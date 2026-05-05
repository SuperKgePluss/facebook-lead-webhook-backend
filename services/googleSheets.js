const { google } = require("googleapis");

const SHEETS = {
    LEADS_MAIN: "LEADS_MAIN",
    LEAD_DETAILS: "LEAD_DETAILS",
    DEALS: "DEALS",
};

function normalizePhone(phone) {
    let digits = String(phone || "").replace(/\D/g, "").trim();

    if (!digits) return "";

    if (digits.startsWith("66") && digits.length > 2) {
        digits = "0" + digits.slice(2);
    }

    if (digits.length === 9 && !digits.startsWith("0")) {
        digits = "0" + digits;
    }

    return digits;
}

function generateId(prefix) {
    return `${prefix}-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function formatDateTimeForSheet(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
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

async function batchUpdateValues(sheets, spreadsheetId, data) {
    if (!data.length) return;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data,
        },
    });
}

function getNextRow(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i] && rows[i].some(cell => String(cell || "").trim() !== "")) {
            return i + 2;
        }
    }

    return 2;
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

function findLeadDetailByLeadgenId(rows, leadgenId) {
    const target = String(leadgenId || "").trim();

    if (!target) return null;

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if (String(row[1] || "").trim() === target) {
            return {
                rowNumber: i + 1,
                lead_id: row[0] || "",
                facebook_leadgen_id: row[1] || "",
            };
        }
    }

    return null;
}

function findLeadDetailByLeadId(rows, leadId) {
    const target = String(leadId || "").trim();

    if (!target) return null;

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if (String(row[0] || "").trim() === target) {
            return {
                rowNumber: i + 1,
                lead_id: row[0] || "",
            };
        }
    }

    return null;
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

function isCompletedLead(leadRow) {
    return String(leadRow?.status || "").toLowerCase() === "completed";
}

function mergeSource(currentSource, incomingSource) {
    const current = String(currentSource || "").trim();
    const incoming = String(incomingSource || "Facebook").trim();

    if (!current) return incoming;
    if (current === incoming) return current;

    return "Multiple";
}

function buildLeadMainRow(leadId, lead) {
    return [
        leadId,
        normalizePhone(lead.phone),
        lead.name || "",
        lead.source || "Facebook",
        lead.status || "New",
        lead.sales_owner || "",
        lead.latest_audio_link || "",
        lead.last_contact_date || "",
        lead.next_follow_up || "",
        lead.note || "",
        formatDateTimeForSheet(new Date()),
        formatDateTimeForSheet(new Date()),
    ];
}

function buildExistingLeadUpdateRow(existingLead, lead) {
    return [
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
    ];
}

function buildDealRow(dealId, leadId, lead) {
    return [
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
    ];
}

function buildExistingDealUpdateRow(existingDeal, lead) {
    return [
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
    ];
}

function buildLeadDetailRow(leadId, lead) {
    return [
        leadId,
        lead.facebook_leadgen_id || "",
        lead.name || "",
        lead.facebook_form_name || "",
        lead.facebook_form_id || "",
        lead.facebook_ad_id || "",
        lead.facebook_campaign_id || "",
        lead.facebook_created_time || "",
        lead.line_user_id || "",
        lead.line_display_name || "",
        lead.line_created_time || "",
        lead.additional_note || "",
    ];
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
            .filter(value => value.toLowerCase() !== "facebook leadgen id")
            .filter(value => value.toLowerCase() !== "facebook_leadgen_id")
    );
}

async function appendLeadToSheet(lead) {
    const result = await appendLeadsToSheetBatch([lead]);

    if (result.created > 0) {
        return {
            action: "created",
            lead_id: result.created_items[0]?.lead_id || "",
            deal_id: result.created_items[0]?.deal_id || "",
        };
    }

    if (result.updated_existing > 0) {
        return {
            action: "updated_existing",
            lead_id: result.updated_items[0]?.lead_id || "",
            deal_id: result.updated_items[0]?.deal_id || "",
        };
    }

    if (result.skipped_existing > 0) {
        return {
            action: "skipped_existing",
        };
    }

    return {
        action: "no_action",
    };
}

async function appendLeadsToSheetBatch(leads) {
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

    let nextLeadRow = getNextRow(leadsRows);
    let nextDealRow = getNextRow(dealsRows);
    let nextDetailRow = getNextRow(detailsRows);

    const newLeadRows = [];
    const newDealRows = [];
    const newDetailRows = [];
    const updateData = [];

    const createdItems = [];
    const updatedItems = [];
    const skippedExistingItems = [];
    const skippedEmptyItems = [];

    const inMemoryLeadRows = leadsRows.map(row => [...row]);
    const inMemoryDealRows = dealsRows.map(row => [...row]);
    const inMemoryDetailRows = detailsRows.map(row => [...row]);

    const seenLeadgenIds = new Set(
        detailsRows
            .slice(1)
            .map(row => String(row[1] || "").trim())
            .filter(Boolean)
    );

    for (const lead of leads) {
        const leadgenId = String(lead.facebook_leadgen_id || "").trim();
        const normalizedPhone = normalizePhone(lead.phone);

        if (!leadgenId) {
            skippedEmptyItems.push({
                reason: "missing_facebook_leadgen_id",
                name: lead.name || "",
                phone: lead.phone || "",
            });
            continue;
        }

        if (!normalizedPhone && !lead.name) {
            skippedEmptyItems.push({
                reason: "missing_phone_and_name",
                facebook_leadgen_id: leadgenId,
            });
            continue;
        }

        if (seenLeadgenIds.has(leadgenId)) {
            skippedExistingItems.push({
                facebook_leadgen_id: leadgenId,
                reason: "facebook_leadgen_id_already_exists",
            });
            continue;
        }

        const existingLead = findLeadByPhone(inMemoryLeadRows, normalizedPhone);

        if (!existingLead) {
            const leadId = generateId("LEAD");
            const dealId = generateId("DEAL");

            const leadMainRow = buildLeadMainRow(leadId, lead);
            const dealRow = buildDealRow(dealId, leadId, lead);
            const detailRow = buildLeadDetailRow(leadId, lead);

            newLeadRows.push(leadMainRow);
            newDealRows.push(dealRow);
            newDetailRows.push(detailRow);

            inMemoryLeadRows[nextLeadRow - 1] = leadMainRow;
            inMemoryDealRows[nextDealRow - 1] = dealRow;
            inMemoryDetailRows[nextDetailRow - 1] = detailRow;

            seenLeadgenIds.add(leadgenId);

            createdItems.push({
                lead_id: leadId,
                deal_id: dealId,
                facebook_leadgen_id: leadgenId,
                phone: normalizedPhone,
                name: lead.name || "",
            });

            nextLeadRow++;
            nextDealRow++;
            nextDetailRow++;

            continue;
        }

        const leadId = existingLead.lead_id;
        const latestDeal = findLatestDealByLeadId(inMemoryDealRows, leadId);
        const existingDetail = findLeadDetailByLeadId(inMemoryDetailRows, leadId);
        const completed = isCompletedLead(existingLead);

        if (completed || !latestDeal) {
            const dealId = generateId("DEAL");
            const dealRow = buildDealRow(dealId, leadId, lead);
            const detailRow = buildLeadDetailRow(leadId, lead);

            newDealRows.push(dealRow);

            inMemoryDealRows[nextDealRow - 1] = dealRow;
            nextDealRow++;

            if (existingDetail) {
                updateData.push({
                    range: `${SHEETS.LEAD_DETAILS}!A${existingDetail.rowNumber}:L${existingDetail.rowNumber}`,
                    values: [detailRow],
                });

                inMemoryDetailRows[existingDetail.rowNumber - 1] = detailRow;
            } else {
                newDetailRows.push(detailRow);
                inMemoryDetailRows[nextDetailRow - 1] = detailRow;
                nextDetailRow++;
            }

            updateData.push({
                range: `${SHEETS.LEADS_MAIN}!B${existingLead.rowNumber}:L${existingLead.rowNumber}`,
                values: [buildExistingLeadUpdateRow(existingLead, lead)],
            });

            seenLeadgenIds.add(leadgenId);

            updatedItems.push({
                lead_id: leadId,
                deal_id: dealId,
                facebook_leadgen_id: leadgenId,
                action: "created_new_deal_for_completed_or_missing_deal",
            });

            continue;
        }

        const updatedDealRow = buildExistingDealUpdateRow(latestDeal, lead);
        const updatedLeadDetailRow = buildLeadDetailRow(leadId, lead);

        updateData.push({
            range: `${SHEETS.DEALS}!A${latestDeal.rowNumber}:N${latestDeal.rowNumber}`,
            values: [updatedDealRow],
        });

        updateData.push({
            range: `${SHEETS.LEADS_MAIN}!B${existingLead.rowNumber}:L${existingLead.rowNumber}`,
            values: [buildExistingLeadUpdateRow(existingLead, lead)],
        });

        if (existingDetail) {
            updateData.push({
                range: `${SHEETS.LEAD_DETAILS}!A${existingDetail.rowNumber}:L${existingDetail.rowNumber}`,
                values: [updatedLeadDetailRow],
            });

            inMemoryDetailRows[existingDetail.rowNumber - 1] = updatedLeadDetailRow;
        } else {
            newDetailRows.push(updatedLeadDetailRow);
            inMemoryDetailRows[nextDetailRow - 1] = updatedLeadDetailRow;
            nextDetailRow++;
        }

        seenLeadgenIds.add(leadgenId);

        updatedItems.push({
            lead_id: leadId,
            deal_id: latestDeal.deal_id,
            facebook_leadgen_id: leadgenId,
            action: "updated_existing",
        });
    }

    const startLeadRow = getNextRow(leadsRows);
    const startDealRow = getNextRow(dealsRows);
    const startDetailRow = getNextRow(detailsRows);

    if (newLeadRows.length) {
        const endRow = startLeadRow + newLeadRows.length - 1;

        await updateSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.LEADS_MAIN}!A${startLeadRow}:L${endRow}`,
            newLeadRows
        );
    }

    if (newDealRows.length) {
        const endRow = startDealRow + newDealRows.length - 1;

        await updateSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.DEALS}!A${startDealRow}:N${endRow}`,
            newDealRows
        );
    }

    if (newDetailRows.length) {
        const endRow = startDetailRow + newDetailRows.length - 1;

        await updateSheet(
            sheets,
            spreadsheetId,
            `${SHEETS.LEAD_DETAILS}!A${startDetailRow}:L${endRow}`,
            newDetailRows
        );
    }

    await batchUpdateValues(sheets, spreadsheetId, updateData);

    console.log(`✅ Batch sync created: ${createdItems.length}`);
    console.log(`🔄 Batch sync updated_existing: ${updatedItems.length}`);
    console.log(`⏭️ Batch sync skipped_existing: ${skippedExistingItems.length}`);
    console.log(`⚠️ Batch sync skipped_empty: ${skippedEmptyItems.length}`);

    return {
        created: createdItems.length,
        updated_existing: updatedItems.length,
        skipped_existing: skippedExistingItems.length,
        skipped_empty: skippedEmptyItems.length,
        created_items: createdItems,
        updated_items: updatedItems,
        skipped_existing_items: skippedExistingItems,
        skipped_empty_items: skippedEmptyItems,
    };
}

module.exports = {
    appendLeadToSheet,
    appendLeadsToSheetBatch,
    getExistingLeadgenIds,
    createSheetsClient,
    readSheet,
    normalizePhone,
};