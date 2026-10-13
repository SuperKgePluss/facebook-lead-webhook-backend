"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDashboardRouter, parseActivityLimit, parseOverviewFilters } = require("../services/dashboardRouter");

test("Production-baseline Dashboard router exposes every frontend API route", () => {
    const router = createDashboardRouter({
        env: {},
        dataProvider: async () => ({}),
        healthReader: async () => null,
    });
    const routes = new Set(router.stack.filter(layer => layer.route).map(layer => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`));

    for (const route of [
        "POST /auth/login",
        "POST /auth/logout",
        "GET /auth/session",
        "GET /dashboard/overview",
        "GET /dashboard/activity",
        "GET /dashboard/health",
    ]) assert.ok(routes.has(route), `missing ${route}`);
});

test("CRM4 filters, date ranges, and lead paging are accepted by Dashboard API parsers", () => {
    const overview = parseOverviewFilters({
        dateFrom: "2026-10-01",
        dateTo: "2026-10-14",
        salesOwner: "Owner",
        leadStatus: "New",
        source: "Website",
        customerTypeCode: "B2C",
        salesFollowUpStatus: "รอติดต่อ",
        leadOffset: "100",
        leadLimit: "100",
    });
    assert.equal(overview.ok, true);
    assert.equal(overview.filters.customerTypeCode, "B2C");
    assert.equal(overview.filters.salesFollowUpStatus, "รอติดต่อ");
    assert.deepEqual(overview.pagination, { offset: 100, limit: 100 });
    assert.equal(parseActivityLimit({ limit: "20", dateFrom: "2026-10-01", dateTo: "2026-10-14" }), 20);
});
