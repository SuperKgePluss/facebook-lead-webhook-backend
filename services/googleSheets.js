const { google } = require("googleapis");

async function appendLeadToSheet(lead) {
    try {
        const auth = new google.auth.JWT(
            process.env.GOOGLE_CLIENT_EMAIL,
            null,
            process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            ["https://www.googleapis.com/auth/spreadsheets"]
        );

        const sheets = google.sheets({ version: "v4", auth });

        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        const values = [
            [
                "", // lead_id (ยังไม่ต้องใส่)
                lead.phone || "",
                lead.name || "", // map ไป customer_name
                "Facebook",
                "New",
                "", // sales_owner
                "", // latest_audio_link
                "", // last_contact_date
                "", // next_follow_up
                "", // note
                new Date().toISOString(), // created_at
                new Date().toISOString(), // updated_at
            ],
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "LEADS_MAIN!A:E",
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