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

function normalizeMappingKey(value) {
    return String(value || "")
        .replace(/_/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function normalizeLooseMappingKey(value) {
    return normalizeMappingKey(value)
        .replace(/[.\-_/(),'"`’‘“”]/g, "")
        .replace(/\s+/g, "");
}

async function loadMappingRules(googleSheets) {
    const rows = await googleSheets.getSheetRows("MAPPING_RULES");
    const headers = rows[0] || [];
    const rules = new Map();
    const entriesByType = new Map();
    const ruleTypes = new Set();
    let loadedCount = 0;

    for (let i = 2; i < rows.length; i++) {
        const rowObject = googleSheets.rowToObject(headers, rows[i]);
        const ruleType = normalizeMappingKey(rowObject.rule_type);
        const inputValue = normalizeMappingKey(rowObject.input_value);
        const outputValue = String(rowObject.output_value || "").trim();

        if (!ruleType || !inputValue) continue;

        loadedCount++;
        ruleTypes.add(ruleType);

        const entry = {
            ruleType,
            inputValue,
            looseInputValue: normalizeLooseMappingKey(rowObject.input_value),
            outputValue,
        };

        if (!entriesByType.has(ruleType)) {
            entriesByType.set(ruleType, []);
        }

        entriesByType.get(ruleType).push(entry);
        rules.set(`${ruleType}::${entry.inputValue}`, outputValue);
        rules.set(`${ruleType}::${entry.looseInputValue}`, outputValue);
    }

    return {
        rules,
        entriesByType,
        loadedCount,
        ruleTypes: [...ruleTypes].sort(),
    };
}

function isInvalidByMappingRules(mappingRules, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return false;

    const normalized = normalizeMappingKey(raw);
    const loose = normalizeLooseMappingKey(raw);

    return mappingRules.rules.has(`invalid_value::${normalized}`)
        || mappingRules.rules.has(`invalid_value::${loose}`);
}

function normalizeByMappingRules(mappingRules, ruleType, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return "";
    if (isInvalidByMappingRules(mappingRules, raw)) return "";

    const normalizedRuleType = normalizeMappingKey(ruleType);

    if (normalizedRuleType === "province" && /^\d+$/.test(raw.replace(/\s+/g, ""))) {
        return "";
    }

    const exactKey = `${normalizedRuleType}::${normalizeMappingKey(raw)}`;
    const looseKey = `${normalizedRuleType}::${normalizeLooseMappingKey(raw)}`;

    if (mappingRules.rules.has(exactKey)) return mappingRules.rules.get(exactKey);
    if (mappingRules.rules.has(looseKey)) return mappingRules.rules.get(looseKey);

    return "";
}

function hasMappingRule(mappingRules, ruleType, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return false;

    const normalizedRuleType = normalizeMappingKey(ruleType);
    return mappingRules.rules.has(`${normalizedRuleType}::${normalizeMappingKey(raw)}`)
        || mappingRules.rules.has(`${normalizedRuleType}::${normalizeLooseMappingKey(raw)}`);
}

function normalizeMultiByMappingRules(mappingRules, ruleType, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw || isInvalidByMappingRules(mappingRules, raw)) return "";

    const normalizedRuleType = normalizeMappingKey(ruleType);
    const entries = mappingRules.entriesByType.get(normalizedRuleType) || [];
    const rawKey = normalizeMappingKey(raw);
    const rawLooseKey = normalizeLooseMappingKey(raw);
    const matches = [];

    for (const entry of entries) {
        if (!entry.outputValue) continue;
        const keyIndex = rawKey.indexOf(entry.inputValue);
        const looseKeyIndex = rawLooseKey.indexOf(entry.looseInputValue);

        if (
            rawKey === entry.inputValue ||
            rawLooseKey === entry.looseInputValue ||
            keyIndex !== -1 ||
            looseKeyIndex !== -1
        ) {
            matches.push({
                label: entry.outputValue,
                index: [keyIndex, looseKeyIndex].filter(index => index >= 0).sort((a, b) => a - b)[0] || 0,
            });
        }
    }

    return [...new Set(matches
        .sort((a, b) => a.index - b.index)
        .map(match => match.label))].join(", ");
}

function mapLegacySource(source, mappingRules) {
    if (hasMappingRule(mappingRules, "source", source) || isInvalidByMappingRules(mappingRules, source)) {
        return normalizeByMappingRules(mappingRules, "source", source);
    }

    const value = String(source || "").trim().toLowerCase();

    if (value.includes("lead gen")) return "Facebook";
    if (value.includes("leadgen")) return "Facebook";
    if (value.includes("facebook")) return "Facebook";
    if (value.includes("fb chat")) return "Messenger";
    if (value.includes("messenger")) return "Messenger";
    if (value.includes("website")) return "Website";

    return "Legacy Import";
}

function mapLegacyStatus(classification, mappingRules) {
    if (hasMappingRule(mappingRules, "lead_status", classification) || isInvalidByMappingRules(mappingRules, classification)) {
        return normalizeByMappingRules(mappingRules, "lead_status", classification);
    }

    return LEGACY_IMPORT_STATUS;
}

function mapLegacyReason(reason, mappingRules) {
    return normalizeByMappingRules(mappingRules, "reason", reason);
}

const LEGACY_IMPORT_STATUS = "Legacy Import";

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
    reason: ["Reason"],
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

function isLegacyAudioHeader(headerName) {
    const header = String(headerName || "").toLowerCase();
    return header.includes("call_recording")
        || header.includes("call_recording_url")
        || header.includes("audio")
        || header.includes("recording");
}

function extractUrls(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];

    return raw.match(/https?:\/\/[^\s,;]+/gi) || [];
}

function getLegacyAudioUrls(rowObject, debugCounters) {
    const urls = [];

    for (const [headerName, value] of Object.entries(rowObject)) {
        if (!isLegacyAudioHeader(headerName)) continue;

        const raw = String(value || "").trim();
        if (!raw) continue;

        const extractedUrls = extractUrls(raw);

        if (!extractedUrls.length) {
            debugCounters.audioUrlsSkipped++;
            debugCounters.audioSkipReasons.invalid_audio_url = (debugCounters.audioSkipReasons.invalid_audio_url || 0) + 1;

            if (debugCounters.sampleAudioItems.length < 10) {
                debugCounters.sampleAudioItems.push({
                    header: headerName,
                    action: "skipped",
                    reason: "invalid_audio_url",
                    value: raw,
                });
            }
            continue;
        }

        for (const url of extractedUrls) {
            if (urls.includes(url)) continue;

            urls.push(url);
            debugCounters.audioUrlsDetected++;

            if (debugCounters.sampleAudioItems.length < 10) {
                debugCounters.sampleAudioItems.push({
                    header: headerName,
                    action: "detected",
                    audio_url: url,
                });
            }
        }
    }

    return urls;
}

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

function normalizeLegacyProvince(rawProvince, mappingRules) {
    const raw = String(rawProvince || "").trim();
    if (!raw) {
        return { province: "", rawProvince: "", wasNormalized: false, wasInvalid: false };
    }

    if (/^\d+$/.test(raw.replace(/\s+/g, "")) || isInvalidByMappingRules(mappingRules, raw)) {
        return { province: "", rawProvince: raw, wasNormalized: false, wasInvalid: true };
    }

    const mappedProvince = normalizeByMappingRules(mappingRules, "province", raw);
    if (mappedProvince) {
        return {
            province: mappedProvince,
            rawProvince: raw,
            wasNormalized: mappedProvince !== raw,
            wasInvalid: false,
        };
    }

    return { province: "", rawProvince: raw, wasNormalized: false, wasInvalid: true };
}

function splitLegacyChoiceValues(value) {
    return String(value || "")
        .replace(/_/g, " ")
        .split(/[,;/\n]+/)
        .map(item => item.replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

function normalizeLegacyPreferredCallDay(rawValue, mappingRules) {
    return normalizeMultiByMappingRules(mappingRules, "preferred_call_day", rawValue);
}

function normalizeLegacyPreferredCallTime(rawValue, mappingRules) {
    return normalizeMultiByMappingRules(mappingRules, "preferred_call_time", rawValue);
}

function normalizeLegacyZone(province, mappingRules) {
    return normalizeByMappingRules(mappingRules, "zone", province);
}

function formatLegacyDateForSheet(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLegacyDateValue(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) {
        return { value: "", isBlank: true, isInvalid: false };
    }

    const thaiMonths = {
        มกราคม: 0,
        กุมภาพันธ์: 1,
        มีนาคม: 2,
        เมษายน: 3,
        พฤษภาคม: 4,
        มิถุนายน: 5,
        กรกฎาคม: 6,
        สิงหาคม: 7,
        กันยายน: 8,
        ตุลาคม: 9,
        พฤศจิกายน: 10,
        ธันวาคม: 11,
    };

    const normalizeYear = (year) => {
        const numericYear = Number(year);
        if (numericYear < 100) return 2000 + numericYear;
        if (numericYear > 2400) return numericYear - 543;
        return numericYear;
    };

    const buildResult = (date) => {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
            return { value: "", isBlank: false, isInvalid: true };
        }

        return { value: formatLegacyDateForSheet(date), isBlank: false, isInvalid: false };
    };

    const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoMatch) {
        return buildResult(new Date(
            Number(isoMatch[1]),
            Number(isoMatch[2]) - 1,
            Number(isoMatch[3]),
            Number(isoMatch[4] || 0),
            Number(isoMatch[5] || 0),
            Number(isoMatch[6] || 0)
        ));
    }

    const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (slashMatch) {
        return buildResult(new Date(
            normalizeYear(slashMatch[3]),
            Number(slashMatch[2]) - 1,
            Number(slashMatch[1]),
            Number(slashMatch[4] || 0),
            Number(slashMatch[5] || 0),
            Number(slashMatch[6] || 0)
        ));
    }

    const thaiDateMatch = raw.match(/^(\d{1,2})\s+([ก-๙]+)\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (thaiDateMatch && Object.prototype.hasOwnProperty.call(thaiMonths, thaiDateMatch[2])) {
        return buildResult(new Date(
            normalizeYear(thaiDateMatch[3]),
            thaiMonths[thaiDateMatch[2]],
            Number(thaiDateMatch[1]),
            Number(thaiDateMatch[4] || 0),
            Number(thaiDateMatch[5] || 0),
            Number(thaiDateMatch[6] || 0)
        ));
    }

    if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
        return buildResult(new Date(raw));
    }

    return { value: "", isBlank: false, isInvalid: true };
}

function normalizeLegacyImportPhone(rawPhone, googleSheets) {
    const cleanPhone = googleSheets.normalizePhone(rawPhone);
    return /^0\d{9}$/.test(cleanPhone) ? cleanPhone : "";
}

function buildLegacyActivityPreviews(rowObject, googleSheets, leadId, audioUrls, debugCounters) {
    const activities = [];
    const usedAudioUrls = new Set();

    for (const followUpNo of [1, 2, 3]) {
        const details = getLegacyValue(rowObject, googleSheets, `follow_up_${followUpNo}_details`);
        const rawCreatedAt = getLegacyValue(rowObject, googleSheets, `follow_up_${followUpNo}_date_time`);
        const parsedCreatedAt = parseLegacyDateValue(rawCreatedAt);
        let audioUrl = details
            ? audioUrls[followUpNo - 1] || audioUrls.find(url => !usedAudioUrls.has(url)) || ""
            : audioUrls[followUpNo - 1] || "";

        if (parsedCreatedAt.isBlank) {
            debugCounters.blankDateCount++;
        } else if (parsedCreatedAt.isInvalid) {
            debugCounters.invalidDateCount++;
        }

        if (!details && !audioUrl) continue;
        if (audioUrl && usedAudioUrls.has(audioUrl)) audioUrl = "";
        if (audioUrl) usedAudioUrls.add(audioUrl);

        activities.push({
            target_sheet: "ACTIVITY_LOG",
            action: "would_create_activity",
            lead_id: leadId || "(resolved after lead creation)",
            follow_up_no: followUpNo,
            action_type: "Follow-up",
            note: details,
            audio_url: audioUrl,
            created_at: parsedCreatedAt.value,
            raw_created_at: rawCreatedAt,
        });
    }

    audioUrls.forEach((audioUrl, index) => {
        if (usedAudioUrls.has(audioUrl)) return;

        activities.push({
            target_sheet: "ACTIVITY_LOG",
            action: "would_create_activity",
            lead_id: leadId || "(resolved after lead creation)",
            follow_up_no: activities.length + 1 || index + 1,
            action_type: "Follow-up",
            note: "",
            audio_url: audioUrl,
            created_at: "",
            raw_created_at: "",
        });
    });

    const audioActivityCount = activities.filter(activity => activity.audio_url).length;
    debugCounters.audioActivitiesCreated += audioActivityCount;

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
            open_deal: false,
            customer_name: values.name,
            phone: cleanPhone,
            source: values.source,
            customer_type: values.corporateName,
            province: values.province,
            zone: values.zone,
            save_follow_up: false,
            preferred_call_day: values.preferredCallDay,
            preferred_call_time: values.preferredCallTime,
            lead_status: values.leadStatus,
            reason: values.reason,
            sales_owner: values.salesperson,
            created_at: values.leadInDate,
            updated_at: values.updatedAt,
        };
    }

    const updateObject = {
        updated_at: values.updatedAt,
    };

    putIfBlank(updateObject, existingLeadObject, "customer_name", values.name);
    putIfBlank(updateObject, existingLeadObject, "phone", cleanPhone);
    putIfBlank(updateObject, existingLeadObject, "source", values.source);
    putIfBlank(updateObject, existingLeadObject, "customer_type", values.corporateName);
    putIfBlank(updateObject, existingLeadObject, "province", values.province);
    putIfBlank(updateObject, existingLeadObject, "zone", values.zone);
    putIfBlank(updateObject, existingLeadObject, "preferred_call_day", values.preferredCallDay);
    putIfBlank(updateObject, existingLeadObject, "preferred_call_time", values.preferredCallTime);
    putIfBlank(updateObject, existingLeadObject, "lead_status", values.leadStatus);
    putIfBlank(updateObject, existingLeadObject, "reason", values.reason);
    putIfBlank(updateObject, existingLeadObject, "sales_owner", values.salesperson);
    putIfBlank(updateObject, existingLeadObject, "created_at", values.leadInDate);

    return updateObject;
}

function buildLegacyLeadDetailObject(values, leadId, rowObject) {
    return {
        lead_id: leadId,
        raw_province: values.rawProvince,
        raw_data_json: JSON.stringify(rowObject),
        import_source: "Legacy Import",
    };
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
        created_at: activity.created_at,
    }));
}

async function readFirstAvailableSheet(googleSheets, sheets, spreadsheetId, sheetNames, rangeSuffix = "A:ZZ") {
    let lastError = null;

    for (const sheetName of sheetNames) {
        try {
            return {
                sheetName,
                rows: await googleSheets.readSheet(
                    sheets,
                    spreadsheetId,
                    `${sheetName}!${rangeSuffix}`
                ),
            };
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error(`No available sheet found: ${sheetNames.join(", ")}`);
}

const CRM1_IMPORT_MARKERS = [
    "priority leads",
    "lead new",
    "close won",
    "close won & ส่งแบบสอบถาม",
    "งานติดตั้ง",
];

const CRM1_SKIP_MARKER_PATTERNS = [
    "pivot leads",
    "reason (update)",
    "stage",
    "reason",
    "summary",
    "pivot",
    "report",
    "config",
];

const CRM1_FIELD_ALIASES = {
    customer_name: ["ชื่อลูกค้า", "ชื่อลูกค้า + ชื่อ LINE / FB", "Customer name", "Name"],
    phone: ["เบอร์ติดต่อ", "เบอร์ติดต่อ (Tel.)", "Tel.", "Tel", "Phone"],
    source: ["ช่องทางการขาย", "Sales Channel", "Sales channel"],
    customer_type: ["ประเภทลูกค้า", "Customer type"],
    location_type: ["ประเภทสถานที่", "Location type"],
    rooms: ["ห้องที่ใช้งาน", "Rooms"],
    area: ["พื้นที่ ตรม.", "sq m."],
    stage: ["Stage", "สถานะ"],
    reason: ["Reason", "เหตุผลยกเลิก"],
    note: ["Notes", "Note", "Next_Step", "Next Step", "Column 23"],
    month: ["Month"],
    contact_method: ["วิธีการติดต่อ"],
    last_contact_date: ["วันที่ติดตามล่าสุด", "Last Contact Date"],
    follow_up_count: ["จำนวนการติดตาม", "จำนวนการติดตาม (ต้องครบ 3 ครั้ง)"],
    next_step_date: ["Next_Step_Date"],
    next_step: ["Next_Step"],
    audio: ["ไฟล์เสียง", "Call Recording", "Audio URL", "Audio", "Recording"],
    product_model: ["Product_Model", "Product Model", "ผลิตภัณฑ์"],
    device_count: ["จำนวนเครื่องที่ติดตั้ง", "Device for setup"],
    payment_date: ["วันที่ชำระเงิน", "Date Payment"],
    payment_slip_url: ["หลักฐานการชำระ", "Link Slip"],
    price: ["ยอดชำระ", "Price"],
    install_date: ["วันที่ติดตั้ง", "Set up date"],
    install_time: ["ช่วงเวลา"],
    install_status: ["สถานะติดตั้ง", "สถานะ"],
    address: ["สถานที่ติดตั้ง + ลิงค์โลเคชั่น", "สถานที่ติดตั้ง + จังหวัด", "Location", "Address"],
    province: ["จังหวัด"],
    zone: ["โซนพื้นที่"],
    cancel_reason: ["เหตุผลยกเลิก"],
};

function isCrm1ImportMarker(value) {
    const marker = normalizeCrm1MarkerText(value);
    return CRM1_IMPORT_MARKERS.some(pattern => marker.includes(normalizeCrm1MarkerText(pattern)));
}

function isCrm1SkippedMarker(value) {
    const marker = normalizeCrm1MarkerText(value);
    return CRM1_SKIP_MARKER_PATTERNS.some(pattern => marker.includes(normalizeCrm1MarkerText(pattern)));
}

function isCrm1AnyMarker(value) {
    return isCrm1ImportMarker(value) || isCrm1SkippedMarker(value);
}

function rowHasAnyValue(row) {
    return Array.isArray(row) && row.some(cell => String(cell || "").trim() !== "");
}

function normalizeCrm1MarkerText(value) {
    return String(value || "")
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function getCrm1Value(rowObject, googleSheets, fieldName) {
    const aliases = CRM1_FIELD_ALIASES[fieldName] || [];

    for (const alias of aliases) {
        const key = googleSheets.normalizeHeaderName(alias);
        const value = String(rowObject[key] || "").trim();

        if (value) return value;
    }

    return "";
}

function findNextNonEmptyRowIndex(rows, startIndex) {
    for (let i = startIndex; i < rows.length; i++) {
        if (rowHasAnyValue(rows[i])) return i;
    }

    return -1;
}

function buildCrm1Blocks(rows) {
    const parsedBlocks = [];
    const skippedBlocks = [];
    const markerDetectionDebug = [];

    for (let i = 0; i < rows.length; i++) {
        const marker = String(rows[i]?.[0] || "").trim();
        const normalizedMarker = normalizeCrm1MarkerText(marker);
        const isMarker = Boolean(marker && isCrm1AnyMarker(marker));

        if (markerDetectionDebug.length < 50 && marker) {
            markerDetectionDebug.push({
                row: i + 1,
                col_a: marker,
                normalized_col_a: normalizedMarker,
                detected_marker: isMarker,
                import_marker: isMarker ? isCrm1ImportMarker(marker) : false,
                skipped_marker: isMarker ? isCrm1SkippedMarker(marker) : false,
            });
        }

        if (!isMarker) continue;

        const headerIndex = findNextNonEmptyRowIndex(rows, i + 1);

        if (headerIndex === -1) {
            skippedBlocks.push({
                marker,
                marker_row: i + 1,
                reason: "missing_header_row",
            });
            break;
        }

        const block = {
            marker,
            markerRow: i + 1,
            headerRow: headerIndex + 1,
            headers: rows[headerIndex] || [],
            dataRows: [],
        };

        let j = headerIndex + 1;
        for (; j < rows.length; j++) {
            const firstCell = String(rows[j]?.[0] || "").trim();
            if (firstCell && isCrm1AnyMarker(firstCell)) break;
            block.dataRows.push({
                rowNumber: j + 1,
                row: rows[j] || [],
            });
        }

        if (isCrm1ImportMarker(marker)) {
            parsedBlocks.push(block);
        } else {
            skippedBlocks.push({
                marker,
                marker_row: block.markerRow,
                reason: "ignored_block_type",
            });
        }

        i = j - 1;
    }

    return { parsedBlocks, skippedBlocks, markerDetectionDebug };
}

function rowToCrm1Object(headers, row, googleSheets) {
    return headers.reduce((object, header, index) => {
        const key = googleSheets.normalizeHeaderName(header);
        if (key) object[key] = row?.[index] || "";
        return object;
    }, {});
}

function detectCrm1Audio(rowObject, googleSheets, sourceBlock, sourceRow, normalizedPhone) {
    const items = [];
    const aliases = CRM1_FIELD_ALIASES.audio || [];

    for (const alias of aliases) {
        const key = googleSheets.normalizeHeaderName(alias);
        const raw = String(rowObject[key] || "").trim();
        if (!raw) continue;

        const urls = extractUrls(raw);
        if (urls.length) {
            urls.forEach(url => items.push({
                source_block: sourceBlock,
                source_row: sourceRow,
                normalized_phone: normalizedPhone,
                audio_url: url,
                audio_file_name: "",
                detected_from_header: alias,
            }));
            continue;
        }

        items.push({
            source_block: sourceBlock,
            source_row: sourceRow,
            normalized_phone: normalizedPhone,
            audio_url: "",
            audio_file_name: raw,
            detected_from_header: alias,
        });
    }

    return items;
}

app.post("/import/legacy", async (req, res) => {
    const dryRun = String(req.query.dry_run ?? "true").trim().toLowerCase() !== "false";

    try {
        const googleSheets = require("./services/googleSheets");
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();

        const rawSheet = await readFirstAvailableSheet(
            googleSheets,
            sheets,
            spreadsheetId,
            ["IMPORT_RAW_CRM2", "IMPORT_RAW"]
        );
        const rawRows = rawSheet.rows;

        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];
        const detailRows = await googleSheets.getSheetRows("LEAD_DETAILS");
        const detailHeaders = detailRows[0] || [];
        const mappingRules = await loadMappingRules(googleSheets);

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

                if (
                    !expectedHeaderKeys.has(googleSheets.normalizeHeaderName(rawHeader)) &&
                    !isLegacyAudioHeader(googleSheets.normalizeHeaderName(rawHeader))
                ) {
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
        let normalizedProvinceCount = 0;
        let invalidProvinceCount = 0;
        let blankDateCount = 0;
        let invalidDateCount = 0;
        let cleanedPreferredCallDayCount = 0;
        let cleanedPreferredCallTimeCount = 0;
        let audioUrlsDetected = 0;
        let audioActivitiesCreated = 0;
        let audioUrlsSkipped = 0;
        const audioSkipReasons = {};
        const sampleAudioItems = [];
        const sampleResultItems = [];
        const pendingLeadCreates = [];
        const pendingLeadUpdates = [];
        const pendingLeadDetailCreates = [];
        const pendingLeadDetailUpdates = [];
        const pendingActivityCreates = [];
        const knownLeadsByPhone = new Map();
        const knownLeadDetailsByLeadId = new Map();
        const debugCounters = {
            get blankDateCount() {
                return blankDateCount;
            },
            set blankDateCount(value) {
                blankDateCount = value;
            },
            get invalidDateCount() {
                return invalidDateCount;
            },
            set invalidDateCount(value) {
                invalidDateCount = value;
            },
            get audioUrlsDetected() {
                return audioUrlsDetected;
            },
            set audioUrlsDetected(value) {
                audioUrlsDetected = value;
            },
            get audioActivitiesCreated() {
                return audioActivitiesCreated;
            },
            set audioActivitiesCreated(value) {
                audioActivitiesCreated = value;
            },
            get audioUrlsSkipped() {
                return audioUrlsSkipped;
            },
            set audioUrlsSkipped(value) {
                audioUrlsSkipped = value;
            },
            audioSkipReasons,
            sampleAudioItems,
        };

        for (let i = 2; i < leadsRows.length; i++) {
            const leadObject = googleSheets.rowToObject(leadHeaders, leadsRows[i]);
            const existingPhone = normalizeLegacyImportPhone(leadObject.phone, googleSheets);

            if (!existingPhone) continue;

            knownLeadsByPhone.set(existingPhone, {
                ...leadObject,
                rowNumber: i + 1,
            });
        }

        for (let i = 2; i < detailRows.length; i++) {
            const detailObject = googleSheets.rowToObject(detailHeaders, detailRows[i]);
            const detailLeadId = String(detailObject.lead_id || "").trim();

            if (!detailLeadId) continue;

            knownLeadDetailsByLeadId.set(detailLeadId, {
                ...detailObject,
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
            const reason = getLegacyValue(rowObject, googleSheets, "reason");
            const numberOfDevicesBought = getLegacyValue(rowObject, googleSheets, "number_of_devices_bought");
            const whichPackage = getLegacyValue(rowObject, googleSheets, "which_package");
            const amountDue = getLegacyValue(rowObject, googleSheets, "amount_due");
            const amountPaid = getLegacyValue(rowObject, googleSheets, "amount_paid");
            const paymentSlip = getLegacyValue(rowObject, googleSheets, "payment_slip");
            const installationLocation = getLegacyValue(rowObject, googleSheets, "installation_location");
            const installationDetails = getLegacyValue(rowObject, googleSheets, "installation_details");
            const installationDate = getLegacyValue(rowObject, googleSheets, "installation_date");
            const installationTime = getLegacyValue(rowObject, googleSheets, "installation_time");

            const cleanPhone = normalizeLegacyImportPhone(phone, googleSheets);
            const provinceResult = normalizeLegacyProvince(province, mappingRules);
            const cleanedPreferredCallDay = normalizeLegacyPreferredCallDay(preferredCallDay, mappingRules);
            const cleanedPreferredCallTime = normalizeLegacyPreferredCallTime(preferredCallTime, mappingRules);
            const cleanedSource = mapLegacySource(source, mappingRules);
            const cleanedLeadStatus = mapLegacyStatus(classification, mappingRules);
            const cleanedReason = mapLegacyReason(reason || classification, mappingRules);
            const cleanedZone = normalizeLegacyZone(provinceResult.province, mappingRules);
            const parsedLeadInDate = parseLegacyDateValue(leadInDate);
            const updatedAt = formatLegacyDateForSheet(new Date());
            const audioUrls = getLegacyAudioUrls(rowObject, debugCounters);

            if (provinceResult.province) {
                normalizedProvinceCount++;
            } else if (provinceResult.wasInvalid) {
                invalidProvinceCount++;
            }

            if (String(preferredCallDay || "").trim() && cleanedPreferredCallDay !== preferredCallDay) {
                cleanedPreferredCallDayCount++;
            }

            if (String(preferredCallTime || "").trim() && cleanedPreferredCallTime !== preferredCallTime) {
                cleanedPreferredCallTimeCount++;
            }

            if (parsedLeadInDate.isBlank) {
                blankDateCount++;
            } else if (parsedLeadInDate.isInvalid) {
                invalidDateCount++;
            }

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
                audioUrls,
                debugCounters
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
                        source: cleanedSource,
                        lead_status: cleanedLeadStatus,
                        reason: cleanedReason,
                        sales_owner: salesperson,
                        province: provinceResult.province,
                        zone: cleanedZone,
                        raw_province: provinceResult.rawProvince,
                        customer_type_or_raw_corporate_preview: corporateName,
                        preferred_call_day: cleanedPreferredCallDay,
                        preferred_call_time: cleanedPreferredCallTime,
                        created_at: parsedLeadInDate.value,
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
                        source: cleanedSource,
                        leadInDate: parsedLeadInDate.value,
                        updatedAt,
                        salesperson,
                        name,
                        province: provinceResult.province,
                        zone: cleanedZone,
                        rawProvince: provinceResult.rawProvince,
                        corporateName,
                        preferredCallDay: cleanedPreferredCallDay,
                        preferredCallTime: cleanedPreferredCallTime,
                        leadStatus: cleanedLeadStatus,
                        reason: cleanedReason,
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

                    const detailObject = buildLegacyLeadDetailObject(values, resolvedLeadId, rowObject);
                    const existingDetailObject = knownLeadDetailsByLeadId.get(resolvedLeadId);

                    if (!existingDetailObject) {
                        pendingLeadDetailCreates.push(detailObject);
                        knownLeadDetailsByLeadId.set(resolvedLeadId, {
                            ...detailObject,
                            rowNumber: null,
                        });
                    } else if (!String(existingDetailObject.facebook_leadgen_id || "").trim()) {
                        pendingLeadDetailUpdates.push({
                            rowNumber: existingDetailObject.rowNumber,
                            object: detailObject,
                        });
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
            const failedCreatedLeadIds = new Set();

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
                            failedCreatedLeadIds.add(leadObject.lead_id);
                        }
                    }
                }
            }

            for (const update of pendingLeadDetailUpdates) {
                try {
                    await googleSheets.updateObjectRow("LEAD_DETAILS", update.rowNumber, update.object);
                } catch (err) {
                    failedRows++;
                }
            }

            const leadDetailCreatesToWrite = pendingLeadDetailCreates
                .filter(detailObject => !failedCreatedLeadIds.has(detailObject.lead_id));

            if (leadDetailCreatesToWrite.length) {
                try {
                    await googleSheets.appendObjects("LEAD_DETAILS", leadDetailCreatesToWrite);
                } catch (err) {
                    for (const detailObject of leadDetailCreatesToWrite) {
                        try {
                            await googleSheets.appendObjects("LEAD_DETAILS", [detailObject]);
                        } catch (rowErr) {
                            failedRows++;
                        }
                    }
                }
            }

            const activityCreatesToWrite = pendingActivityCreates
                .filter(activityObject => !failedCreatedLeadIds.has(activityObject.lead_id));

            if (activityCreatesToWrite.length) {
                try {
                    await googleSheets.appendObjects("ACTIVITY_LOG", activityCreatesToWrite);
                    createdActivities += activityCreatesToWrite.length;
                } catch (err) {
                    for (const activityObject of activityCreatesToWrite) {
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
            normalized_province_count: normalizedProvinceCount,
            invalid_province_count: invalidProvinceCount,
            blank_date_count: blankDateCount,
            invalid_date_count: invalidDateCount,
            cleaned_preferred_call_day_count: cleanedPreferredCallDayCount,
            cleaned_preferred_call_time_count: cleanedPreferredCallTimeCount,
            mapping_rules_loaded: mappingRules.loadedCount,
            mapping_rule_types_loaded: mappingRules.ruleTypes,
            source_sheet_name: rawSheet.sheetName,
            audio_urls_detected: audioUrlsDetected,
            audio_activities_created: audioActivitiesCreated,
            audio_urls_skipped: audioUrlsSkipped,
            audio_skip_reasons: audioSkipReasons,
            sample_audio_items: sampleAudioItems,
            sample_result_items: sampleResultItems,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

app.post("/import/legacy-crm1", async (req, res) => {
    const dryRun = String(req.query.dry_run ?? "true").trim().toLowerCase() !== "false";

    try {
        const googleSheets = require("./services/googleSheets");
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
        const rawSheet = await readFirstAvailableSheet(
            googleSheets,
            sheets,
            spreadsheetId,
            ["IMPORT_RAW_CRM1"]
        );
        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];
        const mappingRules = await loadMappingRules(googleSheets);
        const { parsedBlocks, skippedBlocks, markerDetectionDebug } = buildCrm1Blocks(rawSheet.rows);
        const sourceSheetRowCount = rawSheet.rows.length;
        const sourceSheetColCount = rawSheet.rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
        const first20ColAValues = rawSheet.rows.slice(0, 20).map((row, index) => ({
            row: index + 1,
            value: String(row?.[0] || ""),
            normalized_value: normalizeCrm1MarkerText(row?.[0] || ""),
        }));
        const first5RowsPreview = rawSheet.rows.slice(0, 5).map((row, index) => ({
            row: index + 1,
            values: (row || []).slice(0, 12),
        }));
        const knownLeadsByPhone = new Map();
        const queuedPhones = new Set();
        const samplePreviewItems = [];
        const sampleAudioItems = [];
        const failedRowSamples = [];

        let totalRows = 0;
        let rowsWithValidPhone = 0;
        let rowsMissingPhone = 0;
        let wouldCreateLead = 0;
        let wouldUpdateExistingLead = 0;
        let wouldCreateDeal = 0;
        let wouldCreateInstallation = 0;
        let wouldCreateActivity = 0;
        let audioUrlsDetected = 0;
        let audioFileNamesDetected = 0;
        let failedRows = 0;

        for (let i = 2; i < leadsRows.length; i++) {
            const leadObject = googleSheets.rowToObject(leadHeaders, leadsRows[i]);
            const existingPhone = normalizeLegacyImportPhone(leadObject.phone, googleSheets);

            if (!existingPhone) continue;

            knownLeadsByPhone.set(existingPhone, {
                ...leadObject,
                rowNumber: i + 1,
            });
        }

        for (const block of parsedBlocks) {
            for (const dataRow of block.dataRows) {
                if (!rowHasAnyValue(dataRow.row)) continue;

                totalRows++;

                try {
                    const rowObject = rowToCrm1Object(block.headers, dataRow.row, googleSheets);
                    const customerName = getCrm1Value(rowObject, googleSheets, "customer_name");
                    const phone = getCrm1Value(rowObject, googleSheets, "phone");
                    const source = getCrm1Value(rowObject, googleSheets, "source");
                    const customerType = getCrm1Value(rowObject, googleSheets, "customer_type");
                    const stage = getCrm1Value(rowObject, googleSheets, "stage");
                    const rawReason = getCrm1Value(rowObject, googleSheets, "reason")
                        || getCrm1Value(rowObject, googleSheets, "cancel_reason");
                    const note = getCrm1Value(rowObject, googleSheets, "note")
                        || getCrm1Value(rowObject, googleSheets, "next_step");
                    const rawProvince = getCrm1Value(rowObject, googleSheets, "province");
                    const rawZone = getCrm1Value(rowObject, googleSheets, "zone");
                    const productModel = getCrm1Value(rowObject, googleSheets, "product_model");
                    const deviceCount = getCrm1Value(rowObject, googleSheets, "device_count");
                    const paymentDate = getCrm1Value(rowObject, googleSheets, "payment_date");
                    const paymentSlipUrl = getCrm1Value(rowObject, googleSheets, "payment_slip_url");
                    const price = getCrm1Value(rowObject, googleSheets, "price");
                    const installDateRaw = getCrm1Value(rowObject, googleSheets, "install_date");
                    const installTime = getCrm1Value(rowObject, googleSheets, "install_time");
                    const installStatus = getCrm1Value(rowObject, googleSheets, "install_status");
                    const address = getCrm1Value(rowObject, googleSheets, "address");
                    const lastContactDateRaw = getCrm1Value(rowObject, googleSheets, "last_contact_date");
                    const nextStepDateRaw = getCrm1Value(rowObject, googleSheets, "next_step_date");
                    const contactMethod = getCrm1Value(rowObject, googleSheets, "contact_method");
                    const followUpCount = getCrm1Value(rowObject, googleSheets, "follow_up_count");
                    const normalizedPhone = normalizeLegacyImportPhone(phone, googleSheets);

                    if (!normalizedPhone) {
                        rowsMissingPhone++;
                        if (failedRowSamples.length < 10) {
                            failedRowSamples.push({
                                source_block: block.marker,
                                source_row: dataRow.rowNumber,
                                reason: "missing_or_invalid_phone",
                            });
                        }
                        continue;
                    }

                    rowsWithValidPhone++;

                    const provinceResult = normalizeLegacyProvince(rawProvince, mappingRules);
                    const explicitZone = normalizeByMappingRules(mappingRules, "zone", rawZone);
                    const derivedZone = normalizeLegacyZone(provinceResult.province, mappingRules);
                    const zone = explicitZone || derivedZone;
                    const normalizedSource = mapLegacySource(source || block.marker, mappingRules);
                    const leadStatus = mapLegacyStatus(stage || block.marker, mappingRules);
                    const reason = mapLegacyReason(rawReason || stage, mappingRules);
                    const installDate = parseLegacyDateValue(installDateRaw).value;
                    const lastContactDate = parseLegacyDateValue(lastContactDateRaw).value;
                    const nextStepDate = parseLegacyDateValue(nextStepDateRaw).value;
                    const audioItems = detectCrm1Audio(rowObject, googleSheets, block.marker, dataRow.rowNumber, normalizedPhone);
                    const hasDealData = hasAnyValue({
                        productModel,
                        deviceCount,
                        paymentDate,
                        paymentSlipUrl,
                        price,
                    });
                    const hasInstallationData = hasAnyValue({
                        installDate,
                        installTime,
                        installStatus,
                        address,
                        zone,
                    });
                    const hasActivityData = hasAnyValue({
                        contactMethod,
                        lastContactDate,
                        nextStepDate,
                        note,
                        followUpCount,
                    }) || audioItems.length > 0;
                    const existingLeadObject = knownLeadsByPhone.get(normalizedPhone);
                    const duplicateQueued = queuedPhones.has(normalizedPhone);
                    const wouldUpdate = Boolean(existingLeadObject || duplicateQueued);

                    if (wouldUpdate) {
                        wouldUpdateExistingLead++;
                    } else {
                        wouldCreateLead++;
                        queuedPhones.add(normalizedPhone);
                    }

                    if (hasDealData) wouldCreateDeal++;
                    if (hasInstallationData) wouldCreateInstallation++;
                    if (hasActivityData) wouldCreateActivity++;

                    audioItems.forEach(item => {
                        if (item.audio_url) audioUrlsDetected++;
                        if (item.audio_file_name) audioFileNamesDetected++;
                        if (sampleAudioItems.length < 20) sampleAudioItems.push(item);
                    });

                    if (samplePreviewItems.length < 30) {
                        samplePreviewItems.push({
                            source_block: block.marker,
                            source_row: dataRow.rowNumber,
                            normalized_phone: normalizedPhone,
                            customer_name: customerName,
                            lead_status: leadStatus,
                            source: normalizedSource,
                            province: provinceResult.province,
                            zone,
                            customer_type: customerType,
                            product_model: productModel,
                            install_date: installDate,
                            install_status: installStatus,
                            stage,
                            reason,
                            note_preview: note,
                            would_create_lead: !wouldUpdate,
                            would_create_deal: hasDealData,
                            would_create_installation: hasInstallationData,
                            would_create_activity: hasActivityData,
                        });
                    }
                } catch (err) {
                    failedRows++;

                    if (failedRowSamples.length < 10) {
                        failedRowSamples.push({
                            source_block: block.marker,
                            source_row: dataRow.rowNumber,
                            reason: err.message,
                        });
                    }
                }
            }
        }

        return res.status(dryRun ? 200 : 501).json({
            success: dryRun,
            dry_run: dryRun,
            parsed_dry_run: dryRun,
            source_sheet_name: rawSheet.sheetName,
            source_sheet_found: true,
            source_sheet_row_count: sourceSheetRowCount,
            source_sheet_col_count: sourceSheetColCount,
            first_20_col_a_values: first20ColAValues,
            first_5_rows_preview: first5RowsPreview,
            marker_detection_debug: markerDetectionDebug,
            real_import_implemented: false,
            message: dryRun
                ? undefined
                : "CRM1 real import is not implemented yet. Re-run with dry_run=true for preview only.",
            total_blocks_detected: parsedBlocks.length + skippedBlocks.length,
            parsed_blocks: parsedBlocks.length,
            parsed_block_details: parsedBlocks.map(block => ({
                marker: block.marker,
                marker_row: block.markerRow,
                header_row: block.headerRow,
                data_rows: block.dataRows.filter(item => rowHasAnyValue(item.row)).length,
            })),
            skipped_blocks: skippedBlocks.length,
            total_rows: totalRows,
            rows_with_valid_phone: rowsWithValidPhone,
            rows_missing_phone: rowsMissingPhone,
            would_create_lead: wouldCreateLead,
            would_update_existing_lead: wouldUpdateExistingLead,
            would_create_deal: wouldCreateDeal,
            would_create_installation: wouldCreateInstallation,
            would_create_activity: wouldCreateActivity,
            audio_urls_detected: audioUrlsDetected,
            audio_file_names_detected: audioFileNamesDetected,
            failed_rows: failedRows,
            mapping_rules_loaded: mappingRules.loadedCount,
            mapping_rule_types_loaded: mappingRules.ruleTypes,
            sample_preview_items: samplePreviewItems,
            sample_audio_items: sampleAudioItems,
            skipped_block_details: skippedBlocks,
            failed_row_samples: failedRowSamples,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: dryRun,
            parsed_dry_run: dryRun,
            source_sheet_name: "IMPORT_RAW_CRM1",
            source_sheet_found: false,
            error: err.message,
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
