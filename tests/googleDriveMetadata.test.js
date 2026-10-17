"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoogleDriveMetadataAdapter, DRIVE_METADATA_SCOPE } = require("../services/googleDriveMetadata");

test("shared-drive metadata and change requests are scoped to the configured drive", async () => {
    const calls = [];
    class JWT {
        constructor(options) { this.options = options; }
    }
    const googleApi = {
        auth: { JWT },
        drive(options) {
            assert.equal(options.version, "v3");
            assert.ok(options.auth instanceof JWT);
            assert.deepEqual(options.auth.options.scopes, [DRIVE_METADATA_SCOPE]);
            return {
                changes: {
                    async getStartPageToken(input) {
                        calls.push(["getStartPageToken", input]);
                        return { data: { startPageToken: "synthetic-token" } };
                    },
                    async list(input) {
                        calls.push(["changes.list", input]);
                        return { data: { changes: [], newStartPageToken: "synthetic-next" } };
                    },
                },
                files: {
                    async list(input) {
                        calls.push(["files.list", input]);
                        return { data: { files: [] } };
                    },
                },
            };
        },
    };
    const adapter = createGoogleDriveMetadataAdapter({
        clientEmail: "synthetic@example.invalid",
        privateKey: "synthetic-private-key",
        driveId: "synthetic-shared-drive",
        googleApi,
    });

    assert.equal(await adapter.getStartPageToken(), "synthetic-token");
    await adapter.listChildren({ folderId: "synthetic-folder", pageSize: 100 });
    await adapter.listChanges({ pageToken: "synthetic-token", pageSize: 100 });

    assert.deepEqual(calls[0], ["getStartPageToken", { supportsAllDrives: true, driveId: "synthetic-shared-drive" }]);
    assert.deepEqual(calls[1][1], {
        q: "'synthetic-folder' in parents and trashed = false",
        pageSize: 100,
        corpora: "drive",
        driveId: "synthetic-shared-drive",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents,driveId,md5Checksum,trashed)",
    });
    assert.deepEqual(calls[2], ["changes.list", {
        pageToken: "synthetic-token",
        pageSize: 100,
        spaces: "drive",
        driveId: "synthetic-shared-drive",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,parents,driveId,md5Checksum,trashed))",
    }]);
});

test("My Drive change feed stays user-scoped when no shared-drive ID is configured", async () => {
    const calls = [];
    const googleApi = {
        auth: { JWT: class JWT {} },
        drive: () => ({
            changes: {
                getStartPageToken: async input => { calls.push(input); return { data: { startPageToken: "token" } }; },
                list: async input => { calls.push(input); return { data: { changes: [], newStartPageToken: "next" } }; },
            },
            files: { list: async input => { calls.push(input); return { data: { files: [] } }; } },
        }),
    };
    const adapter = createGoogleDriveMetadataAdapter({ clientEmail: "synthetic@example.invalid", privateKey: "key", googleApi });

    await adapter.getStartPageToken();
    await adapter.listChanges({ pageToken: "token", pageSize: 100 });

    assert.deepEqual(calls[0], { supportsAllDrives: true });
    assert.equal(Object.hasOwn(calls[1], "driveId"), false);
});
