"use strict";

const { getAudioLeadIdentityRows } = require("../services/googleSheets");
const { createGoogleDriveMetadataAdapter } = require("../services/googleDriveMetadata");
const { defaultAudioIndexStore } = require("../services/audioIndexStore");
const { runAudioIndexScan } = require("../services/audioIndexWorker");

async function readDashboardLeads(env = process.env) {
    const leads = await getAudioLeadIdentityRows(env);
    if (!Array.isArray(leads)) throw new Error("The read-only CRM4 Lead source was incomplete.");
    return leads.map(lead => ({
        lead_id: String(lead?.lead_id ?? ""),
        phones: Array.isArray(lead?.phones) ? lead.phones.map(String) : [],
    }));
}

async function main(env = process.env, { store = defaultAudioIndexStore } = {}) {
    const drive = createGoogleDriveMetadataAdapter({
        clientEmail: env.AUDIO_GOOGLE_CLIENT_EMAIL,
        privateKey: env.AUDIO_GOOGLE_PRIVATE_KEY,
        driveId: env.AUDIO_DRIVE_ID,
    });
    return runAudioIndexScan({
        drive,
        readLeads: () => readDashboardLeads(env),
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
        process.stderr.write("Audio index scan failed; the in-memory snapshot remains unavailable until a complete scan succeeds.\n");
        process.exitCode = 1;
    });
}

module.exports = { main, readDashboardLeads };
