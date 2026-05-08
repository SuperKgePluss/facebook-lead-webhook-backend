const googleSheets = require("../googleSheets");
const {
    parseDryRunParam,
    normalizeImportText,
    normalizeByMappingRules,
    mapLegacySource,
    mapLegacyStatus,
    mapLegacyReason,
    normalizeLegacyProvince,
    normalizeLegacyZone,
    normalizeLegacyImportPhone,
    parseLegacyDateValue,
    loadMappingRules,
    readFirstAvailableSheet,
    rowHasAnyValue,
    hasAnyValue,
    extractUrls,
} = require("./importUtils");

const DEFAULT_CRM1_SOURCE_BLOCK = "Priority Leads";

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

const CRM1_FIELD_ALIASES = {
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

function findHeaderMatches(headers, fieldName) {
    const aliases = CRM1_FIELD_ALIASES[fieldName] || [];
    const matches = [];

    headers.forEach((headerText, index) => {
        const text = String(headerText || "").trim();
        if (!text) return;

        const matchedAlias = aliases.find(alias => headerMatchesAlias(text, alias));
        if (!matchedAlias) return;

        matches.push({
            field_name: fieldName,
            column_index: index + 1,
            zero_based_index: index,
            header_text: text,
            matched_alias: matchedAlias,
        });
    });

    return matches;
}

function buildHeaderMap(headers) {
    const mappedHeaders = [];
    const headerMap = {};

    for (const fieldName of Object.keys(CRM1_FIELD_ALIASES)) {
        const matches = findHeaderMatches(headers, fieldName);
        if (!matches.length) continue;

        headerMap[fieldName] = matches[0];
        mappedHeaders.push(matches[0]);

        if (fieldName === "audio") {
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

function buildCrm1Blocks(rows) {
    const markerDetectionDebug = buildMarkerDetectionDebug(rows);
    const firstCell = String(rows[0]?.[0] || "").trim();
    const firstCellMarker = matchCrm1AnyMarker(firstCell);

    if (!firstCellMarker) {
        return {
            parsedBlocks: [{
                marker: DEFAULT_CRM1_SOURCE_BLOCK,
                normalizedMarker: DEFAULT_CRM1_SOURCE_BLOCK,
                markerMatch: { matchedAs: DEFAULT_CRM1_SOURCE_BLOCK, matchReason: "default_row_1_header", confidence: 1, type: "import" },
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

async function handleLegacyCrm1Import(req, res) {
    const dryRun = parseDryRunParam(req);

    try {
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
        const rawSheet = await readFirstAvailableSheet(googleSheets, sheets, spreadsheetId, ["IMPORT_RAW_CRM1"]);
        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];
        const mappingRules = await loadMappingRules(googleSheets);
        const { parsedBlocks, skippedBlocks, markerDetectionDebug, structureMode } = buildCrm1Blocks(rawSheet.rows);
        const primaryBlock = parsedBlocks[0] || null;
        const primaryHeaderInfo = primaryBlock ? buildHeaderMap(primaryBlock.headers) : { headerMap: {}, mappedHeaders: [] };
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
        const failedRowSamples = [];

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

        for (let i = 2; i < leadsRows.length; i++) {
            const leadObject = googleSheets.rowToObject(leadHeaders, leadsRows[i]);
            const existingPhone = normalizeLegacyImportPhone(leadObject.phone, googleSheets);
            if (!existingPhone) continue;
            knownLeadsByPhone.set(existingPhone, { ...leadObject, rowNumber: i + 1 });
        }

        for (const block of parsedBlocks) {
            const { headerMap } = buildHeaderMap(block.headers);

            for (const dataRow of block.dataRows) {
                if (!rowHasAnyValue(dataRow.row)) continue;

                totalRows++;

                try {
                    const customerName = getCrm1Value(dataRow.row, headerMap, "customer_name");
                    const phone = getCrm1Value(dataRow.row, headerMap, "phone");
                    const source = getCrm1Value(dataRow.row, headerMap, "source");
                    const customerType = getCrm1Value(dataRow.row, headerMap, "customer_type");
                    const stage = getCrm1Value(dataRow.row, headerMap, "stage");
                    const rawReason = getCrm1Value(dataRow.row, headerMap, "reason") || getCrm1Value(dataRow.row, headerMap, "cancel_reason");
                    const note = getCrm1Value(dataRow.row, headerMap, "note") || getCrm1Value(dataRow.row, headerMap, "next_step");
                    const rawProvince = getCrm1Value(dataRow.row, headerMap, "province");
                    const rawZone = getCrm1Value(dataRow.row, headerMap, "zone");
                    const productModel = getCrm1Value(dataRow.row, headerMap, "product_model");
                    const deviceCount = getCrm1Value(dataRow.row, headerMap, "device_count");
                    const paymentDate = getCrm1Value(dataRow.row, headerMap, "payment_date");
                    const paymentSlipUrl = getCrm1Value(dataRow.row, headerMap, "payment_slip_url");
                    const price = getCrm1Value(dataRow.row, headerMap, "price");
                    const installDateRaw = getCrm1Value(dataRow.row, headerMap, "install_date");
                    const installTime = getCrm1Value(dataRow.row, headerMap, "install_time");
                    const installStatus = getCrm1Value(dataRow.row, headerMap, "install_status");
                    const address = getCrm1Value(dataRow.row, headerMap, "address");
                    const lastContactDateRaw = getCrm1Value(dataRow.row, headerMap, "last_contact_date");
                    const nextStepDateRaw = getCrm1Value(dataRow.row, headerMap, "next_step_date");
                    const contactMethod = getCrm1Value(dataRow.row, headerMap, "contact_method");
                    const followUpCount = getCrm1Value(dataRow.row, headerMap, "follow_up_count");
                    const normalizedPhone = normalizeLegacyImportPhone(phone, googleSheets);

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
                    const normalizedSource = mapLegacySource(source || block.normalizedMarker || block.marker, mappingRules);
                    const leadStatus = mapLegacyStatus(stage || block.normalizedMarker || block.marker, mappingRules);
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

                    if (samplePreviewItems.length < 30) {
                        samplePreviewItems.push({
                            source_block: block.marker,
                            source_row: dataRow.rowNumber,
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

        return res.status(dryRun ? 200 : 501).json({
            success: dryRun,
            dry_run: dryRun,
            parsed_dry_run: dryRun,
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
            customer_name_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "customer_name"),
            phone_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "phone"),
            source_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "source"),
            note_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "note"),
            audio_header_detected: detectedHeaderDebug(primaryHeaderInfo.headerMap, "audio"),
            real_import_implemented: false,
            message: dryRun ? undefined : "CRM1 real import is not implemented yet. Re-run with dry_run=true for preview only.",
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
            mapping_rules_loaded: mappingRules.loadedCount,
            mapping_rule_types_loaded: mappingRules.ruleTypes,
            sample_preview_items: samplePreviewItems,
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
