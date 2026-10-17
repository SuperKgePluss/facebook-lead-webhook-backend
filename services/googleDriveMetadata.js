"use strict";

const { google } = require("googleapis");

const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,parents,md5Checksum,trashed";

function createGoogleDriveMetadataAdapter({ clientEmail, privateKey }) {
    if (!String(clientEmail ?? "").trim() || !String(privateKey ?? "").trim()) {
        throw new Error("Audio Drive service-account credentials are not configured.");
    }
    const auth = new google.auth.JWT({
        email: clientEmail,
        key: String(privateKey).replace(/\\n/g, "\n"),
        scopes: [DRIVE_METADATA_SCOPE],
    });
    const drive = google.drive({ version: "v3", auth });
    return {
        async getStartPageToken() {
            const response = await drive.changes.getStartPageToken({ supportsAllDrives: true });
            return response.data.startPageToken;
        },
        async listChildren({ folderId, pageToken, pageSize }) {
            const response = await drive.files.list({
                q: `'${String(folderId).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents and trashed = false`,
                pageSize,
                ...(pageToken ? { pageToken } : {}),
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                fields: `nextPageToken,files(${FILE_FIELDS})`,
            });
            return response.data;
        },
        async listChanges({ pageToken, pageSize }) {
            const response = await drive.changes.list({
                pageToken,
                pageSize,
                spaces: "drive",
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
            });
            return response.data;
        },
    };
}

module.exports = { DRIVE_METADATA_SCOPE, createGoogleDriveMetadataAdapter };
