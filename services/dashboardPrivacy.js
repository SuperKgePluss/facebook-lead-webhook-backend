"use strict";

const FORBIDDEN_DASHBOARD_FIELDS = Object.freeze([
    "phone",
    "raw_phone",
    "lead_id",
    "facebook_leadgen_id",
    "facebook_lead_id",
    "note",
    "audio_url",
    "payment_url",
    "payment_slip_url",
    "location_url",
    "drive_url",
    "google_credentials",
    "sync_secret",
    "diagnostic_secret",
]);

function copyMap(value) {
    return value && typeof value === "object" ? { ...value } : {};
}

function shapeDashboardResponse(model) {
    const overview = model?.overview || {};
    const leads = overview.leads || {};
    const financial = overview.financial || {};
    const installations = overview.installations || {};

    return {
        timezone: model?.timezone || "Asia/Bangkok",
        filters: {
            timezone: model?.filters?.timezone || "Asia/Bangkok",
            dateFrom: model?.filters?.dateFrom || null,
            dateTo: model?.filters?.dateTo || null,
            salesOwner: model?.filters?.salesOwner || null,
            leadStatus: model?.filters?.leadStatus || null,
            source: model?.filters?.source || null,
        },
        overview: {
            leads: {
                total: Number(leads.total) || 0,
                new_in_period: Number(leads.new_in_period) || 0,
                incomplete_event_date_count: Number(leads.incomplete_event_date_count) || 0,
                by_status: copyMap(leads.by_status),
                by_source: copyMap(leads.by_source),
                by_sales_owner: copyMap(leads.by_sales_owner),
            },
            financial: {
                deal_value: Number(financial.deal_value) || 0,
                paid: Number(financial.paid) || 0,
                outstanding: Number(financial.outstanding) || 0,
                open_deals: Number(financial.open_deals) || 0,
                payment_status_counts: copyMap(financial.payment_status_counts),
                deals_in_scope: Number(financial.deals_in_scope) || 0,
            },
            installations: {
                by_status: copyMap(installations.by_status),
                upcoming_scheduled_count: Number(installations.upcoming_scheduled_count) || 0,
                upcoming_scheduled_by_date: copyMap(installations.upcoming_scheduled_by_date),
            },
        },
        recent_activity: Array.isArray(model?.recent_activity)
            ? model.recent_activity.map(activity => ({
                customer_name: String(activity?.customer_name || ""),
                activity_type: String(activity?.activity_type || ""),
                sales_owner: String(activity?.sales_owner || ""),
                timestamp: String(activity?.timestamp || ""),
            }))
            : [],
        warnings: Array.isArray(model?.warnings)
            ? model.warnings.map(warning => ({
                code: String(warning?.code || ""),
                count: Number(warning?.count) || 0,
                message: String(warning?.message || ""),
            }))
            : [],
    };
}

module.exports = {
    FORBIDDEN_DASHBOARD_FIELDS,
    shapeDashboardResponse,
};
