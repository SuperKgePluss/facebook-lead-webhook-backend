"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { REQUIRED_AUDIO_ENV, startAudioIndexWorker } = require("../services/audioWorkerRuntime");

function configuredEnv(overrides = {}) {
    return {
        AUDIO_WORKER_ENABLED: "true",
        AUDIO_PERSISTENT_DIR: "/var/data",
        AUDIO_INDEX_PATH: "/var/data/audio-index.json",
        AUDIO_SCAN_INTERVAL_MINUTES: "20",
        AUDIO_GOOGLE_CLIENT_EMAIL: "service-account@example.invalid",
        AUDIO_GOOGLE_PRIVATE_KEY: "synthetic-private-key",
        AUDIO_DRIVE_FOLDER_ID: "synthetic-folder-id",
        GOOGLE_CLIENT_EMAIL: "sheets-account@example.invalid",
        GOOGLE_PRIVATE_KEY: "synthetic-sheets-key",
        GOOGLE_SHEET_ID: "synthetic-sheet-id",
        ...overrides,
    };
}

test("Web runtime leaves the recurring Audio worker disabled by default", () => {
    let started = false;
    const result = startAudioIndexWorker({}, { runScheduledAudioIndex() { started = true; } });
    assert.deepEqual(result, { enabled: false, stop: result.stop });
    assert.equal(started, false);
});

test("enabled worker requires credentials and index state under the persistent mount", () => {
    const missingCredential = configuredEnv({ AUDIO_GOOGLE_PRIVATE_KEY: "" });
    assert.throws(() => startAudioIndexWorker(missingCredential, { runScheduledAudioIndex() {} }), /AUDIO_GOOGLE_PRIVATE_KEY/);

    const ephemeralIndex = configuredEnv({ AUDIO_INDEX_PATH: "/tmp/audio-index.json" });
    assert.throws(() => startAudioIndexWorker(ephemeralIndex, { runScheduledAudioIndex() {} }), /inside AUDIO_PERSISTENT_DIR/);
});

test("worker runtime configures one serial scan at the requested interval and supports shutdown", async () => {
    let scheduleOptions;
    const env = configuredEnv();
    const handle = startAudioIndexWorker(env, {
        runScan: async () => ({ aggregate: { unique_matched_files: 2 } }),
        runScheduledAudioIndex(options) {
            scheduleOptions = options;
            return Promise.resolve();
        },
    });
    assert.equal(handle.enabled, true);
    assert.equal(scheduleOptions.intervalMinutes, 20);
    assert.equal(scheduleOptions.shouldStop(), false);
    handle.stop();
    assert.equal(scheduleOptions.shouldStop(), true);
    await handle.done;
});

test("configuration check covers the dedicated Drive and read-only CRM identities", () => {
    assert.deepEqual(REQUIRED_AUDIO_ENV, [
        "AUDIO_GOOGLE_CLIENT_EMAIL",
        "AUDIO_GOOGLE_PRIVATE_KEY",
        "AUDIO_DRIVE_FOLDER_ID",
        "GOOGLE_CLIENT_EMAIL",
        "GOOGLE_PRIVATE_KEY",
        "GOOGLE_SHEET_ID",
    ]);
});
