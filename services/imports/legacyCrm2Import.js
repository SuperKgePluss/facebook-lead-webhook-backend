const googleSheets = require("../googleSheets");
const {
    parseDryRunParam,
    loadMappingRules,
    readFirstAvailableSheet,
    getLegacyValue,
    hasAnyValue,
    isLegacyAudioHeader,
    extractUrls,
    normalizeLegacyImportPhone,
    normalizeLegacyProvince,
    normalizeLegacyZone,
    normalizeMultiByMappingRules,
    mapLegacySource,
    mapLegacyStatus,
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

function getCrm2Value(rowObject, fieldName) {
    return getLegacyValue(rowObject, googleSheets, LEGACY_IMPORT_FIELD_ALIASES, fieldName);
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
            raw_created_at: rawCreatedAt,
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
            reason: values.reason,
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
    putIfBlank(updateObject, existingLeadObject, "reason", values.reason);
    putIfBlank(updateObject, existingLeadObject, "sales_owner", values.salesperson);
    putIfBlank(updateObject, existingLeadObject, "created_at", values.leadInDate);

    return updateObject;
}

function buildLegacyLeadDetailObject(values, leadId, rowObject) {
    return {
        lead_id: leadId,
        raw_province: values.rawProvince,
        raw_data_json: JSON.stringify(rowObject),
        import_source: "Legacy Import",
    };
}

function buildLegacyActivityObjects(activityPreviews, leadId, salesOwner) {
    return activityPreviews.map(activity => ({
        activity_id: generateImportId("ACT"),
        lead_id: leadId,
        follow_up_no: activity.follow_up_no,
        action_type: "Follow-up",
        result: "",
        note: activity.note,
        audio_url: activity.audio_url,
        audio_file_name: "",
        created_by: salesOwner,
        created_at: activity.created_at,
    }));
}

async function handleLegacyCrm2Import(req, res) {
    const dryRun = parseDryRunParam(req);

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
            const paymentSlip = getCrm2Value(rowObject, "payment_slip");
            const installationLocation = getCrm2Value(rowObject, "installation_location");
            const installationDetails = getCrm2Value(rowObject, "installation_details");
            const installationDate = getCrm2Value(rowObject, "installation_date");
            const installationTime = getCrm2Value(rowObject, "installation_time");
            const cleanPhone = normalizeLegacyImportPhone(phone, googleSheets);
            const provinceResult = normalizeLegacyProvince(province, mappingRules);
            const cleanedPreferredCallDay = normalizeMultiByMappingRules(mappingRules, "preferred_call_day", preferredCallDay);
            const cleanedPreferredCallTime = normalizeMultiByMappingRules(mappingRules, "preferred_call_time", preferredCallTime);
            const cleanedSource = mapLegacySource(source, mappingRules);
            const cleanedLeadStatus = mapLegacyStatus(classification, mappingRules);
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
            else wouldCreateLead++;

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

            if (hasDealData) wouldCreateDeal++;
            if (hasInstallationData) wouldCreateInstallation++;
            wouldCreateActivity += activityPreviews.length;

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
                    activity_previews: activityPreviews,
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
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
}

module.exports = { handleLegacyCrm2Import };
