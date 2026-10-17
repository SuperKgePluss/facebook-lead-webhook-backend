"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInMemoryAudioIndexStore, readAudioIndexSnapshot } = require("../services/audioIndexStore");

function state() {
    return {
        schema_version: 2,
        root_folder_id: "synthetic-root",
        folder_ids: ["synthetic-root"],
        drive_files: [],
        entries: [{ file_id: "FILE_AUDIO_0001", lead_id: "SYN-001", recording_at: "2026-10-17T05:00:00.000Z", recording_at_verified: true }],
        aggregate: { unique_matched_files: 1 },
        last_successful_scan_at: "2026-10-17T05:01:00.000Z",
    };
}

test("memory snapshot is isolated from caller mutation and respects filename, time, and link gates", async () => {
    const store = createInMemoryAudioIndexStore();
    await store.withLock(() => store.write(state()));
    const copy = await store.read();
    copy.entries[0].lead_id = "MUTATED";
    assert.equal((await store.read()).entries[0].lead_id, "SYN-001");

    const gated = await readAudioIndexSnapshot({ store, filenamePatternVerified: false, timestampVerified: true, linksAuthorized: true });
    assert.equal(gated.available, false);
    assert.equal(gated.entries.length, 0);
    assert.equal(gated.warning, "dashboard_audio_filename_pattern_unverified");

    const enabled = await readAudioIndexSnapshot({ store, filenamePatternVerified: true, timestampVerified: false, linksAuthorized: false });
    assert.equal(enabled.available, true);
    assert.deepEqual(enabled.entries, [{ file_id: "FILE_AUDIO_0001", lead_id: "SYN-001", recording_at: "", recording_at_verified: false }]);
    assert.equal(enabled.links_authorized, false);
});

test("new process store starts unavailable and exposes no false zero", async () => {
    const priorProcess = createInMemoryAudioIndexStore();
    await priorProcess.write(state());
    const restartedProcess = createInMemoryAudioIndexStore();
    const snapshot = await readAudioIndexSnapshot({ store: restartedProcess, filenamePatternVerified: true });
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.warning, "dashboard_audio_index_not_ready");
    assert.equal(snapshot.aggregate, undefined);
    assert.deepEqual(snapshot.entries, []);
});

test("incomplete scans explicitly invalidate the last published snapshot", async () => {
    const store = createInMemoryAudioIndexStore();
    await store.write(state());
    await store.markUnavailable("dashboard_audio_index_scan_incomplete");
    const snapshot = await store.readSnapshot({ filenamePatternVerified: true });
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.warning, "dashboard_audio_index_scan_incomplete");
    assert.equal(snapshot.aggregate, undefined);
});

test("memory store rejects malformed snapshot shapes", async () => {
    const store = createInMemoryAudioIndexStore();
    await assert.rejects(store.write({ schema_version: 2, entries: [], drive_files: [] }), /incomplete/);
});
