"use strict";

const {
    createSheetsClient,
    readSheet,
    normalizeHeaderName,
} = require("./googleSheets");

const SOURCE_PRESENCE_FIELDS = Object.freeze([
    "customer_name",
    "full_name",
    "name",
    "phone",
    "facebook_created_time",
    "created_at",
    "lead_status",
    "preferred_call_day",
    "preferred_call_time",
    "sales_owner",
]);
const SOURCE_FIELDS = Object.freeze(["lead_id", ...SOURCE_PRESENCE_FIELDS]);
const COUNT_FIELDS = Object.freeze([
    "source_count",
    "target_count",
    "missing_count",
    "duplicate_count",
    "invalid_count",
]);

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

function getHeaderColumns(rows, sheetName, fields, requiredFields) {
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0])) {
        throw new Error("Dashboard health header snapshot is incomplete.");
    }

    const columnsByField = new Map(fields.map(field => [field, []]));
    rows[0].forEach((header, index) => {
        const field = normalizeHeaderName(header);
        if (columnsByField.has(field)) columnsByField.get(field).push(index + 1);
    });

    for (const field of fields) {
        const columns = columnsByField.get(field);
        if (columns.length > 1 || (requiredFields.includes(field) && columns.length !== 1)) {
            throw new Error(`Dashboard health header is ambiguous for ${sheetName}.`);
        }
    }

    return new Map([...columnsByField]
        .filter(([, columns]) => columns.length === 1)
        .map(([field, columns]) => [field, columns[0]]));
}

function readColumnValues(rows) {
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length > 1)) {
        throw new Error("Dashboard health data snapshot is incomplete.");
    }
    return rows.map(row => row[0]);
}

function normalizeLeadId(value) {
    // This mirrors the Apps Script classifier's `String(value || '').trim()`.
    return String(value || "").trim();
}

function hasMaterializationData(valuesByField, rowIndex) {
    return SOURCE_PRESENCE_FIELDS.some(field => {
        const value = valuesByField[field]?.[rowIndex];
        return value !== null && value !== undefined && String(value).trim() !== "";
    });
}

function summarizeLeadParity(sourceValuesByField, targetLeadIds) {
    const sourceLeadIds = sourceValuesByField.lead_id || [];
    const sourceLength = Math.max(0, ...Object.values(sourceValuesByField).map(values => values.length));
    const sourceIds = new Set();
    let invalidCount = 0;

    for (let rowIndex = 0; rowIndex < sourceLength; rowIndex++) {
        const leadId = normalizeLeadId(sourceLeadIds[rowIndex]);
        if (leadId) {
            sourceIds.add(leadId);
        } else if (hasMaterializationData(sourceValuesByField, rowIndex)) {
            invalidCount++;
        }
    }

    const targetOccurrences = new Map();
    for (const value of targetLeadIds) {
        const leadId = normalizeLeadId(value);
        if (!leadId) continue;
        targetOccurrences.set(leadId, (targetOccurrences.get(leadId) || 0) + 1);
    }

    const targetIds = new Set(targetOccurrences.keys());
    let missingCount = 0;
    for (const leadId of sourceIds) {
        if (!targetIds.has(leadId)) missingCount++;
    }

    let duplicateCount = 0;
    for (const occurrences of targetOccurrences.values()) {
        if (occurrences > 1) duplicateCount++;
    }

    return {
        source_count: sourceIds.size,
        target_count: targetIds.size,
        missing_count: missingCount,
        duplicate_count: duplicateCount,
        invalid_count: invalidCount,
    };
}

async function readDashboardLeadParity(dependencies = {}) {
    try {
        const createClient = dependencies.createSheetsClient || createSheetsClient;
        const read = dependencies.readSheet || readSheet;
        const { sheets, spreadsheetId } = await createClient();
        if (!sheets || !spreadsheetId || typeof read !== "function") return null;

        const [sourceHeaderRows, targetHeaderRows] = await Promise.all([
            read(sheets, spreadsheetId, "LEADS_MAIN!1:1"),
            read(sheets, spreadsheetId, "LEADS!1:1"),
        ]);
        const sourceColumns = getHeaderColumns(
            sourceHeaderRows,
            "LEADS_MAIN",
            SOURCE_FIELDS,
            ["lead_id"]
        );
        const targetColumns = getHeaderColumns(
            targetHeaderRows,
            "LEADS",
            ["lead_id"],
            ["lead_id"]
        );

        const requests = [];
        for (const [field, column] of sourceColumns) {
            requests.push({
                key: `source:${field}`,
                range: `LEADS_MAIN!${columnToLetter(column)}3:${columnToLetter(column)}`,
            });
        }
        const targetLeadIdColumn = targetColumns.get("lead_id");
        requests.push({
            key: "target:lead_id",
            range: `LEADS!${columnToLetter(targetLeadIdColumn)}3:${columnToLetter(targetLeadIdColumn)}`,
        });

        const results = await Promise.all(requests.map(async request => [
            request.key,
            readColumnValues(await read(sheets, spreadsheetId, request.range)),
        ]));
        const valuesByKey = Object.fromEntries(results);
        const sourceValuesByField = Object.fromEntries(
            [...sourceColumns.keys()].map(field => [field, valuesByKey[`source:${field}`]])
        );
        const counts = summarizeLeadParity(sourceValuesByField, valuesByKey["target:lead_id"]);

        return { complete: true, ...counts };
    } catch {
        // Fail closed. The route converts this to UNKNOWN without exposing errors or values.
        return null;
    }
}

function shapeDashboardHealthResponse(snapshot) {
    const countsAreValid = snapshot?.complete === true
        && COUNT_FIELDS.every(field => Number.isSafeInteger(snapshot[field]) && snapshot[field] >= 0)
        && snapshot.missing_count <= snapshot.source_count
        && snapshot.duplicate_count <= snapshot.target_count;
    const counts = countsAreValid
        ? Object.fromEntries(COUNT_FIELDS.map(field => [field, snapshot[field]]))
        : Object.fromEntries(COUNT_FIELDS.map(field => [field, null]));

    const parityStatus = !countsAreValid
        ? "UNKNOWN"
        : COUNT_FIELDS.slice(2).some(field => counts[field] > 0) ? "WARNING" : "HEALTHY";

    return {
        backend: { status: "HEALTHY" },
        core_to_leads: { status: parityStatus, ...counts },
        facebook_sync: { status: "UNKNOWN" },
        last_facebook_sync: null,
        materializer_execution: { status: "UNKNOWN" },
        crm_core_freshness: { status: "UNKNOWN" },
        last_crm_update: null,
    };
}

module.exports = {
    SOURCE_PRESENCE_FIELDS,
    readDashboardLeadParity,
    summarizeLeadParity,
    shapeDashboardHealthResponse,
};
