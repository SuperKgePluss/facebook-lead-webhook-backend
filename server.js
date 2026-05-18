require("dotenv").config();

const express = require("express");
const axios = require("axios");
const {
    fetchLeadDetail,
    fetchFormLeads,
    debugFacebookForm,
    debugLeadgenForms,
    debugFacebookAccess,
    fetchLatestLeadIdsFromPage,
    fetchAllLeadIdsFromPage,
} = require("./services/facebook");

const {
    appendLeadToSheet,
    appendLeadsToSheetBatch,
} = require("./services/googleSheets");
const { handleLegacyCrm2Import } = require("./services/imports/legacyCrm2Import");
const { handleLegacyCrm1Import } = require("./services/imports/legacyCrm1Import");
const { handleLegacyLeadStatusCleanup } = require("./services/imports/legacyCleanup");
const { handleLineWebhook } = require("./services/lineWebhook");

const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    },
}));

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

function getFacebookFieldValue(fieldData, ...names) {
    if (!Array.isArray(fieldData)) return "";

    const normalizedNames = names.map(name => String(name || "").toLowerCase());
    const found = fieldData.find(item => {
        const itemName = String(item.name || "").toLowerCase();
        return normalizedNames.includes(itemName);
    });

    return found?.values?.[0] || "";
}

function maskDebugValue(value) {
    const raw = String(value || "").trim();
    if (raw.length <= 8) return raw ? "***" : "";
    return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function maskDebugName(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.length <= 2 ? "***" : `${raw.slice(0, 1)}***${raw.slice(-1)}`;
}

async function fetchFacebookGraphDebugObject(objectId, fields) {
    const token = process.env.FB_PAGE_ACCESS_TOKEN;

    if (!token) {
        throw new Error("Missing FB_PAGE_ACCESS_TOKEN");
    }

    const response = await axios.get(`https://graph.facebook.com/v19.0/${encodeURIComponent(objectId)}`, {
        params: {
            fields,
            access_token: token,
        },
    });

    return response.data;
}

async function enrichFacebookLeadAttribution(lead, leadData) {
    const leadgenId = String(leadData?.id || lead.facebook_leadgen_id || "").trim();
    let enriched = false;

    const safeFetch = async (objectId, fields, label) => {
        if (!objectId) return null;

        try {
            return await fetchFacebookGraphDebugObject(objectId, fields);
        } catch (err) {
            console.warn("Facebook attribution enrichment skipped:", {
                leadgen_id: maskDebugValue(leadgenId),
                object_type: label,
                object_id: maskDebugValue(objectId),
                reason: err.response?.data?.error?.message || err.message,
            });
            return null;
        }
    };

    const attributionLeadData = await safeFetch(
        leadgenId,
        "created_time,field_data,form_id,ad_id,campaign_id,is_organic,platform",
        "leadgen"
    );

    if (!attributionLeadData) {
        return false;
    }

    if (attributionLeadData.is_organic !== undefined) {
        lead.facebook_is_organic = attributionLeadData.is_organic;
    }
    if (attributionLeadData.platform) {
        lead.facebook_platform = attributionLeadData.platform;
    }

    const formData = await safeFetch(attributionLeadData.form_id, "name", "form");
    if (formData?.name) {
        lead.lead_form_name = formData.name;
        lead.facebook_form_name = formData.name;
        enriched = true;
    }

    const adData = await safeFetch(
        attributionLeadData.ad_id,
        "name,adset{id,name,campaign{id,name}}",
        "ad"
    );
    if (adData?.name) {
        lead.ad_name = adData.name;
        lead.facebook_ad_name = adData.name;
        enriched = true;
    }
    if (adData?.adset?.name) {
        lead.facebook_adset_id = adData.adset.id || "";
        lead.adset_name = adData.adset.name;
        lead.facebook_adset_name = adData.adset.name;
        enriched = true;
    }
    if (adData?.adset?.campaign?.name) {
        lead.campaign_name = adData.adset.campaign.name;
        lead.facebook_campaign_name = adData.adset.campaign.name;
        enriched = true;
    }

    if (attributionLeadData.campaign_id && !lead.campaign_name) {
        const campaignData = await safeFetch(attributionLeadData.campaign_id, "name", "campaign");
        if (campaignData?.name) {
            lead.campaign_name = campaignData.name;
            lead.facebook_campaign_name = campaignData.name;
            enriched = true;
        }
    }

    return enriched;
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

function formatFacebookDateTimeForSheet(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return "";
    }

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function getFacebookCreatedTimeForSheet(leadData) {
    const rawCreatedTime = String(leadData?.created_time || "").trim();

    if (!rawCreatedTime) {
        return {
            value: formatFacebookDateTimeForSheet(new Date()),
            used: false,
        };
    }

    const formattedCreatedTime = formatFacebookDateTimeForSheet(new Date(rawCreatedTime));

    return {
        value: formattedCreatedTime || formatFacebookDateTimeForSheet(new Date()),
        used: Boolean(formattedCreatedTime),
    };
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

function requireSyncSecretMiddleware(req, res, next) {
    if (!requireSyncSecret(req, res)) return;
    next();
}

function parseBooleanQuery(value) {
    return String(value || "").trim().toLowerCase() === "true";
}

async function parseAndEnrichFacebookLeadForSync(leadRef) {
    const leadgenId = String(leadRef.id || "").trim();
    const leadData = await fetchLeadDetail(leadgenId);
    const lead = parseFacebookLead(leadData);
    const attributionEnriched = await enrichFacebookLeadAttribution(lead, leadData);

    lead.source = "Facebook";
    lead.facebook_leadgen_id = String(leadData.id || leadgenId).trim();
    const facebookCreatedTime = getFacebookCreatedTimeForSheet(leadData);
    lead.facebook_created_time = facebookCreatedTime.value;
    lead.facebook_form_id = leadData.form_id || leadRef.form_id || "";
    lead.facebook_form_name = lead.lead_form_name || lead.facebook_form_name || leadRef.form_name || "";
    lead.facebook_ad_id = leadData.ad_id || "";
    lead.facebook_ad_name = lead.ad_name || lead.facebook_ad_name || "";
    lead.facebook_campaign_id = leadData.campaign_id || "";
    lead.facebook_campaign_name = lead.campaign_name || lead.facebook_campaign_name || "";
    lead.facebook_adset_name = lead.adset_name || lead.facebook_adset_name || "";
    lead.facebook_is_organic = leadData.is_organic ?? lead.facebook_is_organic ?? "";
    lead.facebook_platform = leadData.platform || lead.facebook_platform || "";
    lead.raw_data_json = JSON.stringify(leadData);

    return {
        lead,
        attributionEnriched,
        facebookCreatedTimeUsed: facebookCreatedTime.used,
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
                    const lead = parseFacebookLead(leadData);

                    lead.source = "Facebook";
                    lead.facebook_leadgen_id = String(leadData.id || leadgenId).trim();
                    const facebookCreatedTime = getFacebookCreatedTimeForSheet(leadData);
                    lead.facebook_created_time = facebookCreatedTime.value;
                    lead.facebook_form_id = leadData.form_id || "";
                    lead.facebook_form_name = "";
                    lead.facebook_ad_id = leadData.ad_id || "";
                    lead.facebook_ad_name = "";
                    lead.facebook_campaign_id = leadData.campaign_id || "";
                    lead.facebook_campaign_name = leadData.campaign_name || "";
                    lead.facebook_adset_name = leadData.adset_name || "";
                    lead.facebook_is_organic = leadData.is_organic ?? "";
                    lead.facebook_platform = leadData.platform || "";
                    lead.raw_data_json = JSON.stringify(leadData);
                    const attributionEnriched = await enrichFacebookLeadAttribution(lead, leadData);

                    if (!lead.facebook_leadgen_id) {
                        console.warn("⚠️ Webhook lead has no facebook_leadgen_id → skip");
                        continue;
                    }

                    if (!lead.phone && !lead.name) {
                        console.warn("⚠️ Webhook parsed lead is empty → skip:", leadgenId);
                        continue;
                    }

                    const result = await appendLeadToSheet(lead);
                    result.attribution_enriched = attributionEnriched;
                    result.facebook_created_time_used = facebookCreatedTime.used;

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
        if (mode === "full") {
            const startedAtMs = Date.now();
            const stopAtMs = startedAtMs + 120000;
            let fullSyncResponded = false;
            let fullSyncProcessingStarted = false;
            let fullSyncResponseTimer = null;
            let latestFullSyncCounters = {
                fetched_total: 0,
                processed: 0,
                parsed: 0,
                inserted: 0,
                updated_existing: 0,
                skipped_existing: 0,
                skipped_empty: 0,
                failed: 0,
                enriched_success: 0,
                facebook_created_time_used: 0,
                facebook_created_time_missing: 0,
                stopped_early: false,
                stop_reason: "",
            };
            const sendFullSyncResponse = (statusCode, payload) => {
                if (fullSyncResponded || res.headersSent) return false;
                fullSyncResponded = true;
                console.log("[full-sync] response sent", {
                    status_code: statusCode,
                    ...latestFullSyncCounters,
                });
                res.status(statusCode).json(payload);
                return true;
            };
            const startFullSyncResponseTimer = () => {
                if (fullSyncResponseTimer) return;
                fullSyncResponseTimer = setTimeout(() => {
                    if (!fullSyncProcessingStarted && latestFullSyncCounters.processed <= 0) {
                        console.log("[full-sync] timeout guard skipped before processing started");
                        return;
                    }

                    latestFullSyncCounters = {
                        ...latestFullSyncCounters,
                        stopped_early: true,
                        stop_reason: latestFullSyncCounters.stop_reason || "response_timeout_guard",
                    };
                    sendFullSyncResponse(504, {
                        success: false,
                        mode: "full",
                        error: "Full sync response timeout guard reached. Some in-flight work may still finish.",
                        ...latestFullSyncCounters,
                        continue_instructions: "Retry with dry_run=true first, then run mode=full with limit=50 or 100 and max_total=100 per request.",
                    });
                }, 120000);
            };
            const pageSizeQuery = Number(req.query.limit);
            const pageSize = Number.isFinite(pageSizeQuery) && pageSizeQuery > 0
                ? Math.min(pageSizeQuery, 100)
                : 100;
            const maxTotalQuery = Number(req.query.max_total);
            const maxTotal = Number.isFinite(maxTotalQuery) && maxTotalQuery > 0
                ? maxTotalQuery
                : null;
            const dryRun = parseBooleanQuery(req.query.dry_run);
            console.log("[full-sync] fetching lead forms");
            console.log("[full-sync] entering pagination loop");
            const fullFetchResult = await fetchAllLeadIdsFromPage({
                pageSize,
                maxTotal,
                stopAtMs,
            });
            const leadRefs = fullFetchResult.leads
                .slice()
                .sort((a, b) => new Date(a.created_time || 0) - new Date(b.created_time || 0));
            const failedItems = [];
            let parsed = 0;
            let inserted = 0;
            let updatedExisting = 0;
            let skippedExisting = 0;
            let skippedEmpty = 0;
            let enrichedSuccess = 0;
            let facebookCreatedTimeUsed = 0;
            let facebookCreatedTimeMissing = 0;
            let processed = 0;
            let stoppedEarly = fullFetchResult.stopped_early;
            let stopReason = fullFetchResult.stop_reason || "";
            let batchSkippedEmptyItems = [];
            const batchSize = pageSize;

            console.log("[full-sync] started processing");
            fullSyncProcessingStarted = true;
            startFullSyncResponseTimer();

            for (let i = 0; i < leadRefs.length; i += batchSize) {
                if (Date.now() >= stopAtMs) {
                    stoppedEarly = true;
                    stopReason = stopReason || "timeout_guard";
                    break;
                }

                const batchRefs = leadRefs.slice(i, i + batchSize);
                const parsedBatch = [];

                for (const leadRef of batchRefs) {
                    const leadgenId = String(leadRef.id || "").trim();

                    if (!leadgenId) {
                        skippedEmpty++;
                        failedItems.push({
                            leadgen_id: "",
                            reason: "missing_leadgen_id",
                        });
                        continue;
                    }

                    try {
                        const { lead, attributionEnriched, facebookCreatedTimeUsed: createdTimeUsed } = await parseAndEnrichFacebookLeadForSync(leadRef);
                        if (attributionEnriched) enrichedSuccess++;
                        if (createdTimeUsed) facebookCreatedTimeUsed++;
                        else facebookCreatedTimeMissing++;

                        if (!lead.facebook_leadgen_id) {
                            skippedEmpty++;
                            failedItems.push({
                                leadgen_id: leadgenId,
                                reason: "missing_facebook_leadgen_id",
                            });
                            continue;
                        }

                        if (!lead.phone && !lead.name) {
                            skippedEmpty++;
                            failedItems.push({
                                leadgen_id: leadgenId,
                                reason: "missing_phone_and_name",
                            });
                            continue;
                        }

                        parsedBatch.push(lead);
                        parsed++;
                    } catch (err) {
                        failedItems.push({
                            leadgen_id: leadgenId,
                            form_id: leadRef.form_id || "",
                            form_name: leadRef.form_name || "",
                            reason: err.message,
                        });
                    }
                }

                processed += batchRefs.length;
                latestFullSyncCounters = {
                    ...latestFullSyncCounters,
                    fetched_total: leadRefs.length,
                    processed,
                    parsed,
                    inserted,
                    updated_existing: updatedExisting,
                    skipped_existing: skippedExisting,
                    skipped_empty: skippedEmpty,
                    failed: failedItems.length,
                    enriched_success: enrichedSuccess,
                    facebook_created_time_used: facebookCreatedTimeUsed,
                    facebook_created_time_missing: facebookCreatedTimeMissing,
                    stopped_early: stoppedEarly,
                    stop_reason: stopReason,
                };

                if (dryRun || !parsedBatch.length) {
                    if (Date.now() >= stopAtMs) {
                        stoppedEarly = true;
                        stopReason = stopReason || "timeout_guard_after_batch";
                        latestFullSyncCounters = {
                            ...latestFullSyncCounters,
                            stopped_early: stoppedEarly,
                            stop_reason: stopReason,
                        };
                        break;
                    }
                    continue;
                }

                console.log("[full-sync] writing batch", { size: parsedBatch.length });
                const batchResult = await appendLeadsToSheetBatch(parsedBatch);
                inserted += batchResult.created;
                updatedExisting += batchResult.updated_existing;
                skippedExisting += batchResult.skipped_existing;
                skippedEmpty += batchResult.skipped_empty;
                batchSkippedEmptyItems = batchSkippedEmptyItems.concat(batchResult.skipped_empty_items || []);
                latestFullSyncCounters = {
                    ...latestFullSyncCounters,
                    inserted,
                    updated_existing: updatedExisting,
                    skipped_existing: skippedExisting,
                    skipped_empty: skippedEmpty,
                    failed: failedItems.length,
                    enriched_success: enrichedSuccess,
                    facebook_created_time_used: facebookCreatedTimeUsed,
                    facebook_created_time_missing: facebookCreatedTimeMissing,
                    stopped_early: stoppedEarly,
                    stop_reason: stopReason,
                };
                console.log("[full-sync] write complete", latestFullSyncCounters);

                if (Date.now() >= stopAtMs) {
                    stoppedEarly = true;
                    stopReason = stopReason || "timeout_guard_after_write";
                    latestFullSyncCounters = {
                        ...latestFullSyncCounters,
                        stopped_early: stoppedEarly,
                        stop_reason: stopReason,
                    };
                    break;
                }
            }

            const failed = failedItems.length;
            latestFullSyncCounters = {
                fetched_total: leadRefs.length,
                processed,
                parsed,
                inserted,
                updated_existing: updatedExisting,
                skipped_existing: skippedExisting,
                skipped_empty: skippedEmpty,
                failed,
                enriched_success: enrichedSuccess,
                facebook_created_time_used: facebookCreatedTimeUsed,
                facebook_created_time_missing: facebookCreatedTimeMissing,
                stopped_early: stoppedEarly,
                stop_reason: stopReason,
            };

            if (fullSyncResponseTimer) clearTimeout(fullSyncResponseTimer);
            return sendFullSyncResponse(200, {
                success: true,
                mode: "full",
                dry_run: dryRun,
                page_size: pageSize,
                max_total: maxTotal,
                fetched_total: leadRefs.length,
                processed,
                parsed,
                inserted,
                updated_existing: updatedExisting,
                skipped_existing: skippedExisting,
                skipped_empty: skippedEmpty,
                failed,
                enriched_success: enrichedSuccess,
                facebook_created_time_used: facebookCreatedTimeUsed,
                facebook_created_time_missing: facebookCreatedTimeMissing,
                stopped_early: stoppedEarly,
                stop_reason: stopReason,
                next_cursor: fullFetchResult.next_cursor || null,
                continue_instructions: stoppedEarly
                    ? "Run the same full sync again. Existing facebook_leadgen_id rows will be skipped."
                    : "",
                failed_items: failedItems.slice(0, 30),
                batch_skipped_empty_items: batchSkippedEmptyItems.slice(0, 30),
            });
        }

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
        let enriched_success = 0;
        let facebook_created_time_used = 0;
        let facebook_created_time_missing = 0;
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
                const facebookCreatedTime = getFacebookCreatedTimeForSheet(leadData);
                lead.facebook_created_time = facebookCreatedTime.value;
                if (facebookCreatedTime.used) facebook_created_time_used++;
                else facebook_created_time_missing++;
                lead.facebook_form_id = leadData.form_id || leadRef.form_id || "";
                lead.facebook_form_name = leadRef.form_name || "";
                lead.facebook_ad_id = leadData.ad_id || "";
                lead.facebook_ad_name = "";
                lead.facebook_campaign_id = leadData.campaign_id || "";
                lead.facebook_campaign_name = leadData.campaign_name || "";
                lead.facebook_adset_name = leadData.adset_name || "";
                lead.facebook_is_organic = leadData.is_organic ?? "";
                lead.facebook_platform = leadData.platform || "";
                lead.raw_data_json = JSON.stringify(leadData);
                const attributionEnriched = await enrichFacebookLeadAttribution(lead, leadData);
                if (attributionEnriched) enriched_success++;

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
            enriched_success,
            facebook_created_time_used,
            facebook_created_time_missing,
            affected_rows: batchResult.affected_rows || [],
            incremental_cleanup_attempted: batchResult.incremental_cleanup_attempted || false,
            incremental_cleanup_rows: batchResult.incremental_cleanup_rows || 0,
            full_cleanup_required: batchResult.full_cleanup_required || false,
            failed_items: failedItems.slice(0, 30),
            batch_skipped_empty_items: batchResult.skipped_empty_items.slice(0, 30),
        });
    } catch (err) {
        console.error("❌ Facebook lead batch sync failed:", err.message);

        if (res.headersSent) return;

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

console.log("[debug] facebook lead enrichment route registered: GET /debug/facebook-lead/:leadgenId");

app.get("/debug/routes", requireSyncSecretMiddleware, (req, res) => {
    return res.status(200).json({
        success: true,
        debug_routes: [
            "GET /debug/facebook-access",
            "GET /debug/facebook-form",
            "GET /debug/leadgen-forms",
            "GET /debug/facebook-form-raw",
            "GET /debug/facebook-leads-dry-run",
            "GET /debug/facebook-lead/:leadgenId",
            "GET /debug/lead/:leadgenId",
        ],
    });
});

app.get("/debug/facebook-leads-dry-run", requireSyncSecretMiddleware, async (req, res) => {
    try {
        const limitQuery = Number(req.query.limit);
        const limit = Number.isFinite(limitQuery) && limitQuery > 0 ? limitQuery : 20;
        const leadRefs = await fetchLatestLeadIdsFromPage({ limit });
        const preview = [];
        const failedItems = [];
        let parsed = 0;
        let enrichedSuccess = 0;
        let missingPhone = 0;
        let missingCustomerName = 0;
        let missingForm = 0;
        let missingAd = 0;
        let missingCampaign = 0;

        for (const leadRef of leadRefs) {
            const leadgenId = String(leadRef.id || "").trim();
            if (!leadgenId) {
                failedItems.push({ leadgen_id: "", reason: "missing_leadgen_id" });
                continue;
            }

            try {
                const leadData = await fetchLeadDetail(leadgenId);
                const lead = parseFacebookLead(leadData);

                lead.source = "Facebook";
                lead.facebook_leadgen_id = String(leadData.id || leadgenId).trim();
                lead.facebook_form_id = leadData.form_id || leadRef.form_id || "";
                lead.facebook_form_name = leadRef.form_name || "";
                lead.facebook_ad_id = leadData.ad_id || "";
                lead.facebook_ad_name = "";
                lead.facebook_campaign_id = leadData.campaign_id || "";
                lead.facebook_campaign_name = leadData.campaign_name || "";
                lead.facebook_adset_name = leadData.adset_name || "";

                const attributionEnriched = await enrichFacebookLeadAttribution(lead, leadData);
                if (attributionEnriched) enrichedSuccess++;

                const missingFields = [];
                if (!lead.phone) missingFields.push("phone");
                if (!lead.name) missingFields.push("customer_name");
                if (!lead.lead_form_name && !lead.facebook_form_name) missingFields.push("form_name");
                if (!lead.ad_name && !lead.facebook_ad_name) missingFields.push("ad_name");
                if (!lead.campaign_name && !lead.facebook_campaign_name) missingFields.push("campaign_name");

                if (!lead.phone) missingPhone++;
                if (!lead.name) missingCustomerName++;
                if (!lead.lead_form_name && !lead.facebook_form_name) missingForm++;
                if (!lead.ad_name && !lead.facebook_ad_name) missingAd++;
                if (!lead.campaign_name && !lead.facebook_campaign_name) missingCampaign++;

                parsed++;
                preview.push({
                    leadgen_id: lead.facebook_leadgen_id,
                    customer_name: lead.name || "",
                    phone: lead.phone || "",
                    form_name: lead.lead_form_name || lead.facebook_form_name || "",
                    ad_name: lead.ad_name || lead.facebook_ad_name || "",
                    adset_name: lead.adset_name || lead.facebook_adset_name || "",
                    campaign_name: lead.campaign_name || lead.facebook_campaign_name || "",
                    has_required_data: Boolean(lead.phone && lead.name),
                    missing_fields: missingFields,
                });

                console.log("Facebook dry-run lead parsed:", {
                    leadgen_id: maskDebugValue(leadgenId),
                    customer_name: maskDebugName(lead.name),
                    phone: maskDebugValue(lead.phone),
                    enriched: attributionEnriched,
                    missing_fields: missingFields,
                });
            } catch (err) {
                failedItems.push({
                    leadgen_id: maskDebugValue(leadgenId),
                    reason: err.response?.data?.error?.message || err.message,
                });
            }
        }

        return res.status(200).json({
            success: true,
            dry_run: true,
            limit,
            fetched: leadRefs.length,
            parsed,
            enriched_success: enrichedSuccess,
            missing_phone: missingPhone,
            missing_customer_name: missingCustomerName,
            missing_form: missingForm,
            missing_ad: missingAd,
            missing_campaign: missingCampaign,
            preview,
            failed_items: failedItems.slice(0, 30),
        });
    } catch (err) {
        console.error("Facebook dry-run failed:", err.response?.data || err.message);
        return res.status(500).json({
            success: false,
            dry_run: true,
            error: err.response?.data || err.message,
        });
    }
});

app.get("/debug/facebook-lead/:leadgenId", requireSyncSecretMiddleware, async (req, res) => {
    try {
        const leadgenId = String(req.params.leadgenId || "").trim();

        if (!leadgenId) {
            return res.status(400).json({
                error: "Missing leadgenId",
            });
        }

        const leadData = await fetchFacebookGraphDebugObject(
            leadgenId,
            "created_time,field_data,form_id,ad_id,campaign_id"
        );
        const fieldData = leadData.field_data || [];
        const customerName = getFacebookFieldValue(fieldData, "full_name", "name", "first_name", "customer_name");
        const phone = getFacebookFieldValue(fieldData, "phone_number", "phone", "mobile_phone");
        let form = null;
        let ad = null;
        let adset = null;
        let campaign = null;

        if (leadData.form_id) {
            const formData = await fetchFacebookGraphDebugObject(
                leadData.form_id,
                "id,name"
            );
            form = {
                id: formData.id || leadData.form_id,
                name: formData.name || "",
            };
        }

        if (leadData.ad_id) {
            const adData = await fetchFacebookGraphDebugObject(
                leadData.ad_id,
                "id,name,adset{id,name,campaign{id,name}},campaign{id,name}"
            );
            ad = {
                id: adData.id || leadData.ad_id,
                name: adData.name || "",
            };
            if (adData.adset) {
                adset = {
                    id: adData.adset.id || "",
                    name: adData.adset.name || "",
                };
            }
            if (adData.campaign) {
                campaign = {
                    id: adData.campaign.id || "",
                    name: adData.campaign.name || "",
                };
            } else if (adData.adset?.campaign) {
                campaign = {
                    id: adData.adset.campaign.id || "",
                    name: adData.adset.campaign.name || "",
                };
            }
        }

        if (leadData.campaign_id) {
            const campaignData = await fetchFacebookGraphDebugObject(
                leadData.campaign_id,
                "id,name"
            );
            campaign = {
                id: campaignData.id || leadData.campaign_id,
                name: campaignData.name || "",
            };
        }

        console.log("Facebook lead debug fetched:", {
            leadgen_id: maskDebugValue(leadgenId),
            has_customer_name: Boolean(customerName),
            has_phone: Boolean(phone),
            has_form: Boolean(form),
            has_ad: Boolean(ad),
            has_adset: Boolean(adset),
            has_campaign: Boolean(campaign),
        });

        return res.status(200).json({
            leadgen_id: leadData.id || leadgenId,
            customer_name: customerName,
            phone,
            form,
            ad,
            adset,
            campaign,
        });
    } catch (err) {
        console.error("Facebook lead debug failed:", err.response?.data || err.message);
        return res.status(500).json({
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

app.post("/import/legacy", handleLegacyCrm2Import);
app.post("/import/legacy-crm1", handleLegacyCrm1Import);
app.post("/import/legacy/cleanup-lead-status", handleLegacyLeadStatusCleanup);
app.post("/webhook/line", handleLineWebhook);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
