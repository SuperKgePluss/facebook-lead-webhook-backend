"use strict";

const { main: runAudioIndexOnce } = require("./audio-index-once");

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 30;

function parseIntervalMinutes(value) {
    if (value === undefined || value === "") return DEFAULT_INTERVAL_MINUTES;
    if (!/^(?:[1-9]\d*)$/.test(String(value))) throw new TypeError("AUDIO_SCAN_INTERVAL_MINUTES must be an integer from 15 to 30.");
    const minutes = Number(value);
    if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        throw new TypeError("AUDIO_SCAN_INTERVAL_MINUTES must be an integer from 15 to 30.");
    }
    return minutes;
}

function sleepUntilNextScan(milliseconds, shouldStop) {
    return new Promise(resolve => {
        const endAt = Date.now() + milliseconds;
        const check = () => {
            if (shouldStop() || Date.now() >= endAt) return resolve();
            setTimeout(check, Math.min(1000, endAt - Date.now()));
        };
        check();
    });
}

async function runScheduledAudioIndex({ runScan, intervalMinutes = DEFAULT_INTERVAL_MINUTES, shouldStop = () => false, sleep, onResult = () => {}, onError = () => {} }) {
    if (typeof runScan !== "function") throw new TypeError("A scheduled audio scan callback is required.");
    parseIntervalMinutes(String(intervalMinutes));
    while (!shouldStop()) {
        try {
            onResult(await runScan());
        } catch {
            onError();
        }
        if (shouldStop()) break;
        await (sleep || (milliseconds => sleepUntilNextScan(milliseconds, shouldStop)))(intervalMinutes * 60 * 1000);
    }
}

if (require.main === module) {
    let stopping = false;
    process.once("SIGTERM", () => { stopping = true; });
    process.once("SIGINT", () => { stopping = true; });
    let intervalMinutes;
    try {
        intervalMinutes = parseIntervalMinutes(process.env.AUDIO_SCAN_INTERVAL_MINUTES);
    } catch {
        process.stderr.write("Audio worker interval configuration is invalid. Choose an integer from 15 to 30 minutes.\n");
        process.exitCode = 1;
    }
    if (intervalMinutes) {
        runScheduledAudioIndex({
            runScan: () => runAudioIndexOnce(),
            intervalMinutes,
            shouldStop: () => stopping,
            onResult: result => process.stdout.write(`${JSON.stringify(result)}\n`),
            onError: () => process.stderr.write("Audio index scan failed; the in-memory snapshot is unavailable until a complete scan succeeds.\n"),
        }).catch(() => {
            process.stderr.write("Audio worker stopped unexpectedly.\n");
            process.exitCode = 1;
        });
    }
}

module.exports = { DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, parseIntervalMinutes, runScheduledAudioIndex };
