const LEADS_NOTE_SNAPSHOT_SHEET_NAME = 'LEADS_NOTE_SNAPSHOT';
const LEADS_NOTE_SNAPSHOT_CURSOR_KEY = 'LEADS_NOTE_SNAPSHOT_NEXT_ROW';
const LEADS_NOTE_SYNC_BATCH_SIZE = 100;
const LEADS_NOTE_SNAPSHOT_HEADERS = [
  'lead_id',
  'leads_row',
  'last_k_hash',
  'last_k_value',
  'last_synced_at',
  'last_activity_log_row',
];

function initializeLeadsNoteSnapshot() {
  const result = initializeLeadsNoteSnapshot_();
  SpreadsheetApp
    .getActive()
    .toast('Initialized LEADS note snapshot rows: ' + result.snapshot_rows, 'LEADS Note Snapshot', 6);
  return result;
}

function syncLeadsNoteHistoryToActivityLogNow() {
  const result = syncLeadsNoteHistoryToActivityLogBatch_(300);
  toastLeadsNoteSyncResult_(result, 'LEADS Note Sync');
  return result;
}

function syncLeadsNoteHistoryToActivityLogContinue() {
  const result = syncLeadsNoteHistoryToActivityLogBatch_(300);
  toastLeadsNoteSyncResult_(result, 'LEADS Note Sync Continue');
  return result;
}

function syncLeadsNoteHistoryToActivityLogScheduled() {
  return syncLeadsNoteHistoryToActivityLogBatch_(LEADS_NOTE_SYNC_BATCH_SIZE);
}

function installLeadsNoteSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncLeadsNoteHistoryToActivityLogScheduled') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp
    .newTrigger('syncLeadsNoteHistoryToActivityLogScheduled')
    .timeBased()
    .everyMinutes(10)
    .create();
}

function initializeLeadsNoteSnapshot_() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const snapshotSheet = ensureLeadsNoteSnapshotSheet_();
  const rows = buildLeadsNoteSnapshotRows_(leadsSheet);

  clearLeadsNoteSnapshotData_(snapshotSheet);
  if (rows.length) {
    snapshotSheet.getRange(DATA_START_ROW, 1, rows.length, LEADS_NOTE_SNAPSHOT_HEADERS.length).setValues(rows);
  }
  if (!snapshotSheet.isSheetHidden()) snapshotSheet.hideSheet();

  PropertiesService
    .getScriptProperties()
    .setProperty(LEADS_NOTE_SNAPSHOT_CURSOR_KEY, String(DATA_START_ROW));

  Logger.log('initializeLeadsNoteSnapshot snapshot_rows=' + rows.length);
  return {
    snapshot_rows: rows.length,
  };
}

function syncLeadsNoteHistoryToActivityLogBatch_(limit) {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const snapshotSheet = ensureLeadsNoteSnapshotSheet_();
  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) {
    return {
      batchSize: Math.max(1, Number(limit) || LEADS_NOTE_SYNC_BATCH_SIZE),
      startRow: '',
      endRow: '',
      nextCursor: DATA_START_ROW,
      lastRow: leadsSheet ? leadsSheet.getLastRow() : 0,
      checked: 0,
      logged: 0,
      skipped: 0,
      failed: 0,
      task_completed: true,
    };
  }

  const headerMap = getHeaderMap_(leadsSheet);
  const leadIdColumn = headerMap.lead_id;
  const historyColumn = headerMap.sales_note_history;
  if (!leadIdColumn || !historyColumn) {
    throw new Error('LEADS missing Lead ID or Sales Note History header.');
  }

  const batchSize = Math.max(1, Number(limit) || LEADS_NOTE_SYNC_BATCH_SIZE);
  const properties = PropertiesService.getScriptProperties();
  const lastRow = leadsSheet.getLastRow();
  const savedCursor = Number(properties.getProperty(LEADS_NOTE_SNAPSHOT_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + batchSize - 1, lastRow);
  const rowCount = endRow - startRow + 1;
  const leadIds = leadsSheet.getRange(startRow, leadIdColumn, rowCount, 1).getValues();
  const histories = leadsSheet.getRange(startRow, historyColumn, rowCount, 1).getValues();
  const snapshotByLeadId = getLeadsNoteSnapshotByLeadId_(snapshotSheet);
  const snapshotHeaderMap = getHeaderMap_(snapshotSheet);
  const snapshotRowsToAppend = [];
  let checked = 0;
  let logged = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < rowCount; index++) {
    const row = startRow + index;
    const leadId = String(leadIds[index][0] || '').trim();
    const historyValue = String(histories[index][0] || '').trim();
    if (!leadId) {
      skipped++;
      continue;
    }

    checked++;
    try {
      const currentHash = hashLeadsNoteValue_(historyValue);
      const snapshot = snapshotByLeadId[leadId];
      const previousHash = snapshot ? String(snapshot.object.last_k_hash || '') : '';
      if (snapshot && previousHash === currentHash) {
        skipped++;
        continue;
      }

      let activityRow = '';
      if (historyValue) {
        activityRow = appendObjectRow_('ACTIVITY_LOG', {
          activity_id: 'ACT-' + Date.now() + '-leads-note-sync-' + row,
          lead_id: leadId,
          sheet_name: 'LEADS',
          action_type: 'Sales Note History Updated',
          note: historyValue,
          created_by: typeof getSafeCrmUserEmail_ === 'function' ? getSafeCrmUserEmail_() : 'unknown',
          created_at: new Date(),
        });
        logged++;
      } else if (snapshot && previousHash) {
        activityRow = appendObjectRow_('ACTIVITY_LOG', {
          activity_id: 'ACT-' + Date.now() + '-leads-note-clear-' + row,
          lead_id: leadId,
          sheet_name: 'LEADS',
          action_type: 'Sales Note History Updated',
          note: 'Sales Note History cleared in LEADS.',
          created_by: typeof getSafeCrmUserEmail_ === 'function' ? getSafeCrmUserEmail_() : 'unknown',
          created_at: new Date(),
        });
        logged++;
      }

      if (snapshot) {
        writeLeadsNoteSnapshotRecord_(snapshotSheet, snapshot.rowNumber, snapshotHeaderMap, leadId, row, historyValue, activityRow);
      } else {
        snapshotRowsToAppend.push(buildLeadsNoteSnapshotRow_(leadId, row, historyValue, activityRow));
      }
    } catch (err) {
      failed++;
      Logger.log('syncLeadsNoteHistoryToActivityLog skipped LEADS row ' + row + ' lead_id=' + leadId + ': ' + err.message);
    }
  }

  if (snapshotRowsToAppend.length) {
    const startAppendRow = Math.max(snapshotSheet.getLastRow() + 1, DATA_START_ROW);
    snapshotSheet
      .getRange(startAppendRow, 1, snapshotRowsToAppend.length, LEADS_NOTE_SNAPSHOT_HEADERS.length)
      .setValues(snapshotRowsToAppend);
  }

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
    skipped: skipped,
    failed: failed,
    task_completed: nextCursor === DATA_START_ROW,
  };
  Logger.log('syncLeadsNoteHistoryToActivityLog batch_size=' + batchSize
    + ' startRow=' + startRow
    + ' endRow=' + endRow
    + ' lastRow=' + lastRow
    + ' checked=' + checked
    + ' logged=' + logged
    + ' skipped=' + skipped
    + ' failed=' + failed
    + ' nextCursor=' + nextCursor
    + ' task_completed=' + result.task_completed);
  return result;
}

function toastLeadsNoteSyncResult_(result, title) {
  const status = result.task_completed ? 'completed' : 'batch complete; continue later';
  SpreadsheetApp
    .getActive()
    .toast(
      'Rows ' + (result.startRow || '-') + '-' + (result.endRow || '-')
      + ' checked=' + result.checked
      + ' logged=' + result.logged
      + ' skipped=' + result.skipped
      + ' failed=' + result.failed
      + ' next=' + result.nextCursor
      + ' ' + status,
      title || 'LEADS Note Sync',
      8
    );
}

function updateLeadsNoteSnapshotForLead_(leadId, leadsRow, historyValue, lastActivityLogRow) {
  const targetLeadId = String(leadId || '').trim();
  if (!targetLeadId) return false;

  const sheet = ensureLeadsNoteSnapshotSheet_();
  const snapshotByLeadId = getLeadsNoteSnapshotByLeadId_(sheet);
  const headerMap = getHeaderMap_(sheet);
  const snapshot = snapshotByLeadId[targetLeadId];
  if (snapshot) {
    writeLeadsNoteSnapshotRecord_(sheet, snapshot.rowNumber, headerMap, targetLeadId, leadsRow, historyValue, lastActivityLogRow);
    return true;
  }

  const row = Math.max(sheet.getLastRow() + 1, DATA_START_ROW);
  sheet
    .getRange(row, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length)
    .setValues([buildLeadsNoteSnapshotRow_(targetLeadId, leadsRow, historyValue, lastActivityLogRow)]);
  return true;
}

function ensureLeadsNoteSnapshotSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEADS_NOTE_SNAPSHOT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LEADS_NOTE_SNAPSHOT_SHEET_NAME);
  }

  if (sheet.getMaxColumns() < LEADS_NOTE_SNAPSHOT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEADS_NOTE_SNAPSHOT_HEADERS.length - sheet.getMaxColumns());
  }

  const existingHeaders = sheet.getRange(HEADER_ROW, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length).getValues()[0];
  const needsHeaders = LEADS_NOTE_SNAPSHOT_HEADERS.some(function (header, index) {
    return normalizeHeaderName_(existingHeaders[index]) !== normalizeHeaderName_(header);
  });
  if (needsHeaders) {
    sheet.getRange(HEADER_ROW, 1, 1, LEADS_NOTE_SNAPSHOT_HEADERS.length).setValues([LEADS_NOTE_SNAPSHOT_HEADERS]);
  }
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function buildLeadsNoteSnapshotRows_(leadsSheet) {
  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) return [];

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id || !headerMap.sales_note_history) return [];

  const rowCount = leadsSheet.getLastRow() - DATA_START_ROW + 1;
  const leadIds = leadsSheet.getRange(DATA_START_ROW, headerMap.lead_id, rowCount, 1).getValues();
  const histories = leadsSheet.getRange(DATA_START_ROW, headerMap.sales_note_history, rowCount, 1).getValues();
  const rows = [];

  for (let index = 0; index < rowCount; index++) {
    const leadId = String(leadIds[index][0] || '').trim();
    if (!leadId) continue;
    rows.push(buildLeadsNoteSnapshotRow_(leadId, DATA_START_ROW + index, histories[index][0], ''));
  }

  return rows;
}

function buildLeadsNoteSnapshotRow_(leadId, leadsRow, historyValue, lastActivityLogRow) {
  const value = String(historyValue || '').trim();
  return [
    String(leadId || '').trim(),
    leadsRow || '',
    hashLeadsNoteValue_(value),
    value,
    new Date(),
    lastActivityLogRow || '',
  ];
}

function writeLeadsNoteSnapshotRecord_(sheet, row, headerMap, leadId, leadsRow, historyValue, lastActivityLogRow) {
  const value = String(historyValue || '').trim();
  const object = {
    lead_id: String(leadId || '').trim(),
    leads_row: leadsRow || '',
    last_k_hash: hashLeadsNoteValue_(value),
    last_k_value: value,
    last_synced_at: new Date(),
    last_activity_log_row: lastActivityLogRow || '',
  };

  Object.keys(object).forEach(function (field) {
    if (headerMap[field]) sheet.getRange(row, headerMap[field]).setValue(object[field]);
  });
}

function getLeadsNoteSnapshotByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach(function (row, index) {
    const object = {};
    Object.keys(headerMap).forEach(function (header) {
      object[header] = row[headerMap[header] - 1];
    });
    const leadId = String(object.lead_id || '').trim();
    if (leadId && !data[leadId]) {
      data[leadId] = {
        rowNumber: DATA_START_ROW + index,
        object: object,
      };
    }
  });

  return data;
}

function clearLeadsNoteSnapshotData_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return;
  sheet
    .getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, Math.max(sheet.getLastColumn(), LEADS_NOTE_SNAPSHOT_HEADERS.length))
    .clearContent();
}

function hashLeadsNoteValue_(value) {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized, Utilities.Charset.UTF_8);
  return bytes.map(function (byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}
