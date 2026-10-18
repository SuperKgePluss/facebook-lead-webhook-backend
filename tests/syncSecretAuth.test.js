const test = require("node:test");
const assert = require("node:assert/strict");
const { hasValidSyncAuthorization } = require("../services/syncSecretAuth");

const expectedSecret = "local-test-only-secret";

function request(authorization, query = {}) {
    return { headers: authorization ? { authorization } : {}, query };
}

test("accepts a matching Bearer authorization header", () => {
    assert.equal(hasValidSyncAuthorization(request(`Bearer ${expectedSecret}`), expectedSecret), true);
});

test("accepts case-insensitive Bearer scheme", () => {
    assert.equal(hasValidSyncAuthorization(request(`bEaReR ${expectedSecret}`), expectedSecret), true);
});

test("rejects query-string authentication, including with a valid header", () => {
    assert.equal(hasValidSyncAuthorization(request(undefined, { secret: expectedSecret }), expectedSecret), false);
    assert.equal(hasValidSyncAuthorization(request(`Bearer ${expectedSecret}`, { secret: expectedSecret }), expectedSecret), false);
});

test("rejects missing, malformed, and incorrect authorization", () => {
    assert.equal(hasValidSyncAuthorization(request(undefined), expectedSecret), false);
    assert.equal(hasValidSyncAuthorization(request(expectedSecret), expectedSecret), false);
    assert.equal(hasValidSyncAuthorization(request("Basic dGVzdA=="), expectedSecret), false);
    assert.equal(hasValidSyncAuthorization(request("Bearer wrong-value"), expectedSecret), false);
});

test("fails closed when the configured secret is missing", () => {
    assert.equal(hasValidSyncAuthorization(request(`Bearer ${expectedSecret}`), ""), false);
    assert.equal(hasValidSyncAuthorization(request(`Bearer ${expectedSecret}`), undefined), false);
});
