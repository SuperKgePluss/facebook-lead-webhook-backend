"use strict";

const { AUDIO_EXTENSIONS, matchAudioFiles } = require("./audioMatching");

const AUDIO_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_PAGES_PER_SCAN = 100;
const MAX_FILES_PER_SCAN = 10000;
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

function pageToken(response) {
    return String(response?.nextPageToken ?? "");
}

async function listFolderCompletely(drive, folderId, limits, counters, retryOptions) {
    const files = [];
    let token;
    do {
        if (counters.pages >= limits.maxPagesPerScan) throw new Error("Audio Drive listing exceeded its page bound.");
        const response = await retryRead(() => drive.listChildren({ folderId, pageToken: token, pageSize: limits.pageSize }), retryOptions);
        counters.pages++;
        if (!Array.isArray(response?.files)) throw new Error("Audio Drive listing was incomplete.");
        files.push(...response.files.map(cleanFile));
        if (files.length > limits.maxFilesPerScan) throw new Error("Audio Drive listing exceeded its file bound.");
        token = pageToken(response) || undefined;
        if (token && counters.pages >= limits.maxPagesPerScan) throw new Error("Audio Drive listing was incomplete at the page bound.");
    } while (token);
    return files;
}

async function initialCrawl(drive, rootFolderId, limits, counters, retryOptions) {
    const folders = new Set([rootFolderId]);
    const folderParents = new Map([[rootFolderId, []]]);
    const filesById = new Map();
    const queue = [rootFolderId];
    while (queue.length) {
        const folderId = queue.shift();
        const children = await listFolderCompletely(drive, folderId, limits, counters, retryOptions);
        for (const child of children) {
            if (!child.id || child.trashed) continue;
            if (child.mimeType === AUDIO_FOLDER_MIME_TYPE) {
                if (!folders.has(child.id)) {
                    folders.add(child.id);
                    folderParents.set(child.id, child.parents);
                    queue.push(child.id);
                }
            } else if (AUDIO_EXTENSIONS.test(child.name)) {
                filesById.set(child.id, child);
            }
        }
        if (filesById.size > limits.maxFilesPerScan) throw new Error("Audio Drive listing exceeded its file bound.");
    }
    return { folders, folderParents, filesById };
}

async function readChangesCompletely(drive, startPageToken, limits, counters, retryOptions) {
    const changes = [];
    let token = startPageToken;
    let newStartPageToken = "";
    while (token) {
        if (counters.pages >= limits.maxPagesPerScan) throw new Error("Audio Drive changes exceeded their page bound.");
        const response = await retryRead(() => drive.listChanges({ pageToken: token, pageSize: limits.pageSize }), retryOptions);
        counters.pages++;
        if (!Array.isArray(response?.changes)) throw new Error("Audio Drive changes listing was incomplete.");
        changes.push(...response.changes);
        token = pageToken(response);
        newStartPageToken = String(response?.newStartPageToken ?? newStartPageToken);
        if (token && counters.pages >= limits.maxPagesPerScan) throw new Error("Audio Drive changes were incomplete at the page bound.");
    }
    if (!newStartPageToken) throw new Error("Audio Drive did not return a complete changes checkpoint.");
    return { changes, newStartPageToken };
}

function removeFolderSubtree(id, folders, folderParents, filesById) {
    const removedFolders = new Set([id]);
    let foundDescendant = true;
    while (foundDescendant) {
        foundDescendant = false;
        for (const [folderId, parents] of folderParents) {
            if (!removedFolders.has(folderId) && parents.some(parentId => removedFolders.has(parentId))) {
                removedFolders.add(folderId);
                foundDescendant = true;
            }
        }
    }
    for (const folderId of removedFolders) {
        folders.delete(folderId);
        folderParents.delete(folderId);
    }
    for (const [fileId, indexed] of filesById) {
        if (indexed.parents.some(parentId => removedFolders.has(parentId))) filesById.delete(fileId);
    }
}

async function applyChanges(drive, state, changes, limits, counters, retryOptions) {
    const folders = new Set(state.folder_ids);
    const folderParents = new Map(Object.entries(state.folder_parents || {}));
    const filesById = new Map(state.drive_files.map(file => [file.id, cleanFile(file)]));
    const foldersToCrawl = [];

    for (const change of changes) {
        const id = String(change?.fileId ?? change?.file?.id ?? "").trim();
        if (!id) continue;
        const previous = filesById.get(id);
        const file = change?.file ? cleanFile(change.file) : null;
        const isInScope = (file?.parents || previous?.parents || []).some(parentId => folders.has(parentId));
        const trackedFolderMovedOut = folders.has(id) && file && !isInScope;
        if (change?.removed === true || file?.trashed === true || (previous && !isInScope) || trackedFolderMovedOut) {
            filesById.delete(id);
            if (folders.has(id)) {
                removeFolderSubtree(id, folders, folderParents, filesById);
            }
            continue;
        }
        if (!file || !isInScope) continue;
        if (file.mimeType === AUDIO_FOLDER_MIME_TYPE) {
            if (!folders.has(id)) {
                folders.add(id);
                folderParents.set(id, file.parents);
                foldersToCrawl.push(id);
            } else folderParents.set(id, file.parents);
            continue;
        }
        if (!AUDIO_EXTENSIONS.test(file.name)) {
            filesById.delete(id);
            continue;
        }
        filesById.set(id, file);
    }

    for (const folderId of foldersToCrawl) {
        const subtree = await initialCrawl(drive, folderId, limits, counters, retryOptions);
        for (const id of subtree.folders) {
            folders.add(id);
            folderParents.set(id, subtree.folderParents.get(id) || []);
        }
        for (const [id, file] of subtree.filesById) filesById.set(id, file);
    }
    if (filesById.size > limits.maxFilesPerScan) throw new Error("Audio Drive changes exceeded the file bound.");
    return { folders, folderParents, filesById };
}

async function runAudioIndexScan({ drive, readLeads, store, rootFolderId, filenamePatternVerified = false, timestampVerified = false, now = () => new Date(), limits = {}, retry = {} }) {
    if (!drive || typeof drive.listChildren !== "function" || typeof drive.listChanges !== "function"
        || typeof drive.getStartPageToken !== "function") throw new TypeError("A Drive API adapter is required.");
    if (typeof readLeads !== "function") throw new TypeError("A read-only Lead provider is required.");
    if (!store || typeof store.withLock !== "function" || typeof store.read !== "function" || typeof store.write !== "function") {
        throw new TypeError("A persistent audio index store is required.");
    }
    const folderId = String(rootFolderId ?? "").trim();
    if (!folderId) throw new TypeError("The approved Audio Drive folder ID is required.");
    if (runningStores.has(store)) throw new Error("An Audio Drive scan is already running.");

    const effectiveLimits = {
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limits.pageSize) || DEFAULT_PAGE_SIZE)),
        maxPagesPerScan: Math.max(1, Number(limits.maxPagesPerScan) || MAX_PAGES_PER_SCAN),
        maxFilesPerScan: Math.max(1, Number(limits.maxFilesPerScan) || MAX_FILES_PER_SCAN),
    };
    runningStores.add(store);
    try {
        return await store.withLock(async () => {
            const startedAt = now().toISOString();
            const previous = await store.read();
            if (previous?.root_folder_id && previous.root_folder_id !== folderId) {
                throw new Error("Audio index state belongs to a different approved folder.");
            }
            const counters = { pages: 0 };
            const retryOptions = { maxAttempts: retry.maxAttempts, baseDelayMs: retry.baseDelayMs, sleep: retry.sleep };
            let folders;
            let folderParents;
            let filesById;
            let pageTokenValue;
            if (!previous?.changes_page_token) {
                const initialToken = await retryRead(() => drive.getStartPageToken(), retryOptions);
                if (!initialToken) throw new Error("Audio Drive did not provide an initial changes checkpoint.");
                ({ folders, folderParents, filesById } = await initialCrawl(drive, folderId, effectiveLimits, counters, retryOptions));
                const delta = await readChangesCompletely(drive, initialToken, effectiveLimits, counters, retryOptions);
                ({ folders, folderParents, filesById } = await applyChanges(drive, {
                    folder_ids: [...folders],
                    folder_parents: Object.fromEntries(folderParents),
                    drive_files: [...filesById.values()],
                }, delta.changes, effectiveLimits, counters, retryOptions));
                pageTokenValue = delta.newStartPageToken;
            } else {
                const delta = await readChangesCompletely(drive, previous.changes_page_token, effectiveLimits, counters, retryOptions);
                ({ folders, folderParents, filesById } = await applyChanges(drive, previous, delta.changes, effectiveLimits, counters, retryOptions));
                pageTokenValue = delta.newStartPageToken;
            }

            const leads = await retryRead(readLeads, retryOptions);
            if (!Array.isArray(leads)) throw new Error("The read-only Lead source was incomplete.");
            const matched = matchAudioFiles([...filesById.values()], leads, { filenamePatternVerified });
            if (filenamePatternVerified === true && timestampVerified === true) {
                for (const entry of matched.entries) {
                    entry.recording_at_verified = Boolean(entry.recording_at);
                }
                matched.aggregate.timestamp_candidates_unverified = 0;
                matched.aggregate.unverified_recording_timestamps = matched.entries.filter(entry => !entry.recording_at).length;
            }
            const completedAt = now().toISOString();
            const nextState = {
                schema_version: 1,
                root_folder_id: folderId,
                changes_page_token: pageTokenValue,
                folder_ids: [...folders].sort(),
                folder_parents: Object.fromEntries([...folderParents].sort(([a], [b]) => a.localeCompare(b))),
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
        });
    } finally {
        runningStores.delete(store);
    }
}

module.exports = { isRetryableReadError, retryRead, runAudioIndexScan };
