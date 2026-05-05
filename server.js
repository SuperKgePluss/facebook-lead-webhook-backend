require("dotenv").config();

const express = require("express");
const {
    fetchLeadDetail,
    fetchFormLeads,
    debugFacebookForm,
    debugLeadgenForms,
    debugFacebookAccess,
    fetchLatestLeadIdsFromPage,
} = require("./services/facebook");

const {
    appendLeadToSheet,
    appendLeadsToSheetBatch,
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
        const normalizedNames = names.map(n => String(n).toLowerCase());

        const found = fieldData.find(item => {
            const itemName = String(item.name || "").toLowerCase();
            return normalizedNames.includes(itemName);
        });

        return found?.values?.[0] || "";
    };

    const name = getValue("full_name", "name", "first_name");
    const phone = getValue("phone_number", "phone", "mobile_phone");
    const province = getValue("province");

    const preferredCallDay = getValue(
        "วันที่สะดวกให้ติดต่อกลับ",
        "preferred_call_day",
        "preferred call day"
    );

    const preferredCallTime = getValue(
        "ช่วงเวลาที่สะดวกให้เจ้าหน้าที่ติดต่อกลับ",
        "preferred_call_time",
        "preferred call time"
    );

    const inboxUrl = getValue("inbox_url", "Inbox URL");

    const noteParts = [
        province && `จังหวัด: ${province}`,
        preferredCallDay && `วันที่สะดวกให้ติดต่อกลับ: ${preferredCallDay}`,
        preferredCallTime && `ช่วงเวลาที่สะดวกให้ติดต่อกลับ: ${preferredCallTime}`,
        inboxUrl && `Inbox URL: ${inboxUrl}`,
    ].filter(Boolean);

    return {
        name,
        phone,
        note: noteParts.join("\n"),
        additional_note: noteParts.join("\n"),
    };
}

function formatDateTimeForSheet(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

function requireSyncSecret(req, res) {
    if (!process.env.SYNC_SECRET) {
        console.error("❌ Missing SYNC_SECRET in environment variables");

        res.status(500).json({
            success: false,
            error: "Server misconfigured: missing SYNC_SECRET",
        });

        return false;
    }

    const incomingSecret = String(req.query.secret || "").trim();

    if (incomingSecret !== process.env.SYNC_SECRET) {
        console.warn("⛔ Unauthorized attempt");

        res.status(401).json({
            success: false,
            error: "Unauthorized",
        });

        return false;
    }

    return true;
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
                    const lead = parseFacebookLead(leadData);

                    lead.source = "Facebook";
                    lead.facebook_leadgen_id = String(leadData.id || leadgenId).trim();
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

                    const result = await appendLeadToSheet(lead);

                    console.log("✅ Webhook lead processed:", leadgenId, result);
                } catch (err) {
                    console.error("❌ Webhook lead process failed:", leadgenId, err.message);
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
        if (!requireSyncSecret(req, res)) return;

        const mode = String(req.query.mode || "").trim().toLowerCase();
        const limitQuery = Number(req.query.limit);
        const limit = mode === "full"
            ? null
            : Number.isFinite(limitQuery) && limitQuery > 0
                ? limitQuery
                : null;

        console.log("🔄 Facebook lead batch sync started");
        console.log(`⚙️ Sync mode: ${mode || "default"}`);
        console.log(`⚙️ Sync limit: ${limit || "none"}`);

        const leadRefs = await fetchLatestLeadIdsFromPage({ limit });

        console.log(`📥 Facebook lead refs fetched: ${leadRefs.length}`);

        const parsedLeads = [];
        const failedItems = [];
        let skipped_empty = 0;

        for (const leadRef of leadRefs) {
            const leadgenId = String(leadRef.id || "").trim();

            if (!leadgenId) {
                skipped_empty++;
                failedItems.push({
                    leadgen_id: "",
                    reason: "missing_leadgen_id",
                });
                continue;
            }

            try {
                const leadData = await fetchLeadDetail(leadgenId);
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
                    skipped_empty++;
                    failedItems.push({
                        leadgen_id: leadgenId,
                        reason: "missing_facebook_leadgen_id",
                    });
                    continue;
                }

                if (!lead.phone && !lead.name) {
                    skipped_empty++;
                    failedItems.push({
                        leadgen_id: leadgenId,
                        reason: "missing_phone_and_name",
                    });
                    continue;
                }

                parsedLeads.push(lead);
            } catch (err) {
                failedItems.push({
                    leadgen_id: leadgenId,
                    form_id: leadRef.form_id || "",
                    form_name: leadRef.form_name || "",
                    reason: err.message,
                });

                console.error(`❌ Lead parse/fetch failed: ${leadgenId} - ${err.message}`);
            }
        }

        const batchResult = await appendLeadsToSheetBatch(parsedLeads);

        const failed = failedItems.length;

        return res.status(200).json({
            success: true,
            mode: mode || "default",
            limit: limit || null,
            fetched: leadRefs.length,
            parsed: parsedLeads.length,
            inserted: batchResult.created,
            updated_existing: batchResult.updated_existing,
            skipped_existing: batchResult.skipped_existing,
            skipped_empty: skipped_empty + batchResult.skipped_empty,
            failed,
            failed_items: failedItems.slice(0, 30),
            batch_skipped_empty_items: batchResult.skipped_empty_items.slice(0, 30),
        });
    } catch (err) {
        console.error("❌ Facebook lead batch sync failed:", err.message);

        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

app.get("/debug/facebook-access", async (req, res) => {
    try {
        if (!requireSyncSecret(req, res)) return;

        const result = await debugFacebookAccess();

        return res.status(200).json({
            success: true,
            result,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.response?.data || err.message,
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

function mapLegacySource(source) {
    const value = String(source || "").trim().toLowerCase();

    if (value.includes("lead gen")) return "Facebook";
    if (value.includes("fb chat")) return "Messenger";
    if (value.includes("messenger")) return "Messenger";
    if (value.includes("website")) return "Website";

    return "Legacy Import";
}

function mapLegacyClassification(classification) {
    const value = String(classification || "").trim().toLowerCase();

    if (value === "hot") return "Interested";
    if (value === "warm") return "Contacted";
    if (value === "cold") return "New";
    if (value === "not interested") return "Not Interested";
    if (value === "purchased") return "Closed";

    return "New";
}

app.post("/import/legacy", async (req, res) => {
    const dryRun = String(req.query.dry_run || "false") === "true";

    try {
        const googleSheets = require("./services/googleSheets");
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();

        const rawRows = await googleSheets.readSheet(
            sheets,
            spreadsheetId,
            "IMPORT_RAW!A:Z"
        );

        const leadsRows = await googleSheets.readSheet(
            sheets,
            spreadsheetId,
            "LEADS_MAIN!A:L"
        );

        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        const preview = [];

        const seenImportPhones = new Set();

        for (let i = 1; i < rawRows.length; i++) {
            const row = rawRows[i];

            const source = String(row[0] || "").trim();
            const rawMessage = String(row[1] || "").trim();
            const leadInDate = String(row[2] || "").trim();
            const salesperson = String(row[3] || "").trim();
            const name = String(row[4] || "").trim();
            const phone = String(row[5] || "").trim();
            const province = String(row[7] || "").trim();
            const preferredCallDay = String(row[9] || "").trim();
            const preferredCallTime = String(row[10] || "").trim();
            const classification = String(row[20] || "").trim();

            const cleanPhone = googleSheets.normalizePhone(phone);

            if (!cleanPhone) {
                skipped++;
                preview.push({
                    row: i + 1,
                    action: "skipped",
                    reason: "missing phone",
                });
                continue;
            }

            if (seenImportPhones.has(cleanPhone)) {
                skipped++;
                preview.push({
                    row: i + 1,
                    action: "skipped",
                    reason: "duplicate phone in import file",
                    phone,
                    name,
                });
                continue;
            }

            seenImportPhones.add(cleanPhone);

            const existingLead = leadsRows.find((leadRow, index) => {
                if (index === 0) return false;
                const existingPhone = googleSheets.normalizePhone(leadRow[1]);
                return cleanPhone && existingPhone === cleanPhone;
            });

            const noteParts = [
                rawMessage && `Legacy message: ${rawMessage}`,
                leadInDate && `Lead in date: ${leadInDate}`,
                province && `Province: ${province}`,
                preferredCallDay && `Preferred call day: ${preferredCallDay}`,
                preferredCallTime && `Preferred call time: ${preferredCallTime}`,
            ].filter(Boolean);

            const lead = {
                phone,
                name,
                source: mapLegacySource(source),
                status: mapLegacyClassification(classification),
                sales_owner: salesperson,
                note: [
                    `Original source: ${source || "-"}`,
                    classification && `Original classification: ${classification}`,
                    noteParts.join("\n"),
                ].filter(Boolean).join("\n"),
                additional_note: noteParts.join("\n"),
            };

            if (dryRun) {
                if (existingLead) {
                    updated++;
                    preview.push({
                        row: i + 1,
                        action: "would_update",
                        phone,
                        name,
                        existing_lead_id: existingLead[0] || "",
                    });
                } else {
                    inserted++;
                    preview.push({
                        row: i + 1,
                        action: "would_insert",
                        phone,
                        name,
                    });
                }

                continue;
            }

            const result = await googleSheets.appendLeadToSheet(lead);

            if (result?.action === "created") {
                inserted++;
            } else if (
                result?.action === "updated_existing" ||
                result?.action === "created_new_deal_for_existing_lead"
            ) {
                updated++;
            } else {
                skipped++;
            }

            preview.push({
                row: i + 1,
                action: result?.action || "unknown",
                phone,
                name,
                lead_id: result?.lead_id || "",
                deal_id: result?.deal_id || "",
            });
        }

        return res.json({
            success: true,
            dryRun,
            inserted,
            updated,
            skipped,
            preview,
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