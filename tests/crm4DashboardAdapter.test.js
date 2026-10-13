"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    buildCrm4DashboardModel,
    customerTypeForDashboard,
    recordsFromGrid,
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
        ACTIVITY_LOG: [["Activity ID", "Lead ID", "Action Type", "Created At", "Audio File Name", "Audio URL"]],
        AUDIO_LIBRARY_INDEX: [
            ["Drive File ID", "Detected Phone", "Matched Lead ID", "Match Status", "File Name", "Verified Recording At", "Recording Timestamp Verified"],
            ["drive_file_00001", "0812345678", "L-1", "MATCHED_CANDIDATE", "0812345678_261001_100000.mp3", "2026-10-01T03:00:00.000Z", true],
            ["drive_file_00001", "0812345678", "L-1", "MATCHED_CANDIDATE", "0812345678_261001_100000.mp3", "2026-10-01T03:00:00.000Z", true],
        ],
        AUDIO_INDEX_STATE: [["State Key", "State Value"], ["CURRENT_SCAN", JSON.stringify({ status: complete ? "COMPLETE" : "IN_PROGRESS", scan_version: "synthetic-v1" })]],
    };
}

test("CRM 4 maps primary and MAIN-only IDs, normalizes VIP for dashboard, and deduplicates Drive IDs", () => {
    const model = buildCrm4DashboardModel(fixture(), {}, { offset: 0, limit: 100 }, new Date("2026-10-14T00:00:00Z"));
    assert.equal(model.operational_leads.total, 1);
    assert.equal(model.overview.leads.total, 1);
    assert.equal(model.crm4_reconciliation.main_only_lead_count, 1);
    assert.equal(model.warnings.some(warning => warning.code === "crm4_main_only_id_exception" && warning.count === 1), true);
    assert.equal(model.operational_leads.items[0].audio_recording_count, 1);
    assert.equal(model.operational_leads.items[0].latest_recording_link, "https://drive.google.com/file/d/drive_file_00001/view");
    assert.equal(model.audio_index.complete, true);
    assert.equal(model.audio_index.stats.duplicateFiles, 1);
    assert.equal(customerTypeForDashboard("VIP"), "ETC");
    assert.equal(model.overview.leads.by_customer_type_code.ETC, 1);
});

test("incomplete audio index keeps counts and latest links unknown", () => {
    const model = buildCrm4DashboardModel(fixture({ complete: false }), {}, { offset: 0, limit: 100 }, new Date("2026-10-14T00:00:00Z"));
    assert.equal(model.operational_leads.items[0].audio_recording_count, null);
    assert.equal(model.operational_leads.items[0].latest_recording_at, null);
    assert.equal(model.operational_leads.items[0].latest_recording_link, null);
    assert.equal(model.warnings.some(warning => warning.code === "crm4_audio_index_incomplete"), true);
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

test("response shaping allows only validated Drive file links and aggregate audio diagnostics", () => {
    const shaped = shapeDashboardResponse({
        operational_leads: { items: [{ latest_recording_link: "https://drive.google.com/file/d/drive_file_00001/view", audio_recording_count: 2 }] },
        audio_index: { complete: true, stats: { matched: 2, missingPhone: 3 } },
    });
    assert.equal(shaped.operational_leads.items[0].latest_recording_link, "https://drive.google.com/file/d/drive_file_00001/view");
    assert.equal(shaped.audio_index.counts.missing_phone, 3);
    const reconciliation = shapeDashboardResponse({ crm4_reconciliation: { main_only_lead_count: 1 } });
    assert.equal(reconciliation.crm4_reconciliation.main_only_lead_count, 1);
    const rejected = shapeDashboardResponse({ operational_leads: { items: [{ latest_recording_link: "https://example.invalid/file" }] } });
    assert.equal(rejected.operational_leads.items[0].latest_recording_link, null);
});

test("audio update gate remains disabled unless all explicit owner gates are enabled", async () => {
    assert.equal(createAudioUpdateGate({}).enabled, false);
    const result = await runAudioUpdate({ env: {}, readInputs() { throw new Error("must not run"); } });
    assert.equal(result.status, "DISABLED");
    assert.equal(result.gate.writeEnabled, false);
});
