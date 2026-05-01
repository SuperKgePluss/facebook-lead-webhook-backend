require("dotenv").config();

const { fetchLeadDetail, fetchFormLeads, debugFacebookForm } = require("./services/facebook");
const { appendLeadToSheet } = require("./services/googleSheets");
const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;

function parseFacebookLead(leadData) {
    const fieldData = leadData?.field_data;

    if (!Array.isArray(fieldData) || fieldData.length === 0) {
        throw new Error("Missing field_data");
    }

    const getValue = (...names) => {
        const found = fieldData.find(item => names.includes(item.name));
        return found?.values?.[0] || "";
    };

    return {
        name: getValue("full_name", "name", "first_name"),
        phone: getValue("phone_number", "phone", "mobile_phone"),
    };
}

app.get("/health", (req, res) => {
    return res.status(200).send("OK");
});

app.get("/webhook/facebook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
        console.log("Facebook webhook verified");
        return res.status(200).send(challenge);
    }

    console.warn("Facebook webhook verification failed");
    return res.sendStatus(403);
});

app.post("/webhook/facebook", async (req, res) => {
    try {
        console.log("Facebook webhook event received:");
        console.log(JSON.stringify(req.body, null, 2));

        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];

        if (change?.field === "leadgen") {
            const leadgenId = change.value?.leadgen_id;

            console.log("Leadgen ID:", leadgenId);

            if (leadgenId) {
                let lead = null;

                try {
                    const leadData = await fetchLeadDetail(leadgenId);

                    console.log("=== LEAD DETAIL ===");
                    console.log(JSON.stringify(leadData, null, 2));

                    lead = parseFacebookLead(leadData);

                    if (!lead.phone && !lead.name) {
                        throw new Error("Parsed lead is empty");
                    }
                } catch (err) {
                    console.warn("Fetch/parse lead detail failed, using mock lead:", err.message);

                    lead = {
                        name: "Mock Facebook Lead",
                        phone: "0899999999",
                    };
                }

                await appendLeadToSheet(lead);
            }
        }

        return res.sendStatus(200);
    } catch (err) {
        console.error("Webhook error:", err.message);
        return res.sendStatus(200);
    }
});

app.get("/sync/facebook-leads", async (req, res) => {
    try {
        console.log("🔄 Facebook lead sync started");

        const leads = await fetchFormLeads();

        console.log(`📥 Facebook leads fetched: ${leads.length}`);

        let inserted = 0;
        let failed = 0;

        for (const leadData of leads) {
            try {
                console.log("=== PULLED LEAD ===");
                console.log(JSON.stringify(leadData, null, 2));

                const lead = parseFacebookLead(leadData);

                lead.source = "Facebook";
                lead.facebook_leadgen_id = leadData.id || "";
                lead.facebook_created_time = leadData.created_time || "";
                lead.facebook_form_id = leadData.form_id || "";
                lead.facebook_ad_id = leadData.ad_id || "";
                lead.facebook_campaign_id = leadData.campaign_id || "";

                if (!lead.phone && !lead.name) {
                    console.warn("⚠️ Skipped empty lead:", leadData.id);
                    failed++;
                    continue;
                }

                await appendLeadToSheet(lead);
                inserted++;
            } catch (err) {
                failed++;
                console.error("❌ Lead sync item failed:", err.message);
            }
        }

        return res.status(200).json({
            success: true,
            fetched: leads.length,
            inserted,
            failed,
        });
    } catch (err) {
        console.error("❌ Facebook lead sync failed:", err.message);

        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

app.get("/debug/facebook-form", async (req, res) => {
    try {
        const result = await debugFacebookForm();

        return res.status(200).json({
            success: true,
            form: result,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});