const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
    buildDashboardReadModel,
    formatBangkokDateKey,
    parseDateValue,
} = require("../services/dashboardReadModel");
const {
    DASHBOARD_SHEET_NAMES,
    readDashboardSheets,
    sheetRowsToRecords,
} = require("../services/dashboardSheetsReader");
const {
    FORBIDDEN_DASHBOARD_FIELDS,
    shapeDashboardResponse,
} = require("../services/dashboardPrivacy");
const { dateToBangkokSheetsDateSerial } = require("../services/googleSheets");

const DEAL_SOURCE_HEADERS = Object.freeze([
    "Deal ID",
    "Lead ID",
    "Phone",
    "Product Model",
    "Package Type",
    "Full Amount",
    "Paid Amount",
    "Open Installation",
    "Payment Status",
    "Payment Date",
    "Payment Slip URL",
    "Payment Slip Save Status",
]);

function makeDealSheetRows(deals, headers = DEAL_SOURCE_HEADERS) {
    return [
        [...headers],
        headers.map(header => `label:${header}`),
        ...deals.map(deal => headers.map(header => deal[header] ?? "")),
    ];
}

function baseLead(overrides = {}) {
    return {
        lead_id: "LEAD-1",
        customer_name: "Alice Customer",
        source: "Facebook",
        facebook_leadgen_id: "FB-1",
        facebook_created_time: "2026-06-01T17:00:00Z",
        created_at: "2026-06-01T10:00:00+07:00",
        lead_status: "New",
        sales_owner: "Owner A",
        ...overrides,
    };
}

function baseDeal(overrides = {}) {
    return {
        deal_id: "DEAL-1",
        lead_id: "LEAD-1",
        full_amount: "1000",
        paid_amount: "250",
        payment_status: "Unpaid",
        payment_date: "2026-06-02",
        ...overrides,
    };
}

function baseInstallation(overrides = {}) {
    return {
        install_id: "INSTALL-1",
        lead_id: "LEAD-1",
        install_status: "Scheduled",
        preferred_install_date: "2026-06-10",
        ...overrides,
    };
}

test("Sheet reader excludes header and label rows and uses only the four dashboard sheets", async () => {
    const calls = [];
    const readRows = async (sheetName) => {
        calls.push(sheetName);
        if (sheetName === DASHBOARD_SHEET_NAMES.deals) {
            return makeDealSheetRows([{
                "Deal ID": "D-1",
                "Lead ID": "LEAD-1",
                Phone: "synthetic-phone",
                "Product Model": "synthetic-model",
                "Package Type": "synthetic-package",
                "Full Amount": "1000",
                "Paid Amount": "250",
                "Payment Status": "Unpaid",
                "Payment Date": "2026-06-02",
                "Payment Slip URL": "synthetic-slip-url",
            }]);
        }
        if (sheetName === DASHBOARD_SHEET_NAMES.leads) {
            return [["Lead ID", "Customer Name"], ["รหัสลูกค้า", "ชื่อลูกค้า"], ["LEAD-1", "Alice"]];
        }
        return [];
    };

    const sheets = await readDashboardSheets(readRows);
    assert.deepEqual(calls.sort(), Object.values(DASHBOARD_SHEET_NAMES).sort());
    assert.deepEqual(sheets.leads, [{ lead_id: "LEAD-1", customer_name: "Alice" }]);
    assert.deepEqual(sheets.deals, [{
        deal_id: "D-1",
        lead_id: "LEAD-1",
        full_amount: "1000",
        paid_amount: "250",
        payment_status: "Unpaid",
        payment_date: "2026-06-02",
    }]);
    assert.deepEqual(sheets.source_warnings, []);
    assert.deepEqual(sheetRowsToRecords([]), []);
});

test("total leads counts unique canonical Lead IDs and excludes blank IDs", () => {
    const model = buildDashboardReadModel({
        leads: [
            baseLead(),
            baseLead({ lead_id: "LEAD-1", customer_name: "Alice Updated", updated_at: "2026-06-03" }),
            baseLead({ lead_id: "LEAD-2", customer_name: "Bob", source: "Manual", facebook_leadgen_id: "", created_at: "2026-06-02" }),
            baseLead({ lead_id: "", customer_name: "No ID" }),
        ],
    });

    assert.equal(model.overview.leads.total, 2);
    assert.equal(model.overview.leads.by_source.Facebook, 1);
    assert.equal(model.overview.leads.by_source.Manual, 1);
    assert.equal(model.warnings.find(item => item.code === "duplicate_lead_id").count, 1);
});

test("Facebook event dates use Bangkok day boundaries and never fall back to Created At", () => {
    const model = buildDashboardReadModel({
        filters: { dateFrom: "2026-06-02", dateTo: "2026-06-02" },
        leads: [
            baseLead({ lead_id: "LEAD-BEFORE", facebook_created_time: "2026-06-01T16:59:59Z" }),
            baseLead({ lead_id: "LEAD-AT-BOUNDARY", facebook_created_time: "2026-06-01T17:00:00Z" }),
            baseLead({ lead_id: "LEAD-MISSING", facebook_created_time: "", created_at: "2026-06-02T00:00:00+07:00" }),
        ],
    });

    assert.equal(model.overview.leads.new_in_period, 1);
    assert.equal(model.overview.leads.incomplete_event_date_count, 1);
    assert.equal(model.warnings.find(item => item.code === "facebook_event_date_unavailable").count, 1);
});

test("Lead Trend matches New Leads date semantics, fills inclusive days, and preserves the invariant", () => {
    const model = buildDashboardReadModel({
        filters: { dateFrom: "2026-06-02", dateTo: "2026-06-04" },
        leads: [
            baseLead({ lead_id: "FB-BEFORE", facebook_created_time: "2026-06-01T16:59:59Z" }),
            baseLead({ lead_id: "FB-FROM", facebook_created_time: "2026-06-01T17:00:00Z" }),
            baseLead({ lead_id: "FB-MISSING", facebook_created_time: "", created_at: "2026-06-03T10:00:00+07:00" }),
            baseLead({ lead_id: "FB-INVALID", facebook_created_time: "not-a-date", created_at: "2026-06-03T10:00:00+07:00" }),
            baseLead({
                lead_id: "MANUAL-TO",
                source: "Manual",
                facebook_leadgen_id: "",
                facebook_created_time: "",
                created_at: "2026-06-04T16:59:59Z",
            }),
            baseLead({
                lead_id: "MANUAL-AFTER",
                source: "Manual",
                facebook_leadgen_id: "",
                facebook_created_time: "",
                created_at: "2026-06-04T17:00:00Z",
            }),
        ],
    });

    assert.deepEqual(model.overview.leads.lead_trend, [
        { date: "2026-06-02", new_leads: 1 },
        { date: "2026-06-03", new_leads: 0 },
        { date: "2026-06-04", new_leads: 1 },
    ]);
    assert.equal(model.overview.leads.incomplete_event_date_count, 2);
    assert.equal(model.warnings.find(item => item.code === "facebook_event_date_unavailable").count, 2);
    assert.equal(
        model.overview.leads.lead_trend.reduce((total, point) => total + point.new_leads, 0),
        model.overview.leads.new_in_period
    );
});

test("Lead Trend respects owner, lead status, and source filters", () => {
    const model = buildDashboardReadModel({
        filters: {
            dateFrom: "2026-06-01",
            dateTo: "2026-06-02",
            salesOwner: "Owner B",
            leadStatus: "New",
            source: "Manual",
        },
        leads: [
            baseLead({ lead_id: "MATCH", source: "Manual", facebook_leadgen_id: "", sales_owner: "Owner B", created_at: "2026-06-01" }),
            baseLead({ lead_id: "OWNER", source: "Manual", facebook_leadgen_id: "", sales_owner: "Owner A", created_at: "2026-06-01" }),
            baseLead({ lead_id: "STATUS", source: "Manual", facebook_leadgen_id: "", sales_owner: "Owner B", lead_status: "Done", created_at: "2026-06-02" }),
            baseLead({ lead_id: "SOURCE", source: "Facebook", sales_owner: "Owner B", created_at: "2026-06-02" }),
        ],
    });

    assert.deepEqual(model.overview.leads.lead_trend, [
        { date: "2026-06-01", new_leads: 1 },
        { date: "2026-06-02", new_leads: 0 },
    ]);
    assert.equal(model.overview.leads.new_in_period, 1);
});

test("Facebook Leadgen ID alone selects Facebook Created Time for Lead Trend", () => {
    const model = buildDashboardReadModel({
        filters: { dateFrom: "2026-06-02", dateTo: "2026-06-02" },
        leads: [baseLead({
            lead_id: "FB-ID-ONLY",
            source: "Referral",
            facebook_leadgen_id: "FB-IDENTITY",
            facebook_created_time: "2026-06-01T17:00:00Z",
            created_at: "2026-06-01T10:00:00+07:00",
        })],
    });

    assert.deepEqual(model.overview.leads.lead_trend, [{ date: "2026-06-02", new_leads: 1 }]);
    assert.equal(model.overview.leads.new_in_period, 1);
});

test("unbounded Lead Trend fills days between observed events and sums to New Leads", () => {
    const model = buildDashboardReadModel({
        leads: [
            baseLead({ lead_id: "EARLY", facebook_created_time: "2026-06-01" }),
            baseLead({ lead_id: "LATE", facebook_created_time: "2026-06-03" }),
        ],
    });

    assert.deepEqual(model.overview.leads.lead_trend, [
        { date: "2026-06-01", new_leads: 1 },
        { date: "2026-06-02", new_leads: 0 },
        { date: "2026-06-03", new_leads: 1 },
    ]);
    assert.equal(model.overview.leads.lead_trend.reduce((total, point) => total + point.new_leads, 0), 2);
});

test("Lead Trend zero-fill advances correctly across year boundaries", () => {
    const model = buildDashboardReadModel({
        filters: { dateFrom: "2026-12-31", dateTo: "2027-01-02" },
        leads: [
            baseLead({ lead_id: "YEAR-END", facebook_created_time: "2026-12-31" }),
            baseLead({ lead_id: "NEW-YEAR", facebook_created_time: "2027-01-02" }),
        ],
    });

    assert.deepEqual(model.overview.leads.lead_trend, [
        { date: "2026-12-31", new_leads: 1 },
        { date: "2027-01-01", new_leads: 0 },
        { date: "2027-01-02", new_leads: 1 },
    ]);
});

test("manual leads use Created At for the selected period", () => {
    const model = buildDashboardReadModel({
        filters: { dateFrom: "2026-06-02", dateTo: "2026-06-02" },
        leads: [baseLead({
            lead_id: "MANUAL-1",
            source: "Manual",
            facebook_leadgen_id: "",
            facebook_created_time: "",
            created_at: "2026-06-02T00:00:00+07:00",
        })],
    });

    assert.equal(model.overview.leads.new_in_period, 1);
    assert.equal(model.overview.leads.incomplete_event_date_count, 0);
});

test("missing Facebook event dates are reported as incomplete", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead({ facebook_created_time: "not-a-date" })],
    });

    assert.equal(model.overview.leads.incomplete_event_date_count, 1);
    assert.equal(model.overview.leads.new_in_period, 0);
    assert.equal(model.warnings[0].code, "facebook_event_date_unavailable");
});

test("financial totals exclude cancelled deals and preserve partial paid amounts", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [
            baseDeal(),
            baseDeal({ deal_id: "DEAL-2", full_amount: "500", paid_amount: "500", payment_status: "Paid" }),
            baseDeal({ deal_id: "DEAL-3", full_amount: "900", paid_amount: "900", payment_status: "Cancelled" }),
        ],
    });

    assert.equal(model.overview.financial.deal_value, 1500);
    assert.equal(model.overview.financial.paid, 750);
    assert.equal(model.overview.financial.outstanding, 750);
    assert.equal(model.overview.financial.open_deals, 1);
});

test("paid amounts above full amount are retained and surfaced as an anomaly", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [baseDeal({ full_amount: "100", paid_amount: "150" })],
    });

    assert.equal(model.overview.financial.paid, 150);
    assert.equal(model.overview.financial.outstanding, 0);
    assert.equal(model.warnings.find(item => item.code === "paid_exceeds_full_amount").count, 1);
});

test("negative financial amounts are excluded from totals and surfaced as anomalies", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [baseDeal({ full_amount: "-100", paid_amount: "-20" })],
    });

    assert.equal(model.overview.financial.deal_value, 0);
    assert.equal(model.overview.financial.paid, 0);
    assert.equal(model.overview.financial.outstanding, 0);
    assert.equal(model.warnings.find(item => item.code === "negative_full_amount").count, 1);
    assert.equal(model.warnings.find(item => item.code === "negative_paid_amount").count, 1);
});

test("payment status aggregation returns counts without exposing deal rows", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [
            baseDeal({ deal_id: "D1", payment_status: "Unpaid" }),
            baseDeal({ deal_id: "D2", payment_status: "Paid" }),
            baseDeal({ deal_id: "D3", payment_status: "Cancelled" }),
        ],
    });

    assert.deepEqual(model.overview.financial.payment_status_counts, {
        Unpaid: 1,
        Paid: 1,
        Cancelled: 1,
        Unknown: 0,
    });
    assert.equal(Object.hasOwn(model.overview.financial, "deal_rows"), false);
});

test("payment date serials are interpreted in Asia/Bangkok", () => {
    const serial = dateToBangkokSheetsDateSerial(new Date("2026-06-10T00:00:00Z"));
    const parsed = parseDateValue(serial);
    assert.equal(parsed.kind, "sheets_serial_number");
    assert.equal(formatBangkokDateKey(parsed.date), "2026-06-10");
});

test("financial metrics keep current-state totals separate from Payment Date filtering", () => {
    const model = buildDashboardReadModel({
        filters: { dateFrom: "2026-06-10", dateTo: "2026-06-10" },
        leads: [baseLead()],
        deals: [
            baseDeal({ deal_id: "D-IN", payment_date: "2026-06-10", deal_date: "2026-06-11", created_at: "2026-06-11", full_amount: "100", paid_amount: "40" }),
            baseDeal({ deal_id: "D-OUT", payment_date: "2026-06-11", deal_date: "2026-06-10", created_at: "2026-06-10", full_amount: "200", paid_amount: "80" }),
            baseDeal({ deal_id: "D-NO-DATE", payment_date: "", deal_date: "2026-06-10", created_at: "2026-06-10", full_amount: "300", paid_amount: "30" }),
        ],
    });

    assert.equal(model.overview.financial.deal_value, 600);
    assert.equal(model.overview.financial.paid, 40);
    assert.equal(model.overview.financial.outstanding, 450);
    assert.equal(model.overview.financial.open_deals, 3);
    assert.equal(model.overview.financial.deals_in_scope, 3);
    assert.equal(model.warnings.find(item => item.code === "payment_date_unavailable").count, 1);
    assert.ok(model.warnings.some(item => item.code === "deal_value_period_filter_unsupported"));
    assert.ok(model.warnings.some(item => item.code === "outstanding_period_filter_unsupported"));
    assert.ok(model.warnings.some(item => item.code === "open_deals_period_filter_unsupported"));
});

test("unfiltered Paid Amount is a current-state aggregate and does not require a date", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [
            baseDeal({ deal_id: "D-DATED", paid_amount: "40", payment_date: "2026-06-10" }),
            baseDeal({ deal_id: "D-UNDATED", paid_amount: "30", payment_date: "" }),
        ],
    });

    assert.equal(model.overview.financial.paid, 70);
    assert.equal(model.warnings.some(item => item.code === "payment_date_unavailable"), false);
});

test("legacy price is not treated as explicit Paid Amount", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [baseDeal({ paid_amount: undefined, price: "250" })],
    });

    assert.equal(model.overview.financial.deal_value, 1000);
    assert.equal(model.overview.financial.paid, 0);
    assert.equal(model.overview.financial.outstanding, 0);
    assert.equal(model.overview.financial.open_deals, 0);
    assert.ok(model.warnings.some(item => item.code === "paid_amount_unavailable"));
    assert.ok(model.warnings.some(item => item.code === "outstanding_unavailable"));
});

test("Open Deals are non-cancelled deals with known Outstanding greater than zero", () => {
    const model = buildDashboardReadModel({
        leads: [baseLead()],
        deals: [
            baseDeal({ deal_id: "D-FULL-BUT-UNPAID-STATUS", full_amount: "100", paid_amount: "100", payment_status: "Unpaid" }),
            baseDeal({ deal_id: "D-PARTIAL-BUT-PAID-STATUS", full_amount: "100", paid_amount: "40", payment_status: "Paid" }),
            baseDeal({ deal_id: "D-UNPAID", full_amount: "100", paid_amount: "0", payment_status: "Unpaid" }),
            baseDeal({ deal_id: "D-CANCELLED", full_amount: "100", paid_amount: "0", payment_status: "Cancelled" }),
            baseDeal({ deal_id: "D-UNKNOWN-BALANCE", full_amount: "100", paid_amount: undefined, payment_status: "Unpaid" }),
        ],
    });

    assert.equal(model.overview.financial.open_deals, 2);
    assert.equal(model.overview.financial.outstanding, 160);
    assert.equal(model.overview.financial.deal_value, 400);
    assert.equal(model.warnings.some(item => item.code === "outstanding_unavailable"), true);
});

test("exact DEALS projection preserves financial semantics and privacy through the model", async () => {
    const records = [
        {
            "Deal ID": "D-PARTIAL",
            "Lead ID": "LEAD-1",
            Phone: "synthetic-phone-1",
            "Full Amount": "1000",
            "Paid Amount": "250",
            "Payment Status": "Unpaid",
            "Payment Date": "2026-06-10",
            "Payment Slip URL": "synthetic-slip-1",
        },
        {
            "Deal ID": "D-FULL",
            "Lead ID": "LEAD-2",
            Phone: "synthetic-phone-2",
            "Full Amount": "500",
            "Paid Amount": "500",
            "Payment Status": "Unpaid",
            "Payment Date": "2026-06-11",
            "Payment Slip URL": "synthetic-slip-2",
        },
        {
            "Deal ID": "D-CANCELLED",
            "Lead ID": "LEAD-3",
            Phone: "synthetic-phone-3",
            "Full Amount": "900",
            "Paid Amount": "0",
            "Payment Status": "Cancelled",
            "Payment Date": "2026-06-10",
            "Payment Slip URL": "synthetic-slip-3",
        },
        {
            "Deal ID": "D-OVERPAID",
            "Lead ID": "LEAD-4",
            Phone: "synthetic-phone-4",
            "Full Amount": "100",
            "Paid Amount": "150",
            "Payment Status": "Paid",
            "Payment Date": "2026-06-11",
            "Payment Slip URL": "synthetic-slip-4",
        },
    ];
    const reorderedHeaders = [
        "Payment Date",
        "Paid Amount",
        "Phone",
        "Deal ID",
        "Full Amount",
        "Lead ID",
        "Payment Slip URL",
        "Payment Status",
        "Package Type",
        "Product Model",
        "Open Installation",
        "Payment Slip Save Status",
    ];
    const dealRows = makeDealSheetRows(records, reorderedHeaders);
    const originalRows = JSON.stringify(dealRows);
    const calls = [];
    const sheets = await readDashboardSheets(async sheetName => {
        calls.push(sheetName);
        return sheetName === DASHBOARD_SHEET_NAMES.deals ? dealRows : [];
    });

    assert.deepEqual(calls.sort(), Object.values(DASHBOARD_SHEET_NAMES).sort());
    assert.equal(JSON.stringify(dealRows), originalRows);
    assert.deepEqual(Object.keys(sheets.deals[0]).sort(), [
        "deal_id",
        "lead_id",
        "full_amount",
        "paid_amount",
        "payment_status",
        "payment_date",
    ].sort());
    assert.equal(sheets.deals[0].full_amount, "1000");
    assert.equal(sheets.deals[0].paid_amount, "250");
    assert.equal(Object.hasOwn(sheets.deals[0], "phone"), false);
    assert.equal(Object.hasOwn(sheets.deals[0], "payment_slip_url"), false);

    const current = buildDashboardReadModel(sheets);
    assert.equal(current.overview.financial.deal_value, 1600);
    assert.equal(current.overview.financial.paid, 900);
    assert.equal(current.overview.financial.outstanding, 750);
    assert.equal(current.overview.financial.open_deals, 1);
    assert.equal(current.warnings.find(item => item.code === "paid_exceeds_full_amount").count, 1);

    const period = buildDashboardReadModel({
        ...sheets,
        filters: { dateFrom: "2026-06-10", dateTo: "2026-06-10" },
    });
    assert.equal(period.overview.financial.deal_value, 1600);
    assert.equal(period.overview.financial.paid, 250);
    assert.equal(period.overview.financial.outstanding, 750);
    assert.equal(period.overview.financial.open_deals, 1);
    assert.ok(period.warnings.some(item => item.code === "deal_value_period_filter_unsupported"));
    assert.ok(period.warnings.some(item => item.code === "outstanding_period_filter_unsupported"));
    assert.ok(period.warnings.some(item => item.code === "open_deals_period_filter_unsupported"));
});

test("missing Paid Amount header, even with Price present, makes DEALS metrics unavailable", async () => {
    const headers = DEAL_SOURCE_HEADERS
        .filter(header => header !== "Paid Amount")
        .concat("Price");
    const rows = makeDealSheetRows([{
        "Deal ID": "D-PRICE-ONLY",
        "Lead ID": "LEAD-1",
        "Full Amount": "1000",
        Price: "250",
        "Payment Status": "Unpaid",
        "Payment Date": "2026-06-10",
    }], headers);
    const sheets = await readDashboardSheets(async sheetName => (
        sheetName === DASHBOARD_SHEET_NAMES.deals ? rows : []
    ));
    const model = buildDashboardReadModel(sheets);

    assert.deepEqual(sheets.deals, []);
    assert.equal(model.overview.financial.deal_value, 0);
    assert.equal(model.overview.financial.paid, 0);
    assert.equal(model.overview.financial.outstanding, 0);
    assert.equal(model.overview.financial.open_deals, 0);
    const warning = model.warnings.find(item => item.code === "dashboard_deals_projection_unavailable");
    assert.ok(warning);
    assert.match(warning.message, /Paid Amount/);
});

test("missing Full Amount header makes DEALS metrics unavailable", async () => {
    const headers = DEAL_SOURCE_HEADERS.filter(header => header !== "Full Amount");
    const rows = makeDealSheetRows([{
        "Deal ID": "D-NO-FULL",
        "Lead ID": "LEAD-1",
        "Paid Amount": "250",
        "Payment Status": "Unpaid",
        "Payment Date": "2026-06-10",
    }], headers);
    const sheets = await readDashboardSheets(async sheetName => (
        sheetName === DASHBOARD_SHEET_NAMES.deals ? rows : []
    ));
    const model = buildDashboardReadModel(sheets);

    assert.deepEqual(sheets.deals, []);
    const warning = model.warnings.find(item => item.code === "dashboard_deals_projection_unavailable");
    assert.ok(warning);
    assert.match(warning.message, /Full Amount/);
});

test("duplicate required DEALS headers fail closed instead of selecting a column", async () => {
    const headers = [...DEAL_SOURCE_HEADERS, "Paid Amount"];
    const rows = makeDealSheetRows([{
        "Deal ID": "D-DUPLICATE-PAID",
        "Lead ID": "LEAD-1",
        "Full Amount": "1000",
        "Paid Amount": "250",
        "Payment Status": "Unpaid",
        "Payment Date": "2026-06-10",
    }], headers);
    const sheets = await readDashboardSheets(async sheetName => (
        sheetName === DASHBOARD_SHEET_NAMES.deals ? rows : []
    ));

    assert.deepEqual(sheets.deals, []);
    assert.match(sheets.source_warnings[0].message, /duplicated: Paid Amount/);
});

test("installation status distribution and upcoming workload use Preferred Install Date", () => {
    const model = buildDashboardReadModel({
        asOf: "2026-06-01",
        filters: { dateFrom: "2026-06-01", dateTo: "2026-06-30" },
        leads: [baseLead()],
        installations: [
            baseInstallation({ install_id: "I1", install_status: "Pending", preferred_install_date: "2026-06-05" }),
            baseInstallation({ install_id: "I2", install_status: "Scheduled", preferred_install_date: "2026-06-10" }),
            baseInstallation({ install_id: "I3", install_status: "Installed", preferred_install_date: "2026-05-01" }),
            baseInstallation({ install_id: "I4", install_status: "Cancelled", preferred_install_date: "2026-06-12" }),
        ],
    });

    assert.deepEqual(model.overview.installations.by_status, {
        Pending: 1,
        Scheduled: 1,
        Installed: 1,
        Cancelled: 1,
        Unknown: 0,
    });
    assert.equal(model.overview.installations.upcoming_scheduled_count, 2);
    assert.deepEqual(model.overview.installations.upcoming_scheduled_by_date, {
        "2026-06-05": 1,
        "2026-06-10": 1,
    });
    assert.deepEqual(model.overview.installations.upcoming_installations, [
        { date: "2026-06-05", customer_name: "Alice Customer", sales_owner: "Owner A", status: "Pending" },
        { date: "2026-06-10", customer_name: "Alice Customer", sales_owner: "Owner A", status: "Scheduled" },
    ]);
});

test("upcoming installations use Preferred Install Date only and share count/list/date eligibility", () => {
    const model = buildDashboardReadModel({
        asOf: "2026-06-01",
        // Historical overview dates must not hide future preferred install dates.
        filters: { dateFrom: "2026-05-01", dateTo: "2026-06-01" },
        leads: [baseLead()],
        installations: [
            baseInstallation({ install_id: "FUTURE", install_status: "Scheduled", preferred_install_date: "2026-06-05" }),
            baseInstallation({ install_id: "TODAY", install_status: "Pending", preferred_install_date: "2026-06-01" }),
            baseInstallation({ install_id: "INSTALLED", install_status: "Installed", preferred_install_date: "2026-06-03" }),
            baseInstallation({ install_id: "CANCELLED", install_status: "Cancelled", preferred_install_date: "2026-06-04" }),
            baseInstallation({ install_id: "PAST", install_status: "Pending", preferred_install_date: "2026-05-31" }),
            baseInstallation({ install_id: "BLANK", install_status: "Pending", preferred_install_date: "", install_date: "2026-06-06" }),
            baseInstallation({ install_id: "INVALID", install_status: "Scheduled", preferred_install_date: "not-a-date", install_date: "2026-06-07" }),
            baseInstallation({ install_id: "NO-LEAD", lead_id: "MISSING-LEAD", install_status: "Pending", preferred_install_date: "2026-06-08" }),
        ],
    });
    const installations = model.overview.installations;
    const summedByDate = Object.values(installations.upcoming_scheduled_by_date).reduce((sum, count) => sum + count, 0);

    assert.deepEqual(installations.upcoming_installations, [
        { date: "2026-06-01", customer_name: "Alice Customer", sales_owner: "Owner A", status: "Pending" },
        { date: "2026-06-05", customer_name: "Alice Customer", sales_owner: "Owner A", status: "Scheduled" },
    ]);
    assert.equal(installations.upcoming_scheduled_count, installations.upcoming_installations.length);
    assert.equal(installations.upcoming_scheduled_count, summedByDate);
    assert.deepEqual(installations.upcoming_scheduled_by_date, {
        "2026-06-01": 1,
        "2026-06-05": 1,
    });
    assert.equal(model.warnings.find(item => item.code === "installation_date_unavailable").count, 2);
    assert.equal(model.warnings.find(item => item.code === "upcoming_installation_lead_join_missing").count, 1);
});

test("upcoming installation owner/source filters join through Lead ID internally", () => {
    const model = buildDashboardReadModel({
        asOf: "2026-06-01",
        filters: { dateFrom: "2026-06-01", dateTo: "2026-06-01", salesOwner: "Owner B", source: "Manual" },
        leads: [
            baseLead({ lead_id: "LEAD-A", sales_owner: "Owner A", source: "Facebook" }),
            baseLead({ lead_id: "LEAD-B", customer_name: "Synthetic Customer B", sales_owner: "Owner B", source: "Manual", facebook_leadgen_id: "" }),
        ],
        installations: [
            baseInstallation({ install_id: "INSTALL-A", lead_id: "LEAD-A", preferred_install_date: "2026-06-02" }),
            baseInstallation({ install_id: "INSTALL-B", lead_id: "LEAD-B", preferred_install_date: "2026-06-03" }),
        ],
    });

    assert.deepEqual(model.overview.installations.upcoming_installations, [
        { date: "2026-06-03", customer_name: "Synthetic Customer B", sales_owner: "Owner B", status: "Scheduled" },
    ]);
    assert.equal(model.overview.installations.upcoming_scheduled_count, 1);
});

test("installation date serials support the existing Sheets representation", () => {
    const serial = dateToBangkokSheetsDateSerial(new Date("2026-06-12T00:00:00Z"));
    const model = buildDashboardReadModel({
        asOf: "2026-06-01",
        leads: [baseLead()],
        installations: [baseInstallation({ preferred_install_date: serial })],
    });

    assert.equal(model.overview.installations.upcoming_scheduled_count, 1);
    assert.equal(model.overview.installations.upcoming_scheduled_by_date["2026-06-12"], 1);
});

test("Recent Activity joins customer, orders newest first, and limits results", () => {
    const activities = Array.from({ length: 22 }, (_, index) => ({
        activity_id: `ACT-${index}`,
        lead_id: "LEAD-1",
        action_type: "Follow-up",
        created_by: "Owner A",
        created_at: `2026-06-${String(index + 1).padStart(2, "0")}T10:00:00+07:00`,
    }));
    const model = buildDashboardReadModel({ leads: [baseLead()], activities });

    assert.equal(model.recent_activity.length, 20);
    assert.equal(model.recent_activity[0].customer_name, "Alice Customer");
    assert.equal(model.recent_activity[0].timestamp, "2026-06-22T03:00:00.000Z");
    assert.equal(model.recent_activity[19].timestamp, "2026-06-03T03:00:00.000Z");
});

test("filters do not apply Lead Status directly to downstream financial metrics", () => {
    const model = buildDashboardReadModel({
        filters: { leadStatus: "New" },
        leads: [baseLead({ lead_status: "Installed" })],
        deals: [baseDeal({ full_amount: "400", paid_amount: "0" })],
    });

    assert.equal(model.overview.leads.total, 0);
    assert.equal(model.overview.financial.deal_value, 400);
    assert.equal(model.overview.financial.outstanding, 400);
});

test("Sales Owner and Source downstream filters use the explicit Lead ID relationship", () => {
    const model = buildDashboardReadModel({
        filters: { salesOwner: "Owner B", source: "Manual" },
        leads: [
            baseLead({ lead_id: "LEAD-1", sales_owner: "Owner A", source: "Facebook" }),
            baseLead({ lead_id: "LEAD-2", sales_owner: "Owner B", source: "Manual", facebook_leadgen_id: "", created_at: "2026-06-01" }),
        ],
        deals: [
            baseDeal({ deal_id: "D1", lead_id: "LEAD-1", full_amount: "100" }),
            baseDeal({ deal_id: "D2", lead_id: "LEAD-2", full_amount: "200" }),
        ],
    });

    assert.equal(model.overview.financial.deal_value, 200);
    assert.equal(model.overview.financial.deals_in_scope, 1);
});

test("privacy shaping emits only the approved dashboard fields", () => {
    const shaped = shapeDashboardResponse({
        timezone: "Asia/Bangkok",
        filters: {},
        overview: {
            leads: {
                total: 1,
                new_in_period: 1,
                lead_trend: [{ date: "2026-06-01", new_leads: 1, lead_id: "PRIVATE-LEAD" }],
                incomplete_event_date_count: 0,
                by_status: {},
                by_source: {},
                by_sales_owner: {},
            },
            financial: { deal_value: 1, paid: 1, outstanding: 0, open_deals: 0, payment_status_counts: {}, deals_in_scope: 1 },
            installations: {
                by_status: {},
                upcoming_scheduled_count: 1,
                upcoming_scheduled_by_date: { "2026-06-02": 1 },
                upcoming_installations: [{
                    date: "2026-06-02",
                    customer_name: "Synthetic Customer",
                    sales_owner: "Synthetic Owner",
                    status: "Scheduled",
                    lead_id: "PRIVATE-LEAD",
                    install_id: "PRIVATE-INSTALL",
                    phone: "private-phone-marker",
                    note: "private-note-marker",
                    location_url: "https://private.invalid/location",
                }],
            },
        },
        recent_activity: [{
            customer_name: "Alice",
            activity_type: "Follow-up",
            sales_owner: "Owner A",
            timestamp: "2026-06-01T00:00:00.000Z",
            phone: "0812345678",
            lead_id: "LEAD-1",
            note: "private",
            audio_url: "https://private.invalid/audio",
        }],
        warnings: [],
        internal_secret: "must-not-pass",
    });
    const serialized = JSON.stringify(shaped);

    for (const forbiddenField of FORBIDDEN_DASHBOARD_FIELDS) {
        assert.equal(Object.prototype.hasOwnProperty.call(shaped, forbiddenField), false);
        assert.equal(serialized.includes(`"${forbiddenField}"`), false, forbiddenField);
    }
    assert.deepEqual(shaped.recent_activity[0], {
        customer_name: "Alice",
        activity_type: "Follow-up",
        sales_owner: "Owner A",
        timestamp: "2026-06-01T00:00:00.000Z",
    });
    assert.deepEqual(shaped.overview.leads.lead_trend, [{ date: "2026-06-01", new_leads: 1 }]);
    assert.deepEqual(shaped.overview.installations.upcoming_installations, [{
        date: "2026-06-02",
        customer_name: "Synthetic Customer",
        sales_owner: "Synthetic Owner",
        status: "Scheduled",
    }]);
    for (const privateMarker of ["PRIVATE-LEAD", "PRIVATE-INSTALL", "private-phone-marker", "private-note-marker", "private.invalid/location"]) {
        assert.equal(serialized.includes(privateMarker), false, privateMarker);
    }
});

test("dashboard reader does not reference or invoke write helpers", async () => {
    const readerSource = fs.readFileSync(
        path.join(__dirname, "..", "services", "dashboardSheetsReader.js"),
        "utf8"
    );
    for (const forbiddenFunction of [
        "appendLeadsToSheetBatch",
        "appendObjects",
        "updateObjectRow",
        "updateObjectRows",
        "deleteSheetRows",
        "saveFacebookBackfillState",
    ]) {
        assert.equal(readerSource.includes(forbiddenFunction), false, forbiddenFunction);
    }

    const calls = [];
    await readDashboardSheets(async sheetName => {
        calls.push(sheetName);
        return [["Lead ID"], ["รหัสลูกค้า"], ["L-1"]];
    });
    assert.deepEqual(calls.sort(), Object.values(DASHBOARD_SHEET_NAMES).sort());
});
