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

        const values = [
            [
                lead.phone || "",
                lead.name || "", // map ไป customer_name
                "Facebook",
                "New",
                "", // sales_owner
                "", // latest_audio_link
                "", // last_contact_date
                "", // next_follow_up
                "", // note
            ],
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "LEADS_MAIN!B:J",
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values,
            },
        });

        console.log("✅ Lead appended to Google Sheet");
    } catch (err) {
        console.error("❌ Google Sheet error:", err.message);
    }
}

module.exports = {
    appendLeadToSheet,
};