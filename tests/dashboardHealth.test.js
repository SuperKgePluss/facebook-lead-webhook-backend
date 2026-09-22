"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");
const { normalizeHeaderName } = require("../services/googleSheets");
const {
    SOURCE_PRESENCE_FIELDS,
    readDashboardLeadParity,
    shapeDashboardHealthResponse,
} = require("../services/dashboardHealthReader");
const { createDashboardPasswordHash } = require("../services/dashboardAuth");
const { createDashboardRouter } = require("../services/dashboardRouter");

const SOURCE_HEADERS = [
    "Lead ID",
    "Customer Name",
    "Full Name",
    "Name",
    "Phone",
    "Facebook Created Time",
    "Created At",
    "Lead Status",
    "Preferred Call Day",
    "Preferred Call Time",
    "Sales Owner",
    "Internal Notes",
];
const TARGET_HEADERS = ["Lead ID", "Unprojected Customer Data"];
const TEST_ORIGIN = "https://dashboard.example.test";
const TEST_SESSION_ID = "s".repeat(43);
const TEST_PASSWORD_HASH_PROMISE = createDashboardPasswordHash(
    "synthetic-dashboard-password",
    Buffer.from("synthetic-salt-value", "utf8")
);

function columnNumber(letters) {
    return [...letters].reduce((number, character) => (
        number * 26 + character.charCodeAt(0) - 64
    ), 0);
}

function readFixture({ sourceHeaders = SOURCE_HEADERS, targetHeaders = TARGET_HEADERS, sourceRows = [], targetRows = [], failRange } = {}) {
    const ranges = [];
    const tables = {
        LEADS_MAIN: { headers: sourceHeaders, rows: sourceRows },
        LEADS: { headers: targetHeaders, rows: targetRows },
    };

    async function fakeReadSheet(_sheets, _spreadsheetId, range) {
        ranges.push(range);
        if (range === failRange) throw new Error("synthetic private read failure");

        const headerMatch = /^(LEADS_MAIN|LEADS)!1:1$/.exec(range);
        if (headerMatch) return [tables[headerMatch[1]].headers];

        const dataMatch = /^(LEADS_MAIN|LEADS)!([A-Z]+)3:\2$/.exec(range);
        if (!dataMatch) throw new Error("unexpected projection range");
        const [, sheetName, columnLetters] = dataMatch;
        const table = tables[sheetName];
        const field = normalizeHeaderName(table.headers[columnNumber(columnLetters) - 1]);
        const values = table.rows.map(row => row[field] === undefined ? "" : row[field]);
        let lastNonblank = values.length - 1;
        while (lastNonblank >= 0 && (values[lastNonblank] === "" || values[lastNonblank] === null)) {
            lastNonblank--;
        }
        // Google Sheets omits trailing empty cells and represents interior blanks as empty rows.
        return values.slice(0, lastNonblank + 1).map(value => (
            value === "" || value === null ? [] : [value]
        ));
    }

    return {
        ranges,
        async read() {
            return readDashboardLeadParity({
                createSheetsClient: async () => ({ sheets: {}, spreadsheetId: "synthetic-sheet" }),
                readSheet: fakeReadSheet,
            });
        },
    };
}

async function startApp(healthReader) {
    const env = {
        NODE_ENV: "test",
        DASHBOARD_ORIGIN: TEST_ORIGIN,
        DASHBOARD_AUTH_USERNAME: "synthetic-manager",
        DASHBOARD_AUTH_PASSWORD_HASH: await TEST_PASSWORD_HASH_PROMISE,
    };
    const sessions = new Map([[TEST_SESSION_ID, { expiresAt: Date.now() + 60_000 }]]);
    const app = express();
    app.use("/api", createDashboardRouter({ env, sessions, healthReader }));
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    return {
        url: `http://127.0.0.1:${address.port}`,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

async function request(app, { authenticated = false } = {}) {
    const headers = { Origin: TEST_ORIGIN };
    if (authenticated) headers.Cookie = `bo_dashboard_session=${TEST_SESSION_ID}`;
    const response = await fetch(`${app.url}/api/dashboard/health`, { headers });
    return { response, body: await response.json() };
}

async function withApp(healthReader, callback) {
    const app = await startApp(healthReader);
    try {
        return await callback(app);
    } finally {
        await app.close();
    }
}

test("zero-gap snapshot is healthy and reads only row-1 headers plus row-3 projections", async () => {
    const fixture = readFixture({
        sourceRows: [{ lead_id: "SYN-1", customer_name: "private synthetic customer" }],
        targetRows: [{ lead_id: "SYN-1", unprojected_customer_data: "not read" }],
    });
    const snapshot = await fixture.read();
    const response = shapeDashboardHealthResponse(snapshot);

    assert.equal(response.core_to_leads.status, "HEALTHY");
    assert.deepEqual({ ...response.core_to_leads }, {
        status: "HEALTHY",
        source_count: 1,
        target_count: 1,
        missing_count: 0,
        duplicate_count: 0,
        invalid_count: 0,
    });
    assert.equal(fixture.ranges[0], "LEADS_MAIN!1:1");
    assert.equal(fixture.ranges[1], "LEADS!1:1");
    assert.ok(fixture.ranges.slice(2).every(range => /!([A-Z]+)3:\1$/.test(range)));
    assert.ok(fixture.ranges.every(range => !/!2:|!A:ZZ|!A3:ZZ/i.test(range)));
    assert.ok(!fixture.ranges.includes("LEADS!C3:C"));
});

test("source IDs missing from LEADS produce WARNING counts only", async () => {
    const fixture = readFixture({
        sourceRows: [{ lead_id: "SYN-1" }, { lead_id: "SYN-2" }],
        targetRows: [{ lead_id: "SYN-1" }],
    });
    const response = shapeDashboardHealthResponse(await fixture.read());

    assert.equal(response.core_to_leads.status, "WARNING");
    assert.equal(response.core_to_leads.missing_count, 1);
    assert.equal(JSON.stringify(response).includes("SYN-2"), false);
});

test("repeated source IDs are deduplicated for source and missing counts", async () => {
    const fixture = readFixture({
        sourceRows: [{ lead_id: "SYN-1" }, { lead_id: "SYN-1" }],
        targetRows: [{ lead_id: "SYN-1" }],
    });
    const snapshot = await fixture.read();

    assert.equal(snapshot.source_count, 1);
    assert.equal(snapshot.target_count, 1);
    assert.equal(snapshot.missing_count, 0);
});

test("duplicate target IDs are counted by distinct duplicated ID", async () => {
    const fixture = readFixture({
        sourceRows: [{ lead_id: "SYN-1" }],
        targetRows: [{ lead_id: "SYN-1" }, { lead_id: "SYN-1" }, { lead_id: "SYN-1" }],
    });
    const response = shapeDashboardHealthResponse(await fixture.read());

    assert.equal(response.core_to_leads.status, "WARNING");
    assert.equal(response.core_to_leads.target_count, 1);
    assert.equal(response.core_to_leads.duplicate_count, 1);
});

test("each Apps Script presence field independently classifies a blank-ID row as invalid", async () => {
    for (const field of SOURCE_PRESENCE_FIELDS) {
        const fixture = readFixture({ sourceRows: [{ lead_id: "", [field]: "synthetic-present" }] });
        const snapshot = await fixture.read();
        assert.equal(snapshot.invalid_count, 1, field);
        assert.equal(snapshot.source_count, 0, field);
    }
});

test("blank, whitespace-only, and label-like rows are ignored while a nonblank ID is valid", async () => {
    const fixture = readFixture({
        sourceRows: [
            { lead_id: "", customer_name: "", phone: "   " },
            { lead_id: "  ", customer_name: "   ", phone: "" },
            { lead_id: "SYN-VALID", customer_name: "" },
        ],
        targetRows: [{ lead_id: "SYN-VALID" }],
    });
    const snapshot = await fixture.read();

    assert.equal(snapshot.source_count, 1);
    assert.equal(snapshot.invalid_count, 0);
    assert.ok(fixture.ranges.every(range => !range.includes("2")));
});

test("Apps Script falsey Lead ID values normalize as blank", async () => {
    const fixture = readFixture({
        sourceRows: [{ lead_id: 0, customer_name: "synthetic name" }],
    });
    const snapshot = await fixture.read();

    assert.equal(snapshot.source_count, 0);
    assert.equal(snapshot.invalid_count, 1);
});

test("duplicate normalized required headers fail closed without selecting a column", async () => {
    const fixture = readFixture({
        sourceHeaders: [...SOURCE_HEADERS, "Lead-ID"],
        sourceRows: [{ lead_id: "SYN-1" }],
    });

    assert.equal(await fixture.read(), null);
    assert.deepEqual(fixture.ranges, ["LEADS_MAIN!1:1", "LEADS!1:1"]);
});

test("duplicate optional classifier headers also fail closed", async () => {
    const fixture = readFixture({
        sourceHeaders: [...SOURCE_HEADERS, "Customer_Name"],
        sourceRows: [{ lead_id: "SYN-1" }],
    });

    assert.equal(await fixture.read(), null);
});

test("missing required Lead ID headers fail closed", async () => {
    const fixture = readFixture({
        sourceHeaders: SOURCE_HEADERS.filter(header => header !== "Lead ID"),
    });

    assert.equal(await fixture.read(), null);
});

test("missing or duplicated target Lead ID headers fail closed", async () => {
    const missing = readFixture({ targetHeaders: ["Unprojected Customer Data"] });
    const duplicate = readFixture({ targetHeaders: ["Lead ID", "lead_id"] });

    assert.equal(await missing.read(), null);
    assert.equal(await duplicate.read(), null);
});

test("unreadable or incomplete projection returns UNKNOWN instead of zero counts", async () => {
    const fixture = readFixture({
        sourceRows: [{ lead_id: "SYN-1" }],
        failRange: "LEADS_MAIN!B3:B",
    });
    const response = shapeDashboardHealthResponse(await fixture.read());

    assert.equal(response.core_to_leads.status, "UNKNOWN");
    for (const field of ["source_count", "target_count", "missing_count", "duplicate_count", "invalid_count"]) {
        assert.equal(response.core_to_leads[field], null);
    }
});

test("health response strips raw identifiers, names, phones, notes, and URLs", async () => {
    const fixture = readFixture({
        sourceRows: [{
            lead_id: "SYNTHETIC_PRIVATE_ID",
            customer_name: "SYNTHETIC_PRIVATE_NAME",
            phone: "SYNTHETIC_PRIVATE_PHONE",
            name: "SYNTHETIC_PRIVATE_PERSON",
        }],
        targetRows: [],
    });
    const response = shapeDashboardHealthResponse(await fixture.read());
    const serialized = JSON.stringify(response);

    for (const privateValue of [
        "SYNTHETIC_PRIVATE_ID",
        "SYNTHETIC_PRIVATE_NAME",
        "SYNTHETIC_PRIVATE_PHONE",
        "SYNTHETIC_PRIVATE_PERSON",
        "phone",
        "customer_name",
        "notes",
        "https://",
    ]) {
        assert.equal(serialized.includes(privateValue), false, privateValue);
    }
});

test("unavailable Facebook and freshness signals remain UNKNOWN and unavailable dates stay null", () => {
    const response = shapeDashboardHealthResponse({
        complete: true,
        source_count: 0,
        target_count: 0,
        missing_count: 0,
        duplicate_count: 0,
        invalid_count: 0,
        last_updated: "must-not-be-used",
    });

    assert.deepEqual(response.facebook_sync, { status: "UNKNOWN" });
    assert.equal(response.last_facebook_sync, null);
    assert.deepEqual(response.materializer_execution, { status: "UNKNOWN" });
    assert.deepEqual(response.crm_core_freshness, { status: "UNKNOWN" });
    assert.equal(response.last_crm_update, null);
});

test("authenticated health endpoint serves the privacy-shaped contract", async () => {
    let calls = 0;
    await withApp(async () => {
        calls++;
        return {
            complete: true,
            source_count: 1,
            target_count: 1,
            missing_count: 0,
            duplicate_count: 0,
            invalid_count: 0,
            lead_id: "SYNTHETIC_PRIVATE_ID",
            phone: "SYNTHETIC_PRIVATE_PHONE",
            url: "https://private.invalid/synthetic",
        };
    }, async app => {
        const unauthorized = await request(app);
        assert.equal(unauthorized.response.status, 401);
        assert.equal(calls, 0);

        const result = await request(app, { authenticated: true });
        const serialized = JSON.stringify(result.body);
        assert.equal(result.response.status, 200);
        assert.equal(result.body.backend.status, "HEALTHY");
        assert.equal(result.body.core_to_leads.status, "HEALTHY");
        assert.deepEqual(result.body.facebook_sync, { status: "UNKNOWN" });
        assert.equal(result.body.last_facebook_sync, null);
        assert.equal(result.body.materializer_execution.status, "UNKNOWN");
        assert.equal(result.body.crm_core_freshness.status, "UNKNOWN");
        assert.equal(result.body.last_crm_update, null);
        assert.equal(calls, 1);
        assert.equal(serialized.includes("SYNTHETIC_PRIVATE"), false);
        assert.equal(serialized.includes("private.invalid"), false);
        assert.equal(serialized.includes("phone"), false);
    });
});

test("authenticated health endpoint maps reader failures to UNKNOWN without exposing details", async () => {
    await withApp(async () => { throw new Error("synthetic private spreadsheet failure"); }, async app => {
        const result = await request(app, { authenticated: true });
        const serialized = JSON.stringify(result.body);

        assert.equal(result.response.status, 200);
        assert.equal(result.body.backend.status, "HEALTHY");
        assert.equal(result.body.core_to_leads.status, "UNKNOWN");
        assert.equal(result.body.core_to_leads.source_count, null);
        assert.equal(serialized.includes("synthetic private spreadsheet failure"), false);
    });
});

test("health reader and route contain no write-helper dependency", () => {
    const readerSource = fs.readFileSync(
        path.join(__dirname, "..", "services", "dashboardHealthReader.js"),
        "utf8"
    );
    const routerSource = fs.readFileSync(
        path.join(__dirname, "..", "services", "dashboardRouter.js"),
        "utf8"
    );
    for (const source of [readerSource, routerSource]) {
        assert.doesNotMatch(source, /\b(?:appendLead\w*|appendObjects|updateObject\w*|deleteSheetRows|saveFacebookBackfillState|sync\w*|backfill\w*|repair\w*|materializ\w*)\s*\(/i);
    }
    assert.match(readerSource, /require\("\.\/googleSheets"\)/);
    assert.match(readerSource, /readSheet/);
    assert.doesNotMatch(readerSource, /console\.(?:log|error|warn)/);
});

test("invalid or inconsistent count objects fail closed", () => {
    const response = shapeDashboardHealthResponse({
        complete: true,
        source_count: 1,
        target_count: 0,
        missing_count: 2,
        duplicate_count: 0,
        invalid_count: 0,
    });

    assert.equal(response.core_to_leads.status, "UNKNOWN");
    assert.equal(response.core_to_leads.missing_count, null);
});
