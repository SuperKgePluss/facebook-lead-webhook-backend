"use strict";

const crypto = require("crypto");

const PHONE_COLLISION_REVIEW = "PHONE_COLLISION_REVIEW";
const FACEBOOK_REPEAT_SUBMISSION_ACTION = "Facebook Repeat Submission";

function normalizeFacebookLeadgenId(value) {
    if (typeof value !== "string") return "";

    const normalized = value.trim();
    return /^\d+$/.test(normalized) ? normalized : "";
}

function isScientificNotation(value) {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(String(value || "").trim());
}

function assertExactFacebookLeadgenId(value, label = "Facebook Leadgen ID") {
    if (typeof value !== "string") {
        throw new Error(`${label} must be a text string.`);
    }

    const normalized = value.trim();
    if (!normalized || normalized !== value || isScientificNotation(normalized) || !/^\d+$/.test(normalized)) {
        throw new Error(`${label} is not an exact numeric text ID.`);
    }

    return normalized;
}

function classifyFacebookIdentityMatch({ incomingFacebookLeadgenId, exactMatch = false, phoneMatch = false } = {}) {
    const normalizedId = normalizeFacebookLeadgenId(incomingFacebookLeadgenId);

    if (!normalizedId) {
        return { classification: "INVALID_FACEBOOK_LEADGEN_ID", action: "REVIEW" };
    }

    if (exactMatch) {
        return {
            classification: "EXACT_FACEBOOK_ID_MATCH",
            action: "SKIP",
            facebook_leadgen_id: normalizedId,
        };
    }

    if (phoneMatch) {
        return {
            classification: PHONE_COLLISION_REVIEW,
            action: "REPEAT_SUBMISSION",
            facebook_leadgen_id: normalizedId,
        };
    }

    return {
        classification: "NEW_FACEBOOK_ID",
        action: "CREATE",
        facebook_leadgen_id: normalizedId,
    };
}

function deterministicRepeatSubmissionId(leadId, facebookLeadgenId) {
    const normalizedLeadId = String(leadId || "").trim();
    const normalizedFacebookId = assertExactFacebookLeadgenId(facebookLeadgenId);

    if (!normalizedLeadId) {
        throw new Error("Repeat submission event requires a Lead ID.");
    }

    const digest = crypto
        .createHash("sha256")
        .update(`${normalizedLeadId}|${normalizedFacebookId}`, "utf8")
        .digest("hex")
        .slice(0, 24)
        .toUpperCase();

    return `FB-REPEAT-${digest}`;
}

function buildFacebookRepeatSubmissionEvent({
    leadId,
    facebookLeadgenId,
    sourceCreatedTime = "",
    primaryFacebookLeadgenId = "",
} = {}) {
    const exactFacebookId = assertExactFacebookLeadgenId(facebookLeadgenId);
    const activityId = deterministicRepeatSubmissionId(leadId, exactFacebookId);

    return {
        activity_id: activityId,
        event_id: activityId,
        idempotency_key: activityId,
        lead_id: String(leadId || "").trim(),
        sheet_name: "Facebook",
        action_type: FACEBOOK_REPEAT_SUBMISSION_ACTION,
        old_value: String(primaryFacebookLeadgenId || "").trim(),
        new_value: exactFacebookId,
        facebook_leadgen_id: exactFacebookId,
        note: "Repeat Facebook submission recorded as append-only evidence.",
        created_by: "Facebook",
        created_at: String(sourceCreatedTime || "").trim(),
    };
}

function dedupeRepeatSubmissionEvents(existingEventIds, events) {
    const existing = new Set(Array.from(existingEventIds || []).map(value => String(value || "").trim()).filter(Boolean));
    const uniqueEvents = Array.from(new Map(
        (events || []).map(event => [String(event.activity_id || "").trim(), event])
    ).values());
    const pendingEvents = uniqueEvents.filter(event => !existing.has(String(event.activity_id || "").trim()));

    return {
        pendingEvents,
        skippedExisting: (events || []).length - pendingEvents.length,
    };
}

module.exports = {
    FACEBOOK_REPEAT_SUBMISSION_ACTION,
    PHONE_COLLISION_REVIEW,
    assertExactFacebookLeadgenId,
    buildFacebookRepeatSubmissionEvent,
    classifyFacebookIdentityMatch,
    dedupeRepeatSubmissionEvents,
    deterministicRepeatSubmissionId,
    isScientificNotation,
    normalizeFacebookLeadgenId,
};
