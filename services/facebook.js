const axios = require("axios");

const GRAPH_VERSION = "v25.0";

async function fetchLeadDetail(leadgenId) {
    if (!leadgenId) {
        throw new Error("Missing leadgenId");
    }

    const token = process.env.FB_PAGE_ACCESS_TOKEN;

    if (!token) {
        throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}`;

    const response = await axios.get(url, {
        params: {
            fields: "created_time,field_data,form_id,ad_id,campaign_id",
            access_token: token,
        },
    });

    return response.data;
}

async function fetchFormLeads() {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const formId = process.env.FB_FORM_ID;

    if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    if (!formId) throw new Error("Missing FB_FORM_ID");

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${formId}`;

    try {
        const response = await axios.get(url, {
            params: {
                fields: "leads{id,created_time,field_data}",
                access_token: token,
                limit: 25,
            },
        });

        return response.data?.leads?.data || [];
    } catch (err) {
        console.error("❌ Facebook API error status:", err.response?.status);
        console.error("❌ Facebook API error data:", JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

async function debugFacebookForm() {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const formId = process.env.FB_FORM_ID;

    if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    if (!formId) throw new Error("Missing FB_FORM_ID");

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${formId}`;

    try {
        const response = await axios.get(url, {
            params: {
                fields: "id,name,status",
                access_token: token,
            },
        });

        return response.data;
    } catch (err) {
        console.error("❌ Facebook form debug error:", JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

async function debugLeadgenForms() {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FB_PAGE_ID;

    if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    if (!pageId) throw new Error("Missing FB_PAGE_ID");

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/leadgen_forms`;

    try {
        const response = await axios.get(url, {
            params: {
                fields: "id,name,status",
                limit: 100,
                access_token: token,
            },
        });

        return response.data;
    } catch (err) {
        console.error("❌ Facebook forms list error:", JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

async function debugFacebookAccess() {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FB_PAGE_ID;

    if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    if (!pageId) throw new Error("Missing FB_PAGE_ID");

    const pageUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`;
    const formsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/leadgen_forms`;

    const [pageResponse, formsResponse] = await Promise.all([
        axios.get(pageUrl, {
            params: {
                fields: "id,name",
                access_token: token,
            },
        }),
        axios.get(formsUrl, {
            params: {
                fields: "id,name,status",
                limit: 100,
                access_token: token,
            },
        }),
    ]);

    return {
        page: pageResponse.data,
        forms_count: formsResponse.data?.data?.length || 0,
        forms: formsResponse.data?.data || [],
    };
}

async function fetchLatestLeadIdsFromPage(options = {}) {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FB_PAGE_ID;

    const maxLeads = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
        ? Number(options.limit)
        : null;

    if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    if (!pageId) throw new Error("Missing FB_PAGE_ID");

    const formsUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/leadgen_forms`;

    try {
        const formsResponse = await axios.get(formsUrl, {
            params: {
                fields: "id,name,status",
                limit: 100,
                access_token: token,
            },
        });

        const forms = formsResponse.data?.data || [];
        const leads = [];

        console.log(`📋 Lead forms found: ${forms.length}`);

        for (const form of forms) {
            let nextUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${form.id}/leads`;
            let pageCount = 0;

            while (nextUrl) {
                pageCount++;

                if (pageCount > 50) {
                    console.warn(`⚠️ Stop pagination for form ${form.id}: max page limit reached`);
                    break;
                }

                const leadResponse = await axios.get(nextUrl, {
                    params: nextUrl.includes("?")
                        ? {}
                        : {
                            fields: "id,created_time",
                            limit: 100,
                            access_token: token,
                        },
                });

                const formLeads = leadResponse.data?.data || [];

                for (const lead of formLeads) {
                    leads.push({
                        id: lead.id,
                        created_time: lead.created_time,
                        form_id: form.id,
                        form_name: form.name,
                    });

                    if (maxLeads && leads.length >= maxLeads) {
                        console.log(`📌 Lead fetch limit reached: ${maxLeads}`);
                        return leads;
                    }
                }

                nextUrl = leadResponse.data?.paging?.next || null;
            }

            console.log(`✅ Form scanned: ${form.name} (${form.id})`);
        }

        console.log(`📥 Total lead refs fetched: ${leads.length}`);

        return leads;
    } catch (err) {
        console.error("❌ Facebook paginated lead query error:", JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

module.exports = {
    fetchLeadDetail,
    fetchFormLeads,
    debugFacebookForm,
    debugLeadgenForms,
    debugFacebookAccess,
    fetchLatestLeadIdsFromPage,
};