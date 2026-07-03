const assert = require("node:assert");

const {
    _test: {
        buildCrm2FollowUpLogOnlyResponse,
    },
} = require("../services/imports/legacyCrm2Import");

function makeCandidate(overrides = {}) {
    return {
        source_row_number: 7,
        source_column_letter: "M",
        source_column_name: "Follow-up 1 Details",
        candidate_type: "legacy_follow_up_l_to_o",
        raw_text: "Call customer at 081-234-5678 or user@example.com",
        raw_phone: "0812345678",
        normalized_phone: "0812345678",
        phone: "0812345678",
        matched_lead_id: "LEAD-1",
        matched_existing_lead: true,
        duplicate_risk: false,
        ...overrides,
    };
}

function makeResponse(queryOverrides = {}) {
    const matchedCandidates = [
        makeCandidate({ matched_lead_id: "LEAD-1" }),
        makeCandidate({ source_row_number: 8, matched_lead_id: "LEAD-2" }),
    ];
    const logOnlyPlan = {
        candidates_to_append: matchedCandidates,
        duplicate_candidates_skipped: [
            makeCandidate({ source_row_number: 9, duplicate_risk: true, reason_skipped: "possible_duplicate_existing_activity_note" }),
        ],
        unmatched_candidates_skipped: [
            makeCandidate({
                source_row_number: 2,
                raw_phone: "เบอร์โทรศัพท์",
                normalized_phone: "",
                phone: "",
                raw_text: "วัน/เวลา ติดตามครั้งที่ 1",
                matched_lead_id: "",
                matched_existing_lead: false,
                reason_skipped: "unmatched_phone_no_existing_lead_id",
            }),
            makeCandidate({ source_row_number: 10, matched_lead_id: "", matched_existing_lead: false, reason_skipped: "unmatched_phone_no_existing_lead_id" }),
            makeCandidate({ source_row_number: 11, matched_lead_id: "", matched_existing_lead: false, reason_skipped: "unmatched_phone_no_existing_lead_id" }),
        ],
        internal_duplicate_candidates_skipped: [],
    };

    return buildCrm2FollowUpLogOnlyResponse({
        req: {
            query: {
                secret: "super-secret",
                dry_run: "true",
                mode: "crm2_followup_log_only",
                ...queryOverrides,
            },
        },
        dryRun: true,
        rawSheet: { sheetName: "IMPORT_RAW_CRM2" },
        crm2FollowUpAudit: {
            total_crm2_rows_scanned: 12,
            all_candidate_details: matchedCandidates.concat(
                logOnlyPlan.duplicate_candidates_skipped,
                logOnlyPlan.unmatched_candidates_skipped
            ),
        },
        logOnlyPlan,
        matchedCandidates,
        wouldCreateLeadRowsSkipped: [{ source_row_number: 10 }],
        appendedActivities: 0,
        failedActivityRows: 0,
        failedActivitySamples: [],
    });
}

const summary = makeResponse({
    summary_only: "true",
    sample_limit: "1",
});

assert.strictEqual(summary.received_query.secret, "<redacted>");
assert.strictEqual(summary.dry_run, true);
assert.strictEqual(summary.appended_activities, 0);
assert.strictEqual(summary.no_leads_created, true);
assert.strictEqual(summary.write_guard, "dry_run=true; no writes performed");
assert.strictEqual(summary.matched_candidate_samples.length, 1);
assert.strictEqual(summary.unmatched_candidate_samples.length, 1);
assert.strictEqual(summary.duplicate_risk_candidate_samples.length, 1);
assert.strictEqual(summary.header_template_unmatched_candidates_skipped_from_samples, 1);
assert.strictEqual(summary.candidates_matched_to_existing_lead_id, undefined);
assert.strictEqual(summary.duplicate_candidates_skipped_details, undefined);
assert.strictEqual(summary.crm2_followup_l_to_o_audit, undefined);
assert.match(summary.matched_candidate_samples[0].raw_phone, /<redacted_phone>/);
assert.match(summary.matched_candidate_samples[0].normalized_phone, /<redacted_phone>/);
assert.match(summary.matched_candidate_samples[0].phone, /<redacted_phone>/);
assert.match(summary.matched_candidate_samples[0].raw_text_preview, /<redacted_phone>/);
assert.match(summary.matched_candidate_samples[0].raw_text_preview, /<redacted_email>/);
assert.notStrictEqual(summary.unmatched_candidate_samples[0].source_row_number, 2);

const shortPhoneResponse = buildCrm2FollowUpLogOnlyResponse({
    req: {
        query: {
            secret: "super-secret",
            dry_run: "true",
            mode: "crm2_followup_log_only",
            summary_only: "true",
        },
    },
    dryRun: true,
    rawSheet: { sheetName: "IMPORT_RAW_CRM2" },
    crm2FollowUpAudit: {
        total_crm2_rows_scanned: 1,
        all_candidate_details: [makeCandidate({ raw_phone: "959269654", normalized_phone: "959269654", phone: "959269654" })],
    },
    logOnlyPlan: {
        candidates_to_append: [makeCandidate({ raw_phone: "959269654", normalized_phone: "959269654", phone: "959269654" })],
        duplicate_candidates_skipped: [],
        unmatched_candidates_skipped: [],
        internal_duplicate_candidates_skipped: [],
    },
    matchedCandidates: [makeCandidate({ raw_phone: "959269654", normalized_phone: "959269654", phone: "959269654" })],
    wouldCreateLeadRowsSkipped: [],
    appendedActivities: 0,
    failedActivityRows: 0,
    failedActivitySamples: [],
});

assert.strictEqual(shortPhoneResponse.matched_candidate_samples[0].raw_phone, "<redacted_phone>");
assert.strictEqual(shortPhoneResponse.matched_candidate_samples[0].normalized_phone, "<redacted_phone>");
assert.strictEqual(shortPhoneResponse.matched_candidate_samples[0].phone, "<redacted_phone>");

const defaultShape = makeResponse();

assert.strictEqual(defaultShape.received_query.secret, "<redacted>");
assert.ok(Array.isArray(defaultShape.candidates_matched_to_existing_lead_id));
assert.ok(defaultShape.crm2_followup_l_to_o_audit);

console.log("crm2FollowUpSafeResponse tests passed");
