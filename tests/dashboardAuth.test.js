"use strict";

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");
const { createDashboardPasswordHash } = require("../services/dashboardAuth");
const { createDashboardRouter } = require("../services/dashboardRouter");

const TEST_ORIGIN = "https://dashboard.example.test";
const TEST_USERNAME = "synthetic-manager";
const TEST_PASSWORD = `synthetic-${randomBytes(24).toString("base64url")}`;
const SESSION_COOKIE_NAME = "bo_dashboard_session";
let passwordHashPromise;

function testModel() {
    return {
        timezone: "Asia/Bangkok",
        filters: { timezone: "Asia/Bangkok", dateFrom: null, dateTo: null, salesOwner: null, leadStatus: null, source: null },
        overview: {
            leads: { total: 1, new_in_period: 1, incomplete_event_date_count: 0, by_status: { New: 1 }, by_source: { Synthetic: 1 }, by_sales_owner: { "Synthetic Owner": 1 } },
            financial: { deal_value: 100, paid: 25, outstanding: 75, open_deals: 1, payment_status_counts: { Unpaid: 1 }, deals_in_scope: 1 },
            installations: { by_status: { Scheduled: 1 }, upcoming_scheduled_count: 1, upcoming_scheduled_by_date: { "2026-06-10": 1 } },
        },
        recent_activity: Array.from({ length: 22 }, (_, index) => ({
            customer_name: `Synthetic Customer ${index}`,
            activity_type: "Synthetic Follow-up",
            sales_owner: "Synthetic Owner",
            timestamp: `2026-06-${String(22 - index).padStart(2, "0")}T03:00:00.000Z`,
            phone: "synthetic-private-phone",
            lead_id: "SYNTHETIC-LEAD-ID",
            facebook_leadgen_id: "SYNTHETIC-FACEBOOK-ID",
            note: "synthetic-private-note",
            audio_url: "https://private.invalid/synthetic-audio",
            payment_url: "https://private.invalid/synthetic-payment",
            location_url: "https://private.invalid/synthetic-location",
            drive_url: "https://private.invalid/synthetic-drive",
        })),
        warnings: [],
        raw_rows: [{ phone: "synthetic-private-phone" }],
        internal_secret: "synthetic-not-for-response",
    };
}

async function configuredEnv(overrides = {}) {
    if (!passwordHashPromise) {
        passwordHashPromise = createDashboardPasswordHash(
            TEST_PASSWORD,
            Buffer.from("synthetic-salt-value-01", "utf8")
        );
    }
    return {
        NODE_ENV: "test",
        DASHBOARD_ORIGIN: TEST_ORIGIN,
        DASHBOARD_AUTH_USERNAME: TEST_USERNAME,
        DASHBOARD_AUTH_PASSWORD_HASH: await passwordHashPromise,
        ...overrides,
    };
}

async function startApp({ env, dataProvider, now, loginRateLimitMax } = {}) {
    const effectiveEnv = env || await configuredEnv(
        loginRateLimitMax === undefined ? {} : { DASHBOARD_RATE_LIMIT_MAX: String(loginRateLimitMax) }
    );
    const providerCalls = [];
    const provider = dataProvider || (async input => {
        providerCalls.push(input);
        return testModel();
    });
    const app = express();
    app.use(express.json());
    app.use("/api", createDashboardRouter({ env: effectiveEnv, dataProvider: provider, now }));

    // Stand-ins verify that unrelated and operational routes continue through the router mount.
    app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));
    app.get("/api/sync/status", (req, res) => res.status(200).json({ status: "untouched" }));
    app.use((req, res) => res.status(404).json({ error: "not_found" }));

    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    return {
        url: `http://127.0.0.1:${address.port}`,
        providerCalls,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

async function request(app, requestPath, { method = "GET", body, origin = TEST_ORIGIN, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (origin !== null) requestHeaders.Origin = origin;
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";

    const response = await fetch(`${app.url}${requestPath}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsedBody = null;
    if (text) {
        try {
            parsedBody = JSON.parse(text);
        } catch {
            parsedBody = text;
        }
    }
    return { response, body: parsedBody };
}

async function withApp(options, callback) {
    const app = await startApp(options);
    try {
        return await callback(app);
    } finally {
        await app.close();
    }
}

async function login(app, credentials = { username: TEST_USERNAME, password: TEST_PASSWORD }) {
    return request(app, "/api/auth/login", { method: "POST", body: credentials });
}

function cookiePair(response) {
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie, "expected a Set-Cookie response");
    return cookie.split(";", 1)[0];
}

test("missing auth configuration fails closed without preventing backend route initialization", async () => {
    await withApp({ env: { NODE_ENV: "test" } }, async app => {
        const health = await request(app, "/health", { origin: null });
        const loginResponse = await login(app);
        const overview = await request(app, "/api/dashboard/overview");

        assert.equal(health.response.status, 200);
        assert.equal(loginResponse.response.status, 503);
        assert.equal(loginResponse.body.error, "dashboard_not_configured");
        assert.equal(overview.response.status, 503);
        assert.equal(overview.body.error, "dashboard_not_configured");
    });
});

test("wrong username and wrong password receive the same generic login response", async () => {
    await withApp({}, async app => {
        const wrongUser = await login(app, { username: "other-synthetic-user", password: TEST_PASSWORD });
        const wrongPassword = await login(app, { username: TEST_USERNAME, password: "wrong-synthetic-password" });

        assert.equal(wrongUser.response.status, 401);
        assert.deepEqual(wrongUser.body, { error: "invalid_credentials" });
        assert.deepEqual(wrongPassword.body, wrongUser.body);
    });
});

test("successful login creates an opaque server-side session and exposes no credential material", async () => {
    await withApp({}, async app => {
        const result = await login(app);
        const cookie = result.response.headers.get("set-cookie");

        assert.equal(result.response.status, 200);
        assert.deepEqual(result.body, { authenticated: true });
        assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
        assert.equal(JSON.stringify(result.body).includes(TEST_PASSWORD), false);
        assert.equal(cookie.includes(TEST_PASSWORD), false);
        assert.equal(cookie.includes("scrypt$"), false);
    });
});

test("session cookie is HttpOnly, host-only, and uses the configured SameSite policy", async () => {
    await withApp({ env: await configuredEnv({ DASHBOARD_COOKIE_SAMESITE: "Strict" }) }, async app => {
        const result = await login(app);
        const cookie = result.response.headers.get("set-cookie");

        assert.match(cookie, /; HttpOnly(?:;|$)/);
        assert.match(cookie, /; SameSite=Strict(?:;|$)/);
        assert.match(cookie, /; Path=\/(?:;|$)/);
        assert.doesNotMatch(cookie, /; Domain=/i);
    });
});

test("Production session cookie is Secure", async () => {
    await withApp({ env: await configuredEnv({ NODE_ENV: "production" }) }, async app => {
        const result = await login(app);
        assert.match(result.response.headers.get("set-cookie"), /; Secure(?:;|$)/);
    });
});

test("HTTPS dashboard origins use Secure cookies even outside Production", async () => {
    await withApp({}, async app => {
        const result = await login(app);
        assert.match(result.response.headers.get("set-cookie"), /; Secure(?:;|$)/);
    });
});

test("SameSite=None cookies are Secure even outside Production", async () => {
    await withApp({ env: await configuredEnv({ DASHBOARD_COOKIE_SAMESITE: "None" }) }, async app => {
        const result = await login(app);
        const cookie = result.response.headers.get("set-cookie");
        assert.match(cookie, /; SameSite=None(?:;|$)/);
        assert.match(cookie, /; Secure(?:;|$)/);
    });
});

test("session endpoint recognizes the valid server-side session", async () => {
    await withApp({}, async app => {
        const loginResult = await login(app);
        const session = await request(app, "/api/auth/session", {
            headers: { Cookie: cookiePair(loginResult.response) },
        });

        assert.equal(session.response.status, 200);
        assert.deepEqual(session.body, { authenticated: true });
    });
});

test("expired sessions are rejected and removed from server-side storage", async () => {
    let currentTime = 1_000;
    await withApp({ env: await configuredEnv({ DASHBOARD_SESSION_TTL_SECONDS: "60" }), now: () => currentTime }, async app => {
        const loginResult = await login(app);
        currentTime += 60_000;
        const session = await request(app, "/api/auth/session", {
            headers: { Cookie: cookiePair(loginResult.response) },
        });

        assert.equal(session.response.status, 401);
        assert.deepEqual(session.body, { error: "unauthorized" });
    });
});

test("a fresh process-local session store invalidates sessions after restart", async () => {
    const env = await configuredEnv();
    const firstProcess = await startApp({ env });
    let oldCookie;
    try {
        const loginResult = await login(firstProcess);
        oldCookie = cookiePair(loginResult.response);
    } finally {
        await firstProcess.close();
    }

    await withApp({ env }, async restartedProcess => {
        const session = await request(restartedProcess, "/api/auth/session", {
            headers: { Cookie: oldCookie },
        });
        assert.equal(session.response.status, 401);
        assert.deepEqual(session.body, { error: "unauthorized" });
    });
});

test("logout invalidates the server-side session and clears the cookie", async () => {
    await withApp({}, async app => {
        const loginResult = await login(app);
        const oldCookie = cookiePair(loginResult.response);
        const logout = await request(app, "/api/auth/logout", {
            method: "POST",
            headers: { Cookie: oldCookie },
        });
        const session = await request(app, "/api/auth/session", { headers: { Cookie: oldCookie } });
        const clearCookie = logout.response.headers.get("set-cookie");

        assert.equal(logout.response.status, 200);
        assert.deepEqual(logout.body, { authenticated: false });
        assert.match(clearCookie, /Max-Age=0/);
        assert.match(clearCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
        assert.match(clearCookie, /HttpOnly/);
        assert.equal(session.response.status, 401);
    });
});

test("login limiter returns 429 after the configured threshold", async () => {
    await withApp({ loginRateLimitMax: 2 }, async app => {
        await login(app, { username: "wrong", password: "synthetic-wrong" });
        await login(app, { username: "wrong", password: "synthetic-wrong" });
        const limited = await login(app, { username: "wrong", password: "synthetic-wrong" });

        assert.equal(limited.response.status, 429);
        assert.deepEqual(limited.body, { error: "rate_limited" });
        assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
    });
});

test("allowed origin receives exact credentialed CORS headers", async () => {
    await withApp({}, async app => {
        const result = await login(app, { username: "wrong", password: "synthetic-wrong" });
        assert.equal(result.response.headers.get("access-control-allow-origin"), TEST_ORIGIN);
        assert.equal(result.response.headers.get("access-control-allow-credentials"), "true");
    });
});

test("unapproved origin is rejected and receives no CORS permission", async () => {
    await withApp({}, async app => {
        const result = await request(app, "/api/auth/login", {
            method: "POST",
            origin: "https://unapproved.example.test",
            body: { username: TEST_USERNAME, password: TEST_PASSWORD },
        });
        assert.equal(result.response.status, 403);
        assert.deepEqual(result.body, { error: "origin_not_allowed" });
        assert.equal(result.response.headers.get("access-control-allow-origin"), null);
    });
});

test("credentialed CORS never uses a wildcard origin", async () => {
    await withApp({}, async app => {
        const result = await request(app, "/api/auth/session");
        assert.equal(result.response.headers.get("access-control-allow-credentials"), "true");
        assert.notEqual(result.response.headers.get("access-control-allow-origin"), "*");
    });
});

test("dashboard preflight is handled only on the declared route", async () => {
    await withApp({}, async app => {
        const preflightResult = await request(app, "/api/dashboard/activity", {
            method: "OPTIONS",
            headers: {
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "content-type",
            },
        });
        const operational = await request(app, "/api/sync/status", { origin: "https://unapproved.example.test" });

        assert.equal(preflightResult.response.status, 204);
        assert.equal(preflightResult.response.headers.get("access-control-allow-origin"), TEST_ORIGIN);
        assert.equal(preflightResult.response.headers.get("access-control-allow-credentials"), "true");
        assert.equal(operational.response.status, 200);
        assert.deepEqual(operational.body, { status: "untouched" });
        assert.equal(operational.response.headers.get("access-control-allow-origin"), null);
    });
});

test("POST authentication routes require the exact configured Origin", async () => {
    await withApp({}, async app => {
        const result = await request(app, "/api/auth/login", {
            method: "POST",
            origin: null,
            body: { username: TEST_USERNAME, password: TEST_PASSWORD },
        });
        assert.equal(result.response.status, 403);
        assert.deepEqual(result.body, { error: "origin_not_allowed" });
    });
});

test("unauthenticated overview is rejected before reading dashboard data", async () => {
    await withApp({}, async app => {
        const result = await request(app, "/api/dashboard/overview");
        assert.equal(result.response.status, 401);
        assert.deepEqual(result.body, { error: "unauthorized" });
        assert.equal(app.providerCalls.length, 0);
    });
});

test("authenticated overview returns only privacy-shaped data and applies validated filters", async () => {
    const calls = [];
    await withApp({ dataProvider: async input => { calls.push(input); return testModel(); } }, async app => {
        const loginResult = await login(app);
        const result = await request(app, "/api/dashboard/overview?dateFrom=2026-06-01&dateTo=2026-06-30&salesOwner=Synthetic%20Owner", {
            headers: { Cookie: cookiePair(loginResult.response) },
        });
        const serialized = JSON.stringify(result.body);

        assert.equal(result.response.status, 200);
        assert.deepEqual(calls[0].filters, {
            dateFrom: "2026-06-01",
            dateTo: "2026-06-30",
            salesOwner: "Synthetic Owner",
        });
        assert.equal(result.body.overview.financial.paid, 25);
        assert.equal(result.body.recent_activity.length, 22);
        for (const forbidden of ["phone", "lead_id", "facebook_leadgen_id", "note", "audio_url", "payment_url", "location_url", "drive_url", "raw_rows", "internal_secret"]) {
            assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
        }
        assert.equal(serialized.includes("synthetic-private"), false);
        assert.equal(serialized.includes("synthetic-not-for-response"), false);
    });
});

test("malformed, duplicate, unsupported, and reversed overview filters return 400", async () => {
    await withApp({}, async app => {
        const loginResult = await login(app);
        const headers = { Cookie: cookiePair(loginResult.response) };
        const invalidDate = await request(app, "/api/dashboard/overview?dateFrom=2026-02-30", { headers });
        const duplicate = await request(app, "/api/dashboard/overview?source=A&source=B", { headers });
        const unsupported = await request(app, "/api/dashboard/overview?unknown=value", { headers });
        const reversed = await request(app, "/api/dashboard/overview?dateFrom=2026-06-30&dateTo=2026-06-01", { headers });

        for (const result of [invalidDate, duplicate, unsupported, reversed]) {
            assert.equal(result.response.status, 400);
            assert.deepEqual(result.body, { error: "invalid_filter" });
        }
        assert.equal(app.providerCalls.length, 0);
    });
});

test("activity endpoint returns only approved fields and enforces a bounded limit", async () => {
    await withApp({}, async app => {
        const loginResult = await login(app);
        const result = await request(app, "/api/dashboard/activity?limit=2", {
            headers: { Cookie: cookiePair(loginResult.response) },
        });
        const entries = result.body.recent_activity;

        assert.equal(result.response.status, 200);
        assert.equal(entries.length, 2);
        assert.deepEqual(Object.keys(entries[0]).sort(), ["activity_type", "customer_name", "sales_owner", "timestamp"].sort());
        assert.equal(JSON.stringify(entries).includes("synthetic-private"), false);
        assert.equal(JSON.stringify(entries).includes("SYNTHETIC-LEAD-ID"), false);
    });
});

test("activity defaults to at most 20 and rejects limits above 20 or unsupported query keys", async () => {
    await withApp({}, async app => {
        const loginResult = await login(app);
        const headers = { Cookie: cookiePair(loginResult.response) };
        const defaultLimit = await request(app, "/api/dashboard/activity", { headers });
        const tooLarge = await request(app, "/api/dashboard/activity?limit=21", { headers });
        const unsupported = await request(app, "/api/dashboard/activity?source=synthetic", { headers });

        assert.equal(defaultLimit.body.recent_activity.length, 20);
        assert.equal(tooLarge.response.status, 400);
        assert.deepEqual(tooLarge.body, { error: "invalid_limit" });
        assert.equal(unsupported.response.status, 400);
    });
});

test("dashboard data-provider failures return a generic response without exposing errors", async () => {
    await withApp({ dataProvider: async () => { throw new Error("synthetic-private-provider-detail"); } }, async app => {
        const loginResult = await login(app);
        const result = await request(app, "/api/dashboard/overview", {
            headers: { Cookie: cookiePair(loginResult.response) },
        });

        assert.equal(result.response.status, 503);
        assert.deepEqual(result.body, { error: "dashboard_data_unavailable" });
        assert.equal(JSON.stringify(result.body).includes("synthetic-private-provider-detail"), false);
    });
});

test("dashboard route module has no write-helper dependency and does not invoke a write path", async () => {
    const routerSource = fs.readFileSync(path.join(__dirname, "..", "services", "dashboardRouter.js"), "utf8");
    for (const forbiddenHelper of [
        "appendLeadToSheet",
        "appendLeadsToSheetBatch",
        "updateObjectRow",
        "deleteSheetRows",
        "saveFacebookBackfillState",
    ]) {
        assert.equal(routerSource.includes(forbiddenHelper), false, forbiddenHelper);
    }

    let writeCalls = 0;
    await withApp({ dataProvider: async () => testModel() }, async app => {
        const loginResult = await login(app);
        await request(app, "/api/dashboard/overview", {
            headers: { Cookie: cookiePair(loginResult.response) },
        });
        assert.equal(writeCalls, 0);
    });
});

test("dashboard router passes unrelated operational paths through unchanged", async () => {
    await withApp({}, async app => {
        const result = await request(app, "/api/sync/status", { origin: "https://unapproved.example.test" });
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.body, { status: "untouched" });
        assert.equal(result.response.headers.get("access-control-allow-origin"), null);
    });
});

test("invalid password-hash configuration is reported without exposing its value", async () => {
    await withApp({ env: await configuredEnv({ DASHBOARD_AUTH_PASSWORD_HASH: "synthetic-invalid-hash" }) }, async app => {
        const result = await login(app);
        assert.equal(result.response.status, 503);
        assert.deepEqual(result.body, {
            error: "dashboard_not_configured",
            message: "Dashboard authentication is not configured.",
        });
        assert.equal(JSON.stringify(result.body).includes("synthetic-invalid-hash"), false);
    });
});
