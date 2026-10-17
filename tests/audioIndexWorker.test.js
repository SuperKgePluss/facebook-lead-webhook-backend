"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInMemoryAudioIndexStore, readAudioIndexSnapshot } = require("../services/audioIndexStore");
const { runAudioIndexScan } = require("../services/audioIndexWorker");

const leads = [{ lead_id: "SYN-001", phone: "0812345678" }];
const audioFile = (id, second = "123456") => ({
    id,
    name: `บันทึก_0812345678_261017_${second}.m4a`,
    mimeType: "audio/mp4",
    parents: ["folder-child"],
});

function fixtureDrive(files = [audioFile("audio-1")]) {
    const children = {
        root: [{ id: "folder-child", name: "Subfolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] }],
        "folder-child": files,
    };
    const calls = [];
    return {
        calls,
        async listChildren(input) {
            calls.push(input);
            return { files: children[input.folderId] || [] };
        },
    };
}

test("full snapshot covers nested folders, deduplicates stable IDs, and accounts for bounded API pages", async () => {
    const duplicate = audioFile("audio-1");
    const drive = fixtureDrive([audioFile("audio-1"), duplicate]);
    const store = createInMemoryAudioIndexStore();
    const result = await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    assert.equal(result.aggregate.drive_file_count, 1);
    assert.equal(result.aggregate.folder_count, 2);
    assert.equal(result.aggregate.pages_read, 2);
    assert.deepEqual(drive.calls.map(call => call.pageSize), [1000, 1000]);
    assert.equal((await store.read()).entries.length, 1);
    assert.equal((await store.read()).entries[0].recording_at_verified, false);
});

test("237 candidates fit one Drive metadata page with no content or changes-feed requests", async () => {
    const files = Array.from({ length: 237 }, (_, index) => ({
        ...audioFile(`audio-${index}`),
        parents: ["root"],
    }));
    const calls = [];
    const drive = { async listChildren(input) { calls.push(input); return { files }; } };
    const store = createInMemoryAudioIndexStore();
    const result = await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    assert.equal(result.aggregate.drive_file_count, 237);
    assert.equal(result.aggregate.pages_read, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pageSize, 1000);
});

test("repeated full scans replace removed files and rebuild after a process restart", async () => {
    const store = createInMemoryAudioIndexStore();
    const initialDrive = fixtureDrive([audioFile("audio-1"), audioFile("audio-2", "123457")]);
    const first = await runAudioIndexScan({ drive: initialDrive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    assert.equal(first.aggregate.unique_matched_files, 2);

    const restartedStore = createInMemoryAudioIndexStore();
    assert.equal((await readAudioIndexSnapshot({ store: restartedStore, filenamePatternVerified: true })).available, false);
    const rebuilt = await runAudioIndexScan({ drive: fixtureDrive([audioFile("audio-2", "123457")]), readLeads: async () => leads, store: restartedStore, rootFolderId: "root", filenamePatternVerified: true });
    assert.equal(rebuilt.aggregate.unique_matched_files, 1);
    assert.equal((await restartedStore.read()).drive_files.length, 1);
    assert.equal((await restartedStore.read()).drive_files[0].id, "audio-2");
});

test("incomplete Drive pagination fails closed and does not publish a partial or zero snapshot", async () => {
    const store = createInMemoryAudioIndexStore();
    const drive = { async listChildren() { return { files: [], nextPageToken: "next" }; } };
    await assert.rejects(runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", limits: { maxPagesPerScan: 1 } }), /incomplete at the page bound/);
    const snapshot = await readAudioIndexSnapshot({ store, filenamePatternVerified: true });
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.warning, "dashboard_audio_index_scan_incomplete");
    assert.equal(snapshot.aggregate, undefined);
});

test("a provider failure invalidates the published snapshot instead of serving stale counts", async () => {
    const store = createInMemoryAudioIndexStore();
    await runAudioIndexScan({ drive: fixtureDrive(), readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    await assert.rejects(runAudioIndexScan({ drive: { async listChildren() { throw new Error("synthetic read failure"); } }, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true }), /synthetic read failure/);
    const snapshot = await readAudioIndexSnapshot({ store, filenamePatternVerified: true });
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.aggregate, undefined);
});

test("overlapping scans using one process store fail before issuing a second Drive request", async () => {
    let entered;
    let release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const releasePromise = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const drive = { async listChildren() { calls++; entered(); await releasePromise; return { files: [] }; } };
    const store = createInMemoryAudioIndexStore();
    const first = runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root" });
    await enteredPromise;
    await assert.rejects(runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root" }), /already running/);
    release();
    await first;
    assert.equal(calls, 1);
});

test("recording timestamp stays unverified unless both explicit gates are true", async () => {
    const store = createInMemoryAudioIndexStore();
    const result = await runAudioIndexScan({ drive: fixtureDrive(), readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    assert.equal(result.aggregate.candidate_unique_matches, 1);
    assert.equal(result.aggregate.unique_matched_files, 1);
    assert.equal(result.aggregate.timestamp_candidates_unverified, 1);
    assert.equal((await store.read()).entries[0].recording_at_verified, false);
});

test("transient Drive errors retry with bounded backoff", async () => {
    const drive = fixtureDrive();
    let attempts = 0;
    const original = drive.listChildren;
    drive.listChildren = async input => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("synthetic network reset"), { code: "ECONNRESET" });
        return original(input);
    };
    const delays = [];
    const store = createInMemoryAudioIndexStore();
    await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", retry: { maxAttempts: 3, baseDelayMs: 7, sleep: async milliseconds => delays.push(milliseconds) } });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [7]);
});
