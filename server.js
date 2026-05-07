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

const LEGACY_IMPORT_FIELD_ALIASES = {
    source: ["Source"],
    lead_in_date: ["Lead In Date"],
    salesperson: ["Salesperson"],
    name: ["Name"],
    phone_number: ["Phone Number", "Phone", "Mobile Phone"],
    province: ["Province"],
    corporate_name: ["Corporate Name (if B2B)", "Corporate Name"],
    preferred_call_day: ["Preferred Call Day"],
    preferred_call_time: ["Preferred Call Time"],
    classification: ["Classification"],
    follow_up_1_date_time: ["Follow-up 1 Date/Time", "Follow up 1 Date/Time"],
    follow_up_1_details: ["Follow-up 1 Details", "Follow up 1 Details"],
    follow_up_2_date_time: ["Follow-up 2 Date/Time", "Follow up 2 Date/Time"],
    follow_up_2_details: ["Follow-up 2 Details", "Follow up 2 Details"],
    follow_up_3_date_time: ["Follow-up 3 Date/Time", "Follow up 3 Date/Time"],
    follow_up_3_details: ["Follow-up 3 Details", "Follow up 3 Details"],
    call_recording: ["Call Recording"],
    number_of_devices_bought: ["Number of Devices Bought"],
    which_package: ["Which Package"],
    amount_due: ["Amount Due"],
    amount_paid: ["Amount Paid"],
    payment_slip: ["Payment Slip"],
    installation_location: ["Installation Location"],
    installation_details: ["Installation Details"],
    installation_date: ["Installation Date"],
    installation_time: ["Installation Time"],
};

function getLegacyValue(rowObject, googleSheets, fieldName) {
    const aliases = LEGACY_IMPORT_FIELD_ALIASES[fieldName] || [];

    for (const alias of aliases) {
        const key = googleSheets.normalizeHeaderName(alias);
        const value = String(rowObject[key] || "").trim();

        if (value) return value;
    }

    return "";
}

function hasAnyValue(object) {
    return Object.values(object).some(value => String(value || "").trim() !== "");
}

function buildLegacyActivityPreviews(rowObject, googleSheets, leadId, audioUrl) {
    const activities = [];

    for (const followUpNo of [1, 2, 3]) {
        const details = getLegacyValue(rowObject, googleSheets, `follow_up_${followUpNo}_details`);
        const createdAt = getLegacyValue(rowObject, googleSheets, `follow_up_${followUpNo}_date_time`);

        if (!details) continue;

        activities.push({
            target_sheet: "ACTIVITY_LOG",
            action: "would_create_activity",
            lead_id: leadId || "(resolved after lead creation)",
            follow_up_no: followUpNo,
            action_type: "Follow-up",
            note: details,
            audio_url: audioUrl,
            created_at: createdAt,
        });
    }

    return activities;
}

function generateImportId(prefix) {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function putIfBlank(updateObject, existingObject, key, value) {
    const existingValue = String(existingObject?.[key] || "").trim();
    const incomingValue = String(value || "").trim();

    if (!existingValue && incomingValue) {
        updateObject[key] = incomingValue;
    }
}

function buildLegacyLeadObject(values, cleanPhone, leadId, existingLeadObject = null) {
    if (!existingLeadObject) {
        return {
            lead_id: leadId,
            customer_name: values.name,
            phone: cleanPhone,
            source: mapLegacySource(values.source),
            customer_type: values.corporateName,
            province: values.province,
            preferred_call_day: values.preferredCallDay,
            preferred_call_time: values.preferredCallTime,
            lead_status: mapLegacyClassification(values.classification),
            sales_owner: values.salesperson,
            created_at: values.leadInDate || new Date(),
            updated_at: new Date(),
        };
    }

    const updateObject = {
        updated_at: new Date(),
    };

    putIfBlank(updateObject, existingLeadObject, "customer_name", values.name);
    putIfBlank(updateObject, existingLeadObject, "phone", cleanPhone);
    putIfBlank(updateObject, existingLeadObject, "source", mapLegacySource(values.source));
    putIfBlank(updateObject, existingLeadObject, "customer_type", values.corporateName);
    putIfBlank(updateObject, existingLeadObject, "province", values.province);
    putIfBlank(updateObject, existingLeadObject, "preferred_call_day", values.preferredCallDay);
    putIfBlank(updateObject, existingLeadObject, "preferred_call_time", values.preferredCallTime);
    putIfBlank(updateObject, existingLeadObject, "lead_status", mapLegacyClassification(values.classification));
    putIfBlank(updateObject, existingLeadObject, "sales_owner", values.salesperson);
    putIfBlank(updateObject, existingLeadObject, "created_at", values.leadInDate);

    return updateObject;
}

function buildLegacyActivityObjects(activityPreviews, leadId, salesOwner) {
    return activityPreviews.map(activity => ({
        activity_id: generateImportId("ACT"),
        lead_id: leadId,
        follow_up_no: activity.follow_up_no,
        action_type: "Follow-up",
        result: "",
        note: activity.note,
        audio_url: activity.audio_url,
        audio_file_name: "",
        created_by: salesOwner,
        created_at: activity.created_at || new Date(),
    }));
}

app.post("/import/legacy", async (req, res) => {
    const dryRun = String(req.query.dry_run ?? "true").trim().toLowerCase() !== "false";

    try {
        const googleSheets = require("./services/googleSheets");
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();

        const rawRows = await googleSheets.readSheet(
            sheets,
            spreadsheetId,
            "IMPORT_RAW!A:ZZ"
        );

        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];

        const rawHeaders = rawRows[0] || [];
        const detectedHeaders = rawHeaders
            .map(header => String(header || "").trim())
            .filter(Boolean);
        const expectedHeaderKeys = new Set(
            Object.values(LEGACY_IMPORT_FIELD_ALIASES)
                .flat()
                .map(header => googleSheets.normalizeHeaderName(header))
        );
        const presentHeaderKeys = new Set(detectedHeaders.map(header => googleSheets.normalizeHeaderName(header)));
        const missingExpectedHeaders = Object.entries(LEGACY_IMPORT_FIELD_ALIASES)
            .filter(([, aliases]) => !aliases.some(alias => presentHeaderKeys.has(googleSheets.normalizeHeaderName(alias))))
            .map(([fieldName, aliases]) => ({
                field: fieldName,
                accepted_headers: aliases,
            }));
        const ignoredColumns = rawHeaders
            .map((header, index) => {
                const rawHeader = String(header || "").trim();
                const column = index + 1;

                if (!rawHeader) {
                    return {
                        column,
                        header: "",
                        reason: "blank_header",
                    };
                }

                if (!expectedHeaderKeys.has(googleSheets.normalizeHeaderName(rawHeader))) {
                    return {
                        column,
                        header: rawHeader,
                        reason: "unmapped_header",
                    };
                }

                return null;
            })
            .filter(Boolean);

        let rowsWithValidPhone = 0;
        let rowsMissingPhone = 0;
        let wouldCreateLead = 0;
        let wouldUpdateExistingLead = 0;
        let wouldCreateDeal = 0;
        let wouldCreateInstallation = 0;
        let wouldCreateActivity = 0;
        let manualReview = 0;
        const samplePreviewItems = [];
        let insertedLeads = 0;
        let updatedExistingLeads = 0;
        let createdActivities = 0;
        let skippedMissingPhone = 0;
        let skippedDuplicateOrExisting = 0;
        let failedRows = 0;
        const sampleResultItems = [];
        const pendingLeadCreates = [];
        const pendingLeadUpdates = [];
        const pendingActivityCreates = [];
        const knownLeadsByPhone = new Map();

        for (let i = 2; i < leadsRows.length; i++) {
            const leadObject = googleSheets.rowToObject(leadHeaders, leadsRows[i]);
            const existingPhone = googleSheets.normalizePhone(leadObject.phone);

            if (!existingPhone) continue;

            knownLeadsByPhone.set(existingPhone, {
                ...leadObject,
                rowNumber: i + 1,
            });
        }

        for (let i = 1; i < rawRows.length; i++) {
            const row = rawRows[i];
            if (!row || row.every(cell => String(cell || "").trim() === "")) continue;

            const rowObject = googleSheets.rowToObject(rawHeaders, row);
            const source = getLegacyValue(rowObject, googleSheets, "source");
            const leadInDate = getLegacyValue(rowObject, googleSheets, "lead_in_date");
            const salesperson = getLegacyValue(rowObject, googleSheets, "salesperson");
            const name = getLegacyValue(rowObject, googleSheets, "name");
            const phone = getLegacyValue(rowObject, googleSheets, "phone_number");
            const province = getLegacyValue(rowObject, googleSheets, "province");
            const corporateName = getLegacyValue(rowObject, googleSheets, "corporate_name");
            const preferredCallDay = getLegacyValue(rowObject, googleSheets, "preferred_call_day");
            const preferredCallTime = getLegacyValue(rowObject, googleSheets, "preferred_call_time");
            const classification = getLegacyValue(rowObject, googleSheets, "classification");
            const callRecording = getLegacyValue(rowObject, googleSheets, "call_recording");
            const numberOfDevicesBought = getLegacyValue(rowObject, googleSheets, "number_of_devices_bought");
            const whichPackage = getLegacyValue(rowObject, googleSheets, "which_package");
            const amountDue = getLegacyValue(rowObject, googleSheets, "amount_due");
            const amountPaid = getLegacyValue(rowObject, googleSheets, "amount_paid");
            const paymentSlip = getLegacyValue(rowObject, googleSheets, "payment_slip");
            const installationLocation = getLegacyValue(rowObject, googleSheets, "installation_location");
            const installationDetails = getLegacyValue(rowObject, googleSheets, "installation_details");
            const installationDate = getLegacyValue(rowObject, googleSheets, "installation_date");
            const installationTime = getLegacyValue(rowObject, googleSheets, "installation_time");

            const cleanPhone = googleSheets.normalizePhone(phone);

            if (!cleanPhone) {
                rowsMissingPhone++;
                manualReview++;
                skippedMissingPhone++;
                if (samplePreviewItems.length < 30) {
                    samplePreviewItems.push({
                        row: i + 1,
                        action: "manual_review",
                        reason: "missing_or_invalid_phone",
                        raw_data: rowObject,
                    });
                }
                if (!dryRun && sampleResultItems.length < 10) {
                    sampleResultItems.push({
                        row: i + 1,
                        action: "skipped",
                        reason: "missing_or_invalid_phone",
                    });
                }
                continue;
            }

            rowsWithValidPhone++;

            const existingLeadObject = knownLeadsByPhone.get(cleanPhone) || null;

            if (!dryRun && existingLeadObject && !existingLeadObject.rowNumber) {
                skippedDuplicateOrExisting++;

                if (sampleResultItems.length < 10) {
                    sampleResultItems.push({
                        row: i + 1,
                        action: "skipped_duplicate_or_existing",
                        phone: cleanPhone,
                        reason: "duplicate_phone_already_queued_for_import",
                    });
                }

                continue;
            }

            const leadId = existingLeadObject?.lead_id || "";
            const leadAction = existingLeadObject
                ? "would_update_existing_lead"
                : "would_create_lead";

            if (existingLeadObject) {
                wouldUpdateExistingLead++;
            } else {
                wouldCreateLead++;
            }

            const dealPreview = {
                target_sheet: "DEALS",
                action: "would_create_deal",
                lead_id: leadId || "(resolved after lead creation)",
                product_model_or_quantity_preview: numberOfDevicesBought,
                package_type: whichPackage,
                price: amountDue,
                paid_amount_preview: amountPaid,
                payment_status_preview: amountPaid ? "Paid/Partial - review amount" : "",
                payment_slip_url: paymentSlip,
            };

            const installationPreview = {
                target_sheet: "INSTALLATIONS",
                action: "would_create_installation",
                lead_id: leadId || "(resolved after lead creation)",
                zone_or_location_preview: installationLocation,
                note: installationDetails,
                install_date: installationDate,
                install_time: installationTime,
            };
            const hasDealData = hasAnyValue({
                numberOfDevicesBought,
                whichPackage,
                amountDue,
                amountPaid,
                paymentSlip,
            });
            const hasInstallationData = hasAnyValue({
                installationLocation,
                installationDetails,
                installationDate,
                installationTime,
            });

            const activityPreviews = buildLegacyActivityPreviews(
                rowObject,
                googleSheets,
                leadId,
                callRecording
            );

            if (hasDealData) {
                wouldCreateDeal++;
            }

            if (hasInstallationData) {
                wouldCreateInstallation++;
            }

            wouldCreateActivity += activityPreviews.length;

            if (samplePreviewItems.length < 30) {
                samplePreviewItems.push({
                    row: i + 1,
                    action: leadAction,
                    existing_lead_id: leadId,
                    normalized_phone: cleanPhone,
                    lead_preview: {
                        target_sheet: "LEADS_MAIN",
                        customer_name: name,
                        phone: cleanPhone,
                        source: mapLegacySource(source),
                        lead_status: mapLegacyClassification(classification),
                        sales_owner: salesperson,
                        province,
                        customer_type_or_raw_corporate_preview: corporateName,
                        preferred_call_day: preferredCallDay,
                        preferred_call_time: preferredCallTime,
                        created_at: leadInDate,
                    },
                    deal_preview: hasDealData ? dealPreview : null,
                    installation_preview: hasInstallationData ? installationPreview : null,
                    activity_previews: activityPreviews,
                    raw_data: rowObject,
                });
            }

            if (dryRun && !existingLeadObject) {
                knownLeadsByPhone.set(cleanPhone, {
                    lead_id: "(resolved after lead creation)",
                    phone: cleanPhone,
                });
            }

            if (!dryRun) {
                try {
                    const values = {
                        source,
                        leadInDate,
                        salesperson,
                        name,
                        province,
                        corporateName,
                        preferredCallDay,
                        preferredCallTime,
                        classification,
                    };
                    let resolvedLeadId = leadId;
                    let resultAction = "";

                    if (existingLeadObject) {
                        const updateObject = buildLegacyLeadObject(values, cleanPhone, resolvedLeadId, existingLeadObject);
                        pendingLeadUpdates.push({
                            rowNumber: existingLeadObject.rowNumber,
                            object: updateObject,
                        });
                        resultAction = "updated_existing_lead";
                    } else {
                        resolvedLeadId = generateImportId("LEAD");
                        const leadObject = buildLegacyLeadObject(values, cleanPhone, resolvedLeadId);
                        pendingLeadCreates.push(leadObject);
                        knownLeadsByPhone.set(cleanPhone, {
                            ...leadObject,
                            rowNumber: null,
                        });
                        resultAction = "inserted_lead";
                    }

                    const activityObjects = buildLegacyActivityObjects(activityPreviews, resolvedLeadId, salesperson);

                    if (activityObjects.length) {
                        pendingActivityCreates.push(...activityObjects);
                    }

                    if (sampleResultItems.length < 10) {
                        sampleResultItems.push({
                            row: i + 1,
                            action: resultAction,
                            lead_id: resolvedLeadId,
                            phone: cleanPhone,
                            created_activities: activityObjects.length,
                        });
                    }
                } catch (err) {
                    failedRows++;

                    if (sampleResultItems.length < 10) {
                        sampleResultItems.push({
                            row: i + 1,
                            action: "failed",
                            phone: cleanPhone,
                            error: err.message,
                        });
                    }
                }
            }
        }

        if (!dryRun) {
            for (const update of pendingLeadUpdates) {
                try {
                    await googleSheets.updateObjectRow("LEADS_MAIN", update.rowNumber, update.object);
                    updatedExistingLeads++;
                } catch (err) {
                    failedRows++;
                }
            }

            if (pendingLeadCreates.length) {
                try {
                    await googleSheets.appendObjects("LEADS_MAIN", pendingLeadCreates);
                    insertedLeads += pendingLeadCreates.length;
                } catch (err) {
                    for (const leadObject of pendingLeadCreates) {
                        try {
                            await googleSheets.appendObjects("LEADS_MAIN", [leadObject]);
                            insertedLeads++;
                        } catch (rowErr) {
                            failedRows++;
                        }
                    }
                }
            }

            if (pendingActivityCreates.length) {
                try {
                    await googleSheets.appendObjects("ACTIVITY_LOG", pendingActivityCreates);
                    createdActivities += pendingActivityCreates.length;
                } catch (err) {
                    for (const activityObject of pendingActivityCreates) {
                        try {
                            await googleSheets.appendObjects("ACTIVITY_LOG", [activityObject]);
                            createdActivities++;
                        } catch (rowErr) {
                            failedRows++;
                        }
                    }
                }
            }
        }

        return res.json({
            success: true,
            dry_run: dryRun,
            received_query: req.query,
            parsed_dry_run: dryRun,
            total_rows: rowsWithValidPhone + rowsMissingPhone,
            rows_with_valid_phone: rowsWithValidPhone,
            rows_missing_phone: rowsMissingPhone,
            would_create_lead: wouldCreateLead,
            would_update_existing_lead: wouldUpdateExistingLead,
            would_create_deal: wouldCreateDeal,
            would_create_installation: wouldCreateInstallation,
            would_create_activity: wouldCreateActivity,
            manual_review: manualReview,
            ignored_columns: ignoredColumns,
            detected_headers: detectedHeaders,
            missing_expected_headers: missingExpectedHeaders,
            sample_preview_items: samplePreviewItems,
            inserted_leads: insertedLeads,
            updated_existing_leads: updatedExistingLeads,
            created_activities: createdActivities,
            skipped_missing_phone: skippedMissingPhone,
            skipped_duplicate_or_existing: skippedDuplicateOrExisting,
            failed_rows: failedRows,
            sample_result_items: sampleResultItems,
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
