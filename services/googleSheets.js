const { google } = require("googleapis");

async function appendLeadToSheet(lead) {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            },
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });

        const sheets = google.sheets({ version: "v4", auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        const readResult = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: "LEADS_MAIN!B:B",
        });

        const rows = readResult.data.values || [];
        const nextRow = rows.length + 1;

        const values = [[
            lead.phone || "",
            lead.name || "",
            "Facebook",
            "New",
            "",
            "",
            "",
            "",
            "",
        ]];

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `LEADS_MAIN!B${nextRow}:J${nextRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
        });

        console.log(`✅ Lead written to Google Sheet row ${nextRow}`);
    } catch (err) {
        console.error("❌ Google Sheet error:", err.message);
    }
}

module.exports = {
    appendLeadToSheet,
};