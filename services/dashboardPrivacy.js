"use strict";

// Phone and full Sales Note history are exposed only through the explicit, authenticated operational_leads projection.
const FORBIDDEN_DASHBOARD_FIELDS = Object.freeze([
    "raw_phone",
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

function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}


function copyMap(value) {
    return value && typeof value === "object" ? { ...value } : {};
}

function shapeMetricQuality(metrics) {
    if (!metrics || typeof metrics !== "object") return {};
    return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, {
        value: metric?.status === "UNAVAILABLE" ? null : metric?.value ?? null,
        status: ["VERIFIED", "PARTIAL", "UNAVAILABLE"].includes(metric?.status) ? metric.status : "UNAVAILABLE",
        eligibleCount: safeCount(metric?.eligibleCount),
        excludedCount: safeCount(metric?.excludedCount),
        totalCount: safeCount(metric?.totalCount),
        reasonCodes: Array.isArray(metric?.reasonCodes) ? [...new Set(metric.reasonCodes.map(String))] : [],
        reasonCounts: metric?.reasonCounts && typeof metric.reasonCounts === "object"
            ? Object.fromEntries(Object.entries(metric.reasonCounts).map(([code, count]) => [String(code), safeCount(count)]))
            : {},
        sourceAsOf: typeof metric?.sourceAsOf === "string" && Number.isFinite(Date.parse(metric.sourceAsOf)) ? metric.sourceAsOf : null,
    }]));
}

function shapeDashboardResponse(model) {
    const overview = model?.overview || {};
    const leads = overview.leads || {};
    const financial = overview.financial || {};
    const financialComplete = model?.crm4_source_capabilities?.financial_complete === true;
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
            customerTypeCode: model?.filters?.customerTypeCode || null,
            salesFollowUpStatus: model?.filters?.salesFollowUpStatus || null,
        },
        overview: {
            leads: {
                total: Number(leads.total) || 0,
                new_in_period: Number(leads.new_in_period) || 0,
                lead_trend: Array.isArray(leads.lead_trend)
                    ? leads.lead_trend.map(point => ({
                        date: String(point?.date || ""),
                        new_leads: Number.isFinite(Number(point?.new_leads))
                            ? Math.max(0, Math.floor(Number(point.new_leads)))
                            : 0,
                    }))
                    : [],
                incomplete_event_date_count: Number(leads.incomplete_event_date_count) || 0,
                by_status: copyMap(leads.by_status),
                by_source: copyMap(leads.by_source),
                by_sales_owner: copyMap(leads.by_sales_owner),
                sales_owner_options: Array.isArray(leads.sales_owner_options)
                    ? [...new Set(leads.sales_owner_options.map(value => String(value ?? "").trim()).filter(Boolean))]
                    : [],
                by_customer_type_code: copyMap(leads.by_customer_type_code),
                by_sales_follow_up_status: copyMap(leads.by_sales_follow_up_status),
            },
            financial: {
                deal_value: typeof financial.deal_value === "number" && Number.isFinite(financial.deal_value) ? financial.deal_value : null,
                paid: typeof financial.paid === "number" && Number.isFinite(financial.paid) ? financial.paid : null,
                outstanding: typeof financial.outstanding === "number" && Number.isFinite(financial.outstanding) ? financial.outstanding : null,
                open_deals: typeof financial.open_deals === "number" && Number.isFinite(financial.open_deals) ? financial.open_deals : null,
                payment_status_counts: copyMap(financial.payment_status_counts),
                deals_in_scope: safeCount(financial.deals_in_scope),
                source_records_total: safeCount(financial.source_records_total),
                unique_verified_deal_count: safeCount(financial.unique_verified_deal_count),
                conflicting_identity_groups: safeCount(financial.conflicting_identity_groups),
                duplicate_identity_groups: safeCount(financial.duplicate_identity_groups),
                duplicate_rows_collapsed: safeCount(financial.duplicate_rows_collapsed),
                metric_quality: shapeMetricQuality(financial.metric_quality),
            },
            installations: {
                by_status: copyMap(installations.by_status),
                records_total: safeCount(installations.records_total),
                records: Array.isArray(installations.records) ? installations.records.map(item => ({
                    install_id: String(item?.install_id || ""),
                    lead_id: String(item?.lead_id || ""),
                    date: item?.date || null,
                    customer_name: String(item?.customer_name || ""),
                    sales_owner: String(item?.sales_owner || ""),
                    status: String(item?.status || ""),
                })) : [],
                upcoming_scheduled_count: Number(installations.upcoming_scheduled_count) || 0,
                upcoming_scheduled_by_date: copyMap(installations.upcoming_scheduled_by_date),
                upcoming_installations: Array.isArray(installations.upcoming_installations)
                    ? installations.upcoming_installations.map(installation => ({
                        date: String(installation?.date || ""),
                        customer_name: String(installation?.customer_name || ""),
                        sales_owner: String(installation?.sales_owner || ""),
                        status: String(installation?.status || ""),
                    }))
                    : [],
            },
        },
        operational_leads: {
            items: Array.isArray(model?.operational_leads?.items)
                ? model.operational_leads.items.map(lead => ({
                    lead_id: String(lead?.lead_id || ""),
                    customer_name: String(lead?.customer_name || ""),
                    phone: String(lead?.phone || ""),
                    additional_phone: String(lead?.additional_phone || ""),
                    lead_status: lead?.lead_status || null,
                    preferred_call_day: String(lead?.preferred_call_day || ""),
                    preferred_call_time: String(lead?.preferred_call_time || ""),
                    customer_type_code: lead?.customer_type_code || null,
                    sales_follow_up_status: lead?.sales_follow_up_status || null,
                    sales_owner: String(lead?.sales_owner || ""),
                    latest_follow_up_at: lead?.latest_follow_up_at || null,
                    last_successful_contact_at: lead?.last_successful_contact_at || null,
                    sales_note_history: Array.isArray(lead?.sales_note_history)
                        ? lead.sales_note_history.map(note => ({ at: note?.at || null, text: String(note?.text || "") }))
                        : [],
                    audio_recording_count: Number.isInteger(lead?.audio_recording_count) && lead.audio_recording_count > 0 ? lead.audio_recording_count : null,
                    audio_latest_recording_at: typeof lead?.audio_latest_recording_at === "string"
                        && Number.isFinite(Date.parse(lead.audio_latest_recording_at)) ? lead.audio_latest_recording_at : null,
                    audio_latest_recording_url: typeof lead?.audio_latest_recording_url === "string"
                        && /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(lead.audio_latest_recording_url)
                        ? lead.audio_latest_recording_url : null,
                    wants_installation: typeof lead?.wants_installation === "boolean" ? lead.wants_installation : null,
                }))
                : [],
            total: Number(model?.operational_leads?.total) || 0,
            offset: Number.isSafeInteger(model?.operational_leads?.offset) && model.operational_leads.offset >= 0 ? model.operational_leads.offset : 0,
            limit: Number.isSafeInteger(model?.operational_leads?.limit) && model.operational_leads.limit > 0 ? model.operational_leads.limit : 100,
            has_more: Boolean(model?.operational_leads?.has_more),
        },
        recent_activity: Array.isArray(model?.recent_activity)
            ? model.recent_activity.map(activity => ({
                lead_id: String(activity?.lead_id || ""),
                customer_name: String(activity?.customer_name || ""),
                activity_type: String(activity?.activity_type || ""),
                sales_owner: String(activity?.sales_owner || ""),
                timestamp: String(activity?.timestamp || ""),
            }))
            : [],
        crm4_reconciliation: {
            main_only_lead_count: safeCount(model?.crm4_reconciliation?.main_only_lead_count),
        },
        crm4_source_capabilities: {
            sales_follow_up_status: typeof model?.crm4_source_capabilities?.sales_follow_up_status === "boolean" ? model.crm4_source_capabilities.sales_follow_up_status : null,
            customer_type_code: typeof model?.crm4_source_capabilities?.customer_type_code === "boolean" ? model.crm4_source_capabilities.customer_type_code : null,
            financial_complete: financialComplete,
        },
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
