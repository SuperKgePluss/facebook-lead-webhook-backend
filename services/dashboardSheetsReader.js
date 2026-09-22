"use strict";

// Read-only boundary for D2 dashboard data. The only existing Sheets helpers
// used here are getSheetRows (which reaches values.get) and rowToObject.
const { getSheetRows, rowToObject } = require("./googleSheets");

const DASHBOARD_SHEET_NAMES = Object.freeze({
    leads: "LEADS_MAIN",
    deals: "DEALS",
    installations: "INSTALLATIONS",
    activities: "ACTIVITY_LOG",
});

const DEAL_SOURCE_FIELDS = Object.freeze([
    ["Deal ID", "deal_id"],
    ["Lead ID", "lead_id"],
    ["Full Amount", "full_amount"],
    ["Paid Amount", "paid_amount"],
    ["Payment Status", "payment_status"],
    ["Payment Date", "payment_date"],
]);

function sheetRowsToRecords(rows) {
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) return [];

    const headers = rows[0];
    return rows
        .slice(2) // row 1 is headers; row 2 is the canonical label row.
        .filter(row => Array.isArray(row))
        .map(row => rowToObject(headers, row));
}

function projectDealRows(rows) {
    const headers = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
    const headerIndexesByName = new Map();

    headers.forEach((header, index) => {
        const exactSourceName = String(header ?? "").trim().toLowerCase();
        if (!exactSourceName) return;
        const indexes = headerIndexesByName.get(exactSourceName) || [];
        indexes.push(index);
        headerIndexesByName.set(exactSourceName, indexes);
    });

    const missingHeaders = DEAL_SOURCE_FIELDS
        .map(([sourceHeader]) => sourceHeader)
        .filter(sourceHeader => !headerIndexesByName.has(sourceHeader.toLowerCase()));
    const duplicateHeaders = DEAL_SOURCE_FIELDS
        .map(([sourceHeader]) => sourceHeader)
        .filter(sourceHeader => (headerIndexesByName.get(sourceHeader.toLowerCase()) || []).length > 1);

    if (missingHeaders.length > 0 || duplicateHeaders.length > 0) {
        const problemDetails = [];
        if (missingHeaders.length > 0) problemDetails.push(`missing: ${missingHeaders.join(", ")}`);
        if (duplicateHeaders.length > 0) problemDetails.push(`duplicated: ${duplicateHeaders.join(", ")}`);
        return {
            records: [],
            warnings: [{
                code: "dashboard_deals_projection_unavailable",
                count: 1,
                message: `DEALS metrics unavailable; required source headers ${problemDetails.join("; ")}.`,
            }],
        };
    }

    const sourceIndexes = DEAL_SOURCE_FIELDS.map(([sourceHeader, targetField]) => [
        targetField,
        headerIndexesByName.get(sourceHeader.toLowerCase())[0],
    ]);
    const records = rows
        .slice(2) // row 1 is headers; row 2 is the canonical label row.
        .filter(row => Array.isArray(row))
        .map(row => Object.fromEntries(sourceIndexes.map(([targetField, index]) => [
            targetField,
            row[index] ?? "",
        ])));

    return { records, warnings: [] };
}

async function readDashboardSheets(readRows = getSheetRows) {
    const sourceWarnings = [];
    const entries = await Promise.all(
        Object.entries(DASHBOARD_SHEET_NAMES).map(async ([key, sheetName]) => {
            const rows = await readRows(sheetName);
            if (key === "deals") {
                const projection = projectDealRows(rows);
                sourceWarnings.push(...projection.warnings);
                return [key, projection.records];
            }
            return [key, sheetRowsToRecords(rows)];
        })
    );

    return {
        ...Object.fromEntries(entries),
        source_warnings: sourceWarnings,
    };
}

module.exports = {
    DASHBOARD_SHEET_NAMES,
    sheetRowsToRecords,
    readDashboardSheets,
};
