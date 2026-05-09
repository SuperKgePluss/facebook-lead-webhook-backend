const crypto = require("crypto");
const axios = require("axios");
const googleSheets = require("./googleSheets");
const { parseLineLeadMessage } = require("./lineLeadParser");

function generateLineImportId(prefix) {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function formatLineDateTime(date = new Date()) {
    const pad = value => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function verifyLineSignature(rawBody, signature, channelSecret) {
    if (!rawBody || !signature || !channelSecret) return false;

    const expected = crypto
        .createHmac("sha256", channelSecret)
        .update(rawBody)
        .digest("base64");

    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);

    return expectedBuffer.length === signatureBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

async function replyLineMessage(replyToken, text) {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!replyToken || !token) return;

    await axios.post(
        "https://api.line.me/v2/bot/message/reply",
        {
            replyToken,
            messages: [{ type: "text", text }],
        },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        }
    );
}

async function fetchLineProfileDisplayName(userId) {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!userId || !token) return "";

    try {
        const response = await axios.get(
            `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );
        return String(response.data?.displayName || "").trim();
    } catch (err) {
        console.error("LINE profile fetch failed:", err.response?.data || err.message);
        return "";
    }
}

function buildLineActivityNote(data, messageText) {
    return [
        data.product_interest ? `Product Interest: ${data.product_interest}` : "",
        data.note ? `Note: ${data.note}` : "",
        messageText ? `Message: ${messageText}` : "",
    ].filter(Boolean).join("\n");
}

async function findLeadDetailByLeadId(leadId) {
    const rows = await googleSheets.getSheetRows("LEAD_DETAILS");
    const headers = rows[0] || [];
    const target = String(leadId || "").trim();

    for (let i = 2; i < rows.length; i++) {
        const object = googleSheets.rowToObject(headers, rows[i]);
        if (String(object.lead_id || "").trim() === target) {
            return { ...object, rowNumber: i + 1 };
        }
    }

    return null;
}

function findLineLeadByPhone(headers, rows, phone) {
    const target = googleSheets.normalizePhone(phone);
    if (!target) return null;

    const phoneColumn = googleSheets.headerIndex(headers, "phone");
    for (let i = 2; i < rows.length; i++) {
        const rowPhone = googleSheets.normalizePhone(rows[i]?.[phoneColumn]);
        if (rowPhone && rowPhone === target) {
            return {
                ...googleSheets.rowToObject(headers, rows[i]),
                rowNumber: i + 1,
            };
        }
    }

    return null;
}

async function upsertLineLead(data, messageText) {
    const leadRows = await googleSheets.getSheetRows("LEADS_MAIN");
    const leadHeaders = leadRows[0] || [];
    const existingLead = findLineLeadByPhone(leadHeaders, leadRows, data.phone);
    const now = formatLineDateTime(new Date());
    let leadId = existingLead?.lead_id || "";
    let action = "created";

    if (!existingLead) {
        leadId = generateLineImportId("LEAD");
        await googleSheets.appendObjects("LEADS_MAIN", [{
            lead_id: leadId,
            customer_name: data.customer_name,
            phone: data.phone,
            source: "LINE",
            lead_status: "New",
            province: data.province,
            note: data.note,
            created_at: now,
            updated_at: now,
        }]);
    } else {
        action = "updated_existing";
        const updateObject = { updated_at: now };
        if (!String(existingLead.customer_name || "").trim() && data.customer_name) updateObject.customer_name = data.customer_name;
        if (!String(existingLead.source || "").trim()) updateObject.source = "LINE";
        if (!String(existingLead.province || "").trim() && data.province) updateObject.province = data.province;
        if (!String(existingLead.note || "").trim() && data.note) updateObject.note = data.note;
        await googleSheets.updateObjectRow("LEADS_MAIN", existingLead.rowNumber, updateObject);
    }

    const detailObject = {
        lead_id: leadId,
        raw_phone: data.phone,
        line_user_id: data.line_user_id,
        line_display_name: data.line_display_name,
        original_customer_name: data.customer_name,
        created_source: "LINE",
    };
    const existingDetail = await findLeadDetailByLeadId(leadId);
    if (existingDetail?.rowNumber) {
        const detailUpdate = { lead_id: leadId };
        for (const [key, value] of Object.entries(detailObject)) {
            if (key === "lead_id") continue;
            if (String(value || "").trim()) detailUpdate[key] = value;
        }
        await googleSheets.updateObjectRow("LEAD_DETAILS", existingDetail.rowNumber, detailUpdate);
    } else {
        await googleSheets.appendObjects("LEAD_DETAILS", [detailObject]);
    }

    await googleSheets.appendObjects("ACTIVITY_LOG", [{
        activity_id: generateLineImportId("ACT"),
        lead_id: leadId,
        sheet_name: "LINE",
        action_type: "LINE Lead Message",
        note: buildLineActivityNote(data, messageText),
        created_by: "LINE",
        created_at: now,
    }]);

    return { action, leadId };
}

async function handleLineWebhook(req, res) {
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const signature = req.get("x-line-signature") || "";

    if (!verifyLineSignature(req.rawBody, signature, channelSecret)) {
        return res.status(401).json({ success: false, error: "invalid_line_signature" });
    }

    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    for (const event of events) {
        if (event.type !== "message" || event.message?.type !== "text") continue;

        const lineUserId = event.source?.userId || "";
        const displayName = await fetchLineProfileDisplayName(lineUserId);
        const profile = {
            lineUserId,
            displayName,
        };
        const parsed = parseLineLeadMessage(event.message.text, profile);

        if (!parsed.ok && parsed.reason === "missing_phone") {
            try {
                await replyLineMessage(event.replyToken, "กรุณาระบุเบอร์โทร เช่น เบอร์: 0812345678");
            } catch (err) {
                console.error("LINE reply failed:", err.response?.data || err.message);
            }
            continue;
        }

        if (!parsed.ok) continue;

        try {
            const result = await upsertLineLead(parsed.data, event.message.text);
            const replyText = result.action === "updated_existing"
                ? "พบข้อมูลลูกค้านี้ในระบบแล้ว และบันทึกข้อความเพิ่มเติมเรียบร้อยแล้วค่ะ"
                : "บันทึกข้อมูลเรียบร้อยแล้วค่ะ";
            await replyLineMessage(event.replyToken, replyText);
        } catch (err) {
            console.error("LINE lead save failed:", err.response?.data || err.message);
            try {
                await replyLineMessage(event.replyToken, "ระบบบันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้งค่ะ");
            } catch (replyErr) {
                console.error("LINE error reply failed:", replyErr.response?.data || replyErr.message);
            }
        }
    }

    return res.status(200).json({ success: true, processed_events: events.length });
}

module.exports = {
    handleLineWebhook,
    verifyLineSignature,
    upsertLineLead,
};
