"use strict";

const { getSheetRows, rowToObject } = require("../services/googleSheets");
const { createGoogleDriveMetadataAdapter } = require("../services/googleDriveMetadata");
const { createJsonAudioIndexStore } = require("../services/audioIndexStore");
const { runAudioIndexScan } = require("../services/audioIndexWorker");

async function readDashboardLeads() {
    const rows = await getSheetRows("LEADS_MAIN");
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error("The read-only CRM4 Lead source was incomplete.");
    return rows.slice(2).filter(Array.isArray).map(row => rowToObject(rows[0], row)).map(lead => ({
        lead_id: String(lead.lead_id ?? ""),
        phone: String(lead.phone ?? lead.raw_phone ?? ""),
        additional_phone: String(lead.additional_phone ?? ""),
    }));
}

async function main(env = process.env) {
    const drive = createGoogleDriveMetadataAdapter({
        clientEmail: env.AUDIO_GOOGLE_CLIENT_EMAIL,
        privateKey: env.AUDIO_GOOGLE_PRIVATE_KEY,
        driveId: env.AUDIO_DRIVE_ID,
    });
    const store = createJsonAudioIndexStore(env.AUDIO_INDEX_PATH);
    return runAudioIndexScan({
        drive,
        readLeads: readDashboardLeads,
        store,
        rootFolderId: env.AUDIO_DRIVE_FOLDER_ID,
        filenamePatternVerified: env.AUDIO_FILENAME_PATTERN_CONFIRMED === "true",
        timestampVerified: env.AUDIO_RECORDING_TIMESTAMP_CONFIRMED === "true",
    });
}

if (require.main === module) {
    main().then(result => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(() => {
        process.stderr.write("Audio index scan failed; checkpoint was not advanced. Review service logs without exposing file or Lead identifiers.\n");
        process.exitCode = 1;
    });
}

module.exports = { main, readDashboardLeads };
