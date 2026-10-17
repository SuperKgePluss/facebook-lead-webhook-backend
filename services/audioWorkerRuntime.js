"use strict";

const path = require("node:path");
const { runAudioIndexOnce } = require("../scripts/audio-index-once");
const { parseIntervalMinutes, runScheduledAudioIndex } = require("../scripts/audio-index-worker");

const REQUIRED_AUDIO_ENV = Object.freeze([
    "AUDIO_GOOGLE_CLIENT_EMAIL",
    "AUDIO_GOOGLE_PRIVATE_KEY",
    "AUDIO_DRIVE_FOLDER_ID",
    "GOOGLE_CLIENT_EMAIL",
    "GOOGLE_PRIVATE_KEY",
    "GOOGLE_SHEET_ID",
]);

function isWithinDirectory(directory, targetPath) {
    const relative = path.relative(directory, targetPath);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function startAudioIndexWorker(env = process.env, dependencies = {}) {
    if (env.AUDIO_WORKER_ENABLED !== "true") return { enabled: false, stop() {} };

    for (const name of REQUIRED_AUDIO_ENV) {
        if (!String(env[name] ?? "").trim()) throw new TypeError(`Audio worker configuration is missing ${name}.`);
    }
    const persistentDirectory = path.resolve(String(env.AUDIO_PERSISTENT_DIR ?? "").trim());
    const indexPath = path.resolve(String(env.AUDIO_INDEX_PATH ?? "").trim());
    if (!String(env.AUDIO_PERSISTENT_DIR ?? "").trim() || !String(env.AUDIO_INDEX_PATH ?? "").trim()
        || !isWithinDirectory(persistentDirectory, indexPath)) {
        throw new TypeError("AUDIO_INDEX_PATH must be inside AUDIO_PERSISTENT_DIR.");
    }

    const intervalMinutes = parseIntervalMinutes(env.AUDIO_SCAN_INTERVAL_MINUTES);
    let stopping = false;
    const schedule = dependencies.runScheduledAudioIndex || runScheduledAudioIndex;
    const runScan = dependencies.runScan || (() => runAudioIndexOnce(env));
    const onResult = dependencies.onResult || (result => process.stdout.write(`${JSON.stringify(result)}\n`));
    const onError = dependencies.onError || (() => process.stderr.write("Audio index scan failed; checkpoint was not advanced. Review logs without exposing file or Lead identifiers.\n"));
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

module.exports = { REQUIRED_AUDIO_ENV, isWithinDirectory, startAudioIndexWorker };
