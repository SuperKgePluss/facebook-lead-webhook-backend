"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    normalizeThaiPhone,
    parseAudioFilename,
    matchAudioFiles,
    summarizeAudioForLeads,
} = require("../services/audioMatching");

test("Thai phone normalization preserves leading zero and supports +66 notation", () => {
    assert.equal(normalizeThaiPhone("081-234-5678"), "0812345678");
    assert.equal(normalizeThaiPhone("+66 81 234 5678"), "0812345678");
    assert.equal(normalizeThaiPhone("0066 81 234 5678"), "0812345678");
    assert.equal(normalizeThaiPhone("812345678"), "0812345678");
    assert.equal(normalizeThaiPhone("12345"), null);
    assert.equal(normalizeThaiPhone("0812345678 ext 2"), null);
});

test("filename parser emits Bangkok candidates without claiming timestamp verification", () => {
    const parsed = parseAudioFilename("บันทึก_0812345678_261017_123456.m4a");
    assert.equal(parsed.phone, "0812345678");
    assert.equal(parsed.timestampCandidate, "2026-10-17T05:34:56.000Z");
    assert.equal(parsed.timestampVerified, false);
    assert.equal(parseAudioFilename("บันทึก_0812345678_261332_123456.m4a").timestampCandidate, null);
    assert.equal(parseAudioFilename("บันทึก_0812345678_261017_123456.txt"), null);
});

test("matching counts unique Drive IDs and rejects ambiguous or unsafe phone matches", () => {
    const leads = [
        { lead_id: "SYN-001", phone: "0812345678" },
        { lead_id: "SYN-002", phone: "0812345678" },
        { lead_id: "SYN-003", phone: "", phones: ["0899999999"] },
    ];
    const result = matchAudioFiles([
        { id: "drive-unique", name: "บันทึก_0899999999_261017_123456.m4a", webViewLink: "https://drive.google.com/file/d/drive-unique/view" },
        { id: "drive-unique", name: "บันทึก_0899999999_261017_123456.m4a" },
        { id: "drive-copy", name: "สำเนา_0899999999_261017_123457.m4a", md5Checksum: "0123456789abcdef0123456789abcdef" },
        { id: "drive-copy-2", name: "สำเนา_0899999999_261017_123458.m4a", md5Checksum: "0123456789abcdef0123456789abcdef" },
        { id: "drive-ambiguous", name: "บันทึก_0812345678_261017_123456.m4a" },
        { id: "drive-missing", name: "บันทึก_0877777777_261017_123456.m4a" },
        { id: "drive-invalid", name: "บันทึก_0877777777_261017_999999.m4a" },
        { id: "drive-collision", name: "บันทึก_0899999999_261017_123456.m4a" },
        { id: "drive-collision", name: "บันทึก_0877777777_261017_123456.m4a" },
    ], leads, { filenamePatternVerified: true });

    assert.deepEqual(result.entries.map(entry => [entry.file_id, entry.lead_id]), [["drive-unique", "SYN-003"], ["drive-copy", "SYN-003"], ["drive-copy-2", "SYN-003"]]);
    assert.equal(result.entries[0].recording_at_verified, false);
    assert.equal(result.aggregate.unique_matched_files, 3);
    assert.equal(result.aggregate.ambiguous_phone_files, 1);
    assert.equal(result.aggregate.duplicate_file_id_rows, 2);
    assert.equal(result.aggregate.duplicate_content_file_ids, 1);
    assert.equal(result.aggregate.phones_absent_from_leads, 2);
    assert.equal(result.aggregate.invalid_or_missing_phone_files, 0);
    assert.equal(result.aggregate.unverified_recording_timestamps, 3);
});

test("per-Lead summaries deduplicate files and gate timestamps and links", () => {
    const entries = [
        { file_id: "drive-a", lead_id: "SYN-001", recording_at: "2026-10-17T05:00:00.000Z", recording_at_verified: false },
        { file_id: "drive-a", lead_id: "SYN-001", recording_at: "2026-10-17T05:00:00.000Z", recording_at_verified: true },
    ];
    assert.deepEqual(summarizeAudioForLeads(entries), {
        "SYN-001": { count: 1, latest_recording_at: null, latest_recording_url: null },
    });
    const verifiedEntries = entries.map(entry => ({ ...entry, recording_at_verified: true }));
    assert.deepEqual(summarizeAudioForLeads(verifiedEntries, { timestampVerified: true, linksAuthorized: true }), {
        "SYN-001": {
            count: 1,
            latest_recording_at: "2026-10-17T05:00:00.000Z",
            latest_recording_url: "https://drive.google.com/file/d/drive-a/view",
        },
    });
    assert.equal(summarizeAudioForLeads(verifiedEntries, { timestampVerified: true })["SYN-001"].latest_recording_url, null);
});
