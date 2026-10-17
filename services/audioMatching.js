"use strict";

const AUDIO_EXTENSIONS = /\.(?:m4a|mp3|wav|ogg|mp4|aac)$/i;

function text(value) {
    return String(value ?? "").trim();
}

function normalizeThaiPhone(value) {
    const raw = text(value);
    if (!raw || !/^[+\d\s().-]+$/.test(raw)) return null;
    let digits = raw.replace(/\D/g, "");
    if (digits.startsWith("0066") && digits.length === 13) digits = digits.slice(2);
    if (digits.startsWith("66") && digits.length === 11) digits = `0${digits.slice(2)}`;
    if (digits.length === 9 && /^[6-9]/.test(digits)) digits = `0${digits}`;
    return /^0\d{9}$/.test(digits) ? digits : null;
}

function parseBangkokRecordingTime(dateToken, timeToken) {
    let year;
    let month;
    let day;
    if (/^\d{8}$/.test(dateToken)) {
        year = Number(dateToken.slice(0, 4));
        month = Number(dateToken.slice(4, 6));
        day = Number(dateToken.slice(6, 8));
        if (year >= 2400 && year <= 2700) year -= 543;
    } else if (/^\d{6}$/.test(dateToken)) {
        year = 2000 + Number(dateToken.slice(0, 2));
        month = Number(dateToken.slice(2, 4));
        day = Number(dateToken.slice(4, 6));
    } else {
        return null;
    }

    if (!/^\d{6}$/.test(timeToken)) return null;
    const hour = Number(timeToken.slice(0, 2));
    const minute = Number(timeToken.slice(2, 4));
    const second = Number(timeToken.slice(4, 6));
    const wallTime = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (wallTime.getUTCFullYear() !== year || wallTime.getUTCMonth() !== month - 1
        || wallTime.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
    return new Date(wallTime.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

function parseAudioFilename(name) {
    const filename = text(name);
    if (!AUDIO_EXTENSIONS.test(filename)) return null;
    const stem = filename.replace(/\.[^.]+$/, "");
    const match = /^(?<prefix>.+?)[_ -](?<phone>\+?(?:66)?[\d][\d\s().-]{7,17}?)[_ -](?<date>\d{6}|\d{8})[_ -](?<time>\d{6})$/.exec(stem);
    if (!match?.groups) return null;
    const phone = normalizeThaiPhone(match.groups.phone);
    if (!phone) return null;
    return {
        phone,
        timestampCandidate: parseBangkokRecordingTime(match.groups.date, match.groups.time),
        timestampVerified: false,
    };
}

function buildLeadPhoneIndex(leads) {
    const byPhone = new Map();
    for (const lead of Array.isArray(leads) ? leads : []) {
        const leadId = text(lead?.lead_id ?? lead?.leadId);
        if (!leadId) continue;
        const phones = new Set([lead?.phone, lead?.additional_phone, lead?.additionalPhone]
            .map(normalizeThaiPhone).filter(Boolean));
        for (const phone of phones) {
            const owners = byPhone.get(phone) || new Set();
            owners.add(leadId);
            byPhone.set(phone, owners);
        }
    }
    return byPhone;
}

function matchAudioFiles(files, leads, { filenamePatternVerified = false } = {}) {
    const phoneIndex = buildLeadPhoneIndex(leads);
    const byFileId = new Map();
    const filesByChecksum = new Map();
    let duplicateFileIdentityCount = 0;
    let invalidPhoneCount = 0;
    let phoneAbsentFromLeadsCount = 0;
    let ambiguousPhoneCount = 0;

    for (const file of Array.isArray(files) ? files : []) {
        const fileId = text(file?.id ?? file?.fileId);
        if (!fileId) continue;
        if (byFileId.has(fileId)) {
            duplicateFileIdentityCount++;
            const existing = byFileId.get(fileId);
            const repeated = parseAudioFilename(file?.name);
            if (repeated?.phone !== existing.phone) existing.unsafe = true;
            continue;
        }
        const parsed = parseAudioFilename(file?.name);
        const item = { fileId, file, phone: parsed?.phone ?? null, timestampCandidate: parsed?.timestampCandidate ?? null };
        byFileId.set(fileId, item);
        const checksum = text(file?.md5Checksum).toLowerCase();
        if (checksum && /^[a-f0-9]{32}$/.test(checksum) && AUDIO_EXTENSIONS.test(text(file?.name))) {
            const identities = filesByChecksum.get(checksum) || new Set();
            identities.add(fileId);
            filesByChecksum.set(checksum, identities);
        }
        if (!parsed) {
            invalidPhoneCount++;
            continue;
        }
        const owners = phoneIndex.get(parsed.phone);
        if (!owners?.size) {
            phoneAbsentFromLeadsCount++;
            continue;
        }
        if (owners.size !== 1) {
            ambiguousPhoneCount++;
            continue;
        }
        item.leadId = [...owners][0];
    }

    const fileOwners = new Map();
    for (const item of byFileId.values()) {
        if (!item.unsafe && item.leadId) {
            const owners = fileOwners.get(item.fileId) || new Set();
            owners.add(item.leadId);
            fileOwners.set(item.fileId, owners);
        }
    }
    const candidateEntries = [...byFileId.values()]
        .filter(item => !item.unsafe && item.leadId && fileOwners.get(item.fileId)?.size === 1)
        .map(item => ({
            file_id: item.fileId,
            lead_id: item.leadId,
            recording_at: item.timestampCandidate,
            recording_at_verified: false,
        }));
    const entries = filenamePatternVerified === true ? candidateEntries : [];

    return {
        entries,
        aggregate: {
            unique_matched_files: entries.length,
            candidate_unique_matches: candidateEntries.length,
            unverified_filename_pattern_files: filenamePatternVerified === true ? 0 : candidateEntries.length,
            ambiguous_phone_files: ambiguousPhoneCount,
            duplicate_file_id_rows: duplicateFileIdentityCount,
            duplicate_content_file_ids: [...filesByChecksum.values()].reduce((count, identities) => count + Math.max(0, identities.size - 1), 0),
            invalid_or_missing_phone_files: invalidPhoneCount,
            phones_absent_from_leads: phoneAbsentFromLeadsCount,
            timestamp_candidates_unverified: candidateEntries.filter(entry => Boolean(entry.recording_at)).length,
            unverified_recording_timestamps: candidateEntries.filter(entry => !entry.recording_at || entry.recording_at_verified !== true).length,
        },
    };
}

function summarizeAudioForLeads(entries, { timestampVerified = false, linksAuthorized = false } = {}) {
    const byLead = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const leadId = text(entry?.lead_id);
        const fileId = text(entry?.file_id);
        if (!leadId || !fileId) continue;
        const current = byLead.get(leadId) || new Map();
        if (!current.has(fileId)) current.set(fileId, entry);
        byLead.set(leadId, current);
    }
    return Object.fromEntries([...byLead].map(([leadId, files]) => {
        const ordered = [...files.values()]
            .filter(entry => timestampVerified && entry.recording_at_verified === true && Number.isFinite(Date.parse(entry.recording_at)))
            .sort((a, b) => Date.parse(b.recording_at) - Date.parse(a.recording_at));
        const latest = ordered[0] || null;
        return [leadId, {
            count: files.size,
            latest_recording_at: latest?.recording_at ?? null,
            latest_recording_url: linksAuthorized && latest?.file_id
                ? `https://drive.google.com/file/d/${encodeURIComponent(latest.file_id)}/view`
                : null,
        }];
    }));
}

module.exports = {
    AUDIO_EXTENSIONS,
    normalizeThaiPhone,
    parseBangkokRecordingTime,
    parseAudioFilename,
    buildLeadPhoneIndex,
    matchAudioFiles,
    summarizeAudioForLeads,
};
