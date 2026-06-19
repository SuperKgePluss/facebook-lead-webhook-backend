const { google } = require("googleapis");

const SHEETS = {
    LEADS_MAIN: "LEADS_MAIN",
    LEAD_DETAILS: "LEAD_DETAILS",
    DEALS: "DEALS",
    INSTALLATIONS: "INSTALLATIONS",
    SYNC_STATE: "SYNC_STATE",
};

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
            rangeSuffix: `${startColumn}${rowNumber}:${endColumn}${rowNumber}`,
            values: [group.values],
        };
    });
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

async function batchUpdateValues(sheets, spreadsheetId, data) {
    if (!data.length) return;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data,
        },
    });
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

async function appendObjects(sheetName, objects) {
    if (!objects.length) return [];

    const { sheets, spreadsheetId } = await createSheetsClient();
    const rows = await readSheet(sheets, spreadsheetId, `${sheetName}!A:ZZ`);
    const headers = rows[HEADER_ROW - 1] || [];
    let nextRow = getNextDataRow(rows);
    const data = [];
    const appendedRows = [];

    for (const object of objects) {
        const normalizedObject = normalizeSheetObject(sheetName, object);
        const rowNumber = nextRow++;
        const groups = groupObjectRanges(headers, rowNumber, normalizedObject);

        for (const group of groups) {
            data.push({
                range: `${sheetName}!${group.rangeSuffix}`,
                values: group.values,
            });
        }

        appendedRows.push(rowNumber);
    }

    await batchUpdateValues(sheets, spreadsheetId, data);

    return appendedRows;
}

async function updateObjectRow(sheetName, rowNumber, object) {
    const { sheets, spreadsheetId } = await createSheetsClient();
    const headers = await getHeaders(sheetName);
    const groups = groupObjectRanges(headers, rowNumber, normalizeSheetObject(sheetName, object));

    await batchUpdateValues(
        sheets,
        spreadsheetId,
        groups.map(group => ({
            range: `${sheetName}!${group.rangeSuffix}`,
            values: group.values,
        }))
    );
}

async function updateObjectRows(sheetName, updates, chunkSize = 100) {
    if (!updates.length) return 0;

    const { sheets, spreadsheetId } = await createSheetsClient();
    const headers = await getHeaders(sheetName);
    const data = [];

    for (const update of updates) {
        const groups = groupObjectRanges(
            headers,
            update.rowNumber,
            normalizeSheetObject(sheetName, update.object || update.patch || {})
        );

        for (const group of groups) {
            data.push({
                range: `${sheetName}!${group.rangeSuffix}`,
                values: group.values,
            });
        }
    }

    for (let i = 0; i < data.length; i += chunkSize) {
        await batchUpdateValues(sheets, spreadsheetId, data.slice(i, i + chunkSize));
    }

    return updates.length;
}

async function upsertLeadDetailObject(detailObject) {
    const rows = await getSheetRows(SHEETS.LEAD_DETAILS);
    const headers = rows[HEADER_ROW - 1] || [];
    const existing = findLeadDetailRowForObject(headers, rows, detailObject);

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

    return {
        action: "no_action",
    };
}

async function appendLeadsToSheetBatch(leads) {
    const { sheets, spreadsheetId } = await createSheetsClient();

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
    const skippedEmptyItems = [];
    const newLeadObjects = [];
    const newDetailObjects = [];
    const newDealObjects = [];
    const updateData = [];
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

            for (const group of groupObjectRanges(detailHeaders, existingDetail.rowNumber, mergedDetail)) {
                updateData.push({
                    range: `${SHEETS.LEAD_DETAILS}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }

            inMemoryDetailRows[existingDetail.rowNumber - 1] = objectToRow(detailHeaders, mergedDetail);
            return;
        }

        newDetailObjects.push(detailObject);
        inMemoryDetailRows[nextDetailRow - 1] = objectToRow(detailHeaders, detailObject);
        nextDetailRow++;
    };

    for (const lead of leads) {
        const leadgenId = String(lead.facebook_leadgen_id || "").trim();
        const normalizedPhone = normalizePhone(lead.phone);

        if (!leadgenId) {
            skippedEmptyItems.push({
                reason: "missing_facebook_leadgen_id",
                name: lead.name || "",
                phone: lead.phone || "",
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

        if (seenLeadgenIds.has(leadgenId)) {
            skippedExistingItems.push({
                facebook_leadgen_id: leadgenId,
                reason: "facebook_leadgen_id_already_exists",
            });
            continue;
        }

        const existingLead = findLeadByPhone(leadHeaders, inMemoryLeadRows, normalizedPhone);

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

            continue;
        }

        const leadId = existingLead.lead_id;
        affectedRows.add(existingLead.rowNumber);
        const latestDeal = findLatestDealByLeadId(dealHeaders, inMemoryDealRows, leadId);
        const shouldCreateDeal = isCompletedLead(existingLead) || !latestDeal;
        const detailObject = buildLeadDetailObject(leadId, lead);
        const updateLeadObject = buildLeadMainUpdateObject(existingLead, lead);

        for (const group of groupObjectRanges(leadHeaders, existingLead.rowNumber, updateLeadObject)) {
            updateData.push({
                range: `${SHEETS.LEADS_MAIN}!${group.rangeSuffix}`,
                values: group.values,
            });
        }

        queueLeadDetailWrite(detailObject);

        let dealId = latestDeal?.deal_id || "";

        if (shouldCreateDeal) {
            dealId = generateId("DEAL");
            const dealObject = buildDealObject(dealId, leadId, lead);
            newDealObjects.push(dealObject);
            inMemoryDealRows[nextDealRow - 1] = objectToRow(dealHeaders, dealObject);
            nextDealRow++;
        }

        seenLeadgenIds.add(leadgenId);

        updatedItems.push({
            lead_id: leadId,
            deal_id: dealId,
            lead_row_number: existingLead.rowNumber,
            facebook_leadgen_id: leadgenId,
            action: shouldCreateDeal
                ? "created_new_deal_for_completed_or_missing_deal"
                : "updated_existing",
        });
    }

    if (newLeadObjects.length) {
        const startRow = getNextDataRow(leadsRows);
        let rowNumber = startRow;

        for (const object of newLeadObjects) {
            for (const group of groupObjectRanges(leadHeaders, rowNumber, object)) {
                updateData.push({
                    range: `${SHEETS.LEADS_MAIN}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }
            rowNumber++;
        }
    }

    if (newDetailObjects.length) {
        const startRow = getNextDataRow(detailsRows);
        let rowNumber = startRow;

        for (const object of newDetailObjects) {
            for (const group of groupObjectRanges(detailHeaders, rowNumber, object)) {
                updateData.push({
                    range: `${SHEETS.LEAD_DETAILS}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }
            rowNumber++;
        }
    }

    if (newDealObjects.length) {
        const startRow = getNextDataRow(dealsRows);
        let rowNumber = startRow;

        for (const object of newDealObjects) {
            for (const group of groupObjectRanges(dealHeaders, rowNumber, object)) {
                updateData.push({
                    range: `${SHEETS.DEALS}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }
            rowNumber++;
        }
    }

    await batchUpdateValues(sheets, spreadsheetId, updateData);

    console.log(`Batch sync created: ${createdItems.length}`);
    console.log(`Batch sync updated_existing: ${updatedItems.length}`);
    console.log(`Batch sync skipped_existing: ${skippedExistingItems.length}`);
    console.log(`Batch sync skipped_empty: ${skippedEmptyItems.length}`);

    return {
        created: createdItems.length,
        updated_existing: updatedItems.length,
        skipped_existing: skippedExistingItems.length,
        skipped_empty: skippedEmptyItems.length,
        affected_rows: Array.from(affectedRows).sort((a, b) => a - b),
        incremental_cleanup_attempted: false,
        incremental_cleanup_rows: 0,
        full_cleanup_required: false,
        created_items: createdItems,
        updated_items: updatedItems,
        skipped_existing_items: skippedExistingItems,
        skipped_empty_items: skippedEmptyItems,
    };
}

module.exports = {
    appendLeadToSheet,
    appendLeadsToSheetBatch,
    getExistingLeadgenIds,
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
    updateObjectRow,
    updateObjectRows,
    upsertLeadDetailObject,
    deleteSheetRows,
    normalizePhone,
    normalizeHeaderName,
    dateToBangkokSheetsDateSerial,
    valueToBangkokSheetsDateSerial,
};
