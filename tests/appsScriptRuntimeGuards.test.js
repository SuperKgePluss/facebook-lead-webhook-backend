const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');
const appsScriptRoot = path.join(repoRoot, 'apps-script');
const SNAPSHOT_HEADERS = [
  'lead_id', 'leads_row', 'last_k_hash', 'last_k_value', 'last_synced_at', 'last_activity_log_row',
  'pending_event_id', 'pending_lead_id', 'pending_previous_hash', 'pending_target_hash',
  'pending_target_value', 'pending_action_type', 'pending_note', 'pending_created_by', 'pending_created_at', 'pending_state',
  'pending_protocol_version',
];
const ACTIVITY_HEADERS = ['activity_id', 'lead_id', 'sheet_name', 'action_type', 'note', 'created_by', 'created_at'];

function digest(value) {
  return Array.from(crypto.createHash('sha256').update(String(value || '')).digest());
}

function makeRange(sheet, row, column, numRows, numColumns) {
  const read = () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numColumns }, (_, c) => sheet.cell(row + r, column + c)));
  return {
    getValues: read,
    getDisplayValues: () => read().map(values => values.map(value => value instanceof Date ? value.toISOString() : String(value ?? ''))),
    setValues(values) { sheet.write(row, column, values); return this; },
    setValue(value) { sheet.write(row, column, [[value]]); return this; },
    getValue() { return sheet.cell(row, column); },
    clearContent() { sheet.clear(row, column, numRows, numColumns); return this; },
    getRow: () => row,
    getColumn: () => column,
    getLastRow: () => row + numRows - 1,
    getLastColumn: () => column + numColumns - 1,
    getA1Notation: () => `R${row}C${column}`,
    getSheet: () => sheet,
    getNumRows: () => numRows,
    getNumColumns: () => numColumns,
    setNote() { return this; },
  };
}

class FakeSheet {
  constructor(name, headers, rows = [], options = {}) {
    this.name = name;
    this.headers = headers.slice();
    this.rows = rows.map(row => row.slice());
    this.options = options;
    this.writeCount = 0;
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length ? this.rows.length + 2 : 1; }
  getLastColumn() { return Math.max(this.headers.length, ...this.rows.map(row => row.length), 0); }
  getMaxColumns() { return this.getLastColumn(); }
  getRange(row, column, numRows = 1, numColumns = 1) { return makeRange(this, row, column, numRows, numColumns); }
  cell(row, column) {
    if (row === 1) return this.headers[column - 1] ?? '';
    return (this.rows[row - 3] || [])[column - 1] ?? '';
  }
  write(row, column, values) {
    this.writeCount++;
    if (this.options.failWrite && this.options.failWrite({ row, column, values, count: this.writeCount })) throw new Error('simulated sheet write failure');
    values.forEach((inputRow, r) => {
      if (row + r === 1) {
        while (this.headers.length < column + inputRow.length - 1) this.headers.push('');
        inputRow.forEach((value, c) => { this.headers[column + c - 1] = value; });
        return;
      }
      while (this.rows.length < row + r - 2) this.rows.push([]);
      while (this.rows[row + r - 3].length < column + inputRow.length - 1) this.rows[row + r - 3].push('');
      inputRow.forEach((value, c) => { this.rows[row + r - 3][column + c - 1] = value; });
    });
  }
  clear(row, column, numRows, numColumns) {
    for (let r = 0; r < numRows; r++) for (let c = 0; c < numColumns; c++) {
      if (this.rows[row + r - 3]) this.rows[row + r - 3][column + c - 1] = '';
    }
  }
  isSheetHidden() { return false; }
  hideSheet() {}
  insertColumnsAfter() {}
}

class FakeSpreadsheet {
  constructor(sheets) { this.sheets = sheets; this.active = this; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { this.sheets[name] = new FakeSheet(name, SNAPSHOT_HEADERS); return this.sheets[name]; }
  getSheets() { return Object.values(this.sheets); }
  getActiveSheet() { return this.sheets.LEADS; }
  getId() { return 'test-spreadsheet'; }
  getName() { return 'Test CRM'; }
  toast() {}
}

function headerMap(headers) {
  const result = {};
  headers.forEach((header, index) => {
    const normalized = String(header || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (normalized && !result[normalized]) result[normalized] = index + 1;
  });
  return result;
}

function rowForSnapshot(leadId, value, rowNumber = 3) {
  const hash = crypto.createHash('sha256').update(String(value || '').trim()).digest('hex');
  const row = Array(SNAPSHOT_HEADERS.length).fill('');
  row[0] = leadId;
  row[1] = rowNumber;
  row[2] = hash;
  row[3] = value;
  row[4] = new Date();
  return row;
}

function makeRuntime(options = {}) {
  const leadsHeaders = options.leadsHeaders || ['Lead ID', 'Sales Note History'];
  const leadsRows = options.leadsRows || [['lead-1', options.leadValue || 'old']];
  const snapshotRows = options.snapshotRows || [rowForSnapshot('lead-1', 'old')];
  const sheets = {
    LEADS: new FakeSheet('LEADS', leadsHeaders, leadsRows, options.leadsOptions),
    LEADS_NOTE_SNAPSHOT: new FakeSheet('LEADS_NOTE_SNAPSHOT', options.snapshotHeaders || SNAPSHOT_HEADERS, snapshotRows, options.snapshotOptions),
    ACTIVITY_LOG: new FakeSheet('ACTIVITY_LOG', options.activityHeaders || ACTIVITY_HEADERS, options.activityRows || [], options.activityOptions),
  };
  const spreadsheet = new FakeSpreadsheet(sheets);
  const propertiesValues = { LEADS_NOTE_SNAPSHOT_BASELINE_VERSION: options.marker === undefined ? '2' : options.marker };
  const properties = {
    getProperty(key) { return propertiesValues[key] ?? ''; },
    setProperty(key, value) { propertiesValues[key] = String(value); },
    deleteProperty(key) { delete propertiesValues[key]; },
  };
  const cacheValues = {};
  let lockHeld = false;
  let runtimeContext = null;
  let lockHookUsed = false;
  let releaseHookUsed = false;
  const counters = { lockWaits: 0, lockReleases: 0, deleted: [], created: [] };
  const triggers = options.triggers || [];
  const scriptApp = {
    getProjectTriggers() { return triggers.slice(); },
    deleteTrigger(trigger) { counters.deleted.push(trigger); const index = triggers.indexOf(trigger); if (index >= 0) triggers.splice(index, 1); },
    newTrigger(handler) {
      return {
        timeBased() {
          return {
            everyMinutes() {
              return {
                create() {
                  if (options.createTriggerThrows) throw new Error('simulated trigger creation failure');
                  if (options.createTriggerReturnsNull) return null;
                  const created = { handler, getHandlerFunction() { return handler; } };
                  counters.created.push(created);
                  triggers.push(created);
                  return created;
                },
              };
            },
          };
        },
      };
    },
  };
  const context = {
    DATA_START_ROW: 3,
    HEADER_ROW: 1,
    Logger: { log() {} },
    PropertiesService: { getScriptProperties() { return properties; } },
    LockService: { getScriptLock() { return {
      waitLock() {
        counters.lockWaits++;
        if (options.lockFails || lockHeld) throw new Error('lock unavailable');
        lockHeld = true;
        if (options.onLockAcquired && !lockHookUsed) {
          lockHookUsed = true;
          options.onLockAcquired(runtimeContext);
        }
      },
      releaseLock() {
        lockHeld = false;
        counters.lockReleases++;
        if (options.onLockReleased && !releaseHookUsed) {
          releaseHookUsed = true;
          options.onLockReleased(runtimeContext);
        }
      },
    }; } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      computeDigest(_algorithm, value) { return digest(value); },
      base64EncodeWebSafe(value) { return Buffer.from(value).toString('base64url'); },
      formatDate(value) { return new Date(value).toISOString().slice(0, 16).replace('T', ' '); },
      getUuid() { return typeof options.uuid === 'function' ? options.uuid() : options.uuid || 'uuid-12345678'; },
    },
    Buffer,
    SpreadsheetApp: { getActive() { return spreadsheet; } },
    ScriptApp: scriptApp,
    getHeaderMap_(sheet) { return headerMap(sheet.headers); },
    normalizeHeaderName_(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); },
    appendObjectRow_(sheetName, object) {
      const sheet = spreadsheet.getSheetByName(sheetName);
      const map = headerMap(sheet.headers);
      const row = Math.max(sheet.getLastRow() + 1, 3);
      const values = Array(sheet.getLastColumn()).fill('');
      Object.keys(object).forEach(key => { if (map[key]) values[map[key] - 1] = object[key]; });
      sheet.getRange(row, 1, 1, values.length).setValues([values]);
      return row;
    },
    getSafeCrmUserEmail_() { return 'user@example.test'; },
    Session: { getScriptTimeZone() { return 'Asia/Bangkok'; }, getActiveUser() { return { getEmail() { return 'user@example.test'; } }; } },
    CacheService: { getScriptCache() { return { get(key) { return cacheValues[key] || ''; }, put(key, value) { cacheValues[key] = String(value); }, remove(key) { delete cacheValues[key]; } }; } },
  };
  vm.createContext(context);
  runtimeContext = context;
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'LeadsNoteSnapshot.gs'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'Code.gs'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'LeadsView.gs'), 'utf8'), context);
  context.setupLeadsViewRowUi = () => {};
  context.sheets = sheets;
  context.propertiesValues = propertiesValues;
  context.counters = counters;
  context.triggers = triggers;
  return context;
}

function activityRows(runtime) { return runtime.sheets.ACTIVITY_LOG.rows; }

function makePendingSnapshotRow(runtime, options = {}) {
  const previousValue = options.previousValue === undefined ? 'old' : options.previousValue;
  const targetValue = options.targetValue === undefined ? 'changed' : options.targetValue;
  const previousHash = options.previousHash || runtime.hashLeadsNoteValue_(previousValue);
  const targetHash = options.targetHash || runtime.hashLeadsNoteValue_(targetValue);
  const eventId = options.eventId || `ACT-LEADS-NOTE-v1-${previousHash}-${targetHash}-fixture01`;
  const row = rowForSnapshot('lead-1', previousValue);
  row[6] = eventId;
  row[7] = 'lead-1';
  row[8] = previousHash;
  row[9] = targetHash;
  row[10] = targetValue;
  row[11] = options.actionType || 'Sales Note';
  row[12] = options.note === undefined ? String(targetValue || 'Sales Note History cleared in LEADS.') : options.note;
  row[13] = 'user@example.test';
  row[14] = options.createdAt || '2026-07-17T00:00:00.000Z';
  row[15] = 'pending';
  row[16] = '1';
  return row;
}

function makeEditEvent(sheet, row, column, value) {
  return {
    value,
    range: {
      getSheet() { return sheet; },
      getRow() { return row; },
      getColumn() { return column; },
      getNumRows() { return 1; },
      getNumColumns() { return 1; },
      getA1Notation() { return `R${row}C${column}`; },
    },
  };
}

test('schema and canonical-ID validation fails closed before trigger mutation', () => {
  for (const options of [
    { leadsHeaders: ['Sales Note History'] },
    { leadsHeaders: ['Lead ID'] },
    { leadsRows: [['lead-1', 'old'], ['lead-1', 'new']] },
    { snapshotRows: [rowForSnapshot('lead-1', 'old'), rowForSnapshot('lead-1', 'old')] },
    { snapshotRows: [['', '', '', '', '', '', '', '', '', '', 'orphan', '', '', '', '', '']] },
    { leadsRows: [[' lead-1 ', 'old']] },
    { snapshotRows: [rowForSnapshot(' lead-1 ', 'old')] },
  ]) {
    const runtime = makeRuntime(options);
    assert.throws(() => runtime.installLeadsNoteSyncTrigger(), /LEADS|required|duplicate|noncanonical|nonblank|Snapshot/i);
    assert.deepStrictEqual(runtime.counters.deleted, []);
    assert.deepStrictEqual(runtime.counters.created, []);
  }
});

test('tampered snapshot value/hash fails closed', () => {
  const row = rowForSnapshot('lead-1', 'old');
  row[3] = 'tampered';
  const runtime = makeRuntime({ snapshotRows: [row] });
  assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), /value\/hash mismatch/i);
  assert.strictEqual(activityRows(runtime).length, 0);
});

test('initialization failure leaves the completion marker absent', () => {
  const runtime = makeRuntime({ snapshotOptions: { failWrite: () => true } });
  assert.throws(() => runtime.initializeLeadsNoteSnapshot(), /simulated sheet write failure/i);
  assert.strictEqual(runtime.propertiesValues.LEADS_NOTE_SNAPSHOT_BASELINE_VERSION, undefined);
});

test('new eligible Lead is onboarded baseline-only, then later change appends once', () => {
  const runtime = makeRuntime({ leadsRows: [['lead-1', 'old'], ['lead-2', 'new']] });
  const first = runtime.syncLeadsNoteHistoryToActivityLogNow();
  assert.strictEqual(first.onboarded, 1);
  assert.strictEqual(activityRows(runtime).length, 0);
  runtime.sheets.LEADS.rows[1][1] = 'changed';
  runtime.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(runtime).length, 1);
  runtime.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(runtime).length, 1);
});

test('lock acquisition failure performs no writes', () => {
  const runtime = makeRuntime({ lockFails: true, leadsRows: [['lead-1', 'changed']] });
  const snapshotWrites = runtime.sheets.LEADS_NOTE_SNAPSHOT.writeCount;
  assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), /script lock/i);
  assert.strictEqual(activityRows(runtime).length, 0);
  assert.strictEqual(runtime.sheets.LEADS_NOTE_SNAPSHOT.writeCount, snapshotWrites);
});

test('pending state recovers after append interruption without duplicate', () => {
  const runtime = makeRuntime({ leadsRows: [['lead-1', 'changed']] });
  const commit = runtime.commitLeadsNoteTransition_;
  runtime.commitLeadsNoteTransition_ = () => { throw new Error('simulated interruption after append'); };
  assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), /interruption/i);
  assert.strictEqual(activityRows(runtime).length, 1);
  runtime.commitLeadsNoteTransition_ = commit;
  runtime.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(runtime).length, 1);
  const snapshot = runtime.sheets.LEADS_NOTE_SNAPSHOT.rows[0];
  assert.strictEqual(snapshot[3], 'changed');
  assert.strictEqual(snapshot[15], '');
});

test('pending state recovers when execution stops before the Activity Log append', () => {
  const runtime = makeRuntime({ leadsRows: [['lead-1', 'changed']] });
  const append = runtime.appendLeadsNoteActivityRowAtomically_;
  runtime.appendLeadsNoteActivityRowAtomically_ = () => {
    throw new Error('simulated interruption before append');
  };
  assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), /before append/i);
  assert.strictEqual(activityRows(runtime).length, 0);
  runtime.appendLeadsNoteActivityRowAtomically_ = append;
  runtime.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(runtime).length, 1);
  assert.strictEqual(runtime.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], '');
});

test('repeating the same note value in a later transition gets a new event identity', () => {
  let sequence = 0;
  const runtime = makeRuntime({
    uuid: () => 'uuid-1234567' + (++sequence),
    leadsRows: [['lead-1', 'new']],
  });
  runtime.syncLeadsNoteHistoryToActivityLogNow();
  runtime.sheets.LEADS.rows[0][1] = 'old';
  runtime.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(runtime).length, 2);
  assert.notStrictEqual(activityRows(runtime)[0][0], activityRows(runtime)[1][0]);
});

test('malformed pending state is not silently overwritten', () => {
  const row = rowForSnapshot('lead-1', 'old');
  row[6] = 'event-without-rest';
  const runtime = makeRuntime({ snapshotRows: [row], leadsRows: [['lead-1', 'changed']] });
  assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), /malformed pending/i);
  assert.strictEqual(activityRows(runtime).length, 0);
});

test('empty target transitions recover before append and after append without duplicates', () => {
  const beforeAppend = makeRuntime({ leadsRows: [['lead-1', '']] });
  const append = beforeAppend.appendLeadsNoteActivityRowAtomically_;
  beforeAppend.appendLeadsNoteActivityRowAtomically_ = () => { throw new Error('empty target before append'); };
  assert.throws(() => beforeAppend.syncLeadsNoteHistoryToActivityLogNow(), /empty target before append/);
  assert.strictEqual(beforeAppend.sheets.LEADS_NOTE_SNAPSHOT.rows[0][10], '');
  beforeAppend.appendLeadsNoteActivityRowAtomically_ = append;
  beforeAppend.syncLeadsNoteHistoryToActivityLogContinue();
  beforeAppend.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(beforeAppend).length, 1);
  assert.strictEqual(beforeAppend.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], '');

  const afterAppend = makeRuntime({ leadsRows: [['lead-1', '']] });
  const commit = afterAppend.commitLeadsNoteTransition_;
  afterAppend.commitLeadsNoteTransition_ = () => { throw new Error('empty target after append'); };
  assert.throws(() => afterAppend.syncLeadsNoteHistoryToActivityLogNow(), /empty target after append/);
  afterAppend.commitLeadsNoteTransition_ = commit;
  afterAppend.syncLeadsNoteHistoryToActivityLogContinue();
  afterAppend.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(afterAppend).length, 1);
  assert.strictEqual(afterAppend.sheets.LEADS_NOTE_SNAPSHOT.rows[0][3], '');
  assert.strictEqual(afterAppend.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], '');
});

test('pending previous hash must match committed state and target hash must match target value', () => {
  const stale = makeRuntime({
    leadsRows: [['lead-1', 'changed']],
    snapshotRows: [makePendingSnapshotRow(makeRuntime(), { previousHash: 'a'.repeat(64) })],
  });
  assert.throws(() => stale.syncLeadsNoteHistoryToActivityLogNow(), /previous hash.*committed/i);
  assert.strictEqual(activityRows(stale).length, 0);

  const tampered = makeRuntime({
    leadsRows: [['lead-1', 'changed']],
    snapshotRows: [makePendingSnapshotRow(makeRuntime(), { targetHash: 'b'.repeat(64) })],
  });
  assert.throws(() => tampered.syncLeadsNoteHistoryToActivityLogNow(), /target value\/hash mismatch/i);
  assert.strictEqual(activityRows(tampered).length, 0);
});

test('pending metadata requires the exact protocol, primitive fields, hashes, identity, action, and timestamp', () => {
  const fixture = makeRuntime();
  const cases = [
    { name: 'invalid timestamp', index: 14, value: '2026-07-17T00:00:00Z' },
    { name: 'impossible timestamp', index: 14, value: '2026-02-30T00:00:00.000Z' },
    { name: 'timestamp object', index: 14, value: {} },
    { name: 'timestamp Date object', index: 14, value: new Date('2026-07-17T00:00:00.000Z') },
    { name: 'event id object', index: 6, value: {} },
    { name: 'lead id array', index: 7, value: [] },
    { name: 'previous hash number', index: 8, value: 42 },
    { name: 'previous hash NaN', index: 8, value: NaN },
    { name: 'target hash boolean', index: 9, value: true },
    { name: 'target hash Infinity', index: 9, value: Infinity },
    { name: 'target value boolean', index: 10, value: false },
    { name: 'action object', index: 11, value: {} },
    { name: 'note array', index: 12, value: [] },
    { name: 'creator number', index: 13, value: 7 },
    { name: 'state object', index: 15, value: {} },
    { name: 'unsupported protocol', index: 16, value: '2' },
    { name: 'malformed event nonce', index: 6, value: `ACT-LEADS-NOTE-v1-${fixture.hashLeadsNoteValue_('old')}-${fixture.hashLeadsNoteValue_('changed')}-bad nonce` },
    { name: 'malformed hash', index: 8, value: 'not-a-sha256-hash' },
    { name: 'unsupported action', index: 11, value: 'Delete Everything' },
    { name: 'inherited action name', index: 11, value: 'toString' },
  ];
  for (const entry of cases) {
    const pending = makePendingSnapshotRow(fixture);
    pending[entry.index] = entry.value;
    const runtime = makeRuntime({
      leadsRows: [['lead-1', 'changed']],
      snapshotRows: [pending],
    });
    assert.throws(
      () => runtime.syncLeadsNoteHistoryToActivityLogNow(),
      /pending|timestamp|metadata|protocol|identity|hash|action/i,
      entry.name
    );
    assert.strictEqual(activityRows(runtime).length, 0, entry.name);
  }
});

test('existing complete, partial, wrong-payload, duplicate, and malformed events are handled fail-closed', () => {
  const complete = makeRuntime({ leadsRows: [['lead-1', 'changed']] });
  const commit = complete.commitLeadsNoteTransition_;
  complete.commitLeadsNoteTransition_ = () => { throw new Error('leave pending'); };
  assert.throws(() => complete.syncLeadsNoteHistoryToActivityLogNow(), /leave pending/);
  complete.commitLeadsNoteTransition_ = commit;
  complete.syncLeadsNoteHistoryToActivityLogContinue();
  complete.syncLeadsNoteHistoryToActivityLogContinue();
  assert.strictEqual(activityRows(complete).length, 1);

  const fixture = makeRuntime();
  const pending = makePendingSnapshotRow(fixture);
  const cases = [
    { activityRows: [[pending[6], 'lead-1', '', '', '', '', '']], pattern: /inconsistent sheet_name/i },
    { activityRows: [[pending[6], 'other-lead', 'LEADS', 'Sales Note', pending[12], pending[13], pending[14]]], pattern: /inconsistent lead_id/i },
    { activityRows: [[pending[6], 'lead-1', 'LEADS', 'Other Action', pending[12], pending[13], pending[14]]], pattern: /inconsistent action_type/i },
    { activityRows: [[pending[6], 'lead-1', 'LEADS', 'Sales Note', 'wrong note', pending[13], pending[14]]], pattern: /inconsistent note/i },
    { activityRows: [[pending[6], 'lead-1', 'LEADS', 'Sales Note', pending[12], 'other-user', pending[14]]], pattern: /inconsistent created_by/i },
    { activityRows: [[pending[6], 'lead-1', 'LEADS', 'Sales Note', pending[12], pending[13], 'not-a-timestamp']], pattern: /inconsistent created_at/i },
    { activityRows: [
      [pending[6], 'lead-1', 'LEADS', 'Sales Note', pending[12], pending[13], pending[14]],
      [pending[6], 'lead-1', 'LEADS', 'Sales Note', pending[12], pending[13], pending[14]],
    ], pattern: /duplicate event ID/i },
  ];
  for (const entry of cases) {
    const runtime = makeRuntime({ leadsRows: [['lead-1', 'changed']], snapshotRows: [pending], activityRows: entry.activityRows });
    assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), entry.pattern);
    assert.strictEqual(activityRows(runtime).length, entry.activityRows.length);
  }
});

test('duplicate required headers fail closed across LEADS, snapshot, and Activity Log', () => {
  const cases = [
    { leadsHeaders: ['Lead ID', 'Lead ID', 'Sales Note History'] },
    { snapshotHeaders: SNAPSHOT_HEADERS.slice(0, -1).concat(['lead_id']) },
    { activityHeaders: ['activity_id', 'lead_id', 'sheet_name', 'lead_id', 'action_type', 'note', 'created_by', 'created_at'] },
  ];
  for (const options of cases) {
    const runtime = makeRuntime(options);
    assert.throws(() => runtime.syncLeadsNoteHistoryToActivityLogNow(), /duplicate/i);
    assert.strictEqual(activityRows(runtime).length, 0);
  }
});

test('atomic Activity Log append writes one complete row', () => {
  const runtime = makeRuntime({ leadsRows: [['lead-1', 'changed']] });
  runtime.syncLeadsNoteHistoryToActivityLogNow();
  assert.strictEqual(runtime.sheets.ACTIVITY_LOG.writeCount, 1);
  assert.strictEqual(activityRows(runtime)[0].length, ACTIVITY_HEADERS.length);
  assert.ok(activityRows(runtime)[0].every(value => value !== '' && value !== null && value !== undefined));
});

test('atomic Activity Log write failure leaves recoverable pending state and retry appends once', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  const runtime = makeRuntime({
    leadsHeaders: headers,
    leadsRows: [['lead-1', '', 'old']],
    activityOptions: { failWrite: ({ count }) => count === 1 },
  });
  const event = makeEditEvent(runtime.sheets.LEADS, 3, 2, 'atomic retry');
  assert.throws(() => runtime.onEdit(event), /simulated sheet write failure/);
  assert.strictEqual(activityRows(runtime).length, 0);
  assert.strictEqual(runtime.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], 'pending');
  assert.ok(runtime.propertiesValues['LEADS_SALES_NOTE_IN_PROGRESS_lead-1']);
  assert.strictEqual(runtime.propertiesValues['LEADS_SALES_NOTE_LAST_lead-1'], undefined);

  runtime.sheets.ACTIVITY_LOG.options.failWrite = null;
  runtime.onEdit(event);
  assert.strictEqual(activityRows(runtime).length, 1);
  assert.strictEqual(runtime.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], '');
  assert.ok(runtime.propertiesValues['LEADS_SALES_NOTE_LAST_lead-1']);
  assert.strictEqual((String(runtime.sheets.LEADS.rows[0][2]).match(/atomic retry/g) || []).length, 1);
});

test('overlapping onEdit execution is blocked by the transaction owner and later retry is complete', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  let overlapError;
  const runtime = makeRuntime({
    leadsHeaders: headers,
    leadsRows: [['lead-1', '', 'old']],
    onLockAcquired(current) {
      try {
        current.onEdit(makeEditEvent(current.sheets.LEADS, 3, 2, 'overlap note'));
      } catch (err) {
        overlapError = err;
      }
    },
  });
  runtime.onEdit(makeEditEvent(runtime.sheets.LEADS, 3, 2, 'first note'));
  assert.match(String(overlapError && overlapError.message), /lock/i);
  assert.strictEqual(activityRows(runtime).length, 1);
  runtime.onEdit(makeEditEvent(runtime.sheets.LEADS, 3, 2, 'overlap note'));
  assert.strictEqual(activityRows(runtime).length, 2);
  assert.match(String(runtime.sheets.LEADS.rows[0][2]), /first note/);
  assert.match(String(runtime.sheets.LEADS.rows[0][2]), /overlap note/);
});

test('queued onEdit waits during the first transaction and runs from a fresh read after release', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  let secondLockFailure;
  let secondRan = false;
  const secondEventValue = 'queued note';
  const runtime = makeRuntime({
    leadsHeaders: headers,
    leadsRows: [['lead-1', '', 'old']],
    onLockAcquired(current) {
      try {
        current.onEdit(makeEditEvent(current.sheets.LEADS, 3, 2, secondEventValue));
      } catch (err) {
        secondLockFailure = err;
      }
    },
    onLockReleased(current) {
      secondRan = true;
      current.onEdit(makeEditEvent(current.sheets.LEADS, 3, 2, secondEventValue));
    },
  });
  runtime.onEdit(makeEditEvent(runtime.sheets.LEADS, 3, 2, 'first queued note'));
  assert.match(String(secondLockFailure && secondLockFailure.message), /lock/i);
  assert.strictEqual(secondRan, true);
  assert.strictEqual(activityRows(runtime).length, 2);
  assert.match(String(runtime.sheets.LEADS.rows[0][2]), /first queued note/);
  assert.match(String(runtime.sheets.LEADS.rows[0][2]), /queued note/);
});

test('actual onEdit transaction handles two edits and retries after history mutation failure', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  const runtime = makeRuntime({ leadsHeaders: headers, leadsRows: [['lead-1', '', 'old']] });
  runtime.onEdit(makeEditEvent(runtime.sheets.LEADS, 3, 2, 'first note'));
  runtime.onEdit(makeEditEvent(runtime.sheets.LEADS, 3, 2, 'second note'));
  assert.strictEqual(activityRows(runtime).length, 2);
  assert.match(String(runtime.sheets.LEADS.rows[0][2]), /first note/);
  assert.match(String(runtime.sheets.LEADS.rows[0][2]), /second note/);

  const retry = makeRuntime({ leadsHeaders: headers, leadsRows: [['lead-1', '', 'old']] });
  const update = retry.updateLeadsNoteSnapshotForLeadUnlocked_;
  retry.updateLeadsNoteSnapshotForLeadUnlocked_ = () => { throw new Error('failure after history mutation'); };
  const event = makeEditEvent(retry.sheets.LEADS, 3, 2, 'recover me');
  assert.throws(() => retry.onEdit(event), /failure after history mutation/);
  assert.strictEqual(activityRows(retry).length, 0);
  assert.ok(retry.propertiesValues['LEADS_SALES_NOTE_IN_PROGRESS_lead-1']);
  retry.updateLeadsNoteSnapshotForLeadUnlocked_ = update;
  retry.onEdit(event);
  assert.strictEqual(activityRows(retry).length, 1);
  assert.strictEqual((String(retry.sheets.LEADS.rows[0][2]).match(/recover me/g) || []).length, 1);
});

test('expired unresolved note is recovered before a later note and repeated retries stay ordered and idempotent', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  const runtime = makeRuntime({ leadsHeaders: headers, leadsRows: [['lead-1', '', 'old']] });
  const update = runtime.updateLeadsNoteSnapshotForLeadUnlocked_;
  let failFirstUpdate = true;
  runtime.updateLeadsNoteSnapshotForLeadUnlocked_ = function () {
    if (failFirstUpdate) {
      failFirstUpdate = false;
      throw new Error('first snapshot processing failure');
    }
    return update.apply(this, arguments);
  };
  const first = makeEditEvent(runtime.sheets.LEADS, 3, 2, 'first note');
  assert.throws(() => runtime.onEdit(first), /first snapshot processing failure/);
  const inProgressKey = 'LEADS_SALES_NOTE_IN_PROGRESS_lead-1';
  const firstState = JSON.parse(runtime.propertiesValues[inProgressKey]);
  runtime.propertiesValues[inProgressKey] = JSON.stringify({
    ...firstState,
    startedAt: Date.now() - (11 * 60 * 1000),
  });
  assert.strictEqual(activityRows(runtime).length, 0);
  assert.strictEqual((String(runtime.sheets.LEADS.rows[0][2]).match(/first note/g) || []).length, 1);

  const second = makeEditEvent(runtime.sheets.LEADS, 3, 2, 'second note');
  runtime.onEdit(second);
  const history = String(runtime.sheets.LEADS.rows[0][2]);
  assert.strictEqual((history.match(/first note/g) || []).length, 1);
  assert.strictEqual((history.match(/second note/g) || []).length, 1);
  assert.ok(history.indexOf('first note') < history.indexOf('second note'));
  assert.deepStrictEqual(activityRows(runtime).map(row => row[4]), ['first note', 'second note']);
  assert.strictEqual(runtime.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], '');

  runtime.onEdit(second);
  assert.strictEqual((String(runtime.sheets.LEADS.rows[0][2]).match(/second note/g) || []).length, 1);
  assert.strictEqual(activityRows(runtime).length, 2);
});

test('different-note arrival fails closed without overwriting unresolved recovery state', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  const runtime = makeRuntime({ leadsHeaders: headers, leadsRows: [['lead-1', '', 'old']] });
  const update = runtime.updateLeadsNoteSnapshotForLeadUnlocked_;
  runtime.updateLeadsNoteSnapshotForLeadUnlocked_ = () => { throw new Error('recovery unavailable'); };
  const first = makeEditEvent(runtime.sheets.LEADS, 3, 2, 'first note');
  assert.throws(() => runtime.onEdit(first), /recovery unavailable/);
  const key = 'LEADS_SALES_NOTE_IN_PROGRESS_lead-1';
  const stateBefore = JSON.parse(runtime.propertiesValues[key]);
  const historyBefore = String(runtime.sheets.LEADS.rows[0][2]);
  assert.throws(() => runtime.onEdit(makeEditEvent(runtime.sheets.LEADS, 3, 2, 'second note')), /recovery unavailable/);
  assert.deepStrictEqual(JSON.parse(runtime.propertiesValues[key]), stateBefore);
  assert.strictEqual(String(runtime.sheets.LEADS.rows[0][2]), historyBefore);
  assert.strictEqual(activityRows(runtime).length, 0);
});

test('late same-note retry reuses the original History entry and creates at most one Activity Log event', () => {
  const headers = ['Lead ID', 'Sales Note Input', 'Sales Note History'];
  const runtime = makeRuntime({ leadsHeaders: headers, leadsRows: [['lead-1', '', 'old']] });
  const update = runtime.updateLeadsNoteSnapshotForLeadUnlocked_;
  runtime.updateLeadsNoteSnapshotForLeadUnlocked_ = () => { throw new Error('late recovery setup failure'); };
  const event = makeEditEvent(runtime.sheets.LEADS, 3, 2, 'late note');
  assert.throws(() => runtime.onEdit(event), /late recovery setup failure/);
  const key = 'LEADS_SALES_NOTE_IN_PROGRESS_lead-1';
  const state = JSON.parse(runtime.propertiesValues[key]);
  runtime.propertiesValues[key] = JSON.stringify({ ...state, startedAt: Date.now() - (11 * 60 * 1000) });
  runtime.updateLeadsNoteSnapshotForLeadUnlocked_ = update;

  runtime.onEdit(event);
  runtime.onEdit(event);
  assert.strictEqual((String(runtime.sheets.LEADS.rows[0][2]).match(/late note/g) || []).length, 1);
  assert.strictEqual(activityRows(runtime).length, 1);
  assert.strictEqual(runtime.sheets.LEADS_NOTE_SNAPSHOT.rows[0][15], '');
});

test('trigger replacement failure preserves existing trigger and success retires only old matching triggers', () => {
  const old = { handler: 'syncLeadsNoteHistoryToActivityLogScheduled', getHandlerFunction() { return this.handler; } };
  const unrelated = { handler: 'other', getHandlerFunction() { return this.handler; } };
  const failed = makeRuntime({ triggers: [old, unrelated], createTriggerThrows: true });
  assert.throws(() => failed.installLeadsNoteSyncTrigger(), /preserved/i);
  assert.deepStrictEqual(failed.counters.deleted, []);
  assert.deepStrictEqual(failed.triggers, [old, unrelated]);
  const successful = makeRuntime({ triggers: [old, unrelated] });
  const replacement = successful.installLeadsNoteSyncTrigger();
  assert.strictEqual(successful.counters.deleted.length, 1);
  assert.strictEqual(successful.counters.deleted[0], old);
  assert.ok(successful.triggers.includes(replacement));
  assert.ok(successful.triggers.includes(unrelated));
});

function loadMenuRuntime(propertyValue) {
  const menus = [];
  const properties = { getProperty() { return propertyValue; } };
  const context = {
    SpreadsheetApp: { getUi() { return { createMenu(name) { const menu = { name, items: [], addItem(label, handler) { this.items.push({ label, handler }); return this; }, addToUi() { menus.push(this); } }; return menu; } }; } },
    PropertiesService: { getScriptProperties() { return properties; } },
    menus,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'Code.gs'), 'utf8'), context);
  context.onOpen();
  return { menus, context };
}

test('developer menu is default-off and client menu excludes admin handlers', () => {
  for (const value of [undefined, '', 'false', 'yes', '1', 'true-ish']) {
    const runtime = loadMenuRuntime(value);
    assert.deepStrictEqual(runtime.menus.map(menu => menu.name), ['CRM Tools']);
    assert.deepStrictEqual(runtime.menus[0].items.map(item => item.handler), ['createManualLead']);
  }
  const enabled = loadMenuRuntime(' TRUE ');
  assert.deepStrictEqual(enabled.menus.map(menu => menu.name), ['CRM Tools', 'CRM Developer Tools']);
  assert.ok(enabled.menus[1].items.some(item => item.handler === 'diagnoseCrmSetup'));
  assert.strictEqual(enabled.menus[0].items.some(item => /diagnose|snapshot|repair|backfill/i.test(item.handler)), false);
});

test('diagnostic logger is disabled without Spreadsheet access and stores only minimized metadata', () => {
  const context = {
    Logger: { log() {} },
    PropertiesService: { getScriptProperties() { return { getProperty() { return 'false'; } }; } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'CrmDiagnostics.gs'), 'utf8'), context);
  context.SpreadsheetApp = { getActive() { throw new Error('must not open'); } };
  assert.strictEqual(context.logSalesNoteDiagnostic_({ note: 'raw note', notePreview: 'raw preview' }), false);

  let written;
  context.PropertiesService = { getScriptProperties() { return { getProperty() { return 'true'; } }; } };
  context.Session = { getActiveUser() { return { getEmail() { return 'person@example.test'; } }; } };
  context.Utilities = { DigestAlgorithm: { SHA_256: 'sha' }, Charset: { UTF_8: 'utf8' }, computeDigest(_a, value) { return digest(value); } };
  context.ensureCrmDiagnosticLogSheet_ = () => ({ isSheetHidden() { return true; } });
  context.appendObjectRow_ = (_name, row) => { written = row; };
  assert.strictEqual(context.logSalesNoteDiagnostic_({ note: 'raw note', notePreview: 'raw preview', leadId: 'client-lead-123', reason: 'test', details: 'raw error' }), true);
  assert.strictEqual(JSON.stringify(written).includes('raw note'), false);
  assert.strictEqual(JSON.stringify(written).includes('client-lead-123'), false);
  assert.strictEqual(JSON.stringify(written).includes('person@example.test'), false);
  assert.strictEqual(written.note_present, true);
  assert.strictEqual(written.note_length, 8);
  assert.ok(written.note_hash);
});

test('diagnostic temporary protection cleanup runs after permission assessment throws', () => {
  const context = { Logger: { log() {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'CrmDiagnostics.gs'), 'utf8'), context);
  let removed = 0;
  const range = { protect() { return { canEdit() { throw new Error('assessment failure'); }, remove() { removed++; } }; } };
  assert.match(context.canDiagnosticCurrentUserEditRange_({}, range), /assessment failure/);
  assert.strictEqual(removed, 1);
});

test('diagnostic protection cleanup failure is surfaced as incomplete', () => {
  const context = { Logger: { log() {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'CrmDiagnostics.gs'), 'utf8'), context);
  const range = {
    protect() {
      return {
        canEdit() { return true; },
        remove() { throw new Error('cleanup failure'); },
      };
    },
    getA1Notation() { return 'J3:J3'; },
  };
  assert.match(context.canDiagnosticCurrentUserEditRange_({}, range), /failed: temporary protection cleanup failed/);
});

test('diagnostic report write failure is explicit after protection diagnostics complete', () => {
  let cleanupSummaryCalled = 0;
  const sheets = {
    LEADS: { getName() { return 'LEADS'; }, getLastRow() { return 1; } },
    ACTIVITY_LOG: {},
  };
  const spreadsheet = {
    getSheetByName(name) { return sheets[name] || null; },
    getActiveSheet() { return sheets.LEADS; },
    toast() {},
  };
  const context = {
    SpreadsheetApp: { getActive() { return spreadsheet; } },
    ScriptApp: { getProjectTriggers() { return []; } },
    Session: {
      getActiveUser() { return { getEmail() { return 'person@example.test'; } }; },
      getEffectiveUser() { return { getEmail() { return 'person@example.test'; } }; },
    },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha' }, Charset: { UTF_8: 'utf8' }, computeDigest(_a, value) { return digest(value); } },
    Logger: { log() {} },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(appsScriptRoot, 'CrmDiagnostics.gs'), 'utf8'), context);
  context.getDiagnosticProtectionSummary_ = () => {
    cleanupSummaryCalled++;
    return { rangeCount: 0, sheetCount: 0, jProtected: false, kProtected: false, canEditJ: 'unknown', canEditK: 'unknown' };
  };
  context.checkDiagnosticLeadsSchema_ = () => ({ values: {}, notes: {}, warnings: [] });
  context.countDiagnosticRecentSalesNotes_ = () => 0;
  context.writeDiagnosticReport_ = () => { throw new Error('simulated diagnostic report failure'); };
  assert.throws(() => context.diagnoseCrmSetup(), /simulated diagnostic report failure/);
  assert.strictEqual(cleanupSummaryCalled, 1);
});

test('production and isolated Apps Script sources compile and production references resolve', () => {
  const files = fs.readdirSync(appsScriptRoot).filter(file => file.endsWith('.gs'));
  const definitions = new Set();
  const references = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(appsScriptRoot, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
    for (const match of source.matchAll(/^\s*function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)) definitions.add(match[1]);
    for (const match of source.matchAll(/\.addItem\([^,]+,\s*'([^']+)'\s*\)/g)) references.push(match[1]);
    for (const match of source.matchAll(/\.newTrigger\(\s*'([^']+)'\s*\)/g)) references.push(match[1]);
    for (const match of source.matchAll(/typeof\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*===\s*'function'/g)) references.push(match[1]);
  }
  assert.deepStrictEqual(references.filter(handler => !definitions.has(handler)), []);
  const adminRoot = path.join(repoRoot, 'admin-tools/apps-script');
  for (const file of fs.readdirSync(adminRoot).filter(file => file.endsWith('.gs'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(adminRoot, file), 'utf8'), { filename: file }), file);
  }
  const audioSource = fs.readFileSync(path.join(adminRoot, 'AudioMetadataAudit.gs'), 'utf8');
  assert.match(audioSource, /function\s+getAudioRootFolderId_\s*\(/);
  const diagnosticSource = fs.readFileSync(path.join(appsScriptRoot, 'CrmDiagnostics.gs'), 'utf8');
  assert.doesNotMatch(diagnosticSource, /'spreadsheet_id'|'spreadsheet_name'|'lead_id',/);
});
