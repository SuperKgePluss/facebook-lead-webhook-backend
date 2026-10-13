"use strict";

const PHONE_PATTERN = /^0\d{9}$/;
const AUDIO_EXTENSIONS = /\.(?:mp3|m4a|wav|ogg|mp4|aac)$/i;

function text(value) {
    return String(value ?? "").trim();
}

function normalizeThaiPhone(value) {
    let digits = text(value).replace(/\D+/g, "");
    if (digits.startsWith("66") && digits.length === 11) digits = `0${digits.slice(2)}`;
    return PHONE_PATTERN.test(digits) ? digits : "";
}

function bangkokIsoFromParts(year, month, day, hour, minute, second = 0) {
    const yyyy = Number(year) < 100 ? 2000 + Number(year) : Number(year);
    const wall = new Date(Date.UTC(yyyy, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    if (wall.getUTCFullYear() !== yyyy || wall.getUTCMonth() !== Number(month) - 1
        || wall.getUTCDate() !== Number(day) || wall.getUTCHours() !== Number(hour)
        || wall.getUTCMinutes() !== Number(minute) || wall.getUTCSeconds() !== Number(second)) return null;
    return new Date(wall.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

// A filename suffix is only a candidate until the owner confirms FolderSync semantics and timezone.
function parseFilenameTimestampCandidate(fileName) {
    const raw = text(fileName);
    const compact = raw.match(/_(\d{6})_(\d{6})(?=\.[^.]+$)/i);
    if (compact) {
        const date = compact[1];
        const time = compact[2];
        const iso = bangkokIsoFromParts(date.slice(0, 2), date.slice(2, 4), date.slice(4, 6), time.slice(0, 2), time.slice(2, 4), time.slice(4, 6));
        return iso ? { iso, source: "filename_compact_candidate", verified: false } : null;
    }
    const split = raw.match(/_(\d{6})_(\d{2})_(\d{2})(?=\.[^.]+$)/i);
    if (split) {
        const date = split[1];
        const iso = bangkokIsoFromParts(date.slice(0, 2), date.slice(2, 4), date.slice(4, 6), split[2], split[3]);
        return iso ? { iso, source: "filename_split_candidate", verified: false } : null;
    }
    return null;
}

function parseVerifiedTimestamp(record, options = {}) {
    const supplied = text(record?.verified_recording_at);
    if (record?.recording_timestamp_verified === true && supplied) {
        const parsed = new Date(supplied);
        if (!Number.isNaN(parsed.getTime())) return { iso: parsed.toISOString(), source: text(record.recording_timestamp_source) || "verified_source" };
    }
    if (options.filenameTimestampVerified === true && options.filenameTimeZone === "Asia/Bangkok") {
        const candidate = parseFilenameTimestampCandidate(record?.file_name);
        if (candidate) return { iso: candidate.iso, source: "verified_filename" };
    }
    return null;
}

function classifyAudioIndexRecords(leads, audioRecords, options = {}) {
    const leadById = new Map();
    const idsByPhone = new Map();
    for (const lead of Array.isArray(leads) ? leads : []) {
        const id = text(lead?.lead_id);
        if (!id || leadById.has(id)) continue;
        leadById.set(id, lead);
        for (const phone of [lead?.phone, lead?.additional_phone]) {
            const key = normalizeThaiPhone(phone);
            if (!key) continue;
            if (!idsByPhone.has(key)) idsByPhone.set(key, new Set());
            idsByPhone.get(key).add(id);
        }
    }

    const stats = { matched: 0, missingPhone: 0, malformed: 0, ambiguous: 0, unmatched: 0, duplicateFiles: 0, unverifiedTimestamp: 0 };
    const summaryByLead = new Map();
    const grouped = new Map();
    for (const record of Array.isArray(audioRecords) ? audioRecords : []) {
        const fileId = text(record?.drive_file_id);
        if (!fileId || !AUDIO_EXTENSIONS.test(text(record?.file_name))) {
            stats.malformed++;
            continue;
        }
        if (!grouped.has(fileId)) grouped.set(fileId, []);
        grouped.get(fileId).push(record);
    }

    for (const [fileId, duplicates] of grouped) {
        if (duplicates.length > 1) stats.duplicateFiles += duplicates.length - 1;
        const phones = new Set(duplicates.map(item => normalizeThaiPhone(item?.detected_phone)).filter(Boolean));
        const proposedIds = new Set(duplicates.map(item => text(item?.matched_lead_id)).filter(Boolean));
        if (phones.size > 1 || proposedIds.size > 1) {
            stats.ambiguous++;
            continue;
        }
        const record = duplicates[0];
        const matchStatus = text(record?.match_status).toUpperCase();
        const phone = normalizeThaiPhone(record?.detected_phone);
        if (!phone || ["NO_PHONE_IN_FILENAME", "NO_PHONE"].includes(matchStatus)) {
            stats.missingPhone++;
            continue;
        }
        if (matchStatus === "MALFORMED_FILENAME" || matchStatus === "UNSUPPORTED_EXTENSION") {
            stats.malformed++;
            continue;
        }
        if (["AMBIGUOUS_PHONE", "AMBIGUOUS_LEAD", "AMBIGUOUS_MATCH"].includes(matchStatus)) {
            stats.ambiguous++;
            continue;
        }
        if (matchStatus === "PHONE_NOT_FOUND") {
            stats.unmatched++;
            continue;
        }

        const phoneLeadIds = idsByPhone.get(phone) || new Set();
        const recordedLeadId = text(record?.matched_lead_id);
        const leadId = recordedLeadId || (phoneLeadIds.size === 1 ? [...phoneLeadIds][0] : "");
        if (matchStatus !== "MATCHED_CANDIDATE" || phoneLeadIds.size !== 1 || !leadId || !leadById.has(leadId) || !phoneLeadIds.has(leadId)) {
            stats.ambiguous++;
            continue;
        }

        stats.matched++;
        const timestamp = parseVerifiedTimestamp(record, options);
        if (!timestamp) stats.unverifiedTimestamp++;
        if (!summaryByLead.has(leadId)) summaryByLead.set(leadId, { recording_count: 0, latest_recording_at: null, latest_recording_link: null, _latestFileId: "" });
        const summary = summaryByLead.get(leadId);
        summary.recording_count++;
        if (options.indexComplete === true) {
            if (timestamp && (!summary.latest_recording_at || timestamp.iso > summary.latest_recording_at
                || (timestamp.iso === summary.latest_recording_at && fileId < summary._latestFileId))) {
                summary.latest_recording_at = timestamp.iso;
                summary.latest_recording_link = `https://drive.google.com/file/d/${fileId}/view`;
                summary._latestFileId = fileId;
            }
        }
    }

    if (options.indexComplete !== true) {
        for (const summary of summaryByLead.values()) summary.recording_count = null;
    }
    for (const summary of summaryByLead.values()) delete summary._latestFileId;
    return { summaries: summaryByLead, stats };
}

function createAudioUpdateGate(env = process.env) {
    const scheduleEnabled = String(env.CRM4_AUDIO_AUTOMATION_ENABLED || "").toLowerCase() === "true";
    const writeEnabled = String(env.CRM4_AUDIO_SHEET_WRITE_ENABLED || "").toLowerCase() === "true";
    const timestampVerified = String(env.CRM4_AUDIO_TIMESTAMP_SOURCE_VERIFIED || "").toLowerCase() === "true";
    return Object.freeze({ enabled: scheduleEnabled && writeEnabled && timestampVerified, scheduleEnabled, writeEnabled, timestampVerified });
}

async function runAudioUpdate({ env = process.env, readInputs, buildPlan, writePlan }) {
    const gate = createAudioUpdateGate(env);
    if (!gate.enabled) return { status: "DISABLED", gate };
    if (typeof readInputs !== "function" || typeof buildPlan !== "function" || typeof writePlan !== "function") {
        throw new TypeError("Audio update dependencies are required when automation is enabled.");
    }
    const inputs = await readInputs();
    const plan = await buildPlan(inputs);
    const result = await writePlan(plan);
    return { status: "COMPLETED", gate, result };
}

module.exports = {
    AUDIO_EXTENSIONS,
    normalizeThaiPhone,
    parseFilenameTimestampCandidate,
    parseVerifiedTimestamp,
    classifyAudioIndexRecords,
    createAudioUpdateGate,
    runAudioUpdate,
};
