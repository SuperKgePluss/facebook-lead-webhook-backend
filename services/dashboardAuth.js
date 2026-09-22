"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { parseScryptPasswordHash } = require("./dashboardConfig");

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = Object.freeze({ N: 1 << 14, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const PASSWORD_HASH_KEY_BYTES = 64;
const MAX_ACTIVE_SESSIONS = 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function createDashboardPasswordHash(password, salt = crypto.randomBytes(16)) {
    if (typeof password !== "string") throw new TypeError("Password must be a string.");
    if (!Buffer.isBuffer(salt) || salt.length < 16 || salt.length > 64) {
        throw new TypeError("Salt must be a 16-to-64-byte Buffer.");
    }

    const derivedKey = await scrypt(password, salt, PASSWORD_HASH_KEY_BYTES, SCRYPT_OPTIONS);
    return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

async function verifyDashboardPassword(password, parsedHash) {
    if (typeof password !== "string" || !parsedHash) return false;
    const candidate = await scrypt(password, parsedHash.salt, parsedHash.derivedKey.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(candidate, parsedHash.derivedKey);
}

function constantTimeTextEqual(leftValue, rightValue) {
    const left = Buffer.from(String(leftValue ?? ""), "utf8");
    const right = Buffer.from(String(rightValue ?? ""), "utf8");
    const length = Math.max(left.length, right.length, 1);
    const leftPadded = Buffer.alloc(length);
    const rightPadded = Buffer.alloc(length);
    left.copy(leftPadded);
    right.copy(rightPadded);
    return crypto.timingSafeEqual(leftPadded, rightPadded) && left.length === right.length;
}

function getSessionIdFromCookie(req, cookieName) {
    const header = req.headers?.cookie;
    if (typeof header !== "string" || !header) return null;

    const matches = header.split(";").map(part => part.trim()).filter(part => {
        const separator = part.indexOf("=");
        return separator >= 0 && part.slice(0, separator).trim() === cookieName;
    });
    if (matches.length !== 1) return null;

    const sessionId = matches[0].slice(matches[0].indexOf("=") + 1).trim();
    return SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

function formatSessionCookie(config, sessionId, maxAgeSeconds) {
    const parts = [
        `${config.cookieName}=${sessionId}`,
        "Path=/",
        "HttpOnly",
        `SameSite=${config.cookieSameSite}`,
        `Max-Age=${maxAgeSeconds}`,
    ];
    if (config.secureCookie) parts.push("Secure");
    return parts.join("; ");
}

function createDashboardAuth({ config, sessions = new Map(), now = Date.now } = {}) {
    if (!(sessions instanceof Map)) throw new TypeError("Session storage must be a Map.");

    function requireConfigured(req, res, next) {
        if (!config?.configured) {
            return res.status(503).json({
                error: "dashboard_not_configured",
                message: "Dashboard authentication is not configured.",
            });
        }
        return next();
    }

    function pruneExpiredSessions() {
        const currentTime = now();
        for (const [sessionId, session] of sessions) {
            if (!session || session.expiresAt <= currentTime) sessions.delete(sessionId);
        }
    }

    function requireSession(req, res, next) {
        if (!config?.configured) {
            return res.status(503).json({
                error: "dashboard_not_configured",
                message: "Dashboard authentication is not configured.",
            });
        }

        const sessionId = getSessionIdFromCookie(req, config.cookieName);
        const session = sessionId ? sessions.get(sessionId) : null;
        if (!session || session.expiresAt <= now()) {
            if (sessionId) sessions.delete(sessionId);
            return res.status(401).json({ error: "unauthorized" });
        }

        req.dashboardSession = session;
        return next();
    }

    async function login(req, res) {
        const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? req.body
            : {};
        const username = typeof body.username === "string" && body.username.length <= 256
            ? body.username
            : "";
        const password = typeof body.password === "string" && body.password.length <= 1024
            ? body.password
            : "";

        let passwordValid = false;
        try {
            passwordValid = await verifyDashboardPassword(password, config.passwordHash);
        } catch {
            return res.status(503).json({ error: "dashboard_auth_unavailable" });
        }

        if (!constantTimeTextEqual(username, config.username) || !passwordValid) {
            return res.status(401).json({ error: "invalid_credentials" });
        }

        pruneExpiredSessions();
        if (sessions.size >= MAX_ACTIVE_SESSIONS) {
            const oldestSessionId = sessions.keys().next().value;
            if (oldestSessionId) sessions.delete(oldestSessionId);
        }

        const sessionId = crypto.randomBytes(32).toString("base64url");
        const expiresAt = now() + config.sessionTtlSeconds * 1000;
        sessions.set(sessionId, { expiresAt });
        res.setHeader("Set-Cookie", formatSessionCookie(config, sessionId, config.sessionTtlSeconds));
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ authenticated: true });
    }

    function session(req, res) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ authenticated: true });
    }

    function logout(req, res) {
        const sessionId = getSessionIdFromCookie(req, config.cookieName);
        if (sessionId) sessions.delete(sessionId);
        res.setHeader("Set-Cookie", formatSessionCookie(config, "", 0)
            + "; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ authenticated: false });
    }

    return {
        requireConfigured,
        requireSession,
        login,
        session,
        logout,
        sessions,
    };
}

module.exports = {
    createDashboardAuth,
    createDashboardPasswordHash,
    verifyDashboardPassword,
};
