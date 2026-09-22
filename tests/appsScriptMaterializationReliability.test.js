const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CODE_PATH = path.join(ROOT, 'apps-script', 'Code.gs');
const LEADS_VIEW_PATH = path.join(ROOT, 'apps-script', 'LeadsView.gs');
const CODE_SOURCE = fs.readFileSync(CODE_PATH, 'utf8');
const LEADS_VIEW_SOURCE = fs.readFileSync(LEADS_VIEW_PATH, 'utf8');
const STATUS = {
  MATERIALIZED_SUCCESS: 'MATERIALIZED_SUCCESS',
  ALREADY_MATERIALIZED: 'ALREADY_MATERIALIZED',
  EMPTY_SOURCE_ROW_SKIPPED: 'EMPTY_SOURCE_ROW_SKIPPED',
  INVALID_SOURCE_ROW_REPORTED: 'INVALID_SOURCE_ROW_REPORTED',
  RETRYABLE_WRITE_FAILURE: 'RETRYABLE_WRITE_FAILURE',
  AMBIGUOUS_TARGET_FAILURE: 'AMBIGUOUS_TARGET_FAILURE',
};

function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'missing function ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

function normalizeHeader(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function rowFromInput(headers, input) {
  return headers.map(header => input[normalizeHeader(header)] == null ? '' : input[normalizeHeader(header)]);
}

function createWorkerHarness(options = {}) {
  const logs = [];
  const propertyWrites = [];
  const properties = new Map();
  const state = {
    now: options.now || 1000,
    lockAvailable: options.lockAvailable !== false,
    failWriteOnce: options.failWriteOnce || (() => null),
    failReadOnce: options.failReadOnce || (() => null),
    onPersistWrite: options.onPersistWrite || (() => {}),
    writeEvents: [],
    readEvents: [],
    failedWrites: new Set(),
    failedReads: new Set(),
  };

  class FakeRange {
    constructor(sheet, row, column, rowCount, columnCount) {
      this.sheet = sheet;
      this.row = row;
      this.column = column;
      this.rowCount = rowCount;
      this.columnCount = columnCount;
    }

    values() {
      return Array.from({ length: this.rowCount }, (_, rowOffset) => (
        Array.from({ length: this.columnCount }, (_, columnOffset) => (
          this.sheet.valueAt(this.row + rowOffset, this.column + columnOffset)
        ))
      ));
    }

    getValues() {
      return this.values();
    }

    getValue() {
      const event = { type: 'read', sheet: this.sheet.name, row: this.row, column: this.column };
      state.readEvents.push(event);
      const failure = state.failReadOnce(event);
      if (failure && !state.failedReads.has(failure.key || 'read')) {
        state.failedReads.add(failure.key || 'read');
        throw new Error(failure.message || 'injected read failure');
      }
      return this.sheet.valueAt(this.row, this.column);
    }

    setValue(value) {
      const event = { type: 'write', sheet: this.sheet.name, row: this.row, column: this.column, value };
      state.writeEvents.push(event);
      const failure = state.failWriteOnce(event);
      if (failure && !state.failedWrites.has(failure.key || 'write')) {
        state.failedWrites.add(failure.key || 'write');
        if (failure.persist) {
          this.sheet.setValueAt(this.row, this.column, value);
          state.onPersistWrite(event);
        }
        throw new Error(failure.message || 'injected write failure');
      }
      this.sheet.setValueAt(this.row, this.column, value);
      state.onPersistWrite(event);
      return this;
    }

    setValues(values) {
      values.forEach((rowValues, rowOffset) => rowValues.forEach((value, columnOffset) => {
        this.sheet.getRange(this.row + rowOffset, this.column + columnOffset).setValue(value);
      }));
      return this;
    }

    clearContent() {
      for (let row = this.row; row < this.row + this.rowCount; row++) {
        for (let column = this.column; column < this.column + this.columnCount; column++) {
          this.sheet.setValueAt(row, column, '');
        }
      }
      return this;
    }

    getA1Notation() {
      return this.sheet.name + '!R' + this.row + 'C' + this.column;
    }
  }

  class FakeSheet {
    constructor(name, headers, rows) {
      this.name = name;
      this.headers = headers.slice();
      this.data = rows.map(row => row.slice());
    }

    getName() { return this.name; }
    getLastRow() { return Math.max(2, this.data.length + 2); }
    getLastColumn() { return this.headers.length; }
    ensureDataRow(row) {
      while (this.data.length < row - 2) this.data.push(Array(this.headers.length).fill(''));
      while (this.data[row - 3].length < this.headers.length) this.data[row - 3].push('');
    }
    valueAt(row, column) {
      if (row === 1) return this.headers[column - 1] || '';
      if (row === 2) return '';
      this.ensureDataRow(row);
      return this.data[row - 3][column - 1] == null ? '' : this.data[row - 3][column - 1];
    }
    setValueAt(row, column, value) {
      this.ensureDataRow(row);
      this.data[row - 3][column - 1] = value;
    }
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return new FakeRange(this, row, column, rowCount, columnCount);
    }
  }

  const sourceHeaders = options.sourceHeaders || [
    'Lead ID', 'Facebook Created Time', 'Customer Name', 'Phone', 'Lead Status',
    'Preferred Call Day', 'Preferred Call Time', 'Sales Owner',
  ];
  const targetHeaders = [
    'Lead ID', 'Facebook Created Time', 'Customer Name', 'Phone', 'Additional Phone',
    'Lead Status', 'Preferred Call Day', 'Preferred Call Time', 'Sales Owner',
    'Sales Note Input', 'Sales Note History', 'Follow-up Count', 'Latest Audio Link',
    'Facebook Search Name', 'Open Detail',
  ];
  const sourceInputs = options.sourceRows || [{ lead_id: 'SYN-001', customer_name: 'Synthetic One', phone: 'synthetic' }];
  const sourceRows = sourceInputs.map(input => rowFromInput(sourceHeaders, input));
  const targetInputs = options.targetRows || [];
  const targetRows = targetInputs.map(input => rowFromInput(targetHeaders, input));
  const source = new FakeSheet('LEADS_MAIN', sourceHeaders, sourceRows);
  const target = new FakeSheet('LEADS', targetHeaders, targetRows);

  const spreadsheet = {
    getSheetByName(name) {
      if (name === 'LEADS_MAIN') return source;
      if (name === 'LEADS') return target;
      return null;
    },
    getActive() { return spreadsheet; },
    toast() {},
  };

  const context = {
    console,
    Date: class extends Date {
      static now() { return state.now; }
    },
    SpreadsheetApp: {
      getActive: () => spreadsheet,
      flush: () => {},
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.has(key) ? properties.get(key) : null,
        setProperty: (key, value) => {
          properties.set(key, String(value));
          propertyWrites.push({ key, value: String(value) });
        },
        deleteProperty: key => properties.delete(key),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => state.lockAvailable,
        releaseLock: () => {},
      }),
    },
    Utilities: {
      getUuid: () => 'synthetic-uuid',
      sleep: () => {},
    },
    Logger: { log: value => logs.push(String(value)) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
    ScriptApp: { getProjectTriggers: () => [] },
    LEAD_MAIN_STATUS_VALUES: ['New', 'Ongoing', 'Installed', 'Done', 'Cancelled'],
    setupLeadsViewRowUi: () => false,
    getSafeSessionEmail_: () => '',
    setupLeadsViewDataRangeUi_: () => {},
  };
  vm.createContext(context);
  vm.runInContext(CODE_SOURCE, context, { filename: CODE_PATH });
  vm.runInContext(LEADS_VIEW_SOURCE, context, { filename: LEADS_VIEW_PATH });
  context.setupLeadsViewRowUi = () => false;

  const harness = {
    context,
    source,
    target,
    logs,
    propertyWrites,
    state,
    properties,
    run(limit) { return context.syncLeadsViewCursorBatchUnlocked_(limit); },
    setCursor(row) { properties.set('LEADS_VIEW_SCHEDULED_NEXT_ROW', String(row)); },
    cursor() { return properties.get('LEADS_VIEW_SCHEDULED_NEXT_ROW') || null; },
    targetIds() { return target.data.map(row => String(row[0] || '').trim()).filter(Boolean); },
    targetValue(row, column) { return target.valueAt(row, column); },
  };
  state.onPersistWrite = event => {
    options.onPersistWrite?.(event, harness);
  };
  return harness;
}

test('Apps Script materialization sources parse and expose the bounded worker', () => {
  new vm.Script(CODE_SOURCE, { filename: CODE_PATH });
  new vm.Script(LEADS_VIEW_SOURCE, { filename: LEADS_VIEW_PATH });
  assert.match(LEADS_VIEW_SOURCE, /function syncLeadsViewCursorBatchUnlocked_\(/);
  assert.match(LEADS_VIEW_SOURCE, /LEADS_VIEW_SCHEDULED_MAX_BATCH_SIZE = 20/);
  Object.values(STATUS).forEach(status => assert.match(LEADS_VIEW_SOURCE, new RegExp(status + ": ['\\\"]" + status + "['\\\"]")));
});

test('onChange remains audit/UI-only and does not call the materialization worker', () => {
  const body = functionBody(CODE_SOURCE, 'onChange');
  assert.doesNotMatch(body, /syncLeadsView/);
  assert.match(body, /recordCrmFormatAuditChange_/);
  assert.match(body, /setupRecentlyAppendedRows_/);
});

test('the worker enforces the maximum batch and runtime boundary', () => {
  assert.match(LEADS_VIEW_SOURCE, /const batchSize = Math\.min\(requestedBatchSize, LEADS_VIEW_SCHEDULED_MAX_BATCH_SIZE\)/);
  assert.match(LEADS_VIEW_SOURCE, /LEADS_VIEW_SCHEDULED_RUNTIME_BUDGET_MS/);
  assert.match(functionBody(LEADS_VIEW_SOURCE, 'syncLeadsViewCursorBatchUnlocked_'), /reason = 'runtime_budget'/);
});

test('new rows use identity-first write, flush, readback, then business fields', () => {
  const body = functionBody(LEADS_VIEW_SOURCE, 'syncLeadMainRowToLeadsView_');
  assert.match(body, /writeLeadsViewLeadIdAndVerify_/);
  assert.match(body, /skipLeadId: true/);
  assert.match(functionBody(LEADS_VIEW_SOURCE, 'writeLeadsViewLeadIdAndVerify_'), /SpreadsheetApp\.flush\(\)/);
  assert.match(functionBody(LEADS_VIEW_SOURCE, 'writeLeadsViewLeadIdAndVerify_'), /verifyLeadsViewLeadId_/);
});

test('lock acquisition is a bounded stop with a retryable status', () => {
  const harness = createWorkerHarness({ lockAvailable: false });
  const result = harness.context.withLeadsViewScriptLock_('test', 1, () => assert.fail('lock callback ran'));
  assert.equal(result.lock_acquired, false);
  assert.equal(result.status, STATUS.RETRYABLE_WRITE_FAILURE);
  assert.equal(result.reason, 'lock_timeout');
});

test('cursor advancement is limited to the four safe statuses', () => {
  const body = functionBody(LEADS_VIEW_SOURCE, 'syncLeadsViewCursorBatchUnlocked_');
  assert.match(body, /MATERIALIZED_SUCCESS/);
  assert.match(body, /ALREADY_MATERIALIZED/);
  assert.match(body, /EMPTY_SOURCE_ROW_SKIPPED/);
  assert.match(body, /INVALID_SOURCE_ROW_REPORTED/);
  assert.match(body, /RETRYABLE_WRITE_FAILURE/);
  assert.match(body, /AMBIGUOUS_TARGET_FAILURE/);
  assert.match(body, /canAdvanceCursor/);
});

test('normal scheduled sync has no admin repair path', () => {
  const body = functionBody(LEADS_VIEW_SOURCE, 'syncLeadsViewCursorBatchUnlocked_');
  assert.doesNotMatch(body, /repairLeadsViewFromLeadMain/);
  assert.doesNotMatch(body, /resetLeadsViewRefreshCursor/);
});

test('lag diagnostic reads source and target state without property writes', () => {
  const body = functionBody(LEADS_VIEW_SOURCE, 'getLeadsViewMaterializationLagDiagnostic');
  assert.match(body, /getRange/);
  assert.doesNotMatch(body, /setProperty/);
  assert.match(body, /invalid_source_row_count/);
});

test('manual-field preservation is explicit in the normal mapper', () => {
  const body = functionBody(LEADS_VIEW_SOURCE, 'syncLeadMainRowToLeadsView_');
  assert.match(body, /manualByLeadId/);
  assert.match(body, /skipSalesNoteHistory: true/);
  assert.match(functionBody(LEADS_VIEW_SOURCE, 'buildLeadsViewObject_'), /manual\.open_detail/);
});

test('harness materializes a synthetic source row through actual Apps Script functions', () => {
  const harness = createWorkerHarness();
  const result = harness.run(20);
  assert.equal(result.synced, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
  const targetWrites = harness.state.writeEvents.filter(event => event.sheet === 'LEADS');
  assert.equal(targetWrites[0].column, 1);
  assert.ok(targetWrites.slice(1).every(event => event.column !== 1));
  assert.equal(harness.cursor(), '3');
});

test('identity write failure writes no business fields and leaves cursor for retry', () => {
  const harness = createWorkerHarness({
    failWriteOnce: event => event.sheet === 'LEADS' && event.column === 1 ? { key: 'identity', persist: false } : null,
  });
  const failed = harness.run(20);
  assert.equal(failed.failed, 1);
  assert.equal(failed.status, STATUS.RETRYABLE_WRITE_FAILURE);
  assert.equal(harness.cursor(), null);
  assert.equal(harness.target.data.length, 0);
  assert.equal(harness.targetValue(3, 3), '');
  const retried = harness.run(20);
  assert.equal(retried.synced, 1);
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
});

test('persisted identity with failed readback retries the same exact row without a duplicate', () => {
  const harness = createWorkerHarness({
    failReadOnce: event => event.sheet === 'LEADS' && event.column === 1 ? { key: 'identity-readback' } : null,
  });
  const failed = harness.run(20);
  assert.equal(failed.failed, 1);
  assert.equal(failed.status, STATUS.AMBIGUOUS_TARGET_FAILURE);
  assert.equal(harness.cursor(), null);
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
  const retried = harness.run(20);
  assert.equal(retried.already_materialized, 1);
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
  assert.equal(harness.target.data.length, 1);
});

test('post-identity field failure leaves the identity and converges on retry', () => {
  const harness = createWorkerHarness({
    failWriteOnce: event => event.sheet === 'LEADS' && event.column === 3 ? { key: 'field', persist: false } : null,
  });
  const failed = harness.run(20);
  assert.equal(failed.failed, 1);
  assert.equal(failed.status, STATUS.RETRYABLE_WRITE_FAILURE);
  assert.equal(harness.cursor(), null);
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
  const retried = harness.run(20);
  assert.equal(retried.already_materialized, 1);
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
  assert.equal(harness.targetValue(3, 3), 'Synthetic One');
});

test('lock unavailable causes no source or target writes and no cursor advance', () => {
  const harness = createWorkerHarness({ lockAvailable: false });
  const result = harness.context.syncLeadsViewCursorBatch_(20);
  assert.equal(result.lock_acquired, false);
  assert.equal(harness.state.writeEvents.length, 0);
  assert.equal(harness.cursor(), null);
});

test('runtime budget stops before starting another row and preserves cursor', () => {
  const harness = createWorkerHarness({
    sourceRows: [
      { lead_id: 'SYN-001', customer_name: 'One' },
      { lead_id: 'SYN-002', customer_name: 'Two' },
    ],
    onPersistWrite: (event, current) => {
      if (event.sheet === 'LEADS' && event.column === 1 && event.value === 'SYN-001') current.state.now = 181000;
    },
  });
  const result = harness.run(20);
  assert.equal(result.synced, 1);
  assert.equal(result.reason, 'runtime_budget');
  assert.equal(harness.cursor(), '4');
  assert.deepEqual(harness.targetIds(), ['SYN-001']);
});

test('batch size is capped at twenty rows', () => {
  const sourceRows = Array.from({ length: 25 }, (_, index) => ({ lead_id: 'SYN-' + String(index + 1).padStart(3, '0'), customer_name: 'Synthetic ' + index }));
  const harness = createWorkerHarness({ sourceRows });
  harness.setCursor(3);
  const result = harness.run(99);
  assert.equal(result.checked, 20);
  assert.equal(result.synced, 20);
  assert.equal(harness.target.data.length, 20);
  assert.equal(harness.cursor(), '23');
});

test('middle-row failure stops later rows and retry resumes at the failed source row', () => {
  const sourceRows = Array.from({ length: 8 }, (_, index) => ({ lead_id: 'SYN-' + String(index + 1).padStart(3, '0'), customer_name: 'Synthetic ' + index }));
  const harness = createWorkerHarness({
    sourceRows,
    failWriteOnce: event => event.sheet === 'LEADS' && event.column === 1 && event.value === 'SYN-005'
      ? { key: 'middle', persist: false }
      : null,
  });
  const first = harness.run(20);
  assert.equal(first.synced, 4);
  assert.equal(first.failed, 1);
  assert.equal(harness.cursor(), '7');
  assert.deepEqual(harness.targetIds(), ['SYN-001', 'SYN-002', 'SYN-003', 'SYN-004']);
  const second = harness.run(20);
  assert.equal(second.synced, 4);
  assert.deepEqual(harness.targetIds(), sourceRows.map(row => row.lead_id));
});

test('empty and invalid source rows advance safely with explicit anomaly accounting', () => {
  const harness = createWorkerHarness({
    sourceRows: [
      {},
      { customer_name: 'Invalid without ID' },
      { lead_id: 'SYN-003', customer_name: 'Valid after anomaly' },
    ],
  });
  const result = harness.run(20);
  assert.equal(result.empty_source_row_count, 1);
  assert.equal(result.invalid_source_row_count, 1);
  assert.equal(result.first_invalid_source_row, 4);
  assert.equal(result.synced, 1);
  assert.equal(result.failed, 0);
  assert.equal(harness.cursor(), '3');
  assert.deepEqual(harness.targetIds(), ['SYN-003']);
  assert.equal(harness.logs.some(line => line.includes('Invalid without ID')), false);
});

test('duplicate target identity fails closed without adding a second target row', () => {
  const harness = createWorkerHarness({
    targetRows: [{ lead_id: 'SYN-001', customer_name: 'Existing' }, { lead_id: 'SYN-001', customer_name: 'Duplicate' }],
  });
  const result = harness.run(20);
  assert.equal(result.failed, 1);
  assert.equal(result.status, STATUS.AMBIGUOUS_TARGET_FAILURE);
  assert.equal(harness.cursor(), null);
  assert.equal(harness.target.data.length, 2);
});

test('source growth is deferred to a later invocation after the current end', () => {
  const harness = createWorkerHarness({
    sourceRows: [{ lead_id: 'SYN-001', customer_name: 'One' }],
    onPersistWrite: (event, current) => {
      if (event.sheet === 'LEADS' && event.column === 1 && event.value === 'SYN-001') {
        current.source.data.push(rowFromInput(current.source.headers, { lead_id: 'SYN-002', customer_name: 'Two' }));
      }
    },
  });
  const first = harness.run(20);
  assert.equal(first.synced, 1);
  assert.equal(harness.cursor(), '3');
  const second = harness.run(20);
  assert.equal(second.synced, 1);
  assert.deepEqual(harness.targetIds(), ['SYN-001', 'SYN-002']);
});

test('all supported manual fields survive an existing-row sync', () => {
  const manual = {
    lead_id: 'SYN-001',
    additional_phone: 'manual-additional',
    sales_note_input: 'manual-input',
    sales_note_history: 'manual-history',
    follow_up_count: 7,
    latest_audio_link: 'https://synthetic.invalid/audio',
    open_detail: true,
    preferred_call_day: 'Friday',
    preferred_call_time: '10:30',
    sales_owner: 'Synthetic Owner',
  };
  const harness = createWorkerHarness({ targetRows: [manual] });
  const result = harness.run(20);
  assert.equal(result.already_materialized, 1);
  assert.equal(harness.targetValue(3, 5), 'manual-additional');
  assert.equal(harness.targetValue(3, 10), 'manual-input');
  assert.equal(harness.targetValue(3, 11), 'manual-history');
  assert.equal(harness.targetValue(3, 12), 7);
  assert.equal(harness.targetValue(3, 13), 'https://synthetic.invalid/audio');
  assert.equal(harness.targetValue(3, 15), true);
  assert.equal(harness.targetValue(3, 7), 'Friday');
  assert.equal(harness.targetValue(3, 8), '10:30');
  assert.equal(harness.targetValue(3, 9), 'Synthetic Owner');
});

test('lag diagnostic reports missing, invalid, and duplicate identities without writing properties', () => {
  const harness = createWorkerHarness({
    sourceRows: [
      { lead_id: 'SYN-001', customer_name: 'One' },
      { customer_name: 'Invalid' },
      { lead_id: 'SYN-003', customer_name: 'Missing target' },
    ],
    targetRows: [
      { lead_id: 'SYN-001', customer_name: 'One' },
      { lead_id: 'SYN-001', customer_name: 'Duplicate' },
    ],
  });
  const before = harness.propertyWrites.length;
  const result = harness.context.getLeadsViewMaterializationLagDiagnostic();
  assert.equal(result.invalid_source_row_count, 1);
  assert.equal(result.duplicate_lead_id_count, 1);
  assert.equal(result.missing_lead_id_count, 1);
  assert.equal(result.lag_detected, true);
  assert.equal(harness.propertyWrites.length, before);
});

test('R2 backend files contain no R3 materialization worker or view ownership', () => {
  ['server.js', 'services/googleSheets.js'].forEach(file => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /syncLeadsViewCursorBatch|LEADS_VIEW_SCHEDULED_CURSOR_KEY/);
  });
});
