const { google } = require("googleapis");

function normalizePhone(phone) {
    return String(phone || "")
        .replace(/\D/g, "")
        .trim();
}

function generateId(prefix) {
    return `${prefix}-${Date.now()}`;
}

const SHEETS = {
    LEADS_MAIN: "LEADS_MAIN",
    LEAD_DETAILS: "LEAD_DETAILS",
    DEALS: "DEALS",
};

async function readSheet(sheets, spreadsheetId, range) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    return result.data.values || [];
}

function findLeadByPhone(rows, phone) {
    const normalizedPhone = normalizePhone(phone);

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowPhone = normalizePhone(row[1]); // Column B: phone

        if (rowPhone && rowPhone === normalizedPhone) {
            return {
                rowNumber: i + 1,
                lead_id: row[0] || "",
                phone: row[1] || "",
                customer_name: row[2] || "",
                source: row[3] || "",
                status: row[4] || "",
            };
        }
    }

    return null;
}

function getNextRow(rows) {
    return rows.length + 1;
}

function isCompletedLead(leadRow) {
    return String(leadRow?.status || "").toLowerCase() === "completed";
}

function hasRows(rows) {
    return Array.isArray(rows) && rows.length > 0;
}

function findLatestDealByLeadId(rows, leadId) {
    let latestDeal = null;

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if ((row[1] || "") === leadId) { // Column B: lead_id
            latestDeal = {
                rowNumber: i + 1,
                deal_id: row[0] || "",
                lead_id: row[1] || "",
                deal_status: row[2] || "",
            };
        }
    }

    return latestDeal;
}

function findLeadDetailByLeadId(rows, leadId) {
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if ((row[0] || "") === leadId) { // Column A: lead_id
            return {
                rowNumber: i + 1,
                lead_id: row[0] || "",
            };
        }
    }

    return null;
}

async function upsertLeadDetail(sheets, spreadsheetId, detailsRows, leadId, lead) {
    const existingDetail = findLeadDetailByLeadId(detailsRows, leadId);

    if (existingDetail) {
        await updateSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.LEAD_DETAILS}!A${existingDetail.rowNumber}:L${existingDetail.rowNumber}`,
            buildLeadDetailUpdateRow(leadId, lead)
        );

        console.log(`🔄 Updated lead detail: ${leadId}`);
        return;
    }

    const nextDetailRow = getNextRow(detailsRows);

    await updateSheet(
        sheets,
        spreadsheetId,
        `${SHEETS.LEAD_DETAILS}!A${nextDetailRow}:L${nextDetailRow}`,
        buildLeadDetailRow(leadId, lead)
    );

    console.log(`✅ Created lead detail: ${leadId}`);
}

function buildLeadMainRow(leadId, lead) {
    return [[
        leadId,
        normalizePhone(lead.phone),
        lead.name || "",
        lead.source || "Facebook",
        "New",
        "",
        "",
        "",
        "",
        lead.note || "",
        new Date().toISOString(),
        new Date().toISOString(),
    ]];
}

function buildDealRow(dealId, leadId, lead) {
    return [[
        dealId,
        leadId,
        "New",
        lead.product_name || "",
        lead.package_name || "",
        lead.price || "",
        "Unpaid",
        "",
        "Not Scheduled",
        "",
        "",
        lead.note || "",
        new Date().toISOString(),
        new Date().toISOString(),
    ]];
}

function buildExistingDealUpdateRow(existingDeal, lead) {
    return [[
        existingDeal.deal_id,
        existingDeal.lead_id,
        existingDeal.deal_status || "New",
        lead.product_name || "",
        lead.package_name || "",
        lead.price || "",
        "Unpaid",
        "",
        "Not Scheduled",
        "",
        "",
        lead.note || "",
        new Date().toISOString(),
    ]];
}

function buildLeadDetailRow(leadId, lead) {
    return [[
        leadId,
        lead.name || "",
        lead.facebook_leadgen_id || "",
        lead.facebook_form_id || "",
        lead.facebook_ad_id || "",
        lead.facebook_campaign_id || "",
        lead.facebook_created_time || "",
        lead.facebook_name || "",
        lead.line_user_id || "",
        lead.line_display_name || "",
        lead.line_created_time || "",
        lead.additional_note || "",
    ]];
}

function mergeSource(currentSource, incomingSource) {
    const current = String(currentSource || "").trim();
    const incoming = String(incomingSource || "Facebook").trim();

    if (!current) return incoming;
    if (current === incoming) return current;

    return "Multiple";
}

function buildExistingLeadUpdateRow(existingLead, lead) {
    return [[
        normalizePhone(lead.phone || existingLead.phone),
        lead.name || existingLead.customer_name || "",
        mergeSource(existingLead.source, lead.source || "Facebook"),
        existingLead.status || "New",
        "",
        "",
        "",
        "",
        lead.note || "",
        new Date().toISOString(),
    ]];
}

function buildLeadDetailUpdateRow(existingLeadId, lead) {
    return [[
        existingLeadId,
        lead.name || "",
        lead.facebook_leadgen_id || "",
        lead.facebook_form_id || "",
        lead.facebook_ad_id || "",
        lead.facebook_campaign_id || "",
        lead.facebook_created_time || "",
        lead.facebook_name || "",
        lead.line_user_id || "",
        lead.line_display_name || "",
        lead.line_created_time || "",
        lead.additional_note || "",
    ]];
}

async function updateSheet(sheets, spreadsheetId, range, values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
    });
}

async function createSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    return { sheets, spreadsheetId };
}

async function appendLeadToSheet(lead) {
    try {
        const { sheets, spreadsheetId } = await createSheetsClient();

        const leadsRows = await readSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.LEADS_MAIN}!A:L`
        );

        const dealsRows = await readSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.DEALS}!A:N`
        );

        const detailsRows = await readSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.LEAD_DETAILS}!A:L`
        );

        const existingLead = findLeadByPhone(leadsRows, lead.phone);

        console.log("Existing lead:", existingLead);

        if (!existingLead) {
            const leadId = generateId("LEAD");
            const dealId = generateId("DEAL");

            const nextLeadRow = getNextRow(leadsRows);
            const nextDealRow = getNextRow(dealsRows);
            const nextDetailRow = getNextRow(detailsRows);

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.LEADS_MAIN}!A${nextLeadRow}:L${nextLeadRow}`,
                buildLeadMainRow(leadId, lead)
            );

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.DEALS}!A${nextDealRow}:N${nextDealRow}`,
                buildDealRow(dealId, leadId, lead)
            );

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.LEAD_DETAILS}!A${nextDetailRow}:L${nextDetailRow}`,
                buildLeadDetailRow(leadId, lead)
            );

            console.log(`✅ New lead created: ${leadId}, deal: ${dealId}`);
            return;
        }

        // ===== Existing lead logic =====

        const leadId = existingLead.lead_id;

        const latestDeal = findLatestDealByLeadId(dealsRows, leadId);
        const isCompleted = isCompletedLead(existingLead);

        console.log("Existing lead found:", leadId);
        console.log("Latest deal:", latestDeal);
        console.log("Is completed:", isCompleted);

        if (!isCompleted && latestDeal) {
            const dealRowNumber = latestDeal.rowNumber;

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.DEALS}!A${dealRowNumber}:N${dealRowNumber}`,
                buildExistingDealUpdateRow(latestDeal, lead)
            );

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.LEADS_MAIN}!B${existingLead.rowNumber}:L${existingLead.rowNumber}`,
                buildExistingLeadUpdateRow(existingLead, lead)
            );

            await upsertLeadDetail(sheets, spreadsheetId, detailsRows, leadId, lead);

            console.log(`🔄 Updated existing deal: ${latestDeal.deal_id}`);
            return;
        }

        if (isCompleted) {
            const dealId = generateId("DEAL");
            const nextDealRow = getNextRow(dealsRows);

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.DEALS}!A${nextDealRow}:N${nextDealRow}`,
                buildDealRow(dealId, leadId, lead)
            );

            await updateSheet(
                sheets,
                spreadsheetId,
                `${SHEETS.LEADS_MAIN}!B${existingLead.rowNumber}:L${existingLead.rowNumber}`,
                buildExistingLeadUpdateRow(existingLead, lead)
            );

            await upsertLeadDetail(sheets, spreadsheetId, detailsRows, leadId, lead);

            console.log(`🆕 New deal created for existing lead: ${dealId}`);
            return;
        }
    } catch (err) {
        console.error("❌ Google Sheet error:", err.message);
    }
}

module.exports = {
    appendLeadToSheet,
};