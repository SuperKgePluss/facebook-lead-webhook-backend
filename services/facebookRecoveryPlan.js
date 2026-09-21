"use strict";

const crypto = require("crypto");
const {
    PHONE_COLLISION_REVIEW,
    assertExactFacebookLeadgenId,
    normalizeFacebookLeadgenId,
} = require("./facebookIdentity");

const PARTIAL_FAILURE_RECONCILIATION_REQUIRED = "PARTIAL_FAILURE_RECONCILIATION_REQUIRED";

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function validateRecoveryAllowlist(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error("Recovery allowlist must contain at least one ID.");
    }

    const normalized = ids.map((id, index) => {
        if (typeof id !== "string") {
            throw new Error(`Recovery allowlist ID at index ${index} must be text.`);
        }
        return assertExactFacebookLeadgenId(id, `Recovery allowlist ID at index ${index}`);
    });

    const duplicates = normalized.filter((id, index) => normalized.indexOf(id) !== index);
    if (duplicates.length) {
        throw new Error(`Recovery allowlist contains duplicate ID(s): ${Array.from(new Set(duplicates)).join(",")}`);
    }

    return normalized;
}

function normalizeSet(values) {
    return new Set(Array.from(values || [])
        .map(normalizeFacebookLeadgenId)
        .filter(Boolean));
}

function buildRecoveryPlan({
    ids,
    sourceRecords = [],
    existingFacebookIds = [],
    phoneCollisionIds = [],
    sourceCoverageComplete = true,
} = {}) {
    const requestedIds = validateRecoveryAllowlist(ids);
    const existingIds = normalizeSet(existingFacebookIds);
    const collisionIds = normalizeSet(phoneCollisionIds);
    const sourceById = new Map();

    for (const record of sourceRecords) {
        const id = normalizeFacebookLeadgenId(record?.id || record?.facebook_leadgen_id);
        if (id) sourceById.set(id, record);
    }

    const items = requestedIds.map(id => {
        const source = sourceById.get(id);
        let classification = "SAFE_INSERT_NEW";
        let intendedAction = "INSERT";

        if (!sourceCoverageComplete) {
            classification = "SOURCE_COVERAGE_INCOMPLETE";
            intendedAction = "EXCLUDE";
        } else if (existingIds.has(id)) {
            classification = "ALREADY_PRESENT_SKIP";
            intendedAction = "SKIP";
        } else if (!source) {
            classification = "SOURCE_DETAIL_UNAVAILABLE";
            intendedAction = "EXCLUDE";
        } else if (normalizeFacebookLeadgenId(source.id || source.facebook_leadgen_id) !== id) {
            classification = "SOURCE_ID_MISMATCH";
            intendedAction = "EXCLUDE";
        } else if (collisionIds.has(id)) {
            classification = PHONE_COLLISION_REVIEW;
            intendedAction = "EXCLUDE";
        }

        return {
            facebook_leadgen_id: id,
            classification,
            intended_action: intendedAction,
        };
    });

    const planPayload = {
        requested_ids: requestedIds,
        source_coverage_complete: Boolean(sourceCoverageComplete),
        items,
    };
    const planHash = crypto.createHash("sha256").update(stableJson(planPayload), "utf8").digest("hex");

    return {
        ...planPayload,
        plan_hash: planHash,
        run_id: `FB-RECOVERY-${planHash.slice(0, 24).toUpperCase()}`,
        expected_safe_count: items.filter(item => item.intended_action === "INSERT").length,
        counts: items.reduce((counts, item) => {
            counts[item.classification] = (counts[item.classification] || 0) + 1;
            return counts;
        }, {}),
    };
}

function assertPlanWithinAllowlist(plan) {
    const allowed = new Set(validateRecoveryAllowlist(plan?.requested_ids || []));
    const outOfBounds = (plan?.items || []).filter(item => !allowed.has(item.facebook_leadgen_id));
    if (outOfBounds.length) {
        throw new Error("Recovery plan contains an ID outside its allowlist.");
    }
}

async function applyRecoveryPlan({ plan, dryRun = true, write, reconcile } = {}) {
    assertPlanWithinAllowlist(plan);
    const insertItems = (plan.items || []).filter(
        item => item.intended_action === "INSERT" && item.classification === "SAFE_INSERT_NEW"
    );

    if (dryRun) {
        return {
            status: "DRY_RUN",
            run_id: plan.run_id,
            plan_hash: plan.plan_hash,
            write_count: 0,
            requested_ids: plan.requested_ids,
        };
    }

    if (typeof write !== "function" || typeof reconcile !== "function") {
        throw new Error("Recovery apply requires bounded write and reconciliation functions.");
    }

    const writeResult = await write(insertItems);
    const confirmedIds = await reconcile(insertItems.map(item => item.facebook_leadgen_id), writeResult);
    const allowedInsertIds = new Set(insertItems.map(item => item.facebook_leadgen_id));
    const confirmed = new Set(Array.from(confirmedIds || [])
        .map(normalizeFacebookLeadgenId)
        .filter(id => id && allowedInsertIds.has(id)));
    const unexpectedConfirmedIds = Array.from(confirmedIds || [])
        .map(normalizeFacebookLeadgenId)
        .filter(id => id && !allowedInsertIds.has(id));
    const uncertainIds = insertItems
        .map(item => item.facebook_leadgen_id)
        .filter(id => !confirmed.has(id));

    if (uncertainIds.length || unexpectedConfirmedIds.length) {
        return {
            status: PARTIAL_FAILURE_RECONCILIATION_REQUIRED,
            run_id: plan.run_id,
            plan_hash: plan.plan_hash,
            write_count: insertItems.length,
            confirmed_ids: Array.from(confirmed),
            uncertain_ids: uncertainIds,
            unexpected_confirmed_ids: unexpectedConfirmedIds,
        };
    }

    return {
        status: "APPLIED",
        run_id: plan.run_id,
        plan_hash: plan.plan_hash,
        write_count: insertItems.length,
        confirmed_ids: Array.from(confirmed),
        uncertain_ids: [],
    };
}

module.exports = {
    PARTIAL_FAILURE_RECONCILIATION_REQUIRED,
    applyRecoveryPlan,
    assertPlanWithinAllowlist,
    buildRecoveryPlan,
    validateRecoveryAllowlist,
};
