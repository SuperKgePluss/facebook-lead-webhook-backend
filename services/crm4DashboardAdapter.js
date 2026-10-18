"use strict";

const { buildDashboardReadModel } = require("./dashboardReadModel");

const CRM4_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEET_NAMES = Object.freeze(["LEADS", "LEADS_MAIN", "DEALS", "INSTALLATIONS", "ACTIVITY_LOG"]);
const FIELD_ALIASES = Object.freeze({
    lead_id: ["Lead ID", "ID", "รหัสลูกค้า", "รหัส Lead"],
    facebook_created_time: ["Facebook Created Time", "เวลาสร้างลีดจาก Facebook", "วันที่สร้างลีดจาก Facebook"],
    customer_name: ["Customer Name", "Full Name", "ชื่อลูกค้า"],
    phone: ["Phone", "Telephone", "Mobile", "Phone Number", "เบอร์โทร", "เบอร์โทรศัพท์"],
    additional_phone: ["Additional Phone", "Secondary Phone", "เบอร์โทรเพิ่มเติม"],
    lead_status: ["Lead Status", "สถานะลูกค้า", "สถานะ Lead"],
    preferred_call_day: ["Preferred Call Day", "วันสะดวกให้โทร", "วันที่สะดวกให้โทร", "วันที่สะดวกติดต่อ"],
    preferred_call_time: ["Preferred Call Time", "เวลาสะดวกให้โทร", "เวลาที่สะดวกให้โทร", "ช่วงเวลาที่สะดวก"],
    sales_owner: ["Sales Owner", "Owner", "ผู้รับผิดชอบ", "ผู้ดูแล"],
    sales_note_history: ["Sales Note History", "ประวัติโน้ตฝ่ายขาย"],
    sales_follow_up_status: ["Sales Follow-up Status", "Sales Follow Up Status", "สถานะติดตามการขาย"],
    source: ["Source", "Lead Source", "แหล่งที่มา"],
    customer_type_code: ["Customer Type", "Customer Type Code", "ประเภทลูกค้า"],
    latest_follow_up_at: ["Latest Follow-up At", "Latest Follow Up At", "วันที่ล่าสุด"],
    deal_id: ["Deal ID", "รหัสดีล"],
    full_amount: ["Full Amount", "ยอดเต็ม"],
    paid_amount: ["Paid Amount", "ยอดที่ชำระแล้ว"],
    payment_status: ["Payment Status", "สถานะการชำระเงิน"],
    payment_date: ["Payment Date", "วันที่ยืนยันการชำระเงิน"],
    open_installation: ["Open Installation", "เปิดงานติดตั้ง"],
    install_id: ["Install ID", "Installation ID", "รหัสติดตั้ง"],
    install_status: ["Install Status", "Installation Status", "สถานะติดตั้ง"],
    preferred_install_date: ["Preferred Install Date", "วันที่สะดวกติดตั้ง"],
    preferred_install_time: ["Preferred Install Time", "ช่วงเวลาที่สะดวก"],
    machine_count: ["Machine Count", "จำนวนเครื่องที่ติดตั้ง"],
    installation_contact_count: ["Install Contact Count", "จำนวนครั้งที่ติดต่อ"],
    activity_id: ["Activity ID", "รหัสกิจกรรม"],
    action_type: ["Action Type", "Activity Type", "ประเภทกิจกรรม"],
    note: ["Note", "หมายเหตุ"],
    audio_url: ["Audio URL", "Audio Link", "ลิงก์ไฟล์เสียง"],
    audio_file_name: ["Audio File Name", "ชื่อไฟล์เสียง"],
    file_name: ["File Name", "Filename", "ชื่อไฟล์", "ชื่อไฟล์เสียง"],
    created_by: ["Created By", "ผู้บันทึก"],
    created_at: ["Created At", "วันที่สร้าง", "วันที่บันทึก"],
    drive_file_id: ["Drive File ID", "File ID"],
    detected_phone: ["Detected Phone", "Phone", "Filename Phone"],
    matched_lead_id: ["Matched Lead ID", "Lead ID"],
    match_status: ["Match Status", "Status"],
    open_file: ["Open File", "File URL", "Latest Recording Link"],
    verified_recording_at: ["Verified Recording At", "Recording Timestamp", "Latest Recording At"],
    recording_timestamp_source: ["Recording Timestamp Source", "Timestamp Source"],
    recording_timestamp_verified: ["Recording Timestamp Verified", "Timestamp Verified"],
    state_key: ["State Key"],
    state_value: ["State Value"],
});

const REQUIRED_FIELDS = Object.freeze({
    LEADS: ["lead_id", "facebook_created_time", "customer_name", "phone", "lead_status", "sales_owner"],
    LEADS_MAIN: ["lead_id", "customer_name", "phone", "lead_status", "sales_owner", "source", "customer_type_code"],
    DEALS: ["deal_id", "lead_id", "full_amount", "paid_amount", "payment_status", "payment_date"],
    INSTALLATIONS: ["install_id", "lead_id", "install_status", "preferred_install_date"],
    ACTIVITY_LOG: ["activity_id", "lead_id", "action_type", "created_at"],
    AUDIO_LIBRARY_INDEX: ["drive_file_id", "detected_phone", "matched_lead_id", "match_status", "file_name"],
    AUDIO_INDEX_STATE: ["state_key", "state_value"],
});

function normalizeHeader(value) {
    return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const NORMALIZED_ALIASES = Object.freeze(Object.fromEntries(Object.entries(FIELD_ALIASES).map(([key, aliases]) => [key, aliases.map(normalizeHeader)])));

function matchingIndexes(row, field) {
    const aliases = NORMALIZED_ALIASES[field] || [];
    const matches = [];
    for (let index = 0; index < (row || []).length; index++) {
        if (aliases.includes(normalizeHeader(row[index]))) matches.push(index);
    }
    return matches;
}

function isHeaderLikeRow(row) {
    let hits = 0;
    for (const field of Object.keys(FIELD_ALIASES)) {
        if (matchingIndexes(row, field).length) hits++;
        if (hits >= 2) return true;
    }
    return false;
}

function locateHeaderRow(grid, requiredFields, sheetName) {
    if (!Array.isArray(grid)) throw new TypeError(`${sheetName} values are unavailable.`);
    const scanLimit = Math.min(grid.length, 8);
    for (let rowIndex = 0; rowIndex < scanLimit; rowIndex++) {
        const row = grid[rowIndex];
        if (!Array.isArray(row)) continue;
        const hasRequired = requiredFields.every(field => matchingIndexes(row, field).length > 0);
        if (hasRequired) return rowIndex;
    }
    throw new Error(`${sheetName} is missing required headers: ${requiredFields.join(", ")}.`);
}

function buildHeaderMap(headerRow, sheetName) {
    const result = {};
    for (const field of Object.keys(FIELD_ALIASES)) {
        const matches = matchingIndexes(headerRow, field);
        if (matches.length > 1) throw new Error(`${sheetName} has duplicate or conflicting headers for ${field}.`);
        if (matches.length === 1) result[field] = matches[0];
    }
    return result;
}

function recordsFromGrid(grid, sheetName, requiredFields = REQUIRED_FIELDS[sheetName] || ["lead_id"]) {
    const headerRowIndex = locateHeaderRow(grid, requiredFields, sheetName);
    const headerMap = buildHeaderMap(grid[headerRowIndex], sheetName);
    const idField = sheetName === "DEALS" ? "deal_id" : sheetName === "INSTALLATIONS" ? "install_id" : sheetName === "ACTIVITY_LOG" ? "activity_id" : sheetName === "AUDIO_LIBRARY_INDEX" ? "drive_file_id" : sheetName === "AUDIO_INDEX_STATE" ? "state_key" : "lead_id";
    const idHeaderAliases = NORMALIZED_ALIASES[idField] || [];
    const records = [];
    const seenIds = new Set();
    for (let rowIndex = headerRowIndex + 1; rowIndex < grid.length; rowIndex++) {
        const row = grid[rowIndex];
        if (!Array.isArray(row)) continue;
        const record = {};
        for (const [field, index] of Object.entries(headerMap)) record[field] = row[index] ?? "";
        const id = String(record[idField] ?? "").trim();
        if (!id) continue;
        if (isHeaderLikeRow(row) && idHeaderAliases.includes(normalizeHeader(id))) continue;
        if (seenIds.has(id) && sheetName !== "AUDIO_LIBRARY_INDEX" && sheetName !== "DEALS") throw new Error(`${sheetName} contains duplicate ${idField} values.`);
        seenIds.add(id);
        records.push(record);
    }
    return records;
}

function value(primary, secondary, field) {
    const first = primary?.[field];
    return first !== undefined && first !== null && String(first).trim() !== "" ? first : (secondary?.[field] ?? "");
}

function customerTypeForDashboard(value) {
    const raw = String(value ?? "").trim();
    if (raw.toUpperCase() === "VIP") return "ETC";
    if (["B2B", "B2C", "ETC"].includes(raw.toUpperCase())) return raw.toUpperCase();
    return raw;
}

function buildPrimaryLeads(leadsRows, mainRows) {
    const mainById = new Map(mainRows.map(row => [String(row.lead_id).trim(), row]));
    const leadsById = new Map(leadsRows.map(row => [String(row.lead_id).trim(), row]));
    const result = [];
    for (const [id, lead] of leadsById) {
        const main = mainById.get(id) || {};
        result.push({
            lead_id: id,
            facebook_created_time: value(lead, main, "facebook_created_time"),
            created_at: value(lead, main, "created_at"),
            customer_name: value(lead, main, "customer_name"),
            phone: value(lead, main, "phone"),
            additional_phone: value(lead, main, "additional_phone"),
            lead_status: value(lead, main, "lead_status"),
            preferred_call_day: value(lead, main, "preferred_call_day"),
            preferred_call_time: value(lead, main, "preferred_call_time"),
            sales_owner: value(lead, main, "sales_owner"),
            sales_note_history: value(lead, main, "sales_note_history"),
            sales_follow_up_status: value(lead, main, "sales_follow_up_status"),
            source: value(main, lead, "source"),
            customer_type_code: customerTypeForDashboard(value(main, lead, "customer_type_code")),
            latest_follow_up_at: value(main, lead, "latest_follow_up_at"),
        });
    }
    return result;
}

function countMainOnlyLeads(leadsRows, mainRows) {
    const primaryIds = new Set(leadsRows.map(row => String(row.lead_id || "").trim()).filter(Boolean));
    return new Set(mainRows.map(row => String(row.lead_id || "").trim()).filter(id => id && !primaryIds.has(id))).size;
}

function mapDeal(record) {
    return {
        deal_id: record.deal_id,
        lead_id: record.lead_id,
        full_amount: record.full_amount,
        paid_amount: record.paid_amount,
        payment_status: record.payment_status,
        payment_date: record.payment_date,
        open_installation: record.open_installation,
    };
}

function reconcileDealRows(records) {
    const byId = new Map();
    const conflicted = new Set();
    let identicalDuplicates = 0;
    for (const record of records) {
        const deal = mapDeal(record);
        const id = String(deal.deal_id).trim();
        if (!byId.has(id)) {
            byId.set(id, deal);
        } else if (JSON.stringify(byId.get(id)) === JSON.stringify(deal)) {
            identicalDuplicates++;
        } else {
            conflicted.add(id);
        }
    }
    return {
        deals: [...byId].filter(([id]) => !conflicted.has(id)).map(([, deal]) => deal),
        identicalDuplicates,
        conflictingIds: conflicted.size,
    };
}

function mapInstallation(record) {
    return {
        install_id: record.install_id,
        lead_id: record.lead_id,
        install_status: record.install_status,
        preferred_install_date: record.preferred_install_date,
        preferred_install_time: record.preferred_install_time,
        machine_count: record.machine_count,
        install_contact_count: record.installation_contact_count,
    };
}

function mapActivity(record) {
    return {
        activity_id: record.activity_id,
        lead_id: record.lead_id,
        action_type: record.action_type,
        note: record.note,
        created_by: record.created_by,
        created_at: record.created_at,
        lead_status: record.lead_status,
    };
}

function audioIndexIsComplete(stateRows) {
    return (stateRows || []).some(row => {
        const key = String(row.state_key || "").trim().toLowerCase();
        const value = String(row.state_value || "").trim();
        if (key === "status") return value.toUpperCase() === "COMPLETE";
        if (key !== "current_scan") return false;
        try {
            return String(JSON.parse(value)?.status || "").trim().toUpperCase() === "COMPLETE";
        } catch {
            return false;
        }
    });
}

function buildCrm4DashboardModel(sheets, filters, pagination, asOf = new Date(), audioIndex = null) {
    const parsed = {};
    for (const name of SHEET_NAMES) parsed[name] = recordsFromGrid(sheets[name], name);
    const mainHeader = sheets.LEADS_MAIN[locateHeaderRow(sheets.LEADS_MAIN, REQUIRED_FIELDS.LEADS_MAIN, "LEADS_MAIN")];
    const leadsHeader = sheets.LEADS[locateHeaderRow(sheets.LEADS, REQUIRED_FIELDS.LEADS, "LEADS")];
    const sourceCapabilities = {
        sales_follow_up_status: matchingIndexes(mainHeader, "sales_follow_up_status").length === 1
            || matchingIndexes(leadsHeader, "sales_follow_up_status").length === 1,
        customer_type_code: matchingIndexes(mainHeader, "customer_type_code").length === 1
            || matchingIndexes(leadsHeader, "customer_type_code").length === 1,
    };
    const leads = buildPrimaryLeads(parsed.LEADS, parsed.LEADS_MAIN);
    const mainOnlyLeadCount = countMainOnlyLeads(parsed.LEADS, parsed.LEADS_MAIN);
    const dealReconciliation = reconcileDealRows(parsed.DEALS);
    const model = buildDashboardReadModel({
        leads,
        deals: dealReconciliation.deals,
        installations: parsed.INSTALLATIONS.map(mapInstallation),
        activities: parsed.ACTIVITY_LOG.map(mapActivity),
        filters,
        operational_lead_pagination: pagination,
        asOf,
        audio_index: audioIndex,
        source_warnings: [
            ...(dealReconciliation.identicalDuplicates ? [{
                code: "crm4_duplicate_deal_rows_collapsed",
                count: dealReconciliation.identicalDuplicates,
                message: "Identical duplicate Deal rows were counted once.",
            }] : []),
            ...(dealReconciliation.conflictingIds ? [{
                code: "crm4_conflicting_deal_ids_excluded",
                count: dealReconciliation.conflictingIds,
                message: "Conflicting Deal IDs were excluded; financial totals are unavailable until source reconciliation.",
            }] : []),
            ...(!sourceCapabilities.sales_follow_up_status ? [{
                code: "crm4_sales_follow_up_status_column_missing",
                count: 1,
                message: "Sales Follow-up Status column is absent from LEADS and LEADS_MAIN.",
            }] : []),
            ...(!sourceCapabilities.customer_type_code ? [{
                code: "crm4_customer_type_column_missing",
                count: 1,
                message: "Customer Type column is absent from LEADS and LEADS_MAIN.",
            }] : []),
            ...(mainOnlyLeadCount ? [{
                code: "crm4_main_only_id_exception",
                count: mainOnlyLeadCount,
                message: "LEADS_MAIN-only IDs are reconciliation exceptions and are excluded from the primary LEADS population.",
            }] : []),
        ],
    });
    model.crm4_reconciliation = { main_only_lead_count: mainOnlyLeadCount };
    model.crm4_source_capabilities = { ...sourceCapabilities, financial_complete: dealReconciliation.conflictingIds === 0 };
    return model;
}

function columnLetters(number) {
    let result = "";
    let value = Number(number);
    while (value > 0) {
        const remainder = (value - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        value = Math.floor((value - 1) / 26);
    }
    return result;
}

const ACTIVITY_LOG_FIELDS = Object.freeze(["activity_id", "lead_id", "action_type", "note", "created_by", "created_at", "lead_status"]);

async function readActivityLogWithoutAudio(sheets, spreadsheetId, columnCount, frozenRowCount) {
    const endColumn = columnLetters(Math.max(1, Number(columnCount) || 1));
    const headerRowCount = Math.min(8, Math.max(1, Number(frozenRowCount) || 1));
    const headerResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'ACTIVITY_LOG'!A1:${endColumn}${headerRowCount}`,
        valueRenderOption: "UNFORMATTED_VALUE",
    });
    const headerGrid = headerResponse.data.values || [];
    const headerRowIndex = locateHeaderRow(headerGrid, REQUIRED_FIELDS.ACTIVITY_LOG, "ACTIVITY_LOG");
    const headerMap = buildHeaderMap(headerGrid[headerRowIndex], "ACTIVITY_LOG");
    const selectedFields = ACTIVITY_LOG_FIELDS.filter(field => headerMap[field] !== undefined);
    const selectedIndexes = selectedFields.map(field => headerMap[field]);
    const ranges = selectedIndexes.map(index => {
        const column = columnLetters(index + 1);
        return `'ACTIVITY_LOG'!${column}:${column}`;
    });
    const response = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = response.data.valueRanges || [];
    const rowCount = Math.max(0, ...values.map(range => (range.values || []).length));
    const width = Math.max(0, ...selectedIndexes.map(index => index + 1));
    const grid = Array.from({ length: rowCount }, () => Array(width).fill(""));
    selectedIndexes.forEach((columnIndex, fieldIndex) => {
        (values[fieldIndex]?.values || []).forEach((row, rowIndex) => {
            grid[rowIndex][columnIndex] = row?.[0] ?? "";
        });
    });
    return grid;
}

function createCrm4SheetsReader(env = process.env, sheetsClientFactory = null) {
    return async function readCrm4Sheets() {
        const spreadsheetId = String(env.CRM4_SPREADSHEET_ID || "").trim();
        const clientEmail = String(env.CRM4_GOOGLE_CLIENT_EMAIL || "").trim();
        const privateKey = String(env.CRM4_GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
        if (!spreadsheetId || !clientEmail || !privateKey) throw new Error("CRM4 read-only Google Sheets configuration is incomplete.");
        let sheets;
        if (sheetsClientFactory) {
            sheets = sheetsClientFactory();
        } else {
            const { google } = require("googleapis");
            const auth = new google.auth.GoogleAuth({
                credentials: { client_email: clientEmail, private_key: privateKey },
                scopes: [CRM4_SHEETS_SCOPE],
            });
            sheets = google.sheets({ version: "v4", auth });
        }
        const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,gridProperties(columnCount,frozenRowCount)))" });
        const properties = new Map((metadata.data.sheets || []).map(sheet => [sheet.properties.title, sheet.properties.gridProperties || {}]));
        const ranges = SHEET_NAMES.filter(name => name !== "ACTIVITY_LOG").map(name => {
            const grid = properties.get(name);
            if (!grid) throw new Error(`CRM4 is missing required sheet ${name}.`);
            const endColumn = columnLetters(Math.max(1, Number(grid.columnCount) || 1));
            return `'${name.replace(/'/g, "''")}'!A1:${endColumn}`;
        });
        const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges, valueRenderOption: "UNFORMATTED_VALUE" });
        const data = Object.fromEntries(SHEET_NAMES.filter(name => name !== "ACTIVITY_LOG").map((name, index) => [name, response.data.valueRanges?.[index]?.values || []]));
        const activityProperties = properties.get("ACTIVITY_LOG");
        if (!activityProperties) throw new Error("CRM4 is missing required sheet ACTIVITY_LOG.");
        data.ACTIVITY_LOG = await readActivityLogWithoutAudio(sheets, spreadsheetId, activityProperties.columnCount, activityProperties.frozenRowCount);
        return data;
    };
}

const CRM4_SNAPSHOT_CACHE_TTL_MS = 45_000;

function createCrm4DashboardDataProvider({
    env = process.env,
    readSheets = createCrm4SheetsReader(env),
    now = Date.now,
    audioIndexReader = async () => null,
} = {}) {
    let cachedSheets = null;
    let cachedAt = 0;
    let readInFlight = null;

    async function getSheets(forceRefresh) {
        if (readInFlight) return readInFlight;

        const currentTime = now();
        if (!forceRefresh && cachedSheets && currentTime >= cachedAt
            && currentTime - cachedAt < CRM4_SNAPSHOT_CACHE_TTL_MS) {
            return cachedSheets;
        }

        const pendingRead = Promise.resolve().then(readSheets);
        readInFlight = pendingRead;
        try {
            const sheets = await pendingRead;
            // Validate the source before placing it in the cache. This prevents
            // malformed reads from becoming a reusable failed snapshot.
            buildCrm4DashboardModel(sheets, {}, { offset: 0, limit: 1 }, new Date(now()));
            cachedSheets = sheets;
            cachedAt = now();
            return sheets;
        } catch (error) {
            // Never serve an older snapshot after a failed source refresh.
            cachedSheets = null;
            cachedAt = 0;
            throw error;
        } finally {
            if (readInFlight === pendingRead) readInFlight = null;
        }
    }

    return async ({ filters = {}, pagination = {}, asOf = new Date(), forceRefresh = false } = {}) => {
        const [sheets, audioIndex] = await Promise.all([
            getSheets(forceRefresh === true),
            audioIndexReader(),
        ]);
        // Rebuild the response model for each request so filters and pagination
        // remain request-local and no authenticated response is shared.
        return buildCrm4DashboardModel(sheets, filters, pagination, asOf, audioIndex);
    };
}

module.exports = {
    CRM4_SHEETS_SCOPE,
    SHEET_NAMES,
    FIELD_ALIASES,
    REQUIRED_FIELDS,
    normalizeHeader,
    locateHeaderRow,
    buildHeaderMap,
    recordsFromGrid,
    customerTypeForDashboard,
    audioIndexIsComplete,
    buildPrimaryLeads,
    countMainOnlyLeads,
    buildCrm4DashboardModel,
    createCrm4SheetsReader,
    createCrm4DashboardDataProvider,
};
