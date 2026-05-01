const axios = require("axios");

async function fetchLeadDetail(leadgenId) {
    if (!leadgenId) {
        throw new Error("Missing leadgenId");
    }

    const token = process.env.FB_PAGE_ACCESS_TOKEN;

    if (!token) {
        throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    }

    const url = `https://graph.facebook.com/v25.0/${leadgenId}`;

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

    const url = `https://graph.facebook.com/v25.0/${formId}`;

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

    if (!token) {
        throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    }

    if (!formId) {
        throw new Error("Missing FB_FORM_ID");
    }

    const url = `https://graph.facebook.com/v25.0/${formId}`;

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

    if (!token) {
        throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    }

    if (!pageId) {
        throw new Error("Missing FB_PAGE_ID");
    }

    const url = `https://graph.facebook.com/v25.0/${pageId}/leadgen_forms`;

    try {
        const response = await axios.get(url, {
            params: {
                fields: "id,name,status",
                access_token: token,
            },
        });

        return response.data;
    } catch (err) {
        console.error("❌ Facebook forms list error:", JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

async function fetchLatestLeadIdsFromPage() {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FB_PAGE_ID;

    if (!token) throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    if (!pageId) throw new Error("Missing FB_PAGE_ID");

    const url = `https://graph.facebook.com/v25.0/${pageId}`;

    try {
        const response = await axios.get(url, {
            params: {
                fields: "leadgen_forms.limit(10){id,name,leads.limit(25){id,created_time}}",
                access_token: token,
            },
        });

        const forms = response.data?.leadgen_forms?.data || [];
        const leads = [];

        for (const form of forms) {
            const formLeads = form?.leads?.data || [];

            for (const lead of formLeads) {
                leads.push({
                    id: lead.id,
                    created_time: lead.created_time,
                    form_id: form.id,
                    form_name: form.name,
                });
            }
        }

        return leads;
    } catch (err) {
        console.error("❌ Facebook nested lead query error:", JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
    }
}

module.exports = {
    fetchLeadDetail,
    fetchFormLeads,
    debugFacebookForm,
    debugLeadgenForms,
    fetchLatestLeadIdsFromPage,
};