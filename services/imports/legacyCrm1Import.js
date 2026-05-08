const googleSheets = require("../googleSheets");
const {
    parseDryRunParam,
    normalizeImportText,
    normalizeByMappingRules,
    mapLegacySource,
    mapLegacyReason,
    normalizeLegacyProvince,
    normalizeLegacyZone,
    parseLegacyDateValue,
    formatLegacyDateForSheet,
    loadMappingRules,
    readFirstAvailableSheet,
    rowHasAnyValue,
    hasAnyValue,
    extractUrls,
    generateImportId,
} = require("./importUtils");

const DEFAULT_CRM1_SOURCE_BLOCK = "Priority Leads";

const CRM1_PRIORITY_LEADS_HEADERS = {
    customer_name: ["ชื่อลูกค้า + ชื่อ LINE / FB (Customer name)", "Customer name"],
    phone: ["เบอร์ติดต่อ (Tel.)", "Tel."],
    source: ["ช่องทางการขาย (Sales Channel)", "Sales Channel"],
    customer_type: ["ประเภทลูกค้า (Customer type)", "Customer type"],
    location_type: ["ประเภทสถานที่ (Location type)", "Location type"],
    rooms: ["ห้องที่ใช้งาน (Rooms)", "Rooms"],
    area_sqm: ["พื้นที่ กี่ ตรม. (sq m.)", "sq m."],
    room_count: ["จำนวนกี่ห้อง"],
    floor_type: ["ประเภทพื้นอาคาร (Floor type)", "Floor type"],
    activity_type: ["วิธีการติดต่อ"],
    last_contact_date: ["วันที่ติดตามล่าสุด"],
    followup_count: ["จำนวนการติดตาม (ต้องครบ 3 ครั้ง)"],
    next_follow_up: ["Next_Step_Date"],
    next_step_note: ["Next_Step"],
    status: ["Stage"],
    closed_date: ["Close won Date"],
    product_model: ["Product_Model"],
    reason: ["Reason"],
    audio_link: ["ไฟล์เสียง"],
    priority: ["priority 1-3", "piority 1-3", "priority", "piority"],
    notes: ["Notes"],
    extra_note: ["Column 23"],
    month: ["Month"],
};

const CRM1_LAYOUTS = [
    {
        id: "crm1_priority_leads",
        sheetName: "IMPORT_RAW_CRM1",
        structureMode: "row1_header",
        defaultSourceBlock: DEFAULT_CRM1_SOURCE_BLOCK,
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
    },
    {
        id: "crm1_lead_new",
        sheetName: "IMPORT_RAW_CRM1_LEAD_NEW",
        structureMode: "row1_header",
        defaultSourceBlock: "Lead New",
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
    },
    {
        id: "crm1_close_won",
        sheetName: "IMPORT_RAW_CRM1_CLOSE_WON",
        structureMode: "row1_header",
        defaultSourceBlock: "Close Won & ส่งแบบสอบถาม",
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
    },
    {
        id: "crm1_installation",
        sheetName: "IMPORT_RAW_CRM1_INSTALLATION",
        structureMode: "row1_header",
        defaultSourceBlock: "งานติดตั้ง",
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
    },
];

const CRM1_IMPORT_MARKERS = [
    { canonical: "Priority Leads", aliases: ["priority leads", "piority leads"] },
    { canonical: "Lead New", aliases: ["lead new"] },
    { canonical: "Close Won & ส่งแบบสอบถาม", aliases: ["close won", "close won & ส่งแบบสอบถาม"] },
    { canonical: "งานติดตั้ง", aliases: ["งานติดตั้ง"] },
];

const CRM1_SKIP_MARKER_PATTERNS = [
    "pivot leads",
    "reason (update)",
    "stage",
    "reason",
    "summary",
    "pivot",
    "report",
    "config",
];

const CRM1_FALLBACK_FIELD_ALIASES = {
    customer_name: ["ชื่อลูกค้า", "Customer name", "ชื่อ LINE", "ชื่อ LINE / FB", "ชื่อลูกค้า + ชื่อ LINE / FB (Customer name)", "Name"],
    phone: ["เบอร์ติดต่อ", "Tel", "Tel.", "Phone", "เบอร์ติดต่อ (Tel.)"],
    source: ["ช่องทางการขาย", "Sales Channel", "Sales channel"],
    customer_type: ["ประเภทลูกค้า", "Customer type"],
    location_type: ["ประเภทสถานที่", "Location type"],
    rooms: ["ห้องที่ใช้งาน", "Rooms"],
    area: ["พื้นที่ ตรม.", "sq m."],
    stage: ["Stage", "สถานะ"],
    reason: ["Reason", "เหตุผลยกเลิก"],
    note: ["Notes", "Note", "Column 23", "Next_Step", "Next Step"],
    month: ["Month"],
    contact_method: ["วิธีการติดต่อ"],
    last_contact_date: ["วันที่ติดตามล่าสุด", "Last Contact Date"],
    follow_up_count: ["จำนวนการติดตาม", "จำนวนการติดตาม (ต้องครบ 3 ครั้ง)"],
    next_step_date: ["Next_Step_Date"],
    next_step: ["Next_Step"],
    audio: ["ไฟล์เสียง", "Audio", "Audio URL", "Call Recording", "Recording"],
    product_model: ["Product_Model", "Product Model", "ผลิตภัณฑ์"],
    device_count: ["จำนวนเครื่องที่ติดตั้ง", "Device for setup"],
    payment_date: ["วันที่ชำระเงิน", "Date Payment"],
    payment_slip_url: ["หลักฐานการชำระ", "Link Slip"],
    price: ["ยอดชำระ", "Price"],
    install_date: ["วันที่ติดตั้ง", "Set up date"],
    install_time: ["ช่วงเวลา"],
    install_status: ["สถานะติดตั้ง", "สถานะ"],
    address: ["สถานที่ติดตั้ง + ลิงค์โลเคชั่น", "สถานที่ติดตั้ง + จังหวัด", "Location", "Address"],
    province: ["จังหวัด"],
    zone: ["โซนพื้นที่"],
    cancel_reason: ["เหตุผลยกเลิก"],
};

function normalizeCrm1MarkerText(value) {
    return normalizeImportText(value)
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

function normalizeHeaderForMatch(value) {
    return normalizeImportText(value)
        .replace(/[\r\n]+/g, " ")
        .replace(/[().]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matchCrm1ImportMarker(value) {
    const normalized = normalizeCrm1MarkerText(value);
    if (!normalized) return null;

    for (const marker of CRM1_IMPORT_MARKERS) {
        for (const alias of marker.aliases) {
            const normalizedAlias = normalizeCrm1MarkerText(alias);

            if (normalized === normalizedAlias) {
                return {
                    matchedAs: marker.canonical,
                    matchReason: alias === marker.canonical.toLowerCase() ? "exact" : "alias",
                    confidence: 1,
                };
            }

            if (normalized.includes(normalizedAlias)) {
                return {
                    matchedAs: marker.canonical,
                    matchReason: "contains_alias",
                    confidence: 0.95,
                };
            }
        }
    }

    return null;
}

function matchCrm1SkippedMarker(value) {
    const marker = normalizeCrm1MarkerText(value);
    if (!marker) return null;

    const matched = CRM1_SKIP_MARKER_PATTERNS.find(pattern => marker.includes(normalizeCrm1MarkerText(pattern)));
    return matched
        ? { matchedAs: matched, matchReason: "skip_pattern", confidence: 0.9 }
        : null;
}

function matchCrm1AnyMarker(value) {
    const importMatch = matchCrm1ImportMarker(value);
    if (importMatch) return { ...importMatch, type: "import" };

    const skipMatch = matchCrm1SkippedMarker(value);
    if (skipMatch) return { ...skipMatch, type: "skip" };

    return null;
}

function headerMatchesAlias(headerText, alias) {
    const header = normalizeHeaderForMatch(headerText);
    const aliasText = normalizeHeaderForMatch(alias);

    if (!header || !aliasText) return false;
    return header === aliasText || header.includes(aliasText) || aliasText.includes(header);
}

function findHeaderMatches(headers, fieldName, layout) {
    const aliases = layout?.headers?.[fieldName] || CRM1_FALLBACK_FIELD_ALIASES[fieldName] || [];
    const matches = [];

    headers.forEach((headerText, index) => {
        const text = String(headerText || "").trim();
        if (!text) return;

        let matchedAlias = aliases.find(alias => headerMatchesAlias(text, alias));
        let matchReason = "alias";

        if (!matchedAlias && fieldName === "priority") {
            const normalizedHeader = normalizeHeaderForMatch(text);

            if (normalizedHeader.includes("priority") || normalizedHeader.includes("piority")) {
                matchedAlias = normalizedHeader.includes("piority") ? "piority" : "priority";
                matchReason = "priority_keyword_fallback";
            }
        }

        if (!matchedAlias) return;

        const normalizedHeader = normalizeHeaderForMatch(text);
        const normalizedAlias = normalizeHeaderForMatch(matchedAlias);

        matches.push({
            field_name: fieldName,
            column_index: index + 1,
            zero_based_index: index,
            header_text: text,
            matched_alias: matchedAlias,
            match_type: matchReason === "priority_keyword_fallback"
                ? matchReason
                : normalizedHeader === normalizedAlias ? "exact" : "contains",
        });
    });

    return matches.sort((a, b) => {
        if (a.match_type === b.match_type) return a.column_index - b.column_index;
        return a.match_type === "exact" ? -1 : 1;
    });
}

function buildHeaderMap(headers) {
    return buildHeaderMapForLayout(headers, { headers: CRM1_FALLBACK_FIELD_ALIASES });
}

function buildHeaderMapForLayout(headers, layout) {
    const mappedHeaders = [];
    const headerMap = {};

    for (const fieldName of Object.keys(layout.headers || {})) {
        const matches = findHeaderMatches(headers, fieldName, layout);
        if (!matches.length) continue;

        headerMap[fieldName] = matches[0];
        mappedHeaders.push(matches[0]);

        if (fieldName === "audio" || fieldName === "audio_link") {
            headerMap.audio_all = matches;
        }
    }

    return { headerMap, mappedHeaders };
}

function getCrm1Value(row, headerMap, fieldName) {
    const match = headerMap[fieldName];
    if (!match) return "";
    return String(row?.[match.zero_based_index] || "").trim();
}

function normalizeCrm1Phone(rawPhone) {
    const digits = String(rawPhone || "").replace(/\D/g, "");
    if (/^0\d{9}$/.test(digits)) return digits;
    if (/^[689]\d{8}$/.test(digits)) return `0${digits}`;
    return "";
}

function buildCrm1Notes(row, headerMap) {
    const noteFields = [
        ["Next Step", "next_step_note"],
        ["Notes", "notes"],
        ["Column 23", "extra_note"],
        ["Customer Type", "customer_type"],
        ["Location Type", "location_type"],
        ["Rooms", "rooms"],
        ["Area sqm", "area_sqm"],
        ["Room Count", "room_count"],
        ["Floor Type", "floor_type"],
        ["Follow-up Count", "followup_count"],
        ["Month", "month"],
    ];
    const parts = [];

    for (const [label, fieldName] of noteFields) {
        const value = getCrm1Value(row, headerMap, fieldName);
        if (value) parts.push(`${label}: ${value}`);
    }

    return parts.join("\n");
}

function findNextNonEmptyRowIndex(rows, startIndex) {
    for (let i = startIndex; i < rows.length; i++) {
        if (rowHasAnyValue(rows[i])) return i;
    }

    return -1;
}

function buildMarkerDetectionDebug(rows) {
    const debug = [];

    for (let i = 0; i < rows.length && debug.length < 50; i++) {
        const marker = String(rows[i]?.[0] || "").trim();
        if (!marker) continue;

        const normalizedMarker = normalizeCrm1MarkerText(marker);
        const markerMatch = matchCrm1AnyMarker(marker);

        debug.push({
            row: i + 1,
            col_a: marker,
            raw_marker: marker,
            normalized_col_a: normalizedMarker,
            normalized_marker: normalizedMarker,
            detected_marker: Boolean(markerMatch),
            import_marker: markerMatch?.type === "import",
            skipped_marker: markerMatch?.type === "skip",
            matched_as: markerMatch?.matchedAs || "",
            match_reason: markerMatch?.matchReason || "",
            marker_match_strategy: markerMatch?.matchReason || "none",
            marker_match_confidence: markerMatch?.confidence || 0,
        });
    }

    return debug;
}

function buildCrm1Blocks(rows, layout) {
    const markerDetectionDebug = buildMarkerDetectionDebug(rows);
    const firstCell = String(rows[0]?.[0] || "").trim();
    const firstCellMarker = matchCrm1AnyMarker(firstCell);

    if (layout?.structureMode === "row1_header" || !firstCellMarker) {
        return {
            parsedBlocks: [{
                marker: layout?.defaultSourceBlock || DEFAULT_CRM1_SOURCE_BLOCK,
                normalizedMarker: layout?.defaultSourceBlock || DEFAULT_CRM1_SOURCE_BLOCK,
                markerMatch: { matchedAs: layout?.defaultSourceBlock || DEFAULT_CRM1_SOURCE_BLOCK, matchReason: "default_row_1_header", confidence: 1, type: "import" },
                markerRow: null,
                headerRow: 1,
                headers: rows[0] || [],
                dataRows: rows.slice(1).map((row, index) => ({
                    rowNumber: index + 2,
                    row: row || [],
                })),
            }],
            skippedBlocks: [],
            markerDetectionDebug,
            structureMode: "row_1_header",
        };
    }

    const parsedBlocks = [];
    const skippedBlocks = [];

    for (let i = 0; i < rows.length; i++) {
        const marker = String(rows[i]?.[0] || "").trim();
        const markerMatch = matchCrm1AnyMarker(marker);
        if (!markerMatch) continue;

        const headerIndex = findNextNonEmptyRowIndex(rows, i + 1);

        if (headerIndex === -1) {
            skippedBlocks.push({
                marker,
                marker_row: i + 1,
                reason: "missing_header_row",
            });
            break;
        }

        const block = {
            marker,
            normalizedMarker: markerMatch.matchedAs,
            markerMatch,
            markerRow: i + 1,
            headerRow: headerIndex + 1,
            headers: rows[headerIndex] || [],
            dataRows: [],
        };

        let j = headerIndex + 1;
        for (; j < rows.length; j++) {
            const nextMarker = String(rows[j]?.[0] || "").trim();
            if (nextMarker && matchCrm1AnyMarker(nextMarker)) break;
            block.dataRows.push({
                rowNumber: j + 1,
                row: rows[j] || [],
            });
        }

        if (markerMatch.type === "import") {
            parsedBlocks.push(block);
        } else {
            skippedBlocks.push({
                marker,
                marker_row: block.markerRow,
                reason: "ignored_block_type",
                matched_as: markerMatch.matchedAs,
                match_reason: markerMatch.matchReason,
            });
        }

        i = j - 1;
    }

    return { parsedBlocks, skippedBlocks, markerDetectionDebug, structureMode: "marker_blocks" };
}

function detectCrm1Audio(row, headerMap, sourceBlock, sourceRow, normalizedPhone) {
    const items = [];
    const audioHeaders = headerMap.audio_all || (headerMap.audio ? [headerMap.audio] : []);

    for (const header of audioHeaders) {
        const raw = String(row?.[header.zero_based_index] || "").trim();
        if (!raw) continue;

        const urls = extractUrls(raw);
        if (urls.length) {
            urls.forEach(url => items.push({
                source_block: sourceBlock,
                source_row: sourceRow,
                normalized_phone: normalizedPhone,
                audio_url: url,
                audio_file_name: "",
                detected_from_header: header.header_text,
            }));
            continue;
        }

        items.push({
            source_block: sourceBlock,
            source_row: sourceRow,
            normalized_phone: normalizedPhone,
            audio_url: "",
            audio_file_name: raw,
            detected_from_header: header.header_text,
        });
    }

    return items;
}

function detectedHeaderDebug(headerMap, fieldName) {
    const match = headerMap[fieldName];
    if (!match) return null;

    return {
        field_name: fieldName,
        column_index: match.column_index,
        header_text: match.header_text,
    };
}

function normalizeCrm1Status(status, mappingRules) {
    const raw = String(status || "").trim();
    if (!raw) return "New";
    return normalizeByMappingRules(mappingRules, "lead_status", raw) || raw;
}

function normalizeCrm1Priority(value) {
    const raw = String(value || "").trim();
    return /^[123]$/.test(raw) ? Number(raw) : "";
}

function logCrm1LeadMainWrite(headers, object, record, action, rowNumber = "") {
    const rowData = googleSheets.objectToRow(headers, object);

    console.log("CRM1 WRITE ROW:", rowData);
    console.log("customer_type:", record.customerType);
    console.log("followup_count:", record.followUpCount);
    console.log("CRM1 WRITE META:", {
        action,
        rowNumber,
        lead_id: object.lead_id || "",
        phone: object.phone || record.normalizedPhone || "",
    });
}

function logCrm1ActivityWrite(headers, object, record) {
    const activityRowData = googleSheets.objectToRow(headers, object);

    console.log("CRM1 ACTIVITY ROW:", activityRowData);
    console.log("activity followup_count:", record.followUpCount);
}

function buildCrm1LeadObject(record, leadId, existingLeadObject = null) {
    if (!existingLeadObject) {
        return {
            lead_id: leadId,
            open_deal: false,
            save_follow_up: false,
            customer_name: record.customerName,
            phone: record.normalizedPhone,
            source: record.normalizedSource || "Facebook",
            lead_status: "Legacy Import",
            status: "Legacy Import",
            customer_type: record.customerType,
            latest_audio_link: record.audioLink,
            last_contact_date: record.lastContactDate,
            next_follow_up: record.nextStepDate,
            rated_follow_up_no: record.followUpCount,
            note: record.note,
            created_at: record.now,
            updated_at: record.now,
        };
    }

    const object = { updated_at: record.now };
    const putIfPresent = (key, value) => {
        if (String(value || "").trim()) object[key] = value;
    };
    const putIfExistingBlank = (key, value) => {
        if (!String(existingLeadObject?.[key] || "").trim() && String(value || "").trim()) {
            object[key] = value;
        }
    };

    putIfExistingBlank("customer_name", record.customerName);
    putIfExistingBlank("lead_id", leadId);
    putIfExistingBlank("phone", record.normalizedPhone);
    putIfExistingBlank("source", record.normalizedSource || "Facebook");
    putIfPresent("lead_status", "Legacy Import");
    putIfPresent("status", "Legacy Import");
    putIfPresent("customer_type", record.customerType);
    putIfPresent("latest_audio_link", record.audioLink);
    putIfPresent("last_contact_date", record.lastContactDate);
    putIfPresent("next_follow_up", record.nextStepDate);
    putIfPresent("rated_follow_up_no", record.followUpCount);
    putIfPresent("note", record.note);

    return object;
}

function buildCrm1LeadDetailObject(record, leadId) {
    return {
        lead_id: leadId,
        customer_type: record.customerType,
        location_type: record.locationType,
        rooms: record.rooms,
        area_sqm: record.areaSqm,
        room_count: record.roomCount,
        floor_type: record.floorType,
        product_model: record.productModel,
        reason: record.reason,
        priority: record.priority,
        month: record.month,
        original_stage: record.stage,
        original_source_row: record.sourceRow,
        source_block: record.sourceBlock,
        legacy_notes: record.note,
        raw_data_json: JSON.stringify(record.rawObject),
        import_source: "CRM1 Legacy Import",
    };
}

function buildCrm1ActivityObject(record, leadId) {
    const activityType = record.activityType || "Import Note";
    const activityDate = record.lastContactDate || record.now;

    return {
        activity_id: generateImportId("ACT"),
        lead_id: leadId,
        follow_up_no: record.followUpCount || "",
        followup_no: record.followUpCount || "",
        rated_follow_up_no: record.followUpCount || "",
        action_type: activityType,
        activity_type: activityType,
        result: record.leadStatus,
        activity_result: record.leadStatus,
        note: record.note,
        audio_url: record.audioLink,
        audio_link: record.audioLink,
        created_at: record.now,
        activity_date: activityDate,
        created_by: "CRM1 Import",
    };
}

function getActivitySignature(activityObject) {
    return [
        String(activityObject.lead_id || "").trim(),
        String(activityObject.note || "").trim(),
        String(activityObject.audio_url || activityObject.audio_link || "").trim(),
        String(activityObject.activity_date || activityObject.created_at || "").trim(),
    ].join("|");
}

async function handleLegacyCrm1Import(req, res) {
    const dryRun = parseDryRunParam(req);
    const requestedLayoutId = String(req.query.layout || "").trim();

    try {
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
        const candidateLayouts = requestedLayoutId
            ? CRM1_LAYOUTS.filter(layout => layout.id === requestedLayoutId)
            : CRM1_LAYOUTS;
        const candidateSheetNames = candidateLayouts.map(layout => layout.sheetName);
        const rawSheet = await readFirstAvailableSheet(googleSheets, sheets, spreadsheetId, candidateSheetNames);
        const layout = candidateLayouts.find(item => item.sheetName === rawSheet.sheetName) || CRM1_LAYOUTS[0];
        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];
        const detailRows = await googleSheets.getSheetRows("LEAD_DETAILS");
        const detailHeaders = detailRows[0] || [];
        const activityRows = await googleSheets.getSheetRows("ACTIVITY_LOG");
        const activityHeaders = activityRows[0] || [];
        const mappingRules = await loadMappingRules(googleSheets);
        const { parsedBlocks, skippedBlocks, markerDetectionDebug, structureMode } = buildCrm1Blocks(rawSheet.rows, layout);
        const primaryBlock = parsedBlocks[0] || null;
        const primaryHeaderInfo = primaryBlock ? buildHeaderMapForLayout(primaryBlock.headers, layout) : { headerMap: {}, mappedHeaders: [] };
        const missingRequiredHeaders = (layout.requiredFields || [])
            .filter(fieldName => !primaryHeaderInfo.headerMap[fieldName])
            .map(fieldName => ({
                field_name: fieldName,
                accepted_headers: layout.headers[fieldName] || [],
            }));
        const sourceSheetRowCount = rawSheet.rows.length;
        const sourceSheetColCount = rawSheet.rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
        const first20ColAValues = rawSheet.rows.slice(0, 20).map((row, index) => ({
            row: index + 1,
            value: String(row?.[0] || ""),
            normalized_value: normalizeCrm1MarkerText(row?.[0] || ""),
        }));
        const first5RowsPreview = rawSheet.rows.slice(0, 5).map((row, index) => ({
            row: index + 1,
            values: (row || []).slice(0, 12),
        }));
        const knownLeadsByPhone = new Map();
        const queuedPhones = new Set();
        const samplePreviewItems = [];
        const sampleAudioItems = [];
        const sampleImportedItems = [];
        const failedRowSamples = [];
        const parsedRecords = [];
        const knownLeadDetailsByLeadId = new Map();
        const existingActivitySignatures = new Set();

        let totalRows = 0;
        let rowsWithValidPhone = 0;
        let rowsMissingPhone = 0;
        let wouldCreateLead = 0;
        let wouldUpdateExistingLead = 0;
        let wouldCreateDeal = 0;
        let wouldCreateInstallation = 0;
        let wouldCreateActivity = 0;
        let audioUrlsDetected = 0;
        let audioFileNamesDetected = 0;
        let failedRows = 0;
        let insertedLeads = 0;
        let updatedExistingLeads = 0;
        let createdActivities = 0;
        let skippedDuplicateActivities = 0;

        if (missingRequiredHeaders.length) {
            return res.status(400).json({
                success: false,
                dry_run: dryRun,
                parsed_dry_run: dryRun,
                crm1_layout_id: layout.id,
                source_sheet_name: rawSheet.sheetName,
                source_sheet_found: true,
                structure_mode: structureMode,
                header_row_detected: primaryBlock?.headerRow || null,
                mapped_headers: primaryHeaderInfo.mappedHeaders,
                header_map_debug: primaryHeaderInfo.mappedHeaders,
                missing_required_headers: missingRequiredHeaders,
                customer_name_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "customer_name"),
                phone_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "phone"),
                source_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "source"),
                note_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "notes") || detectedHeaderDebug(primaryHeaderInfo.headerMap, "next_step_note"),
                audio_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "audio_link"),
                error: "Missing required CRM1 headers",
            });
        }

        for (let i = 2; i < leadsRows.length; i++) {
            const leadObject = googleSheets.rowToObject(leadHeaders, leadsRows[i]);
            const existingPhone = normalizeCrm1Phone(leadObject.phone);
            if (!existingPhone) continue;
            knownLeadsByPhone.set(existingPhone, { ...leadObject, rowNumber: i + 1 });
        }

        for (let i = 2; i < detailRows.length; i++) {
            const detailObject = googleSheets.rowToObject(detailHeaders, detailRows[i]);
            const leadId = String(detailObject.lead_id || "").trim();
            if (!leadId) continue;
            knownLeadDetailsByLeadId.set(leadId, { ...detailObject, rowNumber: i + 1 });
        }

        for (let i = 2; i < activityRows.length; i++) {
            const activityObject = googleSheets.rowToObject(activityHeaders, activityRows[i]);
            existingActivitySignatures.add(getActivitySignature(activityObject));
        }

        for (const block of parsedBlocks) {
            const { headerMap } = buildHeaderMapForLayout(block.headers, layout);

            for (const dataRow of block.dataRows) {
                if (!rowHasAnyValue(dataRow.row)) continue;

                totalRows++;

                try {
                    const customerName = getCrm1Value(dataRow.row, headerMap, "customer_name");
                    const phone = getCrm1Value(dataRow.row, headerMap, "phone");
                    const source = getCrm1Value(dataRow.row, headerMap, "source");
                    const customerType = getCrm1Value(dataRow.row, headerMap, "customer_type");
                    const locationType = getCrm1Value(dataRow.row, headerMap, "location_type");
                    const rooms = getCrm1Value(dataRow.row, headerMap, "rooms");
                    const areaSqm = getCrm1Value(dataRow.row, headerMap, "area_sqm");
                    const roomCount = getCrm1Value(dataRow.row, headerMap, "room_count");
                    const floorType = getCrm1Value(dataRow.row, headerMap, "floor_type");
                    const month = getCrm1Value(dataRow.row, headerMap, "month");
                    const stage = getCrm1Value(dataRow.row, headerMap, "status");
                    const rawReason = getCrm1Value(dataRow.row, headerMap, "reason");
                    const note = buildCrm1Notes(dataRow.row, headerMap);
                    const rawProvince = getCrm1Value(dataRow.row, headerMap, "province");
                    const rawZone = getCrm1Value(dataRow.row, headerMap, "zone");
                    const productModel = getCrm1Value(dataRow.row, headerMap, "product_model");
                    const deviceCount = "";
                    const paymentDate = getCrm1Value(dataRow.row, headerMap, "payment_date");
                    const paymentSlipUrl = getCrm1Value(dataRow.row, headerMap, "payment_slip_url");
                    const price = "";
                    const installDateRaw = "";
                    const installTime = "";
                    const installStatus = "";
                    const address = "";
                    const lastContactDateRaw = getCrm1Value(dataRow.row, headerMap, "last_contact_date");
                    const nextStepDateRaw = getCrm1Value(dataRow.row, headerMap, "next_follow_up");
                    const contactMethod = getCrm1Value(dataRow.row, headerMap, "activity_type");
                    const followUpCount = getCrm1Value(dataRow.row, headerMap, "followup_count");
                    const priority = normalizeCrm1Priority(getCrm1Value(dataRow.row, headerMap, "priority"));
                    const audioLink = getCrm1Value(dataRow.row, headerMap, "audio_link");
                    const normalizedPhone = normalizeCrm1Phone(phone);

                    if (!normalizedPhone) {
                        rowsMissingPhone++;
                        if (failedRowSamples.length < 10) {
                            failedRowSamples.push({
                                source_block: block.marker,
                                source_row: dataRow.rowNumber,
                                reason: "missing_or_invalid_phone",
                            });
                        }
                        continue;
                    }

                    rowsWithValidPhone++;

                    const provinceResult = normalizeLegacyProvince(rawProvince, mappingRules);
                    const explicitZone = normalizeByMappingRules(mappingRules, "zone", rawZone);
                    const derivedZone = normalizeLegacyZone(provinceResult.province, mappingRules);
                    const zone = explicitZone || derivedZone;
                    const normalizedSource = mapLegacySource(source || layout.defaultSource || block.normalizedMarker || block.marker, mappingRules);
                    const leadStatus = normalizeCrm1Status(stage, mappingRules);
                    const reason = mapLegacyReason(rawReason || stage, mappingRules);
                    const installDate = parseLegacyDateValue(installDateRaw).value;
                    const lastContactDate = parseLegacyDateValue(lastContactDateRaw).value;
                    const nextStepDate = parseLegacyDateValue(nextStepDateRaw).value;
                    const audioItems = detectCrm1Audio(dataRow.row, headerMap, block.marker, dataRow.rowNumber, normalizedPhone);
                    const hasDealData = hasAnyValue({ productModel, deviceCount, paymentDate, paymentSlipUrl, price });
                    const hasInstallationData = hasAnyValue({ installDate, installTime, installStatus, address, zone });
                    const hasActivityData = hasAnyValue({ contactMethod, lastContactDate, nextStepDate, note, followUpCount }) || audioItems.length > 0;
                    const existingLeadObject = knownLeadsByPhone.get(normalizedPhone);
                    const duplicateQueued = queuedPhones.has(normalizedPhone);
                    const wouldUpdate = Boolean(existingLeadObject || duplicateQueued);

                    if (wouldUpdate) wouldUpdateExistingLead++;
                    else {
                        wouldCreateLead++;
                        queuedPhones.add(normalizedPhone);
                    }

                    if (hasDealData) wouldCreateDeal++;
                    if (hasInstallationData) wouldCreateInstallation++;
                    if (hasActivityData) wouldCreateActivity++;

                    audioItems.forEach(item => {
                        if (item.audio_url) audioUrlsDetected++;
                        if (item.audio_file_name) audioFileNamesDetected++;
                        if (sampleAudioItems.length < 20) sampleAudioItems.push(item);
                    });

                    const record = {
                        sourceBlock: block.marker,
                        sourceRow: dataRow.rowNumber,
                        originalPhone: phone,
                        normalizedPhone,
                        customerName,
                        normalizedSource,
                        leadStatus,
                        stage,
                        reason,
                        note,
                        customerType,
                        locationType,
                        rooms,
                        areaSqm,
                        roomCount,
                        floorType,
                        month,
                        rawProvince,
                        province: provinceResult.province,
                        zone,
                        productModel,
                        paymentDate,
                        paymentSlipUrl,
                        lastContactDate,
                        nextStepDate,
                        activityType: contactMethod,
                        followUpCount,
                        priority,
                        audioLink,
                        hasActivityData,
                        existingLeadObject,
                        wouldUpdate,
                        rawObject: {
                            headers: block.headers,
                            row: dataRow.row,
                        },
                        now: formatLegacyDateForSheet(new Date()),
                    };
                    parsedRecords.push(record);

                    if (samplePreviewItems.length < 30) {
                        samplePreviewItems.push({
                            source_block: block.marker,
                            source_row: dataRow.rowNumber,
                            original_phone: phone,
                            normalized_phone: normalizedPhone,
                            customer_name: customerName,
                            lead_status: leadStatus,
                            source: normalizedSource,
                            province: provinceResult.province,
                            zone,
                            customer_type: customerType,
                            product_model: productModel,
                            install_date: installDate,
                            install_status: installStatus,
                            stage,
                            reason,
                            next_follow_up: nextStepDate,
                            audio_link: audioLink,
                            priority,
                            note_preview: note,
                            would_create_lead: !wouldUpdate,
                            would_create_deal: hasDealData,
                            would_create_installation: hasInstallationData,
                            would_create_activity: hasActivityData,
                        });
                    }
                } catch (err) {
                    failedRows++;
                    if (failedRowSamples.length < 10) {
                        failedRowSamples.push({
                            source_block: block.marker,
                            source_row: dataRow.rowNumber,
                            reason: err.message,
                        });
                    }
                }
            }
        }

        if (!dryRun) {
            const leadCreates = [];
            const leadUpdates = [];
            const detailCreates = [];
            const detailUpdates = [];
            const activityCreates = [];
            const failedCreatedLeadIds = new Set();

            for (const record of parsedRecords) {
                try {
                    let leadId = record.existingLeadObject?.lead_id || "";
                    const currentLead = knownLeadsByPhone.get(record.normalizedPhone);
                    const existingLead = currentLead?.rowNumber ? currentLead : record.existingLeadObject;

                    if (!leadId && currentLead?.lead_id) leadId = currentLead.lead_id;
                    if (!leadId) leadId = generateImportId("LEAD");

                    if (existingLead?.rowNumber) {
                        leadUpdates.push({
                            rowNumber: existingLead.rowNumber,
                            object: buildCrm1LeadObject(record, leadId, existingLead),
                            record,
                        });
                        updatedExistingLeads++;
                    } else if (currentLead && !currentLead.rowNumber) {
                        leadId = currentLead.lead_id;
                    } else {
                        leadId = generateImportId("LEAD");
                        const leadObject = buildCrm1LeadObject(record, leadId);
                        leadCreates.push({ object: leadObject, record });
                        knownLeadsByPhone.set(record.normalizedPhone, { ...leadObject, rowNumber: null });
                        insertedLeads++;
                    }

                    const detailObject = buildCrm1LeadDetailObject(record, leadId);
                    const existingDetail = knownLeadDetailsByLeadId.get(leadId);
                    if (existingDetail?.rowNumber) {
                        detailUpdates.push({ rowNumber: existingDetail.rowNumber, object: detailObject });
                    } else if (!existingDetail) {
                        detailCreates.push(detailObject);
                        knownLeadDetailsByLeadId.set(leadId, { ...detailObject, rowNumber: null });
                    }

                    if (record.hasActivityData) {
                        const activityObject = buildCrm1ActivityObject(record, leadId);
                        const signature = getActivitySignature(activityObject);

                        if (existingActivitySignatures.has(signature)) {
                            skippedDuplicateActivities++;
                        } else {
                            activityCreates.push({ object: activityObject, record });
                            existingActivitySignatures.add(signature);
                            createdActivities++;
                        }
                    }

                    if (sampleImportedItems.length < 10) {
                        sampleImportedItems.push({
                            source_row: record.sourceRow,
                            lead_id: leadId,
                            normalized_phone: record.normalizedPhone,
                            customer_name: record.customerName,
                            action: existingLead?.rowNumber ? "updated_existing_lead" : "inserted_or_reused_lead",
                            created_activity: record.hasActivityData,
                        });
                    }
                } catch (err) {
                    failedRows++;
                    if (failedRowSamples.length < 10) {
                        failedRowSamples.push({
                            source_row: record.sourceRow,
                            normalized_phone: record.normalizedPhone,
                            reason: err.message,
                        });
                    }
                }
            }

            if (leadCreates.length) {
                try {
                    for (const entry of leadCreates) {
                        logCrm1LeadMainWrite(leadHeaders, entry.object, entry.record, "insert");
                    }
                    await googleSheets.appendObjects("LEADS_MAIN", leadCreates.map(entry => entry.object));
                } catch (err) {
                    for (const entry of leadCreates) {
                        try {
                            await googleSheets.appendObjects("LEADS_MAIN", [entry.object]);
                        } catch (rowErr) {
                            failedRows++;
                            insertedLeads--;
                            failedCreatedLeadIds.add(entry.object.lead_id);
                        }
                    }
                }
            }

            for (const update of leadUpdates) {
                try {
                    logCrm1LeadMainWrite(leadHeaders, update.object, update.record, "update", update.rowNumber);
                    await googleSheets.updateObjectRow("LEADS_MAIN", update.rowNumber, update.object);
                } catch (err) {
                    failedRows++;
                    updatedExistingLeads--;
                }
            }

            const detailCreatesToWrite = detailCreates.filter(detail => !failedCreatedLeadIds.has(detail.lead_id));
            if (detailCreatesToWrite.length) {
                try {
                    await googleSheets.appendObjects("LEAD_DETAILS", detailCreatesToWrite);
                } catch (err) {
                    for (const detailObject of detailCreatesToWrite) {
                        try {
                            await googleSheets.appendObjects("LEAD_DETAILS", [detailObject]);
                        } catch (rowErr) {
                            failedRows++;
                        }
                    }
                }
            }

            for (const update of detailUpdates) {
                try {
                    await googleSheets.updateObjectRow("LEAD_DETAILS", update.rowNumber, update.object);
                } catch (err) {
                    failedRows++;
                }
            }

            const activityCreatesToWrite = activityCreates.filter(entry => !failedCreatedLeadIds.has(entry.object.lead_id));
            if (activityCreatesToWrite.length) {
                try {
                    for (const entry of activityCreatesToWrite) {
                        logCrm1ActivityWrite(activityHeaders, entry.object, entry.record);
                    }
                    await googleSheets.appendObjects("ACTIVITY_LOG", activityCreatesToWrite.map(entry => entry.object));
                } catch (err) {
                    for (const entry of activityCreatesToWrite) {
                        try {
                            await googleSheets.appendObjects("ACTIVITY_LOG", [entry.object]);
                        } catch (rowErr) {
                            failedRows++;
                            createdActivities--;
                        }
                    }
                }
            }
        }

        return res.status(200).json({
            success: true,
            dry_run: dryRun,
            parsed_dry_run: dryRun,
            crm1_layout_id: layout.id,
            source_sheet_name: rawSheet.sheetName,
            source_sheet_found: true,
            source_sheet_row_count: sourceSheetRowCount,
            source_sheet_col_count: sourceSheetColCount,
            first_20_col_a_values: first20ColAValues,
            first_5_rows_preview: first5RowsPreview,
            marker_detection_debug: markerDetectionDebug,
            structure_mode: structureMode,
            header_row_detected: primaryBlock?.headerRow || null,
            header_map_debug: primaryHeaderInfo.mappedHeaders,
            mapped_headers: primaryHeaderInfo.mappedHeaders,
            missing_required_headers: missingRequiredHeaders,
            customer_name_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "customer_name"),
            phone_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "phone"),
            source_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "source"),
            note_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "notes") || detectedHeaderDebug(primaryHeaderInfo.headerMap, "next_step_note"),
            audio_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "audio_link"),
            real_import_implemented: true,
            total_blocks_detected: parsedBlocks.length + skippedBlocks.length,
            parsed_blocks: parsedBlocks.length,
            parsed_block_details: parsedBlocks.map(block => ({
                marker: block.marker,
                matched_as: block.normalizedMarker,
                match_reason: block.markerMatch.matchReason,
                marker_match_confidence: block.markerMatch.confidence,
                marker_row: block.markerRow,
                header_row: block.headerRow,
                data_rows: block.dataRows.filter(item => rowHasAnyValue(item.row)).length,
            })),
            skipped_blocks: skippedBlocks.length,
            total_rows: totalRows,
            rows_with_valid_phone: rowsWithValidPhone,
            rows_missing_phone: rowsMissingPhone,
            would_create_lead: wouldCreateLead,
            would_update_existing_lead: wouldUpdateExistingLead,
            would_create_deal: wouldCreateDeal,
            would_create_installation: wouldCreateInstallation,
            would_create_activity: wouldCreateActivity,
            audio_urls_detected: audioUrlsDetected,
            audio_file_names_detected: audioFileNamesDetected,
            failed_rows: failedRows,
            inserted_leads: insertedLeads,
            updated_existing_leads: updatedExistingLeads,
            created_activities: createdActivities,
            skipped_duplicate_activities: skippedDuplicateActivities,
            skipped_invalid_phone: rowsMissingPhone,
            mapping_rules_loaded: mappingRules.loadedCount,
            mapping_rule_types_loaded: mappingRules.ruleTypes,
            sample_preview_items: samplePreviewItems,
            sample_imported_items: sampleImportedItems,
            sample_audio_items: sampleAudioItems,
            skipped_block_details: skippedBlocks,
            failed_row_samples: failedRowSamples,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: dryRun,
            parsed_dry_run: dryRun,
            source_sheet_name: "IMPORT_RAW_CRM1",
            source_sheet_found: false,
            error: err.message,
        });
    }
}

module.exports = { handleLegacyCrm1Import };
