"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    buildCrm4DashboardModel,
    customerTypeForDashboard,
    createCrm4SheetsReader,
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
});

test("audio update gate remains disabled unless all explicit owner gates are enabled", async () => {
    assert.equal(createAudioUpdateGate({}).enabled, false);
    const result = await runAudioUpdate({ env: {}, readInputs() { throw new Error("must not run"); } });
    assert.equal(result.status, "DISABLED");
    assert.equal(result.gate.writeEnabled, false);
});
