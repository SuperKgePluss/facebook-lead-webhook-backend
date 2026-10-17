"use strict";

const { runAudioIndexOnce } = require("../scripts/audio-index-once");
const { parseIntervalMinutes, runScheduledAudioIndex } = require("../scripts/audio-index-worker");

const REQUIRED_AUDIO_ENV = Object.freeze([
    "AUDIO_GOOGLE_CLIENT_EMAIL",
    "AUDIO_GOOGLE_PRIVATE_KEY",
    "AUDIO_DRIVE_FOLDER_ID",
    "CRM4_GOOGLE_CLIENT_EMAIL",
    "CRM4_GOOGLE_PRIVATE_KEY",
    "CRM4_SPREADSHEET_ID",
]);

function startAudioIndexWorker(env = process.env, dependencies = {}) {
    if (env.AUDIO_WORKER_ENABLED !== "true") return { enabled: false, stop() {} };

    for (const name of REQUIRED_AUDIO_ENV) {
        if (!String(env[name] ?? "").trim()) throw new TypeError(`Audio worker configuration is missing ${name}.`);
    }
    const intervalMinutes = parseIntervalMinutes(env.AUDIO_SCAN_INTERVAL_MINUTES);
    let stopping = false;
    const schedule = dependencies.runScheduledAudioIndex || runScheduledAudioIndex;
    const runScan = dependencies.runScan || (() => runAudioIndexOnce(env));
    const onResult = dependencies.onResult || (result => process.stdout.write(`${JSON.stringify(result)}\n`));
    const onError = dependencies.onError || (() => process.stderr.write("Audio index scan failed; the in-memory snapshot is unavailable until a complete scan succeeds.\n"));
    const done = schedule({
        runScan,
        intervalMinutes,
        shouldStop: () => stopping,
        onResult,
        onError,
    });

    return {
        enabled: true,
        done,
        stop() { stopping = true; },
    };
}

module.exports = { REQUIRED_AUDIO_ENV, startAudioIndexWorker };
