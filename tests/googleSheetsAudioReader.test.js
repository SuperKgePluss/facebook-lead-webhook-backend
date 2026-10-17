"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readAudioLeadIdentityRowsWithClient } = require("../services/googleSheets");

test("audio Lead reader fetches only the ID and phone columns as formatted strings", async () => {
    const calls = [];
    const sheets = {
        spreadsheets: {
            values: {
                async get(input) {
                    calls.push(["get", input]);
                    return { data: { values: [["Lead ID", "Customer Name", "Phone", "Additional Phone", "Mobile Phone"]] } };
                },
                async batchGet(input) {
                    calls.push(["batchGet", input]);
                    return { data: { valueRanges: [
                        { values: [["SYN-001"], ["SYN-002"]] },
                        { values: [["0812345678"]] },
                        { values: [[""] , ["0811111111"]] },
                        { values: [["0899999999"], ["0811111111"]] },
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
        ["batchGet", {
            spreadsheetId: "synthetic-sheet-id",
            ranges: ["LEADS_MAIN!A3:A", "LEADS_MAIN!C3:C", "LEADS_MAIN!D3:D", "LEADS_MAIN!E3:E"],
            valueRenderOption: "FORMATTED_VALUE",
            majorDimension: "ROWS",
        }],
    ]);
    assert.deepEqual(result, [
        { lead_id: "SYN-001", phones: ["0812345678", "0899999999"] },
        { lead_id: "SYN-002", phones: ["0811111111", "0811111111"] },
    ]);
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
