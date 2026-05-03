require("dotenv").config();

const express = require("express");
const {
    fetchLeadDetail,
    fetchFormLeads,
    debugFacebookForm,
    debugLeadgenForms,
    fetchLatestLeadIdsFromPage,
} = require("./services/facebook");

const {
    appendLeadToSheet,
    getExistingLeadgenIds,
} = require("./services/googleSheets");

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

        const entries = req.body.entry || [];

        for (const entry of entries) {
            const changes = entry.changes || [];

            for (const change of changes) {
                if (change?.field !== "leadgen") {
                    continue;
                }

                const leadgenId = change.value?.leadgen_id;

                if (!leadgenId) {
                    console.warn("⚠️ Webhook missing leadgen_id → skip");
                    continue;
                }

                try {
                    console.log("Webhook Leadgen ID:", leadgenId);

                    const leadData = await fetchLeadDetail(leadgenId);

                    console.log("=== WEBHOOK LEAD DETAIL ===");
                    console.log(JSON.stringify(leadData, null, 2));

                    const lead = parseFacebookLead(leadData);

                    lead.source = "Facebook";
                    lead.facebook_leadgen_id = leadData.id || leadgenId;
                    lead.facebook_created_time = leadData.created_time
                        ? formatDateTimeForSheet(new Date(leadData.created_time))
                        : "";
                    lead.facebook_form_id = leadData.form_id || "";
                    lead.facebook_form_name = "";
                    lead.facebook_ad_id = leadData.ad_id || "";
                    lead.facebook_campaign_id = leadData.campaign_id || "";

                    if (!lead.facebook_leadgen_id) {
                        console.warn("⚠️ Webhook lead has no facebook_leadgen_id → skip");
                        continue;
                    }

                    if (!lead.phone && !lead.name) {
                        console.warn("⚠️ Webhook parsed lead is empty → skip:", leadgenId);
                        continue;
                    }

                    await appendLeadToSheet(lead);

                    console.log("✅ Webhook lead processed:", leadgenId);
                } catch (err) {
                    console.error("❌ Webhook lead process failed:", err.message);
                }
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
        // ✅ Block public access to sync endpoint
        if (!process.env.SYNC_SECRET) {
            console.error("❌ Missing SYNC_SECRET in environment variables");

            return res.status(500).json({
                success: false,
                error: "Server misconfigured: missing SYNC_SECRET",
            });
        }

        const incomingSecret = String(req.query.secret || "").trim();

        if (incomingSecret !== process.env.SYNC_SECRET) {
            console.warn("⛔ Unauthorized sync attempt");

            return res.status(401).json({
                success: false,
                error: "Unauthorized",
            });
        }

        console.log("🔄 Facebook lead sync started");

        const leadRefs = await fetchLatestLeadIdsFromPage();

        console.log(`📥 Facebook lead refs fetched: ${leadRefs.length}`);

        let inserted = 0;
        let updated_existing = 0;
        let skipped_existing = 0;
        let skipped_empty = 0;
        let failed = 0;

        const existingIds = await getExistingLeadgenIds();

        for (const leadRef of leadRefs) {
            try {
                const leadgenId = String(leadRef.id || "").trim();

                if (!leadgenId) {
                    console.warn("⚠️ Missing leadgen_id → skip");
                    skipped_empty++;
                    continue;
                }

                if (existingIds.has(leadgenId)) {
                    console.log(`⏭️ Skipped existing leadgen_id: ${leadgenId}`);
                    skipped_existing++;
                    continue;
                }

                console.log("=== LEAD REF ===");
                console.log(JSON.stringify(leadRef, null, 2));

                const leadData = await fetchLeadDetail(leadgenId);

                console.log("=== LEAD DETAIL ===");
                console.log(JSON.stringify(leadData, null, 2));

                const lead = parseFacebookLead(leadData);

                lead.source = "Facebook";
                lead.facebook_leadgen_id = String(leadData.id || leadgenId).trim();
                lead.facebook_created_time = leadData.created_time
                    ? formatDateTimeForSheet(new Date(leadData.created_time))
                    : "";
                lead.facebook_form_id = leadData.form_id || leadRef.form_id || "";
                lead.facebook_form_name = leadRef.form_name || "";
                lead.facebook_ad_id = leadData.ad_id || "";
                lead.facebook_campaign_id = leadData.campaign_id || "";

                if (!lead.facebook_leadgen_id) {
                    console.warn("⚠️ Lead has no facebook_leadgen_id → skip");
                    skipped_empty++;
                    continue;
                }

                if (!lead.phone && !lead.name) {
                    console.warn("⚠️ Skipped empty lead:", leadgenId);
                    skipped_empty++;
                    continue;
                }

                const result = await appendLeadToSheet(lead);

                existingIds.add(leadgenId);

                if (result?.action === "created") {
                    inserted++;
                } else {
                    updated_existing++;
                }
            } catch (err) {
                failed++;
                console.error("❌ Lead sync item failed:", err.message);
            }
        }

        return res.status(200).json({
            success: true,
            fetched: leadRefs.length,
            inserted,
            updated_existing,
            skipped_existing,
            skipped_empty,
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

app.get("/debug/leadgen-forms", async (req, res) => {
    try {
        const result = await debugLeadgenForms();

        return res.status(200).json({
            success: true,
            result,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

app.get("/debug/facebook-form-raw", async (req, res) => {
    try {
        const formId = process.env.FB_FORM_ID;
        const token = process.env.FB_PAGE_ACCESS_TOKEN;

        const axios = require("axios");

        const response = await axios.get(`https://graph.facebook.com/v25.0/${formId}`, {
            params: {
                fields: "id,name,status,created_time,questions",
                access_token: token,
            },
        });

        return res.status(200).json({
            success: true,
            form: response.data,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
});

app.get("/debug/lead/:leadgenId", async (req, res) => {
    try {
        const leadData = await fetchLeadDetail(req.params.leadgenId);

        return res.status(200).json({
            success: true,
            lead: leadData,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.response?.data || err.message,
        });
    }
});

app.post("/import/legacy", async (req, res) => {
    const dryRun = String(req.query.dry_run || "false") === "true";

    try {
        const { sheets, spreadsheetId } = await require("./services/googleSheets").createSheetsClient();

        const rawRows = await require("./services/googleSheets").readSheet(
            sheets,
            spreadsheetId,
            "IMPORT_RAW!A:Z"
        );

        let inserted = 0;
        let updated = 0;
        let skipped = 0;

        for (let i = 1; i < rawRows.length; i++) {
            const row = rawRows[i];

            const phone = String(row[5] || "").trim(); // ← ปรับ index ตาม mapping จริง
            const name = String(row[4] || "").trim();

            if (!phone) {
                skipped++;
                continue;
            }

            const lead = {
                phone,
                name,
                source: "Legacy Import",
                note: "Imported from legacy sheet"
            };

            if (!dryRun) {
                const result = await appendLeadToSheet(lead);

                if (result?.action === "created") {
                    inserted++;
                }
                else if (
                    result?.action === "updated_existing" ||
                    result?.action === "created_new_deal_for_existing_lead"
                ) {
                    updated++;
                }
                else {
                    skipped++;
                }
            }
        }

        return res.json({
            success: true,
            dryRun,
            inserted,
            updated,
            skipped
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});