const googleSheets = require("../googleSheets");
const { readFirstAvailableSheet } = require("./importUtils");

const DATA_START_ROW = 3;

const CRM3_LEAD_FIELDS = [
    "lead_status",
    "sales_owner",
    "customer_type",
    "zone",
];

const CRM3_SAFE_LEAD_RESTORE_FIELDS = [
    "zone",
    "customer_type",
    "sales_owner",
];

const CRM3_DEAL_FIELDS = [
    "product_model",
    "package_type",
    "payment_status",
    "price",
    "full_amount",
    "payment_slip_url",
    "note",
    "deal_status",
];

const CRM3_INSTALLATION_FIELDS = [
    "install_status",
    "preferred_install_date",
    "preferred_install_time",
    "location",
    "machine_count",
    "location_url",
    "note",
];

const CRM3_SAFE_DEAL_RESTORE_FIELDS = [
    "product_model",
    "package_type",
    "price",
    "full_amount",
    "payment_slip_url",
];

const ACTIVITY_URL_FIELDS = [
    "audio_url",
    "payment_url",
    "payment_slip_url",
    "location_url",
];

const FACEBOOK_RAW_FIELD_MAP = {
    facebook_leadgen_id: {
        aliases: ["lead_id", "leadgen_id", "facebook_leadgen_id", "facebook_lead_id", "id"],
        destination: "LEAD_DETAILS.facebook_leadgen_id",
        status: "mapped",
    },
    facebook_created_time: {
        aliases: ["created_time", "created_time_utc", "facebook_created_time", "created_at"],
        destination: "LEADS_MAIN.facebook_created_time / LEAD_DETAILS.facebook_created_time",
        status: "mapped",
    },
    customer_name: {
        aliases: ["full_name", "customer_name", "name", "full name", "customer name"],
        destination: "LEADS_MAIN.customer_name",
        status: "mapped",
    },
    phone: {
        aliases: ["phone_number", "phone", "mobile_phone", "phone number"],
        destination: "LEADS_MAIN.phone",
        status: "mapped",
    },
    email: {
        aliases: ["email", "email_address", "email address"],
        destination: "Needs decision",
        status: "unmapped",
    },
    form_id: {
        aliases: ["form_id", "form id"],
        destination: "LEAD_DETAILS.form_id",
        status: "mapped",
    },
    form_name: {
        aliases: ["form_name", "form name", "lead_form_name"],
        destination: "LEADS_MAIN.lead_form_name",
        status: "mapped",
    },
    ad_id: {
        aliases: ["ad_id", "ad id"],
        destination: "LEAD_DETAILS.ad_id",
        status: "mapped",
    },
    ad_name: {
        aliases: ["ad_name", "ad name"],
        destination: "LEADS_MAIN.ad_name",
        status: "mapped",
    },
    adset_id: {
        aliases: ["ad_set_id", "adset_id", "ad set id", "adset id"],
        destination: "LEAD_DETAILS.adset_id",
        status: "mapped",
    },
    adset_name: {
        aliases: ["ad_set_name", "adset_name", "ad set name", "adset name"],
        destination: "LEADS_MAIN.adset_name",
        status: "mapped",
    },
    campaign_id: {
        aliases: ["campaign_id", "campaign id"],
        destination: "LEAD_DETAILS.campaign_id",
        status: "mapped",
    },
    campaign_name: {
        aliases: ["campaign_name", "campaign name"],
        destination: "LEADS_MAIN.campaign_name",
        status: "mapped",
    },
    platform: {
        aliases: ["platform"],
        destination: "LEAD_DETAILS.platform",
        status: "mapped",
    },
    is_organic: {
        aliases: ["is_organic", "is organic"],
        destination: "LEAD_DETAILS.is_organic",
        status: "mapped",
    },
    inbox_url: {
        aliases: ["inbox_url", "inbox url"],
        destination: "LEAD_DETAILS.inbox_url",
        status: "mapped",
    },
    province: {
        aliases: ["province", "state", "จังหวัด"],
        destination: "LEADS_MAIN.province / LEAD_DETAILS.raw_province",
        status: "mapped",
    },
    preferred_call_day: {
        aliases: ["preferred_call_day", "preferred call day"],
        destination: "LEADS_MAIN.preferred_call_day",
        status: "mapped",
    },
    preferred_call_time: {
        aliases: ["preferred_call_time", "preferred call time"],
        destination: "LEADS_MAIN.preferred_call_time",
        status: "mapped",
    },
};

function getSheetNameList(req, queryName, defaults) {
    const explicit = String(req.query[queryName] || "").trim();
    if (explicit) return [explicit];
    return defaults;
}

function resolveSpreadsheetId(req, defaultSpreadsheetId, queryName, envName) {
    const queryValue = String(req.query[queryName] || "").trim();
    if (queryValue) {
        return {
            spreadsheetId: queryValue,
            source: `query.${queryName}`,
        };
    }

    const envValue = String(process.env[envName] || "").trim();
    if (envValue) {
        return {
            spreadsheetId: envValue,
            source: `env.${envName}`,
        };
    }

    return {
        spreadsheetId: defaultSpreadsheetId,
        source: "env.GOOGLE_SHEET_ID",
    };
}

function getSampleLimit(req) {
    const parsed = Number.parseInt(req.query.sample_limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 10;
    return Math.min(parsed, 25);
}

function getRestoreLimit(req) {
    const parsed = Number.parseInt(req.query.limit || req.query.restore_limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 50;
    return Math.min(parsed, 200);
}

function getRestoreStep(req) {
    const step = String(req.query.restore_step || "all").trim().toLowerCase();
    if (["leads", "deals", "installations", "activities", "all"].includes(step)) return step;
    return "all";
}

function shouldRunRestoreStep(selectedStep, step) {
    return selectedStep === "all" || selectedStep === step;
}

function isQuotaOrTimeoutError(err) {
    const status = err.response?.status || err.code;
    const message = String(err.response?.data?.error?.message || err.message || "").toLowerCase();
    return status === 429
        || status === 503
        || message.includes("quota")
        || message.includes("timeout")
        || message.includes("timed out")
        || message.includes("rate limit");
}

async function readOptionalSheet(req, queryName, defaults, spreadsheetQueryName, spreadsheetEnvName) {
    const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
    const resolvedSpreadsheet = resolveSpreadsheetId(
        req,
        spreadsheetId,
        spreadsheetQueryName,
        spreadsheetEnvName
    );
    const sheetNames = getSheetNameList(req, queryName, defaults);

    try {
        const result = await readFirstAvailableSheet(
            googleSheets,
            sheets,
            resolvedSpreadsheet.spreadsheetId,
            sheetNames
        );

        return {
            ...result,
            spreadsheet_id_source: resolvedSpreadsheet.source,
        };
    } catch (err) {
        return {
            sheetName: "",
            rows: [],
            error: err.message,
            attempted_sheet_names: sheetNames,
            spreadsheet_id_source: resolvedSpreadsheet.source,
        };
    }
}

async function readExternalSheet(req, sheetName, spreadsheetQueryName, spreadsheetEnvName) {
    const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
    const resolvedSpreadsheet = resolveSpreadsheetId(
        req,
        spreadsheetId,
        spreadsheetQueryName,
        spreadsheetEnvName
    );

    return {
        sheetName,
        rows: await googleSheets.readSheet(
            sheets,
            resolvedSpreadsheet.spreadsheetId,
            `${sheetName}!A:ZZ`
        ),
        spreadsheet_id_source: resolvedSpreadsheet.source,
    };
}

function rowsToObjects(rows, startIndex = DATA_START_ROW - 1) {
    const headers = rows[0] || [];
    return rows
        .slice(startIndex)
        .map((row, index) => ({
            rowNumber: startIndex + index + 1,
            object: googleSheets.rowToObject(headers, row),
        }))
        .filter(item => Object.values(item.object).some(value => String(value || "").trim()));
}

function normalizePhone(value) {
    return googleSheets.normalizePhone(value);
}

function firstValue(object, keys) {
    for (const key of keys) {
        const normalizedKey = googleSheets.normalizeHeaderName(key);
        const value = object[normalizedKey];
        if (String(value || "").trim()) return value;
    }

    return "";
}

function hasAnyField(object, fields) {
    return fields.some(field => String(firstValue(object, [field]) || "").trim());
}

function mapLeadsByPhone(items) {
    const byPhone = new Map();
    const byLeadId = new Map();

    for (const item of items) {
        const lead = item.object;
        const phone = normalizePhone(firstValue(lead, ["phone"]));
        const leadId = String(firstValue(lead, ["lead_id"]) || "").trim();

        if (phone && !byPhone.has(phone)) byPhone.set(phone, { ...item, phone, leadId });
        if (leadId) byLeadId.set(leadId, { ...item, phone, leadId });
    }

    return { byPhone, byLeadId };
}

function compareFieldSet({ currentObject, sourceObject, fields }) {
    const fillBlank = [];
    const conflicts = [];

    for (const field of fields) {
        const oldValue = String(firstValue(sourceObject, [field]) || "").trim();
        const currentValue = String(firstValue(currentObject, [field]) || "").trim();

        if (!oldValue) continue;

        if (!currentValue) {
            fillBlank.push({ field, old_value: oldValue });
            continue;
        }

        if (currentValue !== oldValue) {
            conflicts.push({ field, current_value: currentValue, old_value: oldValue });
        }
    }

    return { fillBlank, conflicts };
}

function findCurrentByLeadId(items, leadId) {
    const target = String(leadId || "").trim();
    if (!target) return null;
    return items.find(item => String(firstValue(item.object, ["lead_id"]) || "").trim() === target) || null;
}

function buildActivitySignature(object, currentLeadId) {
    return [
        currentLeadId,
        firstValue(object, ["action_type", "activity_type"]),
        firstValue(object, ["audio_url", "audio_link"]),
        firstValue(object, ["payment_url", "payment_slip_url"]),
        firstValue(object, ["location_url"]),
        firstValue(object, ["created_at", "activity_date"]),
    ].map(value => String(value || "").trim()).join("|");
}

function isBlankOrUnknown(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return !normalized || normalized === "unknown" || normalized === "n/a" || normalized === "-";
}

function isPresentValue(value) {
    return !isBlankOrUnknown(value);
}

function getRestoreFieldValue(object, field) {
    if (field === "price") return firstValue(object, ["price", "paid_amount", "paid amount"]);
    if (field === "payment_slip_url") return firstValue(object, ["payment_slip_url", "payment_url", "payment slip url"]);
    if (field === "machine_count") return firstValue(object, ["machine_count", "quantity", "device_count"]);
    if (field === "preferred_install_date") return firstValue(object, ["preferred_install_date", "install_date", "install date"]);
    if (field === "preferred_install_time") return firstValue(object, ["preferred_install_time", "install_time", "time_slot"]);
    return firstValue(object, [field]);
}

function buildSafeRestorePatch({ currentObject, sourceObject, fields, allowUnknownCurrent = false }) {
    const patch = {};
    const conflicts = [];
    const skippedEmptySource = [];

    for (const field of fields) {
        const sourceValue = String(getRestoreFieldValue(sourceObject, field) || "").trim();
        const currentValue = String(getRestoreFieldValue(currentObject, field) || "").trim();

        if (!isPresentValue(sourceValue)) {
            skippedEmptySource.push(field);
            continue;
        }

        const currentCanBeFilled = allowUnknownCurrent ? isBlankOrUnknown(currentValue) : !currentValue;
        if (currentCanBeFilled) {
            patch[field] = sourceValue;
            continue;
        }

        if (currentValue !== sourceValue) {
            conflicts.push({ field, current_value: currentValue, snapshot_value: sourceValue });
        }
    }

    return { patch, conflicts, skippedEmptySource };
}

function buildLeadIdToPhoneMap(items) {
    const map = new Map();

    for (const item of items) {
        const leadId = String(firstValue(item.object, ["lead_id"]) || "").trim();
        const phone = normalizePhone(firstValue(item.object, ["phone"]));
        if (leadId && phone) map.set(leadId, phone);
    }

    return map;
}

function resolveSnapshotPhone(snapshotObject, oldLeadIdToPhone) {
    const directPhone = normalizePhone(firstValue(snapshotObject, ["phone"]));
    if (directPhone) return directPhone;

    const oldLeadId = String(firstValue(snapshotObject, ["lead_id"]) || "").trim();
    if (!oldLeadId) return "";
    return oldLeadIdToPhone.get(oldLeadId) || "";
}

function buildActivityUrlKey(object, currentLeadId) {
    return [
        currentLeadId,
        firstValue(object, ["action_type", "activity_type"]) || "Restore URL Evidence",
        firstValue(object, ["audio_url", "audio_link"]),
        firstValue(object, ["payment_url", "payment_slip_url"]),
        firstValue(object, ["location_url"]),
    ].map(value => String(value || "").trim()).join("|");
}

function generateRestoreId(prefix) {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function nowIsoString() {
    return new Date().toISOString();
}

async function handleCrm3RestoreAudit(req, res) {
    try {
        const sampleLimit = getSampleLimit(req);
        const [
            currentLeadRows,
            currentDealRows,
            currentInstallationRows,
            currentActivityRows,
            crm3Leads,
            crm3Deals,
            crm3Installations,
            crm3Activities,
        ] = await Promise.all([
            googleSheets.getSheetRows("LEADS_MAIN"),
            googleSheets.getSheetRows("DEALS"),
            googleSheets.getSheetRows("INSTALLATIONS"),
            googleSheets.getSheetRows("ACTIVITY_LOG"),
            readOptionalSheet(req, "crm3_leads_sheet", ["CRM3_LEADS_MAIN", "CRM3_LEADS", "CRM3_SNAPSHOT_LEADS_MAIN", "LEADS_MAIN_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
            readOptionalSheet(req, "crm3_deals_sheet", ["CRM3_DEALS", "CRM3_SNAPSHOT_DEALS", "DEALS_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
            readOptionalSheet(req, "crm3_installations_sheet", ["CRM3_INSTALLATIONS", "CRM3_SNAPSHOT_INSTALLATIONS", "INSTALLATIONS_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
            readOptionalSheet(req, "crm3_activity_sheet", ["CRM3_ACTIVITY_LOG", "CRM3_ACTIVITIES", "ACTIVITY_LOG_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
        ]);

        const currentLeads = rowsToObjects(currentLeadRows);
        const currentDeals = rowsToObjects(currentDealRows);
        const currentInstallations = rowsToObjects(currentInstallationRows);
        const currentActivities = rowsToObjects(currentActivityRows);
        const oldLeads = rowsToObjects(crm3Leads.rows);
        const oldDeals = rowsToObjects(crm3Deals.rows);
        const oldInstallations = rowsToObjects(crm3Installations.rows);
        const oldActivities = rowsToObjects(crm3Activities.rows);
        const currentLeadMaps = mapLeadsByPhone(currentLeads);
        const oldLeadMaps = mapLeadsByPhone(oldLeads);
        const currentActivitySignatures = new Set(
            currentActivities.map(item => buildActivitySignature(item.object, firstValue(item.object, ["lead_id"])))
        );

        const summary = {
            success: true,
            dry_run: true,
            no_writes_performed: true,
            source_sheets: {
                crm3_leads: {
                    sheet_name: crm3Leads.sheetName || null,
                    spreadsheet_id_source: crm3Leads.spreadsheet_id_source,
                },
                crm3_deals: {
                    sheet_name: crm3Deals.sheetName || null,
                    spreadsheet_id_source: crm3Deals.spreadsheet_id_source,
                },
                crm3_installations: {
                    sheet_name: crm3Installations.sheetName || null,
                    spreadsheet_id_source: crm3Installations.spreadsheet_id_source,
                },
                crm3_activity_log: {
                    sheet_name: crm3Activities.sheetName || null,
                    spreadsheet_id_source: crm3Activities.spreadsheet_id_source,
                },
            },
            source_sheet_errors: [crm3Leads, crm3Deals, crm3Installations, crm3Activities]
                .filter(sheet => sheet.error)
                .map(sheet => ({
                    attempted_sheet_names: sheet.attempted_sheet_names,
                    error: sheet.error,
                })),
            counts: {
                current_leads: currentLeads.length,
                crm3_leads: oldLeads.length,
                matched_phones: 0,
                unmatched_phones: 0,
                lead_fields_to_fill_blank: 0,
                lead_field_conflicts: 0,
                deals_checked: 0,
                deals_matched: 0,
                deals_unmatched_phones: 0,
                deals_would_create: 0,
                deal_fields_to_fill_blank: 0,
                deal_field_conflicts: 0,
                installations_checked: 0,
                installations_matched: 0,
                installations_unmatched_phones: 0,
                installations_would_create: 0,
                installation_fields_to_fill_blank: 0,
                installation_field_conflicts: 0,
                activity_url_rows_checked: 0,
                activity_unmatched_phones: 0,
                activities_would_create: 0,
                activities_skipped_duplicate: 0,
            },
            sample_lead_restore_items: [],
            sample_deal_restore_items: [],
            sample_installation_restore_items: [],
            sample_activity_restore_items: [],
        };

        for (const item of oldLeads) {
            const oldLead = item.object;
            const phone = normalizePhone(firstValue(oldLead, ["phone"]));
            if (!phone) continue;

            const current = currentLeadMaps.byPhone.get(phone);
            if (!current) {
                summary.counts.unmatched_phones++;
                continue;
            }

            summary.counts.matched_phones++;
            const comparison = compareFieldSet({
                currentObject: current.object,
                sourceObject: oldLead,
                fields: CRM3_LEAD_FIELDS,
            });
            summary.counts.lead_fields_to_fill_blank += comparison.fillBlank.length;
            summary.counts.lead_field_conflicts += comparison.conflicts.length;

            if ((comparison.fillBlank.length || comparison.conflicts.length) && summary.sample_lead_restore_items.length < sampleLimit) {
                summary.sample_lead_restore_items.push({
                    phone,
                    current_lead_id: current.leadId,
                    source_row: item.rowNumber,
                    fill_blank: comparison.fillBlank,
                    conflicts: comparison.conflicts,
                });
            }
        }

        for (const item of oldDeals) {
            const oldDeal = item.object;
            if (!hasAnyField(oldDeal, CRM3_DEAL_FIELDS)) continue;

            summary.counts.deals_checked++;
            const oldLeadId = String(firstValue(oldDeal, ["lead_id"]) || "").trim();
            const oldLead = oldLeadMaps.byLeadId.get(oldLeadId);
            const phone = normalizePhone(firstValue(oldDeal, ["phone"]) || oldLead?.phone);
            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) {
                summary.counts.deals_unmatched_phones++;
                continue;
            }

            const currentDeal = findCurrentByLeadId(currentDeals, currentLead.leadId);
            if (!currentDeal) {
                summary.counts.deals_would_create++;
                if (summary.sample_deal_restore_items.length < sampleLimit) {
                    summary.sample_deal_restore_items.push({
                        phone,
                        current_lead_id: currentLead.leadId,
                        source_row: item.rowNumber,
                        action: "would_create_deal",
                    });
                }
                continue;
            }

            summary.counts.deals_matched++;
            const comparison = compareFieldSet({
                currentObject: currentDeal.object,
                sourceObject: oldDeal,
                fields: CRM3_DEAL_FIELDS,
            });
            summary.counts.deal_fields_to_fill_blank += comparison.fillBlank.length;
            summary.counts.deal_field_conflicts += comparison.conflicts.length;

            if ((comparison.fillBlank.length || comparison.conflicts.length) && summary.sample_deal_restore_items.length < sampleLimit) {
                summary.sample_deal_restore_items.push({
                    phone,
                    current_lead_id: currentLead.leadId,
                    source_row: item.rowNumber,
                    action: "would_update_existing_deal_missing_fields",
                    fill_blank: comparison.fillBlank,
                    conflicts: comparison.conflicts,
                });
            }
        }

        for (const item of oldInstallations) {
            const oldInstallation = item.object;
            if (!hasAnyField(oldInstallation, CRM3_INSTALLATION_FIELDS)) continue;

            summary.counts.installations_checked++;
            const oldLeadId = String(firstValue(oldInstallation, ["lead_id"]) || "").trim();
            const oldLead = oldLeadMaps.byLeadId.get(oldLeadId);
            const phone = normalizePhone(firstValue(oldInstallation, ["phone"]) || oldLead?.phone);
            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) {
                summary.counts.installations_unmatched_phones++;
                continue;
            }

            const currentInstallation = findCurrentByLeadId(currentInstallations, currentLead.leadId);
            if (!currentInstallation) {
                summary.counts.installations_would_create++;
                if (summary.sample_installation_restore_items.length < sampleLimit) {
                    summary.sample_installation_restore_items.push({
                        phone,
                        current_lead_id: currentLead.leadId,
                        source_row: item.rowNumber,
                        action: "would_create_installation",
                    });
                }
                continue;
            }

            summary.counts.installations_matched++;
            const comparison = compareFieldSet({
                currentObject: currentInstallation.object,
                sourceObject: oldInstallation,
                fields: CRM3_INSTALLATION_FIELDS,
            });
            summary.counts.installation_fields_to_fill_blank += comparison.fillBlank.length;
            summary.counts.installation_field_conflicts += comparison.conflicts.length;

            if ((comparison.fillBlank.length || comparison.conflicts.length) && summary.sample_installation_restore_items.length < sampleLimit) {
                summary.sample_installation_restore_items.push({
                    phone,
                    current_lead_id: currentLead.leadId,
                    source_row: item.rowNumber,
                    action: "would_update_existing_installation_missing_fields",
                    fill_blank: comparison.fillBlank,
                    conflicts: comparison.conflicts,
                });
            }
        }

        for (const item of oldActivities) {
            const oldActivity = item.object;
            if (!hasAnyField(oldActivity, ACTIVITY_URL_FIELDS)) continue;

            summary.counts.activity_url_rows_checked++;
            const oldLeadId = String(firstValue(oldActivity, ["lead_id"]) || "").trim();
            const oldLead = oldLeadMaps.byLeadId.get(oldLeadId);
            const phone = normalizePhone(firstValue(oldActivity, ["phone"]) || oldLead?.phone);
            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) {
                summary.counts.activity_unmatched_phones++;
                continue;
            }

            const signature = buildActivitySignature(oldActivity, currentLead.leadId);
            if (currentActivitySignatures.has(signature)) {
                summary.counts.activities_skipped_duplicate++;
                continue;
            }

            summary.counts.activities_would_create++;
            if (summary.sample_activity_restore_items.length < sampleLimit) {
                summary.sample_activity_restore_items.push({
                    phone,
                    current_lead_id: currentLead.leadId,
                    source_row: item.rowNumber,
                    audio_url: firstValue(oldActivity, ["audio_url", "audio_link"]),
                    payment_url: firstValue(oldActivity, ["payment_url", "payment_slip_url"]),
                    location_url: firstValue(oldActivity, ["location_url"]),
                    action_type: firstValue(oldActivity, ["action_type", "activity_type"]),
                });
            }
        }

        summary.counts.total_fields_to_fill_blank =
            summary.counts.lead_fields_to_fill_blank
            + summary.counts.deal_fields_to_fill_blank
            + summary.counts.installation_fields_to_fill_blank;
        summary.counts.total_field_conflicts =
            summary.counts.lead_field_conflicts
            + summary.counts.deal_field_conflicts
            + summary.counts.installation_field_conflicts;

        return res.status(200).json(summary);
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: true,
            error: err.message,
        });
    }
}

function getFacebookRawHeaderMapping(headers) {
    const mapping = [];
    const detected = headers.map(header => String(header || "").trim()).filter(Boolean);

    for (const header of detected) {
        const normalizedHeader = googleSheets.normalizeHeaderName(header);
        const match = Object.entries(FACEBOOK_RAW_FIELD_MAP).find(([, config]) => {
            return config.aliases
                .map(alias => googleSheets.normalizeHeaderName(alias))
                .includes(normalizedHeader);
        });

        if (match) {
            const [field, config] = match;
            mapping.push({
                header,
                normalized_header: normalizedHeader,
                field,
                status: config.status,
                destination: config.destination,
            });
            continue;
        }

        mapping.push({
            header,
            normalized_header: normalizedHeader,
            field: "",
            status: "unmapped",
            destination: "Needs review",
        });
    }

    return mapping;
}

async function handleFacebookRawAudit(req, res) {
    try {
        const sampleLimit = getSampleLimit(req);
        const rawSheetName = String(req.query.sheet || "IMPORT_RAW").trim();
        const [rawSheet, currentLeadRows, detailRows] = await Promise.all([
            readExternalSheet(req, rawSheetName, "facebook_raw_spreadsheet_id", "FACEBOOK_RAW_SPREADSHEET_ID"),
            googleSheets.getSheetRows("LEADS_MAIN"),
            googleSheets.getSheetRows("LEAD_DETAILS"),
        ]);
        const rawRows = rawSheet.rows;
        const rawHeaders = rawRows[0] || [];
        const rawItems = rowsToObjects(rawRows, 1);
        const currentLeadMaps = mapLeadsByPhone(rowsToObjects(currentLeadRows));
        const detailHeaders = detailRows[0] || [];
        const existingLeadgenIds = new Set(
            detailRows
                .slice(DATA_START_ROW - 1)
                .map(row => String(googleSheets.rowToObject(detailHeaders, row).facebook_leadgen_id || "").trim())
                .filter(Boolean)
        );
        const headerMapping = getFacebookRawHeaderMapping(rawHeaders);
        const samplePreview = [];
        let parsed = 0;
        let matchedPhones = 0;
        let unmatchedPhones = 0;
        let duplicateLeadgen = 0;
        let missingPhone = 0;
        let failed = 0;
        let wouldCreateLeads = 0;
        let wouldUpdateExisting = 0;

        for (const item of rawItems) {
            try {
                const row = item.object;
                const phone = normalizePhone(firstValue(row, ["phone_number", "phone", "mobile_phone", "phone number"]));
                const leadgenId = String(firstValue(row, ["leadgen_id", "facebook_leadgen_id", "facebook_lead_id", "lead_id", "id"]) || "").trim();
                const currentLead = currentLeadMaps.byPhone.get(phone);

                parsed++;
                if (!phone) missingPhone++;
                else if (currentLead) matchedPhones++;
                else unmatchedPhones++;

                if (leadgenId && existingLeadgenIds.has(leadgenId)) duplicateLeadgen++;
                if (phone && !currentLead && !(leadgenId && existingLeadgenIds.has(leadgenId))) wouldCreateLeads++;
                if (phone && currentLead) wouldUpdateExisting++;

                if (samplePreview.length < sampleLimit) {
                    samplePreview.push({
                        source_row: item.rowNumber,
                        facebook_leadgen_id: leadgenId,
                        phone,
                        current_lead_id: currentLead?.leadId || "",
                        customer_name: firstValue(row, ["full_name", "customer_name", "name"]),
                        form_id: firstValue(row, ["form_id"]),
                        form_name: firstValue(row, ["form_name", "lead_form_name"]),
                        ad_id: firstValue(row, ["ad_id"]),
                        ad_name: firstValue(row, ["ad_name"]),
                        adset_id: firstValue(row, ["ad_set_id", "adset_id"]),
                        adset_name: firstValue(row, ["ad_set_name", "adset_name"]),
                        campaign_id: firstValue(row, ["campaign_id"]),
                        campaign_name: firstValue(row, ["campaign_name"]),
                        duplicate_leadgen: Boolean(leadgenId && existingLeadgenIds.has(leadgenId)),
                        would_create_lead: Boolean(phone && !currentLead && !(leadgenId && existingLeadgenIds.has(leadgenId))),
                        would_update_existing: Boolean(phone && currentLead),
                    });
                }
            } catch (err) {
                failed++;
            }
        }

        return res.status(200).json({
            success: true,
            dry_run: true,
            no_writes_performed: true,
            source_sheet: rawSheetName,
            source_spreadsheet_id_source: rawSheet.spreadsheet_id_source,
            total_rows: rawItems.length,
            parsed,
            matched_phones: matchedPhones,
            unmatched_phones: unmatchedPhones,
            would_create_leads: wouldCreateLeads,
            would_update_existing: wouldUpdateExisting,
            skipped_duplicate_leadgen: duplicateLeadgen,
            skipped_missing_phone: missingPhone,
            failed,
            detected_headers: rawHeaders.map(header => String(header || "").trim()).filter(Boolean),
            header_mapping: headerMapping,
            mapped_fields: headerMapping.filter(item => item.status === "mapped"),
            unmapped_fields: headerMapping.filter(item => item.status !== "mapped"),
            sample_preview: samplePreview,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: true,
            error: err.message,
        });
    }
}

async function handleCrm3SafeRestore(req, res) {
    const confirm = String(req.query.confirm || "").trim().toLowerCase() === "true";
    const dryRun = !confirm || String(req.query.mode || "").trim().toLowerCase() === "dry_run";
    const sampleLimit = getSampleLimit(req);
    const restoreLimit = getRestoreLimit(req);
    const restoreStep = getRestoreStep(req);

    try {
        const [
            currentLeadRows,
            currentDealRows,
            currentInstallationRows,
            currentActivityRows,
            crm3Leads,
            crm3Deals,
            crm3Installations,
            crm3Activities,
        ] = await Promise.all([
            googleSheets.getSheetRows("LEADS_MAIN"),
            googleSheets.getSheetRows("DEALS"),
            googleSheets.getSheetRows("INSTALLATIONS"),
            googleSheets.getSheetRows("ACTIVITY_LOG"),
            readOptionalSheet(req, "crm3_leads_sheet", ["CRM3_LEADS_MAIN", "CRM3_LEADS", "CRM3_SNAPSHOT_LEADS_MAIN", "LEADS_MAIN_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
            readOptionalSheet(req, "crm3_deals_sheet", ["CRM3_DEALS", "CRM3_SNAPSHOT_DEALS", "DEALS_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
            readOptionalSheet(req, "crm3_installations_sheet", ["CRM3_INSTALLATIONS", "CRM3_SNAPSHOT_INSTALLATIONS", "INSTALLATIONS_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
            readOptionalSheet(req, "crm3_activity_sheet", ["CRM3_ACTIVITY_LOG", "CRM3_ACTIVITIES", "ACTIVITY_LOG_CRM3"], "crm3_spreadsheet_id", "CRM3_SNAPSHOT_SPREADSHEET_ID"),
        ]);

        const currentLeads = rowsToObjects(currentLeadRows);
        const currentDeals = rowsToObjects(currentDealRows);
        const currentInstallations = rowsToObjects(currentInstallationRows);
        const currentActivities = rowsToObjects(currentActivityRows);
        const oldLeads = rowsToObjects(crm3Leads.rows);
        const oldDeals = rowsToObjects(crm3Deals.rows);
        const oldInstallations = rowsToObjects(crm3Installations.rows);
        const oldActivities = rowsToObjects(crm3Activities.rows);
        const currentLeadMaps = mapLeadsByPhone(currentLeads);
        const oldLeadIdToPhone = buildLeadIdToPhoneMap(oldLeads);
        const currentActivityUrlKeys = new Set(
            currentActivities.map(item => buildActivityUrlKey(item.object, firstValue(item.object, ["lead_id"])))
        );

        const leadUpdates = [];
        const dealUpdates = [];
        const installationCreates = [];
        const activityCreates = [];
        const plannedActivityKeys = new Set();
        const response = {
            success: true,
            dry_run: dryRun,
            write_enabled: !dryRun,
            no_writes_performed: dryRun,
            restore_step: restoreStep,
            limit_per_step: restoreLimit,
            partial_completed: false,
            continue_required: false,
            next_step: null,
            source_sheets: {
                crm3_leads: {
                    sheet_name: crm3Leads.sheetName || null,
                    spreadsheet_id_source: crm3Leads.spreadsheet_id_source,
                },
                crm3_deals: {
                    sheet_name: crm3Deals.sheetName || null,
                    spreadsheet_id_source: crm3Deals.spreadsheet_id_source,
                },
                crm3_installations: {
                    sheet_name: crm3Installations.sheetName || null,
                    spreadsheet_id_source: crm3Installations.spreadsheet_id_source,
                },
                crm3_activity_log: {
                    sheet_name: crm3Activities.sheetName || null,
                    spreadsheet_id_source: crm3Activities.spreadsheet_id_source,
                },
            },
            counts: {
                matched_phones: 0,
                unmatched_phones: 0,
                leads_update_candidates: 0,
                leads_updated: 0,
                deals_update_candidates: 0,
                deals_updated: 0,
                installation_create_candidates: 0,
                created_installations: 0,
                activity_create_candidates: 0,
                created_activities: 0,
                skipped_duplicate_activities: 0,
                conflicts_skipped: 0,
                skipped_missing_current_deal: 0,
                skipped_existing_installation: 0,
                skipped_missing_phone: 0,
                leads_remaining: 0,
                deals_remaining: 0,
                installations_remaining: 0,
                activities_remaining: 0,
            },
            sample_lead_updates: [],
            sample_deal_updates: [],
            sample_installation_creates: [],
            sample_activity_creates: [],
        };

        for (const item of oldLeads) {
            const oldLead = item.object;
            const phone = resolveSnapshotPhone(oldLead, oldLeadIdToPhone);
            if (!phone) {
                response.counts.skipped_missing_phone++;
                continue;
            }

            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) {
                response.counts.unmatched_phones++;
                continue;
            }

            response.counts.matched_phones++;
            const restore = buildSafeRestorePatch({
                currentObject: currentLead.object,
                sourceObject: oldLead,
                fields: CRM3_SAFE_LEAD_RESTORE_FIELDS,
                allowUnknownCurrent: true,
            });
            response.counts.conflicts_skipped += restore.conflicts.length;

            if (Object.keys(restore.patch).length) {
                leadUpdates.push({
                    rowNumber: currentLead.rowNumber,
                    leadId: currentLead.leadId,
                    phone,
                    patch: restore.patch,
                    sourceRow: item.rowNumber,
                });
                response.counts.leads_update_candidates++;

                if (response.sample_lead_updates.length < sampleLimit) {
                    response.sample_lead_updates.push({
                        current_lead_id: currentLead.leadId,
                        phone,
                        source_row: item.rowNumber,
                        patch: restore.patch,
                    });
                }
            }
        }

        for (const item of oldDeals) {
            const oldDeal = item.object;
            if (!hasAnyField(oldDeal, CRM3_SAFE_DEAL_RESTORE_FIELDS)) continue;

            const phone = resolveSnapshotPhone(oldDeal, oldLeadIdToPhone);
            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) continue;

            const currentDeal = findCurrentByLeadId(currentDeals, currentLead.leadId);
            if (!currentDeal) {
                response.counts.skipped_missing_current_deal++;
                continue;
            }

            const restore = buildSafeRestorePatch({
                currentObject: currentDeal.object,
                sourceObject: oldDeal,
                fields: CRM3_SAFE_DEAL_RESTORE_FIELDS,
                allowUnknownCurrent: false,
            });
            response.counts.conflicts_skipped += restore.conflicts.length;

            if (Object.keys(restore.patch).length) {
                dealUpdates.push({
                    rowNumber: currentDeal.rowNumber,
                    leadId: currentLead.leadId,
                    phone,
                    patch: restore.patch,
                    sourceRow: item.rowNumber,
                });
                response.counts.deals_update_candidates++;

                if (response.sample_deal_updates.length < sampleLimit) {
                    response.sample_deal_updates.push({
                        current_lead_id: currentLead.leadId,
                        phone,
                        source_row: item.rowNumber,
                        patch: restore.patch,
                    });
                }
            }
        }

        for (const item of oldInstallations) {
            const oldInstallation = item.object;
            if (!hasAnyField(oldInstallation, CRM3_INSTALLATION_FIELDS)) continue;

            const phone = resolveSnapshotPhone(oldInstallation, oldLeadIdToPhone);
            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) continue;

            const currentInstallation = findCurrentByLeadId(currentInstallations, currentLead.leadId);
            if (currentInstallation) {
                response.counts.skipped_existing_installation++;
                continue;
            }

            const location = String(
                getRestoreFieldValue(oldInstallation, "location")
                || firstValue(oldInstallation, ["location_url"])
                || ""
            ).trim();
            const installationObject = {
                install_id: generateRestoreId("INST"),
                lead_id: currentLead.leadId,
                phone,
                install_status: getRestoreFieldValue(oldInstallation, "install_status") || "In Progress",
                preferred_install_date: getRestoreFieldValue(oldInstallation, "preferred_install_date"),
                preferred_install_time: getRestoreFieldValue(oldInstallation, "preferred_install_time"),
                location,
                location_url: firstValue(oldInstallation, ["location_url"]),
                machine_count: getRestoreFieldValue(oldInstallation, "machine_count"),
                note: getRestoreFieldValue(oldInstallation, "note"),
            };

            installationCreates.push({
                object: installationObject,
                sourceRow: item.rowNumber,
            });
            response.counts.installation_create_candidates++;

            if (response.sample_installation_creates.length < sampleLimit) {
                response.sample_installation_creates.push({
                    current_lead_id: currentLead.leadId,
                    phone,
                    source_row: item.rowNumber,
                    installation: installationObject,
                });
            }
        }

        for (const item of oldActivities) {
            const oldActivity = item.object;
            if (!hasAnyField(oldActivity, ACTIVITY_URL_FIELDS)) continue;

            const phone = resolveSnapshotPhone(oldActivity, oldLeadIdToPhone);
            const currentLead = currentLeadMaps.byPhone.get(phone);
            if (!currentLead) continue;

            const activityObject = {
                activity_id: generateRestoreId("ACT"),
                lead_id: currentLead.leadId,
                sheet_name: firstValue(oldActivity, ["sheet_name"]) || "CRM3_RESTORE",
                action_type: firstValue(oldActivity, ["action_type", "activity_type"]) || "restore_url_evidence",
                note: firstValue(oldActivity, ["note"]),
                audio_url: firstValue(oldActivity, ["audio_url", "audio_link"]),
                payment_url: firstValue(oldActivity, ["payment_url", "payment_slip_url"]),
                location_url: firstValue(oldActivity, ["location_url"]),
                created_by: "CRM3 Restore",
                created_at: firstValue(oldActivity, ["created_at", "activity_date"]) || nowIsoString(),
            };
            const duplicateKey = buildActivityUrlKey(activityObject, currentLead.leadId);

            if (currentActivityUrlKeys.has(duplicateKey) || plannedActivityKeys.has(duplicateKey)) {
                response.counts.skipped_duplicate_activities++;
                continue;
            }

            plannedActivityKeys.add(duplicateKey);
            activityCreates.push({
                object: activityObject,
                sourceRow: item.rowNumber,
            });
            response.counts.activity_create_candidates++;

            if (response.sample_activity_creates.length < sampleLimit) {
                response.sample_activity_creates.push({
                    current_lead_id: currentLead.leadId,
                    phone,
                    source_row: item.rowNumber,
                    activity: activityObject,
                });
            }
        }

        response.counts.leads_remaining = leadUpdates.length;
        response.counts.deals_remaining = dealUpdates.length;
        response.counts.installations_remaining = installationCreates.length;
        response.counts.activities_remaining = activityCreates.length;

        if (!dryRun) {
            try {
                if (shouldRunRestoreStep(restoreStep, "leads")) {
                    const chunk = leadUpdates.slice(0, restoreLimit);
                    if (chunk.length) {
                        response.counts.leads_updated = await googleSheets.updateObjectRows(
                            "LEADS_MAIN",
                            chunk.map(update => ({
                                rowNumber: update.rowNumber,
                                object: update.patch,
                            }))
                        );
                    }
                    response.counts.leads_remaining = Math.max(leadUpdates.length - response.counts.leads_updated, 0);
                }

                if (shouldRunRestoreStep(restoreStep, "deals")) {
                    const chunk = dealUpdates.slice(0, restoreLimit);
                    if (chunk.length) {
                        response.counts.deals_updated = await googleSheets.updateObjectRows(
                            "DEALS",
                            chunk.map(update => ({
                                rowNumber: update.rowNumber,
                                object: update.patch,
                            }))
                        );
                    }
                    response.counts.deals_remaining = Math.max(dealUpdates.length - response.counts.deals_updated, 0);
                }

                if (shouldRunRestoreStep(restoreStep, "installations")) {
                    const chunk = installationCreates.slice(0, restoreLimit);
                    if (chunk.length) {
                        await googleSheets.appendObjects("INSTALLATIONS", chunk.map(item => item.object));
                        response.counts.created_installations = chunk.length;
                    }
                    response.counts.installations_remaining = Math.max(installationCreates.length - response.counts.created_installations, 0);
                }

                if (shouldRunRestoreStep(restoreStep, "activities")) {
                    const chunk = activityCreates.slice(0, restoreLimit);
                    if (chunk.length) {
                        await googleSheets.appendObjects("ACTIVITY_LOG", chunk.map(item => item.object));
                        response.counts.created_activities = chunk.length;
                    }
                    response.counts.activities_remaining = Math.max(activityCreates.length - response.counts.created_activities, 0);
                }
            } catch (writeErr) {
                response.success = false;
                response.partial_completed = true;
                response.error = writeErr.response?.data || writeErr.message;
                response.quota_or_timeout = isQuotaOrTimeoutError(writeErr);
                response.continue_required = true;
                response.next_step = "Rerun the same restore endpoint after quota resets. The restore recomputes current sheet state and skips already restored rows.";
                return res.status(response.quota_or_timeout ? 429 : 500).json(response);
            }
        }

        if (dryRun) {
            response.counts.leads_updated = 0;
            response.counts.deals_updated = 0;
            response.counts.created_installations = 0;
            response.counts.created_activities = 0;
        }

        response.continue_required = !dryRun && (
            response.counts.leads_remaining > 0
            || response.counts.deals_remaining > 0
            || response.counts.installations_remaining > 0
            || response.counts.activities_remaining > 0
        );
        if (response.continue_required) {
            response.partial_completed = true;
            response.next_step = "Rerun the same endpoint with confirm=true. Already restored rows will be skipped by current-sheet matching/dedupe.";
        }

        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: dryRun,
            error: err.message,
        });
    }
}

module.exports = {
    handleCrm3RestoreAudit,
    handleFacebookRawAudit,
    handleCrm3SafeRestore,
};
