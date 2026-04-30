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

module.exports = {
    fetchLeadDetail,
};