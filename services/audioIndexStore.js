"use strict";

function clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
}

function createInMemoryAudioIndexStore() {
    let state = null;
    let lockHeld = false;
    let unavailableWarning = "dashboard_audio_index_not_ready";

    async function withLock(operation) {
        if (lockHeld) throw new Error("Audio index scan is already running.");
        lockHeld = true;
        try {
            return await operation();
        } finally {
            lockHeld = false;
        }
    }

    async function read() {
        return clone(state);
    }

    async function write(nextState) {
        if (!nextState || nextState.schema_version !== 2 || !Array.isArray(nextState.entries)
            || !Array.isArray(nextState.drive_files) || !Array.isArray(nextState.folder_ids)
            || !nextState.aggregate || typeof nextState.aggregate !== "object") {
            throw new Error("Audio index snapshot is incomplete.");
        }
        state = clone(nextState);
        unavailableWarning = "dashboard_audio_index_not_ready";
    }

    async function markUnavailable(warning = "dashboard_audio_index_unavailable") {
        state = null;
        unavailableWarning = warning;
    }

    async function readSnapshot({ filenamePatternVerified = false, timestampVerified = false, linksAuthorized = false } = {}) {
        if (filenamePatternVerified !== true) {
            return { available: false, entries: [], warning: "dashboard_audio_filename_pattern_unverified" };
        }
        if (!state) return { available: false, entries: [], warning: unavailableWarning };

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
    }

    return { withLock, read, write, markUnavailable, readSnapshot };
}

const defaultAudioIndexStore = createInMemoryAudioIndexStore();

async function readAudioIndexSnapshot({ store = defaultAudioIndexStore, filenamePatternVerified = false, timestampVerified = false, linksAuthorized = false } = {}) {
    if (!store || typeof store.readSnapshot !== "function") {
        return { available: false, entries: [], warning: "dashboard_audio_index_not_configured" };
    }
    return store.readSnapshot({ filenamePatternVerified, timestampVerified, linksAuthorized });
}

module.exports = { createInMemoryAudioIndexStore, defaultAudioIndexStore, readAudioIndexSnapshot };
