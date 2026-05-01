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

    if (!token) {
        throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    }

    if (!formId) {
        throw new Error("Missing FB_FORM_ID");
    }

    const url = `https://graph.facebook.com/v25.0/${formId}/leads`;

    try {
        const response = await axios.get(url, {
            params: {
                fields: "id,created_time,field_data",
                access_token: token,
                limit: 25,
            },
        });

        return response.data?.data || [];
    } catch (err) {
        console.error("❌ Facebook API error status:", err.response?.status);
        console.error("❌ Facebook API error data:", JSON.stringify(err.response?.data, null, 2));

        throw new Error(
            err.response?.data?.error?.message || err.message
        );
    }
}

module.exports = {
    fetchLeadDetail,
    fetchFormLeads,
};