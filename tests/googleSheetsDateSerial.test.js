const assert = require('assert');
const {
    dateToBangkokSheetsDateSerial,
    valueToBangkokSheetsDateSerial,
} = require('../services/googleSheets');

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30, 0, 0, 0, 0);

function serialToBangkokParts(serial) {
    const date = new Date(SHEETS_EPOCH_MS + serial * 86400000);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
    };
}

function assertBangkokParts(inputIso, expected) {
    const serial = dateToBangkokSheetsDateSerial(new Date(inputIso));
    assert.strictEqual(typeof serial, 'number');
    assert(Number.isFinite(serial));
    assert.deepStrictEqual(serialToBangkokParts(serial), expected);
    assert(!String(serial).includes('/'), 'serial output must not contain slash date text');
}

assertBangkokParts('2026-04-29T00:47:00Z', {
    year: 2026,
    month: 4,
    day: 29,
    hour: 7,
    minute: 47,
    second: 0,
});

assertBangkokParts('2026-04-28T18:47:30Z', {
    year: 2026,
    month: 4,
    day: 29,
    hour: 1,
    minute: 47,
    second: 30,
});

assertBangkokParts('2024-02-29T16:59:59Z', {
    year: 2024,
    month: 2,
    day: 29,
    hour: 23,
    minute: 59,
    second: 59,
});

assert.strictEqual(dateToBangkokSheetsDateSerial(), '');
assert.strictEqual(dateToBangkokSheetsDateSerial(null), '');
assert.strictEqual(dateToBangkokSheetsDateSerial(new Date('not-a-date')), '');

const sample = dateToBangkokSheetsDateSerial(new Date('2026-06-18T03:00:00Z'));
assert.strictEqual(typeof sample, 'number');
assert(!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(sample)), 'must not emit MM/dd/yyyy text');

assert.deepStrictEqual(serialToBangkokParts(valueToBangkokSheetsDateSerial('2026-06-18T03:00:00Z')), {
    year: 2026,
    month: 6,
    day: 18,
    hour: 10,
    minute: 0,
    second: 0,
});
assert.strictEqual(valueToBangkokSheetsDateSerial(''), '');
assert.strictEqual(valueToBangkokSheetsDateSerial('not-a-date'), '');

console.log('googleSheetsDateSerial tests passed');
