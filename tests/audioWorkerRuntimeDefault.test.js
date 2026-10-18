"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("default scheduled worker runs the real one-shot scanner and publishes its in-memory snapshot", async () => {
    const modulePaths = [
        require.resolve("../services/googleSheets"),
        require.resolve("../services/googleDriveMetadata"),
        require.resolve("../services/audioIndexStore"),
        require.resolve("../scripts/audio-index-once"),
        require.resolve("../services/audioWorkerRuntime"),
    ];
    const originalModules = new Map(modulePaths.map(filename => [filename, require.cache[filename]]));
    const { createInMemoryAudioIndexStore, readAudioIndexSnapshot } = require("../services/audioIndexStore");
    const store = createInMemoryAudioIndexStore();

    function installModule(filename, exports) {
        require.cache[filename] = { id: filename, filename, loaded: true, exports };
    }

    for (const filename of [modulePaths[2], modulePaths[3], modulePaths[4]]) delete require.cache[filename];
    installModule(modulePaths[0], {
        async getAudioLeadIdentityRows() {
            return [{ lead_id: "synthetic-lead-1", phones: ["0812345678"] }];
        },
    });
    installModule(modulePaths[1], {
        createGoogleDriveMetadataAdapter() {
            return {
                async listChildren() {
                    return {
                        files: [{
                            id: "synthetic-drive-file-1",
                            name: "Call_0812345678_261018_120000.m4a",
                            mimeType: "audio/mp4",
                            parents: ["synthetic-folder"],
                        }],
                    };
                },
            };
        },
    });
    installModule(modulePaths[2], { defaultAudioIndexStore: store });

    try {
        const { startAudioIndexWorker } = require("../services/audioWorkerRuntime");
        let scanResult;
        const env = {
            AUDIO_WORKER_ENABLED: "true",
            AUDIO_SCAN_INTERVAL_MINUTES: "30",
            AUDIO_GOOGLE_CLIENT_EMAIL: "synthetic-audio@example.invalid",
            AUDIO_GOOGLE_PRIVATE_KEY: "synthetic-key",
            AUDIO_DRIVE_FOLDER_ID: "synthetic-folder",
            AUDIO_FILENAME_PATTERN_CONFIRMED: "true",
            AUDIO_RECORDING_TIMESTAMP_CONFIRMED: "true",
            CRM4_GOOGLE_CLIENT_EMAIL: "synthetic-sheets@example.invalid",
            CRM4_GOOGLE_PRIVATE_KEY: "synthetic-sheet-key",
            CRM4_SPREADSHEET_ID: "synthetic-sheet",
        };
        const handle = startAudioIndexWorker(env, {
            async runScheduledAudioIndex({ runScan, onResult, onError }) {
                try {
                    scanResult = await runScan();
                    onResult(scanResult);
                } catch (error) {
                    onError(error);
                    throw error;
                }
            },
        });
        await handle.done;

        assert.equal(handle.enabled, true);
        assert.equal(scanResult.aggregate.unique_matched_files, 1);
        const snapshot = await readAudioIndexSnapshot({
            store,
            filenamePatternVerified: true,
            timestampVerified: true,
            linksAuthorized: true,
        });
        assert.equal(snapshot.available, true);
        assert.equal(snapshot.entries.length, 1);
        assert.equal(snapshot.entries[0].lead_id, "synthetic-lead-1");
        assert.equal(snapshot.entries[0].file_id, "synthetic-drive-file-1");
        assert.equal(snapshot.entries[0].recording_at_verified, true);
    } finally {
        for (const filename of modulePaths) {
            const original = originalModules.get(filename);
            if (original) require.cache[filename] = original;
            else delete require.cache[filename];
        }
    }
});
