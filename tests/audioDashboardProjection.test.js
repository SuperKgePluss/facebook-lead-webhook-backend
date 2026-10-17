"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDashboardReadModel } = require("../services/dashboardReadModel");
const { shapeDashboardResponse } = require("../services/dashboardPrivacy");

function buildModel(audioIndex) {
    return buildDashboardReadModel({
        leads: [{ lead_id: "SYN-LEAD-1", customer_name: "Synthetic", phone: "0812345678", created_at: "2026-10-17T10:00:00+07:00" }],
        audio_index: audioIndex,
    });
}

test("authenticated Dashboard projection shows unique verified audio summary fields", () => {
    const model = buildModel({
        available: true,
        timestamp_verified: true,
        links_authorized: true,
        entries: [
            { file_id: "synthetic-file-1", lead_id: "SYN-LEAD-1", recording_at: "2026-10-17T03:00:00.000Z", recording_at_verified: true },
            { file_id: "synthetic-file-1", lead_id: "SYN-LEAD-1", recording_at: "2026-10-17T03:00:00.000Z", recording_at_verified: true },
            { file_id: "synthetic-file-2", lead_id: "SYN-LEAD-1", recording_at: "2026-10-17T04:00:00.000Z", recording_at_verified: true },
        ],
    });
    const lead = shapeDashboardResponse(model).operational_leads.items[0];
    assert.equal(lead.audio_recording_count, 2);
    assert.equal(lead.audio_latest_recording_at, "2026-10-17T04:00:00.000Z");
    assert.equal(lead.audio_latest_recording_url, "https://drive.google.com/file/d/synthetic-file-2/view");
});

test("unavailable, unverified, or unauthorized audio remains honestly unavailable", () => {
    const unavailable = shapeDashboardResponse(buildModel({ available: false })).operational_leads.items[0];
    assert.equal(unavailable.audio_recording_count, null);
    assert.equal(unavailable.audio_latest_recording_at, null);
    assert.equal(unavailable.audio_latest_recording_url, null);

    const unverified = buildModel({
        available: true,
        timestamp_verified: false,
        links_authorized: false,
        entries: [{ file_id: "synthetic-file-3", lead_id: "SYN-LEAD-1", recording_at: "2026-10-17T04:00:00.000Z", recording_at_verified: false }],
    });
    const lead = shapeDashboardResponse(unverified).operational_leads.items[0];
    assert.equal(lead.audio_recording_count, 1);
    assert.equal(lead.audio_latest_recording_at, null);
    assert.equal(lead.audio_latest_recording_url, null);
});

test("privacy projection rejects noncanonical Drive links", () => {
    const lead = shapeDashboardResponse({ operational_leads: { items: [{
        audio_recording_count: 1,
        audio_latest_recording_at: "2026-10-17T04:00:00.000Z",
        audio_latest_recording_url: "https://drive.google.com/open?id=synthetic-file-4",
    }] } }).operational_leads.items[0];
    assert.equal(lead.audio_latest_recording_url, null);
});
