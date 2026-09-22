"use strict";

const PASSWORD_HASH_KEY_BYTES = 64;

function parseScryptPasswordHash(value) {
    if (typeof value !== "string") return null;
    const parts = value.split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return null;
    if (!/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;

    const salt = Buffer.from(parts[1], "base64url");
    const derivedKey = Buffer.from(parts[2], "base64url");
    if (salt.length < 16 || salt.length > 64 || salt.toString("base64url") !== parts[1]) return null;
    if (derivedKey.length !== PASSWORD_HASH_KEY_BYTES || derivedKey.toString("base64url") !== parts[2]) return null;

    return { salt, derivedKey };
}

function normalizeOrigin(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const candidate = value.trim();

    try {
        const url = new URL(candidate);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.origin !== candidate || url.username || url.password || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
}

function optionalInteger(env, name, fallback, minimum, maximum, invalidNames) {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        invalidNames.push(name);
        return fallback;
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        invalidNames.push(name);
        return fallback;
    }
    return value;
}

function loadDashboardConfig(env = process.env) {
    const missingOrInvalid = [];
    const isProduction = String(env.NODE_ENV || "").toLowerCase() === "production";
    const dashboardOrigin = normalizeOrigin(env.DASHBOARD_ORIGIN);
    if (!dashboardOrigin) missingOrInvalid.push("DASHBOARD_ORIGIN");

    const username = typeof env.DASHBOARD_AUTH_USERNAME === "string"
        ? env.DASHBOARD_AUTH_USERNAME.trim()
        : "";
    if (!username || username.length > 256 || /[\u0000-\u001f\u007f]/.test(username)) {
        missingOrInvalid.push("DASHBOARD_AUTH_USERNAME");
    }

    const passwordHash = parseScryptPasswordHash(env.DASHBOARD_AUTH_PASSWORD_HASH);
    if (!passwordHash) missingOrInvalid.push("DASHBOARD_AUTH_PASSWORD_HASH");

    const cookieName = typeof env.DASHBOARD_COOKIE_NAME === "string" && env.DASHBOARD_COOKIE_NAME.trim()
        ? env.DASHBOARD_COOKIE_NAME.trim()
        : "bo_dashboard_session";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) missingOrInvalid.push("DASHBOARD_COOKIE_NAME");

    const rawSameSite = typeof env.DASHBOARD_COOKIE_SAMESITE === "string"
        ? env.DASHBOARD_COOKIE_SAMESITE.trim().toLowerCase()
        : "lax";
    const sameSiteValues = { strict: "Strict", lax: "Lax", none: "None" };
    const cookieSameSite = sameSiteValues[rawSameSite];
    if (!cookieSameSite) missingOrInvalid.push("DASHBOARD_COOKIE_SAMESITE");

    const sessionTtlSeconds = optionalInteger(
        env,
        "DASHBOARD_SESSION_TTL_SECONDS",
        8 * 60 * 60,
        60,
        7 * 24 * 60 * 60,
        missingOrInvalid
    );
    const rateLimitWindowSeconds = optionalInteger(
        env,
        "DASHBOARD_RATE_LIMIT_WINDOW_SECONDS",
        60,
        1,
        60 * 60,
        missingOrInvalid
    );
    const rateLimitMax = optionalInteger(
        env,
        "DASHBOARD_RATE_LIMIT_MAX",
        10,
        1,
        1000,
        missingOrInvalid
    );

    return Object.freeze({
        configured: missingOrInvalid.length === 0,
        missingOrInvalid: Object.freeze(missingOrInvalid),
        dashboardOrigin,
        username,
        passwordHash,
        cookieName,
        cookieSameSite: cookieSameSite || "Lax",
        secureCookie: isProduction || cookieSameSite === "None" || dashboardOrigin?.startsWith("https://") === true,
        sessionTtlSeconds,
        rateLimitWindowSeconds,
        rateLimitMax,
    });
}

module.exports = {
    loadDashboardConfig,
    normalizeOrigin,
    parseScryptPasswordHash,
};
