"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createJsonAudioIndexStore, readAudioIndexSnapshot } = require("../services/audioIndexStore");

test("audio state writes atomically, persists only derived identity, and fails closed behind its verification gate", async () => {
    const directory = await fs.mkdtemp(path.join(__dirname, ".tmp-audio-index-test-"));
    try {
        const filePath = path.join(directory, "state.json");
        const store = createJsonAudioIndexStore(filePath);
        const state = {
            schema_version: 1,
            root_folder_id: "synthetic-root",
            changes_page_token: "synthetic-token",
            folder_ids: ["synthetic-root"],
            folder_parents: { "synthetic-root": [] },
            drive_files: [],
            entries: [{ file_id: "FILE_AUDIO_0001", lead_id: "SYN-001", recording_at: "2026-10-17T05:00:00.000Z", recording_at_verified: true }],
            aggregate: { unique_matched_files: 1 },
            last_successful_scan_at: "2026-10-17T05:01:00.000Z",
        };
        await store.withLock(() => store.write(state));
        assert.deepEqual(await store.read(), state);
        const nextState = { ...state, changes_page_token: "synthetic-token-next" };
        await store.withLock(() => store.write(nextState));
        assert.deepEqual(await store.read(), nextState);
        assert.equal(await fs.access(`${filePath}.lock`).then(() => true, () => false), false);

        const gated = await readAudioIndexSnapshot({ filePath, filenamePatternVerified: false, timestampVerified: true, linksAuthorized: true });
        assert.equal(gated.available, false);
        assert.equal(gated.entries.length, 0);

        const enabled = await readAudioIndexSnapshot({ filePath, filenamePatternVerified: true, timestampVerified: false, linksAuthorized: false });
        assert.equal(enabled.available, true);
        assert.deepEqual(enabled.entries, [{ file_id: "FILE_AUDIO_0001", lead_id: "SYN-001", recording_at: "", recording_at_verified: false }]);
        assert.equal(enabled.links_authorized, false);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("audio store requires an explicit persistent path", () => {
    assert.throws(() => createJsonAudioIndexStore(""), /A persistent AUDIO_INDEX_PATH is required/);
});
