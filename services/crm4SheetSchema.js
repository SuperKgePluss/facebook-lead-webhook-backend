"use strict";

const { SALES_FOLLOW_UP_STATUSES } = require("./dashboardReadModel");
const {
    REQUIRED_FIELDS,
    locateHeaderRow,
    buildHeaderMap,
    recordsFromGrid,
    buildPrimaryLeads,
    audioIndexIsComplete,
} = require("./crm4DashboardAdapter");
const { classifyAudioIndexRecords } = require("./crm4AudioAutomation");

const CRM4_ADD_ON_COLUMNS = Object.freeze([
    { key: "sales_follow_up_status", header: "Sales Follow-up Status", aliases: ["Sales Follow-up Status", "Sales Follow Up Status", "สถานะติดตามการขาย"], label: "สถานะติดตามการขาย", validation: "follow_up_status" },
    { key: "audio_recording_count", header: "Audio Recording Count", aliases: ["Audio Recording Count", "จำนวนไฟล์เสียง"], label: "จำนวนไฟล์เสียง", validation: null },
    { key: "latest_recording_at", header: "Latest Recording At", aliases: ["Latest Recording At", "เวลาบันทึกเสียงล่าสุด"], label: "เวลาบันทึกเสียงล่าสุด", validation: null },
    { key: "latest_recording_link", header: "Latest Recording Link", aliases: ["Latest Recording Link", "ลิงก์ไฟล์เสียงล่าสุด"], label: "ลิงก์ไฟล์เสียงล่าสุด", validation: null },
]);

function normalizeHeader(value) {
    return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildAdditiveSchemaPlan(headerRows, firstDataRow = 3) {
    if (!Array.isArray(headerRows) || !Array.isArray(headerRows[0])) throw new TypeError("CRM4 header row is required.");
    const headers = headerRows[0];
    const normalizedHeaders = headers.map(normalizeHeader);
    const planned = [];
    for (const column of CRM4_ADD_ON_COLUMNS) {
        const aliases = (column.aliases || [column.header]).map(normalizeHeader);
        const found = [];
        normalizedHeaders.forEach((value, index) => { if (aliases.includes(value)) found.push(index + 1); });
        if (found.length > 1) throw new Error(`Duplicate CRM4 output header: ${column.header}`);
        if (found.length === 1) continue;
        planned.push({ ...column, columnIndex: headers.length + planned.length + 1, firstDataRow });
    }
    return {
        mode: "DRY_RUN_ONLY",
        writesEnabled: false,
        appendHeaders: planned.map(item => item.header),
        appendLabels: planned.map(item => item.label),
        columns: planned,
        dropdownValues: [...SALES_FOLLOW_UP_STATUSES],
        requiresSeparateSheetWriteApproval: planned.length > 0,
        requiresTimestampVerification: true,
    };
}

function buildCrm4AudioSheetPlan(sheets, options = {}) {
    const leadsGrid = sheets?.LEADS;
    const leadsHeaderRow = locateHeaderRow(leadsGrid, REQUIRED_FIELDS.LEADS, "LEADS");
    const leadsHeaderMap = buildHeaderMap(leadsGrid[leadsHeaderRow], "LEADS");
    const leadRecords = recordsFromGrid(leadsGrid, "LEADS");
    const mainRecords = recordsFromGrid(sheets.LEADS_MAIN, "LEADS_MAIN");
    const leads = buildPrimaryLeads(leadRecords, mainRecords);
    const audioRows = recordsFromGrid(sheets.AUDIO_LIBRARY_INDEX, "AUDIO_LIBRARY_INDEX");
    const stateRows = recordsFromGrid(sheets.AUDIO_INDEX_STATE, "AUDIO_INDEX_STATE");
    const complete = audioIndexIsComplete(stateRows);
    const audio = classifyAudioIndexRecords(leads, audioRows, {
        indexComplete: complete,
        filenameTimestampVerified: options.filenameTimestampVerified === true,
        filenameTimeZone: options.filenameTimeZone,
    });
    const leadRows = new Map();
    for (let rowIndex = leadsHeaderRow + 1; rowIndex < leadsGrid.length; rowIndex++) {
        const row = leadsGrid[rowIndex];
        if (!Array.isArray(row)) continue;
        const leadId = String(row[leadsHeaderMap.lead_id] ?? "").trim();
        if (leadId) leadRows.set(leadId, rowIndex + 1);
    }
    const primaryDataRows = leads.map(lead => leadRows.get(lead.lead_id)).filter(Number.isSafeInteger);
    const firstDataRow = primaryDataRows.length ? Math.min(...primaryDataRows) : leadsHeaderRow + 2;
    const headerPlan = buildAdditiveSchemaPlan([leadsGrid[leadsHeaderRow]], firstDataRow);
    const outputColumns = {};
    for (const column of CRM4_ADD_ON_COLUMNS) {
        const matching = (leadsGrid[leadsHeaderRow] || []).findIndex(header => (column.aliases || [column.header]).map(normalizeHeader).includes(normalizeHeader(header)));
        outputColumns[column.key] = matching >= 0 ? matching + 1 : headerPlan.columns.find(item => item.key === column.key)?.columnIndex ?? null;
    }
    const rowUpdates = [];
    if (complete) {
        for (const lead of leads) {
            const rowNumber = leadRows.get(lead.lead_id);
            if (!rowNumber) continue; // MAIN-only IDs remain visible on the Dashboard, with no invented LEADS row.
            const summary = audio.summaries.get(lead.lead_id);
            const values = {
                audio_recording_count: summary?.recording_count ?? 0,
                latest_recording_at: summary?.latest_recording_at ?? "",
                latest_recording_link: summary?.latest_recording_link ?? "",
            };
            rowUpdates.push({
                rowNumber,
                cells: Object.entries(values)
                    .map(([key, value]) => ({ columnIndex: outputColumns[key], value }))
                    .filter(cell => Number.isInteger(cell.columnIndex)),
            });
        }
    }
    return {
        mode: "DRY_RUN_ONLY",
        writesEnabled: false,
        audioIndexComplete: complete,
        headerPlan,
        outputColumns,
        rowUpdates,
        counts: { plannedLeadRows: rowUpdates.length, ...audio.stats },
        requiresSeparateSheetWriteApproval: true,
        requiresOwnerVerifiedAudioIndexCompletion: !complete,
        requiresTimestampVerification: true,
    };
}

module.exports = { CRM4_ADD_ON_COLUMNS, normalizeHeader, buildAdditiveSchemaPlan, buildCrm4AudioSheetPlan };
