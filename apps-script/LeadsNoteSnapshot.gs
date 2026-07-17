// LEADS note-history snapshot and recoverable Activity Log synchronization.
// Every mutating entrypoint acquires the script lock. A pending transition is
// written before the Activity Log append so a later run can finish either side
// of an execution interruption without emitting a duplicate event.
const LEADS_NOTE_SNAPSHOT_SHEET_NAME = 'LEADS_NOTE_SNAPSHOT';
const LEADS_NOTE_SNAPSHOT_CURSOR_KEY = 'LEADS_NOTE_SNAPSHOT_NEXT_ROW';
const LEADS_NOTE_SNAPSHOT_BASELINE_VERSION_KEY = 'LEADS_NOTE_SNAPSHOT_BASELINE_VERSION';
const LEADS_NOTE_SNAPSHOT_BASELINE_VERSION = '2';
const LEADS_NOTE_SYNC_BATCH_SIZE = 100;
const LEADS_NOTE_LOCK_TIMEOUT_MS = 5000;
const LEADS_NOTE_PENDING_STATE = 'pending';
const LEADS_NOTE_PENDING_PROTOCOL_VERSION = '1';
// Pending and Activity Log timestamps use one explicit wire format. They are
// stored as strings so recovery can compare the exact payload, not a locale- or
// sheet-coerced Date value.
const LEADS_NOTE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEADS_NOTE_SUPPORTED_ACTION_TYPES = {
  'Sales Note': true,
  'Sales Note History Updated': true,
};
const LEADS_NOTE_SNAPSHOT_HEADERS = [
  'lead_id',
  'leads_row',
  'last_k_hash',
  'last_k_value',
  'last_synced_at',
  'last_activity_log_row',
  'pending_event_id',
  'pending_lead_id',
  'pending_previous_hash',
  'pending_target_hash',
  'pending_target_value',
  'pending_action_type',
  'pending_note',
  'pending_created_by',
  'pending_created_at',
  'pending_state',
  'pending_protocol_version',
];

function initializeLeadsNoteSnapshot() {
  const result = withLeadsNoteSnapshotLock_('Initialize LEADS Note Snapshot', function () {
    return initializeLeadsNoteSnapshot_();
  });
  SpreadsheetApp.getActive().toast(
    'Initialized LEADS note snapshot rows: ' + result.snapshot_rows,
    'LEADS Note Snapshot',
    6
  );
  return result;
}

function syncLeadsNoteHistoryToActivityLogNow() {
  const result = withLeadsNoteSnapshotLock_('Sync LEADS Note History', function () {
    return syncLeadsNoteHistoryToActivityLogBatch_(300);
  });
  toastLeadsNoteSyncResult_(result, 'LEADS Note Sync');
  return result;
}

function syncLeadsNoteHistoryToActivityLogContinue() {
  const result = withLeadsNoteSnapshotLock_('Continue LEADS Note History Sync', function () {
    return syncLeadsNoteHistoryToActivityLogBatch_(300);
  });
  toastLeadsNoteSyncResult_(result, 'LEADS Note Sync Continue');
  return result;
}

function syncLeadsNoteHistoryToActivityLogScheduled() {
  return withLeadsNoteSnapshotLock_('Scheduled LEADS Note History Sync', function () {
    return syncLeadsNoteHistoryToActivityLogBatch_(LEADS_NOTE_SYNC_BATCH_SIZE);
  });
}

function installLeadsNoteSyncTrigger() {
  return withLeadsNoteSnapshotLock_('Install LEADS Note Sync Trigger', function () {
    const readiness = getLeadsNoteSnapshotReadiness_({ requireFullCoverage: true });
    if (!readiness.ready) {
      throw new Error('LEADS note trigger installation blocked: ' + readiness.errors.join(' '));
    }

    const previousTriggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === 'syncLeadsNoteHistoryToActivityLogScheduled';
    });
    let replacement;
    try {
      replacement = ScriptApp
        .newTrigger('syncLeadsNoteHistoryToActivityLogScheduled')
        .timeBased()
        .everyMinutes(10)
        .create();
    } catch (err) {
      throw new Error('Could not create replacement LEADS note trigger; existing triggers were preserved: ' + err.message);
    }

    if (!replacement || typeof replacement.getHandlerFunction !== 'function'
      || replacement.getHandlerFunction() !== 'syncLeadsNoteHistoryToActivityLogScheduled') {
      throw new Error('Replacement LEADS note trigger was not returned or has the wrong identity; existing triggers were preserved.');
    }

    // Only previously captured matching triggers are retired. The replacement
    // cannot be deleted because it was created after this capture.
    previousTriggers.forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
    return replacement;
  });
}

function initializeLeadsNoteSnapshot_() {
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty(LEADS_NOTE_SNAPSHOT_BASELINE_VERSION_KEY);
  let completed = false;
  try {
    const ss = SpreadsheetApp.getActive();
    const leadsSheet = ss.getSheetByName('LEADS');
    const leadsState = validateLeadsNoteLeadsSheet_(leadsSheet);
    const snapshotSheet = ensureLeadsNoteSnapshotSheet_();
    const state = validateLeadsNoteState_({
      leadsSheet: leadsSheet,
      leadsState: leadsState,
      snapshotSheet: snapshotSheet,
      requireFullCoverage: false,
    });
    if (!state.ready) {
      throw new Error('LEADS note initialization precondition failed: ' + state.errors.join(' '));
    }
    const rows = leadsState.records.map(function (record) {
      return buildLeadsNoteSnapshotRow_(record.leadId, record.rowNumber, record.historyValue, '');
    });

    clearLeadsNoteSnapshotData_(snapshotSheet);
    if (rows.length) {
      snapshotSheet
        .getRange(DATA_START_ROW, 1, rows.length, LEADS_NOTE_SNAPSHOT_HEADERS.length)
        .setValues(rows);
    }
    if (!snapshotSheet.isSheetHidden()) snapshotSheet.hideSheet();

    properties.setProperty(LEADS_NOTE_SNAPSHOT_CURSOR_KEY, String(DATA_START_ROW));
    const verified = validateLeadsNoteState_({
      leadsSheet: leadsSheet,
      snapshotSheet: snapshotSheet,
      requireFullCoverage: true,
    });
    if (!verified.ready) {
      throw new Error('Baseline verification failed after write: ' + verified.errors.join(' '));
    }
    properties.setProperty(LEADS_NOTE_SNAPSHOT_BASELINE_VERSION_KEY, LEADS_NOTE_SNAPSHOT_BASELINE_VERSION);
    completed = true;
    Logger.log('initializeLeadsNoteSnapshot snapshot_rows=' + rows.length);
    return { snapshot_rows: rows.length };
  } finally {
    if (!completed) properties.deleteProperty(LEADS_NOTE_SNAPSHOT_BASELINE_VERSION_KEY);
  }
}

function getLeadsNoteSnapshotScheduledSyncReadiness_() {
  return getLeadsNoteSnapshotReadiness_({ requireFullCoverage: true });
}

function getLeadsNoteSnapshotReadiness_(options) {
  const opts = options || {};
  const errors = [];
  const properties = PropertiesService.getScriptProperties();
  const baselineVersion = String(properties.getProperty(LEADS_NOTE_SNAPSHOT_BASELINE_VERSION_KEY) || '').trim();
  if (baselineVersion !== LEADS_NOTE_SNAPSHOT_BASELINE_VERSION) {
    errors.push('Baseline initialization marker is missing or outdated. Run Initialize LEADS Note Snapshot successfully before syncing or installing the trigger.');
  }

  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const snapshotSheet = ss.getSheetByName(LEADS_NOTE_SNAPSHOT_SHEET_NAME);
  if (!snapshotSheet) errors.push('Snapshot sheet LEADS_NOTE_SNAPSHOT is missing. Run Initialize LEADS Note Snapshot.');
  if (snapshotSheet && snapshotSheet.getName() !== LEADS_NOTE_SNAPSHOT_SHEET_NAME) {
    errors.push('Snapshot sheet identity does not match LEADS_NOTE_SNAPSHOT.');
  }
  const state = validateLeadsNoteState_({
    leadsSheet: leadsSheet,
    snapshotSheet: snapshotSheet,
    requireFullCoverage: opts.requireFullCoverage === true,
  });
  errors.push.apply(errors, state.errors);
  return {
    ready: errors.length === 0,
    errors: errors,
    eligible_leads_count: state.eligible_leads_count || 0,
    snapshot_leads_count: state.snapshot_leads_count || 0,
    missing_lead_ids_count: state.missing_lead_ids_count || 0,
  };
}

function validateLeadsNoteState_(options) {
  const opts = options || {};
  const errors = [];
  const leadsSheet = opts.leadsSheet || SpreadsheetApp.getActive().getSheetByName('LEADS');
  let leadsState = opts.leadsState;
  if (!leadsState) {
    try {
      leadsState = validateLeadsNoteLeadsSheet_(leadsSheet);
    } catch (err) {
      errors.push(err.message);
      return { ready: false, errors: errors };
    }
  }
  errors.push.apply(errors, leadsState.errors || []);

  const snapshotSheet = opts.snapshotSheet || SpreadsheetApp.getActive().getSheetByName(LEADS_NOTE_SNAPSHOT_SHEET_NAME);
  let snapshotState = { records: [], byLeadId: {}, errors: [] };
  if (!snapshotSheet) {
    errors.push('Snapshot sheet LEADS_NOTE_SNAPSHOT is missing.');
  } else {
    try {
      snapshotState = validateLeadsNoteSnapshotSheet_(snapshotSheet);
      errors.push.apply(errors, snapshotState.errors);
    } catch (err) {
      errors.push(err.message);
    }
  }

  let activitySheet = null;
  try {
    activitySheet = SpreadsheetApp.getActive().getSheetByName('ACTIVITY_LOG');
    validateLeadsNoteActivityLogSheet_(activitySheet);
  } catch (err) {
    errors.push(err.message);
  }

  const eligibleByLeadId = {};
  (leadsState.records || []).forEach(function (record) { eligibleByLeadId[record.leadId] = true; });
  const missingLeadIds = [];
  (leadsState.records || []).forEach(function (record) {
    if (!snapshotState.byLeadId[record.leadId]) missingLeadIds.push(record.leadId);
  });
  (snapshotState.records || []).forEach(function (record) {
    if (!eligibleByLeadId[record.leadId]) {
      errors.push('Snapshot contains Lead ID not present in LEADS: ' + record.leadId + '. Repair the snapshot before syncing.');
    }
  });
  if (opts.requireFullCoverage === true && missingLeadIds.length) {
    errors.push('Snapshot baseline coverage is incomplete for ' + missingLeadIds.length + ' eligible LEADS record(s): ' + missingLeadIds.slice(0, 10).join(', ') + '.');
  }

  return {
    ready: errors.length === 0,
    errors: errors,
    leadsSheet: leadsSheet,
    snapshotSheet: snapshotSheet,
    activitySheet: activitySheet,
    leadsState: leadsState,
    snapshotState: snapshotState,
    eligible_leads_count: (leadsState.records || []).length,
    snapshot_leads_count: (snapshotState.records || []).length,
    missing_lead_ids_count: missingLeadIds.length,
  };
}

function validateLeadsNoteLeadsSheet_(sheet) {
  const errors = [];
  if (!sheet || sheet.getName() !== 'LEADS') {
    errors.push('LEADS sheet identity is missing or does not match LEADS.');
    return { records: [], errors: errors };
  }
  const headers = getLeadsNoteHeaderValues_(sheet);
  const headerMap = getLeadsNoteHeaderMap_(headers);
  ['lead_id', 'sales_note_history'].forEach(function (required) {
    if (!headerMap[required]) errors.push('LEADS required header is missing: ' + required + '.');
  });
  if (errors.length) return { records: [], errors: errors };

  const records = [];
  const seen = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return { records: records, errors: errors, headerMap: headerMap };
  const width = Math.max(sheet.getLastColumn(), headers.length);
  const values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, width).getValues();
  values.forEach(function (row, index) {
    const rawLeadId = row[headerMap.lead_id - 1];
    if (rawLeadId === '' || rawLeadId === null || rawLeadId === undefined) return;
    let leadId;
    try {
      leadId = normalizeCanonicalLeadsNoteLeadId_(rawLeadId, 'LEADS row ' + (DATA_START_ROW + index));
    } catch (err) {
      errors.push(err.message);
      return;
    }
    if (seen[leadId]) {
      errors.push('LEADS contains duplicate canonical Lead ID: ' + leadId + ' (rows ' + seen[leadId] + ' and ' + (DATA_START_ROW + index) + ').');
      return;
    }
    seen[leadId] = DATA_START_ROW + index;
    records.push({
      leadId: leadId,
      rowNumber: DATA_START_ROW + index,
      historyValue: String(row[headerMap.sales_note_history - 1] || '').replace(/\r\n/g, '\n').trim(),
    });
  });
  return { records: records, errors: errors, headerMap: headerMap };
}

function validateLeadsNoteSnapshotSheet_(sheet) {
  const errors = [];
  const result = { records: [], byLeadId: {}, errors: errors };
  if (!sheet || sheet.getName() !== LEADS_NOTE_SNAPSHOT_SHEET_NAME) {
    errors.push('Snapshot sheet identity does not match LEADS_NOTE_SNAPSHOT.');
    return result;
  }
  const headers = getLeadsNoteHeaderValues_(sheet);
  const headerMap = getLeadsNoteHeaderMap_(headers);
  const missing = LEADS_NOTE_SNAPSHOT_HEADERS.filter(function (header) { return !headerMap[header]; });
  if (missing.length) {
    errors.push('Snapshot required headers are missing: ' + missing.join(', ') + '.');
    return result;
  }
  result.headerMap = headerMap;
  if (sheet.getLastRow() < DATA_START_ROW) return result;
  const width = Math.max(sheet.getLastColumn(), headers.length);
  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, width).getValues();
  const seen = {};
  values.forEach(function (row, index) {
    const rowNumber = DATA_START_ROW + index;
    const rawLeadId = row[headerMap.lead_id - 1];
    const hasAnyValue = row.some(function (value) { return value !== '' && value !== null && value !== undefined; });
    if (rawLeadId === '' || rawLeadId === null || rawLeadId === undefined) {
      if (hasAnyValue) errors.push('Snapshot row ' + rowNumber + ' has nonblank data but no Lead ID.');
      return;
    }
    let leadId;
    try {
      leadId = normalizeCanonicalLeadsNoteLeadId_(rawLeadId, 'Snapshot row ' + rowNumber);
    } catch (err) {
      errors.push(err.message);
      return;
    }
    if (seen[leadId]) {
      errors.push('Snapshot contains duplicate canonical Lead ID: ' + leadId + ' (rows ' + seen[leadId] + ' and ' + rowNumber + ').');
      return;
    }
    seen[leadId] = rowNumber;
    const object = {};
    LEADS_NOTE_SNAPSHOT_HEADERS.forEach(function (header) {
      object[header] = row[headerMap[header] - 1];
    });
    const storedValue = String(object.last_k_value || '').replace(/\r\n/g, '\n').trim();
    const storedHash = String(object.last_k_hash || '').trim();
    if (hashLeadsNoteValue_(storedValue) !== storedHash) {
      errors.push('Snapshot row ' + rowNumber + ' has a stored value/hash mismatch for Lead ID ' + leadId + '. Reinitialize only after reviewing the snapshot.');
    }
    try {
      validateLeadsNotePendingObject_(object, leadId, rowNumber, object);
    } catch (err) {
      errors.push(err.message);
    }
    const record = { leadId: leadId, rowNumber: rowNumber, object: object };
    result.records.push(record);
    result.byLeadId[leadId] = record;
  });
  if (Object.keys(seen).length !== result.records.length) {
    errors.push('Snapshot integrity validation failed; duplicate or malformed Lead IDs were found.');
  }
  return result;
}

function validateLeadsNoteActivityLogSheet_(sheet) {
  if (!sheet || sheet.getName() !== 'ACTIVITY_LOG') throw new Error('ACTIVITY_LOG sheet identity is missing or does not match ACTIVITY_LOG.');
  const headerMap = getLeadsNoteHeaderMap_(getLeadsNoteHeaderValues_(sheet));
  const missing = ['activity_id', 'lead_id', 'sheet_name', 'action_type', 'note', 'created_by', 'created_at']
    .filter(function (header) { return !headerMap[header]; });
  if (missing.length) throw new Error('ACTIVITY_LOG required headers are missing: ' + missing.join(', ') + '.');
  return headerMap;
}

function normalizeCanonicalLeadsNoteLeadId_(rawValue, context) {
  if (typeof rawValue !== 'string') throw new Error(context + ' Lead ID must be a string.');
  const trimmed = rawValue.trim();
  if (!trimmed) throw new Error(context + ' Lead ID must be nonblank.');
  if (rawValue !== trimmed) throw new Error(context + ' Lead ID is noncanonical because it has surrounding whitespace.');
  return trimmed;
}

function getLeadsNoteHeaderValues_(sheet) {
  if (!sheet || sheet.getLastRow() < HEADER_ROW) return [];
  const width = Math.max(sheet.getLastColumn(), LEADS_NOTE_SNAPSHOT_HEADERS.length);
  return sheet.getRange(HEADER_ROW, 1, 1, width).getValues()[0];
}

function getLeadsNoteHeaderMap_(headers) {
  const map = {};
  const duplicates = [];
  (headers || []).forEach(function (header, index) {
    const normalized = normalizeHeaderName_(header);
    if (!normalized) return;
    if (map[normalized]) duplicates.push(normalized);
    else map[normalized] = index + 1;
  });
  if (duplicates.length) {
    throw new Error('Duplicate required or recognized headers: ' + duplicates.join(', ') + '. Refusing to continue.');
  }
  return map;
}

function syncLeadsNoteHistoryToActivityLogBatch_(limit) {
  const readiness = getLeadsNoteSnapshotReadiness_({ requireFullCoverage: false });
  if (!readiness.ready) throw new Error('LEADS note sync precondition failed: ' + readiness.errors.join(' '));
  const state = validateLeadsNoteState_({ requireFullCoverage: false });
  const leads = state.leadsState.records;
  const snapshotSheet = state.snapshotSheet;
  const snapshotByLeadId = state.snapshotState.byLeadId;
  const properties = PropertiesService.getScriptProperties();
  const lastRow = state.leadsSheet.getLastRow();
  if (lastRow < DATA_START_ROW) {
    return { batchSize: Math.max(1, Number(limit) || LEADS_NOTE_SYNC_BATCH_SIZE), startRow: '', endRow: '', nextCursor: DATA_START_ROW, lastRow: lastRow, checked: 0, logged: 0, onboarded: 0, skipped: 0, task_completed: true };
  }
  const batchSize = Math.max(1, Number(limit) || LEADS_NOTE_SYNC_BATCH_SIZE);
  const savedCursor = Number(properties.getProperty(LEADS_NOTE_SNAPSHOT_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow ? savedCursor : DATA_START_ROW;
  const endRow = Math.min(startRow + batchSize - 1, lastRow);
  let checked = 0;
  let logged = 0;
  let onboarded = 0;
  let skipped = 0;

  leads.forEach(function (lead) {
    if (lead.rowNumber < startRow || lead.rowNumber > endRow) return;
    checked++;
    let snapshot = snapshotByLeadId[lead.leadId];
    if (!snapshot) {
      const rowNumber = Math.max(snapshotSheet.getLastRow() + 1, DATA_START_ROW);
      snapshotSheet.getRange(rowNumber, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length)
        .setValues([buildLeadsNoteSnapshotRow_(lead.leadId, lead.rowNumber, lead.historyValue, '')]);
      snapshot = { rowNumber: rowNumber, leadId: lead.leadId, object: buildLeadsNoteSnapshotObject_(lead.leadId, lead.rowNumber, lead.historyValue, '') };
      snapshotByLeadId[lead.leadId] = snapshot;
      onboarded++;
      return;
    }

    if (hasLeadsNotePendingState_(snapshot.object)) {
      recoverLeadsNotePendingTransition_(state, snapshot);
      snapshot = readLeadsNoteSnapshotRecord_(snapshotSheet, snapshot.rowNumber, state.snapshotState.headerMap);
      snapshotByLeadId[lead.leadId] = snapshot;
    }

    const currentHash = hashLeadsNoteValue_(lead.historyValue);
    const previousHash = String(snapshot.object.last_k_hash || '').trim();
    if (previousHash === currentHash) {
      skipped++;
      return;
    }
    processLeadsNoteTransition_(state, snapshot, lead.leadId, lead.rowNumber, lead.historyValue, lead.historyValue, 'Sales Note History Updated');
    logged++;
  });

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEADS_NOTE_SNAPSHOT_CURSOR_KEY, String(nextCursor));
  const result = {
    batchSize: batchSize,
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    lastRow: lastRow,
    checked: checked,
    logged: logged,
    onboarded: onboarded,
    skipped: skipped,
    task_completed: nextCursor === DATA_START_ROW,
  };
  Logger.log('syncLeadsNoteHistoryToActivityLog ' + JSON.stringify(result));
  return result;
}

function updateLeadsNoteSnapshotForLead_(leadId, leadsRow, historyValue, lastActivityLogRow, activityNote, actionType) {
  return withLeadsNoteSnapshotLock_('Update LEADS Note Snapshot', function () {
    return updateLeadsNoteSnapshotForLeadUnlocked_(leadId, leadsRow, historyValue, lastActivityLogRow, activityNote, actionType);
  });
}

function updateLeadsNoteSnapshotForLeadUnlocked_(leadId, leadsRow, historyValue, lastActivityLogRow, activityNote, actionType) {
    const state = validateLeadsNoteState_({ requireFullCoverage: false });
    if (!state.ready) throw new Error('LEADS note update precondition failed: ' + state.errors.join(' '));
    const targetLeadId = normalizeCanonicalLeadsNoteLeadId_(String(leadId || ''), 'LEADS note update');
    let snapshot = state.snapshotState.byLeadId[targetLeadId];
    if (!snapshot) {
      const rowNumber = Math.max(state.snapshotSheet.getLastRow() + 1, DATA_START_ROW);
      state.snapshotSheet.getRange(rowNumber, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length)
        .setValues([buildLeadsNoteSnapshotRow_(targetLeadId, leadsRow, historyValue, '')]);
      return { changed: false, onboarded: true };
    }
    if (hasLeadsNotePendingState_(snapshot.object)) {
      recoverLeadsNotePendingTransition_(state, snapshot);
      // Recovery commits the transition and changes the snapshot object. Use
      // a fresh read before deciding whether the current history needs another
      // transition; otherwise an interrupted onEdit could append a second
      // event for the same already-recovered history value.
      snapshot = readLeadsNoteSnapshotRecord_(state.snapshotSheet, snapshot.rowNumber, state.snapshotState.headerMap);
    }
    const targetValue = String(historyValue || '').replace(/\r\n/g, '\n').trim();
    if (String(snapshot.object.last_k_hash || '').trim() === hashLeadsNoteValue_(targetValue)) return { changed: false };
    return processLeadsNoteTransition_(
      state,
      snapshot,
      targetLeadId,
      leadsRow,
      targetValue,
      activityNote || targetValue,
      actionType || 'Sales Note History Updated'
    );
}

function processLeadsNoteTransition_(state, snapshot, leadId, leadsRow, targetValue, activityNote, actionType) {
  const object = snapshot.object;
  const previousHash = String(object.last_k_hash || '').trim();
  const normalizedTargetValue = String(targetValue === null || targetValue === undefined ? '' : targetValue)
    .replace(/\r\n/g, '\n')
    .trim();
  const targetHash = hashLeadsNoteValue_(normalizedTargetValue);
  if (previousHash === targetHash) return { changed: false };
  const eventId = 'ACT-LEADS-NOTE-v1-' + previousHash + '-' + targetHash + '-' + createLeadsNoteEventNonce_();
  const createdAt = new Date().toISOString();
  const pending = {
    pending_event_id: eventId,
    pending_lead_id: leadId,
    pending_previous_hash: previousHash,
    pending_target_hash: targetHash,
    pending_target_value: normalizedTargetValue,
    pending_action_type: actionType || 'Sales Note History Updated',
    pending_note: String(activityNote || (normalizedTargetValue || 'Sales Note History cleared in LEADS.')),
    pending_created_by: typeof getSafeCrmUserEmail_ === 'function' ? getSafeCrmUserEmail_() : 'unknown',
    pending_created_at: createdAt,
    pending_state: LEADS_NOTE_PENDING_STATE,
    pending_protocol_version: LEADS_NOTE_PENDING_PROTOCOL_VERSION,
  };
  validateLeadsNotePendingObject_(pending, leadId, snapshot.rowNumber, object);
  writeLeadsNoteSnapshotFields_(state.snapshotSheet, snapshot.rowNumber, state.snapshotState.headerMap, pending);
  const activityRow = appendOrConfirmLeadsNoteActivity_(state.activitySheet, pending);
  commitLeadsNoteTransition_(state.snapshotSheet, snapshot.rowNumber, state.snapshotState.headerMap, object, leadId, leadsRow, normalizedTargetValue, activityRow);
  return { changed: true, event_id: eventId, activity_log_row: activityRow };
}

function recoverLeadsNotePendingTransition_(state, snapshot) {
  const pending = snapshot.object;
  validateLeadsNotePendingObject_(pending, snapshot.leadId, snapshot.rowNumber, pending);
  const activityRow = appendOrConfirmLeadsNoteActivity_(state.activitySheet, pending);
  commitLeadsNoteTransition_(
    state.snapshotSheet,
    snapshot.rowNumber,
    state.snapshotState.headerMap,
    pending,
    snapshot.leadId,
    pending.leads_row || '',
    pending.pending_target_value,
    activityRow
  );
  return activityRow;
}

function appendOrConfirmLeadsNoteActivity_(activitySheet, pending) {
  const activityMap = validateLeadsNoteActivityLogSheet_(activitySheet);
  const existing = findLeadsNoteActivityEventRows_(activitySheet, activityMap, pending.pending_event_id);
  if (existing.length > 1) throw new Error('ACTIVITY_LOG contains duplicate event ID ' + pending.pending_event_id + '; refusing to continue.');
  if (existing.length === 1) {
    const row = existing[0];
    const values = activitySheet.getRange(row, 1, 1, activitySheet.getLastColumn()).getValues()[0];
    const expected = {
      activity_id: pending.pending_event_id,
      lead_id: pending.pending_lead_id,
      sheet_name: 'LEADS',
      action_type: pending.pending_action_type,
      note: pending.pending_note,
      created_by: pending.pending_created_by,
    };
    Object.keys(expected).forEach(function (field) {
      const storedValue = values[activityMap[field] - 1];
      if (typeof storedValue !== 'string' || storedValue !== expected[field]) {
        throw new Error('ACTIVITY_LOG event ID ' + pending.pending_event_id + ' has inconsistent ' + field + '; refusing to continue.');
      }
    });
    if (!leadsNoteDatesEqual_(values[activityMap.created_at - 1], pending.pending_created_at)) {
      throw new Error('ACTIVITY_LOG event ID ' + pending.pending_event_id + ' has inconsistent created_at; refusing to continue.');
    }
    validateLeadsNoteEventIdentity_(pending);
    return row;
  }
  return appendLeadsNoteActivityRowAtomically_(activitySheet, activityMap, {
    activity_id: pending.pending_event_id,
    lead_id: pending.pending_lead_id,
    sheet_name: 'LEADS',
    action_type: pending.pending_action_type,
    note: pending.pending_note,
    created_by: pending.pending_created_by,
    created_at: pending.pending_created_at,
  });
}

function appendLeadsNoteActivityRowAtomically_(activitySheet, activityMap, object) {
  const width = Math.max(activitySheet.getLastColumn(), Object.keys(activityMap).reduce(function (max, key) {
    return Math.max(max, activityMap[key]);
  }, 0));
  const row = Math.max(activitySheet.getLastRow() + 1, DATA_START_ROW);
  const values = Array(width).fill('');
  Object.keys(object).forEach(function (field) {
    if (activityMap[field]) values[activityMap[field] - 1] = object[field];
  });
  activitySheet.getRange(row, 1, 1, width).setValues([values]);
  return row;
}

function findLeadsNoteActivityEventRows_(sheet, headerMap, eventId) {
  const rows = [];
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return rows;
  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach(function (row, index) {
    if (String(row[headerMap.activity_id - 1] || '') === String(eventId)) rows.push(DATA_START_ROW + index);
  });
  return rows;
}

function commitLeadsNoteTransition_(sheet, row, headerMap, existingObject, leadId, leadsRow, targetValue, activityRow) {
  const object = existingObject || {};
  writeLeadsNoteSnapshotFields_(sheet, row, headerMap, {
    lead_id: leadId,
    leads_row: leadsRow,
    last_k_hash: hashLeadsNoteValue_(targetValue),
    last_k_value: targetValue,
    last_synced_at: new Date(),
    last_activity_log_row: activityRow || '',
    pending_event_id: '',
    pending_lead_id: '',
    pending_previous_hash: '',
    pending_target_hash: '',
    pending_target_value: '',
    pending_action_type: '',
    pending_note: '',
    pending_created_by: '',
    pending_created_at: '',
    pending_state: '',
    pending_protocol_version: '',
  });
}

function validateLeadsNotePendingObject_(object, leadId, rowNumber, committedObject) {
  const pendingFields = LEADS_NOTE_SNAPSHOT_HEADERS.slice(6);
  const present = pendingFields.filter(function (field) { return object[field] !== '' && object[field] !== null && object[field] !== undefined; });
  if (!present.length) return;
  const required = ['pending_event_id', 'pending_lead_id', 'pending_previous_hash', 'pending_target_hash', 'pending_target_value', 'pending_action_type', 'pending_note', 'pending_created_by', 'pending_created_at', 'pending_state', 'pending_protocol_version'];
  const missing = required.filter(function (field) {
    return object[field] === null || object[field] === undefined
      || (field !== 'pending_target_value' && object[field] === '');
  });
  if (missing.length) throw new Error('Snapshot row ' + rowNumber + ' has malformed pending state; missing ' + missing.join(', ') + '. Refusing to overwrite it.');
  const requiredStrings = [
    'pending_event_id', 'pending_lead_id', 'pending_previous_hash', 'pending_target_hash',
    'pending_target_value', 'pending_action_type', 'pending_note', 'pending_created_by',
    'pending_state', 'pending_protocol_version',
  ];
  const wrongTypes = requiredStrings.filter(function (field) { return typeof object[field] !== 'string'; });
  if (wrongTypes.length) throw new Error('Snapshot row ' + rowNumber + ' has non-string pending metadata: ' + wrongTypes.join(', ') + '.');
  if (object.pending_state !== LEADS_NOTE_PENDING_STATE) throw new Error('Snapshot row ' + rowNumber + ' has unknown pending state; refusing to overwrite it.');
  if (object.pending_lead_id !== leadId) throw new Error('Snapshot row ' + rowNumber + ' pending Lead ID does not match the snapshot Lead ID.');
  if (object.pending_protocol_version !== LEADS_NOTE_PENDING_PROTOCOL_VERSION) throw new Error('Snapshot row ' + rowNumber + ' has unsupported pending protocol version.');
  if (!Object.prototype.hasOwnProperty.call(LEADS_NOTE_SUPPORTED_ACTION_TYPES, object.pending_action_type)) throw new Error('Snapshot row ' + rowNumber + ' has unsupported pending action type.');
  canonicalLeadsNoteTimestamp_(object.pending_created_at, 'Snapshot row ' + rowNumber + ' pending_created_at');
  validateLeadsNoteEventIdentity_(object);
  if (!/^[a-f0-9]{64}$/.test(object.pending_previous_hash) || !/^[a-f0-9]{64}$/.test(object.pending_target_hash)) {
    throw new Error('Snapshot row ' + rowNumber + ' has malformed pending hash state; refusing to overwrite it.');
  }
  const committed = committedObject || object;
  const committedValue = String(committed.last_k_value === null || committed.last_k_value === undefined ? '' : committed.last_k_value)
    .replace(/\r\n/g, '\n').trim();
  const committedHash = String(committed.last_k_hash || '').trim();
  if (hashLeadsNoteValue_(committedValue) !== committedHash) {
    throw new Error('Snapshot row ' + rowNumber + ' committed value/hash mismatch; refusing to recover pending state.');
  }
  if (object.pending_previous_hash !== committedHash) {
    throw new Error('Snapshot row ' + rowNumber + ' pending previous hash does not match the committed snapshot state.');
  }
  const targetValue = object.pending_target_value
    .replace(/\r\n/g, '\n').trim();
  if (hashLeadsNoteValue_(targetValue) !== object.pending_target_hash) {
    throw new Error('Snapshot row ' + rowNumber + ' pending target value/hash mismatch; refusing to overwrite it.');
  }
}

function validateLeadsNoteEventIdentity_(pending) {
  if (!pending || typeof pending.pending_event_id !== 'string' || typeof pending.pending_protocol_version !== 'string') {
    throw new Error('Pending event has invalid metadata types.');
  }
  const eventId = pending.pending_event_id;
  const pattern = /^ACT-LEADS-NOTE-v1-([a-f0-9]{64})-([a-f0-9]{64})-([A-Za-z0-9_-]{8,128})$/;
  const match = eventId.match(pattern);
  if (!match || pending.pending_protocol_version !== LEADS_NOTE_PENDING_PROTOCOL_VERSION) {
    throw new Error('Pending event has an invalid transition identity.');
  }
  if (match[1] !== pending.pending_previous_hash || match[2] !== pending.pending_target_hash) {
    throw new Error('Pending event transition identity does not match its hashes.');
  }
}

function leadsNoteDatesEqual_(left, right) {
  try {
    return canonicalLeadsNoteTimestamp_(left, 'Activity Log created_at')
      === canonicalLeadsNoteTimestamp_(right, 'pending_created_at');
  } catch (err) {
    return false;
  }
}

function canonicalLeadsNoteTimestamp_(value, context) {
  if (typeof value !== 'string' || !LEADS_NOTE_TIMESTAMP_PATTERN.test(value)) {
    throw new Error((context || 'Timestamp') + ' must be a canonical UTC timestamp in YYYY-MM-DDTHH:mm:ss.sssZ format.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error((context || 'Timestamp') + ' is invalid or not canonical.');
  }
  return value;
}

function hasLeadsNotePendingState_(object) {
  return Boolean(object && LEADS_NOTE_SNAPSHOT_HEADERS.slice(6).some(function (field) {
    return object[field] !== '' && object[field] !== null && object[field] !== undefined;
  }));
}

function readLeadsNoteSnapshotRecord_(sheet, row, headerMap) {
  const values = sheet.getRange(row, 1, 1, Math.max(sheet.getLastColumn(), LEADS_NOTE_SNAPSHOT_HEADERS.length)).getValues()[0];
  const object = {};
  LEADS_NOTE_SNAPSHOT_HEADERS.forEach(function (header) { object[header] = values[headerMap[header] - 1]; });
  return { rowNumber: row, leadId: String(object.lead_id || '').trim(), object: object };
}

function writeLeadsNoteSnapshotFields_(sheet, row, headerMap, fields) {
  const width = Math.max(sheet.getLastColumn(), LEADS_NOTE_SNAPSHOT_HEADERS.length);
  const values = sheet.getRange(row, 1, 1, width).getValues()[0];
  Object.keys(fields).forEach(function (field) {
    if (headerMap[field]) values[headerMap[field] - 1] = fields[field];
  });
  sheet.getRange(row, 1, 1, width).setValues([values]);
}

function buildLeadsNoteSnapshotObject_(leadId, leadsRow, historyValue, lastActivityLogRow) {
  const value = String(historyValue || '').replace(/\r\n/g, '\n').trim();
  return {
    lead_id: String(leadId || '').trim(),
    leads_row: leadsRow || '',
    last_k_hash: hashLeadsNoteValue_(value),
    last_k_value: value,
    last_synced_at: new Date(),
    last_activity_log_row: lastActivityLogRow || '',
    pending_event_id: '', pending_lead_id: '', pending_previous_hash: '', pending_target_hash: '',
    pending_target_value: '', pending_action_type: '', pending_note: '', pending_created_by: '', pending_created_at: '', pending_state: '',
    pending_protocol_version: '',
  };
}

function buildLeadsNoteSnapshotRow_(leadId, leadsRow, historyValue, lastActivityLogRow) {
  const object = buildLeadsNoteSnapshotObject_(leadId, leadsRow, historyValue, lastActivityLogRow);
  return LEADS_NOTE_SNAPSHOT_HEADERS.map(function (header) { return object[header]; });
}

function ensureLeadsNoteSnapshotSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEADS_NOTE_SNAPSHOT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LEADS_NOTE_SNAPSHOT_SHEET_NAME);
  if (sheet.getMaxColumns() < LEADS_NOTE_SNAPSHOT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEADS_NOTE_SNAPSHOT_HEADERS.length - sheet.getMaxColumns());
  }
  const existing = sheet.getRange(HEADER_ROW, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length).getValues()[0];
  const needsHeaders = LEADS_NOTE_SNAPSHOT_HEADERS.some(function (header, index) {
    return normalizeHeaderName_(existing[index]) !== normalizeHeaderName_(header);
  });
  if (needsHeaders) sheet.getRange(HEADER_ROW, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length).setValues([LEADS_NOTE_SNAPSHOT_HEADERS]);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function clearLeadsNoteSnapshotData_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return;
  sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, Math.max(sheet.getLastColumn(), LEADS_NOTE_SNAPSHOT_HEADERS.length)).clearContent();
}

function withLeadsNoteSnapshotLock_(operationName, callback) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LEADS_NOTE_LOCK_TIMEOUT_MS);
  } catch (err) {
    throw new Error(operationName + ' could not acquire the script lock; no snapshot, state, or Activity Log writes were performed. Retry later.');
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function createLeadsNoteEventNonce_() {
  if (typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(new Date().getTime()) + '|' + Math.random(), Utilities.Charset.UTF_8);
  return bytes.map(function (byte) { const value = byte < 0 ? byte + 256 : byte; return ('0' + value.toString(16)).slice(-2); }).join('');
}

function toastLeadsNoteSyncResult_(result, title) {
  SpreadsheetApp.getActive().toast(
    'Rows ' + (result.startRow || '-') + '-' + (result.endRow || '-')
      + ' checked=' + result.checked
      + ' logged=' + result.logged
      + ' onboarded=' + (result.onboarded || 0)
      + ' skipped=' + result.skipped
      + ' next=' + result.nextCursor
      + (result.task_completed ? ' completed' : ' batch complete; continue later'),
    title || 'LEADS Note Sync',
    8
  );
}

function hashLeadsNoteValue_(value) {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized, Utilities.Charset.UTF_8);
  return bytes.map(function (byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}
