const { timingSafeEqual } = require("node:crypto");

function hasValidSyncAuthorization(req, expectedSecret) {
    if (!req || typeof expectedSecret !== "string" || expectedSecret.length === 0) return false;

    const query = req.query;
    if (query && Object.prototype.hasOwnProperty.call(query, "secret")) return false;

    const authorization = typeof req.get === "function"
        ? req.get("authorization")
        : req.headers?.authorization;
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(authorization || ""));
    if (!match) return false;

    const supplied = Buffer.from(match[1], "utf8");
    const expected = Buffer.from(expectedSecret, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

module.exports = { hasValidSyncAuthorization };
