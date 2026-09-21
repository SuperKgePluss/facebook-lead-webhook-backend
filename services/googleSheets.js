const { google } = require("googleapis");
const {
    assertExactFacebookLeadgenId,
    buildFacebookRepeatSubmissionEvent,
    classifyFacebookIdentityMatch,
    dedupeRepeatSubmissionEvents,
    PHONE_COLLISION_REVIEW,
} = require("./facebookIdentity");

const SHEETS = {
    LEADS_MAIN: "LEADS_MAIN",
    LEAD_DETAILS: "LEAD_DETAILS",
    DEALS: "DEALS",
    INSTALLATIONS: "INSTALLATIONS",
    SYNC_STATE: "SYNC_STATE",
    ACTIVITY_LOG: "ACTIVITY_LOG",
};

const FACEBOOK_INGESTION_STATE = Object.freeze({
    COMPLETE_EXISTING: "COMPLETE_EXISTING",
    PARTIAL_EXISTING_REPAIRABLE: "PARTIAL_EXISTING_REPAIRABLE",
    PHONE_COLLISION_REVIEW: PHONE_COLLISION_REVIEW,
    SAFE_NEW: "SAFE_NEW",
    AMBIGUOUS_STOP: "AMBIGUOUS_STOP",
});

const HEADER_ROW = 1;
const DATA_START_ROW = 3;
const SYNC_STATE_DATA_ROW = 3;
const SYNC_STATE_HEADERS = [
    "job_id",
    "status",
    "mode",
    "current_form_index",
    "current_form_id",
    "current_form_name",
    "after_cursor",
    "processed_total",
    "inserted_total",
    "updated_existing_total",
    "skipped_existing_total",
    "skipped_empty_total",
    "failed_total",
    "forms_count",
    "started_at",
    "updated_at",
    "completed_at",
    "last_error",
];

const HEADER_ALIASES = {
    facebook_lead_id: "facebook_leadgen_id",
    fb_lead_id: "facebook_leadgen_id",
    lead_form_name: "lead_form_name",
    ad_set_name: "adset_name",
    adset_name: "adset_name",
    paid_amount: "price",
    install_date: "preferred_install_date",
    install_time: "preferred_install_time",
    time_slot: "preferred_install_time",
    quantity: "machine_count",
    device_count: "machine_count",
    installation_status: "install_status",
    activity_type: "action_type",
    activity_result: "new_value",
    result: "new_value",
    audio_link: "audio_url",
    activity_date: "created_at",
    import_source: "created_source",
};

function normalizeLeadStatusForSheet(status) {
    const raw = String(status || "").trim();
    const value = raw.toLowerCase();

    if (!raw || value === "unknown") return "New";
    if (["new"].includes(value)) return "New";
    if (["ongoing", "contacted", "interested", "follow-up", "follow up", "followup", "pending"].includes(value)) return "Ongoing";
    if (["installed", "installation complete"].includes(value)) return "Installed";
    if (["done", "closed", "closed won", "completed", "complete"].includes(value)) return "Done";
    if (["cancelled", "canceled", "not interested", "closed lost"].includes(value)) return "Cancelled";

    if (value.includes("cancel")) return "Cancelled";
    if (value.includes("not interested")) return "Cancelled";
    if (value.includes("install")) return "Installed";
    if (value.includes("closed") || value.includes("done") || value.includes("complete")) return "Done";
    if (value.includes("follow") || value.includes("pending") || value.includes("contact") || value.includes("interest")) return "Ongoing";

    return "New";
}

function normalizePaymentStatusForSheet(status) {
    const raw = String(status || "").trim();
    const value = raw.toLowerCase();

    if (!raw || value === "unknown") return "Unpaid";
    if (value === "paid") return "Paid";
    if (value === "unpaid") return "Unpaid";
    if (value === "cancelled" || value === "canceled") return "Cancelled";
    if (value === "partial" || value.includes("partial")) return "Unpaid";

    if (value.includes("cancel")) return "Cancelled";
    if (value.includes("unpaid")) return "Unpaid";
    if (value.includes("paid") && !value.includes("unpaid")) return "Paid";

    return "Unpaid";
}

function normalizeInstallationStatusForSheet(status) {
    const raw = String(status || "").trim();
    const value = raw.toLowerCase();

    if (value === "installed") return "Installed";
    if (value === "cancelled" || value === "canceled") return "Cancelled";
    if (value.includes("install") && !value.includes("progress")) return "Installed";
    if (value.includes("cancel")) return "Cancelled";

    return "In Progress";
}

function normalizePhone(phone) {
    let digits = String(phone || "").replace(/\D/g, "").trim();

    if (!digits) return "";

    if (digits.startsWith("0066") && digits.length > 4) {
        digits = digits.slice(2);
    }

    if (digits.startsWith("66") && digits.length === 11) {
        digits = "0" + digits.slice(2);
    }

    if (digits.length === 9 && /^[689]/.test(digits)) {
        digits = "0" + digits;
    }

    return /^0\d{9}$/.test(digits) ? digits : "";
}

function generateId(prefix) {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function dateToBangkokSheetsDateSerial(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return "";
    }

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    const epoch = Date.UTC(1899, 11, 30, 0, 0, 0, 0);
    const bangkokWallTimeAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second || 0),
        0
    );

    return (bangkokWallTimeAsUtc - epoch) / 86400000;
}

function valueToBangkokSheetsDateSerial(value) {
    if (value === null || value === undefined || value === "") {
        return "";
    }

    if (value instanceof Date) {
        return dateToBangkokSheetsDateSerial(value);
    }

    const parsed = new Date(String(value).trim());
    return Number.isNaN(parsed.getTime()) ? "" : dateToBangkokSheetsDateSerial(parsed);
}


function columnToLetter(columnNumber) {
    let column = columnNumber;
    let letter = "";

    while (column > 0) {
        const remainder = (column - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        column = Math.floor((column - 1) / 26);
    }

    return letter;
}

function getLastDataRow(rows) {
    for (let i = rows.length - 1; i >= DATA_START_ROW - 1; i--) {
        if (rows[i] && rows[i].some(cell => String(cell || "").trim() !== "")) {
            return i + 1;
        }
    }

    return DATA_START_ROW - 1;
}

function getNextDataRow(rows) {
    return Math.max(getLastDataRow(rows) + 1, DATA_START_ROW);
}

async function ensureSheetHeaders(sheets, spreadsheetId, sheetName, rows, requiredHeaders) {
    const headers = rows[HEADER_ROW - 1] || [];
    const existingHeaders = new Set(headers.map(normalizeHeaderName).filter(Boolean));
    const missingHeaders = requiredHeaders.filter(header => !existingHeaders.has(normalizeHeaderName(header)));

    if (!missingHeaders.length) {
        return headers;
    }

    const startColumn = columnToLetter(headers.length + 1);
    const endColumn = columnToLetter(headers.length + missingHeaders.length);
    await updateSheet(
        sheets,
        spreadsheetId,
        `${sheetName}!${startColumn}${HEADER_ROW}:${endColumn}${HEADER_ROW}`,
        [missingHeaders]
    );

    const updatedHeaders = [...headers, ...missingHeaders];
    rows[HEADER_ROW - 1] = updatedHeaders;
    return updatedHeaders;
}

function normalizeHeaderName(headerName) {
    const normalized = String(headerName || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    return HEADER_ALIASES[normalized] || normalized;
}

function groupObjectRanges(headers, rowNumber, object) {
    const groups = [];
    let currentGroup = null;

    headers.forEach((header, index) => {
        const canonicalHeader = normalizeHeaderName(header);

        if (
            !canonicalHeader ||
            !Object.prototype.hasOwnProperty.call(object, canonicalHeader)
        ) {
            if (currentGroup) {
                groups.push(currentGroup);
                currentGroup = null;
            }
            return;
        }

        const value = getObjectValueForCanonicalHeader(object, canonicalHeader);

        if (!currentGroup) {
            currentGroup = {
                startIndex: index,
                endIndex: index,
                values: [value],
            };
            return;
        }

        if (index === currentGroup.endIndex + 1) {
            currentGroup.endIndex = index;
            currentGroup.values.push(value);
            return;
        }

        groups.push(currentGroup);
        currentGroup = {
            startIndex: index,
            endIndex: index,
            values: [value],
        };
    });

    if (currentGroup) {
        groups.push(currentGroup);
    }

    return groups.map(group => {
        const startColumn = columnToLetter(group.startIndex + 1);
        const endColumn = columnToLetter(group.endIndex + 1);

        return {
            rowNumber,
            startIndex: group.startIndex,
            endIndex: group.endIndex,
            canonicalHeaders: headers
                .slice(group.startIndex, group.endIndex + 1)
                .map(normalizeHeaderName),
            rangeSuffix: `${startColumn}${rowNumber}:${endColumn}${rowNumber}`,
            values: [group.values],
        };
    });
}

function buildObjectWriteOperations(sheetName, headers, rowNumber, object, options = {}) {
    const rawFields = new Set((options.rawFields || []).map(normalizeHeaderName));
    if (sheetName === SHEETS.LEAD_DETAILS) rawFields.add("facebook_leadgen_id");
    const identityField = normalizeHeaderName(options.identityField || "facebook_leadgen_id");
    const enteredData = [];
    const rawData = [];
    const identityAnchorData = [];
    const identityVerifications = [];

    for (const group of groupObjectRanges(headers, rowNumber, object)) {
        let segment = null;
        const flushSegment = () => {
            if (!segment) return;

            const startColumn = columnToLetter(segment.startIndex + 1);
            const endColumn = columnToLetter(segment.endIndex + 1);
            const operation = {
                range: `${sheetName}!${startColumn}${rowNumber}:${endColumn}${rowNumber}`,
                values: [segment.values],
            };

            if (segment.raw) rawData.push(operation);
            else enteredData.push(operation);
            segment = null;
        };

        group.canonicalHeaders.forEach((canonicalHeader, offset) => {
            const raw = rawFields.has(canonicalHeader);
            const index = group.startIndex + offset;
            const value = group.values[0][offset];

            if (!segment || segment.raw !== raw || segment.endIndex + 1 !== index) {
                flushSegment();
                segment = {
                    startIndex: index,
                    endIndex: index,
                    values: [value],
                    raw,
                };
            } else {
                segment.endIndex = index;
                segment.values.push(value);
            }

            if (raw && canonicalHeader === identityField) {
                identityVerifications.push({
                    sheetName,
                    rowNumber,
                    headerName: canonicalHeader,
                    expectedValue: value,
                });
            }
        });

        flushSegment();
    }

    const anchorFields = sheetName === SHEETS.LEAD_DETAILS
        ? ["lead_id"]
        : sheetName === SHEETS.ACTIVITY_LOG
            ? ["activity_id", "event_id", "idempotency_key"]
            : [];
    if (identityVerifications.length && anchorFields.length) {
        for (const anchorField of anchorFields) {
            const index = headers.findIndex(header => normalizeHeaderName(header) === anchorField);
            if (index < 0 || !Object.prototype.hasOwnProperty.call(object, anchorField)) continue;
            const column = columnToLetter(index + 1);
            identityAnchorData.push({
                range: `${sheetName}!${column}${rowNumber}:${column}${rowNumber}`,
                values: [[getObjectValueForCanonicalHeader(object, anchorField)]],
            });
        }
    }

    return { enteredData, rawData, identityAnchorData, identityVerifications };
}

async function createSheetsClient() {
    const privateKey = process.env.GOOGLE_PRIVATE_KEY;

    if (!process.env.GOOGLE_CLIENT_EMAIL) {
        throw new Error("Missing GOOGLE_CLIENT_EMAIL");
    }

    if (!privateKey) {
        throw new Error("Missing GOOGLE_PRIVATE_KEY");
    }

    if (!process.env.GOOGLE_SHEET_ID) {
        throw new Error("Missing GOOGLE_SHEET_ID");
    }

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: privateKey.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    return { sheets, spreadsheetId };
}

async function readSheet(sheets, spreadsheetId, range) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    return result.data.values || [];
}

async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
    const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties.title",
    });
    const exists = (spreadsheet.data.sheets || [])
        .some(sheet => sheet.properties?.title === sheetName);

    if (exists) return;

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
            requests: [
                {
                    addSheet: {
                        properties: {
                            title: sheetName,
                        },
                    },
                },
            ],
        },
    });
}

async function updateSheet(sheets, spreadsheetId, range, values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
    });
}

async function ensureSyncStateSheet() {
    const { sheets, spreadsheetId } = await createSheetsClient();
    await ensureSheetExists(sheets, spreadsheetId, SHEETS.SYNC_STATE);

    const rows = await readSheet(sheets, spreadsheetId, `${SHEETS.SYNC_STATE}!A:ZZ`);
    const headers = rows[HEADER_ROW - 1] || [];
    const existingHeaders = headers.map(normalizeHeaderName);
    const hasAllHeaders = SYNC_STATE_HEADERS.every(header => existingHeaders.includes(header));

    if (!hasAllHeaders) {
        await updateSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.SYNC_STATE}!A${HEADER_ROW}:${columnToLetter(SYNC_STATE_HEADERS.length)}${HEADER_ROW}`,
            [SYNC_STATE_HEADERS]
        );
        rows[HEADER_ROW - 1] = SYNC_STATE_HEADERS;
    }

    return {
        sheets,
        spreadsheetId,
        rows,
        headers: rows[HEADER_ROW - 1] || SYNC_STATE_HEADERS,
    };
}

async function getFacebookBackfillState() {
    const { rows, headers } = await ensureSyncStateSheet();
    const state = rowToObject(headers, rows[SYNC_STATE_DATA_ROW - 1] || []);

    if (!String(state.job_id || "").trim()) return null;
    return state;
}

async function saveFacebookBackfillState(state) {
    const { sheets, spreadsheetId, headers } = await ensureSyncStateSheet();
    const normalizedState = normalizeSheetObject(SHEETS.SYNC_STATE, state);
    const row = objectToRow(headers, normalizedState);

    await updateSheet(
        sheets,
        spreadsheetId,
        `${SHEETS.SYNC_STATE}!A${SYNC_STATE_DATA_ROW}:${columnToLetter(headers.length)}${SYNC_STATE_DATA_ROW}`,
        [row]
    );

    return normalizedState;
}

async function batchUpdateValues(sheets, spreadsheetId, data, valueInputOption = "USER_ENTERED") {
    if (!data.length) return;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption,
            data,
        },
    });
}

async function verifyExactFacebookLeadgenReadbacks(sheets, spreadsheetId, verifications) {
    const uniqueVerifications = Array.from(new Map(
        verifications.map(item => [
            `${item.sheetName}:${item.rowNumber}:${item.headerName}`,
            item,
        ])
    ).values());

    for (const verification of uniqueVerifications) {
        const headers = await readSheet(
            sheets,
            spreadsheetId,
            `${verification.sheetName}!A${verification.rowNumber}:ZZ${verification.rowNumber}`
        );
        const row = headers[0] || [];
        const headerRows = await readSheet(
            sheets,
            spreadsheetId,
            `${verification.sheetName}!A${HEADER_ROW}:ZZ${HEADER_ROW}`
        );
        const header = headerRows[0] || [];
        const index = header.findIndex(item => normalizeHeaderName(item) === verification.headerName);
        const actualValue = index >= 0 ? row[index] : undefined;

        if (typeof actualValue !== "string" || actualValue !== verification.expectedValue) {
            throw new Error(
                `Facebook Leadgen ID readback mismatch at ${verification.sheetName} row ${verification.rowNumber}.`
            );
        }

        assertExactFacebookLeadgenId(actualValue, `${verification.sheetName}.${verification.headerName}`);
    }
}

async function writeObjectOperations(sheets, spreadsheetId, entries) {
    const enteredData = [];
    const rawData = [];
    const identityAnchorData = [];
    const verifications = [];

    for (const entry of entries) {
        const operations = buildObjectWriteOperations(
            entry.sheetName,
            entry.headers,
            entry.rowNumber,
            entry.object,
            entry.options
        );
        enteredData.push(...operations.enteredData);
        rawData.push(...operations.rawData);
        identityAnchorData.push(...operations.identityAnchorData);
        verifications.push(...operations.identityVerifications);
    }

    await batchUpdateValues(sheets, spreadsheetId, rawData, "RAW");
    await batchUpdateValues(sheets, spreadsheetId, identityAnchorData);

    if (verifications.length) {
        await verifyExactFacebookLeadgenReadbacks(sheets, spreadsheetId, verifications);
    }

    await batchUpdateValues(sheets, spreadsheetId, enteredData);
}

async function getSheetRows(sheetName) {
    const { sheets, spreadsheetId } = await createSheetsClient();
    return readSheet(sheets, spreadsheetId, `${sheetName}!A:ZZ`);
}

async function getHeaders(sheetName) {
    const rows = await getSheetRows(sheetName);
    return rows[HEADER_ROW - 1] || [];
}

function headerIndex(headers, headerName) {
    const target = normalizeHeaderName(headerName);
    const index = headers.findIndex(header => normalizeHeaderName(header) === target);

    if (index === -1) {
        throw new Error(`Missing required header: ${target}`);
    }

    return index;
}

function rowToObject(headers, row) {
    return headers.reduce((object, header, index) => {
        const canonicalHeader = normalizeHeaderName(header);

        if (canonicalHeader) {
            object[canonicalHeader] = row?.[index] || "";
        }

        return object;
    }, {});
}

function getObjectValueForCanonicalHeader(object, canonicalHeader) {
    if (!object) return "";
    if (Object.prototype.hasOwnProperty.call(object, canonicalHeader)) {
        const value = object[canonicalHeader];
        if (value !== undefined && value !== null) return value;
    }
    if (canonicalHeader === "price" && Object.prototype.hasOwnProperty.call(object, "paid_amount")) {
        return object.paid_amount ?? "";
    }
    return "";
}

function isNonEmptyValue(value) {
    return String(value ?? "").trim() !== "";
}

function mergeObjectPreserveExisting(existingObject = {}, incomingObject = {}) {
    const merged = { ...existingObject };

    for (const [key, value] of Object.entries(incomingObject)) {
        if (!isNonEmptyValue(value)) continue;
        if (!isNonEmptyValue(merged[key])) merged[key] = value;
    }

    return merged;
}

function normalizeComparableSheetValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(Math.round(value * 10000000000) / 10000000000);
    }
    return String(value).trim();
}

function hasMeaningfulObjectChanges(headers, existingObject = {}, proposedObject = {}, options = {}) {
    const excludedFields = new Set((options.exclude || []).map(normalizeHeaderName));
    const headerSet = new Set((headers || []).map(normalizeHeaderName).filter(Boolean));

    for (const [key, proposedValue] of Object.entries(proposedObject || {})) {
        const canonicalKey = normalizeHeaderName(key);
        if (!canonicalKey || excludedFields.has(canonicalKey) || !headerSet.has(canonicalKey)) continue;

        const existingValue = getObjectValueForCanonicalHeader(existingObject, canonicalKey);
        if (normalizeComparableSheetValue(existingValue) !== normalizeComparableSheetValue(proposedValue)) {
            return true;
        }
    }

    return false;
}

function getLeadDetailDedupeKeys(object = {}) {
    const facebookLeadgenId = String(object.facebook_leadgen_id || "").trim();
    const phone = normalizePhone(object.raw_phone || object.phone);
    const leadId = String(object.lead_id || "").trim();

    return {
        facebookLeadgenId,
        phone,
        leadId,
    };
}

function findLeadDetailRowForObject(headers, rows, detailObject = {}) {
    const incoming = getLeadDetailDedupeKeys(detailObject);
    let phoneMatch = null;
    let leadIdMatch = null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const rowObject = rowToObject(headers, rows[i] || []);
        const existing = getLeadDetailDedupeKeys(rowObject);

        if (incoming.facebookLeadgenId && existing.facebookLeadgenId === incoming.facebookLeadgenId) {
            return { ...rowObject, rowNumber: i + 1, matchType: "facebook_leadgen_id" };
        }

        if (!phoneMatch && incoming.phone && existing.phone === incoming.phone) {
            phoneMatch = { ...rowObject, rowNumber: i + 1, matchType: "raw_phone" };
        }

        if (!leadIdMatch && incoming.leadId && existing.leadId === incoming.leadId) {
            leadIdMatch = { ...rowObject, rowNumber: i + 1, matchType: "lead_id" };
        }
    }

    return phoneMatch || leadIdMatch;
}

function findLeadDetailRowsByFacebookLeadgenId(headers, rows, facebookLeadgenId) {
    const leadgenIndex = headerIndex(headers, "facebook_leadgen_id");
    const target = assertExactFacebookLeadgenId(facebookLeadgenId, "Facebook Leadgen ID");
    const matches = [];

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const value = row[leadgenIndex];

        if (typeof value === "string" && value === target) {
            matches.push({
                ...rowToObject(headers, row),
                rowNumber: i + 1,
                matchType: "facebook_leadgen_id",
            });
        }
    }

    return matches;
}

function findLeadRowsByLeadId(headers, rows, leadId) {
    const leadIdIndex = headerIndex(headers, "lead_id");
    const target = String(leadId || "").trim();
    if (!target) return [];

    const matches = [];
    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];
        if (String(row[leadIdIndex] || "").trim() !== target) continue;
        matches.push({
            ...rowToObject(headers, row),
            rowNumber: i + 1,
        });
    }

    return matches;
}

function inspectFacebookIngestionState({
    facebookLeadgenId,
    lead,
    leadHeaders,
    leadsRows,
    detailHeaders,
    detailsRows,
    dealHeaders,
    dealsRows,
} = {}) {
    const targetId = assertExactFacebookLeadgenId(facebookLeadgenId, "Facebook Leadgen ID");
    const exactDetailRows = findLeadDetailRowsByFacebookLeadgenId(
        detailHeaders,
        detailsRows,
        targetId
    );

    if (!exactDetailRows.length) {
        return {
            classification: FACEBOOK_INGESTION_STATE.SAFE_NEW,
            facebookLeadgenId: targetId,
            exactDetailRows,
            detail: null,
            lead: null,
            deals: [],
            leadId: "",
            detailNeedsRepair: false,
            leadMissing: false,
            dealMissing: false,
        };
    }

    if (exactDetailRows.length > 1) {
        return {
            classification: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
            reason: "duplicate_exact_facebook_id",
            facebookLeadgenId: targetId,
            exactDetailRows,
        };
    }

    const detail = exactDetailRows[0];
    const leadId = String(detail.lead_id || "").trim();
    if (!leadId) {
        return {
            classification: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
            reason: "exact_facebook_id_missing_lead_id",
            facebookLeadgenId: targetId,
            exactDetailRows,
            detail,
            leadId,
        };
    }

    const leadRows = findLeadRowsByLeadId(leadHeaders, leadsRows, leadId);
    if (leadRows.length > 1) {
        return {
            classification: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
            reason: "multiple_leads_for_detail_lead_id",
            facebookLeadgenId: targetId,
            exactDetailRows,
            detail,
            leadId,
            leadRows,
        };
    }

    const existingPhoneLead = findLeadByPhone(
        leadHeaders,
        leadsRows,
        lead?.phone || lead?.raw_phone || detail.raw_phone
    );
    if (existingPhoneLead && String(existingPhoneLead.lead_id || "").trim() !== leadId) {
        return {
            classification: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
            reason: "exact_detail_conflicts_with_phone_lead",
            facebookLeadgenId: targetId,
            exactDetailRows,
            detail,
            leadId,
            leadRows,
            existingPhoneLead,
        };
    }

    const existingLead = leadRows[0] || null;
    const deals = findLeadRowsByLeadId(dealHeaders, dealsRows, leadId);
    const expectedDetail = lead ? buildLeadDetailObject(leadId, lead) : null;
    const mergedDetail = expectedDetail
        ? mergeObjectPreserveExisting(detail, expectedDetail)
        : detail;
    const detailNeedsRepair = Boolean(
        expectedDetail
        && hasMeaningfulObjectChanges(detailHeaders, detail, mergedDetail)
    );
    const leadMissing = !existingLead;
    const dealMissing = deals.length === 0;

    return {
        classification: !leadMissing && !dealMissing && !detailNeedsRepair
            ? FACEBOOK_INGESTION_STATE.COMPLETE_EXISTING
            : FACEBOOK_INGESTION_STATE.PARTIAL_EXISTING_REPAIRABLE,
        facebookLeadgenId: targetId,
        exactDetailRows,
        detail,
        lead: existingLead,
        leadRows,
        deals,
        leadId,
        detailNeedsRepair,
        leadMissing,
        dealMissing,
        expectedDetail,
    };
}

function normalizeSheetObject(sheetName, object = {}) {
    const normalizedObject = { ...object };

    if (sheetName === SHEETS.LEADS_MAIN) {
        if (Object.prototype.hasOwnProperty.call(normalizedObject, "lead_status")) {
            normalizedObject.lead_status = normalizeLeadStatusForSheet(normalizedObject.lead_status);
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "status")) {
            normalizedObject.status = normalizeLeadStatusForSheet(normalizedObject.status);
        }
    }

    if (sheetName === SHEETS.DEALS) {
        if (Object.prototype.hasOwnProperty.call(normalizedObject, "paid_amount")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "price")) {
            normalizedObject.price = normalizedObject.paid_amount;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "payment_status")) {
            normalizedObject.payment_status = normalizePaymentStatusForSheet(normalizedObject.payment_status);
        }
    }

    if (sheetName === SHEETS.INSTALLATIONS) {
        const copyIfMissing = (target, sources) => {
            if (Object.prototype.hasOwnProperty.call(normalizedObject, target)) return;
            for (const source of sources) {
                if (Object.prototype.hasOwnProperty.call(normalizedObject, source)
                    && String(normalizedObject[source] ?? "").trim()) {
                    normalizedObject[target] = normalizedObject[source];
                    return;
                }
            }
        };

        copyIfMissing("preferred_install_date", ["install_date"]);
        copyIfMissing("preferred_install_time", ["install_time", "time_slot"]);
        copyIfMissing("machine_count", ["quantity", "device_count"]);
        copyIfMissing("location", ["location", "address", "zone"]);

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "install_status")
            || Object.prototype.hasOwnProperty.call(normalizedObject, "installation_status")) {
            normalizedObject.install_status = normalizeInstallationStatusForSheet(
                normalizedObject.install_status || normalizedObject.installation_status
            );
        }
    }

    if (sheetName === "ACTIVITY_LOG") {
        if (Object.prototype.hasOwnProperty.call(normalizedObject, "activity_type")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "action_type")) {
            normalizedObject.action_type = normalizedObject.activity_type;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "activity_result")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "new_value")) {
            normalizedObject.new_value = normalizedObject.activity_result;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "result")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "new_value")) {
            normalizedObject.new_value = normalizedObject.result;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "audio_link")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "audio_url")) {
            normalizedObject.audio_url = normalizedObject.audio_link;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "activity_date")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "created_at")) {
            normalizedObject.created_at = normalizedObject.activity_date;
        }
    }

    return normalizedObject;
}

function objectToRow(headers, object) {
    return headers.map(header => getObjectValueForCanonicalHeader(object, normalizeHeaderName(header)));
}

async function appendObjects(sheetName, objects, options = {}) {
    if (!objects.length) return [];

    const client = await createSheetsClient();
    return appendObjectsWithClient(sheetName, objects, options, client);
}

async function appendObjectsWithClient(sheetName, objects, options = {}, { sheets, spreadsheetId }) {
    if (!objects.length) return [];

    const rows = await readSheet(sheets, spreadsheetId, `${sheetName}!A:ZZ`);
    const headers = rows[HEADER_ROW - 1] || [];
    const workingRows = rows.map(row => [...row]);
    let nextRow = getNextDataRow(rows);
    const appendedRows = [];
    const entries = [];

    for (const object of objects) {
        const normalizedObject = normalizeSheetObject(sheetName, object);
        let rowNumber;

        if (sheetName === SHEETS.LEAD_DETAILS && normalizedObject.facebook_leadgen_id) {
            const exactId = assertExactFacebookLeadgenId(
                normalizedObject.facebook_leadgen_id,
                "LEAD_DETAILS.facebook_leadgen_id"
            );
            const exactRows = findLeadDetailRowsByFacebookLeadgenId(
                headers,
                workingRows,
                exactId
            );

            if (exactRows.length > 1) {
                throw new Error(
                    `AMBIGUOUS_STOP: duplicate LEAD_DETAILS rows for Facebook Leadgen ID ${exactId}.`
                );
            }

            if (exactRows.length === 1) {
                rowNumber = exactRows[0].rowNumber;
                const merged = mergeObjectPreserveExisting(exactRows[0], normalizedObject);
                if (hasMeaningfulObjectChanges(headers, exactRows[0], merged)) {
                    entries.push({
                        sheetName,
                        headers,
                        rowNumber,
                        object: merged,
                        options,
                    });
                    workingRows[rowNumber - 1] = objectToRow(headers, merged);
                }
                appendedRows.push(rowNumber);
                continue;
            }
        }

        rowNumber = nextRow++;
        entries.push({
            sheetName,
            headers,
            rowNumber,
            object: normalizedObject,
            options,
        });
        workingRows[rowNumber - 1] = objectToRow(headers, normalizedObject);
        appendedRows.push(rowNumber);
    }

    await writeObjectOperations(sheets, spreadsheetId, entries);

    return appendedRows;
}

async function updateObjectRow(sheetName, rowNumber, object) {
    const { sheets, spreadsheetId } = await createSheetsClient();
    const headers = await getHeaders(sheetName);
    await writeObjectOperations(sheets, spreadsheetId, [{
        sheetName,
        headers,
        rowNumber,
        object: normalizeSheetObject(sheetName, object),
        options: {},
    }]);
}

async function updateObjectRows(sheetName, updates, chunkSize = 100) {
    if (!updates.length) return 0;

    const { sheets, spreadsheetId } = await createSheetsClient();
    const headers = await getHeaders(sheetName);
    const entries = [];

    for (const update of updates) {
        entries.push({
            sheetName,
            headers,
            rowNumber: update.rowNumber,
            object: normalizeSheetObject(sheetName, update.object || update.patch || {}),
            options: {},
        });
    }

    for (let i = 0; i < entries.length; i += chunkSize) {
        await writeObjectOperations(sheets, spreadsheetId, entries.slice(i, i + chunkSize));
    }

    return updates.length;
}

async function upsertLeadDetailObject(detailObject) {
    const rows = await getSheetRows(SHEETS.LEAD_DETAILS);
    const headers = rows[HEADER_ROW - 1] || [];
    const rawIncomingFacebookId = detailObject.facebook_leadgen_id;
    const incomingFacebookId = rawIncomingFacebookId
        ? assertExactFacebookLeadgenId(rawIncomingFacebookId, "LEAD_DETAILS.facebook_leadgen_id")
        : "";
    if (incomingFacebookId) {
        const exactRows = findLeadDetailRowsByFacebookLeadgenId(
            headers,
            rows,
            incomingFacebookId
        );
        if (exactRows.length > 1) {
            throw new Error(
                `AMBIGUOUS_STOP: duplicate LEAD_DETAILS rows for Facebook Leadgen ID ${incomingFacebookId}.`
            );
        }
    }
    const existing = findLeadDetailRowForObject(headers, rows, detailObject);
    const existingFacebookId = String(existing?.facebook_leadgen_id || "").trim();

    if (
        incomingFacebookId
        && existing?.rowNumber
        && existing.matchType !== "facebook_leadgen_id"
        && existingFacebookId
        && existingFacebookId !== incomingFacebookId
    ) {
        throw new Error(`${PHONE_COLLISION_REVIEW}: Facebook identity does not match the existing Lead Details row.`);
    }

    if (existing?.rowNumber) {
        const merged = mergeObjectPreserveExisting(existing, detailObject);
        await updateObjectRow(SHEETS.LEAD_DETAILS, existing.rowNumber, merged);
        return {
            action: "updated_existing",
            rowNumber: existing.rowNumber,
            matchType: existing.matchType,
        };
    }

    const appendedRows = await appendObjects(SHEETS.LEAD_DETAILS, [detailObject]);
    return {
        action: "created",
        rowNumber: appendedRows[0] || null,
        matchType: "",
    };
}

function findPrimaryFacebookLeadgenId(headers, rows, leadId) {
    const target = String(leadId || "").trim();
    if (!target) return "";

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const object = rowToObject(headers, rows[i] || []);
        if (String(object.lead_id || "").trim() !== target) continue;
        return String(object.facebook_leadgen_id || "").trim();
    }

    return "";
}

function validateFacebookRepeatSubmissionActivityHeaders(headers) {
    const normalizedHeaders = new Set((headers || []).map(normalizeHeaderName));
    const identityField = normalizedHeaders.has("facebook_leadgen_id")
        ? "facebook_leadgen_id"
        : normalizedHeaders.has("new_value")
            ? "new_value"
            : "";
    const eventIdFields = ["activity_id", "event_id", "idempotency_key"]
        .filter(field => normalizedHeaders.has(field));
    const requiredFields = [
        "lead_id",
        "sheet_name",
        "action_type",
        "old_value",
        "note",
        "created_by",
        "created_at",
    ];
    const missingFields = requiredFields.filter(field => !normalizedHeaders.has(field));

    if (!identityField) {
        throw new Error(
            "ACTIVITY_LOG_SCHEMA_INVALID: expected facebook_leadgen_id or new_value for the exact secondary Facebook ID."
        );
    }

    if (!eventIdFields.length) {
        throw new Error(
            "ACTIVITY_LOG_SCHEMA_INVALID: expected activity_id, event_id, or idempotency_key."
        );
    }

    if (missingFields.length) {
        throw new Error(
            `ACTIVITY_LOG_SCHEMA_INVALID: missing required field(s): ${missingFields.join(", ")}.`
        );
    }

    return { identityField, eventIdFields };
}

async function appendFacebookRepeatSubmissionEvents(sheets, spreadsheetId, events) {
    if (!events.length) {
        return { created: 0, skipped_existing: 0 };
    }

    const rows = await readSheet(sheets, spreadsheetId, `${SHEETS.ACTIVITY_LOG}!A:ZZ`);
    const headers = rows[HEADER_ROW - 1] || [];
    const { identityField, eventIdFields } = validateFacebookRepeatSubmissionActivityHeaders(headers);

    const existingEventIds = new Set();
    rows.slice(DATA_START_ROW - 1).forEach(row => {
        const object = rowToObject(headers, row);
        for (const field of eventIdFields) {
            const value = String(object[field] || "").trim();
            if (value) existingEventIds.add(value);
        }
    });

    const { pendingEvents, skippedExisting } = dedupeRepeatSubmissionEvents(existingEventIds, events);
    if (!pendingEvents.length) {
        return { created: 0, skipped_existing: skippedExisting };
    }

    const entries = [];
    let nextRow = getNextDataRow(rows);
    for (const event of pendingEvents) {
        entries.push({
            sheetName: SHEETS.ACTIVITY_LOG,
            headers,
            rowNumber: nextRow++,
            object: event,
            options: {
                rawFields: ["facebook_leadgen_id", "new_value"],
                identityField,
            },
        });
    }

    await writeObjectOperations(sheets, spreadsheetId, entries);
    return {
        created: pendingEvents.length,
        skipped_existing: skippedExisting,
    };
}

async function verifyCompleteFacebookIngestionStates(sheets, spreadsheetId, targets) {
    const uniqueTargets = Array.from(new Map(
        (targets || []).map(target => [target.facebookLeadgenId, target])
    ).values());
    if (!uniqueTargets.length) return;

    const [leadsRows, detailsRows, dealsRows] = await Promise.all([
        readSheet(sheets, spreadsheetId, `${SHEETS.LEADS_MAIN}!A:ZZ`),
        readSheet(sheets, spreadsheetId, `${SHEETS.LEAD_DETAILS}!A:ZZ`),
        readSheet(sheets, spreadsheetId, `${SHEETS.DEALS}!A:ZZ`),
    ]);
    const leadHeaders = leadsRows[HEADER_ROW - 1] || [];
    const detailHeaders = detailsRows[HEADER_ROW - 1] || [];
    const dealHeaders = dealsRows[HEADER_ROW - 1] || [];

    for (const target of uniqueTargets) {
        const state = inspectFacebookIngestionState({
            facebookLeadgenId: target.facebookLeadgenId,
            lead: target.lead,
            leadHeaders,
            leadsRows,
            detailHeaders,
            detailsRows,
            dealHeaders,
            dealsRows,
        });

        if (state.classification !== FACEBOOK_INGESTION_STATE.COMPLETE_EXISTING) {
            throw new Error(
                `FACEBOOK_INGESTION_STATE_INCOMPLETE: ${target.facebookLeadgenId} is ${state.classification}.`
            );
        }
    }
}

async function deleteSheetRows(sheetName, rowNumbers) {
    const rowsToDelete = Array.from(new Set(
        (Array.isArray(rowNumbers) ? rowNumbers : [])
            .map(row => Number(row))
            .filter(row => Number.isInteger(row) && row >= DATA_START_ROW)
    )).sort((a, b) => b - a);

    if (!rowsToDelete.length) return 0;

    const { sheets, spreadsheetId } = await createSheetsClient();
    const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties",
    });
    const sheet = (spreadsheet.data.sheets || [])
        .find(item => item.properties?.title === sheetName);

    if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) {
        throw new Error(`Missing sheet for row deletion: ${sheetName}`);
    }

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
            requests: rowsToDelete.map(rowNumber => ({
                deleteDimension: {
                    range: {
                        sheetId: sheet.properties.sheetId,
                        dimension: "ROWS",
                        startIndex: rowNumber - 1,
                        endIndex: rowNumber,
                    },
                },
            })),
        },
    });

    return rowsToDelete.length;
}

function findLeadByPhone(headers, rows, phone) {
    const phoneIndex = headerIndex(headers, "phone");
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) return null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const rowPhone = normalizePhone(row[phoneIndex]);

        if (rowPhone && rowPhone === normalizedPhone) {
            return {
                ...rowToObject(headers, row),
                rowNumber: i + 1,
            };
        }
    }

    return null;
}

function findLeadDetailByLeadgenId(headers, rows, leadgenId) {
    const leadgenIndex = headerIndex(headers, "facebook_leadgen_id");
    const target = String(leadgenId || "").trim();

    if (!target) return null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];

        if (String(row[leadgenIndex] || "").trim() === target) {
            return {
                ...rowToObject(headers, row),
                rowNumber: i + 1,
            };
        }
    }

    return null;
}

function findLatestDealByLeadId(headers, rows, leadId) {
    const leadIdIndex = headerIndex(headers, "lead_id");
    const target = String(leadId || "").trim();
    let latestDeal = null;

    if (!target) return null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];

        if (String(row[leadIdIndex] || "").trim() === target) {
            latestDeal = {
                ...rowToObject(headers, row),
                rowNumber: i + 1,
            };
        }
    }

    return latestDeal;
}

function isCompletedLead(leadObject) {
    const status = String(leadObject?.lead_status || "").trim().toLowerCase();
    return status === "completed" || status === "closed won";
}

function buildLeadMainObject(leadId, lead, existingLead = null) {
    const now = dateToBangkokSheetsDateSerial(new Date());
    const facebookCreatedTime = valueToBangkokSheetsDateSerial(lead.facebook_created_time);

    return {
        lead_id: leadId,
        customer_name: lead.name || existingLead?.customer_name || "",
        phone: normalizePhone(lead.phone || existingLead?.phone),
        source: lead.source || existingLead?.source || "Facebook",
        customer_type: existingLead?.customer_type || lead.customer_type || "",
        province: lead.province || existingLead?.province || "",
        zone: existingLead?.zone || lead.zone || "",
        preferred_call_day: existingLead?.preferred_call_day || lead.preferred_call_day || "",
        preferred_call_time: existingLead?.preferred_call_time || lead.preferred_call_time || "",
        lead_form_name: lead.lead_form_name || lead.facebook_form_name || "",
        ad_name: lead.ad_name || lead.facebook_ad_name || "",
        adset_name: lead.adset_name || lead.facebook_adset_name || "",
        campaign_name: lead.campaign_name || lead.facebook_campaign_name || "",
        facebook_created_time: facebookCreatedTime,
        lead_status: normalizeLeadStatusForSheet(existingLead?.lead_status || lead.status || "New"),
        sales_owner: existingLead?.sales_owner || lead.sales_owner || "",
        created_at: existingLead?.created_at || now,
        updated_at: now,
    };
}

function buildLeadMainUpdateObject(existingLead, lead) {
    return {
        customer_name: lead.name || existingLead.customer_name || "",
        phone: normalizePhone(lead.phone || existingLead.phone),
        source: lead.source || existingLead.source || "Facebook",
        province: lead.province || existingLead.province || "",
        preferred_call_day: existingLead.preferred_call_day || lead.preferred_call_day || "",
        preferred_call_time: existingLead.preferred_call_time || lead.preferred_call_time || "",
        updated_at: dateToBangkokSheetsDateSerial(new Date()),
    };
}

function buildLeadDetailObject(leadId, lead) {
    return {
        lead_id: leadId,
        facebook_leadgen_id: lead.facebook_leadgen_id || "",
        raw_phone: lead.raw_phone || lead.phone || "",
        raw_province: lead.raw_province || "",
        form_id: lead.form_id || lead.facebook_form_id || "",
        ad_id: lead.ad_id || lead.facebook_ad_id || "",
        adset_id: lead.adset_id || lead.facebook_adset_id || "",
        campaign_id: lead.campaign_id || lead.facebook_campaign_id || "",
        facebook_created_time: valueToBangkokSheetsDateSerial(lead.facebook_created_time),
        is_organic: lead.is_organic ?? lead.facebook_is_organic ?? "",
        platform: lead.platform || lead.facebook_platform || "",
        inbox_url: lead.inbox_url || "",
        original_customer_name: lead.original_customer_name || lead.name || "",
        created_source: lead.source || "Facebook",
    };
}

function buildDealObject(dealId, leadId, lead = {}, existingDeal = null) {
    return {
        deal_id: dealId,
        lead_id: leadId,
        phone: normalizePhone(lead.phone || existingDeal?.phone || ""),
        product_model: lead.product_model || lead.product_name || existingDeal?.product_model || "",
        package_type: lead.package_type || lead.package_name || existingDeal?.package_type || "",
        price: lead.price || existingDeal?.price || "",
        full_amount: lead.full_amount || existingDeal?.full_amount || "",
        payment_status: normalizePaymentStatusForSheet(existingDeal?.payment_status || lead.payment_status || "Unpaid"),
        payment_date: existingDeal?.payment_date || lead.payment_date || "",
    };
}

async function getExistingLeadgenIds() {
    const rows = await getSheetRows(SHEETS.LEAD_DETAILS);
    const headers = rows[HEADER_ROW - 1] || [];
    const leadgenIndex = headerIndex(headers, "facebook_leadgen_id");

    return new Set(
        rows
            .slice(DATA_START_ROW - 1)
            .map(row => String(row?.[leadgenIndex] || "").trim())
            .filter(Boolean)
    );
}

async function getExistingLeadgenIdsNarrow() {
    const { sheets, spreadsheetId } = await createSheetsClient();
    const headerRows = await readSheet(sheets, spreadsheetId, `${SHEETS.LEAD_DETAILS}!A${HEADER_ROW}:ZZ${HEADER_ROW}`);
    const headers = headerRows[0] || [];
    const leadgenIndex = headers.findIndex(header => normalizeHeaderName(header) === "facebook_leadgen_id");
    if (leadgenIndex < 0) {
        throw new Error(`Missing required header facebook_leadgen_id in ${SHEETS.LEAD_DETAILS}`);
    }
    const leadgenColumn = columnToLetter(leadgenIndex + 1);
    const rows = await readSheet(sheets, spreadsheetId, `${SHEETS.LEAD_DETAILS}!${leadgenColumn}${DATA_START_ROW}:${leadgenColumn}`);

    return new Set(
        rows
            .map(row => String(row?.[0] || "").trim())
            .filter(Boolean)
    );
}

async function appendLeadToSheet(lead) {
    const result = await appendLeadsToSheetBatch([lead]);

    if (result.created > 0) {
        return {
            action: "created",
            lead_id: result.created_items[0]?.lead_id || "",
            deal_id: result.created_items[0]?.deal_id || "",
            affected_rows: result.affected_rows || [],
        };
    }

    if (result.updated_existing > 0) {
        return {
            action: "updated_existing",
            lead_id: result.updated_items[0]?.lead_id || "",
            deal_id: result.updated_items[0]?.deal_id || "",
            affected_rows: result.affected_rows || [],
        };
    }

    if (result.skipped_existing > 0) {
        return {
            action: "skipped_existing",
        };
    }

    if (result.repaired_existing > 0) {
        return {
            action: "repaired_existing",
            repaired_items: result.repaired_items || [],
            affected_rows: result.affected_rows || [],
        };
    }

    if (result.phone_collision_review > 0) {
        return {
            action: PHONE_COLLISION_REVIEW,
            collision_items: result.collision_items || [],
            repeat_submission_events_created: result.repeat_submission_events_created || 0,
            repeat_submission_events_skipped: result.repeat_submission_events_skipped || 0,
        };
    }

    if (result.ambiguous_stop > 0) {
        return {
            action: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
            ambiguous_items: result.ambiguous_items || [],
        };
    }

    return {
        action: "no_action",
    };
}

async function appendLeadsToSheetBatch(leads) {
    const client = await createSheetsClient();
    return appendLeadsToSheetBatchWithClient(leads, client);
}

async function appendLeadsToSheetBatchWithClient(leads, { sheets, spreadsheetId }) {

    const [leadsRows, detailsRows, dealsRows] = await Promise.all([
        readSheet(sheets, spreadsheetId, `${SHEETS.LEADS_MAIN}!A:ZZ`),
        readSheet(sheets, spreadsheetId, `${SHEETS.LEAD_DETAILS}!A:ZZ`),
        readSheet(sheets, spreadsheetId, `${SHEETS.DEALS}!A:ZZ`),
    ]);

    const leadHeaders = await ensureSheetHeaders(
        sheets,
        spreadsheetId,
        SHEETS.LEADS_MAIN,
        leadsRows,
        ["lead_form_name", "ad_name", "adset_name", "campaign_name", "facebook_created_time"]
    );
    const detailHeaders = await ensureSheetHeaders(
        sheets,
        spreadsheetId,
        SHEETS.LEAD_DETAILS,
        detailsRows,
        [
            "form_id",
            "ad_id",
            "adset_id",
            "campaign_id",
            "facebook_created_time",
            "is_organic",
            "platform",
            "inbox_url",
        ]
    );
    const dealHeaders = dealsRows[HEADER_ROW - 1] || [];

    headerIndex(leadHeaders, "phone");
    headerIndex(detailHeaders, "facebook_leadgen_id");
    headerIndex(dealHeaders, "lead_id");

    const createdItems = [];
    const updatedItems = [];
    const skippedExistingItems = [];
    const skippedUnchangedItems = [];
    const skippedEmptyItems = [];
    const collisionItems = [];
    const ambiguousItems = [];
    const repairedItems = [];
    const repeatSubmissionEvents = [];
    const verificationTargets = [];
    const newLeadObjects = [];
    const newDetailObjects = [];
    const newDealObjects = [];
    const writeEntries = [];
    const affectedRows = new Set();

    const inMemoryLeadRows = leadsRows.map(row => [...row]);
    const inMemoryDetailRows = detailsRows.map(row => [...row]);
    const inMemoryDealRows = dealsRows.map(row => [...row]);

    let nextLeadRow = getNextDataRow(inMemoryLeadRows);
    let nextDetailRow = getNextDataRow(inMemoryDetailRows);
    let nextDealRow = getNextDataRow(inMemoryDealRows);

    const seenLeadgenIds = new Set(
        detailsRows
            .slice(DATA_START_ROW - 1)
            .map(row => rowToObject(detailHeaders, row).facebook_leadgen_id)
            .map(value => String(value || "").trim())
            .filter(Boolean)
    );

    const queueLeadDetailWrite = (detailObject) => {
        const existingDetail = findLeadDetailRowForObject(detailHeaders, inMemoryDetailRows, detailObject);

        if (existingDetail?.rowNumber) {
            const mergedDetail = mergeObjectPreserveExisting(existingDetail, detailObject);

            if (!hasMeaningfulObjectChanges(detailHeaders, existingDetail, mergedDetail)) {
                return {
                    action: "unchanged",
                    rowNumber: existingDetail.rowNumber,
                    matchType: existingDetail.matchType,
                };
            }

            writeEntries.push({
                sheetName: SHEETS.LEAD_DETAILS,
                headers: detailHeaders,
                rowNumber: existingDetail.rowNumber,
                object: mergedDetail,
                options: {},
            });

            inMemoryDetailRows[existingDetail.rowNumber - 1] = objectToRow(detailHeaders, mergedDetail);
            return {
                action: "updated",
                rowNumber: existingDetail.rowNumber,
                matchType: existingDetail.matchType,
            };
        }

        newDetailObjects.push(detailObject);
        inMemoryDetailRows[nextDetailRow - 1] = objectToRow(detailHeaders, detailObject);
        nextDetailRow++;
        return {
            action: "created",
            rowNumber: nextDetailRow - 1,
            matchType: "new",
        };
    };

    for (const lead of leads) {
        const rawLeadgenId = lead.facebook_leadgen_id;
        const normalizedPhone = normalizePhone(lead.phone);

        if (rawLeadgenId === undefined || rawLeadgenId === null || String(rawLeadgenId).trim() === "") {
            skippedEmptyItems.push({
                reason: "missing_facebook_leadgen_id",
                name: lead.name || "",
                phone: lead.phone || "",
            });
            continue;
        }

        let leadgenId;
        try {
            leadgenId = assertExactFacebookLeadgenId(rawLeadgenId);
        } catch (error) {
            skippedEmptyItems.push({
                reason: "invalid_facebook_leadgen_id",
                error: error.message,
            });
            continue;
        }

        if (!normalizedPhone && !lead.name) {
            skippedEmptyItems.push({
                reason: "missing_phone_and_name",
                facebook_leadgen_id: leadgenId,
            });
            continue;
        }

        const ingestionState = inspectFacebookIngestionState({
            facebookLeadgenId: leadgenId,
            lead,
            leadHeaders,
            leadsRows: inMemoryLeadRows,
            detailHeaders,
            detailsRows: inMemoryDetailRows,
            dealHeaders,
            dealsRows: inMemoryDealRows,
        });

        if (ingestionState.classification === FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP) {
            ambiguousItems.push({
                facebook_leadgen_id: leadgenId,
                classification: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
                reason: ingestionState.reason,
            });
            continue;
        }

        if (ingestionState.classification === FACEBOOK_INGESTION_STATE.COMPLETE_EXISTING) {
            skippedExistingItems.push({
                facebook_leadgen_id: leadgenId,
                lead_id: ingestionState.leadId,
                reason: "complete_existing",
                classification: FACEBOOK_INGESTION_STATE.COMPLETE_EXISTING,
            });
            seenLeadgenIds.add(leadgenId);
            continue;
        }

        if (ingestionState.classification === FACEBOOK_INGESTION_STATE.PARTIAL_EXISTING_REPAIRABLE) {
            const leadId = ingestionState.leadId;
            const repairActions = [];
            const detailObject = buildLeadDetailObject(leadId, lead);
            const detailWriteResult = queueLeadDetailWrite(detailObject);

            if (ingestionState.leadMissing) {
                const leadObject = buildLeadMainObject(leadId, lead);
                const leadRowNumber = nextLeadRow;
                newLeadObjects.push(leadObject);
                inMemoryLeadRows[leadRowNumber - 1] = objectToRow(leadHeaders, leadObject);
                nextLeadRow++;
                affectedRows.add(leadRowNumber);
                repairActions.push("created_missing_lead");
            }

            let dealId = ingestionState.deals[0]?.deal_id || "";
            if (ingestionState.dealMissing) {
                dealId = generateId("DEAL");
                const dealObject = buildDealObject(dealId, leadId, lead);
                newDealObjects.push(dealObject);
                inMemoryDealRows[nextDealRow - 1] = objectToRow(dealHeaders, dealObject);
                nextDealRow++;
                affectedRows.add(ingestionState.lead?.rowNumber || nextLeadRow - 1);
                repairActions.push("created_missing_deal");
            }

            if (detailWriteResult?.action === "updated") repairActions.push("repaired_detail");
            if (detailWriteResult?.action === "created") repairActions.push("created_missing_detail");

            repairedItems.push({
                facebook_leadgen_id: leadgenId,
                lead_id: leadId,
                deal_id: dealId,
                classification: FACEBOOK_INGESTION_STATE.PARTIAL_EXISTING_REPAIRABLE,
                action: repairActions.join("+") || "reconciled_existing",
            });
            verificationTargets.push({ facebookLeadgenId: leadgenId, lead });
            seenLeadgenIds.add(leadgenId);
            continue;
        }

        if (seenLeadgenIds.has(leadgenId)) {
            skippedExistingItems.push({
                facebook_leadgen_id: leadgenId,
                reason: "facebook_leadgen_id_already_exists",
            });
            continue;
        }

        const existingLead = findLeadByPhone(leadHeaders, inMemoryLeadRows, normalizedPhone);
        const primaryFacebookLeadgenId = existingLead
            ? findPrimaryFacebookLeadgenId(
                detailHeaders,
                inMemoryDetailRows,
                String(existingLead.lead_id || "").trim()
            )
            : "";

        const identityMatch = classifyFacebookIdentityMatch({
            incomingFacebookLeadgenId: leadgenId,
            exactMatch: false,
            phoneMatch: Boolean(existingLead && primaryFacebookLeadgenId),
        });

        if (identityMatch.classification === PHONE_COLLISION_REVIEW) {
            const leadId = String(existingLead.lead_id || "").trim();
            const event = buildFacebookRepeatSubmissionEvent({
                leadId,
                facebookLeadgenId: leadgenId,
                sourceCreatedTime: lead.facebook_created_time || "",
                primaryFacebookLeadgenId,
            });

            repeatSubmissionEvents.push(event);
            collisionItems.push({
                lead_id: leadId,
                facebook_leadgen_id: leadgenId,
                classification: PHONE_COLLISION_REVIEW,
                action: "repeat_submission_event",
            });
            seenLeadgenIds.add(leadgenId);
            continue;
        }

        if (existingLead) {
            ambiguousItems.push({
                facebook_leadgen_id: leadgenId,
                lead_id: String(existingLead.lead_id || "").trim(),
                classification: FACEBOOK_INGESTION_STATE.AMBIGUOUS_STOP,
                reason: "phone_match_without_distinct_primary_facebook_id",
            });
            continue;
        }

        if (!existingLead) {
            const leadId = generateId("LEAD");
            const dealId = generateId("DEAL");
            const leadRowNumber = nextLeadRow;
            const leadObject = buildLeadMainObject(leadId, lead);
            const detailObject = buildLeadDetailObject(leadId, lead);
            const dealObject = buildDealObject(dealId, leadId, lead);

            newLeadObjects.push(leadObject);
            queueLeadDetailWrite(detailObject);
            newDealObjects.push(dealObject);

            inMemoryLeadRows[nextLeadRow - 1] = objectToRow(leadHeaders, leadObject);
            inMemoryDealRows[nextDealRow - 1] = objectToRow(dealHeaders, dealObject);
            nextLeadRow++;
            nextDealRow++;
            seenLeadgenIds.add(leadgenId);
            affectedRows.add(leadRowNumber);

            createdItems.push({
                lead_id: leadId,
                deal_id: dealId,
                lead_row_number: leadRowNumber,
                facebook_leadgen_id: leadgenId,
                phone: normalizedPhone,
                name: lead.name || "",
            });

            verificationTargets.push({ facebookLeadgenId: leadgenId, lead });

            continue;
        }

        const leadId = existingLead.lead_id;
        const latestDeal = findLatestDealByLeadId(dealHeaders, inMemoryDealRows, leadId);
        const shouldCreateDeal = isCompletedLead(existingLead) || !latestDeal;
        const detailObject = buildLeadDetailObject(leadId, lead);
        const updateLeadObject = buildLeadMainUpdateObject(existingLead, lead);
        const leadHasMeaningfulChanges = hasMeaningfulObjectChanges(
            leadHeaders,
            existingLead,
            updateLeadObject,
            { exclude: ["updated_at"] }
        );
        const detailWriteResult = queueLeadDetailWrite(detailObject);

        if (!leadHasMeaningfulChanges && detailWriteResult?.action === "unchanged" && !shouldCreateDeal) {
            seenLeadgenIds.add(leadgenId);
            skippedUnchangedItems.push({
                lead_id: leadId,
                lead_row_number: existingLead.rowNumber,
                facebook_leadgen_id: leadgenId,
                reason: "existing_lead_no_meaningful_changes",
            });
            continue;
        }

        let dealId = latestDeal?.deal_id || "";

        if (leadHasMeaningfulChanges) {
            const leadObjectWithUpdatedAt = {
                ...updateLeadObject,
                updated_at: dateToBangkokSheetsDateSerial(new Date()),
            };
            writeEntries.push({
                sheetName: SHEETS.LEADS_MAIN,
                headers: leadHeaders,
                rowNumber: existingLead.rowNumber,
                object: leadObjectWithUpdatedAt,
                options: {},
            });
            affectedRows.add(existingLead.rowNumber);
        }

        if (shouldCreateDeal) {
            dealId = generateId("DEAL");
            const dealObject = buildDealObject(dealId, leadId, lead);
            newDealObjects.push(dealObject);
            inMemoryDealRows[nextDealRow - 1] = objectToRow(dealHeaders, dealObject);
            nextDealRow++;
            affectedRows.add(existingLead.rowNumber);
        }

        seenLeadgenIds.add(leadgenId);

        updatedItems.push({
            lead_id: leadId,
            deal_id: dealId,
            lead_row_number: existingLead.rowNumber,
            facebook_leadgen_id: leadgenId,
            action: [
                leadHasMeaningfulChanges ? "updated_lead" : "",
                detailWriteResult?.action === "updated" ? "updated_detail" : "",
                detailWriteResult?.action === "created" ? "created_detail" : "",
                shouldCreateDeal ? "created_new_deal_for_completed_or_missing_deal" : "",
            ].filter(Boolean).join("+") || "updated_existing",
        });
    }

    if (newLeadObjects.length) {
        const startRow = getNextDataRow(leadsRows);
        let rowNumber = startRow;

        for (const object of newLeadObjects) {
            writeEntries.push({
                sheetName: SHEETS.LEADS_MAIN,
                headers: leadHeaders,
                rowNumber,
                object,
                options: {},
            });
            rowNumber++;
        }
    }

    if (newDetailObjects.length) {
        const startRow = getNextDataRow(detailsRows);
        let rowNumber = startRow;

        for (const object of newDetailObjects) {
            writeEntries.push({
                sheetName: SHEETS.LEAD_DETAILS,
                headers: detailHeaders,
                rowNumber,
                object,
                options: {},
            });
            rowNumber++;
        }
    }

    if (newDealObjects.length) {
        const startRow = getNextDataRow(dealsRows);
        let rowNumber = startRow;

        for (const object of newDealObjects) {
            writeEntries.push({
                sheetName: SHEETS.DEALS,
                headers: dealHeaders,
                rowNumber,
                object,
                options: {},
            });
            rowNumber++;
        }
    }

    await writeObjectOperations(sheets, spreadsheetId, writeEntries);
    await verifyCompleteFacebookIngestionStates(
        sheets,
        spreadsheetId,
        verificationTargets
    );
    const repeatSubmissionResult = await appendFacebookRepeatSubmissionEvents(
        sheets,
        spreadsheetId,
        repeatSubmissionEvents
    );

    console.log(`Batch sync created: ${createdItems.length}`);
    console.log(`Batch sync updated_existing: ${updatedItems.length}`);
    console.log(`Batch sync skipped_existing: ${skippedExistingItems.length}`);
    console.log(`Batch sync skipped_unchanged: ${skippedUnchangedItems.length}`);
    console.log(`Batch sync skipped_empty: ${skippedEmptyItems.length}`);
    console.log(`Batch sync phone_collision_review: ${collisionItems.length}`);
    console.log(`Batch sync ambiguous_stop: ${ambiguousItems.length}`);
    console.log(`Batch sync repaired_existing: ${repairedItems.length}`);

    return {
        created: createdItems.length,
        updated_existing: updatedItems.length,
        skipped_existing: skippedExistingItems.length,
        skipped_unchanged: skippedUnchangedItems.length,
        skipped_empty: skippedEmptyItems.length,
        phone_collision_review: collisionItems.length,
        ambiguous_stop: ambiguousItems.length,
        repaired_existing: repairedItems.length,
        repeat_submission_events_created: repeatSubmissionResult.created,
        repeat_submission_events_skipped: repeatSubmissionResult.skipped_existing,
        affected_rows: Array.from(affectedRows).sort((a, b) => a - b),
        incremental_cleanup_attempted: false,
        incremental_cleanup_rows: 0,
        full_cleanup_required: false,
        created_items: createdItems,
        updated_items: updatedItems,
        skipped_existing_items: skippedExistingItems,
        skipped_unchanged_items: skippedUnchangedItems,
        skipped_empty_items: skippedEmptyItems,
        collision_items: collisionItems,
        ambiguous_items: ambiguousItems,
        repaired_items: repairedItems,
    };
}

module.exports = {
    appendLeadToSheet,
    appendLeadsToSheetBatch,
    appendLeadsToSheetBatchWithClient,
    getExistingLeadgenIds,
    getExistingLeadgenIdsNarrow,
    createSheetsClient,
    readSheet,
    getSheetRows,
    getHeaders,
    headerIndex,
    rowToObject,
    objectToRow,
    getFacebookBackfillState,
    saveFacebookBackfillState,
    appendObjects,
    appendObjectsWithClient,
    updateObjectRow,
    updateObjectRows,
    upsertLeadDetailObject,
    deleteSheetRows,
    normalizePhone,
    normalizeHeaderName,
    dateToBangkokSheetsDateSerial,
    valueToBangkokSheetsDateSerial,
    FACEBOOK_INGESTION_STATE,
    buildObjectWriteOperations,
    verifyExactFacebookLeadgenReadbacks,
    inspectFacebookIngestionState,
    findLeadDetailRowsByFacebookLeadgenId,
    validateFacebookRepeatSubmissionActivityHeaders,
    classifyFacebookIdentityMatch,
    buildFacebookRepeatSubmissionEvent,
};
