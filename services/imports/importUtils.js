const LEGACY_IMPORT_STATUS = "Legacy Import";

function parseDryRunParam(req) {
    return String(req.query.dry_run ?? "true").trim().toLowerCase() !== "false";
}

function normalizeImportText(value) {
    return String(value || "")
        .replace(/[\u0300-\u036f\u200B-\u200D\uFEFF\u00A0]/g, " ")
        .replace(/_/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function normalizeLooseMappingKey(value) {
    return normalizeImportText(value)
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
        const ruleType = normalizeImportText(rowObject.rule_type);
        const inputValue = normalizeImportText(rowObject.input_value);
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

        if (!entriesByType.has(ruleType)) entriesByType.set(ruleType, []);

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

    return mappingRules.rules.has(`invalid_value::${normalizeImportText(raw)}`)
        || mappingRules.rules.has(`invalid_value::${normalizeLooseMappingKey(raw)}`);
}

function normalizeByMappingRules(mappingRules, ruleType, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw || isInvalidByMappingRules(mappingRules, raw)) return "";

    const normalizedRuleType = normalizeImportText(ruleType);
    if (normalizedRuleType === "province" && /^\d+$/.test(raw.replace(/\s+/g, ""))) return "";

    const exactKey = `${normalizedRuleType}::${normalizeImportText(raw)}`;
    const looseKey = `${normalizedRuleType}::${normalizeLooseMappingKey(raw)}`;

    if (mappingRules.rules.has(exactKey)) return mappingRules.rules.get(exactKey);
    if (mappingRules.rules.has(looseKey)) return mappingRules.rules.get(looseKey);

    return "";
}

function hasMappingRule(mappingRules, ruleType, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) return false;

    const normalizedRuleType = normalizeImportText(ruleType);
    return mappingRules.rules.has(`${normalizedRuleType}::${normalizeImportText(raw)}`)
        || mappingRules.rules.has(`${normalizedRuleType}::${normalizeLooseMappingKey(raw)}`);
}

function normalizeMultiByMappingRules(mappingRules, ruleType, rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw || isInvalidByMappingRules(mappingRules, raw)) return "";

    const normalizedRuleType = normalizeImportText(ruleType);
    const entries = mappingRules.entriesByType.get(normalizedRuleType) || [];
    const rawKey = normalizeImportText(raw);
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
    return normalizeLegacySourceValue(source, mappingRules);
}

function normalizeLegacySourceValue(source, mappingRules = null) {
    const mapped = mappingRules && (hasMappingRule(mappingRules, "source", source) || isInvalidByMappingRules(mappingRules, source))
        ? normalizeByMappingRules(mappingRules, "source", source)
        : "";
    const raw = String(mapped || source || "").trim();
    const value = raw.toLowerCase();

    if (!raw) return LEGACY_IMPORT_STATUS;

    if (value.includes("lead gen")) return "Facebook";
    if (value.includes("leadgen")) return "Facebook";
    if (value.includes("facebook")) return "Facebook";
    if (value === "fb" || value.includes("fb chat")) return "Facebook";
    if (value.includes("line")) return "LINE";
    if (value.includes("manual")) return "Manual";
    if (value.includes("cold call") || value.includes("coldcall")) return "Cold call";

    if (["facebook", "line", "manual", "cold call"].includes(value)) return raw;

    return LEGACY_IMPORT_STATUS;
}

function mapLegacyStatus(classification, mappingRules) {
    return normalizeLegacyLeadStatusValue(classification, mappingRules);
}

function normalizeLegacyLeadStatusValue(status, mappingRules = null, signals = {}) {
    const mapped = mappingRules && (hasMappingRule(mappingRules, "lead_status", status) || isInvalidByMappingRules(mappingRules, status))
        ? normalizeByMappingRules(mappingRules, "lead_status", status)
        : "";
    const explicit = String(mapped || status || "").trim();
    const signalText = [
        explicit,
        signals.stage,
        signals.result,
        signals.installStatus,
        signals.paymentStatus,
        signals.sourceMarker,
        signals.closedDate ? "closed" : "",
        signals.paid ? "paid" : "",
    ].filter(Boolean).join(" ");
    const value = signalText.toLowerCase();

    if (value.includes("not interested") || value.includes("cancel") || value.includes("ยกเลิก")) {
        return "Not Interested";
    }

    if (
        value.includes("close won")
        || value.includes("closed")
        || value.includes("paid")
        || value.includes("ชำระครบแล้ว")
        || signals.closedDate
    ) {
        return "Closed";
    }

    if (value.includes("follow")) return "Follow-up";
    if (value.includes("pending") || value.includes("รอ")) return "Pending";

    if (explicit && explicit !== LEGACY_IMPORT_STATUS) return explicit;

    return "New";
}

function mapLegacyReason(reason, mappingRules) {
    return normalizeByMappingRules(mappingRules, "reason", reason);
}

function normalizeLegacyProvince(rawProvince, mappingRules) {
    const raw = String(rawProvince || "").trim();
    if (!raw) return { province: "", rawProvince: "", wasNormalized: false, wasInvalid: false };

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
    if (!raw) return { value: "", isBlank: true, isInvalid: false };

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

    if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return buildResult(new Date(raw));

    return { value: "", isBlank: false, isInvalid: true };
}

function normalizeLegacyImportPhone(rawPhone, googleSheets) {
    const cleanPhone = googleSheets.normalizePhone(rawPhone);
    return /^0\d{9}$/.test(cleanPhone) ? cleanPhone : "";
}

function getLegacyValue(rowObject, googleSheets, aliasesByField, fieldName) {
    const aliases = aliasesByField[fieldName] || [];

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

function rowHasAnyValue(row) {
    return Array.isArray(row) && row.some(cell => String(cell || "").trim() !== "");
}

function extractUrls(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];

    return raw.match(/https?:\/\/[^\s,;]+/gi) || [];
}

function isLegacyAudioHeader(headerName) {
    const header = String(headerName || "").toLowerCase();
    return header.includes("call_recording")
        || header.includes("call_recording_url")
        || header.includes("audio")
        || header.includes("recording");
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

function generateImportId(prefix) {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function putIfBlank(updateObject, existingObject, key, value) {
    const existingValue = String(existingObject?.[key] || "").trim();
    const incomingValue = String(value || "").trim();

    if (!existingValue && incomingValue) updateObject[key] = incomingValue;
}

module.exports = {
    LEGACY_IMPORT_STATUS,
    parseDryRunParam,
    normalizeImportText,
    normalizeByMappingRules,
    normalizeMultiByMappingRules,
    normalizeLegacySourceValue,
    normalizeLegacyLeadStatusValue,
    mapLegacySource,
    mapLegacyStatus,
    mapLegacyReason,
    normalizeLegacyProvince,
    normalizeLegacyZone,
    formatLegacyDateForSheet,
    parseLegacyDateValue,
    normalizeLegacyImportPhone,
    getLegacyValue,
    hasAnyValue,
    rowHasAnyValue,
    extractUrls,
    isLegacyAudioHeader,
    loadMappingRules,
    readFirstAvailableSheet,
    generateImportId,
    putIfBlank,
};
