"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    buildFacebookRepeatSubmissionEvent,
    classifyFacebookIdentityMatch,
    dedupeRepeatSubmissionEvents,
    deterministicRepeatSubmissionId,
    normalizeFacebookLeadgenId,
} = require("../services/facebookIdentity");
const {
    PARTIAL_FAILURE_RECONCILIATION_REQUIRED,
    applyRecoveryPlan,
    assertPlanWithinAllowlist,
    buildRecoveryPlan,
    validateRecoveryAllowlist,
} = require("../services/facebookRecoveryPlan");
const {
    appendObjectsWithClient,
    appendLeadsToSheetBatchWithClient,
    buildObjectWriteOperations,
    validateFacebookRepeatSubmissionActivityHeaders,
    verifyExactFacebookLeadgenReadbacks,
} = require("../services/googleSheets");

const SYNTHETIC_ID = "12345678901234567";
const SYNTHETIC_ID_2 = "22345678901234567";

test("numeric-looking Facebook Leadgen IDs remain exact text", () => {
    assert.equal(normalizeFacebookLeadgenId(SYNTHETIC_ID), SYNTHETIC_ID);
    assert.equal(normalizeFacebookLeadgenId("  " + SYNTHETIC_ID + "  "), SYNTHETIC_ID);
    assert.equal(normalizeFacebookLeadgenId(12345678901234567), "");
    assert.equal(normalizeFacebookLeadgenId("1.2345678901234567e+16"), "");
});

test("Facebook detail writes isolate the identity cell for RAW semantics", () => {
    const operations = buildObjectWriteOperations(
        "LEAD_DETAILS",
        ["lead_id", "facebook_leadgen_id", "raw_phone"],
        3,
        {
            lead_id: "LEAD-SYNTHETIC",
            facebook_leadgen_id: SYNTHETIC_ID,
            raw_phone: "0812345678",
        }
    );

    assert.deepEqual(operations.rawData, [{
        range: "LEAD_DETAILS!B3:B3",
        values: [[SYNTHETIC_ID]],
    }]);
    assert.deepEqual(operations.identityVerifications, [{
        sheetName: "LEAD_DETAILS",
        rowNumber: 3,
        headerName: "facebook_leadgen_id",
        expectedValue: SYNTHETIC_ID,
    }]);
    assert.deepEqual(operations.enteredData, [{
        range: "LEAD_DETAILS!A3:A3",
        values: [["LEAD-SYNTHETIC"]],
    }, {
        range: "LEAD_DETAILS!C3:C3",
        values: [["0812345678"]],
    }]);
});

function fakeSheets(rowValue) {
    return {
        spreadsheets: {
            values: {
                get: async ({ range }) => ({
                    data: {
                        values: range.includes("A1:ZZ1")
                            ? [["lead_id", "facebook_leadgen_id"]]
                            : [["LEAD-SYNTHETIC", rowValue]],
                    },
                }),
            },
        },
    };
}

test("exact post-write readback succeeds for an exact text value", async () => {
    await verifyExactFacebookLeadgenReadbacks(fakeSheets(SYNTHETIC_ID), "synthetic-sheet", [{
        sheetName: "LEAD_DETAILS",
        rowNumber: 3,
        headerName: "facebook_leadgen_id",
        expectedValue: SYNTHETIC_ID,
    }]);
});

test("numeric or scientific readback fails closed", async () => {
    await assert.rejects(
        verifyExactFacebookLeadgenReadbacks(fakeSheets(12345678901234567), "synthetic-sheet", [{
            sheetName: "LEAD_DETAILS",
            rowNumber: 3,
            headerName: "facebook_leadgen_id",
            expectedValue: SYNTHETIC_ID,
        }]),
        /readback mismatch/
    );

    await assert.rejects(
        verifyExactFacebookLeadgenReadbacks(fakeSheets("1.2345678901234567E+16"), "synthetic-sheet", [{
            sheetName: "LEAD_DETAILS",
            rowNumber: 3,
            headerName: "facebook_leadgen_id",
            expectedValue: SYNTHETIC_ID,
        }]),
        /readback mismatch/
    );
});

test("exact ID takes precedence over phone collision", () => {
    assert.equal(
        classifyFacebookIdentityMatch({
            incomingFacebookLeadgenId: SYNTHETIC_ID,
            exactMatch: true,
            phoneMatch: true,
        }).classification,
        "EXACT_FACEBOOK_ID_MATCH"
    );
    assert.equal(
        classifyFacebookIdentityMatch({
            incomingFacebookLeadgenId: SYNTHETIC_ID,
            phoneMatch: true,
        }).classification,
        "PHONE_COLLISION_REVIEW"
    );
});

test("repeat-submission event identity is deterministic and idempotent", () => {
    const first = buildFacebookRepeatSubmissionEvent({
        leadId: "LEAD-SYNTHETIC",
        facebookLeadgenId: SYNTHETIC_ID,
        sourceCreatedTime: "2026-09-01T00:00:00+07:00",
        primaryFacebookLeadgenId: SYNTHETIC_ID_2,
    });
    const retry = buildFacebookRepeatSubmissionEvent({
        leadId: "LEAD-SYNTHETIC",
        facebookLeadgenId: SYNTHETIC_ID,
        sourceCreatedTime: "2026-09-01T00:00:00+07:00",
        primaryFacebookLeadgenId: SYNTHETIC_ID_2,
    });

    assert.deepEqual(first, retry);
    assert.equal(first.action_type, "Facebook Repeat Submission");
    assert.equal(first.new_value, SYNTHETIC_ID);
    assert.equal(first.activity_id, deterministicRepeatSubmissionId("LEAD-SYNTHETIC", SYNTHETIC_ID));

    const firstAttempt = dedupeRepeatSubmissionEvents([], [first, first]);
    assert.equal(firstAttempt.pendingEvents.length, 1);
    assert.equal(firstAttempt.skippedExisting, 1);

    const retryDedupe = dedupeRepeatSubmissionEvents([first.activity_id], [first]);
    assert.equal(retryDedupe.pendingEvents.length, 0);
    assert.equal(retryDedupe.skippedExisting, 1);
});

test("recovery allowlist is exact, bounded, and dry-run performs no write", async () => {
    assert.deepEqual(validateRecoveryAllowlist([SYNTHETIC_ID, SYNTHETIC_ID_2]), [SYNTHETIC_ID, SYNTHETIC_ID_2]);
    assert.throws(() => validateRecoveryAllowlist([SYNTHETIC_ID, SYNTHETIC_ID]), /duplicate/);
    assert.throws(() => validateRecoveryAllowlist([12345678901234567]), /must be text/);

    const plan = buildRecoveryPlan({
        ids: [SYNTHETIC_ID, SYNTHETIC_ID_2],
        sourceRecords: [{ id: SYNTHETIC_ID }, { id: SYNTHETIC_ID_2 }],
    });
    assert.equal(plan.expected_safe_count, 2);
    assertPlanWithinAllowlist(plan);
    assert.throws(() => assertPlanWithinAllowlist({
        ...plan,
        items: [...plan.items, {
            facebook_leadgen_id: "32345678901234567",
            classification: "SAFE_INSERT_NEW",
            intended_action: "INSERT",
        }],
    }), /outside its allowlist/);

    let writes = 0;
    const result = await applyRecoveryPlan({
        plan,
        dryRun: true,
        write: async () => { writes++; },
        reconcile: async () => new Set(),
    });
    assert.equal(result.status, "DRY_RUN");
    assert.equal(writes, 0);
});

test("recovery plan classifies phone collisions and partial writes", async () => {
    const plan = buildRecoveryPlan({
        ids: [SYNTHETIC_ID],
        sourceRecords: [{ id: SYNTHETIC_ID }],
        phoneCollisionIds: [SYNTHETIC_ID],
    });
    assert.equal(plan.items[0].classification, "PHONE_COLLISION_REVIEW");
    assert.equal(plan.expected_safe_count, 0);

    const insertPlan = buildRecoveryPlan({
        ids: [SYNTHETIC_ID],
        sourceRecords: [{ id: SYNTHETIC_ID }],
    });
    const result = await applyRecoveryPlan({
        plan: insertPlan,
        dryRun: false,
        write: async items => items,
        reconcile: async () => new Set(),
    });
    assert.equal(result.status, PARTIAL_FAILURE_RECONCILIATION_REQUIRED);
    assert.deepEqual(result.uncertain_ids, [SYNTHETIC_ID]);
});

const LEAD_HEADERS = [
    "lead_id", "customer_name", "phone", "source", "customer_type", "province", "zone",
    "preferred_call_day", "preferred_call_time", "lead_form_name", "ad_name", "adset_name",
    "campaign_name", "facebook_created_time", "lead_status", "sales_owner", "created_at", "updated_at",
];
const DETAIL_HEADERS = [
    "lead_id", "facebook_leadgen_id", "raw_phone", "raw_province", "form_id", "ad_id", "adset_id",
    "campaign_id", "facebook_created_time", "is_organic", "platform", "inbox_url",
    "original_customer_name", "created_source",
];
const DEAL_HEADERS = [
    "deal_id", "lead_id", "phone", "product_model", "package_type", "price", "full_amount",
    "payment_status", "payment_date",
];
const ACTIVITY_HEADERS = [
    "activity_id", "lead_id", "sheet_name", "action_type", "old_value", "new_value",
    "lead_status", "note", "created_by", "created_at",
];

function columnNumber(column) {
    return column.split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function parseA1Range(range) {
    const [sheetName, address] = range.split("!");
    const match = address.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    if (!match) {
        const fullMatch = address.match(/^([A-Z]+):([A-Z]+)$/);
        if (!fullMatch) throw new Error(`Unsupported fake range: ${range}`);
        return {
            sheetName,
            startColumn: columnNumber(fullMatch[1]),
            endColumn: columnNumber(fullMatch[2]),
            startRow: 1,
            endRow: Number.MAX_SAFE_INTEGER,
        };
    }
    return {
        sheetName,
        startColumn: columnNumber(match[1]),
        endColumn: columnNumber(match[3] || match[1]),
        startRow: Number(match[2]),
        endRow: Number(match[4] || match[2]),
    };
}

function createFakeWorkbook({ failRawWrites = 0, failReadbackOnce = false, failDependentWrites = 0 } = {}) {
    const workbook = {
        LEADS_MAIN: [LEAD_HEADERS, [], []],
        LEAD_DETAILS: [DETAIL_HEADERS, [], []],
        DEALS: [DEAL_HEADERS, [], []],
        ACTIVITY_LOG: [ACTIVITY_HEADERS, [], []],
    };
    const counters = { rawWrites: 0, allWrites: 0, readbacksFailed: 0 };

    const values = {
        get: async ({ range }) => {
            const parsed = parseA1Range(range);
            if (
                failReadbackOnce
                && parsed.sheetName === "LEAD_DETAILS"
                && parsed.startRow >= 3
                && parsed.startRow === parsed.endRow
                && counters.readbacksFailed === 0
            ) {
                counters.readbacksFailed++;
                throw new Error("synthetic readback failure");
            }

            const rows = workbook[parsed.sheetName] || [];
            const endRow = Math.min(parsed.endRow, rows.length);
            const output = [];
            for (let rowNumber = parsed.startRow; rowNumber <= endRow; rowNumber++) {
                const source = rows[rowNumber - 1] || [];
                output.push(source.slice(parsed.startColumn - 1, parsed.endColumn));
            }
            return { data: { values: output } };
        },
        update: async ({ range, requestBody }) => {
            applyFakeData(range, requestBody.values || [], "USER_ENTERED");
        },
        batchUpdate: async ({ requestBody }) => {
            const option = requestBody.valueInputOption || "USER_ENTERED";
            counters.allWrites++;
            if (option === "RAW") {
                counters.rawWrites++;
                if (failRawWrites > 0) {
                    failRawWrites--;
                    throw new Error("synthetic RAW write failure");
                }
            } else if (failDependentWrites > 0 && counters.allWrites > 2) {
                failDependentWrites--;
                throw new Error("synthetic dependent write failure");
            }
            for (const item of requestBody.data || []) {
                applyFakeData(item.range, item.values || [], option);
            }
        },
    };

    function applyFakeData(range, valuesToWrite, option) {
        const parsed = parseA1Range(range);
        const rows = workbook[parsed.sheetName];
        for (let rowOffset = 0; rowOffset < valuesToWrite.length; rowOffset++) {
            const rowNumber = parsed.startRow + rowOffset;
            while (rows.length < rowNumber) rows.push([]);
            const row = rows[rowNumber - 1];
            const sourceValues = valuesToWrite[rowOffset] || [];
            for (let columnOffset = 0; columnOffset < sourceValues.length; columnOffset++) {
                row[parsed.startColumn - 1 + columnOffset] = sourceValues[columnOffset];
            }
        }
    }

    return {
        workbook,
        counters,
        sheets: {
            spreadsheets: {
                values,
            },
        },
    };
}

function syntheticFacebookLead() {
    return {
        facebook_leadgen_id: SYNTHETIC_ID,
        name: "Synthetic Customer",
        phone: "0812345678",
        source: "Facebook",
        status: "New",
        facebook_created_time: "2026-09-01T00:00:00+07:00",
    };
}

async function runSyntheticBatch(fake, lead = syntheticFacebookLead()) {
    return appendLeadsToSheetBatchWithClient([lead], {
        sheets: fake.sheets,
        spreadsheetId: "synthetic-sheet",
    });
}

function dataRows(fake, sheetName) {
    return fake.workbook[sheetName].slice(2).filter(row => row.some(Boolean));
}

test("integration: new Facebook ingestion reaches complete state", async () => {
    const fake = createFakeWorkbook();
    const result = await runSyntheticBatch(fake);

    assert.equal(result.created, 1);
    assert.equal(result.repaired_existing, 0);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);
    assert.equal(fake.workbook.LEAD_DETAILS[2][1], SYNTHETIC_ID);
});

test("integration: RAW identity failure is retryable without partial dependent rows", async () => {
    const fake = createFakeWorkbook({ failRawWrites: 1 });
    await assert.rejects(runSyntheticBatch(fake), /synthetic RAW write failure/);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 0);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 0);
    assert.equal(dataRows(fake, "DEALS").length, 0);

    const result = await runSyntheticBatch(fake);
    assert.equal(result.created, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);
});

test("integration: readback failure leaves an exact anchor and retry repairs missing dependents", async () => {
    const fake = createFakeWorkbook({ failReadbackOnce: true });
    await assert.rejects(runSyntheticBatch(fake), /synthetic readback failure/);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 0);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 0);
    assert.equal(fake.workbook.LEAD_DETAILS[2][1], SYNTHETIC_ID);

    const result = await runSyntheticBatch(fake);
    assert.equal(result.repaired_existing, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);

    const complete = await runSyntheticBatch(fake);
    assert.equal(complete.skipped_existing, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);
});

test("integration: dependent write failure after identity anchor is resumable", async () => {
    const fake = createFakeWorkbook({ failDependentWrites: 1 });
    await assert.rejects(runSyntheticBatch(fake), /synthetic dependent write failure/);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 0);
    assert.equal(dataRows(fake, "DEALS").length, 0);

    const result = await runSyntheticBatch(fake);
    assert.equal(result.repaired_existing, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);
});

test("integration: exact-ID partial state repairs only the missing Lead", async () => {
    const fake = createFakeWorkbook();
    fake.workbook.LEAD_DETAILS[2] = ["LEAD-PARTIAL", SYNTHETIC_ID, "0812345678"];
    const result = await runSyntheticBatch(fake);

    assert.equal(result.repaired_existing, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
});

test("integration: exact-ID partial state repairs only the missing Deal", async () => {
    const fake = createFakeWorkbook();
    fake.workbook.LEADS_MAIN[2] = ["LEAD-PARTIAL", "Synthetic Customer", "0812345678", "Facebook", "", "", "", "", "", "", "", "", "", "", "New"];
    fake.workbook.LEAD_DETAILS[2] = ["LEAD-PARTIAL", SYNTHETIC_ID, "0812345678", "", "", "", "", "", "", "", "", "", "Synthetic Customer", "Facebook"];
    const result = await runSyntheticBatch(fake);

    assert.equal(result.repaired_existing, 1);
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 1);
    assert.equal(dataRows(fake, "DEALS").length, 1);
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
});

test("integration: duplicate exact Facebook IDs fail closed", async () => {
    const fake = createFakeWorkbook();
    fake.workbook.LEAD_DETAILS[2] = ["LEAD-1", SYNTHETIC_ID, "0812345678"];
    fake.workbook.LEAD_DETAILS.push(["LEAD-2", SYNTHETIC_ID, "0812345678"]);
    const result = await runSyntheticBatch(fake);

    assert.equal(result.ambiguous_stop, 1);
    assert.equal(result.ambiguous_items[0].reason, "duplicate_exact_facebook_id");
    assert.equal(dataRows(fake, "LEADS_MAIN").length, 0);
    assert.equal(dataRows(fake, "DEALS").length, 0);
});

test("integration: Facebook LEAD_DETAILS retry reuses the exact row", async () => {
    const fake = createFakeWorkbook({ failReadbackOnce: true });
    const detail = {
        lead_id: "LEAD-GENERIC",
        facebook_leadgen_id: SYNTHETIC_ID,
        raw_phone: "0812345678",
    };
    await assert.rejects(
        appendObjectsWithClient("LEAD_DETAILS", [detail], {}, {
            sheets: fake.sheets,
            spreadsheetId: "synthetic-sheet",
        }),
        /synthetic readback failure/
    );
    await appendObjectsWithClient("LEAD_DETAILS", [detail], {}, {
        sheets: fake.sheets,
        spreadsheetId: "synthetic-sheet",
    });
    assert.equal(dataRows(fake, "LEAD_DETAILS").length, 1);
});

test("integration: a genuinely different Facebook ID remains a phone collision", async () => {
    const fake = createFakeWorkbook();
    fake.workbook.LEADS_MAIN[2] = ["LEAD-PRIMARY", "Primary", "0812345678", "Facebook"];
    fake.workbook.LEAD_DETAILS[2] = ["LEAD-PRIMARY", SYNTHETIC_ID_2, "0812345678"];
    const result = await runSyntheticBatch(fake);

    assert.equal(result.phone_collision_review, 1);
    assert.equal(result.ambiguous_stop, 0);
    assert.equal(dataRows(fake, "ACTIVITY_LOG").length, 1);
    assert.equal(fake.workbook.ACTIVITY_LOG[2][5], SYNTHETIC_ID);
});

test("ACTIVITY_LOG missing required semantic header fails before append", () => {
    assert.throws(
        () => validateFacebookRepeatSubmissionActivityHeaders([
            "activity_id", "lead_id", "sheet_name", "action_type", "new_value", "created_at",
        ]),
        /missing required field\(s\)/
    );
});

test("integration: missing ACTIVITY_LOG semantic header prevents any event append", async () => {
    const fake = createFakeWorkbook();
    fake.workbook.LEADS_MAIN[2] = ["LEAD-PRIMARY", "Primary", "0812345678", "Facebook"];
    fake.workbook.LEAD_DETAILS[2] = ["LEAD-PRIMARY", SYNTHETIC_ID_2, "0812345678"];
    fake.workbook.ACTIVITY_LOG[0] = [
        "activity_id", "lead_id", "sheet_name", "action_type", "new_value", "created_at",
    ];

    await assert.rejects(runSyntheticBatch(fake), /ACTIVITY_LOG_SCHEMA_INVALID/);
    assert.equal(dataRows(fake, "ACTIVITY_LOG").length, 0);
});

test("complete ACTIVITY_LOG schema and sequential retry create one event", async () => {
    const fake = createFakeWorkbook();
    fake.workbook.LEADS_MAIN[2] = ["LEAD-PRIMARY", "Primary", "0812345678", "Facebook"];
    fake.workbook.LEAD_DETAILS[2] = ["LEAD-PRIMARY", SYNTHETIC_ID_2, "0812345678"];
    const first = await runSyntheticBatch(fake);
    assert.equal(first.phone_collision_review, 1);
    assert.equal(dataRows(fake, "ACTIVITY_LOG").length, 1);

    const second = await runSyntheticBatch(fake);
    assert.equal(second.phone_collision_review, 1);
    assert.equal(second.repeat_submission_events_created, 0);
    assert.equal(second.repeat_submission_events_skipped, 1);
    assert.equal(dataRows(fake, "ACTIVITY_LOG").length, 1);
});
