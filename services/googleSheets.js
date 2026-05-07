const { google } = require("googleapis");

const SHEETS = {
    LEADS_MAIN: "LEADS_MAIN",
    LEAD_DETAILS: "LEAD_DETAILS",
    DEALS: "DEALS",
};

const HEADER_ROW = 1;
const DATA_START_ROW = 3;

const HEADER_ALIASES = {
    facebook_lead_id: "facebook_leadgen_id",
    fb_lead_id: "facebook_leadgen_id",
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

function columnToLetter(columnNumber) {
    let column = columnNumber;
    let letter = "";

    while (column > 0) {
        const remainder = (column - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        column = Math.floor((column - 1) / 26);
    }

    return letter;
}

function getLastDataRow(rows) {
    for (let i = rows.length - 1; i >= DATA_START_ROW - 1; i--) {
        if (rows[i] && rows[i].some(cell => String(cell || "").trim() !== "")) {
            return i + 1;
        }
    }

    return DATA_START_ROW - 1;
}

function getNextDataRow(rows) {
    return Math.max(getLastDataRow(rows) + 1, DATA_START_ROW);
}

function normalizeHeaderName(headerName) {
    const normalized = String(headerName || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    return HEADER_ALIASES[normalized] || normalized;
}

function groupObjectRanges(headers, rowNumber, object) {
    const groups = [];
    let currentGroup = null;

    headers.forEach((header, index) => {
        const canonicalHeader = normalizeHeaderName(header);

        if (
            !canonicalHeader ||
            canonicalHeader === "open_deal" ||
            !Object.prototype.hasOwnProperty.call(object, canonicalHeader)
        ) {
            if (currentGroup) {
                groups.push(currentGroup);
                currentGroup = null;
            }
            return;
        }

        if (!currentGroup) {
            currentGroup = {
                startIndex: index,
                endIndex: index,
                values: [object[canonicalHeader] ?? ""],
            };
            return;
        }

        if (index === currentGroup.endIndex + 1) {
            currentGroup.endIndex = index;
            currentGroup.values.push(object[canonicalHeader] ?? "");
            return;
        }

        groups.push(currentGroup);
        currentGroup = {
            startIndex: index,
            endIndex: index,
            values: [object[canonicalHeader] ?? ""],
        };
    });

    if (currentGroup) {
        groups.push(currentGroup);
    }

    return groups.map(group => {
        const startColumn = columnToLetter(group.startIndex + 1);
        const endColumn = columnToLetter(group.endIndex + 1);

        return {
            rowNumber,
            rangeSuffix: `${startColumn}${rowNumber}:${endColumn}${rowNumber}`,
            values: [group.values],
        };
    });
}

async function createSheetsClient() {
    const privateKey = process.env.GOOGLE_PRIVATE_KEY;

    if (!process.env.GOOGLE_CLIENT_EMAIL) {
        throw new Error("Missing GOOGLE_CLIENT_EMAIL");
    }

    if (!privateKey) {
        throw new Error("Missing GOOGLE_PRIVATE_KEY");
    }

    if (!process.env.GOOGLE_SHEET_ID) {
        throw new Error("Missing GOOGLE_SHEET_ID");
    }

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: privateKey.replace(/\\n/g, "\n"),
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

async function getSheetRows(sheetName) {
    const { sheets, spreadsheetId } = await createSheetsClient();
    return readSheet(sheets, spreadsheetId, `${sheetName}!A:ZZ`);
}

async function getHeaders(sheetName) {
    const rows = await getSheetRows(sheetName);
    return rows[HEADER_ROW - 1] || [];
}

function headerIndex(headers, headerName) {
    const target = normalizeHeaderName(headerName);
    const index = headers.findIndex(header => normalizeHeaderName(header) === target);

    if (index === -1) {
        throw new Error(`Missing required header: ${target}`);
    }

    return index;
}

function rowToObject(headers, row) {
    return headers.reduce((object, header, index) => {
        const canonicalHeader = normalizeHeaderName(header);

        if (canonicalHeader) {
            object[canonicalHeader] = row?.[index] || "";
        }

        return object;
    }, {});
}

function objectToRow(headers, object) {
    return headers.map(header => object?.[normalizeHeaderName(header)] ?? "");
}

async function appendObjects(sheetName, objects) {
    if (!objects.length) return [];

    const { sheets, spreadsheetId } = await createSheetsClient();
    const rows = await readSheet(sheets, spreadsheetId, `${sheetName}!A:ZZ`);
    const headers = rows[HEADER_ROW - 1] || [];
    let nextRow = getNextDataRow(rows);
    const data = [];
    const appendedRows = [];

    for (const object of objects) {
        const rowNumber = nextRow++;
        const groups = groupObjectRanges(headers, rowNumber, object);

        for (const group of groups) {
            data.push({
                range: `${sheetName}!${group.rangeSuffix}`,
                values: group.values,
            });
        }

        appendedRows.push(rowNumber);
    }

    await batchUpdateValues(sheets, spreadsheetId, data);

    return appendedRows;
}

async function updateObjectRow(sheetName, rowNumber, object) {
    const { sheets, spreadsheetId } = await createSheetsClient();
    const headers = await getHeaders(sheetName);
    const groups = groupObjectRanges(headers, rowNumber, object);

    await batchUpdateValues(
        sheets,
        spreadsheetId,
        groups.map(group => ({
            range: `${sheetName}!${group.rangeSuffix}`,
            values: group.values,
        }))
    );
}

function findLeadByPhone(headers, rows, phone) {
    const phoneIndex = headerIndex(headers, "phone");
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) return null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const rowPhone = normalizePhone(row[phoneIndex]);

        if (rowPhone && rowPhone === normalizedPhone) {
            return {
                ...rowToObject(headers, row),
                rowNumber: i + 1,
            };
        }
    }

    return null;
}

function findLeadDetailByLeadgenId(headers, rows, leadgenId) {
    const leadgenIndex = headerIndex(headers, "facebook_leadgen_id");
    const target = String(leadgenId || "").trim();

    if (!target) return null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];

        if (String(row[leadgenIndex] || "").trim() === target) {
            return {
                ...rowToObject(headers, row),
                rowNumber: i + 1,
            };
        }
    }

    return null;
}

function findLatestDealByLeadId(headers, rows, leadId) {
    const leadIdIndex = headerIndex(headers, "lead_id");
    const target = String(leadId || "").trim();
    let latestDeal = null;

    if (!target) return null;

    for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
        const row = rows[i] || [];

        if (String(row[leadIdIndex] || "").trim() === target) {
            latestDeal = {
                ...rowToObject(headers, row),
                rowNumber: i + 1,
            };
        }
    }

    return latestDeal;
}

function isCompletedLead(leadObject) {
    const status = String(leadObject?.lead_status || "").trim().toLowerCase();
    return status === "completed" || status === "closed won";
}

function buildLeadMainObject(leadId, lead, existingLead = null) {
    const now = formatDateTimeForSheet(new Date());

    return {
        lead_id: leadId,
        customer_name: lead.name || existingLead?.customer_name || "",
        phone: normalizePhone(lead.phone || existingLead?.phone),
        source: lead.source || existingLead?.source || "Facebook",
        customer_type: existingLead?.customer_type || lead.customer_type || "",
        province: lead.province || existingLead?.province || "",
        zone: existingLead?.zone || lead.zone || "",
        preferred_call_day: existingLead?.preferred_call_day || lead.preferred_call_day || "",
        preferred_call_time: existingLead?.preferred_call_time || lead.preferred_call_time || "",
        lead_status: existingLead?.lead_status || lead.status || "New",
        reason: existingLead?.reason || lead.reason || "",
        sales_owner: existingLead?.sales_owner || lead.sales_owner || "",
        created_at: existingLead?.created_at || now,
        updated_at: now,
    };
}

function buildLeadMainUpdateObject(existingLead, lead) {
    return {
        customer_name: lead.name || existingLead.customer_name || "",
        phone: normalizePhone(lead.phone || existingLead.phone),
        source: lead.source || existingLead.source || "Facebook",
        province: lead.province || existingLead.province || "",
        preferred_call_day: existingLead.preferred_call_day || lead.preferred_call_day || "",
        preferred_call_time: existingLead.preferred_call_time || lead.preferred_call_time || "",
        updated_at: formatDateTimeForSheet(new Date()),
    };
}

function buildLeadDetailObject(leadId, lead) {
    return {
        lead_id: leadId,
        facebook_leadgen_id: lead.facebook_leadgen_id || "",
        campaign_name: lead.facebook_campaign_name || "",
        adset_name: lead.facebook_adset_name || "",
        raw_province: lead.raw_province || "",
        raw_data_json: lead.raw_data_json || "",
        import_source: lead.source || "Facebook",
    };
}

function buildDealObject(dealId, leadId, lead = {}, existingDeal = null) {
    return {
        deal_id: dealId,
        lead_id: leadId,
        product_model: lead.product_model || lead.product_name || existingDeal?.product_model || "",
        package_type: lead.package_type || lead.package_name || existingDeal?.package_type || "",
        price: lead.price || existingDeal?.price || "",
        payment_status: existingDeal?.payment_status || lead.payment_status || "Unpaid",
        payment_date: existingDeal?.payment_date || lead.payment_date || "",
    };
}

async function getExistingLeadgenIds() {
    const rows = await getSheetRows(SHEETS.LEAD_DETAILS);
    const headers = rows[HEADER_ROW - 1] || [];
    const leadgenIndex = headerIndex(headers, "facebook_leadgen_id");

    return new Set(
        rows
            .slice(DATA_START_ROW - 1)
            .map(row => String(row?.[leadgenIndex] || "").trim())
            .filter(Boolean)
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

    const [leadsRows, detailsRows, dealsRows] = await Promise.all([
        readSheet(sheets, spreadsheetId, `${SHEETS.LEADS_MAIN}!A:ZZ`),
        readSheet(sheets, spreadsheetId, `${SHEETS.LEAD_DETAILS}!A:ZZ`),
        readSheet(sheets, spreadsheetId, `${SHEETS.DEALS}!A:ZZ`),
    ]);

    const leadHeaders = leadsRows[HEADER_ROW - 1] || [];
    const detailHeaders = detailsRows[HEADER_ROW - 1] || [];
    const dealHeaders = dealsRows[HEADER_ROW - 1] || [];

    headerIndex(leadHeaders, "phone");
    headerIndex(detailHeaders, "facebook_leadgen_id");
    headerIndex(dealHeaders, "lead_id");

    const createdItems = [];
    const updatedItems = [];
    const skippedExistingItems = [];
    const skippedEmptyItems = [];
    const newLeadObjects = [];
    const newDetailObjects = [];
    const newDealObjects = [];
    const updateData = [];

    const inMemoryLeadRows = leadsRows.map(row => [...row]);
    const inMemoryDetailRows = detailsRows.map(row => [...row]);
    const inMemoryDealRows = dealsRows.map(row => [...row]);

    let nextLeadRow = getNextDataRow(inMemoryLeadRows);
    let nextDetailRow = getNextDataRow(inMemoryDetailRows);
    let nextDealRow = getNextDataRow(inMemoryDealRows);

    const seenLeadgenIds = new Set(
        detailsRows
            .slice(DATA_START_ROW - 1)
            .map(row => rowToObject(detailHeaders, row).facebook_leadgen_id)
            .map(value => String(value || "").trim())
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

        const existingLead = findLeadByPhone(leadHeaders, inMemoryLeadRows, normalizedPhone);

        if (!existingLead) {
            const leadId = generateId("LEAD");
            const dealId = generateId("DEAL");
            const leadObject = buildLeadMainObject(leadId, lead);
            const detailObject = buildLeadDetailObject(leadId, lead);
            const dealObject = buildDealObject(dealId, leadId, lead);

            newLeadObjects.push(leadObject);
            newDetailObjects.push(detailObject);
            newDealObjects.push(dealObject);

            inMemoryLeadRows[nextLeadRow - 1] = objectToRow(leadHeaders, leadObject);
            inMemoryDetailRows[nextDetailRow - 1] = objectToRow(detailHeaders, detailObject);
            inMemoryDealRows[nextDealRow - 1] = objectToRow(dealHeaders, dealObject);
            nextLeadRow++;
            nextDetailRow++;
            nextDealRow++;
            seenLeadgenIds.add(leadgenId);

            createdItems.push({
                lead_id: leadId,
                deal_id: dealId,
                facebook_leadgen_id: leadgenId,
                phone: normalizedPhone,
                name: lead.name || "",
            });

            continue;
        }

        const leadId = existingLead.lead_id;
        const latestDeal = findLatestDealByLeadId(dealHeaders, inMemoryDealRows, leadId);
        const shouldCreateDeal = isCompletedLead(existingLead) || !latestDeal;
        const detailObject = buildLeadDetailObject(leadId, lead);
        const updateLeadObject = buildLeadMainUpdateObject(existingLead, lead);

        for (const group of groupObjectRanges(leadHeaders, existingLead.rowNumber, updateLeadObject)) {
            updateData.push({
                range: `${SHEETS.LEADS_MAIN}!${group.rangeSuffix}`,
                values: group.values,
            });
        }

        newDetailObjects.push(detailObject);
        inMemoryDetailRows[nextDetailRow - 1] = objectToRow(detailHeaders, detailObject);
        nextDetailRow++;

        let dealId = latestDeal?.deal_id || "";

        if (shouldCreateDeal) {
            dealId = generateId("DEAL");
            const dealObject = buildDealObject(dealId, leadId, lead);
            newDealObjects.push(dealObject);
            inMemoryDealRows[nextDealRow - 1] = objectToRow(dealHeaders, dealObject);
            nextDealRow++;
        }

        seenLeadgenIds.add(leadgenId);

        updatedItems.push({
            lead_id: leadId,
            deal_id: dealId,
            facebook_leadgen_id: leadgenId,
            action: shouldCreateDeal
                ? "created_new_deal_for_completed_or_missing_deal"
                : "updated_existing",
        });
    }

    if (newLeadObjects.length) {
        const startRow = getNextDataRow(leadsRows);
        let rowNumber = startRow;

        for (const object of newLeadObjects) {
            for (const group of groupObjectRanges(leadHeaders, rowNumber, object)) {
                updateData.push({
                    range: `${SHEETS.LEADS_MAIN}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }
            rowNumber++;
        }
    }

    if (newDetailObjects.length) {
        const startRow = getNextDataRow(detailsRows);
        let rowNumber = startRow;

        for (const object of newDetailObjects) {
            for (const group of groupObjectRanges(detailHeaders, rowNumber, object)) {
                updateData.push({
                    range: `${SHEETS.LEAD_DETAILS}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }
            rowNumber++;
        }
    }

    if (newDealObjects.length) {
        const startRow = getNextDataRow(dealsRows);
        let rowNumber = startRow;

        for (const object of newDealObjects) {
            for (const group of groupObjectRanges(dealHeaders, rowNumber, object)) {
                updateData.push({
                    range: `${SHEETS.DEALS}!${group.rangeSuffix}`,
                    values: group.values,
                });
            }
            rowNumber++;
        }
    }

    await batchUpdateValues(sheets, spreadsheetId, updateData);

    console.log(`Batch sync created: ${createdItems.length}`);
    console.log(`Batch sync updated_existing: ${updatedItems.length}`);
    console.log(`Batch sync skipped_existing: ${skippedExistingItems.length}`);
    console.log(`Batch sync skipped_empty: ${skippedEmptyItems.length}`);

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
    getSheetRows,
    getHeaders,
    headerIndex,
    rowToObject,
    objectToRow,
    appendObjects,
    updateObjectRow,
    normalizePhone,
    normalizeHeaderName,
};
