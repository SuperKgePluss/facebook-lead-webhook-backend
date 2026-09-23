"use strict";

const TIMEZONE = "Asia/Bangkok";
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30, 0, 0, 0, 0);
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_RECENT_ACTIVITY = 20;

const KNOWN_LEAD_STATUSES = ["New", "Installed", "Cancelled", "Ongoing", "Done"];
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

function statusMap(knownStatuses) {
    return Object.fromEntries([...knownStatuses, "Unknown"].map(status => [status, 0]));
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
    if (filters.salesOwner && lower(lead.sales_owner) !== lower(filters.salesOwner)) return false;
    if (filters.source && lower(lead.source) !== lower(filters.source)) return false;
    if (filters.leadStatus && lower(lead.lead_status) !== lower(filters.leadStatus)) return false;
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

    if (filters.salesOwner && lower(lead.sales_owner) !== lower(filters.salesOwner)) return false;
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
    const statusCounts = statusMap(KNOWN_LEAD_STATUSES);
    const sourceCounts = {};
    const ownerCounts = {};
    const leadTrendCounts = {};
    let newInPeriod = 0;
    let incompleteEventDateCount = 0;
    let total = 0;

    for (const lead of leads) {
        if (!matchesLeadFilters(lead, filters)) continue;
        total++;

        const status = canonicalStatus(lead.lead_status, KNOWN_LEAD_STATUSES);
        increment(statusCounts, status);
        increment(sourceCounts, text(lead.source) || "Unknown");
        increment(ownerCounts, text(lead.sales_owner) || "Unassigned");

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

    for (const installation of dedupeById(installations, "install_id", warnings, "duplicate_installation_id")) {
        if (!matchesDownstreamRelationship(installation, leadById, filters, warnings)) continue;

        const status = canonicalStatus(installation.install_status || installation.installation_status, KNOWN_INSTALLATION_STATUSES);
        increment(statusCounts, status);
        if (!UPCOMING_INSTALLATION_STATUSES.has(status)) continue;

        const lead = leadById.get(text(installation.lead_id));
        if (!lead) {
            warnings.add(
                "upcoming_installation_lead_join_missing",
                "An upcoming installation could not be matched to a lead."
            );
            continue;
        }

        const installationDate = getInstallationDate(installation);
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

    return {
        by_status: statusCounts,
        upcoming_scheduled_count: upcomingScheduled,
        upcoming_scheduled_by_date: upcomingByDate,
        upcoming_installations: upcomingInstallations,
    };
}

function buildRecentActivity(activities, leadById, filters, warnings) {
    const items = [];

    for (const activity of Array.isArray(activities) ? activities : []) {
        const activityDate = getActivityDate(activity);
        if (!activityDate.date) {
            warnings.add("activity_timestamp_unavailable");
            continue;
        }
        if (!dateKeyInRange(activityDate.dateKey, filters)) continue;

        const lead = leadById.get(text(activity.lead_id));
        if (filters.salesOwner || filters.source) {
            if (!lead || !matchesDownstreamRelationship(activity, leadById, filters, warnings)) continue;
        }

        items.push({
            customer_name: text(lead?.customer_name),
            activity_type: text(activity.action_type || activity.activity_type),
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
        customer_name: item.customer_name,
        activity_type: item.activity_type,
        sales_owner: item.sales_owner,
        timestamp: item.timestamp,
    }));
}

function buildDashboardReadModel({
    leads = [],
    deals = [],
    installations = [],
    activities = [],
    filters: filterInput = {},
    asOf = new Date(),
    source_warnings: sourceWarnings = [],
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
    const uniqueLeads = dedupeById(leads, "lead_id", warnings, "duplicate_lead_id");
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
        recent_activity: buildRecentActivity(activities, leadById, filters, warnings),
        warnings: warnings.toArray(),
    };
}

module.exports = {
    TIMEZONE,
    MAX_RECENT_ACTIVITY,
    KNOWN_LEAD_STATUSES,
    KNOWN_PAYMENT_STATUSES,
    KNOWN_INSTALLATION_STATUSES,
    parseDateValue,
    formatBangkokDateKey,
    normalizeFilters,
    buildDashboardReadModel,
};
