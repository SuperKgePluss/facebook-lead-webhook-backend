const assert = require('assert');
const {
    getFacebookCreatedTimeForSheetValue,
    selectFacebookLeadCustomerName,
} = require('../services/facebookLeadParser');

function field(name, values) {
    return {
        name,
        values: Array.isArray(values) ? values : [values],
    };
}

const silentLogger = {
    warn() {},
};

assert.strictEqual(
    selectFacebookLeadCustomerName([field('full_name', 'Todd TK')], { logger: silentLogger }),
    'Todd TK'
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('first_name', 'Todd'), field('last_name', 'TK')], { logger: silentLogger }),
    'Todd TK'
);

process.env.FB_NAME_FIELD_KEYS = 'contact_person';
assert.strictEqual(
    selectFacebookLeadCustomerName([field('contact_person', 'Custom Name')], { logger: silentLogger }),
    'Custom Name'
);
delete process.env.FB_NAME_FIELD_KEYS;

assert.strictEqual(
    selectFacebookLeadCustomerName([field('phone_number', '0812345678')], { logger: silentLogger }),
    ''
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('name', 'This is a long open-ended survey answer. It is not a person name and should never be used as the customer name because it is sentence-like and too long.')], { logger: silentLogger }),
    ''
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('full_name', 'Line one\nLine two')], { logger: silentLogger }),
    ''
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('email', 'customer@example.com')], { logger: silentLogger }),
    ''
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('name', 'Bubu@Oun')], { logger: silentLogger }),
    'Bubu@Oun'
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('customer_name', 'Chaisri Chalodhorn')], { logger: silentLogger }),
    'Chaisri Chalodhorn'
);

assert.strictEqual(
    selectFacebookLeadCustomerName([field('source', 'Manual'), field('customer_name', 'Test Manual Lead')], { logger: silentLogger }),
    'Test Manual Lead'
);

assert.deepStrictEqual(
    getFacebookCreatedTimeForSheetValue({ created_time: '2026-06-18T10:49:00+0000' }),
    {
        value: '2026-06-18T10:49:00+0000',
        used: true,
    }
);

const fallback = getFacebookCreatedTimeForSheetValue({});
assert.strictEqual(typeof fallback.value, 'string');
assert.strictEqual(fallback.value, '');
assert.strictEqual(fallback.used, false);
assert(!fallback.value.includes('/'));

assert.deepStrictEqual(
    getFacebookCreatedTimeForSheetValue({ created_time: 'not-a-date' }),
    {
        value: '',
        used: false,
    }
);

assert.deepStrictEqual(
    getFacebookCreatedTimeForSheetValue({ created_time: '2026-06-18T10:49:00' }),
    {
        value: '',
        used: false,
    }
);

console.log('facebookLeadParser tests passed');
