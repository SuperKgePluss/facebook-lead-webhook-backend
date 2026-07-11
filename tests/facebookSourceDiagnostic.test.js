const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFacebookSourceDiagnostic } = require("../services/facebookSourceDiagnostic");

const fromDate = new Date("2026-07-03T14:27:00.000Z");
const toDate = new Date("2026-07-12T23:59:59.000Z");

function lead(id, createdTime, formId) {
    return { id, created_time: createdTime, form_id: formId };
}

function baseOptions(overrides = {}) {
    return {
        forms: [{ id: "form-1", name: "Form 1" }],
        perFormLimit: 100,
        fromDate,
        toDate,
        compareSheet: true,
        capturedLeadgenIds: new Set(),
        fetchLeadRefsPageForForm: async ({ formId }) => ({
            leads: [lead(`${formId}-lead`, "2026-07-04T00:00:00.000Z", formId)],
            next_after_cursor: "",
            next_url_available: false,
        }),
        ...overrides,
    };
}

test("count_in_window always equals items_in_window.length", async () => {
    const result = await buildFacebookSourceDiagnostic(baseOptions());
    assert.equal(result.count_in_window, result.items_in_window.length);
    assert.equal(result.source_items_in_window_count, result.items_in_window.length);
});

test("all discovered forms are scanned independently", async () => {
    const calls = [];
    const forms = [
        { id: "form-1", name: "Form 1" },
        { id: "form-2", name: "Form 2" },
        { id: "form-3", name: "Form 3" },
        { id: "form-4", name: "Form 4" },
    ];
    const result = await buildFacebookSourceDiagnostic(baseOptions({
        forms,
        fetchLeadRefsPageForForm: async ({ formId }) => {
            calls.push(formId);
            return {
                leads: [lead(`${formId}-lead`, "2026-07-04T00:00:00.000Z", formId)],
                next_after_cursor: "",
                next_url_available: false,
            };
        },
    }));

    assert.deepEqual(calls, forms.map(form => form.id));
    assert.equal(result.form_count, 4);
    assert.equal(result.forms_scanned_count, 4);
    assert.equal(result.all_forms_scanned, true);
    assert.equal(result.source_coverage_complete, true);
});

test("a form limit before the requested start prevents complete coverage", async () => {
    const result = await buildFacebookSourceDiagnostic(baseOptions({
        perFormLimit: 2,
        fetchLeadRefsPageForForm: async ({ formId }) => ({
            leads: [
                lead("lead-new", "2026-07-06T00:00:00.000Z", formId),
                lead("lead-old", "2026-07-05T00:00:00.000Z", formId),
            ],
            next_after_cursor: "next-page",
            next_url_available: true,
        }),
    }));

    assert.equal(result.forms[0].reached_limit, true);
    assert.equal(result.source_coverage_complete, false);
    assert.match(result.coverage_warnings[0], /requested start timestamp/);
});

test("a failed form prevents complete coverage while later forms are still attempted", async () => {
    const calls = [];
    const result = await buildFacebookSourceDiagnostic(baseOptions({
        forms: [{ id: "bad", name: "Bad" }, { id: "good", name: "Good" }],
        fetchLeadRefsPageForForm: async ({ formId }) => {
            calls.push(formId);
            if (formId === "bad") throw new Error("Graph unavailable");
            return { leads: [], next_after_cursor: "", next_url_available: false };
        },
    }));

    assert.deepEqual(calls, ["bad", "good"]);
    assert.equal(result.forms[0].fetch_failed, true);
    assert.equal(result.all_forms_scanned, true);
    assert.equal(result.source_coverage_complete, false);
});

test("missing Facebook Leadgen IDs are reported from the captured-ID set", async () => {
    const result = await buildFacebookSourceDiagnostic(baseOptions({
        capturedLeadgenIds: new Set(["captured"]),
        fetchLeadRefsPageForForm: async ({ formId }) => ({
            leads: [
                lead("captured", "2026-07-04T00:00:00.000Z", formId),
                lead("missing", "2026-07-05T00:00:00.000Z", formId),
            ],
            next_after_cursor: "",
            next_url_available: false,
        }),
    }));

    assert.equal(result.source_items_in_window_count, 2);
    assert.equal(result.existing_in_leads_main_count, 1);
    assert.equal(result.missing_from_leads_main_count, 1);
    assert.equal(result.missing_from_leads_main[0].facebook_leadgen_id, "missing");
});

test("diagnostic orchestration never calls an injected write helper", async () => {
    let writeCalls = 0;
    const result = await buildFacebookSourceDiagnostic(baseOptions({
        appendLeadsToSheetBatch: async () => { writeCalls++; },
    }));

    assert.equal(result.read_only, undefined);
    assert.equal(writeCalls, 0);
});
