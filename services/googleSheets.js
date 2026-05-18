const { google } = require("googleapis");

const SHEETS = {
    LEADS_MAIN: "LEADS_MAIN",
    LEAD_DETAILS: "LEAD_DETAILS",
    DEALS: "DEALS",
    INSTALLATIONS: "INSTALLATIONS",
};

const HEADER_ROW = 1;
const DATA_START_ROW = 3;

const HEADER_ALIASES = {
    facebook_lead_id: "facebook_leadgen_id",
    fb_lead_id: "facebook_leadgen_id",
    paid_amount: "price",
    install_date: "preferred_install_date",
    install_time: "preferred_install_time",
    time_slot: "preferred_install_time",
    quantity: "machine_count",
    device_count: "machine_count",
    installation_status: "install_status",
    activity_type: "action_type",
    activity_result: "new_value",
    result: "new_value",
    audio_link: "audio_url",
    activity_date: "created_at",
    import_source: "created_source",
};

function normalizeLeadStatusForSheet(status) {
    const raw = String(status || "").trim();
    const value = raw.toLowerCase();

    if (!raw || value === "unknown") return "New";
    if (["new"].includes(value)) return "New";
    if (["ongoing", "contacted", "interested", "follow-up", "follow up", "followup", "pending"].includes(value)) return "Ongoing";
    if (["installed", "installation complete"].includes(value)) return "Installed";
    if (["done", "closed", "closed won", "completed", "complete"].includes(value)) return "Done";
    if (["cancelled", "canceled", "not interested", "closed lost"].includes(value)) return "Cancelled";

    if (value.includes("cancel")) return "Cancelled";
    if (value.includes("not interested")) return "Cancelled";
    if (value.includes("install")) return "Installed";
    if (value.includes("closed") || value.includes("done") || value.includes("complete")) return "Done";
    if (value.includes("follow") || value.includes("pending") || value.includes("contact") || value.includes("interest")) return "Ongoing";

    return "New";
}

function normalizePaymentStatusForSheet(status) {
    const raw = String(status || "").trim();
    const value = raw.toLowerCase();

    if (!raw || value === "unknown") return "Unpaid";
    if (value === "paid") return "Paid";
    if (value === "unpaid") return "Unpaid";
    if (value === "cancelled" || value === "canceled") return "Cancelled";
    if (value === "partial" || value.includes("partial")) return "Unpaid";

    if (value.includes("cancel")) return "Cancelled";
    if (value.includes("unpaid")) return "Unpaid";
    if (value.includes("paid") && !value.includes("unpaid")) return "Paid";

    return "Unpaid";
}

function normalizeInstallationStatusForSheet(status) {
    const raw = String(status || "").trim();
    const value = raw.toLowerCase();

    if (value === "installed") return "Installed";
    if (value === "cancelled" || value === "canceled") return "Cancelled";
    if (value.includes("install") && !value.includes("progress")) return "Installed";
    if (value.includes("cancel")) return "Cancelled";

    return "In Progress";
}

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

async function ensureSheetHeaders(sheets, spreadsheetId, sheetName, rows, requiredHeaders) {
    const headers = rows[HEADER_ROW - 1] || [];
    const existingHeaders = new Set(headers.map(normalizeHeaderName).filter(Boolean));
    const missingHeaders = requiredHeaders.filter(header => !existingHeaders.has(normalizeHeaderName(header)));

    if (!missingHeaders.length) {
        return headers;
    }

    const startColumn = columnToLetter(headers.length + 1);
    const endColumn = columnToLetter(headers.length + missingHeaders.length);
    await updateSheet(
        sheets,
        spreadsheetId,
        `${sheetName}!${startColumn}${HEADER_ROW}:${endColumn}${HEADER_ROW}`,
        [missingHeaders]
    );

    const updatedHeaders = [...headers, ...missingHeaders];
    rows[HEADER_ROW - 1] = updatedHeaders;
    return updatedHeaders;
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
            !Object.prototype.hasOwnProperty.call(object, canonicalHeader)
        ) {
            if (currentGroup) {
                groups.push(currentGroup);
                currentGroup = null;
            }
            return;
        }

        const value = getObjectValueForCanonicalHeader(object, canonicalHeader);

        if (!currentGroup) {
            currentGroup = {
                startIndex: index,
                endIndex: index,
                values: [value],
            };
            return;
        }

        if (index === currentGroup.endIndex + 1) {
            currentGroup.endIndex = index;
            currentGroup.values.push(value);
            return;
        }

        groups.push(currentGroup);
        currentGroup = {
            startIndex: index,
            endIndex: index,
            values: [value],
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

function getObjectValueForCanonicalHeader(object, canonicalHeader) {
    if (!object) return "";
    if (Object.prototype.hasOwnProperty.call(object, canonicalHeader)) {
        const value = object[canonicalHeader];
        if (value !== undefined && value !== null) return value;
    }
    if (canonicalHeader === "price" && Object.prototype.hasOwnProperty.call(object, "paid_amount")) {
        return object.paid_amount ?? "";
    }
    return "";
}

function normalizeSheetObject(sheetName, object = {}) {
    const normalizedObject = { ...object };

    if (sheetName === SHEETS.LEADS_MAIN) {
        if (Object.prototype.hasOwnProperty.call(normalizedObject, "lead_status")) {
            normalizedObject.lead_status = normalizeLeadStatusForSheet(normalizedObject.lead_status);
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "status")) {
            normalizedObject.status = normalizeLeadStatusForSheet(normalizedObject.status);
        }
    }

    if (sheetName === SHEETS.DEALS) {
        if (Object.prototype.hasOwnProperty.call(normalizedObject, "paid_amount")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "price")) {
            normalizedObject.price = normalizedObject.paid_amount;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "payment_status")) {
            normalizedObject.payment_status = normalizePaymentStatusForSheet(normalizedObject.payment_status);
        }
    }

    if (sheetName === SHEETS.INSTALLATIONS) {
        const copyIfMissing = (target, sources) => {
            if (Object.prototype.hasOwnProperty.call(normalizedObject, target)) return;
            for (const source of sources) {
                if (Object.prototype.hasOwnProperty.call(normalizedObject, source)
                    && String(normalizedObject[source] ?? "").trim()) {
                    normalizedObject[target] = normalizedObject[source];
                    return;
                }
            }
        };

        copyIfMissing("preferred_install_date", ["install_date"]);
        copyIfMissing("preferred_install_time", ["install_time", "time_slot"]);
        copyIfMissing("machine_count", ["quantity", "device_count"]);
        copyIfMissing("location", ["location", "address", "zone"]);

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "install_status")
            || Object.prototype.hasOwnProperty.call(normalizedObject, "installation_status")) {
            normalizedObject.install_status = normalizeInstallationStatusForSheet(
                normalizedObject.install_status || normalizedObject.installation_status
            );
        }
    }

    if (sheetName === "ACTIVITY_LOG") {
        if (Object.prototype.hasOwnProperty.call(normalizedObject, "activity_type")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "action_type")) {
            normalizedObject.action_type = normalizedObject.activity_type;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "activity_result")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "new_value")) {
            normalizedObject.new_value = normalizedObject.activity_result;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "result")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "new_value")) {
            normalizedObject.new_value = normalizedObject.result;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "audio_link")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "audio_url")) {
            normalizedObject.audio_url = normalizedObject.audio_link;
        }

        if (Object.prototype.hasOwnProperty.call(normalizedObject, "activity_date")
            && !Object.prototype.hasOwnProperty.call(normalizedObject, "created_at")) {
            normalizedObject.created_at = normalizedObject.activity_date;
        }
    }

    return normalizedObject;
}

function objectToRow(headers, object) {
    return headers.map(header => getObjectValueForCanonicalHeader(object, normalizeHeaderName(header)));
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
        const normalizedObject = normalizeSheetObject(sheetName, object);
        const rowNumber = nextRow++;
        const groups = groupObjectRanges(headers, rowNumber, normalizedObject);

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
    const groups = groupObjectRanges(headers, rowNumber, normalizeSheetObject(sheetName, object));

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
    const facebookCreatedTime = String(lead.facebook_created_time || "").trim();

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
        lead_form_name: lead.lead_form_name || lead.facebook_form_name || "",
        ad_name: lead.ad_name || lead.facebook_ad_name || "",
        adset_name: lead.adset_name || lead.facebook_adset_name || "",
        campaign_name: lead.campaign_name || lead.facebook_campaign_name || "",
        facebook_created_time: facebookCreatedTime,
        lead_status: normalizeLeadStatusForSheet(existingLead?.lead_status || lead.status || "New"),
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
        raw_phone: lead.raw_phone || lead.phone || "",
        raw_province: lead.raw_province || "",
        form_id: lead.form_id || lead.facebook_form_id || "",
        ad_id: lead.ad_id || lead.facebook_ad_id || "",
        adset_id: lead.adset_id || lead.facebook_adset_id || "",
        campaign_id: lead.campaign_id || lead.facebook_campaign_id || "",
        facebook_created_time: lead.facebook_created_time || "",
        is_organic: lead.is_organic ?? lead.facebook_is_organic ?? "",
        platform: lead.platform || lead.facebook_platform || "",
        inbox_url: lead.inbox_url || "",
        original_customer_name: lead.original_customer_name || lead.name || "",
        created_source: lead.source || "Facebook",
    };
}

function buildDealObject(dealId, leadId, lead = {}, existingDeal = null) {
    return {
        deal_id: dealId,
        lead_id: leadId,
        product_model: lead.product_model || lead.product_name || existingDeal?.product_model || "",
        package_type: lead.package_type || lead.package_name || existingDeal?.package_type || "",
        price: lead.price || existingDeal?.price || "",
        full_amount: lead.full_amount || existingDeal?.full_amount || "",
        payment_status: normalizePaymentStatusForSheet(existingDeal?.payment_status || lead.payment_status || "Unpaid"),
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
            affected_rows: result.affected_rows || [],
        };
    }

    if (result.updated_existing > 0) {
        return {
            action: "updated_existing",
            lead_id: result.updated_items[0]?.lead_id || "",
            deal_id: result.updated_items[0]?.deal_id || "",
            affected_rows: result.affected_rows || [],
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

    const leadHeaders = await ensureSheetHeaders(
        sheets,
        spreadsheetId,
        SHEETS.LEADS_MAIN,
        leadsRows,
        ["lead_form_name", "ad_name", "adset_name", "campaign_name", "facebook_created_time"]
    );
    const detailHeaders = await ensureSheetHeaders(
        sheets,
        spreadsheetId,
        SHEETS.LEAD_DETAILS,
        detailsRows,
        [
            "form_id",
            "ad_id",
            "adset_id",
            "campaign_id",
            "facebook_created_time",
            "is_organic",
            "platform",
            "inbox_url",
        ]
    );
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
    const affectedRows = new Set();

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
            const leadRowNumber = nextLeadRow;
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
            affectedRows.add(leadRowNumber);

            createdItems.push({
                lead_id: leadId,
                deal_id: dealId,
                lead_row_number: leadRowNumber,
                facebook_leadgen_id: leadgenId,
                phone: normalizedPhone,
                name: lead.name || "",
            });

            continue;
        }

        const leadId = existingLead.lead_id;
        affectedRows.add(existingLead.rowNumber);
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
            lead_row_number: existingLead.rowNumber,
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
        affected_rows: Array.from(affectedRows).sort((a, b) => a - b),
        incremental_cleanup_attempted: false,
        incremental_cleanup_rows: 0,
        full_cleanup_required: false,
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
