const googleSheets = require("../googleSheets");
const {
    parseDryRunParam,
    normalizeImportText,
    normalizeByMappingRules,
    mapLegacySource,
    mapLegacyReason,
    normalizeLegacyLeadStatusValue,
    normalizeLegacyProvince,
    normalizeLegacyZone,
    parseLegacyDateValue,
    formatLegacyDateForSheet,
    loadMappingRules,
    readFirstAvailableSheet,
    rowHasAnyValue,
    hasAnyValue,
    extractUrls,
    normalizePaymentSlipLink,
    generateImportId,
} = require("./importUtils");

const DEFAULT_CRM1_SOURCE_BLOCK = "Priority Leads";
const DEFAULT_CRM1_MAX_ACTIVITIES_PER_RUN = 100;
const DEFAULT_CRM1_TIMEOUT_MS = 60000;
const DEBUG_CRM1_TIMEOUT_MS = 10000;
const CRM1_WRITE_SCOPES = new Set(["leads_only", "details_only", "activities_only", "installations_only", "all"]);
const CRM1_ROW_1_MARKER_PATTERNS = ["link close won", "close won", "open lead", "lead"];

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

const CRM1_LAYOUT_2_HEADERS = {
    form_link: ["ลิงค์กรอกฟอร์ม"],
    admin_name: ["ชื่อแอดมิน (Admin name)", "Admin name"],
    customer_name: ["ชื่อลูกค้า + ชื่อ LINE / FB (Customer name)", "Customer name"],
    phone: ["เบอร์ติดต่อ (Tel.)", "Tel."],
    source: ["ช่องทางการขาย (Sales Channel)", "Sales Channel"],
    customer_type: ["ประเภทลูกค้า (Customer type)", "Customer type"],
    location_type: ["ประเภทสถานที่ (Location type)", "Location type"],
    rooms: ["ห้องที่ใช้งาน (Rooms)", "Rooms"],
    area_sqm: ["พื้นที่ กี่ ตรม. (sq m.)", "sq m."],
    room_count: ["จำนวนกี่ห้อง"],
    floor_type: ["ประเภทพื้นอาคาร", "Floor type"],
    activity_type: ["วิธีการติดต่อ"],
    last_contact_date: ["วันที่ติดตามล่าสุด"],
    followup_count: ["จำนวนการติดตาม (ต้องครบ 3 ครั้ง)"],
    next_follow_up: ["Next_Step_Date"],
    next_step_note: ["Next_Step"],
    stage_raw: ["Stage"],
    stage: ["Stage"],
    reason_raw: ["Reason"],
    reason: ["Reason"],
    product_model: ["Product_Model"],
    closed_date: ["Close won Date"],
    audio_link: ["ไฟล์เสียง"],
    notes: ["Notes"],
    month: ["Month"],
};

const CRM1_LAYOUT_3_HEADERS = {
    form_link: ["Link_Close_won", "Link Close won", "Link_Close won"],
    admin_name: ["ชื่อแอดมิน (Admin name)", "Admin name"],
    customer_name: ["ชื่อลูกค้า + ชื่อ LINE / FB (Customer name)", "Customer name"],
    phone: ["เบอร์ติดต่อ (Tel.)", "Tel."],
    address: ["สถานที่ติดตั้ง + ลิงค์โลเคชั่น (Location)", "Location"],
    source: ["ช่องทางการขาย (Sales Channel)", "Sales Channel"],
    customer_type: ["ประเภทลูกค้า (Customer type)", "Customer type"],
    location_type: ["ประเภทสถานที่ (Location type)", "Location type"],
    product_model: ["ผลิตภัณฑ์ (Product Model)", "Product Model", "Product_Model"],
    device_count: ["จำนวนเครื่องที่ติดตั้ง (Device for setup)", "Device for setup"],
    install_date: ["วันที่ติดตั้ง (Set up date)", "Set up date"],
    price: ["ยอดชำระ (Price)", "Price"],
    payment_date: ["วันที่ชำระเงิน (Date Payment)", "Date Payment"],
    install_status: ["สถานะติดตั้ง"],
    outstanding_amount: ["ยอดที่ต้องชำระเพิ่ม (กรณีลูกค้าพรีออเดอร์)", "ยอดที่ต้องชำระเพิ่ม"],
    payment_slip_url: ["หลักฐานการชำระ (Link Slip)", "Link Slip"],
    after_sales_30_days: ["After sales 30 วัน", "After sales 30 days"],
    form_noti_date: ["วันที่ต้องส่ง Noti แบบสอบถาม"],
    form_status: ["Status การส่ง form"],
    notes: ["Note", "Notes"],
    month: ["Month"],
    week: ["Week"],
};

const CRM1_LAYOUT_4_HEADERS = {
    product_model: ["ผลิตภัณฑ์"],
    quantity: ["จำนวนเครื่องติดตั้ง"],
    install_date: ["วันนัดติดตั้ง", "วันที่ติดตั้ง", "วันติดตั้ง", "Set up date", "setup date"],
    time_slot: ["ช่วงเวลา"],
    technician: ["ชื่อทีมช่าง"],
    install_status: ["สถานะ"],
    cancel_reason: ["เหตุผลยกเลิก"],
    note: ["Note"],
    phone: ["เบอร์ติดต่อ (Tel.)", "Tel.", "Phone", "เบอร์ติดต่อ"],
    customer_name: ["ชื่อลูกค้า (ใส่ชื่อ LINE / FB)", "ชื่อลูกค้า + ชื่อ LINE / FB (Customer name)", "Customer name", "ชื่อลูกค้า"],
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
        realImportEnabled: true,
    },
    {
        id: "crm1_layout_2",
        sheetName: "IMPORT_RAW_CRM1",
        structureMode: "row1_header",
        defaultSourceBlock: "CRM1 Layout 2",
        defaultSource: "Facebook",
        headers: CRM1_LAYOUT_2_HEADERS,
        requiredFields: ["customer_name", "phone"],
        realImportEnabled: true,
    },
    {
        id: "crm1_layout_3",
        sheetName: "IMPORT_RAW_CRM1",
        structureMode: "row1_header",
        defaultSourceBlock: "CRM1 Layout 3",
        defaultSource: "Facebook",
        headers: CRM1_LAYOUT_3_HEADERS,
        requiredFields: ["customer_name", "phone"],
        realImportEnabled: true,
    },
    {
        id: "crm1_layout_4",
        sheetName: "IMPORT_RAW_CRM1",
        structureMode: "row1_header",
        defaultSourceBlock: "CRM1 Layout 4 Installation",
        defaultSource: "Legacy Import",
        headers: CRM1_LAYOUT_4_HEADERS,
        requiredFields: ["product_model", "install_date", "install_status"],
        realImportEnabled: true,
        updateExistingLeadOnly: true,
        skipLeadDetails: true,
        skipDeals: true,
    },
    {
        id: "crm1_lead_new",
        sheetName: "IMPORT_RAW_CRM1_LEAD_NEW",
        structureMode: "row1_header",
        defaultSourceBlock: "Lead New",
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
        realImportEnabled: true,
    },
    {
        id: "crm1_close_won",
        sheetName: "IMPORT_RAW_CRM1_CLOSE_WON",
        structureMode: "row1_header",
        defaultSourceBlock: "Close Won & ส่งแบบสอบถาม",
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
        realImportEnabled: true,
    },
    {
        id: "crm1_installation",
        sheetName: "IMPORT_RAW_CRM1_INSTALLATION",
        structureMode: "row1_header",
        defaultSourceBlock: "งานติดตั้ง",
        defaultSource: "Facebook",
        headers: CRM1_PRIORITY_LEADS_HEADERS,
        requiredFields: ["customer_name", "phone"],
        realImportEnabled: true,
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
        .replace(/[_-]+/g, " ")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

function detectCrm1Row1HeaderOffsetMarker(value) {
    const normalized = normalizeCrm1MarkerText(value);
    if (!normalized) return null;

    const matched = CRM1_ROW_1_MARKER_PATTERNS.find(pattern => normalized.includes(pattern));
    return matched
        ? {
            matchedAs: value,
            normalizedMarker: normalized,
            matchReason: "row_1_marker_contains",
            matchedPattern: matched,
            confidence: 0.95,
            type: "import",
        }
        : null;
}

function detectCrm1HeaderLayout(allRows, layout) {
    const rowOne = allRows.at(0) || [];
    const rowOneColumnA = String(rowOne[0] || "").trim();
    const rowOneMarker = ["crm1_layout_3", "crm1_layout_4"].includes(layout?.id)
        ? null
        : detectCrm1Row1HeaderOffsetMarker(rowOneColumnA);
    const headerRowDetected = rowOneMarker ? 2 : 1;
    const headerIndex = headerRowDetected - 1;
    const dataStartIndex = headerIndex + 1;
    const headerRow = allRows[headerIndex] || [];

    return {
        headerRowDetected,
        headerIndex,
        headerRow,
        dataStartIndex,
        rowOneColumnA,
        rowOneMarker,
    };
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

        const match = (
            layout.id === "crm1_layout_2"
            && (fieldName === "stage" || fieldName === "reason")
            && matches.length > 1
        )
            ? matches[1]
            : matches[0];

        headerMap[fieldName] = match;
        mappedHeaders.push(match);

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
        ["Form Link", "form_link"],
        ["Admin Name", "admin_name"],
        ["Location", "address"],
        ["Next Step", "next_step_note"],
        ["Notes", "notes"],
        ["Column 23", "extra_note"],
        ["Customer Type", "customer_type"],
        ["Location Type", "location_type"],
        ["Device Count", "device_count"],
        ["Price", "price"],
        ["Payment Date", "payment_date"],
        ["Install Date", "install_date"],
        ["Install Status", "install_status"],
        ["Outstanding Amount", "outstanding_amount"],
        ["Payment Slip", "payment_slip_url"],
        ["After Sales 30 Days", "after_sales_30_days"],
        ["Form Noti Date", "form_noti_date"],
        ["Form Status", "form_status"],
        ["Rooms", "rooms"],
        ["Area sqm", "area_sqm"],
        ["Room Count", "room_count"],
        ["Floor Type", "floor_type"],
        ["Follow-up Count", "followup_count"],
        ["Month", "month"],
        ["Week", "week"],
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
        const row1HeaderOffsetMatch = i === 0 ? detectCrm1Row1HeaderOffsetMarker(marker) : null;
        const detectedMatch = markerMatch || row1HeaderOffsetMatch;

        debug.push({
            row: i + 1,
            col_a: marker,
            raw_marker: marker,
            normalized_col_a: normalizedMarker,
            normalized_marker: normalizedMarker,
            detected_marker: Boolean(detectedMatch),
            import_marker: detectedMatch?.type === "import",
            skipped_marker: detectedMatch?.type === "skip",
            matched_as: detectedMatch?.matchedAs || "",
            match_reason: detectedMatch?.matchReason || "",
            marker_match_strategy: detectedMatch?.matchReason || "none",
            marker_match_confidence: detectedMatch?.confidence || 0,
        });
    }

    return debug;
}

function buildCrm1Blocks(rows, layout) {
    const allRows = rows || [];
    const markerDetectionDebug = buildMarkerDetectionDebug(allRows);
    const headerLayout = detectCrm1HeaderLayout(allRows, layout);
    const firstCell = headerLayout.rowOneColumnA;
    const firstCellMarker = matchCrm1AnyMarker(firstCell);

    if (layout?.structureMode === "row1_header" || !firstCellMarker) {
        const { headerIndex, headerRow, dataStartIndex, rowOneMarker } = headerLayout;
        const defaultMarker = layout?.defaultSourceBlock || DEFAULT_CRM1_SOURCE_BLOCK;

        console.log("HEADER ROW:", headerRow);

        return {
            parsedBlocks: [{
                marker: rowOneMarker ? firstCell : defaultMarker,
                normalizedMarker: rowOneMarker?.normalizedMarker || defaultMarker,
                markerMatch: rowOneMarker || { matchedAs: defaultMarker, matchReason: "default_row_1_header", confidence: 1, type: "import" },
                markerRow: rowOneMarker ? 1 : null,
                headerRow: headerLayout.headerRowDetected,
                headerIndex,
                dataStartIndex,
                headers: headerRow,
                dataRows: allRows.slice(dataStartIndex).map((row, index) => ({
                    rowNumber: dataStartIndex + index + 1,
                    row: row || [],
                })),
            }],
            skippedBlocks: [],
            markerDetectionDebug,
            structureMode: rowOneMarker ? "row_1_marker_row_2_header" : "row_1_header",
        };
    }

    const parsedBlocks = [];
    const skippedBlocks = [];

    for (let i = 0; i < allRows.length; i++) {
        const marker = String(allRows[i]?.[0] || "").trim();
        const markerMatch = matchCrm1AnyMarker(marker);
        if (!markerMatch) continue;

        const headerIndex = findNextNonEmptyRowIndex(allRows, i + 1);

        if (headerIndex === -1) {
            skippedBlocks.push({
                marker,
                marker_row: i + 1,
                reason: "missing_header_row",
            });
            break;
        }

        const headerRow = allRows[headerIndex] || [];
        console.log("HEADER ROW:", headerRow);

        const block = {
            marker,
            normalizedMarker: markerMatch.matchedAs,
            markerMatch,
            markerRow: i + 1,
            headerRow: headerIndex + 1,
            headerIndex,
            dataStartIndex: headerIndex + 1,
            headers: headerRow,
            dataRows: [],
        };

        let j = headerIndex + 1;
        for (; j < allRows.length; j++) {
            const nextMarker = String(allRows[j]?.[0] || "").trim();
            if (nextMarker && matchCrm1AnyMarker(nextMarker)) break;
            block.dataRows.push({
                rowNumber: j + 1,
                row: allRows[j] || [],
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
    return normalizeLegacyLeadStatusValue(status, mappingRules);
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

function getCrm1MaxActivitiesPerRun(req) {
    const raw = req.query.max_activities || process.env.CRM1_MAX_ACTIVITIES_PER_RUN || DEFAULT_CRM1_MAX_ACTIVITIES_PER_RUN;
    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CRM1_MAX_ACTIVITIES_PER_RUN;
}

function getCrm1MaxLeadUpdates(req) {
    const raw = String(req.query.max_lead_updates || "").trim();
    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getCrm1MaxDetailUpdates(req) {
    const raw = String(req.query.max_detail_updates || "").trim();
    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCrm1BooleanQuery(value) {
    return String(value || "").trim().toLowerCase() === "true";
}

function getCrm1WriteScope(req) {
    const scope = String(req.query.write_scope || "all").trim().toLowerCase();
    return CRM1_WRITE_SCOPES.has(scope) ? scope : "all";
}

function canWriteCrm1Scope(writeScope, target) {
    return writeScope === "all" || writeScope === target;
}

function createCrm1Diagnostics(timeoutMs) {
    return {
        timeout_ms: timeoutMs,
        started_at: new Date().toISOString(),
        steps: [],
    };
}

function logCrm1Step(diagnostics, step, extra = {}) {
    const elapsedMs = Date.now() - diagnostics.startedAtMs;
    const entry = { step, elapsed_ms: elapsedMs, ...extra };

    diagnostics.steps.push(entry);
    console.log("CRM1 IMPORT STEP:", entry);
}

function assertCrm1TimeRemaining(diagnostics, step) {
    const elapsedMs = Date.now() - diagnostics.startedAtMs;
    if (elapsedMs >= diagnostics.timeout_ms) {
        const err = new Error(`CRM1 import timed out at step: ${step}`);
        err.code = "CRM1_IMPORT_TIMEOUT";
        err.step = step;
        throw err;
    }
}

async function withCrm1Timeout(promise, diagnostics, step) {
    assertCrm1TimeRemaining(diagnostics, step);

    const remainingMs = Math.max(1, diagnostics.timeout_ms - (Date.now() - diagnostics.startedAtMs));
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const err = new Error(`CRM1 import timed out at step: ${step}`);
            err.code = "CRM1_IMPORT_TIMEOUT";
            err.step = step;
            reject(err);
        }, remainingMs);
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
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

function getNextCrm1DataRow(rows) {
    for (let i = rows.length - 1; i >= 2; i--) {
        if (rowHasAnyValue(rows[i])) return i + 2;
    }

    return 3;
}

async function appendCrm1ActivityRows(sheets, spreadsheetId, activityRows, activityHeaders, entries) {
    if (!entries.length) return;

    const startRow = getNextCrm1DataRow(activityRows);
    const endRow = startRow + entries.length - 1;
    const endColumn = columnToLetter(Math.max(activityHeaders.length, 1));
    const values = entries.map(entry => googleSheets.objectToRow(activityHeaders, entry.object));

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `ACTIVITY_LOG!A${startRow}:${endColumn}${endRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
    });
}

function normalizeCrm1ComparableValue(value) {
    return String(value ?? "").trim();
}

function normalizeCrm1CustomerType(value) {
    const raw = String(value || "").trim();
    const lower = raw.toLowerCase();

    if (lower === "b2c") return "B2C";
    if (lower === "b2b") return "B2B";
    return raw;
}

function normalizeCrm1PaymentStatus(value, mappingRules) {
    const raw = String(value || "").trim();
    const lower = raw.toLowerCase();
    const mapped = normalizeByMappingRules(mappingRules, "payment_status", raw)
        || normalizeByMappingRules(mappingRules, "payment", raw);

    return normalizeCrm1PaymentStatusForSheet(mapped || raw || lower);
}

function normalizeCrm1PaymentStatusForSheet(value) {
    const raw = String(value || "").trim();
    const lower = raw.toLowerCase();

    if (!raw || lower === "unknown") return "Unpaid";
    if (lower === "paid" || raw.includes("ชำระครบแล้ว")) return "Paid";
    if (lower === "unpaid") return "Unpaid";
    if (lower === "cancelled" || lower === "canceled" || raw.includes("ยกเลิก")) return "Cancelled";
    if (lower === "partial" || raw.includes("มัดจำ") || lower.includes("pre-order") || raw.includes("รอชำระส่วนต่าง")) return "Unpaid";

    return "Unpaid";
}

function normalizeCrm1InstallationStatus(value, mappingRules) {
    const raw = String(value || "").trim();
    const lower = raw.toLowerCase();
    const mapped = normalizeByMappingRules(mappingRules, "installation_status", raw)
        || normalizeByMappingRules(mappingRules, "install_status", raw);

    if (mapped) return mapped;
    if (!raw) return "unknown";
    if (raw.includes("ยกเลิก") || lower.includes("cancel")) return "cancelled";
    if (lower.includes("pre-order") || raw.includes("รอ") || raw.includes("มัดจำ") || raw.includes("วางบิล")) return "pending";
    if (raw.includes("ติดตั้ง") || raw.includes("ชำระครบแล้ว") || lower.includes("installed") || lower.includes("setup complete")) return "installed";
    return "unknown";
}

function getCrm1Layout3LeadStatus(installStatus, sourceMarker = "") {
    const raw = String(installStatus || "").trim();
    const marker = normalizeCrm1MarkerText(sourceMarker);

    if (marker.includes("link close won") || marker.includes("close won")) return "Done";
    if (raw.includes("ชำระครบแล้ว")) return "Done";
    if (raw.includes("ยกเลิก")) return "Cancelled";
    return "";
}

function getCrm1Layout4LeadStatus(installationStatus) {
    const status = String(installationStatus || "").trim().toLowerCase();

    if (status === "installed") return "Installed";
    if (status === "cancelled") return "Cancelled";
    return "";
}

function normalizeCrm1LeadStatusForSheet(value) {
    const raw = String(value || "").trim();
    const lower = raw.toLowerCase();

    if (!raw || lower === "unknown") return "New";
    if (lower === "new") return "New";
    if (["ongoing", "contacted", "interested", "follow-up", "follow up", "followup", "pending"].includes(lower)) return "Ongoing";
    if (lower === "installed") return "Installed";
    if (["done", "closed", "closed won", "completed", "complete"].includes(lower)) return "Done";
    if (["cancelled", "canceled", "not interested", "closed lost"].includes(lower)) return "Cancelled";
    if (lower.includes("cancel")) return "Cancelled";
    if (lower.includes("install")) return "Installed";
    if (lower.includes("closed") || lower.includes("done") || lower.includes("complete")) return "Done";
    if (lower.includes("follow") || lower.includes("pending") || lower.includes("contact") || lower.includes("interest")) return "Ongoing";

    return "New";
}

function normalizeCrm1Layout4InstallationStatus(value) {
    const raw = String(value || "").trim();

    if (!raw) return "";
    if (raw.includes("ติดตั้งเรียบร้อย")) return "installed";
    if (raw.includes("ยกเลิก")) return "cancelled";
    if (raw.includes("รอคอนเฟิร์ม")) return "pending";
    if (raw.includes("คอนเฟิร์มแล้ว")) return "confirmed";
    if (raw.includes("เลื่อนวัน")) return "rescheduled";

    return raw;
}

function shouldUpdateCrm1ExistingStatus(existingLeadObject) {
    const current = String(existingLeadObject?.lead_status || existingLeadObject?.status || "").trim().toLowerCase();
    return !current || current === "new";
}

function getCrm1FinalLeadStatus(record) {
    if (record.finalLeadStatus) return normalizeCrm1LeadStatusForSheet(record.finalLeadStatus);
    return record.closedDate ? "Done" : "New";
}

function normalizeCrm1DealDateKey(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const parsed = parseLegacyDateValue(raw).value;
    const normalized = parsed || raw;
    const isoMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

    if (!isoMatch) return "";

    return [
        isoMatch[1],
        String(isoMatch[2]).padStart(2, "0"),
        String(isoMatch[3]).padStart(2, "0"),
    ].join("-");
}

function normalizeCrm1DealPriceKey(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const cleaned = raw.replace(/,/g, "").replace(/[^\d.-]/g, "");
    const parsed = Number.parseFloat(cleaned);

    return Number.isFinite(parsed) ? String(parsed) : "";
}

function getCrm1DealSignature(leadId, productModel, dateValue, price = "") {
    const normalizedLeadId = String(leadId || "").trim();
    const normalizedProduct = String(productModel || "").trim().toLowerCase();
    const normalizedDate = normalizeCrm1DealDateKey(dateValue);
    const normalizedPrice = normalizeCrm1DealPriceKey(price);

    if (!normalizedDate) {
        return `${normalizedLeadId}|${normalizedProduct}|${normalizedPrice}`;
    }

    return `${normalizedLeadId}|${normalizedProduct}|${normalizedDate}|${normalizedPrice}`;
}

function buildCrm1LeadUpdatePlan(headers, update) {
    const changedKeys = new Set();
    const object = update.object || {};
    const existingObject = update.existingObject || {};

    for (const header of headers) {
        const key = googleSheets.normalizeHeaderName(header);
        if (!key || key === "updated_at" || !Object.prototype.hasOwnProperty.call(object, key)) continue;

        const currentValue = normalizeCrm1ComparableValue(existingObject[key]);
        const nextValue = normalizeCrm1ComparableValue(object[key]);
        if (currentValue !== nextValue) changedKeys.add(key);
    }

    if (!changedKeys.size) return null;
    if (Object.prototype.hasOwnProperty.call(object, "updated_at")) {
        changedKeys.add("updated_at");
    }

    const ranges = [];
    let currentGroup = null;

    headers.forEach((header, index) => {
        const key = googleSheets.normalizeHeaderName(header);
        if (!changedKeys.has(key)) {
            if (currentGroup) {
                ranges.push(currentGroup);
                currentGroup = null;
            }
            return;
        }

        const value = object[key] ?? "";
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

        ranges.push(currentGroup);
        currentGroup = {
            startIndex: index,
            endIndex: index,
            values: [value],
        };
    });

    if (currentGroup) ranges.push(currentGroup);

    return {
        rowNumber: update.rowNumber,
        update,
        ranges: ranges.map(group => ({
            range: `LEADS_MAIN!${columnToLetter(group.startIndex + 1)}${update.rowNumber}:${columnToLetter(group.endIndex + 1)}${update.rowNumber}`,
            values: [group.values],
        })),
    };
}

async function batchUpdateCrm1LeadRows(sheets, spreadsheetId, plans) {
    const data = plans.flatMap(plan => plan.ranges);
    if (!data.length) return;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data,
        },
    });
}

function buildCrm1ObjectUpdatePlan(sheetName, headers, update) {
    const changedKeys = new Set();
    const object = update.object || {};
    const existingObject = update.existingObject || {};

    for (const header of headers) {
        const key = googleSheets.normalizeHeaderName(header);
        if (!key || !Object.prototype.hasOwnProperty.call(object, key)) continue;

        const currentValue = normalizeCrm1ComparableValue(existingObject[key]);
        const nextValue = normalizeCrm1ComparableValue(object[key]);
        if (currentValue !== nextValue) changedKeys.add(key);
    }

    if (!changedKeys.size) return null;

    const ranges = [];
    let currentGroup = null;

    headers.forEach((header, index) => {
        const key = googleSheets.normalizeHeaderName(header);
        if (!changedKeys.has(key)) {
            if (currentGroup) {
                ranges.push(currentGroup);
                currentGroup = null;
            }
            return;
        }

        const value = object[key] ?? "";
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

        ranges.push(currentGroup);
        currentGroup = {
            startIndex: index,
            endIndex: index,
            values: [value],
        };
    });

    if (currentGroup) ranges.push(currentGroup);

    return {
        rowNumber: update.rowNumber,
        update,
        ranges: ranges.map(group => ({
            range: `${sheetName}!${columnToLetter(group.startIndex + 1)}${update.rowNumber}:${columnToLetter(group.endIndex + 1)}${update.rowNumber}`,
            values: [group.values],
        })),
    };
}

async function batchUpdateCrm1ObjectRows(sheets, spreadsheetId, plans) {
    const data = plans.flatMap(plan => plan.ranges);
    if (!data.length) return;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data,
        },
    });
}

function buildCrm1LeadObject(record, leadId, existingLeadObject = null) {
    const finalLeadStatus = getCrm1FinalLeadStatus(record);

    if (!existingLeadObject) {
        return {
            lead_id: leadId,
            open_deal: false,
            save_follow_up: false,
            customer_name: record.customerName,
            phone: record.normalizedPhone,
            source: record.normalizedSource || "Legacy Import",
            lead_status: finalLeadStatus,
            status: finalLeadStatus,
            sales_owner: record.adminName,
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

    if (record.layoutId === "crm1_layout_4") {
        if (shouldUpdateCrm1ExistingStatus(existingLeadObject)) {
            putIfPresent("lead_status", finalLeadStatus);
            putIfPresent("status", finalLeadStatus);
        }
        return object;
    }

    putIfExistingBlank("customer_name", record.customerName);
    putIfExistingBlank("lead_id", leadId);
    putIfExistingBlank("phone", record.normalizedPhone);
    putIfExistingBlank("source", record.normalizedSource || "Legacy Import");
    if (!record.statusUpdateOnlyIfBlankOrNew || shouldUpdateCrm1ExistingStatus(existingLeadObject)) {
        putIfPresent("lead_status", finalLeadStatus);
        putIfPresent("status", finalLeadStatus);
    }
    putIfPresent("sales_owner", record.adminName);
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
        raw_phone: record.originalPhone,
        raw_province: record.rawProvince,
        original_customer_name: record.customerName,
        created_source: "CRM1 Import",
    };
}

function buildCrm1DealObject(record, leadId, dealId) {
    const object = {
        deal_id: dealId,
        lead_id: leadId,
        product_model: record.productModel,
        product: record.productModel,
        quantity: record.deviceCount,
        device_count: record.deviceCount,
        price: record.price,
        paid_amount: record.price,
        payment_date: record.paymentDate,
        payment_status: record.paymentStatus,
        installation_status: record.installationStatus,
        install_date: record.installDate,
        setup_date: record.installDate,
        outstanding_amount: record.outstandingAmount,
        additional_payment: record.outstandingAmount,
        payment_slip_url: record.paymentSlipUrl,
        link_slip: record.paymentSlipUrl,
        note: record.dealNote,
        closed_date: record.closedDate,
        close_won_date: record.closedDate,
        updated_at: record.now,
        created_at: record.now,
        import_source: "CRM1 Legacy Import",
    };

    if (String(record.fullAmount || "").trim()) {
        object.full_amount = record.fullAmount;
    }

    return object;
}

function buildCrm1InstallationObject(record, leadId, installId) {
    const note = [
        record.note,
        record.zone ? `Zone: ${record.zone}` : "",
        record.technician ? `Technician: ${record.technician}` : "",
        record.cancelReason ? `Cancel Reason: ${record.cancelReason}` : "",
    ].filter(Boolean).join("\n");

    return {
        install_id: installId,
        lead_id: leadId,
        install_status: record.installationStatus,
        preferred_install_date: record.installDate,
        preferred_install_time: record.timeSlot,
        location: record.address || record.zone,
        machine_count: record.quantity,
        note,
        created_at: record.now,
        updated_at: record.now,
        import_source: "CRM1 Legacy Import",
    };
}

function buildCrm1ActivityObject(record, leadId) {
    const activityType = record.activityType || "Import Note";
    const activityDate = record.lastContactDate || record.now;

    return {
        activity_id: generateImportId("ACT"),
        lead_id: leadId,
        sheet_name: "IMPORT",
        action_type: activityType,
        lead_status: record.leadStatus,
        note: record.note,
        audio_url: record.audioLink,
        created_at: record.now,
        activity_date: activityDate,
        created_by: "CRM1 Import",
    };
}

function buildCrm1ActivityObjects(record, leadId) {
    if (record.layoutId === "crm1_layout_4") {
        return [{
            activity_id: generateImportId("ACT"),
            lead_id: leadId,
            sheet_name: "IMPORT",
            action_type: "Installation",
            new_value: record.installationStatus,
            note: [
                record.timeSlot ? `Time slot: ${record.timeSlot}` : "",
                record.technician ? `Technician: ${record.technician}` : "",
                record.note,
            ].filter(Boolean).join("\n"),
            created_at: record.now,
            activity_date: record.installDate || record.now,
            created_by: "CRM1 Import",
        }];
    }

    if (record.layoutId !== "crm1_layout_3") {
        return [buildCrm1ActivityObject(record, leadId)];
    }

    const activities = [];
    const base = {
        lead_id: leadId,
        sheet_name: "IMPORT",
        created_at: record.now,
        created_by: "CRM1 Import",
    };

    if (hasAnyValue({ price: record.price, paymentDate: record.paymentDate, outstandingAmount: record.outstandingAmount, paymentSlipUrl: record.paymentSlipUrl })) {
        activities.push({
            ...base,
            activity_id: generateImportId("ACT"),
            action_type: "Payment",
            new_value: record.paymentStatus,
            payment_url: record.paymentSlipUrl,
            note: [
                record.price ? `Price: ${record.price}` : "",
                record.paymentDate ? `Payment Date: ${record.paymentDate}` : "",
                record.outstandingAmount ? `Outstanding: ${record.outstandingAmount}` : "",
                record.installStatusRaw ? `Install Status: ${record.installStatusRaw}` : "",
                record.paymentSlipUrl ? `Slip: ${record.paymentSlipUrl}` : "",
            ].filter(Boolean).join("\n"),
            activity_date: record.paymentDate || record.now,
        });
    }

    if (hasAnyValue({ installDate: record.installDate, address: record.address, deviceCount: record.deviceCount })) {
        activities.push({
            ...base,
            activity_id: generateImportId("ACT"),
            action_type: "Installation",
            new_value: record.installationStatus,
            note: [
                record.installDate ? `Set up date: ${record.installDate}` : "",
                record.address ? `Location: ${record.address}` : "",
                record.deviceCount ? `Device Count: ${record.deviceCount}` : "",
            ].filter(Boolean).join("\n"),
            activity_date: record.installDate || record.now,
        });
    }

    if (hasAnyValue({ afterSales30Days: record.afterSales30Days, formNotiDate: record.formNotiDate, formStatus: record.formStatus })) {
        activities.push({
            ...base,
            activity_id: generateImportId("ACT"),
            action_type: "After Sales / Form Notification",
            new_value: record.formStatus || record.afterSales30Days,
            note: [
                record.afterSales30Days ? `After sales 30 days: ${record.afterSales30Days}` : "",
                record.formNotiDate ? `Form Noti Date: ${record.formNotiDate}` : "",
                record.formStatus ? `Form Status: ${record.formStatus}` : "",
            ].filter(Boolean).join("\n"),
            activity_date: record.formNotiDate || record.now,
        });
    }

    return activities;
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
    const requestedSheetName = String(req.query.sheet_name || req.query.source_sheet || "").trim();
    const maxActivitiesPerRun = getCrm1MaxActivitiesPerRun(req);
    const maxLeadUpdates = getCrm1MaxLeadUpdates(req);
    const maxDetailUpdates = getCrm1MaxDetailUpdates(req);
    const debugOnly = parseCrm1BooleanQuery(req.query.debug_only);
    const writeScope = getCrm1WriteScope(req);
    const timeoutMs = debugOnly ? DEBUG_CRM1_TIMEOUT_MS : DEFAULT_CRM1_TIMEOUT_MS;
    const diagnostics = createCrm1Diagnostics(timeoutMs);
    diagnostics.startedAtMs = Date.now();
    diagnostics.debug_only = debugOnly;
    diagnostics.write_scope = writeScope;

    try {
        logCrm1Step(diagnostics, "start import", {
            dry_run: dryRun,
            debug_only: debugOnly,
            write_scope: writeScope,
            max_activities_per_run: maxActivitiesPerRun,
            max_lead_updates: maxLeadUpdates,
            max_detail_updates: maxDetailUpdates,
        });

        const { sheets, spreadsheetId } = await withCrm1Timeout(
            googleSheets.createSheetsClient(),
            diagnostics,
            "create sheets client"
        );
        let candidateLayouts = requestedLayoutId
            ? CRM1_LAYOUTS.filter(layout => layout.id === requestedLayoutId)
            : CRM1_LAYOUTS;
        if (requestedSheetName) {
            candidateLayouts = candidateLayouts.map(layout => ({ ...layout, sheetName: requestedSheetName }));
        }
        const candidateSheetNames = candidateLayouts.map(layout => layout.sheetName);
        const rawSheet = await withCrm1Timeout(
            readFirstAvailableSheet(googleSheets, sheets, spreadsheetId, candidateSheetNames),
            diagnostics,
            "read source sheet"
        );
        logCrm1Step(diagnostics, "after reading source sheet", {
            source_sheet_name: rawSheet.sheetName,
            source_rows: rawSheet.rows.length,
        });
        const layout = candidateLayouts.find(item => item.sheetName === rawSheet.sheetName) || CRM1_LAYOUTS[0];
        const leadsRows = await withCrm1Timeout(
            googleSheets.getSheetRows("LEADS_MAIN"),
            diagnostics,
            "read LEADS_MAIN"
        );
        logCrm1Step(diagnostics, "after reading LEADS_MAIN", { rows: leadsRows.length });
        const leadHeaders = leadsRows[0] || [];
        const detailRows = await withCrm1Timeout(
            googleSheets.getSheetRows("LEAD_DETAILS"),
            diagnostics,
            "read LEAD_DETAILS"
        );
        logCrm1Step(diagnostics, "after reading LEAD_DETAILS", { rows: detailRows.length });
        const detailHeaders = detailRows[0] || [];
        const dealRows = await withCrm1Timeout(
            googleSheets.getSheetRows("DEALS"),
            diagnostics,
            "read DEALS"
        );
        logCrm1Step(diagnostics, "after reading DEALS", { rows: dealRows.length });
        const dealHeaders = dealRows[0] || [];
        const installationRows = await withCrm1Timeout(
            googleSheets.getSheetRows("INSTALLATIONS"),
            diagnostics,
            "read INSTALLATIONS"
        );
        logCrm1Step(diagnostics, "after reading INSTALLATIONS", { rows: installationRows.length });
        const installationHeaders = installationRows[0] || [];
        const activityRows = await withCrm1Timeout(
            googleSheets.getSheetRows("ACTIVITY_LOG"),
            diagnostics,
            "read ACTIVITY_LOG"
        );
        logCrm1Step(diagnostics, "after reading ACTIVITY_LOG", { rows: activityRows.length });
        const activityHeaders = activityRows[0] || [];
        const mappingRules = await withCrm1Timeout(
            loadMappingRules(googleSheets),
            diagnostics,
            "load MAPPING_RULES"
        );
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
        const knownDealsBySignature = new Map();
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
        let skippedActivityLimit = 0;
        let leadsUpdateCandidates = 0;
        let leadsSkippedUnchanged = 0;
        let leadsUpdated = 0;
        let leadUpdateBatches = 0;
        let skippedLeadUpdateLimit = 0;
        let detailUpdateCandidates = 0;
        let detailsUpdated = 0;
        let detailsSkippedUnchanged = 0;
        let detailUpdateBatches = 0;
        let skippedDetailUpdateLimit = 0;
        let dealsToCreate = 0;
        let dealsUpdated = 0;
        let dealsSkippedDuplicate = 0;
        let closedWonLeads = 0;

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

        for (let i = 2; i < dealRows.length; i++) {
            const dealObject = googleSheets.rowToObject(dealHeaders, dealRows[i]);
            const leadId = String(dealObject.lead_id || "").trim();
            const productModel = dealObject.product_model || dealObject.product || "";
            const closedDate = dealObject.payment_date || dealObject.closed_date || dealObject.close_won_date || "";
            const price = dealObject.price || "";
            if (!leadId || !String(productModel || "").trim()) continue;
            knownDealsBySignature.set(getCrm1DealSignature(leadId, productModel, closedDate, price), { ...dealObject, rowNumber: i + 1 });
        }

        for (let i = 2; i < activityRows.length; i++) {
            const activityObject = googleSheets.rowToObject(activityHeaders, activityRows[i]);
            existingActivitySignatures.add(getActivitySignature(activityObject));
        }

        const isLayout4 = layout.id === "crm1_layout_4";

        for (const block of parsedBlocks) {
            const { headerMap } = buildHeaderMapForLayout(block.headers, layout);

            for (const dataRow of block.dataRows) {
                if (!rowHasAnyValue(dataRow.row)) continue;

                totalRows++;

                try {
                    const customerName = getCrm1Value(dataRow.row, headerMap, "customer_name");
                    const phone = getCrm1Value(dataRow.row, headerMap, "phone");
                    const formLink = getCrm1Value(dataRow.row, headerMap, "form_link");
                    const adminName = getCrm1Value(dataRow.row, headerMap, "admin_name");
                    const source = getCrm1Value(dataRow.row, headerMap, "source");
                    const rawCustomerType = getCrm1Value(dataRow.row, headerMap, "customer_type");
                    const customerType = normalizeCrm1CustomerType(rawCustomerType);
                    const locationType = getCrm1Value(dataRow.row, headerMap, "location_type");
                    const rooms = getCrm1Value(dataRow.row, headerMap, "rooms");
                    const areaSqm = getCrm1Value(dataRow.row, headerMap, "area_sqm");
                    const roomCount = getCrm1Value(dataRow.row, headerMap, "room_count");
                    const floorType = getCrm1Value(dataRow.row, headerMap, "floor_type");
                    const month = getCrm1Value(dataRow.row, headerMap, "month");
                    const stageRaw = getCrm1Value(dataRow.row, headerMap, "stage_raw") || getCrm1Value(dataRow.row, headerMap, "status");
                    const stage = getCrm1Value(dataRow.row, headerMap, "stage") || stageRaw;
                    const rawReason = getCrm1Value(dataRow.row, headerMap, "reason_raw") || getCrm1Value(dataRow.row, headerMap, "reason");
                    const cleanReason = getCrm1Value(dataRow.row, headerMap, "reason") || rawReason;
                    const note = isLayout4
                        ? getCrm1Value(dataRow.row, headerMap, "note")
                        : buildCrm1Notes(dataRow.row, headerMap);
                    const rawProvince = getCrm1Value(dataRow.row, headerMap, "province");
                    const rawZone = getCrm1Value(dataRow.row, headerMap, "zone");
                    const productModel = getCrm1Value(dataRow.row, headerMap, "product_model");
                    const deviceCount = getCrm1Value(dataRow.row, headerMap, "device_count");
                    const quantity = getCrm1Value(dataRow.row, headerMap, "quantity") || deviceCount;
                    const paymentDateRaw = getCrm1Value(dataRow.row, headerMap, "payment_date");
                    const paymentSlipUrl = normalizePaymentSlipLink(getCrm1Value(dataRow.row, headerMap, "payment_slip_url"));
                    const price = getCrm1Value(dataRow.row, headerMap, "price");
                    const installDateRaw = getCrm1Value(dataRow.row, headerMap, "install_date");
                    const installTime = getCrm1Value(dataRow.row, headerMap, "install_time");
                    const timeSlot = getCrm1Value(dataRow.row, headerMap, "time_slot") || installTime;
                    const installStatusRaw = getCrm1Value(dataRow.row, headerMap, "install_status");
                    const technician = getCrm1Value(dataRow.row, headerMap, "technician");
                    const cancelReason = getCrm1Value(dataRow.row, headerMap, "cancel_reason");
                    const address = getCrm1Value(dataRow.row, headerMap, "address");
                    const lastContactDateRaw = getCrm1Value(dataRow.row, headerMap, "last_contact_date");
                    const nextStepDateRaw = getCrm1Value(dataRow.row, headerMap, "next_follow_up");
                    const closedDateRaw = getCrm1Value(dataRow.row, headerMap, "closed_date");
                    const outstandingAmount = getCrm1Value(dataRow.row, headerMap, "outstanding_amount");
                    const afterSales30Days = getCrm1Value(dataRow.row, headerMap, "after_sales_30_days");
                    const formNotiDateRaw = getCrm1Value(dataRow.row, headerMap, "form_noti_date");
                    const formStatus = getCrm1Value(dataRow.row, headerMap, "form_status");
                    const week = getCrm1Value(dataRow.row, headerMap, "week");
                    const contactMethod = getCrm1Value(dataRow.row, headerMap, "activity_type");
                    const followUpCount = getCrm1Value(dataRow.row, headerMap, "followup_count");
                    const priority = normalizeCrm1Priority(getCrm1Value(dataRow.row, headerMap, "priority"));
                    const audioLink = getCrm1Value(dataRow.row, headerMap, "audio_link");
                    const normalizedPhone = normalizeCrm1Phone(phone);

                    if (!normalizedPhone && !isLayout4) {
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

                    if (normalizedPhone) rowsWithValidPhone++;

                    const provinceResult = normalizeLegacyProvince(rawProvince, mappingRules);
                    const explicitZone = normalizeByMappingRules(mappingRules, "zone", rawZone);
                    const derivedZone = normalizeLegacyZone(provinceResult.province, mappingRules);
                    const zone = explicitZone || derivedZone;
                    const normalizedSource = mapLegacySource(source, mappingRules);
                    const reason = mapLegacyReason(cleanReason || stage, mappingRules);
                    const installDate = parseLegacyDateValue(installDateRaw).value;
                    const paymentDate = parseLegacyDateValue(paymentDateRaw).value;
                    const lastContactDate = parseLegacyDateValue(lastContactDateRaw).value;
                    const nextStepDate = parseLegacyDateValue(nextStepDateRaw).value;
                    const closedDate = parseLegacyDateValue(closedDateRaw).value;
                    const formNotiDate = parseLegacyDateValue(formNotiDateRaw).value;
                    const paymentStatus = normalizeCrm1PaymentStatus(installStatusRaw, mappingRules);
                    const installationStatus = isLayout4
                        ? normalizeCrm1Layout4InstallationStatus(installStatusRaw)
                        : normalizeCrm1InstallationStatus(installStatusRaw, mappingRules);
                    const layout3Status = layout.id === "crm1_layout_3" ? getCrm1Layout3LeadStatus(installStatusRaw, block.marker) : "";
                    const layout4Status = isLayout4 ? getCrm1Layout4LeadStatus(installationStatus) : "";
                    const leadStatus = layout4Status || layout3Status || normalizeLegacyLeadStatusValue(stage, mappingRules, {
                        closedDate,
                        installStatus: installStatusRaw,
                        paymentStatus,
                        sourceMarker: block.marker,
                    });
                    const audioItems = detectCrm1Audio(dataRow.row, headerMap, block.marker, dataRow.rowNumber, normalizedPhone);
                    const hasDealData = !layout.skipDeals && hasAnyValue({ productModel, deviceCount, paymentDate, paymentSlipUrl, price });
                    const hasInstallationData = hasAnyValue({ productModel, quantity, installDate, timeSlot, technician, installationStatus, cancelReason, note });
                    const hasLayout3ActivityData = layout.id === "crm1_layout_3" && hasAnyValue({
                        price,
                        paymentDate,
                        outstandingAmount,
                        paymentSlipUrl,
                        installDate,
                        address,
                        deviceCount,
                        afterSales30Days,
                        formNotiDate,
                        formStatus,
                    });
                    const hasActivityData = isLayout4 || hasLayout3ActivityData || hasAnyValue({ contactMethod, lastContactDate, nextStepDate, note, followUpCount }) || audioItems.length > 0;
                    const existingLeadObject = normalizedPhone ? knownLeadsByPhone.get(normalizedPhone) : null;
                    const duplicateQueued = queuedPhones.has(normalizedPhone);
                    const wouldUpdate = Boolean(normalizedPhone && (existingLeadObject || duplicateQueued));

                    if (wouldUpdate) wouldUpdateExistingLead++;
                    else if (!layout.updateExistingLeadOnly) {
                        wouldCreateLead++;
                        if (normalizedPhone) queuedPhones.add(normalizedPhone);
                    }

                    if (hasDealData) wouldCreateDeal++;
                    if (leadStatus === "Done") closedWonLeads++;
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
                        originalPhone: phone,
                        formLink,
                        adminName,
                        normalizedSource,
                        leadStatus,
                        finalLeadStatus: leadStatus,
                        statusUpdateOnlyIfBlankOrNew: isLayout4 || (layout.id === "crm1_layout_3" && !layout3Status),
                        updateExistingLeadOnly: Boolean(layout.updateExistingLeadOnly),
                        skipLeadDetails: Boolean(layout.skipLeadDetails),
                        skipDeals: Boolean(layout.skipDeals),
                        rawCustomerType,
                        stageRaw,
                        stage,
                        reasonRaw: rawReason,
                        reason,
                        note,
                        customerType,
                        locationType,
                        rooms,
                        areaSqm,
                        roomCount,
                        floorType,
                        month,
                        week,
                        address,
                        rawProvince,
                        province: provinceResult.province,
                        zone,
                        productModel,
                        deviceCount,
                        quantity,
                        price,
                        paymentDate,
                        paymentSlipUrl,
                        outstandingAmount,
                        lastContactDate,
                        nextStepDate,
                        closedDate,
                        installDate,
                        installStatusRaw,
                        timeSlot,
                        technician,
                        cancelReason,
                        paymentStatus,
                        installationStatus,
                        afterSales30Days,
                        formNotiDate,
                        formStatus,
                        activityType: contactMethod,
                        followUpCount,
                        priority,
                        audioLink,
                        hasActivityData,
                        layoutId: layout.id,
                        dealNote: [
                            deviceCount ? `Device Count: ${deviceCount}` : "",
                            outstandingAmount ? `Outstanding: ${outstandingAmount}` : "",
                            paymentSlipUrl ? `Payment Slip: ${paymentSlipUrl}` : "",
                            installStatusRaw ? `Install Status: ${installStatusRaw}` : "",
                            address ? `Location: ${address}` : "",
                        ].filter(Boolean).join("\n"),
                        dealDedupeDate: layout.id === "crm1_layout_3" ? paymentDate : closedDate,
                        dealDedupePrice: layout.id === "crm1_layout_3" ? price : "",
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
                            form_link: formLink,
                            admin_name: adminName,
                            sales_owner_preview: adminName,
                            lead_status: leadStatus,
                            lead_status_final: leadStatus,
                            source: normalizedSource,
                            province: provinceResult.province,
                            zone,
                            customer_type: customerType,
                            normalized_customer_type: customerType,
                            activity_type: contactMethod,
                            last_contact_date: lastContactDate,
                            followup_count: followUpCount,
                            product_model: productModel,
                            price,
                            payment_date: paymentDate,
                            payment_status: paymentStatus,
                            closed_date: closedDate,
                            install_date: installDate,
                            time_slot: timeSlot,
                            technician,
                            install_status: installationStatus,
                            install_status_raw: installStatusRaw,
                            device_count: deviceCount,
                            quantity,
                            cancel_reason: cancelReason,
                            outstanding_amount: outstandingAmount,
                            payment_slip_url: paymentSlipUrl,
                            after_sales_30_days: afterSales30Days,
                            form_noti_date: formNotiDate,
                            form_status: formStatus,
                            stage_raw: stageRaw,
                            stage,
                            reason_raw: rawReason,
                            reason,
                            next_follow_up: nextStepDate,
                            audio_link: audioLink,
                            priority,
                            month,
                            week,
                            address,
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

        logCrm1Step(diagnostics, "after parsing rows", {
            total_rows: totalRows,
            rows_with_valid_phone: rowsWithValidPhone,
            rows_missing_phone: rowsMissingPhone,
            parsed_records: parsedRecords.length,
        });

        if (!dryRun && layout.realImportEnabled === false) {
            return res.status(501).json({
                success: false,
                dry_run: dryRun,
                parsed_dry_run: dryRun,
                crm1_layout_id: layout.id,
                source_sheet_name: rawSheet.sheetName,
                structure_mode: structureMode,
                header_row_detected: primaryBlock?.headerRow || null,
                mapped_headers: primaryHeaderInfo.mappedHeaders,
                missing_required_headers: missingRequiredHeaders,
                total_rows: totalRows,
                rows_with_valid_phone: rowsWithValidPhone,
                rows_missing_phone: rowsMissingPhone,
                skipped_invalid_phone: rowsMissingPhone,
                sample_preview_items: samplePreviewItems,
                failed_row_samples: failedRowSamples,
                real_import_implemented: false,
                message: "Real import for this CRM1 layout is not enabled yet.",
            });
        }

        const leadCreates = [];
        const leadUpdates = [];
        const detailCreates = [];
        const detailUpdates = [];
        const dealCreates = [];
        const dealUpdates = [];
        const installationCreates = [];
        const activityCreates = [];

        if (!dryRun || debugOnly) {
            const failedCreatedLeadIds = new Set();

            for (const record of parsedRecords) {
                assertCrm1TimeRemaining(diagnostics, "compute rows to write");
                try {
                    let leadId = record.existingLeadObject?.lead_id || "";
                    const currentLead = record.normalizedPhone ? knownLeadsByPhone.get(record.normalizedPhone) : null;
                    const existingLead = currentLead?.rowNumber ? currentLead : record.existingLeadObject;

                    if (!leadId && currentLead?.lead_id) leadId = currentLead.lead_id;

                    if (existingLead?.rowNumber) {
                        leadUpdates.push({
                            rowNumber: existingLead.rowNumber,
                            object: buildCrm1LeadObject(record, leadId, existingLead),
                            record,
                            existingObject: existingLead,
                        });
                    } else if (currentLead && !currentLead.rowNumber) {
                        leadId = currentLead.lead_id;
                    } else if (!record.updateExistingLeadOnly && record.normalizedPhone) {
                        leadId = generateImportId("LEAD");
                        const leadObject = buildCrm1LeadObject(record, leadId);
                        leadCreates.push({ object: leadObject, record });
                        knownLeadsByPhone.set(record.normalizedPhone, { ...leadObject, rowNumber: null });
                        insertedLeads++;
                    }

                    if (!record.skipLeadDetails && leadId) {
                        const detailObject = buildCrm1LeadDetailObject(record, leadId);
                        const existingDetail = knownLeadDetailsByLeadId.get(leadId);
                        if (existingDetail?.rowNumber) {
                            detailUpdates.push({
                                rowNumber: existingDetail.rowNumber,
                                object: detailObject,
                                existingObject: existingDetail,
                            });
                        } else if (!existingDetail) {
                            detailCreates.push(detailObject);
                            knownLeadDetailsByLeadId.set(leadId, { ...detailObject, rowNumber: null });
                        }
                    }

                    if (!record.skipDeals && String(record.productModel || "").trim()) {
                        const dealSignature = getCrm1DealSignature(
                            leadId,
                            record.productModel,
                            record.dealDedupeDate,
                            record.dealDedupePrice
                        );
                        const existingDeal = knownDealsBySignature.get(dealSignature);
                        const dealId = existingDeal?.deal_id || generateImportId("DEAL");
                        const dealObject = buildCrm1DealObject(record, leadId, dealId);

                        if (existingDeal?.rowNumber && record.layoutId === "crm1_layout_3") {
                            dealsSkippedDuplicate++;
                        } else if (existingDeal?.rowNumber) {
                            dealUpdates.push({
                                rowNumber: existingDeal.rowNumber,
                                object: dealObject,
                                existingObject: existingDeal,
                            });
                        } else if (!existingDeal) {
                            dealCreates.push(dealObject);
                            knownDealsBySignature.set(dealSignature, { ...dealObject, rowNumber: null });
                            dealsToCreate++;
                        } else {
                            dealsSkippedDuplicate++;
                        }
                    }

                    if (record.layoutId === "crm1_layout_4" && hasAnyValue({
                        productModel: record.productModel,
                        quantity: record.quantity,
                        installDate: record.installDate,
                        timeSlot: record.timeSlot,
                        technician: record.technician,
                        installationStatus: record.installationStatus,
                        cancelReason: record.cancelReason,
                        note: record.note,
                    })) {
                        installationCreates.push(buildCrm1InstallationObject(record, leadId, generateImportId("INST")));
                    }

                    if (record.hasActivityData) {
                        const activityObjects = buildCrm1ActivityObjects(record, leadId);

                        for (const activityObject of activityObjects) {
                            const signature = getActivitySignature(activityObject);

                            if (existingActivitySignatures.has(signature)) {
                                skippedDuplicateActivities++;
                            } else if (activityCreates.length >= maxActivitiesPerRun) {
                                skippedActivityLimit++;
                            } else {
                                activityCreates.push({ object: activityObject, record });
                                existingActivitySignatures.add(signature);
                                createdActivities++;
                                if (createdActivities % 25 === 0) {
                                    console.log("Processed activities:", createdActivities);
                                }
                            }
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

            logCrm1Step(diagnostics, "after computing rows to write", {
                leads_to_insert: leadCreates.length,
                leads_to_update: leadUpdates.length,
                details_to_create: detailCreates.length,
                details_to_update: detailUpdates.length,
                deals_to_create: dealCreates.length,
                deals_to_update: dealUpdates.length,
                installations_to_create: installationCreates.length,
                activities_to_write: activityCreates.length,
                skipped_duplicate_activities: skippedDuplicateActivities,
                skipped_activity_limit: skippedActivityLimit,
            });

            const leadUpdatePlans = leadUpdates
                .map(update => buildCrm1LeadUpdatePlan(leadHeaders, update))
                .filter(Boolean);
            leadsUpdateCandidates = leadUpdates.length;
            leadsSkippedUnchanged = leadUpdates.length - leadUpdatePlans.length;
            skippedLeadUpdateLimit = maxLeadUpdates === null
                ? 0
                : Math.max(0, leadUpdatePlans.length - maxLeadUpdates);
            const leadUpdatePlansToWrite = maxLeadUpdates === null
                ? leadUpdatePlans
                : leadUpdatePlans.slice(0, maxLeadUpdates);
            const detailUpdatePlans = detailUpdates
                .map(update => buildCrm1ObjectUpdatePlan("LEAD_DETAILS", detailHeaders, update))
                .filter(Boolean);
            detailUpdateCandidates = detailUpdates.length;
            detailsSkippedUnchanged = detailUpdates.length - detailUpdatePlans.length;
            skippedDetailUpdateLimit = maxDetailUpdates === null
                ? 0
                : Math.max(0, detailUpdatePlans.length - maxDetailUpdates);
            const detailUpdatePlansToWrite = maxDetailUpdates === null
                ? detailUpdatePlans
                : detailUpdatePlans.slice(0, maxDetailUpdates);
            const dealUpdatePlans = dealUpdates
                .map(update => buildCrm1ObjectUpdatePlan("DEALS", dealHeaders, update))
                .filter(Boolean);
            dealsSkippedDuplicate += dealUpdates.length - dealUpdatePlans.length;

            if (debugOnly) {
                logCrm1Step(diagnostics, "before response", { debug_only: true });
                return res.status(200).json({
                    success: true,
                    dry_run: dryRun,
                    parsed_dry_run: dryRun,
                    debug_only: true,
                    crm1_layout_id: layout.id,
                    source_sheet_name: rawSheet.sheetName,
                    structure_mode: structureMode,
                    header_row_detected: primaryBlock?.headerRow || null,
                    total_rows: totalRows,
                    rows_with_valid_phone: rowsWithValidPhone,
                    skipped_invalid_phone: rowsMissingPhone,
                    leads_to_insert: leadCreates.length,
                    leads_to_update: leadUpdates.length,
                    leads_update_candidates: leadsUpdateCandidates,
                    leads_updated: 0,
                    leads_skipped_unchanged: leadsSkippedUnchanged,
                    lead_update_batches: 0,
                    skipped_lead_update_limit: skippedLeadUpdateLimit,
                    max_lead_updates: maxLeadUpdates,
                    detail_update_candidates: detailUpdateCandidates,
                    details_updated: 0,
                    details_skipped_unchanged: detailsSkippedUnchanged,
                    detail_update_batches: 0,
                    skipped_detail_update_limit: skippedDetailUpdateLimit,
                    max_detail_updates: maxDetailUpdates,
                    deals_to_create: dealCreates.length,
                    deals_updated: 0,
                    deals_skipped_duplicate: dealsSkippedDuplicate,
                    installations_to_create: installationCreates.length,
                    closed_won_leads: closedWonLeads,
                    details_to_write: detailCreates.length + detailUpdates.length,
                    activities_to_write: activityCreates.length,
                    skipped_duplicates: skippedDuplicateActivities,
                    skipped_activity_limit: skippedActivityLimit,
                    failed_rows: failedRows,
                    sample_imported_items: sampleImportedItems,
                    failed_row_samples: failedRowSamples,
                    diagnostics,
                });
            }

            if (canWriteCrm1Scope(writeScope, "leads_only") && leadCreates.length) {
                logCrm1Step(diagnostics, "before writing LEADS_MAIN", {
                    inserts: leadCreates.length,
                    updates: leadUpdates.length,
                });
                try {
                    for (const entry of leadCreates) {
                        logCrm1LeadMainWrite(leadHeaders, entry.object, entry.record, "insert");
                    }
                    await withCrm1Timeout(
                        googleSheets.appendObjects("LEADS_MAIN", leadCreates.map(entry => entry.object)),
                        diagnostics,
                        "write LEADS_MAIN inserts"
                    );
                } catch (err) {
                    if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                    for (const entry of leadCreates) {
                        try {
                            await withCrm1Timeout(
                                googleSheets.appendObjects("LEADS_MAIN", [entry.object]),
                                diagnostics,
                                "write LEADS_MAIN insert fallback"
                            );
                        } catch (rowErr) {
                            if (rowErr.code === "CRM1_IMPORT_TIMEOUT") throw rowErr;
                            failedRows++;
                            insertedLeads--;
                            failedCreatedLeadIds.add(entry.object.lead_id);
                        }
                    }
                }
            }

            if (canWriteCrm1Scope(writeScope, "leads_only")) {
                logCrm1Step(diagnostics, "before writing LEADS_MAIN updates", {
                    candidates: leadsUpdateCandidates,
                    changed: leadUpdatePlans.length,
                    to_write: leadUpdatePlansToWrite.length,
                    skipped_unchanged: leadsSkippedUnchanged,
                    skipped_limit: skippedLeadUpdateLimit,
                });

                const chunkSize = 25;
                for (let i = 0; i < leadUpdatePlansToWrite.length; i += chunkSize) {
                    assertCrm1TimeRemaining(diagnostics, "write LEADS_MAIN update batch");
                    const chunk = leadUpdatePlansToWrite.slice(i, i + chunkSize);
                    try {
                        for (const plan of chunk) {
                            logCrm1LeadMainWrite(leadHeaders, plan.update.object, plan.update.record, "update", plan.rowNumber);
                        }
                        await withCrm1Timeout(
                            batchUpdateCrm1LeadRows(sheets, spreadsheetId, chunk),
                            diagnostics,
                            "write LEADS_MAIN update batch"
                        );
                        leadsUpdated += chunk.length;
                        updatedExistingLeads += chunk.length;
                        leadUpdateBatches++;
                    } catch (err) {
                        if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                        failedRows += chunk.length;
                    }
                }
                logCrm1Step(diagnostics, "after writing LEADS_MAIN", {
                    inserts: leadCreates.length,
                    updates: leadsUpdated,
                    skipped_unchanged: leadsSkippedUnchanged,
                    batches: leadUpdateBatches,
                });
            }

            const detailCreatesToWrite = detailCreates.filter(detail => !failedCreatedLeadIds.has(detail.lead_id));
            if (canWriteCrm1Scope(writeScope, "details_only") && detailCreatesToWrite.length) {
                logCrm1Step(diagnostics, "before writing LEAD_DETAILS", {
                    creates: detailCreatesToWrite.length,
                    updates: detailUpdates.length,
                });
                try {
                    await withCrm1Timeout(
                        googleSheets.appendObjects("LEAD_DETAILS", detailCreatesToWrite),
                        diagnostics,
                        "write LEAD_DETAILS creates"
                    );
                } catch (err) {
                    if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                    for (const detailObject of detailCreatesToWrite) {
                        try {
                            await withCrm1Timeout(
                                googleSheets.appendObjects("LEAD_DETAILS", [detailObject]),
                                diagnostics,
                                "write LEAD_DETAILS create fallback"
                            );
                        } catch (rowErr) {
                            if (rowErr.code === "CRM1_IMPORT_TIMEOUT") throw rowErr;
                            failedRows++;
                        }
                    }
                }
            }

            if (canWriteCrm1Scope(writeScope, "details_only")) {
                logCrm1Step(diagnostics, "before writing LEAD_DETAILS updates", {
                    candidates: detailUpdateCandidates,
                    changed: detailUpdatePlans.length,
                    to_write: detailUpdatePlansToWrite.length,
                    skipped_unchanged: detailsSkippedUnchanged,
                    skipped_limit: skippedDetailUpdateLimit,
                });

                const chunkSize = 25;
                for (let i = 0; i < detailUpdatePlansToWrite.length; i += chunkSize) {
                    assertCrm1TimeRemaining(diagnostics, "write LEAD_DETAILS update batch");
                    const chunk = detailUpdatePlansToWrite.slice(i, i + chunkSize);
                    try {
                        await withCrm1Timeout(
                            batchUpdateCrm1ObjectRows(sheets, spreadsheetId, chunk),
                            diagnostics,
                            "write LEAD_DETAILS update batch"
                        );
                        detailsUpdated += chunk.length;
                        detailUpdateBatches++;
                    } catch (err) {
                        if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                        failedRows += chunk.length;
                    }
                }
                logCrm1Step(diagnostics, "after writing LEAD_DETAILS", {
                    creates: detailCreatesToWrite.length,
                    updates: detailsUpdated,
                    skipped_unchanged: detailsSkippedUnchanged,
                    batches: detailUpdateBatches,
                });
            }

            if (writeScope === "all" && (dealCreates.length || dealUpdatePlans.length)) {
                logCrm1Step(diagnostics, "before writing DEALS", {
                    creates: dealCreates.length,
                    updates: dealUpdatePlans.length,
                    skipped_duplicate: dealsSkippedDuplicate,
                });

                if (dealCreates.length) {
                    try {
                        await withCrm1Timeout(
                            googleSheets.appendObjects("DEALS", dealCreates),
                            diagnostics,
                            "write DEALS creates"
                        );
                    } catch (err) {
                        if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                        failedRows += dealCreates.length;
                        dealsToCreate -= dealCreates.length;
                    }
                }

                const chunkSize = 25;
                for (let i = 0; i < dealUpdatePlans.length; i += chunkSize) {
                    assertCrm1TimeRemaining(diagnostics, "write DEALS update batch");
                    const chunk = dealUpdatePlans.slice(i, i + chunkSize);
                    try {
                        await withCrm1Timeout(
                            batchUpdateCrm1ObjectRows(sheets, spreadsheetId, chunk),
                            diagnostics,
                            "write DEALS update batch"
                        );
                        dealsUpdated += chunk.length;
                    } catch (err) {
                        if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                        failedRows += chunk.length;
                    }
                }

                logCrm1Step(diagnostics, "after writing DEALS", {
                    creates: dealCreates.length,
                    updates: dealsUpdated,
                    skipped_duplicate: dealsSkippedDuplicate,
                });
            }

            const installationCreatesToWrite = installationCreates.filter(installation => !installation.lead_id || !failedCreatedLeadIds.has(installation.lead_id));
            if (canWriteCrm1Scope(writeScope, "installations_only") && installationCreatesToWrite.length) {
                logCrm1Step(diagnostics, "before writing INSTALLATIONS", {
                    creates: installationCreatesToWrite.length,
                });
                try {
                    await withCrm1Timeout(
                        googleSheets.appendObjects("INSTALLATIONS", installationCreatesToWrite),
                        diagnostics,
                        "write INSTALLATIONS creates"
                    );
                    logCrm1Step(diagnostics, "after writing INSTALLATIONS", {
                        creates: installationCreatesToWrite.length,
                    });
                } catch (err) {
                    if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                    failedRows += installationCreatesToWrite.length;
                }
            }

            const activityCreatesToWrite = activityCreates.filter(entry => !failedCreatedLeadIds.has(entry.object.lead_id));
            if (canWriteCrm1Scope(writeScope, "activities_only") && activityCreatesToWrite.length) {
                logCrm1Step(diagnostics, "before writing ACTIVITY_LOG", {
                    activities: activityCreatesToWrite.length,
                });
                try {
                    for (const entry of activityCreatesToWrite) {
                        logCrm1ActivityWrite(activityHeaders, entry.object, entry.record);
                    }
                    await withCrm1Timeout(
                        appendCrm1ActivityRows(sheets, spreadsheetId, activityRows, activityHeaders, activityCreatesToWrite),
                        diagnostics,
                        "write ACTIVITY_LOG"
                    );
                    console.log("Processed activities:", activityCreatesToWrite.length);
                    logCrm1Step(diagnostics, "after writing ACTIVITY_LOG", {
                        activities: activityCreatesToWrite.length,
                    });
                } catch (err) {
                    if (err.code === "CRM1_IMPORT_TIMEOUT") throw err;
                    failedRows += activityCreatesToWrite.length;
                    createdActivities -= activityCreatesToWrite.length;
                }
            }
        }

        logCrm1Step(diagnostics, "before response");
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
            real_import_implemented: layout.realImportEnabled !== false,
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
            leads_update_candidates: leadsUpdateCandidates,
            leads_updated: leadsUpdated,
            leads_skipped_unchanged: leadsSkippedUnchanged,
            lead_update_batches: leadUpdateBatches,
            skipped_lead_update_limit: skippedLeadUpdateLimit,
            max_lead_updates: maxLeadUpdates,
            detail_update_candidates: detailUpdateCandidates,
            details_updated: detailsUpdated,
            details_skipped_unchanged: detailsSkippedUnchanged,
            detail_update_batches: detailUpdateBatches,
            skipped_detail_update_limit: skippedDetailUpdateLimit,
            max_detail_updates: maxDetailUpdates,
            created_activities: createdActivities,
            skipped_duplicate_activities: skippedDuplicateActivities,
            skipped_activity_limit: skippedActivityLimit,
            max_activities_per_run: maxActivitiesPerRun,
            deals_to_create: dryRun && !debugOnly ? wouldCreateDeal : dealsToCreate,
            deals_updated: dealsUpdated,
            deals_skipped_duplicate: dealsSkippedDuplicate,
            installations_to_create: dryRun && !debugOnly ? wouldCreateInstallation : installationCreates.length,
            closed_won_leads: closedWonLeads,
            debug_only: debugOnly,
            write_scope: writeScope,
            skipped_invalid_phone: rowsMissingPhone,
            mapping_rules_loaded: mappingRules.loadedCount,
            mapping_rule_types_loaded: mappingRules.ruleTypes,
            sample_preview_items: samplePreviewItems,
            sample_imported_items: sampleImportedItems,
            sample_audio_items: sampleAudioItems,
            skipped_block_details: skippedBlocks,
            failed_row_samples: failedRowSamples,
            diagnostics,
        });
    } catch (err) {
        const isTimeout = err.code === "CRM1_IMPORT_TIMEOUT";
        logCrm1Step(diagnostics, isTimeout ? "timeout before response" : "error before response", {
            error: err.message,
            failed_step: err.step || "",
        });

        return res.status(isTimeout ? 504 : 500).json({
            success: false,
            dry_run: dryRun,
            parsed_dry_run: dryRun,
            debug_only: debugOnly,
            write_scope: writeScope,
            source_sheet_name: "IMPORT_RAW_CRM1",
            source_sheet_found: false,
            timeout: isTimeout,
            failed_step: err.step || "",
            error: err.message,
            diagnostics,
        });
    }
}

module.exports = { handleLegacyCrm1Import };
