"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAudioReadOnlySheetsClient, getAudioLeadIdentityRows, readAudioLeadIdentityRowsWithClient } = require("../services/googleSheets");

test("Audio Lead client uses the read-only Sheets OAuth scope", async () => {
    let authOptions;
    let sheetsOptions;
    class GoogleAuth {
        constructor(options) { authOptions = options; }
    }
    const googleApi = {
        auth: { GoogleAuth },
        sheets(options) { sheetsOptions = options; return { spreadsheets: {} }; },
    };

    const client = await createAudioReadOnlySheetsClient({
        clientEmail: "synthetic@example.invalid",
        privateKey: "synthetic\\nprivate-key",
        spreadsheetId: "synthetic-sheet-id",
        googleApi,
    });

    assert.deepEqual(authOptions.scopes, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
    assert.equal(authOptions.credentials.private_key, "synthetic\nprivate-key");
    assert.equal(sheetsOptions.version, "v4");
    assert.ok(sheetsOptions.auth instanceof GoogleAuth);
    assert.equal(client.spreadsheetId, "synthetic-sheet-id");
});

test("audio Lead reader intersects LEADS_MAIN identity fields with canonical LEADS IDs", async () => {
    const calls = [];
    const sheets = {
        spreadsheets: {
            values: {
                async get(input) {
                    calls.push(["get", input]);
                    const values = input.range === "LEADS!1:1"
                        ? [["Lead ID", "Customer Name"]]
                        : [["Lead ID", "Customer Name", "Phone", "Additional Phone", "Mobile Phone"]];
                    return { data: { values } };
                },
                async batchGet(input) {
                    calls.push(["batchGet", input]);
                    return { data: { valueRanges: [
                        { values: [["SYN-001"], ["SYN-002"]] },
                        { values: [["0812345678"]] },
                        { values: [[""] , ["0811111111"]] },
                        { values: [["0899999999"], ["0811111111"]] },
                        { values: [["SYN-001"], ["SYN-003"]] },
                    ] } };
                },
            },
        },
    };

    const result = await readAudioLeadIdentityRowsWithClient(sheets, "synthetic-sheet-id");

    assert.deepEqual(calls, [
        ["get", {
            spreadsheetId: "synthetic-sheet-id",
            range: "LEADS_MAIN!1:1",
            valueRenderOption: "FORMATTED_VALUE",
        }],
        ["get", {
            spreadsheetId: "synthetic-sheet-id",
            range: "LEADS!1:1",
            valueRenderOption: "FORMATTED_VALUE",
        }],
        ["batchGet", {
            spreadsheetId: "synthetic-sheet-id",
            ranges: ["LEADS_MAIN!A3:A", "LEADS_MAIN!C3:C", "LEADS_MAIN!D3:D", "LEADS_MAIN!E3:E", "LEADS!A3:A"],
            valueRenderOption: "FORMATTED_VALUE",
            majorDimension: "ROWS",
        }],
    ]);
    assert.deepEqual(result, [{ lead_id: "SYN-001", phones: ["0812345678", "0899999999"] }]);
});

test("audio Lead reader uses CRM4-specific identity and workbook binding", async () => {
    let authOptions;
    let sheetsOptions;
    let requestedSpreadsheetId;
    class GoogleAuth { constructor(options) { authOptions = options; } }
    const googleApi = {
        auth: { GoogleAuth },
        sheets(options) {
            sheetsOptions = options;
            return { spreadsheets: { values: {
                async get({ spreadsheetId, range }) {
                    requestedSpreadsheetId = spreadsheetId;
                    return { data: { values: [range === "LEADS!1:1" ? ["Lead ID"] : ["Lead ID", "Phone"]] } };
                },
                async batchGet({ spreadsheetId }) {
                    requestedSpreadsheetId = spreadsheetId;
                    return { data: { valueRanges: [{ values: [["SYN-001"]] }, { values: [["0812345678"]] }, { values: [["SYN-001"]] }] } };
                },
            } } };
        },
    };
    const result = await getAudioLeadIdentityRows({
        CRM4_GOOGLE_CLIENT_EMAIL: "dashboard-reader@example.invalid",
        CRM4_GOOGLE_PRIVATE_KEY: "synthetic-key",
        CRM4_SPREADSHEET_ID: "crm4-workbook",
        GOOGLE_CLIENT_EMAIL: "legacy-wrong@example.invalid",
        GOOGLE_PRIVATE_KEY: "legacy-wrong-key",
        GOOGLE_SHEET_ID: "legacy-wrong-workbook",
    }, googleApi);
    assert.deepEqual(result, [{ lead_id: "SYN-001", phones: ["0812345678"] }]);
    assert.equal(authOptions.credentials.client_email, "dashboard-reader@example.invalid");
    assert.equal(requestedSpreadsheetId, "crm4-workbook");
    assert.ok(sheetsOptions.auth instanceof GoogleAuth);
    assert.deepEqual(authOptions.scopes, ["https://www.googleapis.com/auth/spreadsheets.readonly"]);
});

test("audio Lead reader fails closed on a missing or duplicate Lead ID header", async () => {
    let dataReads = 0;
    const sheets = { spreadsheets: { values: {
        async get() { return { data: { values: [["Lead ID", "lead_id", "Phone"]] } }; },
        async batchGet() { dataReads++; return { data: { valueRanges: [] } }; },
    } } };

    await assert.rejects(readAudioLeadIdentityRowsWithClient(sheets, "synthetic-sheet-id"), /missing or ambiguous/);
    assert.equal(dataReads, 0);
});
