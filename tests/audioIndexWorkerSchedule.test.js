"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIntervalMinutes, runScheduledAudioIndex } = require("../scripts/audio-index-worker");

test("scheduler defaults to 20 minutes and accepts only the 15–30 minute window", () => {
    assert.equal(parseIntervalMinutes(undefined), 20);
    assert.equal(parseIntervalMinutes("15"), 15);
    assert.equal(parseIntervalMinutes("30"), 30);
    for (const value of ["14", "31", "15.5", "0", "bad"]) assert.throws(() => parseIntervalMinutes(value));
});

test("scheduled scans run serially and continue after a failed scan without exposing its error", async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let failures = 0;
    const results = [];
    const delays = [];
    await runScheduledAudioIndex({
        intervalMinutes: 15,
        runScan: async () => {
            calls++;
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                if (calls === 1) throw new Error("private synthetic diagnostic");
                return { last_successful_scan_at: "synthetic-time" };
            } finally {
                active--;
            }
        },
        shouldStop: () => calls >= 2,
        sleep: async milliseconds => delays.push(milliseconds),
        onResult: result => results.push(result),
        onError: () => { failures++; },
    });
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
    assert.equal(failures, 1);
    assert.deepEqual(results, [{ last_successful_scan_at: "synthetic-time" }]);
    assert.deepEqual(delays, [15 * 60 * 1000]);
});
