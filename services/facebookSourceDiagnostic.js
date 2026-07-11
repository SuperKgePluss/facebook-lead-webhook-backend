function formatBangkokTime(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date).reduce((result, part) => {
        if (part.type !== "literal") result[part.type] = part.value;
        return result;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`;
}

function serializeItem(item) {
    return {
        facebook_leadgen_id: item.facebook_leadgen_id,
        form_id: item.form_id,
        created_time_utc: item.created_time_utc,
        created_time_bangkok: item.created_time_bangkok,
    };
}

function getTimeBounds(items) {
    if (!items.length) return {
        oldest_created_time_utc: null,
        oldest_created_time_bangkok: null,
        newest_created_time_utc: null,
        newest_created_time_bangkok: null,
    };
    return {
        oldest_created_time_utc: items[0].created_time_utc,
        oldest_created_time_bangkok: items[0].created_time_bangkok,
        newest_created_time_utc: items[items.length - 1].created_time_utc,
        newest_created_time_bangkok: items[items.length - 1].created_time_bangkok,
    };
}

async function scanForm(form, perFormLimit, fetchLeadRefsPageForForm) {
    const refs = [];
    let afterCursor = "";
    let reachedLimit = false;

    while (refs.length < perFormLimit) {
        const page = await fetchLeadRefsPageForForm({
            formId: form.id,
            formName: form.name,
            pageSize: Math.min(100, perFormLimit - refs.length),
            afterCursor,
        });
        refs.push(...page.leads.slice(0, perFormLimit - refs.length));

        if (!page.next_url_available) break;
        if (refs.length >= perFormLimit) {
            reachedLimit = true;
            break;
        }
        afterCursor = page.next_after_cursor;
        if (!afterCursor) {
            reachedLimit = true;
            break;
        }
    }

    return { refs, reachedLimit };
}

async function buildFacebookSourceDiagnostic(options) {
    const {
        forms,
        perFormLimit,
        fromDate,
        toDate,
        compareSheet,
        capturedLeadgenIds,
        fetchLeadRefsPageForForm,
    } = options;
    const items = [];
    const failedItems = [];
    const formCoverage = [];

    for (const form of forms) {
        let refs = [];
        let reachedLimit = false;
        let fetchFailed = false;

        try {
            const scan = await scanForm(form, perFormLimit, fetchLeadRefsPageForForm);
            refs = scan.refs;
            reachedLimit = scan.reachedLimit;
        } catch (err) {
            fetchFailed = true;
            failedItems.push({
                form_id: String(form.id || "").trim(),
                reason: err.response?.data?.error?.message || err.message,
            });
        }

        const formItems = [];
        refs.forEach(ref => {
            const leadgenId = String(ref.id || "").trim();
            const sourceCreatedTime = String(ref.created_time || "").trim();
            const createdAt = new Date(sourceCreatedTime);
            if (!leadgenId || !sourceCreatedTime || Number.isNaN(createdAt.getTime())) {
                failedItems.push({
                    facebook_leadgen_id: leadgenId,
                    form_id: String(form.id || "").trim(),
                    source_created_time: sourceCreatedTime,
                    reason: !leadgenId ? "missing_leadgen_id" : "invalid_created_time",
                });
                return;
            }
            formItems.push({
                facebook_leadgen_id: leadgenId,
                form_id: String(form.id || "").trim(),
                created_time_utc: createdAt.toISOString(),
                created_time_bangkok: formatBangkokTime(createdAt),
                _created_time_ms: createdAt.getTime(),
            });
        });
        formItems.sort((a, b) => a._created_time_ms - b._created_time_ms);
        items.push(...formItems);
        formCoverage.push({
            form_id: String(form.id || "").trim(),
            fetched_count: refs.length,
            ...getTimeBounds(formItems),
            reached_limit: reachedLimit,
            fetch_failed: fetchFailed,
            _oldest_time_ms: formItems[0]?._created_time_ms ?? null,
        });
    }

    items.sort((a, b) => a._created_time_ms - b._created_time_ms);
    const itemsInWindow = items.filter(item => (
        item._created_time_ms >= fromDate.getTime()
        && item._created_time_ms <= toDate.getTime()
    ));
    const coverageWarnings = [];

    formCoverage.forEach(form => {
        if (form.fetch_failed) coverageWarnings.push(`Form ${form.form_id} fetch failed.`);
        if (form.reached_limit && (form._oldest_time_ms === null || form._oldest_time_ms >= fromDate.getTime())) {
            coverageWarnings.push(`Form ${form.form_id} reached the per-form limit before covering the requested start timestamp.`);
        }
    });

    const allFormsScanned = formCoverage.length === forms.length;
    const sourceCoverageComplete = allFormsScanned
        && failedItems.length === 0
        && formCoverage.every(form => !form.fetch_failed)
        && formCoverage.every(form => (
            !form.reached_limit
            || (form._oldest_time_ms !== null && form._oldest_time_ms < fromDate.getTime())
        ));
    if (!allFormsScanned) coverageWarnings.push("Not every discovered form was scanned.");
    if (failedItems.some(item => item.reason === "missing_leadgen_id" || item.reason === "invalid_created_time")) {
        coverageWarnings.push("One or more source records could not be classified into the requested time window.");
    }
    if (!sourceCoverageComplete && coverageWarnings.length === 0) {
        coverageWarnings.push("Complete source coverage could not be proven.");
    }

    const serializedItems = items.map(serializeItem);
    const serializedWindowItems = itemsInWindow.map(serializeItem);
    const missing = compareSheet
        ? itemsInWindow.filter(item => !capturedLeadgenIds.has(item.facebook_leadgen_id)).map(serializeItem)
        : null;
    const serializedFormCoverage = formCoverage.map(form => {
        const { _oldest_time_ms, ...serialized } = form;
        return serialized;
    });

    const result = {
        fetched_count: formCoverage.reduce((total, form) => total + form.fetched_count, 0),
        form_count: forms.length,
        forms_scanned_count: formCoverage.length,
        all_forms_scanned: allFormsScanned,
        source_coverage_complete: sourceCoverageComplete,
        coverage_warnings: coverageWarnings,
        forms: serializedFormCoverage,
        ...getTimeBounds(items),
        items: serializedItems,
        items_in_window: serializedWindowItems,
        count_in_window: serializedWindowItems.length,
        source_items_in_window_count: serializedWindowItems.length,
        existing_in_leads_main_count: compareSheet ? serializedWindowItems.length - missing.length : null,
        missing_from_leads_main_count: compareSheet ? missing.length : null,
        missing_from_leads_main: missing,
        failed_items: failedItems,
    };
    if (result.count_in_window !== result.items_in_window.length) {
        throw new Error("Diagnostic invariant failed: count_in_window does not match items_in_window.length");
    }
    return result;
}

module.exports = {
    buildFacebookSourceDiagnostic,
    formatBangkokTime,
};
