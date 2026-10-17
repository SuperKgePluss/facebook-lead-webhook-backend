"use strict";

const { AUDIO_EXTENSIONS, matchAudioFiles } = require("./audioMatching");

const AUDIO_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGES_PER_SCAN = 100;
const MAX_FILES_PER_SCAN = 10000;
const MAX_ITEMS_PER_SCAN = 10000;
const MAX_READ_ATTEMPTS = 3;
const runningStores = new WeakSet();

function isRetryableReadError(error) {
    const status = Number(error?.response?.status ?? error?.status);
    if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
    if (status === 403) {
        const reasons = error?.response?.data?.error?.errors;
        return Array.isArray(reasons) && reasons.some(item => ["rateLimitExceeded", "userRateLimitExceeded"].includes(item?.reason));
    }
    return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(String(error?.code ?? ""));
}

async function retryRead(operation, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || MAX_READ_ATTEMPTS);
    const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 100);
    const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= maxAttempts || !isRetryableReadError(error)) throw error;
            await sleep(Math.min(1000, baseDelayMs * (2 ** (attempt - 1))));
        }
    }
}

function cleanFile(file) {
    return {
        id: String(file?.id ?? "").trim(),
        name: String(file?.name ?? ""),
        mimeType: String(file?.mimeType ?? ""),
        modifiedTime: String(file?.modifiedTime ?? ""),
        md5Checksum: String(file?.md5Checksum ?? ""),
        parents: Array.isArray(file?.parents) ? file.parents.map(String) : [],
        trashed: file?.trashed === true,
    };
}

async function listFolderCompletely(drive, folderId, limits, counters, retryOptions) {
    const files = [];
    let token;
    do {
        if (counters.pages >= limits.maxPagesPerScan) throw new Error("Audio Drive listing exceeded its page bound.");
        const response = await retryRead(() => drive.listChildren({ folderId, pageToken: token, pageSize: limits.pageSize }), retryOptions);
        counters.pages++;
        if (!Array.isArray(response?.files)) throw new Error("Audio Drive listing was incomplete.");
        counters.items += response.files.length;
        if (counters.items > limits.maxItemsPerScan) throw new Error("Audio Drive listing exceeded its item bound.");
        files.push(...response.files.map(cleanFile));
        if (files.length > limits.maxFilesPerScan) throw new Error("Audio Drive listing exceeded its file bound.");
        token = String(response?.nextPageToken ?? "") || undefined;
        if (token && counters.pages >= limits.maxPagesPerScan) throw new Error("Audio Drive listing was incomplete at the page bound.");
    } while (token);
    return files;
}

async function fullCrawl(drive, rootFolderId, limits, counters, retryOptions) {
    const folders = new Set([rootFolderId]);
    const queue = [rootFolderId];
    const filesById = new Map();
    while (queue.length) {
        const folderId = queue.shift();
        const children = await listFolderCompletely(drive, folderId, limits, counters, retryOptions);
        for (const child of children) {
            if (!child.id) throw new Error("Audio Drive listing returned an item without a stable file ID.");
            if (child.trashed) continue;
            if (child.mimeType === AUDIO_FOLDER_MIME_TYPE) {
                if (!folders.has(child.id)) {
                    folders.add(child.id);
                    queue.push(child.id);
                }
            } else if (AUDIO_EXTENSIONS.test(child.name)) {
                const previous = filesById.get(child.id);
                if (previous && JSON.stringify(previous) !== JSON.stringify(child)) {
                    throw new Error("Audio Drive returned conflicting metadata for a stable file ID.");
                }
                filesById.set(child.id, child);
            }
        }
        if (filesById.size > limits.maxFilesPerScan) throw new Error("Audio Drive listing exceeded its file bound.");
    }
    return { folders, filesById };
}

async function runAudioIndexScan({ drive, readLeads, store, rootFolderId, filenamePatternVerified = false, timestampVerified = false, now = () => new Date(), limits = {}, retry = {} }) {
    if (!drive || typeof drive.listChildren !== "function") throw new TypeError("A Drive metadata adapter is required.");
    if (typeof readLeads !== "function") throw new TypeError("A read-only Lead provider is required.");
    if (!store || typeof store.withLock !== "function" || typeof store.read !== "function"
        || typeof store.write !== "function" || typeof store.markUnavailable !== "function") {
        throw new TypeError("An in-memory audio index store is required.");
    }
    const folderId = String(rootFolderId ?? "").trim();
    if (!folderId) throw new TypeError("The approved Audio Drive folder ID is required.");
    if (runningStores.has(store)) throw new Error("An Audio Drive scan is already running.");

    const effectiveLimits = {
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limits.pageSize) || DEFAULT_PAGE_SIZE)),
        maxPagesPerScan: Math.max(1, Number(limits.maxPagesPerScan) || MAX_PAGES_PER_SCAN),
        maxFilesPerScan: Math.max(1, Number(limits.maxFilesPerScan) || MAX_FILES_PER_SCAN),
        maxItemsPerScan: Math.max(1, Number(limits.maxItemsPerScan) || MAX_ITEMS_PER_SCAN),
    };
    runningStores.add(store);
    try {
        return await store.withLock(async () => {
            const startedAt = now().toISOString();
            await store.markUnavailable("dashboard_audio_index_scan_incomplete");
            try {
                const counters = { pages: 0, items: 0 };
                const retryOptions = { maxAttempts: retry.maxAttempts, baseDelayMs: retry.baseDelayMs, sleep: retry.sleep };
                const { folders, filesById } = await fullCrawl(drive, folderId, effectiveLimits, counters, retryOptions);
                const leads = await retryRead(readLeads, retryOptions);
                if (!Array.isArray(leads)) throw new Error("The read-only Lead source was incomplete.");
                const matched = matchAudioFiles([...filesById.values()], leads, { filenamePatternVerified });
                if (filenamePatternVerified === true && timestampVerified === true) {
                    for (const entry of matched.entries) entry.recording_at_verified = Boolean(entry.recording_at);
                    matched.aggregate.timestamp_candidates_unverified = 0;
                    matched.aggregate.unverified_recording_timestamps = matched.entries.filter(entry => !entry.recording_at).length;
                }
                const completedAt = now().toISOString();
                const nextState = {
                    schema_version: 2,
                    root_folder_id: folderId,
                    folder_ids: [...folders].sort(),
                    drive_files: [...filesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
                    entries: matched.entries,
                    aggregate: matched.aggregate,
                    last_scan_started_at: startedAt,
                    last_successful_scan_at: completedAt,
                };
                await store.write(nextState);
                return {
                    aggregate: { ...matched.aggregate, drive_file_count: filesById.size, folder_count: folders.size, pages_read: counters.pages },
                    last_successful_scan_at: completedAt,
                };
            } catch (error) {
                await store.markUnavailable("dashboard_audio_index_scan_incomplete");
                throw error;
            }
        });
    } finally {
        runningStores.delete(store);
    }
}

module.exports = { isRetryableReadError, retryRead, runAudioIndexScan };
