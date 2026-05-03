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

async function readSheet(sheets, spreadsheetId, range) {
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    return result.data.values || [];
}

async function updateSheet(sheets, spreadsheetId, range, values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
    });
}

function findLeadByPhone(rows, phone) {
    const normalizedPhone = normalizePhone(phone);

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowPhone = normalizePhone(row[1]);

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

function findLatestDealByLeadId(rows, leadId) {
    let latestDeal = null;

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if ((row[1] || "") === leadId) {
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

        if ((row[0] || "") === leadId) {
            return {
                rowNumber: i + 1,
                lead_id: row[0] || "",
            };
        }
    }

    return null;
}

function mergeSource(currentSource, incomingSource) {
    const current = String(currentSource || "").trim();
    const incoming = String(incomingSource || "Facebook").trim();

    if (!current) return incoming;
    if (current === incoming) return current;

    return "Multiple";
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
        formatDateTimeForSheet(new Date()),
        formatDateTimeForSheet(new Date()),
    ]];
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
        formatDateTimeForSheet(new Date()),
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
        formatDateTimeForSheet(new Date()),
        formatDateTimeForSheet(new Date()),
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
        formatDateTimeForSheet(new Date()),
        formatDateTimeForSheet(new Date()),
    ]];
}

function buildLeadDetailRow(leadId, lead) {
    return [[
        leadId,
        lead.facebook_leadgen_id || "",
        lead.name || "",
        lead.facebook_form_id || "",
        lead.facebook_form_name || "",
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

function buildLeadDetailUpdateRow(leadId, lead) {
    return [[
        leadId,
        lead.facebook_leadgen_id || "",
        lead.name || "",
        lead.facebook_form_id || "",
        lead.facebook_form_name || "",
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

async function getExistingLeadgenIds() {
    const { sheets, spreadsheetId } = await createSheetsClient();

    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.LEAD_DETAILS}!B:B`,
    });

    const values = result.data.values || [];

    return new Set(
        values
            .flat()
            .map(value => String(value || "").trim())
            .filter(Boolean)
            .filter(value => value !== "facebook_leadgen_id")
    );
}

async function upsertLeadDetail(sheets, spreadsheetId, detailsRows, leadId, lead) {
    const existingDetail = findLeadDetailByLeadId(detailsRows, leadId);

    if (existingDetail) {
        await updateSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.LEAD_DETAILS}!A${existingDetail.rowNumber}:M${existingDetail.rowNumber}`,
            buildLeadDetailUpdateRow(leadId, lead)
        );

        console.log(`🔄 Updated lead detail: ${leadId}`);
        return;
    }

    const nextDetailRow = getNextRow(detailsRows);

    await updateSheet(
        sheets,
        spreadsheetId,
        `${SHEETS.LEAD_DETAILS}!A${nextDetailRow}:M${nextDetailRow}`,
        buildLeadDetailRow(leadId, lead)
    );

    console.log(`✅ Created lead detail: ${leadId}`);
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
            `${SHEETS.LEAD_DETAILS}!A:M`
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
                `${SHEETS.LEAD_DETAILS}!A${nextDetailRow}:M${nextDetailRow}`,
                buildLeadDetailRow(leadId, lead)
            );

            console.log(`✅ New lead created: ${leadId}, deal: ${dealId}`);

            return {
                action: "created",
                lead_id: leadId,
                deal_id: dealId,
            };
        }

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

            return {
                action: "updated_existing",
                lead_id: leadId,
                deal_id: latestDeal.deal_id,
            };
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

            return {
                action: "created_new_deal_for_existing_lead",
                lead_id: leadId,
                deal_id: dealId,
            };
        }

        return {
            action: "no_action",
            lead_id: leadId,
        };
    } catch (err) {
        console.error("❌ Google Sheet error:", err.message);
        throw err;
    }
}

async function getExistingLeadgenIds() {
    const { sheets, spreadsheetId } = await createSheetsClient();

    const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.LEAD_DETAILS}!B:B`,
    });

    const values = result.data.values || [];

    return new Set(
        values
            .flat()
            .map(value => String(value || "").trim())
            .filter(Boolean)
            .filter(value => value !== "facebook_leadgen_id")
    );
}

module.exports = {
    appendLeadToSheet,
    getExistingLeadgenIds,
    createSheetsClient,
    readSheet,
};