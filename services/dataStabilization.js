const googleSheets = require("./googleSheets");

const DATA_START_ROW = 3;

function parseConfirm(req) {
    return String(req.query.confirm || "").trim().toLowerCase() === "true";
}

function parseLimit(req, defaultLimit = 50, maxLimit = 200) {
    const parsed = Number.parseInt(req.query.limit || "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
    return Math.min(parsed, maxLimit);
}

function isNonEmpty(value) {
    return String(value ?? "").trim() !== "";
}

function getDetailKeys(object = {}) {
    return {
        facebookLeadgenId: String(object.facebook_leadgen_id || "").trim(),
        phone: googleSheets.normalizePhone(object.raw_phone || object.phone),
        leadId: String(object.lead_id || "").trim(),
    };
}

function getDetailUnionKeys(object = {}) {
    const keys = getDetailKeys(object);
    return [
        keys.facebookLeadgenId ? `fb:${keys.facebookLeadgenId}` : "",
        keys.phone ? `phone:${keys.phone}` : "",
        keys.leadId ? `lead:${keys.leadId}` : "",
    ].filter(Boolean);
}

function createUnionFind(size) {
    const parent = Array.from({ length: size }, (_, index) => index);

    function find(index) {
        if (parent[index] !== index) parent[index] = find(parent[index]);
        return parent[index];
    }

    function union(left, right) {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    }

    return { find, union };
}

function getCanonicalFieldNames(headers) {
    return headers
        .map(header => googleSheets.normalizeHeaderName(header))
        .filter(Boolean);
}

function mergeDetailGroup(headers, items) {
    const fields = getCanonicalFieldNames(headers);
    const canonical = items[0];
    const merged = { ...canonical.object };
    const conflicts = [];

    for (const field of fields) {
        const values = items
            .map(item => String(item.object[field] ?? "").trim())
            .filter(Boolean);
        const uniqueValues = Array.from(new Set(values));

        if (!isNonEmpty(merged[field])) {
            const firstValue = values[0] || "";
            if (firstValue) merged[field] = firstValue;
        }

        if (uniqueValues.length > 1) {
            conflicts.push({
                field,
                canonical_value: String(canonical.object[field] ?? "").trim(),
                duplicate_values: uniqueValues,
            });
        }
    }

    return { merged, conflicts };
}

function buildLeadDetailDuplicatePlans(rows) {
    const headers = rows[0] || [];
    const items = rows
        .slice(DATA_START_ROW - 1)
        .map((row, index) => ({
            rowNumber: DATA_START_ROW + index,
            object: googleSheets.rowToObject(headers, row),
        }))
        .filter(item => Object.values(item.object).some(isNonEmpty));

    const unionFind = createUnionFind(items.length);
    const keyOwner = new Map();
    let skippedNoKey = 0;

    items.forEach((item, index) => {
        const keys = getDetailUnionKeys(item.object);
        if (!keys.length) {
            skippedNoKey++;
            return;
        }

        keys.forEach(key => {
            if (keyOwner.has(key)) unionFind.union(keyOwner.get(key), index);
            else keyOwner.set(key, index);
        });
    });

    const groupsByRoot = new Map();
    items.forEach((item, index) => {
        const keys = getDetailUnionKeys(item.object);
        if (!keys.length) return;

        const root = unionFind.find(index);
        if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
        groupsByRoot.get(root).push(item);
    });

    const duplicateGroups = [];

    for (const group of groupsByRoot.values()) {
        if (group.length < 2) continue;

        const sorted = [...group].sort((a, b) => a.rowNumber - b.rowNumber);
        const canonical = sorted[0];
        const duplicates = sorted.slice(1);
        const merge = mergeDetailGroup(headers, sorted);
        const keys = sorted.reduce((allKeys, item) => {
            getDetailUnionKeys(item.object).forEach(key => allKeys.add(key));
            return allKeys;
        }, new Set());

        duplicateGroups.push({
            canonical_row: canonical.rowNumber,
            duplicate_rows: duplicates.map(item => item.rowNumber),
            dedupe_keys: Array.from(keys).sort(),
            merged_object: merge.merged,
            conflicts: merge.conflicts,
        });
    }

    return {
        headers,
        rows_checked: items.length,
        skipped_no_key: skippedNoKey,
        duplicate_groups: duplicateGroups,
    };
}

async function handleLeadDetailsRepair(req, res) {
    const confirm = parseConfirm(req);
    const dryRun = !confirm;
    const limit = parseLimit(req, 50, 200);

    try {
        const rows = await googleSheets.getSheetRows("LEAD_DETAILS");
        const plan = buildLeadDetailDuplicatePlans(rows);
        const groupsToProcess = plan.duplicate_groups.slice(0, limit);
        const duplicateRowsToDelete = groupsToProcess.flatMap(group => group.duplicate_rows);
        const response = {
            success: true,
            dry_run: dryRun,
            no_writes_performed: dryRun,
            strategy: "merge connected duplicate LEAD_DETAILS rows by facebook_leadgen_id, normalized raw_phone, and lead_id; keep oldest row",
            limit,
            counts: {
                rows_checked: plan.rows_checked,
                skipped_no_key: plan.skipped_no_key,
                duplicate_groups: plan.duplicate_groups.length,
                duplicate_groups_processed: 0,
                canonical_rows_updated: 0,
                duplicate_rows_deleted: 0,
                duplicate_rows_pending: plan.duplicate_groups
                    .slice(limit)
                    .reduce((total, group) => total + group.duplicate_rows.length, 0),
                conflicts_found: plan.duplicate_groups.reduce((total, group) => total + group.conflicts.length, 0),
            },
            continue_required: plan.duplicate_groups.length > limit,
            sample_groups: plan.duplicate_groups.slice(0, 10).map(group => ({
                canonical_row: group.canonical_row,
                duplicate_rows: group.duplicate_rows,
                dedupe_keys: group.dedupe_keys,
                conflicts: group.conflicts.slice(0, 5),
            })),
        };

        if (!dryRun && groupsToProcess.length) {
            await googleSheets.updateObjectRows(
                "LEAD_DETAILS",
                groupsToProcess.map(group => ({
                    rowNumber: group.canonical_row,
                    object: group.merged_object,
                }))
            );
            response.counts.canonical_rows_updated = groupsToProcess.length;

            response.counts.duplicate_rows_deleted = await googleSheets.deleteSheetRows(
                "LEAD_DETAILS",
                duplicateRowsToDelete
            );
            response.counts.duplicate_groups_processed = groupsToProcess.length;
        }

        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: dryRun,
            error: err.response?.data || err.message,
        });
    }
}

function buildLeadPhoneMap(leadRows) {
    const headers = leadRows[0] || [];
    const map = new Map();

    for (let i = DATA_START_ROW - 1; i < leadRows.length; i++) {
        const object = googleSheets.rowToObject(headers, leadRows[i] || []);
        const leadId = String(object.lead_id || "").trim();
        const phone = googleSheets.normalizePhone(object.phone);

        if (leadId && phone && !map.has(leadId)) map.set(leadId, phone);
    }

    return map;
}

async function handleDealsPhoneRepair(req, res) {
    const confirm = parseConfirm(req);
    const dryRun = !confirm;
    const limit = parseLimit(req, 100, 500);

    try {
        const [leadRows, dealRows] = await Promise.all([
            googleSheets.getSheetRows("LEADS_MAIN"),
            googleSheets.getSheetRows("DEALS"),
        ]);
        const leadPhoneById = buildLeadPhoneMap(leadRows);
        const dealHeaders = dealRows[0] || [];
        const updates = [];
        let rowsChecked = 0;
        let missingLeadPhone = 0;

        for (let i = DATA_START_ROW - 1; i < dealRows.length; i++) {
            const object = googleSheets.rowToObject(dealHeaders, dealRows[i] || []);
            if (!Object.values(object).some(isNonEmpty)) continue;

            rowsChecked++;
            const leadId = String(object.lead_id || "").trim();
            const currentPhone = googleSheets.normalizePhone(object.phone);
            if (!leadId || currentPhone) continue;

            const phone = leadPhoneById.get(leadId) || "";
            if (!phone) {
                missingLeadPhone++;
                continue;
            }

            updates.push({
                rowNumber: i + 1,
                object: { phone },
                lead_id: leadId,
                phone,
            });
        }

        const updatesToWrite = updates.slice(0, limit);
        const response = {
            success: true,
            dry_run: dryRun,
            no_writes_performed: dryRun,
            limit,
            counts: {
                rows_checked: rowsChecked,
                phone_fill_candidates: updates.length,
                phones_filled: 0,
                remaining: Math.max(updates.length - updatesToWrite.length, 0),
                missing_lead_phone: missingLeadPhone,
            },
            continue_required: updates.length > limit,
            sample_updates: updates.slice(0, 10).map(update => ({
                row_number: update.rowNumber,
                lead_id: update.lead_id,
                phone: update.phone,
            })),
        };

        if (!dryRun && updatesToWrite.length) {
            response.counts.phones_filled = await googleSheets.updateObjectRows("DEALS", updatesToWrite);
        }

        return res.status(200).json(response);
    } catch (err) {
        return res.status(500).json({
            success: false,
            dry_run: dryRun,
            error: err.response?.data || err.message,
        });
    }
}

module.exports = {
    handleLeadDetailsRepair,
    handleDealsPhoneRepair,
};
