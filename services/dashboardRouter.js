"use strict";

const express = require("express");
const { loadDashboardConfig } = require("./dashboardConfig");
const { createDashboardAuth } = require("./dashboardAuth");
const { readDashboardSheets } = require("./dashboardSheetsReader");
const { buildDashboardReadModel } = require("./dashboardReadModel");
const { shapeDashboardResponse } = require("./dashboardPrivacy");
const { readAudioIndexSnapshot } = require("./audioIndexStore");
const {
    readDashboardLeadParity,
    shapeDashboardHealthResponse,
} = require("./dashboardHealthReader");

const OVERVIEW_FILTER_NAMES = Object.freeze([
    "dateFrom",
    "dateTo",
    "salesOwner",
    "leadStatus",
    "source",
    "customerTypeCode",
    "salesFollowUpStatus",
    "leadSearch",
]);
const DEFAULT_OPERATIONAL_LEAD_LIMIT = 100;
const MAX_OPERATIONAL_LEAD_LIMIT = 100;
const MAX_OPERATIONAL_LEAD_OFFSET = 1000000;

function safeCrm4ReadFailure(error) {
    const message = String(error?.message || "");
    const status = Number(error?.response?.status || error?.code || 0);
    if (message.includes("configuration is incomplete")) return "crm4_config_incomplete";
    if (message.includes("missing required sheet")) return "crm4_tab_missing";
    if (message.includes("missing required headers")) return "crm4_required_identity_header_missing";
    if (/duplicate|conflicting headers/i.test(message)) return "crm4_duplicate_identity_or_header";
    if (status === 401 || status === 403) return "crm4_sheets_access_denied";
    if (status === 404) return "crm4_spreadsheet_not_found";
    if (status === 429) return "crm4_sheets_rate_limited";
    return "crm4_read_failed";
}

function parseFilterDate(value) {
    if (value === undefined || value === "") return { ok: true, value: null };
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false };
    }

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return { ok: false };
    }
    return { ok: true, value };
}

function parseOverviewFilters(query = {}) {
    const allowed = new Set([...OVERVIEW_FILTER_NAMES, "leadOffset", "leadLimit", "refresh"]);
    if (Object.keys(query).some(key => !allowed.has(key))) return { ok: false };
    if (query.refresh !== undefined && query.refresh !== "1") return { ok: false };

    const filters = {};
    for (const name of OVERVIEW_FILTER_NAMES) {
        const value = query[name];
        if (Array.isArray(value) || (value !== undefined && typeof value !== "string")) {
            return { ok: false };
        }

        if (name === "dateFrom" || name === "dateTo") {
            const parsed = parseFilterDate(value);
            if (!parsed.ok) return { ok: false };
            if (parsed.value) filters[name] = parsed.value;
            continue;
        }

        if (value === undefined || value === "") continue;
        const normalized = value.trim();
        if (normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) return { ok: false };
        if (normalized) filters[name] = normalized;
    }

    if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
        return { ok: false };
    }
    const pagination = {};
    if (query.leadOffset !== undefined) {
        if (typeof query.leadOffset !== "string" || !/^(?:0|[1-9]\d*)$/.test(query.leadOffset)) return { ok: false };
        const offset = Number(query.leadOffset);
        if (!Number.isSafeInteger(offset) || offset > MAX_OPERATIONAL_LEAD_OFFSET) return { ok: false };
        pagination.offset = offset;
    } else {
        pagination.offset = 0;
    }
    if (query.leadLimit !== undefined) {
        if (typeof query.leadLimit !== "string" || !/^[1-9]\d*$/.test(query.leadLimit)) return { ok: false };
        const limit = Number(query.leadLimit);
        if (!Number.isSafeInteger(limit) || limit > MAX_OPERATIONAL_LEAD_LIMIT) return { ok: false };
        pagination.limit = limit;
    } else {
        pagination.limit = DEFAULT_OPERATIONAL_LEAD_LIMIT;
    }
    return { ok: true, filters, pagination };
}

function parseActivityLimit(query = {}) {
    if (Object.keys(query).some(key => !["limit", "dateFrom", "dateTo", "refresh"].includes(key))) return null;
    if (query.limit !== undefined && (typeof query.limit !== "string" || !/^(?:[1-9]|1\d|20)$/.test(query.limit))) return null;
    if (query.refresh !== undefined && query.refresh !== "1") return null;
    const filters = parseOverviewFilters({ dateFrom: query.dateFrom, dateTo: query.dateTo });
    if (!filters.ok) return null;
    return query.limit === undefined ? 20 : Number(query.limit);
}

function createDefaultDataProvider(now, audioIndexReader) {
    return async ({ filters, pagination }) => {
        const [sheets, audioIndex] = await Promise.all([readDashboardSheets(), audioIndexReader()]);
        return buildDashboardReadModel({
            ...sheets,
            filters,
            operational_lead_pagination: pagination,
            audio_index: audioIndex,
            asOf: new Date(now()),
        });
    };
}

function createDashboardCors(config) {
    return (req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        const origin = req.get("Origin");
        if (origin && config.dashboardOrigin && origin !== config.dashboardOrigin) {
            return res.status(403).json({ error: "origin_not_allowed" });
        }

        if (origin && origin === config.dashboardOrigin) {
            res.setHeader("Access-Control-Allow-Origin", config.dashboardOrigin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.vary("Origin");
        }
        return next();
    };
}

function requireDashboardOrigin(config) {
    return (req, res, next) => {
        if (!config.dashboardOrigin || req.get("Origin") !== config.dashboardOrigin) {
            return res.status(403).json({ error: "origin_not_allowed" });
        }
        return next();
    };
}

function preflight(config, methods) {
    return (req, res) => {
        if (!config.dashboardOrigin || req.get("Origin") !== config.dashboardOrigin) {
            return res.status(403).json({ error: "origin_not_allowed" });
        }

        const requestedMethod = String(req.get("Access-Control-Request-Method") || "").toUpperCase();
        if (!methods.includes(requestedMethod)) return res.status(405).json({ error: "method_not_allowed" });

        const requestedHeaders = String(req.get("Access-Control-Request-Headers") || "")
            .split(",")
            .map(header => header.trim().toLowerCase())
            .filter(Boolean);
        if (requestedHeaders.some(header => header !== "content-type")) {
            return res.status(400).json({ error: "headers_not_allowed" });
        }

        res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
        if (requestedHeaders.length) res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        return res.status(204).end();
    };
}

function createLoginRateLimiter({ max, windowSeconds, now }) {
    const windowMs = windowSeconds * 1000;
    let windowStartedAt = null;
    let attemptCount = 0;

    return (req, res, next) => {
        const currentTime = now();
        if (windowStartedAt === null || currentTime < windowStartedAt || currentTime - windowStartedAt >= windowMs) {
            windowStartedAt = currentTime;
            attemptCount = 0;
        }

        if (attemptCount >= max) {
            const retryAfter = Math.max(1, Math.ceil((windowStartedAt + windowMs - currentTime) / 1000));
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({ error: "rate_limited" });
        }

        attemptCount++;
        return next();
    };
}

function createDashboardRouter(options = {}) {
    const env = options.env || process.env;
    const now = options.now || Date.now;
    const config = loadDashboardConfig(env);
    const auth = createDashboardAuth({ config, sessions: options.sessions || new Map(), now });
    const audioIndexReader = options.audioIndexReader || (() => readAudioIndexSnapshot({
        filePath: env.AUDIO_INDEX_PATH,
        filenamePatternVerified: env.AUDIO_FILENAME_PATTERN_CONFIRMED === "true",
        timestampVerified: env.AUDIO_RECORDING_TIMESTAMP_CONFIRMED === "true",
        linksAuthorized: env.AUDIO_DASHBOARD_LINKS_AUTHORIZED === "true",
    }));
    const dataProvider = options.dataProvider || createDefaultDataProvider(now, audioIndexReader);
    const healthReader = options.healthReader || readDashboardLeadParity;
    if (typeof dataProvider !== "function") throw new TypeError("Dashboard data provider must be a function.");
    if (typeof healthReader !== "function") throw new TypeError("Dashboard health reader must be a function.");

    const router = express.Router();
    const cors = createDashboardCors(config);
    const requireOrigin = requireDashboardOrigin(config);
    const rateLimitLogin = createLoginRateLimiter({
        max: config.rateLimitMax,
        windowSeconds: config.rateLimitWindowSeconds,
        now,
    });

    router.options("/auth/login", cors, auth.requireConfigured, preflight(config, ["POST"]));
    router.options("/auth/logout", cors, auth.requireConfigured, preflight(config, ["POST"]));
    router.options("/auth/session", cors, auth.requireConfigured, preflight(config, ["GET"]));
    router.options("/dashboard/overview", cors, auth.requireConfigured, preflight(config, ["GET"]));
    router.options("/dashboard/activity", cors, auth.requireConfigured, preflight(config, ["GET"]));
    router.options("/dashboard/health", cors, auth.requireConfigured, preflight(config, ["GET"]));

    router.post("/auth/login", cors, auth.requireConfigured, requireOrigin, rateLimitLogin, auth.login);
    router.post("/auth/logout", cors, auth.requireConfigured, requireOrigin, auth.logout);
    router.get("/auth/session", cors, auth.requireConfigured, auth.requireSession, auth.session);

    router.get("/dashboard/overview", cors, auth.requireConfigured, auth.requireSession, async (req, res) => {
        const parsed = parseOverviewFilters(req.query);
        if (!parsed.ok) return res.status(400).json({ error: "invalid_filter" });

        try {
            const model = await dataProvider({
                filters: parsed.filters,
                pagination: parsed.pagination,
                asOf: new Date(now()),
                forceRefresh: req.query.refresh === "1",
            });
            if (!model || typeof model !== "object") throw new TypeError("Dashboard model unavailable.");
            return res.status(200).json(shapeDashboardResponse(model));
        } catch (error) {
            return res.status(503).json({
                error: "dashboard_data_unavailable",
                ...(String(env.CRM4_DASHBOARD_MODE || "").toLowerCase() === "true" ? { reason: safeCrm4ReadFailure(error) } : {}),
            });
        }
    });

    router.get("/dashboard/activity", cors, auth.requireConfigured, auth.requireSession, async (req, res) => {
        const limit = parseActivityLimit(req.query);
        if (limit === null) return res.status(400).json({ error: "invalid_limit" });

        try {
            const parsedFilters = parseOverviewFilters({ dateFrom: req.query.dateFrom, dateTo: req.query.dateTo, refresh: req.query.refresh });
            if (!parsedFilters.ok) return res.status(400).json({ error: "invalid_filter" });
            const model = await dataProvider({
                filters: parsedFilters.filters,
                asOf: new Date(now()),
                forceRefresh: req.query.refresh === "1",
            });
            if (!model || typeof model !== "object") throw new TypeError("Dashboard model unavailable.");
            const shaped = shapeDashboardResponse(model);
            return res.status(200).json({ recent_activity: shaped.recent_activity.slice(0, limit) });
        } catch (error) {
            return res.status(503).json({
                error: "dashboard_data_unavailable",
                ...(String(env.CRM4_DASHBOARD_MODE || "").toLowerCase() === "true" ? { reason: safeCrm4ReadFailure(error) } : {}),
            });
        }
    });

    router.get("/dashboard/health", cors, auth.requireConfigured, auth.requireSession, async (req, res) => {
        let snapshot = null;
        try {
            snapshot = await healthReader();
        } catch {
            // The health payload intentionally reports UNKNOWN without exposing source errors.
        }
        return res.status(200).json(shapeDashboardHealthResponse(snapshot));
    });

    return router;
}

module.exports = {
    createDashboardRouter,
    parseOverviewFilters,
    parseActivityLimit,
};
