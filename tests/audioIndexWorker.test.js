"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runAudioIndexScan } = require("../services/audioIndexWorker");

function memoryStore() {
    let state = null;
    return {
        writes: 0,
        async withLock(operation) { return operation(); },
        async read() { return state; },
        async write(next) { state = structuredClone(next); this.writes++; },
        state() { return state; },
    };
}

function fixtureDrive() {
    const children = {
        root: [{ id: "folder-child", name: "Subfolder", mimeType: "application/vnd.google-apps.folder", parents: ["root"] }],
        "folder-child": [{ id: "audio-1", name: "บันทึก_0812345678_261017_123456.m4a", mimeType: "audio/mp4", parents: ["folder-child"], webViewLink: "https://drive.google.com/file/d/audio-1/view" }],
    };
    let changes = [];
    return {
        async getStartPageToken() { return "token-0"; },
        async listChildren({ folderId }) { return { files: children[folderId] || [] }; },
        async listChanges() { const result = changes; changes = []; return { changes: result, newStartPageToken: "token-next" }; },
        setChanges(next) { changes = next; },
    };
}

const leads = [{ lead_id: "SYN-001", phone: "0812345678" }];

test("initial Drive crawl covers nested folders and subsequent change pages incrementally", async () => {
    const drive = fixtureDrive();
    const store = memoryStore();
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 9, 17, 5, 0, tick++));
    const initial = await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true, now });
    assert.equal(initial.aggregate.drive_file_count, 1);
    assert.equal(initial.aggregate.folder_count, 2);
    assert.equal(store.state().entries.length, 1);
    assert.equal(store.state().entries[0].recording_at_verified, false);
    assert.equal(store.writes, 1);

    drive.setChanges([{ fileId: "audio-2", file: {
        id: "audio-2", name: "บันทึก_0812345678_261017_123457.m4a", mimeType: "audio/mp4", parents: ["folder-child"],
    } }]);
    const incremental = await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true, now });
    assert.equal(incremental.aggregate.drive_file_count, 2);
    assert.equal(incremental.aggregate.unique_matched_files, 2);
    assert.equal(store.state().entries.length, 2);
    assert.equal(store.state().changes_page_token, "token-next");
    assert.equal(store.writes, 2);
});

test("incomplete bounded Drive listing does not advance or write the checkpoint", async () => {
    const store = memoryStore();
    const drive = {
        async getStartPageToken() { return "token-0"; },
        async listChildren() { return { files: [], nextPageToken: "next" }; },
        async listChanges() { return { changes: [], newStartPageToken: "token-next" }; },
    };
    await assert.rejects(runAudioIndexScan({
        drive, readLeads: async () => leads, store, rootFolderId: "root", limits: { maxPagesPerScan: 1 },
    }), /incomplete at the page bound/);
    assert.equal(store.state(), null);
    assert.equal(store.writes, 0);
});

test("deleting a nested folder removes all of its descendant audio identities", async () => {
    const drive = {
        async getStartPageToken() { return "token-0"; },
        async listChildren({ folderId }) {
            if (folderId === "root") return { files: [{ id: "folder-a", name: "A", mimeType: "application/vnd.google-apps.folder", parents: ["root"] }] };
            if (folderId === "folder-a") return { files: [{ id: "folder-b", name: "B", mimeType: "application/vnd.google-apps.folder", parents: ["folder-a"] }] };
            if (folderId === "folder-b") return { files: [{ id: "audio-1", name: "บันทึก_0812345678_261017_123456.m4a", parents: ["folder-b"] }] };
            return { files: [] };
        },
        async listChanges({ pageToken }) {
            return pageToken === "token-0"
                ? { changes: [], newStartPageToken: "token-1" }
                : { changes: [{ fileId: "folder-a", removed: true }], newStartPageToken: "token-2" };
        },
    };
    const store = memoryStore();
    await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    const removed = await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    assert.equal(removed.aggregate.folder_count, 1);
    assert.equal(removed.aggregate.drive_file_count, 0);
    assert.equal(store.state().entries.length, 0);
});

test("moving a tracked nested folder outside the approved root removes its subtree", async () => {
    const drive = fixtureDrive();
    const store = memoryStore();
    await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });
    drive.setChanges([{
        fileId: "folder-child",
        file: { id: "folder-child", name: "Subfolder", mimeType: "application/vnd.google-apps.folder", parents: ["outside"] },
    }]);

    const result = await runAudioIndexScan({ drive, readLeads: async () => leads, store, rootFolderId: "root", filenamePatternVerified: true });

    assert.equal(result.aggregate.folder_count, 1);
    assert.equal(result.aggregate.drive_file_count, 0);
    assert.deepEqual(store.state().folder_ids, ["root"]);
    assert.equal(store.state().entries.length, 0);
});

test("timestamp verification remains disabled unless explicitly supplied", async () => {
    const store = memoryStore();
    const result = await runAudioIndexScan({ drive: fixtureDrive(), readLeads: async () => leads, store, rootFolderId: "root" });
    assert.equal(result.aggregate.candidate_unique_matches, 1);
    assert.equal(result.aggregate.unique_matched_files, 0);
    assert.equal(result.aggregate.timestamp_candidates_unverified, 1);
    assert.equal(store.state().entries.length, 0);
});

test("transient Drive read errors retry with bounded backoff", async () => {
    const drive = fixtureDrive();
    let attempts = 0;
    const original = drive.listChildren;
    drive.listChildren = async input => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("synthetic network reset"), { code: "ECONNRESET" });
        return original(input);
    };
    const store = memoryStore();
    const delays = [];
    await runAudioIndexScan({
        drive, readLeads: async () => leads, store, rootFolderId: "root",
        retry: { maxAttempts: 3, baseDelayMs: 7, sleep: async milliseconds => delays.push(milliseconds) },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [7]);
    assert.equal(store.writes, 1);
});
