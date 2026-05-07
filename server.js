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

function normalizeProvince(rawProvince) {
    const raw = String(rawProvince || "").trim();
    if (!raw) return { province: "UNKNOWN", rawProvince: "" };

    const normalizeKey = (value) => String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^จังหวัด/i, "")
        .replace(/^changwat/i, "")
        .replace(/^provinceof/i, "")
        .replace(/province$/i, "")
        .replace(/[.\-_/(),'"`’‘“”]/g, "")
        .replace(/\s+/g, "");

    const cleaned = normalizeKey(raw);
    if (!cleaned) return { province: "UNKNOWN", rawProvince: raw };

    const provinceAliases = {
        "กรุงเทพมหานคร": ["กทม", "กทม.", "กรุงเทพ", "กรุงเทพฯ", "bangkok", "bkk"],
        "กระบี่": ["krabi"],
        "กาญจนบุรี": ["kanchanaburi"],
        "กาฬสินธุ์": ["kalasin"],
        "กำแพงเพชร": ["kamphaengphet", "kamphaeng phet"],
        "ขอนแก่น": ["khonkaen", "khon kaen"],
        "จันทบุรี": ["chanthaburi"],
        "ฉะเชิงเทรา": ["chachoengsao"],
        "ชลบุรี": ["chonburi", "chon buri"],
        "ชัยนาท": ["chainat", "chai nat"],
        "ชัยภูมิ": ["chaiyaphum"],
        "ชุมพร": ["chumphon"],
        "เชียงราย": ["chiangrai", "chiang rai"],
        "เชียงใหม่": ["chiangmai", "chiang mai"],
        "ตรัง": ["trang"],
        "ตราด": ["trat"],
        "ตาก": ["tak"],
        "นครนายก": ["nakhonnayok", "nakhon nayok"],
        "นครปฐม": ["nakhonpathom", "nakhon pathom"],
        "นครพนม": ["nakhonphanom", "nakhon phanom"],
        "นครราชสีมา": ["nakhonratchasima", "nakhon ratchasima", "korat"],
        "นครศรีธรรมราช": ["nakhonsithammarat", "nakhon si thammarat"],
        "นครสวรรค์": ["nakhonsawan", "nakhon sawan"],
        "นนทบุรี": ["nonthaburi"],
        "นราธิวาส": ["narathiwat"],
        "น่าน": ["nan"],
        "บึงกาฬ": ["buengkan", "bueng kan"],
        "บุรีรัมย์": ["buriram", "buri ram"],
        "ปทุมธานี": ["pathumthani", "pathum thani"],
        "ประจวบคีรีขันธ์": ["prachuapkhirikhan", "prachuap khiri khan"],
        "ปราจีนบุรี": ["prachinburi", "prachin buri"],
        "ปัตตานี": ["pattani"],
        "พระนครศรีอยุธยา": ["phranakhonsiayutthaya", "phra nakhon si ayutthaya", "ayutthaya"],
        "พังงา": ["phangnga", "phang nga"],
        "พัทลุง": ["phatthalung"],
        "พิจิตร": ["phichit"],
        "พิษณุโลก": ["phitsanulok"],
        "เพชรบุรี": ["phetchaburi"],
        "เพชรบูรณ์": ["phetchabun"],
        "แพร่": ["phrae"],
        "พะเยา": ["phayao"],
        "ภูเก็ต": ["phuket"],
        "มหาสารคาม": ["mahasarakham", "maha sarakham"],
        "มุกดาหาร": ["mukdahan"],
        "แม่ฮ่องสอน": ["maehongson", "mae hong son"],
        "ยโสธร": ["yasothon"],
        "ยะลา": ["yala"],
        "ร้อยเอ็ด": ["roiet", "roi et"],
        "ระนอง": ["ranong"],
        "ระยอง": ["rayong"],
        "ราชบุรี": ["ratchaburi"],
        "ลพบุรี": ["lopburi", "lop buri"],
        "ลำปาง": ["lampang"],
        "ลำพูน": ["lamphun"],
        "เลย": ["loei"],
        "ศรีสะเกษ": ["sisaket", "si sa ket"],
        "สกลนคร": ["sakonnakhon", "sakon nakhon"],
        "สงขลา": ["songkhla"],
        "สตูล": ["satun"],
        "สมุทรปราการ": ["samutprakan", "samut prakan"],
        "สมุทรสงคราม": ["samutsongkhram", "samut songkhram"],
        "สมุทรสาคร": ["samutsakhon", "samut sakhon"],
        "สระแก้ว": ["sakaeo", "sa kaeo"],
        "สระบุรี": ["saraburi"],
        "สิงห์บุรี": ["singburi", "sing buri"],
        "สุโขทัย": ["sukhothai"],
        "สุพรรณบุรี": ["suphanburi", "suphan buri"],
        "สุราษฎร์ธานี": ["suratthani", "surat thani"],
        "สุรินทร์": ["surin"],
        "หนองคาย": ["nongkhai", "nong khai"],
        "หนองบัวลำภู": ["nongbualamphu", "nong bua lamphu"],
        "อ่างทอง": ["angthong", "ang thong"],
        "อำนาจเจริญ": ["amnatcharoen", "amnat charoen"],
        "อุดรธานี": ["udonthani", "udon thani"],
        "อุตรดิตถ์": ["uttaradit"],
        "อุทัยธานี": ["uthaithani", "uthai thani"],
        "อุบลราชธานี": ["ubonratchathani", "ubon ratchathani"],
    };

    for (const [officialName, aliases] of Object.entries(provinceAliases)) {
        const acceptedValues = [officialName, ...aliases].map(normalizeKey);
        if (acceptedValues.includes(cleaned)) {
            return { province: officialName, rawProvince: raw };
        }
    }

    return { province: "UNKNOWN", rawProvince: raw };
}

function normalizePreferredCallValues(values, exactLabels) {
    const normalizeDisplayValue = (value) => String(value || "")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const normalizeMatchKey = (value) => normalizeDisplayValue(value)
        .toLowerCase()
        .replace(/\s+/g, "");

    const labelByKey = exactLabels.reduce((map, label) => {
        map[normalizeMatchKey(label)] = label;
        return map;
    }, {});

    return values
        .map(normalizeDisplayValue)
        .filter(Boolean)
        .map(value => labelByKey[normalizeMatchKey(value)] || value)
        .join(", ");
}

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

    const getValues = (...names) => {
        const normalizedNames = names.map(n => String(n).toLowerCase());

        const found = fieldData.find(item => {
            const itemName = String(item.name || "").toLowerCase();
            return normalizedNames.includes(itemName);
        });

        return Array.isArray(found?.values) ? found.values : [];
    };

    const name = getValue("full_name", "name", "first_name");
    const phone = getValue("phone_number", "phone", "mobile_phone");

    const rawProvince = getValue("province");
    const provinceResult = normalizeProvince(rawProvince);
    const province = provinceResult.province;

    const preferred_call_day = normalizePreferredCallValues(
        getValues(
            "วันที่สะดวกให้ติดต่อกลับ",
            "วันที่สะดวกให้เจ้าหน้าที่ติดต่อกลับ",
            "preferred_call_day"
        ),
        [
            "วันจันทร์ - ศุกร์ (วันธรรมดา)",
            "วันเสาร์ - อาทิตย์ (วันหยุด)",
            "สะดวกทุกวัน",
        ]
    );

    const preferred_call_time = normalizePreferredCallValues(
        getValues(
            "ช่วงเวลาที่สะดวกให้เจ้าหน้าที่ติดต่อกลับ",
            "เวลาที่สะดวกให้โทรสาย",
            "เวลาที่สะดวกโทรกลับ",
            "ช่วงเวลาที่สะดวกให้ติดต่อกลับ",
            "preferred_call_time"
        ),
        [
            "ช่วงเช้า (09:00 - 12:00 น.)",
            "ช่วงบ่าย (12:00 - 17:00 น.)",
            "ช่วงค่ำ (17:00 - 20:00 น.)",
            "สะดวกทุกช่วงเวลา",
        ]
    );

    const inbox_url = getValue("inbox_url", "Inbox URL");

    return {
        name,
        phone,
        province,
        raw_province: provinceResult.rawProvince,
        preferred_call_day,
        preferred_call_time,
        inbox_url,
        note: "",
        additional_note: provinceResult.rawProvince && provinceResult.rawProvince !== province
            ? `Raw province input: ${provinceResult.rawProvince}`
            : ""
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
                    lead.facebook_campaign_name = leadData.campaign_name || "";
                    lead.facebook_adset_name = leadData.adset_name || "";
                    lead.raw_data_json = JSON.stringify(leadData);

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
                lead.facebook_campaign_name = leadData.campaign_name || "";
                lead.facebook_adset_name = leadData.adset_name || "";
                lead.raw_data_json = JSON.stringify(leadData);

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
            affected_rows: batchResult.affected_rows || [],
            incremental_cleanup_attempted: batchResult.incremental_cleanup_attempted || false,
            incremental_cleanup_rows: batchResult.incremental_cleanup_rows || 0,
            full_cleanup_required: batchResult.full_cleanup_required || false,
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

        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];

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
                if (index < 2) return false;
                const leadObject = googleSheets.rowToObject(leadHeaders, leadRow);
                const existingPhone = googleSheets.normalizePhone(leadObject.phone);
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
                        existing_lead_id: googleSheets.rowToObject(leadHeaders, existingLead).lead_id || "",
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
