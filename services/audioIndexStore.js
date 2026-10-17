"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");

function createJsonAudioIndexStore(filePath) {
    const resolvedPath = String(filePath ?? "").trim();
    if (!resolvedPath) throw new TypeError("A persistent AUDIO_INDEX_PATH is required.");
    const lockPath = `${resolvedPath}.lock`;

    async function withLock(operation) {
        let lockHandle;
        try {
            lockHandle = await fs.open(lockPath, "wx", 0o600);
        } catch (error) {
            if (error?.code === "EEXIST") throw new Error("Audio index scan is already running or requires lock recovery.");
            throw error;
        }
        try {
            await lockHandle.writeFile(`${process.pid}\n`);
            return await operation();
        } finally {
            await lockHandle.close();
            await fs.rm(lockPath, { force: true });
        }
    }

    async function read() {
        try {
            const state = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
            if (state?.schema_version !== 1 || !Array.isArray(state.folder_ids) || !Array.isArray(state.drive_files)
                || !Array.isArray(state.entries) || !state.aggregate || typeof state.aggregate !== "object") {
                throw new Error("Audio index state has an unsupported or incomplete schema.");
            }
            return state;
        } catch (error) {
            if (error?.code === "ENOENT") return null;
            throw error;
        }
    }

    async function write(state) {
        const temporaryPath = `${resolvedPath}.${crypto.randomUUID()}.tmp`;
        const handle = await fs.open(temporaryPath, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await fs.rename(temporaryPath, resolvedPath);
        } catch (error) {
            await fs.rm(temporaryPath, { force: true });
            throw error;
        }
    }

    return { withLock, read, write };
}

async function readAudioIndexSnapshot({ filePath, filenamePatternVerified = false, timestampVerified = false, linksAuthorized = false } = {}) {
    if (!String(filePath ?? "").trim()) {
        return { available: false, entries: [], warning: "dashboard_audio_index_not_configured" };
    }
    try {
        const state = JSON.parse(await fs.readFile(String(filePath), "utf8"));
        if (state?.schema_version !== 1 || !Array.isArray(state.entries) || !state.aggregate) {
            return { available: false, entries: [], warning: "dashboard_audio_index_unavailable" };
        }
        if (filenamePatternVerified !== true) {
            return { available: false, entries: [], warning: "dashboard_audio_filename_pattern_unverified" };
        }
        const entries = state.entries.map(entry => ({
            file_id: String(entry?.file_id ?? ""),
            lead_id: String(entry?.lead_id ?? ""),
            recording_at: timestampVerified && entry?.recording_at_verified === true ? String(entry.recording_at ?? "") : "",
            recording_at_verified: timestampVerified && entry?.recording_at_verified === true,
        }));
        return {
            available: true,
            entries,
            timestamp_verified: timestampVerified === true,
            links_authorized: linksAuthorized === true,
            last_successful_scan_at: String(state.last_successful_scan_at ?? ""),
            aggregate: { ...state.aggregate },
        };
    } catch (error) {
        if (error?.code === "ENOENT") return { available: false, entries: [], warning: "dashboard_audio_index_not_ready" };
        return { available: false, entries: [], warning: "dashboard_audio_index_unavailable" };
    }
}

module.exports = { createJsonAudioIndexStore, readAudioIndexSnapshot };
