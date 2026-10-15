"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    buildCrm4DashboardModel,
    customerTypeForDashboard,
    createCrm4SheetsReader,
    createCrm4DashboardDataProvider,
    recordsFromGrid,
    SHEET_NAMES,
} = require("../services/crm4DashboardAdapter");
const { createAudioUpdateGate, runAudioUpdate } = require("../services/crm4AudioAutomation");
const { buildAdditiveSchemaPlan, buildCrm4AudioSheetPlan } = require("../services/crm4SheetSchema");
const { shapeDashboardResponse } = require("../services/dashboardPrivacy");

function fixture({ complete = true } = {}) {
    return {
        LEADS: [
            ["Lead ID", "Facebook Created Time", "Customer Name", "Phone", "Lead Status", "Sales Owner"],
            ["รหัสลูกค้า", "เวลาสร้างลีดจาก Facebook", "ชื่อลูกค้า", "เบอร์โทร", "สถานะลูกค้า", "ผู้รับผิดชอบ"],
            ["L-1", "2026-10-01", "Synthetic One", "0812345678", "New", "Owner A"],
        ],
        LEADS_MAIN: [
            ["Lead ID", "Customer Name", "Phone", "Lead Status", "Sales Owner", "Source", "Customer Type"],
            ["รหัสลูกค้า", "ชื่อลูกค้า", "เบอร์โทร", "สถานะลูกค้า", "ผู้ดูแล", "แหล่งที่มา", "ประเภทลูกค้า"],
            ["L-1", "Synthetic One", "0812345678", "New", "Owner A", "Facebook", "VIP"],
            ["L-2", "Synthetic Two", "0898765432", "Ongoing", "Owner B", "Referral", "B2B"],
        ],
        DEALS: [["Deal ID", "Lead ID", "Full Amount", "Paid Amount", "Payment Status", "Payment Date"]],
        INSTALLATIONS: [["Install ID", "Lead ID", "Install Status", "Preferred Install Date"]],
        ACTIVITY_LOG: [
            ["Activity ID", "Lead ID", "Action Type", "Created At", "Audio File Name", "Audio URL"],
            ["ACT-1", "L-1", "Audio Sync", "2026-10-14", "synthetic.mp3", "https://drive.google.com/file/d/private-id/view"],
        ],
        AUDIO_LIBRARY_INDEX: [
            ["Drive File ID", "Detected Phone", "Matched Lead ID", "Match Status", "File Name", "Verified Recording At", "Recording Timestamp Verified"],
            ["drive_file_00001", "0812345678", "L-1", "MATCHED_CANDIDATE", "0812345678_261001_100000.mp3", "2026-10-01T03:00:00.000Z", true],
            ["drive_file_00001", "0812345678", "L-1", "MATCHED_CANDIDATE", "0812345678_261001_100000.mp3", "2026-10-01T03:00:00.000Z", true],
        ],
        AUDIO_INDEX_STATE: [["State Key", "State Value"], ["CURRENT_SCAN", JSON.stringify({ status: complete ? "COMPLETE" : "IN_PROGRESS", scan_version: "synthetic-v1" })]],
    };
}

test("CRM4 provider caches source sheets for 45 seconds and rebuilds filtered pages per request", async () => {
    let currentTime = 1_000;
    let readCount = 0;
    const sheets = fixture();
    sheets.LEADS.push(["L-2", "2026-10-02", "Synthetic Two", "0898765432", "Ongoing", "Owner B"]);
    const provider = createCrm4DashboardDataProvider({
        readSheets: async () => { readCount++; return sheets; },
        now: () => currentTime,
    });

    const first = await provider({ filters: {}, pagination: { offset: 0, limit: 1 } });
    const filtered = await provider({ filters: { salesOwner: "Owner B" }, pagination: { offset: 0, limit: 1 } });
    const secondPage = await provider({ filters: {}, pagination: { offset: 1, limit: 1 } });

    assert.equal(readCount, 1);
    assert.equal(first.operational_leads.items.length, 1);
    assert.equal(filtered.operational_leads.items[0].sales_owner, "Owner B");
    assert.equal(secondPage.operational_leads.items.length, 1);
    assert.notEqual(first, filtered);

    currentTime += 45_000;
    await provider({ filters: {}, pagination: { offset: 0, limit: 1 } });
    assert.equal(readCount, 2);
});

test("CRM4 provider coalesces concurrent source reads and force refresh bypasses the cache", async () => {
    let readCount = 0;
    let releaseRead;
    const pendingSheets = new Promise(resolve => { releaseRead = resolve; });
    const provider = createCrm4DashboardDataProvider({
        readSheets: () => { readCount++; return pendingSheets; },
    });

    const first = provider();
    const second = provider({ forceRefresh: true });
    await Promise.resolve();
    assert.equal(readCount, 1);
    releaseRead(fixture());
    await Promise.all([first, second]);
    await provider({ forceRefresh: true });
    assert.equal(readCount, 2);
});

test("CRM4 provider clears its snapshot and surfaces refresh failures", async () => {
    let readCount = 0;
    const provider = createCrm4DashboardDataProvider({
        readSheets: async () => {
            readCount++;
            if (readCount > 1) throw new Error("synthetic CRM4 read failure");
            return fixture();
        },
    });

    await provider();
    await assert.rejects(provider({ forceRefresh: true }), /synthetic CRM4 read failure/);
    await assert.rejects(provider(), /synthetic CRM4 read failure/);
    assert.equal(readCount, 3);
});

test("CRM4 provider does not cache a source snapshot that fails model validation", async () => {
    let readCount = 0;
    const provider = createCrm4DashboardDataProvider({
        readSheets: async () => {
            readCount++;
            return { LEADS: [] };
        },
    });

    await assert.rejects(provider());
    await assert.rejects(provider());
    assert.equal(readCount, 2);
});

test("Release 1 maps CRM4 leads without audio tabs and excludes MAIN-only IDs", () => {
    const sheets = fixture();
    delete sheets.AUDIO_LIBRARY_INDEX;
    delete sheets.AUDIO_INDEX_STATE;
    const model = buildCrm4DashboardModel(sheets, {}, { offset: 0, limit: 100 }, new Date("2026-10-14T00:00:00Z"));
    assert.deepEqual(SHEET_NAMES, ["LEADS", "LEADS_MAIN", "DEALS", "INSTALLATIONS", "ACTIVITY_LOG"]);
    assert.equal(model.operational_leads.total, 1);
    assert.equal(model.overview.leads.total, 1);
    assert.equal(model.crm4_reconciliation.main_only_lead_count, 1);
    assert.equal(model.warnings.some(warning => warning.code === "crm4_main_only_id_exception" && warning.count === 1), true);
    assert.equal(Object.keys(model.operational_leads.items[0]).some(key => /audio|recording/i.test(key)), false);
    assert.equal(Object.hasOwn(model, "audio_index"), false);
    assert.equal(JSON.stringify(model.recent_activity).includes("Audio Sync"), false);
    assert.equal(JSON.stringify(model).includes("private-id"), false);
    assert.equal(customerTypeForDashboard("VIP"), "ETC");
    assert.equal(model.overview.leads.by_customer_type_code.ETC, 1);
});

test("valid CRM4 Lead IDs survive header-like cell values and unknown lifecycle status", () => {
    const sheets = fixture();
    sheets.LEADS.push(["L-UNMAPPED", "2026-10-02", "Owner", "Phone", "Future Lifecycle", "Owner A"]);
    const model = buildCrm4DashboardModel(sheets, {}, { offset: 0, limit: 100 }, new Date("2026-10-14T00:00:00Z"));

    assert.equal(model.overview.leads.total, 2);
    assert.equal(model.operational_leads.total, 2);
    assert.equal(model.operational_leads.items.some(item => item.lead_id === "L-UNMAPPED" && item.lead_status === "Unknown/Unmapped"), true);
    assert.equal(model.overview.leads.by_status["Unknown/Unmapped"], 1);
    assert.equal(Object.values(model.overview.leads.by_status).reduce((sum, count) => sum + count, 0), model.overview.leads.total);
    const unknownOnly = buildCrm4DashboardModel(sheets, { leadStatus: "Unknown/Unmapped" }, { offset: 0, limit: 100 }, new Date("2026-10-14T00:00:00Z"));
    assert.deepEqual(unknownOnly.operational_leads.items.map(item => item.lead_id), ["L-UNMAPPED"]);
    assert.equal(unknownOnly.overview.leads.total, 1);
});

test("duplicate Deal IDs do not double count or invent financial totals", () => {
    const headers = ["Deal ID", "Lead ID", "Full Amount", "Paid Amount", "Payment Status", "Payment Date"];
    const deal = ["D-1", "L-1", 1000, 200, "Partial", "2026-10-01"];
    const identical = fixture();
    identical.DEALS = [headers, deal, [...deal]];
    const valid = shapeDashboardResponse(buildCrm4DashboardModel(identical, {}, {}, new Date("2026-10-14T00:00:00Z")));
    assert.equal(valid.overview.financial.deal_value, 1000);
    assert.equal(valid.crm4_source_capabilities.financial_complete, true);
    assert.equal(valid.warnings.some(warning => warning.code === "crm4_duplicate_deal_rows_collapsed"), true);

    const conflicting = fixture();
    conflicting.DEALS = [headers, deal, ["D-1", "L-1", 2000, 200, "Partial", "2026-10-01"]];
    const unavailable = shapeDashboardResponse(buildCrm4DashboardModel(conflicting, {}, {}, new Date("2026-10-14T00:00:00Z")));
    assert.equal(unavailable.overview.leads.total, 1);
    assert.equal(unavailable.overview.financial.deal_value, null);
    assert.equal(unavailable.crm4_source_capabilities.financial_complete, false);
    assert.equal(unavailable.warnings.some(warning => warning.code === "crm4_conflicting_deal_ids_excluded" && warning.count === 1), true);
});

test("Release 1 Sheet reader requires no audio tabs or recording data columns", async () => {
    const requestedRanges = [];
    const headers = ["Activity ID", "Lead ID", "Sheet Name", "Action Type", "Old Value", "New Value", "Lead Status", "Note", "Audio URL", "Audio File Name", "Payment URL", "Payment File Name", "Location URL", "Location File Name", "Created By", "Created At"];
    const valuesByColumn = {
        A: [["Activity ID"], ["activity-1"]], B: [["Lead ID"], ["lead-1"]], D: [["Action Type"], ["Follow-up"]],
        G: [["Lead Status"], ["New"]], H: [["Note"], ["synthetic note"]], O: [["Created By"], ["synthetic owner"]], P: [["Created At"], ["2026-10-14"]],
    };
    const fakeSheets = {
        spreadsheets: {
            get: async () => ({ data: { sheets: SHEET_NAMES.map(title => ({ properties: { title, gridProperties: { columnCount: title === "ACTIVITY_LOG" ? 16 : 8, frozenRowCount: 2 } } })) } }),
            values: {
                batchGet: async ({ ranges }) => {
                    requestedRanges.push(...ranges);
                    const activityRead = ranges.some(range => range.includes("ACTIVITY_LOG"));
                    return { data: { valueRanges: ranges.map(range => {
                        if (!activityRead) return { values: [] };
                        const column = range.match(/!([A-Z]+):/)[1];
                        return { values: valuesByColumn[column] || [] };
                    }) } };
                },
                get: async ({ range }) => {
                    assert.equal(range, "'ACTIVITY_LOG'!A1:P2");
                    return { data: { values: [headers, headers] } };
                },
            },
        },
    };
    const read = createCrm4SheetsReader({ CRM4_SPREADSHEET_ID: "synthetic-sheet", CRM4_GOOGLE_CLIENT_EMAIL: "reader@example.test", CRM4_GOOGLE_PRIVATE_KEY: "synthetic-key" }, () => fakeSheets);
    const sheets = await read();
    assert.deepEqual(Object.keys(sheets), ["LEADS", "LEADS_MAIN", "DEALS", "INSTALLATIONS", "ACTIVITY_LOG"]);
    assert.equal(requestedRanges.some(range => /AUDIO_LIBRARY_INDEX|AUDIO_INDEX_STATE|ACTIVITY_LOG'!I:I|ACTIVITY_LOG'!J:J/.test(range)), false);
    assert.equal(sheets.ACTIVITY_LOG[1][8], "");
    assert.equal(sheets.ACTIVITY_LOG[1][9], "");
});

test("header matching fails closed on conflicting aliases and schema planning never enables writes", () => {
    assert.throws(() => recordsFromGrid([["Lead ID", "ID", "Facebook Created Time", "Customer Name", "Phone", "Lead Status", "Sales Owner"]], "LEADS"), /duplicate or conflicting headers/);
    const plan = buildAdditiveSchemaPlan([["Lead ID", "Phone"]]);
    assert.equal(plan.mode, "DRY_RUN_ONLY");
    assert.equal(plan.writesEnabled, false);
    assert.equal(plan.columns.length, 4);
    assert.equal(plan.dropdownValues.length, 15);
});

test("audio sheet plan is bounded to CRM4 LEADS rows and remains dry-run only", () => {
    const sheets = fixture();
    const plan = buildCrm4AudioSheetPlan(sheets);
    assert.equal(plan.mode, "DRY_RUN_ONLY");
    assert.equal(plan.writesEnabled, false);
    assert.equal(plan.audioIndexComplete, true);
    assert.equal(plan.rowUpdates.length, 1);
    assert.equal(plan.rowUpdates[0].rowNumber, 3);
    assert.equal(plan.headerPlan.columns[0].firstDataRow, 3);
    assert.deepEqual(plan.rowUpdates[0].cells.map(cell => cell.value), [1, "2026-10-01T03:00:00.000Z", "https://drive.google.com/file/d/drive_file_00001/view"]);
    assert.equal(plan.headerPlan.columns.some(column => column.key === "sales_follow_up_status"), true);
});

test("Release 1 response shaping omits audio fields, counts, and links", () => {
    const shaped = shapeDashboardResponse({
        operational_leads: { items: [{ audio_follow_up_count: 4, latest_recording_link: "https://drive.google.com/file/d/private-id/view", audio_recording_count: 2, latest_recording_at: "2026-10-14" }] },
        audio_index: { complete: true, stats: { matched: 2, missingPhone: 3 } },
    });
    assert.equal(Object.keys(shaped.operational_leads.items[0]).some(key => /audio|recording/i.test(key)), false);
    assert.equal(Object.hasOwn(shaped, "audio_index"), false);
    assert.equal(JSON.stringify(shaped).includes("private-id"), false);
    const reconciliation = shapeDashboardResponse({ crm4_reconciliation: { main_only_lead_count: 1 } });
    assert.equal(reconciliation.crm4_reconciliation.main_only_lead_count, 1);
    const ownerOptions = shapeDashboardResponse({
        overview: { leads: { sales_owner_options: ["Owner A", "__CRM4_UNASSIGNED_FILTER__", "Owner A"] } },
    });
    assert.deepEqual(ownerOptions.overview.leads.sales_owner_options, ["Owner A", "__CRM4_UNASSIGNED_FILTER__"]);
});

test("audio update gate remains disabled unless all explicit owner gates are enabled", async () => {
    assert.equal(createAudioUpdateGate({}).enabled, false);
    const result = await runAudioUpdate({ env: {}, readInputs() { throw new Error("must not run"); } });
    assert.equal(result.status, "DISABLED");
    assert.equal(result.gate.writeEnabled, false);
});
