const googleSheets = require("../googleSheets");
const {
    parseDryRunParam,
    loadMappingRules,
    readFirstAvailableSheet,
    getLegacyValue,
    hasAnyValue,
    isLegacyAudioHeader,
    extractUrls,
    normalizePaymentSlipLink,
    normalizeLegacyImportPhone,
    normalizeLegacyProvince,
    normalizeLegacyZone,
    normalizeMultiByMappingRules,
    mapLegacySource,
    normalizeLegacyLeadStatusValue,
    mapLegacyReason,
    parseLegacyDateValue,
    formatLegacyDateForSheet,
    generateImportId,
    putIfBlank,
} = require("./importUtils");

const LEGACY_IMPORT_FIELD_ALIASES = {
    source: ["Source"],
    lead_in_date: ["Lead In Date"],
    salesperson: ["Salesperson"],
    name: ["Name"],
    phone_number: ["Phone Number", "Phone", "Mobile Phone"],
    province: ["Province"],
    corporate_name: ["Corporate Name (if B2B)", "Corporate Name"],
    preferred_call_day: ["Preferred Call Day"],
    preferred_call_time: ["Preferred Call Time"],
    classification: ["Classification"],
    reason: ["Reason"],
    follow_up_1_date_time: ["Follow-up 1 Date/Time", "Follow up 1 Date/Time"],
    follow_up_1_details: ["Follow-up 1 Details", "Follow up 1 Details"],
    follow_up_2_date_time: ["Follow-up 2 Date/Time", "Follow up 2 Date/Time"],
    follow_up_2_details: ["Follow-up 2 Details", "Follow up 2 Details"],
    follow_up_3_date_time: ["Follow-up 3 Date/Time", "Follow up 3 Date/Time"],
    follow_up_3_details: ["Follow-up 3 Details", "Follow up 3 Details"],
    call_recording: ["Call Recording"],
    number_of_devices_bought: ["Number of Devices Bought"],
    which_package: ["Which Package"],
    amount_due: ["Amount Due"],
    amount_paid: ["Amount Paid"],
    payment_slip: ["Payment Slip"],
    installation_location: ["Installation Location"],
    installation_details: ["Installation Details"],
    installation_date: ["Installation Date"],
    installation_time: ["Installation Time"],
};

const CRM2_FOLLOW_UP_AUDIT_COLUMNS = [
    { index: 11, letter: "L", expectedHeader: "Follow-up 1 Date/Time" },
    { index: 12, letter: "M", expectedHeader: "Follow-up 1 Details" },
    { index: 13, letter: "N", expectedHeader: "Follow-up 3 Date/Time" },
    { index: 14, letter: "O", expectedHeader: "Follow-up 3 Details" },
];

function getCrm2Value(rowObject, fieldName) {
    return getLegacyValue(rowObject, googleSheets, LEGACY_IMPORT_FIELD_ALIASES, fieldName);
}

function normalizeCrm2AuditText(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function columnToLetter(columnNumber) {
    let column = Number(columnNumber);
    let letter = "";

    while (column > 0) {
        const remainder = (column - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        column = Math.floor((column - remainder - 1) / 26);
    }

    return letter;
}

function buildExistingActivityTextIndex(activityRows) {
    const headers = activityRows[0] || [];
    const index = new Map();

    for (let i = 2; i < activityRows.length; i++) {
        const activity = googleSheets.rowToObject(headers, activityRows[i]);
        const leadId = String(activity.lead_id || "").trim();
        const note = normalizeCrm2AuditText(activity.note);
        if (!leadId || !note) continue;

        if (!index.has(leadId)) index.set(leadId, []);
        index.get(leadId).push(note);
    }

    return index;
}

function isPossibleDuplicateLegacyFollowUp(existingNotes, rawValue, sourceColumnName) {
    const normalizedRaw = normalizeCrm2AuditText(rawValue);
    if (!normalizedRaw) return false;

    const prefixed = normalizeCrm2AuditText(`[CRM2 ${sourceColumnName}] ${rawValue}`);
    return (existingNotes || []).some(note => (
        note === normalizedRaw
        || note === prefixed
        || note.includes(normalizedRaw)
        || normalizedRaw.includes(note)
    ));
}

function buildCrm2FollowUpAuditCandidate({
    sourceRowNumber,
    sourceColumnLetter,
    sourceColumnIndex,
    sourceColumnName,
    rawValue,
    rawPhone,
    cleanPhone,
    existingLead,
    customerName,
    existingActivityTextByLeadId,
    candidateType,
}) {
    const leadId = existingLead?.lead_id || "";
    const existingNotes = leadId ? existingActivityTextByLeadId.get(leadId) || [] : [];
    const possibleDuplicate = Boolean(leadId && isPossibleDuplicateLegacyFollowUp(existingNotes, rawValue, sourceColumnName));

    return {
        source_row_number: sourceRowNumber,
        source_column_letter: sourceColumnLetter,
        source_column_index: sourceColumnIndex,
        source_column_name: sourceColumnName,
        candidate_type: candidateType || "legacy_follow_up_cell",
        raw_text: rawValue,
        raw_phone: rawPhone,
        normalized_phone: cleanPhone,
        phone: cleanPhone,
        customer_name: customerName,
        matched_lead_id: leadId,
        matched_existing_lead: Boolean(leadId),
        duplicate_risk: possibleDuplicate,
        suggested_activity_log_preview: leadId ? {
            lead_id: leadId,
            sheet_name: "CRM2 Legacy Import",
            action_type: "Legacy Follow-up",
            note: `[CRM2 ${sourceColumnName}]\n${rawValue}`,
            created_by: "CRM2 Import",
        } : null,
    };
}

function buildCrm2FollowUpAudit(rawRows, rawHeaders, knownLeadsByPhone, existingActivityTextByLeadId) {
    const audit = {
        audit_only_no_writes: true,
        source_columns: CRM2_FOLLOW_UP_AUDIT_COLUMNS.map(column => ({
            column_letter: column.letter,
            column_index: column.index + 1,
            header: String(rawHeaders[column.index] || column.expectedHeader || "").trim(),
        })),
        total_crm2_rows_scanned: 0,
        rows_with_any_l_to_o_value: 0,
        rows_with_any_follow_up_candidate: 0,
        total_follow_up_cells_found: 0,
        call_recording_text_cells_found: 0,
        matched_existing_leads_by_phone: 0,
        unmatched_phone_rows: 0,
        candidate_activity_log_entries: 0,
        possible_duplicates: 0,
        unmatched_phone_row_details: [],
        possible_duplicate_details: [],
        invalid_call_recording_text_candidates: [],
        all_candidate_details: [],
        sample_candidates: [],
    };

    for (let i = 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || row.every(cell => String(cell || "").trim() === "")) continue;

        audit.total_crm2_rows_scanned++;

        const rowObject = googleSheets.rowToObject(rawHeaders, row);
        const phone = getCrm2Value(rowObject, "phone_number");
        const cleanPhone = normalizeLegacyImportPhone(phone, googleSheets);
        const existingLead = cleanPhone ? knownLeadsByPhone.get(cleanPhone) : null;
        const customerName = getCrm2Value(rowObject, "name");
        const nonEmptyFollowUpCells = CRM2_FOLLOW_UP_AUDIT_COLUMNS
            .map(column => ({
                ...column,
                header: String(rawHeaders[column.index] || column.expectedHeader || `Column ${column.letter}`).trim(),
                raw_value: String(row[column.index] || "").trim(),
            }))
            .filter(item => item.raw_value);

        const callRecordingTextCells = rawHeaders
            .map((header, index) => ({
                index,
                letter: columnToLetter(index + 1),
                header: String(header || `Column ${columnToLetter(index + 1)}`).trim(),
                raw_value: String(row[index] || "").trim(),
            }))
            .filter(item => (
                item.raw_value
                && isLegacyAudioHeader(googleSheets.normalizeHeaderName(item.header))
                && !extractUrls(item.raw_value).length
            ));

        const auditCells = nonEmptyFollowUpCells.map(cell => ({
            ...cell,
            candidate_type: "legacy_follow_up_l_to_o",
        })).concat(callRecordingTextCells.map(cell => ({
            ...cell,
            candidate_type: "call_recording_text_note",
        })));

        if (!auditCells.length) continue;

        audit.rows_with_any_follow_up_candidate++;
        if (nonEmptyFollowUpCells.length) audit.rows_with_any_l_to_o_value++;
        if (existingLead?.lead_id) audit.matched_existing_leads_by_phone++;
        else audit.unmatched_phone_rows++;

        for (const cell of auditCells) {
            audit.total_follow_up_cells_found++;

            const candidate = buildCrm2FollowUpAuditCandidate({
                sourceRowNumber: i + 1,
                sourceColumnLetter: cell.letter,
                sourceColumnIndex: cell.index + 1,
                sourceColumnName: cell.header,
                rawValue: cell.raw_value,
                rawPhone: phone,
                cleanPhone,
                existingLead,
                customerName,
                existingActivityTextByLeadId,
                candidateType: cell.candidate_type,
            });

            if (candidate.matched_lead_id) audit.candidate_activity_log_entries++;
            if (candidate.duplicate_risk) {
                audit.possible_duplicates++;
                audit.possible_duplicate_details.push(candidate);
            }
            if (!candidate.matched_lead_id) audit.unmatched_phone_row_details.push(candidate);
            if (cell.candidate_type === "call_recording_text_note") {
                audit.call_recording_text_cells_found++;
                audit.invalid_call_recording_text_candidates.push(candidate);
            }
            audit.all_candidate_details.push(candidate);

            if (audit.sample_candidates.length < 20) {
                audit.sample_candidates.push(candidate);
            }
        }
    }

    return audit;
}

function summarizeCrm2FollowUpCandidatesByRow(candidates) {
    const byKey = new Map();

    for (const candidate of candidates || []) {
        const key = `${candidate.source_row_number}|${candidate.phone || ""}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                source_row_number: candidate.source_row_number,
                raw_phone: candidate.raw_phone,
                normalized_phone: candidate.normalized_phone,
                phone: candidate.normalized_phone,
                customer_name: candidate.customer_name,
                matched_lead_id: candidate.matched_lead_id,
                matched_existing_lead: candidate.matched_existing_lead,
                duplicate_risk: false,
                candidate_count: 0,
                raw_crm2_values: [],
            });
        }

        const item = byKey.get(key);
        item.duplicate_risk = item.duplicate_risk || Boolean(candidate.duplicate_risk);
        item.candidate_count++;
        item.raw_crm2_values.push({
            source_column_letter: candidate.source_column_letter,
            source_column_index: candidate.source_column_index,
            source_column_name: candidate.source_column_name,
            candidate_type: candidate.candidate_type,
            raw_text: candidate.raw_text,
        });
    }

    return Array.from(byKey.values()).sort((a, b) => a.source_row_number - b.source_row_number);
}

function buildCrm2FollowUpCandidatesByRow(candidates) {
    const byRow = new Map();

    for (const candidate of candidates || []) {
        if (!byRow.has(candidate.source_row_number)) byRow.set(candidate.source_row_number, []);
        byRow.get(candidate.source_row_number).push({
            target_sheet: "ACTIVITY_LOG",
            action: "would_create_legacy_follow_up_activity",
            lead_id: candidate.matched_lead_id || "(unmatched phone)",
            source_row_number: candidate.source_row_number,
            raw_phone: candidate.raw_phone,
            normalized_phone: candidate.normalized_phone,
            customer_name: candidate.customer_name,
            source_column_letter: candidate.source_column_letter,
            source_column_index: candidate.source_column_index,
            source_column_name: candidate.source_column_name,
            candidate_type: candidate.candidate_type,
            action_type: "Legacy Follow-up",
            note: `[CRM2 ${candidate.source_column_name}]\n${candidate.raw_text}`,
            raw_text: candidate.raw_text,
            duplicate_risk: candidate.duplicate_risk,
            import_enabled: false,
        });
    }

    return byRow;
}

function parseCrm2FollowUpLogOnlyMode(req) {
    const rawMode = String(req.query.mode || "").trim().toLowerCase();
    const rawFlag = String(req.query.crm2_followup_log_only ?? req.query.followup_log_only ?? "").trim().toLowerCase();
    return rawMode === "crm2_followup_log_only" || rawFlag === "true" || rawFlag === "1";
}

function parseCrm2ConfirmWrite(req) {
    const rawConfirm = String(req.query.confirm || "").trim().toLowerCase();
    return rawConfirm === "true" || rawConfirm === "1" || rawConfirm === "yes";
}

function parseCrm2BooleanQuery(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;

    const raw = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(raw)) return true;
    if (["false", "0", "no", "n"].includes(raw)) return false;
    return fallback;
}

function parseCrm2SampleLimit(value, fallback = 5) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(Math.floor(parsed), 50);
}

function buildSafeCrm2ReceivedQuery(query = {}, options = {}) {
    const redact = options.redact !== false;

    return Object.entries(query || {}).reduce((safeQuery, [key, value]) => {
        const normalizedKey = String(key || "").trim().toLowerCase();
        if (normalizedKey === "secret") {
            safeQuery[key] = "<redacted>";
            return safeQuery;
        }

        safeQuery[key] = redact ? redactCrm2SensitiveValue(value, options.secret) : value;
        return safeQuery;
    }, {});
}

function redactCrm2SensitiveValue(value, secret = "") {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(item => redactCrm2SensitiveValue(item, secret));
    if (typeof value === "object") {
        return Object.entries(value).reduce((object, [key, item]) => {
            object[key] = redactCrm2SensitiveValue(item, secret);
            return object;
        }, {});
    }

    let text = String(value);
    const secretText = String(secret || "").trim();
    if (secretText) {
        text = text.split(secretText).join("<redacted>");
    }

    return text
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted_email>")
        .replace(/(?:\+?66|0)[\d\s().-]{8,16}/g, "<redacted_phone>");
}

function truncateCrm2Text(value, maxLength = 160) {
    const text = String(value || "").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function sanitizeCrm2CandidateSample(candidate = {}, options = {}) {
    return {
        source_row_number: candidate.source_row_number || "",
        source_column_letter: candidate.source_column_letter || "",
        source_column_name: candidate.source_column_name || "",
        candidate_type: candidate.candidate_type || "",
        matched_lead_id: candidate.matched_lead_id || "",
        matched_existing_lead: Boolean(candidate.matched_existing_lead),
        duplicate_risk: Boolean(candidate.duplicate_risk),
        reason_skipped: candidate.reason_skipped || "",
        raw_phone: redactCrm2SensitiveValue(candidate.raw_phone || "", options.secret),
        normalized_phone: redactCrm2SensitiveValue(candidate.normalized_phone || candidate.phone || "", options.secret),
        raw_text_preview: truncateCrm2Text(redactCrm2SensitiveValue(candidate.raw_text || candidate.note || "", options.secret)),
    };
}

function sampleCrm2Candidates(candidates, sampleLimit, options = {}) {
    return (candidates || [])
        .slice(0, sampleLimit)
        .map(candidate => sanitizeCrm2CandidateSample(candidate, options));
}

function buildCrm2FollowUpLogOnlyResponse({
    req,
    dryRun,
    rawSheet,
    crm2FollowUpAudit,
    logOnlyPlan,
    matchedCandidates,
    wouldCreateLeadRowsSkipped,
    appendedActivities,
    failedActivityRows,
    failedActivitySamples,
}) {
    const summaryOnly = parseCrm2BooleanQuery(req.query.summary_only, false);
    const includeDetails = summaryOnly
        ? false
        : parseCrm2BooleanQuery(req.query.include_details, true);
    const redact = parseCrm2BooleanQuery(req.query.redact, dryRun);
    const sampleLimit = parseCrm2SampleLimit(req.query.sample_limit, 5);
    const redactOptions = {
        redact,
        secret: req.query.secret,
    };

    const baseResponse = {
        success: true,
        dry_run: dryRun,
        mode: "crm2_followup_log_only",
        received_query: buildSafeCrm2ReceivedQuery(req.query, redactOptions),
        source_sheet_name: rawSheet.sheetName,
        total_rows_scanned: crm2FollowUpAudit.total_crm2_rows_scanned,
        total_followup_candidates_found: crm2FollowUpAudit.all_candidate_details.length,
        matched_existing_lead_candidates: matchedCandidates.length,
        candidates_to_append: logOnlyPlan.candidates_to_append.length,
        appended_activities: appendedActivities,
        duplicate_candidates_skipped: logOnlyPlan.duplicate_candidates_skipped.length,
        unmatched_phone_candidates_skipped: logOnlyPlan.unmatched_candidates_skipped.length,
        would_create_lead_rows_skipped: wouldCreateLeadRowsSkipped.length,
        internal_duplicate_candidates_skipped: logOnlyPlan.internal_duplicate_candidates_skipped.length,
        failed_activity_rows: failedActivityRows,
        no_leads_created: true,
        no_leads_updated: true,
        no_lead_details_updated: true,
        no_deals_updated: true,
        no_installations_updated: true,
        write_guard: dryRun
            ? "dry_run=true; no writes performed"
            : "log-only write completed; only ACTIVITY_LOG append was allowed",
    };

    const samples = {
        sample_limit: sampleLimit,
        matched_candidate_samples: sampleCrm2Candidates(matchedCandidates, sampleLimit, redactOptions),
        candidates_to_append_samples: sampleCrm2Candidates(logOnlyPlan.candidates_to_append, sampleLimit, redactOptions),
        unmatched_candidate_samples: sampleCrm2Candidates(logOnlyPlan.unmatched_candidates_skipped, sampleLimit, redactOptions),
        duplicate_risk_candidate_samples: sampleCrm2Candidates(logOnlyPlan.duplicate_candidates_skipped, sampleLimit, redactOptions),
        internal_duplicate_candidate_samples: sampleCrm2Candidates(logOnlyPlan.internal_duplicate_candidates_skipped, sampleLimit, redactOptions),
        failed_candidate_samples: (failedActivitySamples || []).slice(0, sampleLimit).map(sample => redactCrm2SensitiveValue(sample, req.query.secret)),
    };

    if (summaryOnly || !includeDetails) {
        return {
            ...baseResponse,
            ...samples,
        };
    }

    return {
        ...baseResponse,
        ...samples,
        candidates_matched_to_existing_lead_id: matchedCandidates,
        candidates_to_append_details: logOnlyPlan.candidates_to_append,
        duplicate_candidates_skipped_details: logOnlyPlan.duplicate_candidates_skipped,
        unmatched_phone_rows_skipped_details: summarizeCrm2FollowUpCandidatesByRow(logOnlyPlan.unmatched_candidates_skipped),
        unmatched_phone_candidates_skipped_details: logOnlyPlan.unmatched_candidates_skipped,
        would_create_lead_rows_skipped_details: wouldCreateLeadRowsSkipped,
        internal_duplicate_candidates_skipped_details: logOnlyPlan.internal_duplicate_candidates_skipped,
        failed_activity_samples: failedActivitySamples,
        crm2_followup_l_to_o_audit: crm2FollowUpAudit,
    };
}

function buildCrm2WouldCreateLeadRows(rawRows, rawHeaders, knownLeadsByPhone, candidateSourceRows = null) {
    const rows = [];

    for (let i = 1; i < rawRows.length; i++) {
        const sourceRowNumber = i + 1;
        if (candidateSourceRows && !candidateSourceRows.has(sourceRowNumber)) continue;

        const row = rawRows[i];
        if (!row || row.every(cell => String(cell || "").trim() === "")) continue;

        const rowObject = googleSheets.rowToObject(rawHeaders, row);
        const rawPhone = getCrm2Value(rowObject, "phone_number");
        const cleanPhone = normalizeLegacyImportPhone(rawPhone, googleSheets);
        if (!cleanPhone || knownLeadsByPhone.has(cleanPhone)) continue;

        rows.push({
            source_row_number: sourceRowNumber,
            customer_name: getCrm2Value(rowObject, "name"),
            raw_phone: rawPhone,
            normalized_phone: cleanPhone,
            matched_lead_id: "",
            matched_existing_lead: false,
            reason_skipped: "would_create_new_lead_not_allowed_in_log_only_mode",
            raw_crm2_values: rowObject,
        });
    }

    return rows;
}

function buildCrm2FollowUpLogOnlyPlan(crm2FollowUpAudit) {
    const candidatesToAppend = [];
    const duplicateCandidatesSkipped = [];
    const unmatchedCandidatesSkipped = [];
    const internalDuplicateCandidatesSkipped = [];
    const seenPlannedNotes = new Set();

    for (const candidate of crm2FollowUpAudit.all_candidate_details || []) {
        if (!candidate.matched_lead_id) {
            unmatchedCandidatesSkipped.push({
                ...candidate,
                reason_skipped: "unmatched_phone_no_existing_lead_id",
            });
            continue;
        }

        if (candidate.duplicate_risk) {
            duplicateCandidatesSkipped.push({
                ...candidate,
                reason_skipped: "possible_duplicate_existing_activity_note",
            });
            continue;
        }

        const note = `[CRM2 ${candidate.source_column_name}]\n${candidate.raw_text}`;
        const plannedKey = `${candidate.matched_lead_id}|${normalizeCrm2AuditText(note)}`;
        if (seenPlannedNotes.has(plannedKey)) {
            internalDuplicateCandidatesSkipped.push({
                ...candidate,
                reason_skipped: "duplicate_within_current_crm2_log_only_batch",
            });
            continue;
        }
        seenPlannedNotes.add(plannedKey);

        candidatesToAppend.push({
            ...candidate,
            note,
            activity_object: {
                activity_id: generateImportId("ACT"),
                lead_id: candidate.matched_lead_id,
                sheet_name: "CRM2 Legacy Import",
                action_type: "Legacy Follow-up",
                note,
                created_by: "CRM2 Import",
                created_at: formatLegacyDateForSheet(new Date()),
            },
        });
    }

    return {
        candidates_to_append: candidatesToAppend,
        duplicate_candidates_skipped: duplicateCandidatesSkipped,
        unmatched_candidates_skipped: unmatchedCandidatesSkipped,
        internal_duplicate_candidates_skipped: internalDuplicateCandidatesSkipped,
    };
}

function getLegacyAudioUrls(rowObject, debugCounters) {
    const urls = [];

    for (const [headerName, value] of Object.entries(rowObject)) {
        if (!isLegacyAudioHeader(headerName)) continue;

        const raw = String(value || "").trim();
        if (!raw) continue;

        const extractedUrls = extractUrls(raw);

        if (!extractedUrls.length) {
            debugCounters.audioUrlsSkipped++;
            debugCounters.audioSkipReasons.invalid_audio_url = (debugCounters.audioSkipReasons.invalid_audio_url || 0) + 1;

            if (debugCounters.sampleAudioItems.length < 10) {
                debugCounters.sampleAudioItems.push({
                    header: headerName,
                    action: "skipped",
                    reason: "invalid_audio_url",
                    value: raw,
                });
            }
            continue;
        }

        for (const url of extractedUrls) {
            if (urls.includes(url)) continue;

            urls.push(url);
            debugCounters.audioUrlsDetected++;

            if (debugCounters.sampleAudioItems.length < 10) {
                debugCounters.sampleAudioItems.push({
                    header: headerName,
                    action: "detected",
                    audio_url: url,
                });
            }
        }
    }

    return urls;
}

function buildLegacyActivityPreviews(rowObject, leadId, audioUrls, debugCounters) {
    const activities = [];
    const usedAudioUrls = new Set();

    for (const followUpNo of [1, 2, 3]) {
        const details = getCrm2Value(rowObject, `follow_up_${followUpNo}_details`);
        const rawCreatedAt = getCrm2Value(rowObject, `follow_up_${followUpNo}_date_time`);
        const parsedCreatedAt = parseLegacyDateValue(rawCreatedAt);
        let audioUrl = details
            ? audioUrls[followUpNo - 1] || audioUrls.find(url => !usedAudioUrls.has(url)) || ""
            : audioUrls[followUpNo - 1] || "";

        if (parsedCreatedAt.isBlank) {
            debugCounters.blankDateCount++;
        } else if (parsedCreatedAt.isInvalid) {
            debugCounters.invalidDateCount++;
        }

        if (!details && !audioUrl) continue;
        if (audioUrl && usedAudioUrls.has(audioUrl)) audioUrl = "";
        if (audioUrl) usedAudioUrls.add(audioUrl);

        activities.push({
            target_sheet: "ACTIVITY_LOG",
            action: "would_create_activity",
            lead_id: leadId || "(resolved after lead creation)",
            follow_up_no: followUpNo,
            action_type: "Follow-up",
            note: details,
            audio_url: audioUrl,
            created_at: parsedCreatedAt.value,
            raw_created_at: parsedCreatedAt.isInvalid ? "" : rawCreatedAt,
        });
    }

    audioUrls.forEach((audioUrl, index) => {
        if (usedAudioUrls.has(audioUrl)) return;

        activities.push({
            target_sheet: "ACTIVITY_LOG",
            action: "would_create_activity",
            lead_id: leadId || "(resolved after lead creation)",
            follow_up_no: activities.length + 1 || index + 1,
            action_type: "Follow-up",
            note: "",
            audio_url: audioUrl,
            created_at: "",
            raw_created_at: "",
        });
    });

    debugCounters.audioActivitiesCreated += activities.filter(activity => activity.audio_url).length;
    return activities;
}

function buildLegacyLeadObject(values, cleanPhone, leadId, existingLeadObject = null) {
    if (!existingLeadObject) {
        return {
            lead_id: leadId,
            open_deal: false,
            customer_name: values.name,
            phone: cleanPhone,
            source: values.source,
            customer_type: values.corporateName,
            province: values.province,
            zone: values.zone,
            save_follow_up: false,
            preferred_call_day: values.preferredCallDay,
            preferred_call_time: values.preferredCallTime,
            lead_status: values.leadStatus,
            sales_owner: values.salesperson,
            created_at: values.leadInDate,
            updated_at: values.updatedAt,
        };
    }

    const updateObject = { updated_at: values.updatedAt };

    putIfBlank(updateObject, existingLeadObject, "customer_name", values.name);
    putIfBlank(updateObject, existingLeadObject, "phone", cleanPhone);
    putIfBlank(updateObject, existingLeadObject, "source", values.source);
    putIfBlank(updateObject, existingLeadObject, "customer_type", values.corporateName);
    putIfBlank(updateObject, existingLeadObject, "province", values.province);
    putIfBlank(updateObject, existingLeadObject, "zone", values.zone);
    putIfBlank(updateObject, existingLeadObject, "preferred_call_day", values.preferredCallDay);
    putIfBlank(updateObject, existingLeadObject, "preferred_call_time", values.preferredCallTime);
    putIfBlank(updateObject, existingLeadObject, "lead_status", values.leadStatus);
    putIfBlank(updateObject, existingLeadObject, "sales_owner", values.salesperson);
    putIfBlank(updateObject, existingLeadObject, "created_at", values.leadInDate);

    return updateObject;
}

function buildLegacyLeadDetailObject(values, leadId, rowObject) {
    return {
        lead_id: leadId,
        raw_phone: values.rawPhone || "",
        raw_province: values.rawProvince,
        original_customer_name: values.name || "",
        created_source: "CRM2 Import",
    };
}

function buildLegacyActivityObjects(activityPreviews, leadId, salesOwner) {
    return activityPreviews.map(activity => ({
        activity_id: generateImportId("ACT"),
        lead_id: leadId,
        sheet_name: "IMPORT",
        action_type: "Follow-up",
        note: activity.note,
        audio_url: activity.audio_url,
        audio_file_name: "",
        created_by: "CRM2 Import",
        created_at: activity.created_at,
    }));
}

async function handleLegacyCrm2Import(req, res) {
    const dryRun = parseDryRunParam(req);
    const crm2FollowUpLogOnly = parseCrm2FollowUpLogOnlyMode(req);
    const confirmWrite = parseCrm2ConfirmWrite(req);

    try {
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
        const rawSheet = await readFirstAvailableSheet(
            googleSheets,
            sheets,
            spreadsheetId,
            ["IMPORT_RAW_CRM2", "IMPORT_RAW"]
        );
        const rawRows = rawSheet.rows;
        const leadsRows = await googleSheets.getSheetRows("LEADS_MAIN");
        const leadHeaders = leadsRows[0] || [];
        const detailRows = await googleSheets.getSheetRows("LEAD_DETAILS");
        const detailHeaders = detailRows[0] || [];
        const activityRows = await googleSheets.getSheetRows("ACTIVITY_LOG");
        const existingActivityTextByLeadId = buildExistingActivityTextIndex(activityRows);
        const mappingRules = await loadMappingRules(googleSheets);
        const rawHeaders = rawRows[0] || [];
        const detectedHeaders = rawHeaders.map(header => String(header || "").trim()).filter(Boolean);
        const expectedHeaderKeys = new Set(
            Object.values(LEGACY_IMPORT_FIELD_ALIASES).flat().map(header => googleSheets.normalizeHeaderName(header))
        );
        const presentHeaderKeys = new Set(detectedHeaders.map(header => googleSheets.normalizeHeaderName(header)));
        const missingExpectedHeaders = Object.entries(LEGACY_IMPORT_FIELD_ALIASES)
            .filter(([, aliases]) => !aliases.some(alias => presentHeaderKeys.has(googleSheets.normalizeHeaderName(alias))))
            .map(([fieldName, aliases]) => ({ field: fieldName, accepted_headers: aliases }));
        const ignoredColumns = rawHeaders.map((header, index) => {
            const rawHeader = String(header || "").trim();
            const column = index + 1;

            if (!rawHeader) return { column, header: "", reason: "blank_header" };
            if (!expectedHeaderKeys.has(googleSheets.normalizeHeaderName(rawHeader)) && !isLegacyAudioHeader(googleSheets.normalizeHeaderName(rawHeader))) {
                return { column, header: rawHeader, reason: "unmapped_header" };
            }

            return null;
        }).filter(Boolean);

        let rowsWithValidPhone = 0;
        let rowsMissingPhone = 0;
        let wouldCreateLead = 0;
        let wouldUpdateExistingLead = 0;
        let wouldCreateDeal = 0;
        let wouldCreateInstallation = 0;
        let wouldCreateActivity = 0;
        let manualReview = 0;
        let insertedLeads = 0;
        let updatedExistingLeads = 0;
        let createdActivities = 0;
        let skippedMissingPhone = 0;
        let skippedDuplicateOrExisting = 0;
        let failedRows = 0;
        let normalizedProvinceCount = 0;
        let invalidProvinceCount = 0;
        let blankDateCount = 0;
        let invalidDateCount = 0;
        let cleanedPreferredCallDayCount = 0;
        let cleanedPreferredCallTimeCount = 0;
        let audioUrlsDetected = 0;
        let audioActivitiesCreated = 0;
        let audioUrlsSkipped = 0;
        const audioSkipReasons = {};
        const samplePreviewItems = [];
        const sampleAudioItems = [];
        const sampleResultItems = [];
        const wouldCreateLeadDetails = [];
        const pendingLeadCreates = [];
        const pendingLeadUpdates = [];
        const pendingLeadDetailCreates = [];
        const pendingLeadDetailUpdates = [];
        const pendingActivityCreates = [];
        const knownLeadsByPhone = new Map();
        const knownLeadDetailsByLeadId = new Map();
        const debugCounters = {
            get blankDateCount() { return blankDateCount; },
            set blankDateCount(value) { blankDateCount = value; },
            get invalidDateCount() { return invalidDateCount; },
            set invalidDateCount(value) { invalidDateCount = value; },
            get audioUrlsDetected() { return audioUrlsDetected; },
            set audioUrlsDetected(value) { audioUrlsDetected = value; },
            get audioActivitiesCreated() { return audioActivitiesCreated; },
            set audioActivitiesCreated(value) { audioActivitiesCreated = value; },
            get audioUrlsSkipped() { return audioUrlsSkipped; },
            set audioUrlsSkipped(value) { audioUrlsSkipped = value; },
            audioSkipReasons,
            sampleAudioItems,
        };

        for (let i = 2; i < leadsRows.length; i++) {
            const leadObject = googleSheets.rowToObject(leadHeaders, leadsRows[i]);
            const existingPhone = normalizeLegacyImportPhone(leadObject.phone, googleSheets);
            if (!existingPhone) continue;
            knownLeadsByPhone.set(existingPhone, { ...leadObject, rowNumber: i + 1 });
        }

        for (let i = 2; i < detailRows.length; i++) {
            const detailObject = googleSheets.rowToObject(detailHeaders, detailRows[i]);
            const detailLeadId = String(detailObject.lead_id || "").trim();
            if (!detailLeadId) continue;
            knownLeadDetailsByLeadId.set(detailLeadId, { ...detailObject, rowNumber: i + 1 });
        }

        const crm2FollowUpAudit = buildCrm2FollowUpAudit(
            rawRows,
            rawHeaders,
            knownLeadsByPhone,
            existingActivityTextByLeadId
        );
        const crm2FollowUpAllCandidateRows = summarizeCrm2FollowUpCandidatesByRow(crm2FollowUpAudit.all_candidate_details);
        const crm2FollowUpUnmatchedRows = summarizeCrm2FollowUpCandidatesByRow(crm2FollowUpAudit.unmatched_phone_row_details);
        const crm2FollowUpDuplicateRiskRows = summarizeCrm2FollowUpCandidatesByRow(crm2FollowUpAudit.possible_duplicate_details);
        const crm2FollowUpCandidatesByRow = buildCrm2FollowUpCandidatesByRow(crm2FollowUpAudit.all_candidate_details);

        if (crm2FollowUpLogOnly) {
            if (!dryRun && !confirmWrite) {
                return res.status(400).json({
                    success: false,
                    dry_run: dryRun,
                    mode: "crm2_followup_log_only",
                    error: "confirm=true is required for CRM2 follow-up log-only writes.",
                    no_write_performed: true,
                    required_params_for_real_import: {
                        crm2_followup_log_only: "true",
                        dry_run: "false",
                        confirm: "true",
                    },
                });
            }

            const logOnlyPlan = buildCrm2FollowUpLogOnlyPlan(crm2FollowUpAudit);
            const candidateSourceRows = new Set(
                (crm2FollowUpAudit.all_candidate_details || []).map(candidate => candidate.source_row_number)
            );
            const wouldCreateLeadRowsSkipped = buildCrm2WouldCreateLeadRows(
                rawRows,
                rawHeaders,
                knownLeadsByPhone,
                candidateSourceRows
            );
            const matchedCandidates = (crm2FollowUpAudit.all_candidate_details || [])
                .filter(candidate => candidate.matched_lead_id);
            const activityObjectsToAppend = logOnlyPlan.candidates_to_append
                .map(candidate => candidate.activity_object);
            let appendedActivities = 0;
            let failedActivityRows = 0;
            const failedActivitySamples = [];

            if (!dryRun && activityObjectsToAppend.length) {
                try {
                    await googleSheets.appendObjects("ACTIVITY_LOG", activityObjectsToAppend);
                    appendedActivities = activityObjectsToAppend.length;
                } catch (err) {
                    for (const activityObject of activityObjectsToAppend) {
                        try {
                            await googleSheets.appendObjects("ACTIVITY_LOG", [activityObject]);
                            appendedActivities++;
                        } catch (rowErr) {
                            failedActivityRows++;
                            if (failedActivitySamples.length < 10) {
                                failedActivitySamples.push({
                                    lead_id: activityObject.lead_id,
                                    action_type: activityObject.action_type,
                                    note: activityObject.note,
                                    error: rowErr.message,
                                });
                            }
                        }
                    }
                }
            }

            return res.json(buildCrm2FollowUpLogOnlyResponse({
                req,
                dryRun,
                rawSheet,
                crm2FollowUpAudit,
                logOnlyPlan,
                matchedCandidates,
                wouldCreateLeadRowsSkipped,
                appendedActivities,
                failedActivityRows,
                failedActivitySamples,
            }));
        }

        for (let i = 1; i < rawRows.length; i++) {
            const row = rawRows[i];
            if (!row || row.every(cell => String(cell || "").trim() === "")) continue;

            const rowObject = googleSheets.rowToObject(rawHeaders, row);
            const source = getCrm2Value(rowObject, "source");
            const leadInDate = getCrm2Value(rowObject, "lead_in_date");
            const salesperson = getCrm2Value(rowObject, "salesperson");
            const name = getCrm2Value(rowObject, "name");
            const phone = getCrm2Value(rowObject, "phone_number");
            const province = getCrm2Value(rowObject, "province");
            const corporateName = getCrm2Value(rowObject, "corporate_name");
            const preferredCallDay = getCrm2Value(rowObject, "preferred_call_day");
            const preferredCallTime = getCrm2Value(rowObject, "preferred_call_time");
            const classification = getCrm2Value(rowObject, "classification");
            const reason = getCrm2Value(rowObject, "reason");
            const numberOfDevicesBought = getCrm2Value(rowObject, "number_of_devices_bought");
            const whichPackage = getCrm2Value(rowObject, "which_package");
            const amountDue = getCrm2Value(rowObject, "amount_due");
            const amountPaid = getCrm2Value(rowObject, "amount_paid");
            const paymentSlip = normalizePaymentSlipLink(getCrm2Value(rowObject, "payment_slip"));
            const installationLocation = getCrm2Value(rowObject, "installation_location");
            const installationDetails = getCrm2Value(rowObject, "installation_details");
            const installationDate = getCrm2Value(rowObject, "installation_date");
            const installationTime = getCrm2Value(rowObject, "installation_time");
            const cleanPhone = normalizeLegacyImportPhone(phone, googleSheets);
            const provinceResult = normalizeLegacyProvince(province, mappingRules);
            const cleanedPreferredCallDay = normalizeMultiByMappingRules(mappingRules, "preferred_call_day", preferredCallDay);
            const cleanedPreferredCallTime = normalizeMultiByMappingRules(mappingRules, "preferred_call_time", preferredCallTime);
            const cleanedSource = mapLegacySource(source, mappingRules);
            const cleanedLeadStatus = normalizeLegacyLeadStatusValue(classification, mappingRules, {
                paid: Boolean(String(amountPaid || "").trim()),
            });
            const cleanedReason = mapLegacyReason(reason || classification, mappingRules);
            const cleanedZone = normalizeLegacyZone(provinceResult.province, mappingRules);
            const parsedLeadInDate = parseLegacyDateValue(leadInDate);
            const updatedAt = formatLegacyDateForSheet(new Date());
            const audioUrls = getLegacyAudioUrls(rowObject, debugCounters);

            if (provinceResult.province) normalizedProvinceCount++;
            else if (provinceResult.wasInvalid) invalidProvinceCount++;
            if (String(preferredCallDay || "").trim() && cleanedPreferredCallDay !== preferredCallDay) cleanedPreferredCallDayCount++;
            if (String(preferredCallTime || "").trim() && cleanedPreferredCallTime !== preferredCallTime) cleanedPreferredCallTimeCount++;
            if (parsedLeadInDate.isBlank) blankDateCount++;
            else if (parsedLeadInDate.isInvalid) invalidDateCount++;

            if (!cleanPhone) {
                rowsMissingPhone++;
                manualReview++;
                skippedMissingPhone++;
                if (samplePreviewItems.length < 30) {
                    samplePreviewItems.push({ row: i + 1, action: "manual_review", reason: "missing_or_invalid_phone", raw_data: rowObject });
                }
                if (!dryRun && sampleResultItems.length < 10) {
                    sampleResultItems.push({ row: i + 1, action: "skipped", reason: "missing_or_invalid_phone" });
                }
                continue;
            }

            rowsWithValidPhone++;
            const existingLeadObject = knownLeadsByPhone.get(cleanPhone) || null;

            if (!dryRun && existingLeadObject && !existingLeadObject.rowNumber) {
                skippedDuplicateOrExisting++;
                if (sampleResultItems.length < 10) {
                    sampleResultItems.push({
                        row: i + 1,
                        action: "skipped_duplicate_or_existing",
                        phone: cleanPhone,
                        reason: "duplicate_phone_already_queued_for_import",
                    });
                }
                continue;
            }

            const leadId = existingLeadObject?.lead_id || "";
            const leadAction = existingLeadObject ? "would_update_existing_lead" : "would_create_lead";
            if (existingLeadObject) wouldUpdateExistingLead++;
            else {
                wouldCreateLead++;
                wouldCreateLeadDetails.push({
                    source_row_number: i + 1,
                    raw_phone: phone,
                    normalized_phone: cleanPhone,
                    customer_name: name,
                    matched_lead_id: "",
                    matched_existing_lead: false,
                    create_reason: "no_existing_lead_matched_by_normalized_phone",
                    source: cleanedSource,
                    lead_status: cleanedLeadStatus,
                    sales_owner: salesperson,
                    province: provinceResult.province,
                    zone: cleanedZone,
                    customer_type: corporateName,
                    preferred_call_day: cleanedPreferredCallDay,
                    preferred_call_time: cleanedPreferredCallTime,
                    created_at: parsedLeadInDate.value,
                    raw_crm2_values: rowObject,
                });
            }

            const hasDealData = hasAnyValue({ numberOfDevicesBought, whichPackage, amountDue, amountPaid, paymentSlip });
            const hasInstallationData = hasAnyValue({ installationLocation, installationDetails, installationDate, installationTime });
            const dealPreview = {
                target_sheet: "DEALS",
                action: "would_create_deal",
                lead_id: leadId || "(resolved after lead creation)",
                product_model_or_quantity_preview: numberOfDevicesBought,
                package_type: whichPackage,
                price: amountDue,
                paid_amount_preview: amountPaid,
                payment_status_preview: amountPaid ? "Paid/Partial - review amount" : "",
                payment_slip_url: paymentSlip,
            };
            const installationPreview = {
                target_sheet: "INSTALLATIONS",
                action: "would_create_installation",
                lead_id: leadId || "(resolved after lead creation)",
                zone_or_location_preview: installationLocation,
                note: installationDetails,
                install_date: installationDate,
                install_time: installationTime,
            };
            const activityPreviews = buildLegacyActivityPreviews(rowObject, leadId, audioUrls, debugCounters);
            const legacyFollowUpActivityCandidates = crm2FollowUpCandidatesByRow.get(i + 1) || [];
            const dryRunActivityPreviews = legacyFollowUpActivityCandidates.concat(activityPreviews);

            if (hasDealData) wouldCreateDeal++;
            if (hasInstallationData) wouldCreateInstallation++;
            wouldCreateActivity += dryRun ? dryRunActivityPreviews.length : activityPreviews.length;

            if (samplePreviewItems.length < 30) {
                samplePreviewItems.push({
                    row: i + 1,
                    action: leadAction,
                    existing_lead_id: leadId,
                    normalized_phone: cleanPhone,
                    lead_preview: {
                        target_sheet: "LEADS_MAIN",
                        customer_name: name,
                        phone: cleanPhone,
                        source: cleanedSource,
                        lead_status: cleanedLeadStatus,
                        reason: cleanedReason,
                        sales_owner: salesperson,
                        province: provinceResult.province,
                        zone: cleanedZone,
                        raw_province: provinceResult.rawProvince,
                        customer_type_or_raw_corporate_preview: corporateName,
                        preferred_call_day: cleanedPreferredCallDay,
                        preferred_call_time: cleanedPreferredCallTime,
                        created_at: parsedLeadInDate.value,
                    },
                    deal_preview: hasDealData ? dealPreview : null,
                    installation_preview: hasInstallationData ? installationPreview : null,
                    activity_previews: dryRunActivityPreviews,
                    legacy_followup_activity_candidates: legacyFollowUpActivityCandidates,
                    standard_activity_previews: activityPreviews,
                    raw_data: rowObject,
                });
            }

            if (dryRun && !existingLeadObject) {
                knownLeadsByPhone.set(cleanPhone, { lead_id: "(resolved after lead creation)", phone: cleanPhone });
            }

            if (!dryRun) {
                try {
                    const values = {
                        source: cleanedSource,
                        leadInDate: parsedLeadInDate.value,
                        updatedAt,
                        salesperson,
                        name,
                        province: provinceResult.province,
                        zone: cleanedZone,
                        rawProvince: provinceResult.rawProvince,
                        rawPhone: phone,
                        corporateName,
                        preferredCallDay: cleanedPreferredCallDay,
                        preferredCallTime: cleanedPreferredCallTime,
                        leadStatus: cleanedLeadStatus,
                        reason: cleanedReason,
                    };
                    let resolvedLeadId = leadId;
                    let resultAction = "";

                    if (existingLeadObject) {
                        pendingLeadUpdates.push({ rowNumber: existingLeadObject.rowNumber, object: buildLegacyLeadObject(values, cleanPhone, resolvedLeadId, existingLeadObject) });
                        resultAction = "updated_existing_lead";
                    } else {
                        resolvedLeadId = generateImportId("LEAD");
                        const leadObject = buildLegacyLeadObject(values, cleanPhone, resolvedLeadId);
                        pendingLeadCreates.push(leadObject);
                        knownLeadsByPhone.set(cleanPhone, { ...leadObject, rowNumber: null });
                        resultAction = "inserted_lead";
                    }

                    const detailObject = buildLegacyLeadDetailObject(values, resolvedLeadId, rowObject);
                    const existingDetailObject = knownLeadDetailsByLeadId.get(resolvedLeadId);

                    if (!existingDetailObject) {
                        pendingLeadDetailCreates.push(detailObject);
                        knownLeadDetailsByLeadId.set(resolvedLeadId, { ...detailObject, rowNumber: null });
                    } else if (!String(existingDetailObject.facebook_leadgen_id || "").trim()) {
                        pendingLeadDetailUpdates.push({ rowNumber: existingDetailObject.rowNumber, object: detailObject });
                    }

                    const activityObjects = buildLegacyActivityObjects(activityPreviews, resolvedLeadId, salesperson);
                    if (activityObjects.length) pendingActivityCreates.push(...activityObjects);

                    if (sampleResultItems.length < 10) {
                        sampleResultItems.push({ row: i + 1, action: resultAction, lead_id: resolvedLeadId, phone: cleanPhone, created_activities: activityObjects.length });
                    }
                } catch (err) {
                    failedRows++;
                    if (sampleResultItems.length < 10) {
                        sampleResultItems.push({ row: i + 1, action: "failed", phone: cleanPhone, error: err.message });
                    }
                }
            }
        }

        if (!dryRun) {
            const failedCreatedLeadIds = new Set();

            for (const update of pendingLeadUpdates) {
                try {
                    await googleSheets.updateObjectRow("LEADS_MAIN", update.rowNumber, update.object);
                    updatedExistingLeads++;
                } catch (err) {
                    failedRows++;
                }
            }

            if (pendingLeadCreates.length) {
                try {
                    await googleSheets.appendObjects("LEADS_MAIN", pendingLeadCreates);
                    insertedLeads += pendingLeadCreates.length;
                } catch (err) {
                    for (const leadObject of pendingLeadCreates) {
                        try {
                            await googleSheets.appendObjects("LEADS_MAIN", [leadObject]);
                            insertedLeads++;
                        } catch (rowErr) {
                            failedRows++;
                            failedCreatedLeadIds.add(leadObject.lead_id);
                        }
                    }
                }
            }

            for (const update of pendingLeadDetailUpdates) {
                try {
                    await googleSheets.updateObjectRow("LEAD_DETAILS", update.rowNumber, update.object);
                } catch (err) {
                    failedRows++;
                }
            }

            const leadDetailCreatesToWrite = pendingLeadDetailCreates.filter(detailObject => !failedCreatedLeadIds.has(detailObject.lead_id));
            if (leadDetailCreatesToWrite.length) {
                try {
                    await googleSheets.appendObjects("LEAD_DETAILS", leadDetailCreatesToWrite);
                } catch (err) {
                    for (const detailObject of leadDetailCreatesToWrite) {
                        try {
                            await googleSheets.appendObjects("LEAD_DETAILS", [detailObject]);
                        } catch (rowErr) {
                            failedRows++;
                        }
                    }
                }
            }

            const activityCreatesToWrite = pendingActivityCreates.filter(activityObject => !failedCreatedLeadIds.has(activityObject.lead_id));
            if (activityCreatesToWrite.length) {
                try {
                    await googleSheets.appendObjects("ACTIVITY_LOG", activityCreatesToWrite);
                    createdActivities += activityCreatesToWrite.length;
                } catch (err) {
                    for (const activityObject of activityCreatesToWrite) {
                        try {
                            await googleSheets.appendObjects("ACTIVITY_LOG", [activityObject]);
                            createdActivities++;
                        } catch (rowErr) {
                            failedRows++;
                        }
                    }
                }
            }
        }

        return res.json({
            success: true,
            dry_run: dryRun,
            received_query: req.query,
            parsed_dry_run: dryRun,
            total_rows: rowsWithValidPhone + rowsMissingPhone,
            rows_with_valid_phone: rowsWithValidPhone,
            rows_missing_phone: rowsMissingPhone,
            would_create_lead: wouldCreateLead,
            would_update_existing_lead: wouldUpdateExistingLead,
            would_create_deal: wouldCreateDeal,
            would_create_installation: wouldCreateInstallation,
            would_create_activity: wouldCreateActivity,
            manual_review: manualReview,
            ignored_columns: ignoredColumns,
            detected_headers: detectedHeaders,
            missing_expected_headers: missingExpectedHeaders,
            sample_preview_items: samplePreviewItems,
            inserted_leads: insertedLeads,
            updated_existing_leads: updatedExistingLeads,
            created_activities: createdActivities,
            skipped_missing_phone: skippedMissingPhone,
            skipped_duplicate_or_existing: skippedDuplicateOrExisting,
            failed_rows: failedRows,
            normalized_province_count: normalizedProvinceCount,
            invalid_province_count: invalidProvinceCount,
            blank_date_count: blankDateCount,
            invalid_date_count: invalidDateCount,
            cleaned_preferred_call_day_count: cleanedPreferredCallDayCount,
            cleaned_preferred_call_time_count: cleanedPreferredCallTimeCount,
            mapping_rules_loaded: mappingRules.loadedCount,
            mapping_rule_types_loaded: mappingRules.ruleTypes,
            source_sheet_name: rawSheet.sheetName,
            audio_urls_detected: audioUrlsDetected,
            audio_activities_created: audioActivitiesCreated,
            audio_urls_skipped: audioUrlsSkipped,
            audio_skip_reasons: audioSkipReasons,
            sample_audio_items: sampleAudioItems,
            sample_result_items: sampleResultItems,
            would_create_lead_details: wouldCreateLeadDetails,
            crm2_legacy_followup_import_enabled: false,
            crm2_legacy_followup_import_mode: "audit_only",
            crm2_followup_all_candidate_activity_rows: crm2FollowUpAudit.all_candidate_details,
            crm2_followup_all_candidate_rows_grouped: crm2FollowUpAllCandidateRows,
            crm2_followup_duplicate_risk_rows: crm2FollowUpAudit.possible_duplicate_details,
            crm2_followup_duplicate_risk_rows_grouped: crm2FollowUpDuplicateRiskRows,
            crm2_followup_unmatched_phone_rows_detail: crm2FollowUpAudit.unmatched_phone_row_details,
            crm2_followup_unmatched_phone_rows_grouped: crm2FollowUpUnmatchedRows,
            crm2_followup_l_to_o_audit: crm2FollowUpAudit,
            crm2_followup_total_rows_scanned: crm2FollowUpAudit.total_crm2_rows_scanned,
            crm2_followup_rows_with_any_l_to_o_value: crm2FollowUpAudit.rows_with_any_l_to_o_value,
            crm2_followup_rows_with_any_candidate: crm2FollowUpAudit.rows_with_any_follow_up_candidate,
            crm2_followup_cells_found: crm2FollowUpAudit.total_follow_up_cells_found,
            crm2_followup_call_recording_text_cells_found: crm2FollowUpAudit.call_recording_text_cells_found,
            crm2_followup_matched_existing_leads_by_phone: crm2FollowUpAudit.matched_existing_leads_by_phone,
            crm2_followup_unmatched_phone_rows: crm2FollowUpAudit.unmatched_phone_rows,
            crm2_followup_candidate_activity_log_entries: crm2FollowUpAudit.candidate_activity_log_entries,
            crm2_followup_possible_duplicates: crm2FollowUpAudit.possible_duplicates,
            crm2_followup_unmatched_phone_row_details: crm2FollowUpAudit.unmatched_phone_row_details,
            crm2_followup_possible_duplicate_details: crm2FollowUpAudit.possible_duplicate_details,
            crm2_followup_invalid_call_recording_text_candidates: crm2FollowUpAudit.invalid_call_recording_text_candidates,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
}

module.exports = {
    handleLegacyCrm2Import,
    _test: {
        buildCrm2FollowUpLogOnlyResponse,
        buildSafeCrm2ReceivedQuery,
        redactCrm2SensitiveValue,
    },
};
