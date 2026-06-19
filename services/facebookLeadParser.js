const DEFAULT_NAME_FIELD_KEYS = [
    "full_name",
    "name",
    "customer_name",
];

const FIRST_NAME_KEYS = [
    "first_name",
];

const LAST_NAME_KEYS = [
    "last_name",
];

function normalizeFacebookFieldName(name) {
    return String(name || "")
        .trim()
        .toLowerCase();
}

function getFacebookFieldValues(fieldData, names) {
    if (!Array.isArray(fieldData)) return [];

    const normalizedNames = names.map(normalizeFacebookFieldName);
    const found = fieldData.find(item => {
        const itemName = normalizeFacebookFieldName(item?.name);
        return normalizedNames.includes(itemName);
    });

    return Array.isArray(found?.values) ? found.values : [];
}

function getFirstFacebookFieldValue(fieldData, names) {
    const values = getFacebookFieldValues(fieldData, names);
    return values.length ? String(values[0] || "").trim() : "";
}

function getConfiguredNameFieldKeys() {
    return String(process.env.FB_NAME_FIELD_KEYS || "")
        .split(",")
        .map(value => normalizeFacebookFieldName(value))
        .filter(Boolean);
}

function isSuspiciousCustomerName(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    if (raw.length > 120) return true;
    if (/\r|\n/.test(raw)) return true;
    if (/https?:\/\//i.test(raw)) return true;
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(raw)) return true;
    if (/\b\d{8,}\b/.test(raw.replace(/[\s\-()]/g, ""))) return true;
    if (/[.!?]/.test(raw) && raw.length > 60) return true;
    return false;
}

function selectFacebookLeadCustomerName(fieldData, options = {}) {
    const logger = options.logger || console;
    const leadgenId = options.leadgenId || "";
    const formId = options.formId || "";
    const nameKeys = DEFAULT_NAME_FIELD_KEYS.concat(getConfiguredNameFieldKeys());
    const directName = getFirstFacebookFieldValue(fieldData, nameKeys);

    if (directName && !isSuspiciousCustomerName(directName)) {
        return directName;
    }

    if (directName) {
        logger.warn("Facebook lead customer name rejected", {
            leadgen_id: leadgenId,
            form_id: formId,
            reason: "suspicious_direct_name",
            preview: directName.slice(0, 120),
        });
    }

    const firstName = getFirstFacebookFieldValue(fieldData, FIRST_NAME_KEYS);
    const lastName = getFirstFacebookFieldValue(fieldData, LAST_NAME_KEYS);
    const combinedName = [firstName, lastName].map(value => String(value || "").trim()).filter(Boolean).join(" ");
    if (combinedName && !isSuspiciousCustomerName(combinedName)) {
        return combinedName;
    }

    if (combinedName) {
        logger.warn("Facebook lead customer name rejected", {
            leadgen_id: leadgenId,
            form_id: formId,
            reason: "suspicious_first_last_name",
            preview: combinedName.slice(0, 120),
        });
    } else {
        logger.warn("Facebook lead customer name missing", {
            leadgen_id: leadgenId,
            form_id: formId,
            reason: "no_verified_name_field",
        });
    }

    return "";
}

function getFacebookCreatedTimeForSheetValue(leadData) {
    const rawCreatedTime = String(leadData?.created_time || "").trim();
    const hasExplicitTimezone = /(Z|[+-]\d{2}:?\d{2})$/i.test(rawCreatedTime);
    const parsed = rawCreatedTime && hasExplicitTimezone ? new Date(rawCreatedTime) : null;

    return {
        value: parsed && !Number.isNaN(parsed.getTime()) ? rawCreatedTime : "",
        used: Boolean(parsed && !Number.isNaN(parsed.getTime())),
    };
}

module.exports = {
    getFacebookCreatedTimeForSheetValue,
    getFirstFacebookFieldValue,
    isSuspiciousCustomerName,
    selectFacebookLeadCustomerName,
};
