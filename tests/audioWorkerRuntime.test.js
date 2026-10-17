"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { REQUIRED_AUDIO_ENV, startAudioIndexWorker } = require("../services/audioWorkerRuntime");

function configuredEnv(overrides = {}) {
    return {
        AUDIO_WORKER_ENABLED: "true",
        AUDIO_SCAN_INTERVAL_MINUTES: "30",
        AUDIO_GOOGLE_CLIENT_EMAIL: "service-account@example.invalid",
        AUDIO_GOOGLE_PRIVATE_KEY: "synthetic-private-key",
        AUDIO_DRIVE_FOLDER_ID: "synthetic-folder-id",
        CRM4_GOOGLE_CLIENT_EMAIL: "sheets-account@example.invalid",
        CRM4_GOOGLE_PRIVATE_KEY: "synthetic-sheets-key",
        CRM4_SPREADSHEET_ID: "synthetic-sheet-id",
        ...overrides,
    };
}

test("Web runtime leaves the recurring Audio worker disabled by default", () => {
    let started = false;
    const result = startAudioIndexWorker({}, { runScheduledAudioIndex() { started = true; } });
    assert.deepEqual(result, { enabled: false, stop: result.stop });
    assert.equal(started, false);
});

test("enabled worker requires its authorized service credentials without any filesystem path", () => {
    const missingCredential = configuredEnv({ AUDIO_GOOGLE_PRIVATE_KEY: "" });
    assert.throws(() => startAudioIndexWorker(missingCredential, { runScheduledAudioIndex() {} }), /AUDIO_GOOGLE_PRIVATE_KEY/);

    const handle = startAudioIndexWorker(configuredEnv(), { runScheduledAudioIndex() {} });
    assert.equal(handle.enabled, true);
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
    assert.equal(scheduleOptions.intervalMinutes, 30);
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
        "CRM4_GOOGLE_CLIENT_EMAIL",
        "CRM4_GOOGLE_PRIVATE_KEY",
        "CRM4_SPREADSHEET_ID",
    ]);
});
