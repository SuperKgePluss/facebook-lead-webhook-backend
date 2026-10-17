"use strict";

const TIMEZONE = "Asia/Bangkok";
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30, 0, 0, 0, 0);
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_RECENT_ACTIVITY = 20;
const MAX_OPERATIONAL_LEADS = 100;
const { summarizeAudioForLeads } = require("./audioMatching");

const CUSTOMER_TYPE_CODES = ["B2C", "B2B", "ETC"];
const SALES_FOLLOW_UP_STATUSES = [
    "รอติดต่อ", "โทรติดต่อได้", "โทรติดต่อไม่ได้", "ส่งรายละเอียดทางข้อความ",
    "ส่งรายละเอียดทาง FB / Line", "ไม่สนใจไม่ต้องติดตาม", "อาจจะสนใจในอนาคต", "กำลังพิจารณา",
    "นัดสำรวจหน้างาน", "นัดหมายวันติดตั้งแล้ว", "ติดตั้งแล้วจ่ายครบ", "ติดตั้งแล้วทดลองใช้ 30 วัน",
    "ติดตั้งแล้วทดลองใช้ 60 วัน", "ยกเลิกติดตั้งและคืนเงิน", "ยกเลิกติดตั้งและไม่คืนเงิน",
];

const KNOWN_LEAD_STATUSES = ["New", "Installed", "Cancelled", "Ongoing", "Done"];
const UNMAPPED_LEAD_STATUS = "Unknown/Unmapped";
const UNASSIGNED_SALES_OWNER_FILTER = "__CRM4_UNASSIGNED_FILTER__";
const KNOWN_PAYMENT_STATUSES = ["Unpaid", "Paid", "Cancelled"];
const KNOWN_INSTALLATION_STATUSES = ["Pending", "Scheduled", "Installed", "Cancelled"];
const UPCOMING_INSTALLATION_STATUSES = new Set(["Pending", "Scheduled"]);

function text(value) {
    return String(value ?? "").trim();
}

function lower(value) {
    return text(value).toLowerCase();
}

function hasValue(value) {
    return text(value) !== "";
}

function isValidDate(date) {
    return date instanceof Date && !Number.isNaN(date.getTime());
}

function normalizeYear(year) {
    const numericYear = Number(year);
    if (numericYear < 100) return 2000 + numericYear;
    if (numericYear > 2400) return numericYear - 543;
    return numericYear;
}

function makeBangkokDate(year, month, day, hour = 0, minute = 0, second = 0) {
    const normalizedYear = normalizeYear(year);
    const wallTime = new Date(Date.UTC(
        normalizedYear,
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        0
    ));

    if (!isValidDate(wallTime)
        || wallTime.getUTCFullYear() !== normalizedYear
        || wallTime.getUTCMonth() !== Number(month) - 1
        || wallTime.getUTCDate() !== Number(day)
        || wallTime.getUTCHours() !== Number(hour)
        || wallTime.getUTCMinutes() !== Number(minute)
        || wallTime.getUTCSeconds() !== Number(second)) {
        return null;
    }

    return new Date(wallTime.getTime() - BANGKOK_OFFSET_MS);
}

function parseSheetsSerial(value) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial <= 0 || serial > 100000) return null;

    // Google Sheets serials represent Bangkok wall time in this project. Convert
    // that wall time into an instant so Intl formatting returns the same day.
    const wallTimeMs = SHEETS_EPOCH_MS + serial * 86400000;
    const date = new Date(wallTimeMs - BANGKOK_OFFSET_MS);
    return isValidDate(date) ? date : null;
}

function parseDateValue(value) {
    if (value instanceof Date) {
        return isValidDate(value)
            ? { date: new Date(value.getTime()), kind: "date_object" }
            : { date: null, kind: "invalid_date_object" };
    }

    if (value === null || value === undefined || text(value) === "") {
        return { date: null, kind: "blank" };
    }

    if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(text(value))) {
        const numericValue = Number(value);
        if (numericValue >= 20000 && numericValue <= 100000) {
            const serialDate = parseSheetsSerial(numericValue);
            return serialDate
                ? { date: serialDate, kind: "sheets_serial_number" }
                : { date: null, kind: "invalid_sheets_serial" };
        }
    }

    const raw = text(value);
    const isoDateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoDateOnly) {
        const date = makeBangkokDate(isoDateOnly[1], isoDateOnly[2], isoDateOnly[3]);
        return date ? { date, kind: "bangkok_date_only" } : { date: null, kind: "invalid_date" };
    }

    const isoLocal = raw.match(
        /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );
    if (isoLocal) {
        const date = makeBangkokDate(
            isoLocal[1],
            isoLocal[2],
            isoLocal[3],
            isoLocal[4],
            isoLocal[5],
            isoLocal[6] || 0
        );
        return date ? { date, kind: "bangkok_local_datetime" } : { date: null, kind: "invalid_date" };
    }

    if (/^\d{4}-\d{1,2}-\d{1,2}T/.test(raw)) {
        const date = new Date(raw);
        return isValidDate(date)
            ? { date, kind: "iso_explicit_timezone" }
            : { date: null, kind: "invalid_iso" };
    }

    const slash = raw.match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );
    if (slash) {
        const first = Number(slash[1]);
        const second = Number(slash[2]);
        const month = first > 12 ? second : first;
        const day = first > 12 ? first : second;
        const date = makeBangkokDate(
            slash[3],
            month,
            day,
            slash[4] || 0,
            slash[5] || 0,
            slash[6] || 0
        );
        return date ? { date, kind: "slash_datetime" } : { date: null, kind: "invalid_date" };
    }

    return { date: null, kind: "unsupported_text" };
}

function formatBangkokDateKey(date) {
    if (!isValidDate(date)) return "";

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date).reduce((result, part) => {
        result[part.type] = part.value;
        return result;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimestamp(date) {
    return isValidDate(date) ? date.toISOString() : "";
}

class WarningCollector {
    constructor() {
        this.items = new Map();
    }

    add(code, message, count = 1) {
        const current = this.items.get(code);
        if (current) {
            current.count += count;
            return;
        }

        this.items.set(code, { code, count, message });
    }

    toArray() {
        return Array.from(this.items.values()).sort((a, b) => a.code.localeCompare(b.code));
    }
}

function normalizeFilters(input = {}, warnings = new WarningCollector()) {
    const parseFilterDate = (value, fieldName) => {
        if (!hasValue(value)) return null;
        const parsed = parseDateValue(value);
        if (!parsed.date) {
            warnings.add(`invalid_${fieldName}`, `${fieldName} is not a supported date.`);
            return null;
        }
        return formatBangkokDateKey(parsed.date);
    };

    const dateFrom = parseFilterDate(input.dateFrom, "date_from");
    const dateTo = parseFilterDate(input.dateTo, "date_to");
    if (dateFrom && dateTo && dateFrom > dateTo) {
        warnings.add("invalid_date_range", "dateFrom must not be after dateTo.");
    }

    return {
        timezone: TIMEZONE,
        dateFrom,
        dateTo,
        salesOwner: hasValue(input.salesOwner) ? text(input.salesOwner) : null,
        leadStatus: hasValue(input.leadStatus) ? text(input.leadStatus) : null,
        source: hasValue(input.source) ? text(input.source) : null,
        customerTypeCode: hasValue(input.customerTypeCode) ? text(input.customerTypeCode) : null,
        salesFollowUpStatus: hasValue(input.salesFollowUpStatus) ? text(input.salesFollowUpStatus) : null,
        leadSearch: hasValue(input.leadSearch) ? text(input.leadSearch) : null,
    };
}

function hasDateFilter(filters) {
    return Boolean(filters.dateFrom || filters.dateTo);
}

function dateKeyInRange(dateKey, filters) {
    if (!hasDateFilter(filters)) return true;
    if (!dateKey) return false;
    if (filters.dateFrom && dateKey < filters.dateFrom) return false;
    if (filters.dateTo && dateKey > filters.dateTo) return false;
    return true;
}

function nextDateKey(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function buildLeadTrend(dailyCounts, filters) {
    const observedDates = Object.keys(dailyCounts).sort();
    const startDate = filters.dateFrom || observedDates[0] || null;
    const endDate = filters.dateTo || observedDates[observedDates.length - 1] || null;
    if (!startDate || !endDate || startDate > endDate) return [];

    const trend = [];
    for (let date = startDate; date <= endDate;) {
        trend.push({ date, new_leads: dailyCounts[date] || 0 });
        if (date === endDate) break;
        date = nextDateKey(date);
    }
    return trend;
}

function increment(map, key, amount = 1) {
    map[key] = (map[key] || 0) + amount;
}

function canonicalStatus(value, knownStatuses, unknownBucket = "Unknown") {
    const raw = text(value);
    if (!raw) return unknownBucket;
    return knownStatuses.find(status => status.toLowerCase() === raw.toLowerCase()) || raw;
}

function canonicalLeadStatus(value) {
    const raw = text(value);
    return KNOWN_LEAD_STATUSES.find(status => status.toLowerCase() === raw.toLowerCase()) || UNMAPPED_LEAD_STATUS;
}

function isUnmappedLeadStatus(value) {
    const raw = text(value);
    return !KNOWN_LEAD_STATUSES.some(status => status.toLowerCase() === raw.toLowerCase());
}

function matchesSalesOwnerFilter(lead, salesOwner) {
    if (!salesOwner) return true;
    const owner = text(lead?.sales_owner);
    if (salesOwner === UNASSIGNED_SALES_OWNER_FILTER) return owner === "";
    return owner === salesOwner;
}

function statusMap(knownStatuses, unknownBucket = "Unknown") {
    return Object.fromEntries([...knownStatuses, unknownBucket].map(status => [status, 0]));
}

function stableRecordKey(record) {
    return Object.keys(record || {})
        .sort()
        .map(key => `${key}:${text(record[key])}`)
        .join("|");
}

function choosePreferredRecord(current, candidate) {
    const currentUpdated = parseDateValue(current?.updated_at).date;
    const candidateUpdated = parseDateValue(candidate?.updated_at).date;

    if (candidateUpdated && !currentUpdated) return candidate;
    if (candidateUpdated && currentUpdated && candidateUpdated > currentUpdated) return candidate;
    if (!currentUpdated && !candidateUpdated && stableRecordKey(candidate) > stableRecordKey(current)) return candidate;
    return current;
}

function dedupeById(records, idField, warnings, warningCode) {
    const byId = new Map();
    const withoutId = [];

    for (const record of Array.isArray(records) ? records : []) {
        const id = text(record?.[idField]);
        if (!id) {
            withoutId.push(record || {});
            continue;
        }

        if (!byId.has(id)) {
            byId.set(id, record || {});
            continue;
        }

        warnings.add(warningCode);
        byId.set(id, choosePreferredRecord(byId.get(id), record || {}));
    }

    return [...byId.values(), ...withoutId];
}

function isFacebookLead(lead) {
    return lower(lead?.source) === "facebook" || hasValue(lead?.facebook_leadgen_id);
}

function getLeadEventDate(lead) {
    if (isFacebookLead(lead)) {
        const parsed = parseDateValue(lead.facebook_created_time);
        return parsed.date
            ? { ...parsed, dateKey: formatBangkokDateKey(parsed.date) }
            : { date: null, dateKey: "", kind: parsed.kind, reason: "facebook_event_date_unavailable" };
    }

    const parsed = parseDateValue(lead.created_at);
    return parsed.date
        ? { ...parsed, dateKey: formatBangkokDateKey(parsed.date) }
        : { date: null, dateKey: "", kind: parsed.kind, reason: "manual_created_at_unavailable" };
}

function matchesLeadFilters(lead, filters) {
    if (!matchesSalesOwnerFilter(lead, filters.salesOwner)) return false;
    if (filters.source && lower(lead.source) !== lower(filters.source)) return false;
    if (filters.leadStatus && (filters.leadStatus === UNMAPPED_LEAD_STATUS
        ? !isUnmappedLeadStatus(lead.lead_status)
        : lower(lead.lead_status) !== lower(filters.leadStatus))) return false;
    if (filters.customerTypeCode && lower(lead.customer_type_code) !== lower(filters.customerTypeCode)) return false;
    if (filters.salesFollowUpStatus && text(lead.sales_follow_up_status) !== filters.salesFollowUpStatus) return false;
    return true;
}

function matchesDownstreamRelationship(record, leadById, filters, warnings) {
    if (!filters.salesOwner && !filters.source) return true;

    const leadId = text(record?.lead_id);
    const lead = leadById.get(leadId);
    if (!lead) {
        warnings.add("downstream_lead_join_missing");
        return false;
    }

    if (!matchesSalesOwnerFilter(lead, filters.salesOwner)) return false;
    if (filters.source && lower(lead.source) !== lower(filters.source)) return false;
    return true;
}

function getInstallationDate(installation) {
    const parsed = parseDateValue(installation?.preferred_install_date);
    return parsed.date
        ? { ...parsed, dateKey: formatBangkokDateKey(parsed.date) }
        : { date: null, dateKey: "", kind: parsed.kind };
}

function getActivityDate(activity) {
    const parsed = parseDateValue(activity?.created_at ?? activity?.activity_date);
    return parsed.date
        ? { ...parsed, dateKey: formatBangkokDateKey(parsed.date) }
        : { date: null, dateKey: "", kind: parsed.kind };
}

function parseAmount(value) {
    if (!hasValue(value)) return { value: 0, present: false, invalid: false, negative: false };

    const raw = text(value).replace(/[฿$€£,\s]/g, "");
    const negativeParentheses = /^\(.*\)$/.test(raw);
    const numeric = Number(negativeParentheses ? `-${raw.slice(1, -1)}` : raw);
    if (!Number.isFinite(numeric)) return { value: 0, present: true, invalid: true, negative: false };
    return { value: numeric, present: true, invalid: false, negative: numeric < 0 };
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function getPaidAmount(deal) {
    // `price` is not a universally verified synonym for money already paid.
    return deal?.paid_amount;
}

function isCancelledDeal(deal) {
    return [deal?.payment_status, deal?.deal_status]
        .some(value => lower(value) === "cancelled");
}

function buildLeadMetrics(leads, filters, warnings) {
    const statusCounts = statusMap(KNOWN_LEAD_STATUSES, UNMAPPED_LEAD_STATUS);
    const sourceCounts = {};
    const ownerCounts = {};
    const customerTypeCounts = Object.fromEntries([...CUSTOMER_TYPE_CODES, "Unknown"].map(value => [value, 0]));
    const salesFollowUpStatusCounts = Object.fromEntries([...SALES_FOLLOW_UP_STATUSES, "Unknown"].map(value => [value, 0]));
    const leadTrendCounts = {};
    let newInPeriod = 0;
    let incompleteEventDateCount = 0;
    let total = 0;
    const salesOwnerOptionSet = new Set(leads.map(lead => text(lead.sales_owner) || UNASSIGNED_SALES_OWNER_FILTER));

    for (const lead of leads) {
        if (!matchesLeadFilters(lead, filters)) continue;
        total++;

        const status = canonicalLeadStatus(lead.lead_status);
        increment(statusCounts, status);
        increment(sourceCounts, text(lead.source) || "Unknown");
        increment(ownerCounts, text(lead.sales_owner) || UNASSIGNED_SALES_OWNER_FILTER);
        increment(customerTypeCounts, CUSTOMER_TYPE_CODES.includes(text(lead.customer_type_code)) ? text(lead.customer_type_code) : "Unknown");
        increment(salesFollowUpStatusCounts, SALES_FOLLOW_UP_STATUSES.includes(text(lead.sales_follow_up_status)) ? text(lead.sales_follow_up_status) : "Unknown");

        const eventDate = getLeadEventDate(lead);
        if (!eventDate.date) {
            incompleteEventDateCount++;
            warnings.add(eventDate.reason);
            continue;
        }

        if (dateKeyInRange(eventDate.dateKey, filters)) {
            newInPeriod++;
            increment(leadTrendCounts, eventDate.dateKey);
        }
    }

    return {
        total,
        new_in_period: newInPeriod,
        lead_trend: buildLeadTrend(leadTrendCounts, filters),
        incomplete_event_date_count: incompleteEventDateCount,
        by_status: statusCounts,
        by_source: sourceCounts,
        by_sales_owner: ownerCounts,
        sales_owner_options: [...salesOwnerOptionSet].sort((left, right) => left.localeCompare(right)),
        by_customer_type_code: customerTypeCounts,
        by_sales_follow_up_status: salesFollowUpStatusCounts,
    };
}

function buildFinancialMetrics(deals, leadById, filters, warnings) {
    const paymentStatusCounts = statusMap(KNOWN_PAYMENT_STATUSES);
    const scopedDeals = [];

    if (hasDateFilter(filters)) {
        warnings.add(
            "deal_value_period_filter_unsupported",
            "Deal Value is a current-state total; the date filter does not apply."
        );
        warnings.add(
            "outstanding_period_filter_unsupported",
            "Outstanding is a current-state balance; the date filter does not apply."
        );
        warnings.add(
            "open_deals_period_filter_unsupported",
            "Open Deals is a current-state count; the date filter does not apply."
        );
    }

    for (const deal of dedupeById(deals, "deal_id", warnings, "duplicate_deal_id")) {
        if (!matchesDownstreamRelationship(deal, leadById, filters, warnings)) continue;
        scopedDeals.push(deal);
        increment(paymentStatusCounts, canonicalStatus(deal.payment_status, KNOWN_PAYMENT_STATUSES));
    }

    let dealValue = 0;
    let paid = 0;
    let outstanding = 0;
    let openDeals = 0;

    for (const deal of scopedDeals) {
        if (isCancelledDeal(deal)) continue;

        const full = parseAmount(deal.full_amount);
        const paidAmount = parseAmount(getPaidAmount(deal));
        if (full.invalid) warnings.add("invalid_full_amount");
        if (paidAmount.invalid) warnings.add("invalid_paid_amount");
        if (full.negative) warnings.add("negative_full_amount");
        if (paidAmount.negative) warnings.add("negative_paid_amount");
        if (!full.present) warnings.add("full_amount_unavailable", "A deal has no explicit full_amount value.");
        if (!paidAmount.present) warnings.add("paid_amount_unavailable", "A deal has no explicit paid_amount value; price is not used as a fallback.");

        const safeFull = full.invalid || full.value < 0 ? 0 : full.value;
        const safePaid = paidAmount.invalid || paidAmount.value < 0 ? 0 : paidAmount.value;
        if (safePaid > safeFull) warnings.add("paid_exceeds_full_amount");

        dealValue += safeFull;

        let paidAmountMatchesPeriod = true;
        if (hasDateFilter(filters)) {
            const paymentDate = parseDateValue(deal.payment_date);
            if (!paymentDate.date) {
                paidAmountMatchesPeriod = false;
                warnings.add("payment_date_unavailable", "Paid Amount cannot be period-filtered when Payment Date is blank or invalid.");
            } else {
                paidAmountMatchesPeriod = dateKeyInRange(formatBangkokDateKey(paymentDate.date), filters);
            }
        }
        if (paidAmount.present && !paidAmount.invalid && !paidAmount.negative && paidAmountMatchesPeriod) {
            paid += safePaid;
        }

        const balanceIsKnown = full.present
            && paidAmount.present
            && !full.invalid
            && !paidAmount.invalid
            && !full.negative
            && !paidAmount.negative;
        if (!balanceIsKnown) {
            warnings.add("outstanding_unavailable", "Outstanding and Open Deals omit deals without valid explicit full_amount and paid_amount values.");
            continue;
        }

        const safeOutstanding = Math.max(0, safeFull - safePaid);
        outstanding += safeOutstanding;
        if (safeOutstanding > 0) openDeals++;
    }

    return {
        deal_value: roundMoney(dealValue),
        paid: roundMoney(paid),
        outstanding: roundMoney(outstanding),
        open_deals: openDeals,
        payment_status_counts: paymentStatusCounts,
        deals_in_scope: scopedDeals.length,
    };
}

function buildInstallationMetrics(installations, leadById, filters, warnings, asOf) {
    const statusCounts = statusMap(KNOWN_INSTALLATION_STATUSES);
    const upcomingByDate = {};
    const asOfDate = parseDateValue(asOf).date || new Date();
    const asOfKey = formatBangkokDateKey(asOfDate);
    let upcomingScheduled = 0;
    const upcomingInstallations = [];
    const records = [];

    for (const installation of dedupeById(installations, "install_id", warnings, "duplicate_installation_id")) {
        if (!matchesDownstreamRelationship(installation, leadById, filters, warnings)) continue;

        const status = canonicalStatus(installation.install_status || installation.installation_status, KNOWN_INSTALLATION_STATUSES);
        increment(statusCounts, status);
        const lead = leadById.get(text(installation.lead_id));
        const installationDate = getInstallationDate(installation);
        if (dateKeyInRange(installationDate.dateKey, filters)) records.push({
            install_id: text(installation.install_id),
            lead_id: text(installation.lead_id),
            date: installationDate.dateKey || null,
            customer_name: text(lead?.customer_name),
            sales_owner: text(lead?.sales_owner),
            status,
        });
        if (!UPCOMING_INSTALLATION_STATUSES.has(status)) continue;

        if (!lead) {
            warnings.add(
                "upcoming_installation_lead_join_missing",
                "An upcoming installation could not be matched to a lead."
            );
            continue;
        }

        if (!installationDate.dateKey) {
            warnings.add("installation_date_unavailable");
            continue;
        }
        if (installationDate.dateKey < asOfKey) continue;

        upcomingScheduled++;
        increment(upcomingByDate, installationDate.dateKey);
        upcomingInstallations.push({
            date: installationDate.dateKey,
            customer_name: text(lead.customer_name),
            sales_owner: text(lead.sales_owner),
            status,
        });
    }

    upcomingInstallations.sort((a, b) => a.date.localeCompare(b.date));
    records.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.install_id.localeCompare(b.install_id));

    return {
        by_status: statusCounts,
        records: records.slice(0, 100),
        records_total: records.length,
        upcoming_scheduled_count: upcomingScheduled,
        upcoming_scheduled_by_date: upcomingByDate,
        upcoming_installations: upcomingInstallations,
    };
}

function buildRecentActivity(activities, leadById, filters, warnings) {
    const items = [];
        const hiddenClientActivityTypes = new Set(["facebook repeat submission", "legacy follow-up"]);

    for (const activity of Array.isArray(activities) ? activities : []) {
        const activityDate = getActivityDate(activity);
        if (!activityDate.date) {
            warnings.add("activity_timestamp_unavailable");
            continue;
        }
        if (!dateKeyInRange(activityDate.dateKey, filters)) continue;

        const lead = leadById.get(text(activity.lead_id));
        const activityType = text(activity.action_type || activity.activity_type);
        if (hiddenClientActivityTypes.has(activityType.toLowerCase()) || activityType.toLowerCase().includes("audio")) continue;
        if (filters.salesOwner || filters.source) {
            if (!lead || !matchesDownstreamRelationship(activity, leadById, filters, warnings)) continue;
        }

        items.push({
            lead_id: text(activity.lead_id),
            customer_name: text(lead?.customer_name),
            activity_type: activityType,
            sales_owner: text(lead?.sales_owner || activity.sales_owner || activity.created_by),
            timestamp: formatTimestamp(activityDate.date),
            _sort_id: text(activity.activity_id || activity.id),
        });
    }

    items.sort((a, b) => {
        const timestampOrder = b.timestamp.localeCompare(a.timestamp);
        return timestampOrder || b._sort_id.localeCompare(a._sort_id);
    });

    return items.slice(0, MAX_RECENT_ACTIVITY).map(item => ({
        lead_id: item.lead_id,
        customer_name: item.customer_name,
        activity_type: item.activity_type,
        sales_owner: item.sales_owner,
        timestamp: item.timestamp,
    }));
}

function driveFileIdFromAudioUrl(value) {
    const raw = text(value);
    const match = raw.match(/(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{10,})/);
    return match ? match[1] : "";
}

function buildAudioFollowUpCountIndex(activities, warnings) {
    const fileOwners = new Map();
    const leadFiles = new Map();
    let unresolved = 0;
    for (const activity of Array.isArray(activities) ? activities : []) {
        const action = lower(activity?.action_type || activity?.activity_type);
        const isConflict = action === "audio mapping conflict";
        if (!isConflict && !["audio sync", "follow-up"].includes(action)) continue;
        const leadId = text(activity?.lead_id);
        const fileName = text(activity?.audio_file_name);
        const fileId = driveFileIdFromAudioUrl(activity?.audio_url);
        if (!leadId || !fileId || !/\.(?:mp3|m4a|wav|ogg|mp4|aac)$/i.test(fileName)) {
            unresolved++;
            continue;
        }
        if (!fileOwners.has(fileId)) fileOwners.set(fileId, new Set());
        fileOwners.get(fileId).add(leadId);
        if (!isConflict) {
            if (!leadFiles.has(leadId)) leadFiles.set(leadId, new Set());
            leadFiles.get(leadId).add(fileId);
        }
    }
    if (unresolved) warnings.add("audio_follow_up_identity_unavailable", "Some Audio Sync rows lacked a stable Lead ID, supported recording filename, or Drive file ID.", unresolved);
    let ambiguous = 0;
    for (const owners of fileOwners.values()) if (owners.size > 1) ambiguous++;
    if (ambiguous) warnings.add("audio_follow_up_cross_lead_ambiguous", "Physical audio files associated with multiple Leads were excluded.", ambiguous);
    const counts = {};
    for (const [leadId, fileIds] of leadFiles) {
        counts[leadId] = [...fileIds].filter(fileId => fileOwners.get(fileId)?.size === 1).length;
    }
    return counts;
}

function buildOperationalLeads(leads, activities, filters, warnings, pagination = {}, deals = [], audioSummaries = {}) {
    const noteEvents = new Map();
    const latestFollowUp = new Map();
    for (const activity of Array.isArray(activities) ? activities : []) {
        const leadId = text(activity?.lead_id);
        if (!leadId) continue;
        const action = lower(activity?.action_type || activity?.activity_type);
        const parsed = getActivityDate(activity);
        if ((action === "sales note" || action === "sales note save") && hasValue(activity?.note)) {
            if (!noteEvents.has(leadId)) noteEvents.set(leadId, []);
            noteEvents.get(leadId).push({ at: parsed.date ? formatTimestamp(parsed.date) : null, text: text(activity.note) });
        }
        if (action === "follow-up" && parsed.date) {
            const previous = latestFollowUp.get(leadId);
            if (!previous || parsed.date.getTime() > previous.getTime()) latestFollowUp.set(leadId, parsed.date);
        }
    }

    const rows = [];
    const installationInterestByLeadId = new Map();
    for (const deal of Array.isArray(deals) ? deals : []) {
        const leadId = text(deal?.lead_id);
        if (!leadId) continue;
        const raw = deal?.open_installation;
        const explicit = typeof raw === "boolean"
            ? raw
            : ["true", "false"].includes(text(raw).toLowerCase())
                ? text(raw).toLowerCase() === "true"
                : null;
        if (explicit === null) continue;
        const values = installationInterestByLeadId.get(leadId) || new Set();
        values.add(explicit);
        installationInterestByLeadId.set(leadId, values);
    }
    for (const lead of leads) {
        const leadId = text(lead?.lead_id);
        if (!leadId || !matchesLeadFilters(lead, filters)) continue;
        if (filters.leadSearch && ![leadId, lead.customer_name, lead.phone, lead.additional_phone]
            .some(value => lower(value).includes(lower(filters.leadSearch)))) continue;
        const eventDate = getLeadEventDate(lead);
        if (hasDateFilter(filters) && (!eventDate.date || !dateKeyInRange(eventDate.dateKey, filters))) continue;
        const sourceHistory = parseSalesNoteHistory(lead?.sales_note_history);
        const history = noteEvents.get(leadId) || [];
        if (!history.length) history.push(...sourceHistory);
        else sourceHistory.forEach(item => { if (!history.some(existing => existing.text === item.text)) history.push(item); });
        history.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
        const explicitLatest = parseDateValue(lead?.latest_follow_up_at).date;
        const successful = parseDateValue(lead?.last_successful_contact_at).date;
        const audioSummary = audioSummaries[leadId] || null;
        const activityLatest = latestFollowUp.get(leadId) || null;
        const latest = explicitLatest && activityLatest
            ? (explicitLatest.getTime() >= activityLatest.getTime() ? explicitLatest : activityLatest)
            : explicitLatest || activityLatest;
        rows.push({
            lead_id: leadId,
            customer_name: text(lead?.customer_name || lead?.full_name || lead?.name),
            phone: text(lead?.phone),
            additional_phone: text(lead?.additional_phone),
            lead_status: canonicalLeadStatus(lead?.lead_status),
            preferred_call_day: text(lead?.preferred_call_day),
            preferred_call_time: text(lead?.preferred_call_time),
            customer_type_code: CUSTOMER_TYPE_CODES.includes(text(lead?.customer_type_code)) ? text(lead.customer_type_code) : null,
            sales_follow_up_status: SALES_FOLLOW_UP_STATUSES.includes(text(lead?.sales_follow_up_status)) ? text(lead.sales_follow_up_status) : null,
            sales_owner: text(lead?.sales_owner),
            latest_follow_up_at: latest ? formatTimestamp(latest) : null,
            last_successful_contact_at: successful ? formatTimestamp(successful) : null,
            sales_note_history: history,
            wants_installation: installationInterestByLeadId.has(leadId)
                ? (installationInterestByLeadId.get(leadId).has(true) ? true : false)
                : null,
            audio_recording_count: audioSummary?.count > 0 ? audioSummary.count : null,
            audio_latest_recording_at: audioSummary?.latest_recording_at || null,
            audio_latest_recording_url: audioSummary?.latest_recording_url || null,
            _sort: eventDate.date ? eventDate.date.getTime() : 0,
            _tie: leadId,
        });
    }
    rows.sort((a, b) => b._sort - a._sort || a.customer_name.localeCompare(b.customer_name) || a._tie.localeCompare(b._tie));
    const offset = Number.isSafeInteger(pagination.offset) && pagination.offset >= 0 ? pagination.offset : 0;
    const requestedLimit = Number.isSafeInteger(pagination.limit) && pagination.limit > 0 ? pagination.limit : MAX_OPERATIONAL_LEADS;
    const limit = Math.min(requestedLimit, MAX_OPERATIONAL_LEADS);
    const items = rows.slice(offset, offset + limit).map(({ _sort, _tie, ...row }) => row);
    return { items, total: rows.length, offset, limit, has_more: offset + items.length < rows.length };
}

function mergeLeadViewFields(leads, leadsView, warnings) {
    const viewById = new Map();
    for (const view of Array.isArray(leadsView) ? leadsView : []) {
        const leadId = text(view?.lead_id);
        if (!leadId) continue;
        if (viewById.has(leadId)) {
            warnings.add("duplicate_leads_view_id");
            continue;
        }
        viewById.set(leadId, view);
    }
    return (Array.isArray(leads) ? leads : []).map(lead => {
        const view = viewById.get(text(lead?.lead_id));
        if (!view) return lead;
        const result = { ...lead };
        for (const field of ["customer_type_code", "sales_follow_up_status", "last_successful_contact_at"]) {
            if (!Object.prototype.hasOwnProperty.call(result, field) && Object.prototype.hasOwnProperty.call(view, field)) {
                result[field] = view[field];
            }
        }
        if (!hasValue(result.sales_note_history) && hasValue(view.sales_note_history)) result.sales_note_history = view.sales_note_history;
        if (!hasValue(result.sales_owner) && hasValue(view.sales_owner)) result.sales_owner = view.sales_owner;
        return result;
    });
}

function parseSalesNoteHistory(value) {
    const raw = text(value);
    if (!raw) return [];
    const entries = raw.split(/\n\s*\n(?=\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\])/);
    return entries.map(entry => {
        const match = entry.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*([\s\S]*)$/);
        if (!match) return { at: null, text: entry.trim() };
        const parsed = parseDateValue(match[1]);
        return { at: parsed.date ? formatTimestamp(parsed.date) : null, text: match[2].trim() };
    }).filter(item => item.text);
}

function buildDashboardReadModel({
    leads = [],
    deals = [],
    installations = [],
    activities = [],
    leads_view: leadsView = [],
    filters: filterInput = {},
    operational_lead_pagination: operationalLeadPagination = {},
    asOf = new Date(),
    source_warnings: sourceWarnings = [],
    audio_index: audioIndex = null,
} = {}) {
    const warnings = new WarningCollector();
    for (const warning of Array.isArray(sourceWarnings) ? sourceWarnings : []) {
        const code = text(warning?.code);
        if (!code) continue;

        const suppliedCount = Number(warning?.count);
        const count = Number.isInteger(suppliedCount) && suppliedCount > 0 ? suppliedCount : 1;
        warnings.add(code, text(warning?.message) || "A dashboard source projection is unavailable.", count);
    }

    const filters = normalizeFilters(filterInput, warnings);
    if (audioIndex?.warning) warnings.add(audioIndex.warning, "Verified Audio Release 2 data is not available.");
    const audioSummaries = audioIndex?.available === true
        ? summarizeAudioForLeads(audioIndex.entries, {
            timestampVerified: audioIndex.timestamp_verified === true,
            linksAuthorized: audioIndex.links_authorized === true,
        })
        : {};
    const mergedLeads = mergeLeadViewFields(leads, leadsView, warnings);
    const uniqueLeads = dedupeById(mergedLeads, "lead_id", warnings, "duplicate_lead_id");
    const leadById = new Map(
        uniqueLeads
            .map(lead => [text(lead.lead_id), lead])
            .filter(([leadId]) => leadId)
    );

    return {
        timezone: TIMEZONE,
        filters,
        overview: {
            leads: buildLeadMetrics(uniqueLeads.filter(lead => text(lead.lead_id)), filters, warnings),
            financial: buildFinancialMetrics(deals, leadById, filters, warnings),
            installations: buildInstallationMetrics(installations, leadById, filters, warnings, asOf),
        },
        operational_leads: buildOperationalLeads(uniqueLeads.filter(lead => text(lead.lead_id)), activities, filters, warnings, operationalLeadPagination, deals, audioSummaries),
        recent_activity: buildRecentActivity(activities, leadById, filters, warnings),
        warnings: warnings.toArray(),
    };
}

module.exports = {
    TIMEZONE,
    MAX_RECENT_ACTIVITY,
    MAX_OPERATIONAL_LEADS,
    CUSTOMER_TYPE_CODES,
    SALES_FOLLOW_UP_STATUSES,
    buildAudioFollowUpCountIndex,
    buildOperationalLeads,
    mergeLeadViewFields,
    parseSalesNoteHistory,
    KNOWN_LEAD_STATUSES,
    UNMAPPED_LEAD_STATUS,
    UNASSIGNED_SALES_OWNER_FILTER,
    KNOWN_PAYMENT_STATUSES,
    KNOWN_INSTALLATION_STATUSES,
    parseDateValue,
    formatBangkokDateKey,
    normalizeFilters,
    buildDashboardReadModel,
};
