const { normalizePhone } = require("./googleSheets");

const FIELD_ALIASES = {
    customer_name: ["ชื่อ", "ชื่อลูกค้า", "name", "customer"],
    phone: ["เบอร์", "เบอร์โทร", "โทร", "phone", "tel", "mobile"],
    product_interest: ["สนใจ", "สินค้า", "รุ่น", "product", "interest"],
    province: ["จังหวัด", "province", "location"],
    note: ["หมายเหตุ", "note", "รายละเอียด", "อื่นๆ"],
};

function normalizeKey(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ")
        .replace(/\s+/g, " ");
}

function fieldNameForKey(key) {
    const normalizedKey = normalizeKey(key);

    for (const [fieldName, aliases] of Object.entries(FIELD_ALIASES)) {
        if (aliases.some(alias => {
            const normalizedAlias = normalizeKey(alias);
            return normalizedAlias === normalizedKey
                || normalizedKey.includes(normalizedAlias)
                || normalizedAlias.includes(normalizedKey);
        })) {
            return fieldName;
        }
    }

    return "";
}

function normalizeLineProvince(value) {
    const raw = String(value || "").trim();
    const key = raw.toLowerCase().replace(/[.\-_/()\s]+/g, "");

    if (!raw) return "";
    if (["กทม", "กรุงเทพ", "กรุงเทพฯ", "กรุงเทพมหานคร", "bangkok", "bkk"].includes(key)) {
        return "กรุงเทพมหานคร";
    }

    return raw;
}

function parseLineLeadMessage(message, profile = {}) {
    const data = {
        source: "LINE",
        phone: "",
        customer_name: "",
        product_interest: "",
        province: "",
        note: "",
        line_user_id: String(profile.lineUserId || "").trim(),
        line_display_name: String(profile.displayName || "").trim(),
        lead_status: "New",
    };

    const lines = String(message || "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        const match = line.match(/^([^:：=]+)[:：=](.*)$/);
        if (!match) continue;

        const fieldName = fieldNameForKey(match[1]);
        if (!fieldName) continue;

        const value = String(match[2] || "").trim();
        if (!value) continue;

        data[fieldName] = value;
    }

    data.phone = normalizePhone(data.phone);
    data.customer_name = data.customer_name || data.line_display_name;
    data.province = normalizeLineProvince(data.province);

    if (!data.phone) {
        return {
            ok: false,
            reason: "missing_phone",
            message: "กรุณาระบุเบอร์โทร เช่น เบอร์: 0812345678",
            data,
        };
    }

    return { ok: true, data };
}

module.exports = {
    parseLineLeadMessage,
    normalizeLineProvince,
};
