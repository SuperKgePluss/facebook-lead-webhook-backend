// Sales-facing LEADS tab. LEADS_MAIN remains the backend/master sheet.
const LEADS_VIEW_REFRESH_CURSOR_KEY = 'LEADS_VIEW_REFRESH_NEXT_ROW';
const LEADS_VIEW_REFRESH_BATCH_SIZE = 70;
const LEADS_VIEW_SCHEDULED_CURSOR_KEY = 'LEADS_VIEW_SCHEDULED_NEXT_ROW';
const LEADS_VIEW_SCHEDULED_BATCH_SIZE = 20;
const LEADS_VIEW_MEMO_START_COLUMN = 16;
const LEADS_DATE_AUDIT_SHEET_NAME = 'LEADS_DATE_AUDIT';
const LEADS_DATE_APPLY_LOG_SHEET_NAME = 'LEADS_DATE_APPLY_LOG';
const LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT = 'dd/MM/yyyy HH:mm';
const LEADS_DATE_AUDIT_TARGET_DATE_FORMAT = 'dd/MM/yyyy';
const LEADS_VIEW_HEADERS = [
  'Lead ID',
  'Facebook Created Time',
  'Customer Name',
  'Phone',
  'Additional Phone',
  'Lead Status',
  'Preferred Call Day',
  'Preferred Call Time',
  'Sales Owner',
  'Sales Note Input',
  'Sales Note History',
  'Follow-up Count',
  'Latest Audio Link',
  'Facebook Search Name',
  'Open Detail',
];
const LEADS_VIEW_THAI_LABELS = [
  'รหัสลูกค้า',
  'เวลาสร้างลีดจาก Facebook',
  'ชื่อลูกค้า',
  'เบอร์โทร',
  'เบอร์โทรเพิ่มเติม',
  'สถานะลูกค้า',
  'วันที่สะดวกให้โทร',
  'เวลาที่สะดวกให้โทร',
  'ผู้รับผิดชอบ',
  'ใส่โน้ตฝ่ายขาย',
  'ประวัติโน้ตฝ่ายขาย',
  'จำนวนติดตาม',
  'ลิงก์ไฟล์เสียงล่าสุด',
  'ชื่อไว้ค้นหา Facebook',
  'เปิดรายละเอียด',
];
const LEADS_VIEW_MANUAL_FIELDS = {
  additional_phone: true,
  sales_note_input: true,
  sales_note_history: true,
  follow_up_count: true,
  open_detail: true,
};

function setupLeadsViewUi() {
  const sheet = getOrCreateLeadsViewSheet_();
  const schema = validateLeadsViewSchemaForNormalSync_(sheet);
  if (!schema.valid) {
    stopLeadsViewSyncForInvalidSchema_('setupLeadsViewUi', schema);
    return;
  }
  setupLeadsViewExistingRowsUi_(sheet);
  setupLeadsViewStatusConditionalFormatting_(sheet);
  hideDeprecatedLeadsSalesNoteInputColumn_(sheet);
  resetLeadsViewRefreshCursor();
  Logger.log('setupLeadsViewUi completed lightweight setup. Run setupCrmUiBatch repeatedly to sync LEADS rows.');
}

function refreshLeadsViewLight() {
  return withLeadsViewScriptLock_('refreshLeadsViewLight', 1000, () => refreshLeadsViewLightUnlocked_());
}

function refreshLeadsViewLightUnlocked_() {
  const properties = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) return { task_completed: true };

  const schema = validateLeadsViewSchemaForNormalSync_(leadsSheet);
  if (!schema.valid) {
    return stopLeadsViewSyncForInvalidSchema_('refreshLeadsViewLight', schema, {
      task_completed: false,
    });
  }

  const leadMainLastRow = leadMainSheet.getLastRow();
  const savedCursor = Number(properties.getProperty(LEADS_VIEW_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= leadMainLastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + LEADS_VIEW_REFRESH_BATCH_SIZE - 1, leadMainLastRow);
  const manualByLeadId = getLeadsViewManualDataByLeadId_(leadsSheet);
  const rowByLeadId = getLeadsViewRowMapByLeadId_(leadsSheet);
  let checked = 0;
  let fixed = 0;
  let failed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    try {
      if (syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, rowByLeadId)) {
        fixed++;
      }
    } catch (err) {
      failed++;
      Logger.log('refreshLeadsViewLight skipped LEADS_MAIN row ' + row + ': ' + err.message);
    }
  }

  const nextCursor = endRow + 1 > leadMainLastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEADS_VIEW_REFRESH_CURSOR_KEY, String(nextCursor));

  Logger.log('refreshLeadsViewLight batch_size=' + LEADS_VIEW_REFRESH_BATCH_SIZE + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + leadMainLastRow + ' checked=' + checked + ' fixed=' + fixed + ' failed=' + failed + ' nextCursor=' + nextCursor);
  return {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    fixed: fixed,
    failed: failed,
    task_completed: nextCursor === DATA_START_ROW,
  };
}

function resetLeadsViewRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(LEADS_VIEW_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('LEADS view refresh cursor reset to ' + DATA_START_ROW);
}

function withLeadsViewScriptLock_(source, waitMs, callback) {
  const lock = LockService.getScriptLock();
  const operation = source || 'LEADS operation';
  const timeoutMs = Math.max(1, Number(waitMs) || 5000);
  if (!lock.tryLock(timeoutMs)) {
    const result = {
      lock_acquired: false,
      stopped: true,
      reason: 'lock_timeout',
      source: operation,
      checked: 0,
      synced: 0,
      failed: 0,
    };
    Logger.log(operation + ' stopped because another LEADS sync/repair operation is running.');
    return result;
  }

  try {
    return callback();
  } catch (err) {
    Logger.log(operation + ' failed: ' + err.message);
    throw err;
  } finally {
    try {
      SpreadsheetApp.flush();
    } catch (err) {
      Logger.log(operation + ' flush before lock release failed: ' + (err && err.message ? err.message : err));
    }
    lock.releaseLock();
  }
}

function validateLeadsViewSchemaForNormalSync_(sheet) {
  if (!sheet) {
    return {
      valid: false,
      reason: 'missing_leads_sheet',
    };
  }
  if (sheet.getName() !== 'LEADS') {
    return {
      valid: false,
      reason: 'wrong_sheet',
      sheetName: sheet.getName(),
    };
  }
  if (sheet.getLastColumn() < LEADS_VIEW_HEADERS.length) {
    return {
      valid: false,
      reason: 'missing_required_columns',
      lastColumn: sheet.getLastColumn(),
      requiredColumnCount: LEADS_VIEW_HEADERS.length,
    };
  }

  const headers = sheet.getRange(HEADER_ROW, 1, 1, LEADS_VIEW_HEADERS.length).getValues()[0];
  const mismatches = [];
  LEADS_VIEW_HEADERS.forEach((header, index) => {
    const actual = normalizeHeaderName_(headers[index]);
    const expected = normalizeHeaderName_(header);
    if (actual !== expected) {
      mismatches.push({
        column: index + 1,
        expected: header,
        actual: headers[index] || '',
      });
    }
  });

  if (mismatches.length) {
    return {
      valid: false,
      reason: 'header_order_mismatch',
      mismatches: mismatches.slice(0, 10),
    };
  }

  return {
    valid: true,
  };
}

function stopLeadsViewSyncForInvalidSchema_(source, schema, extra) {
  const result = Object.assign({
    schema_valid: false,
    stopped: true,
    source: source || '',
    reason: schema && schema.reason ? schema.reason : 'invalid_schema',
    checked: 0,
    synced: 0,
    failed: 0,
  }, extra || {});
  Logger.log((source || 'LEADS sync') + ' stopped because LEADS schema is invalid: ' + JSON.stringify(schema));
  try {
    SpreadsheetApp
      .getActive()
      .toast('LEADS schema is invalid. Run Admin Repair LEADS View before syncing.', source || 'LEADS sync', 8);
  } catch (err) {
    Logger.log('Unable to show LEADS schema warning toast: ' + err.message);
  }
  return result;
}

function confirmLeadsViewAdminRepair_() {
  try {
    const ui = SpreadsheetApp.getUi();
    const response = ui.alert(
      'Admin Repair LEADS View',
      'This administrator repair can rebuild LEADS rows and shift/repair LEADS columns. It preserves known manual fields, Sales Note History, Latest Audio Link, and audio memo data, but should not be run during active sales editing. Continue?',
      ui.ButtonSet.OK_CANCEL
    );
    return response === ui.Button.OK;
  } catch (err) {
    Logger.log('Admin Repair LEADS View confirmation failed: ' + err.message);
    throw new Error('Admin Repair LEADS View requires interactive confirmation.');
  }
}

function getLeadsViewSchemaSnapshot_(sheet) {
  if (!sheet) {
    return {
      exists: false,
    };
  }
  const lastColumn = sheet.getLastColumn();
  const headerCount = Math.min(Math.max(lastColumn, 0), Math.max(LEADS_VIEW_HEADERS.length, 1));
  const headers = headerCount
    ? sheet.getRange(HEADER_ROW, 1, 1, headerCount).getValues()[0].map(value => String(value || ''))
    : [];
  return {
    exists: true,
    lastRow: sheet.getLastRow(),
    lastColumn: lastColumn,
    headers: headers,
  };
}

function getLeadsViewSafeUserSummary_() {
  const active = typeof getSafeSessionEmail_ === 'function' ? getSafeSessionEmail_(true) : '';
  const effective = typeof getSafeSessionEmail_ === 'function' ? getSafeSessionEmail_(false) : '';
  return 'active=' + (active || '') + ' effective=' + (effective || '');
}

function syncLeadsViewNow() {
  const result = syncRecentLeadsViewRows_(200);
  SpreadsheetApp.getActive().toast(result.schema_valid === false
    ? 'LEADS schema is invalid. Run Admin Repair LEADS View.'
    : result.stopped
      ? 'LEADS sync stopped: ' + (result.reason || 'unknown')
      : 'Synced recent LEADS rows: ' + result.synced, 'Sync LEADS View', 5);
  return result;
}

function syncLeadsViewScheduled() {
  return syncLeadsViewCursorBatch_(LEADS_VIEW_SCHEDULED_BATCH_SIZE);
}

function adminRepairLeadsViewFromLeadMain() {
  return repairLeadsViewFromLeadMain();
}

function repairLeadsViewFromLeadMain() {
  if (!confirmLeadsViewAdminRepair_()) {
    Logger.log('repairLeadsViewFromLeadMain cancelled by user.');
    return {
      cancelled: true,
    };
  }

  return withLeadsViewScriptLock_('repairLeadsViewFromLeadMain', 15000, () => repairLeadsViewFromLeadMainAdmin_());
}

function repairLeadsViewFromLeadMainAdmin_() {
  Logger.log('repairLeadsViewFromLeadMain LEADS_VIEW_HEADERS=' + JSON.stringify(LEADS_VIEW_HEADERS));
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = getOrCreateLeadsViewSheet_();
  const schemaBefore = getLeadsViewSchemaSnapshot_(leadsSheet);
  Logger.log('repairLeadsViewFromLeadMain start user=' + getLeadsViewSafeUserSummary_() + ' schema_before=' + JSON.stringify(schemaBefore));
  logCrmScriptFormatAudit_('REPAIR_START', leadsSheet, 'A:O', 'Admin Repair LEADS View started. schema_before=' + JSON.stringify(schemaBefore));

  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) {
    writeLeadsViewHeadersOnly_(leadsSheet, {
      allowStructureChange: true,
      source: 'repairLeadsViewFromLeadMain',
    });
    setupLeadsViewExistingRowsUi_(leadsSheet);
    const schemaAfterEmpty = getLeadsViewSchemaSnapshot_(leadsSheet);
    Logger.log('repairLeadsViewFromLeadMain completed empty source schema_after=' + JSON.stringify(schemaAfterEmpty));
    logCrmScriptFormatAudit_('REPAIR_COMPLETE', leadsSheet, 'A:O', 'Admin Repair LEADS View completed with no LEADS_MAIN data. schema_after=' + JSON.stringify(schemaAfterEmpty));
    return {
      rebuilt: 0,
    };
  }

  setLeadsViewHeaders_(leadsSheet, {
    allowSchemaMigration: true,
    source: 'repairLeadsViewFromLeadMain',
  });
  const historyByLeadId = getLeadsViewHistoryDataByLeadId_(leadsSheet);
  const safeManualByLeadId = getSafeLeadsViewManualDataByLeadId_(leadsSheet);
  const detailFacebookTimeByLeadId = getLeadDetailsFacebookCreatedTimeByLeadId_();
  const latestAudioUrlByLeadId = getLatestActivityAudioUrlByLeadId_();
  const leadRows = leadMainSheet
    .getRange(DATA_START_ROW, 1, leadMainSheet.getLastRow() - DATA_START_ROW + 1, leadMainSheet.getLastColumn())
    .getValues();
  const leadHeaders = leadMainSheet.getRange(HEADER_ROW, 1, 1, leadMainSheet.getLastColumn()).getValues()[0];
  const rebuiltRows = [];

  leadRows.forEach(row => {
    const lead = leadHeaders.reduce((object, header, index) => {
      const name = normalizeHeaderName_(header);
      if (name) object[name] = row[index];
      return object;
    }, {});
    const leadId = String(lead.lead_id || '').trim();
    if (!leadId) return;

    const manual = safeManualByLeadId[leadId] || {};
    if (historyByLeadId[leadId]) {
      manual.sales_note_history = mergeSalesNoteHistoryText_(manual.sales_note_history, historyByLeadId[leadId].noteHistory);
    }
    const facebookCreatedTime = resolveLeadsViewFacebookCreatedTime_(lead, detailFacebookTimeByLeadId[leadId]);
    const object = sanitizeLeadsViewSyncObject_(buildLeadsViewObject_(Object.assign({}, lead, {
      facebook_created_time: facebookCreatedTime,
    }), manual));
    object.latest_audio_link = latestAudioUrlByLeadId[leadId] || manual.latest_audio_link || '';
    rebuiltRows.push(buildLeadsViewRowValues_(object));
  });

  logCrmScriptFormatAudit_('REPAIR_BROAD_WRITE', leadsSheet, 'A:O', 'Admin Repair LEADS View clearing/rebuilding data rows=' + rebuiltRows.length);
  clearLeadsViewData_(leadsSheet);
  clearLeadsViewAudioMemoArea_(leadsSheet);
  writeLeadsViewHeadersOnly_(leadsSheet, {
    allowStructureChange: true,
    source: 'repairLeadsViewFromLeadMain',
  });
  if (rebuiltRows.length) {
    logCrmScriptFormatAudit_('REPAIR_BROAD_WRITE', leadsSheet, 'A' + DATA_START_ROW + ':O' + (DATA_START_ROW + rebuiltRows.length - 1), 'Admin Repair LEADS View writing rebuilt A:O rows=' + rebuiltRows.length);
    leadsSheet.getRange(DATA_START_ROW, 1, rebuiltRows.length, LEADS_VIEW_HEADERS.length).setValues(rebuiltRows);
    setupLeadsViewDataRangeUi_(leadsSheet, DATA_START_ROW, rebuiltRows.length);
    restoreLeadsViewMemoData_(leadsSheet, getAudioMemoDataFromHistory_(historyByLeadId));
  }
  setupLeadsViewStatusConditionalFormatting_(leadsSheet);
  hideDeprecatedLeadsSalesNoteInputColumn_(leadsSheet);
  resetLeadsViewRefreshCursor();
  PropertiesService
    .getScriptProperties()
    .setProperty(LEADS_VIEW_SCHEDULED_CURSOR_KEY, String(DATA_START_ROW));

  const result = {
    rebuilt: rebuiltRows.length,
  };
  const schemaAfter = getLeadsViewSchemaSnapshot_(leadsSheet);
  Logger.log('repairLeadsViewFromLeadMain rebuilt=' + rebuiltRows.length + ' schema_after=' + JSON.stringify(schemaAfter));
  logCrmScriptFormatAudit_('REPAIR_COMPLETE', leadsSheet, 'A:O', 'Admin Repair LEADS View completed. rebuilt=' + rebuiltRows.length + ' schema_after=' + JSON.stringify(schemaAfter));
  SpreadsheetApp.getActive().toast('Rebuilt LEADS rows: ' + rebuiltRows.length, 'Repair LEADS View', 5);
  return result;
}

function clearLeadsViewAudioMemoArea_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW || sheet.getLastColumn() < LEADS_VIEW_MEMO_START_COLUMN) return;

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const columnCount = sheet.getLastColumn() - LEADS_VIEW_MEMO_START_COLUMN + 1;
  sheet.getRange(DATA_START_ROW, LEADS_VIEW_MEMO_START_COLUMN, rowCount, columnCount).clearContent();
}

function installLeadsViewSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'syncLeadsViewScheduled') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp
    .newTrigger('syncLeadsViewScheduled')
    .timeBased()
    .everyMinutes(10)
    .create();
}

function syncRecentLeadsViewRows_(limit) {
  return withLeadsViewScriptLock_('syncRecentLeadsViewRows_', 1000, () => syncRecentLeadsViewRowsUnlocked_(limit));
}

function syncRecentLeadsViewRowsUnlocked_(limit) {
  const rowLimit = Math.max(1, Number(limit) || 200);
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) {
    return {
      checked: 0,
      synced: 0,
    };
  }

  const schema = validateLeadsViewSchemaForNormalSync_(leadsSheet);
  if (!schema.valid) {
    return stopLeadsViewSyncForInvalidSchema_('syncRecentLeadsViewRows_', schema);
  }

  const lastRow = leadMainSheet.getLastRow();
  const startRow = Math.max(DATA_START_ROW, lastRow - rowLimit + 1);
  const manualByLeadId = getLeadsViewManualDataByLeadId_(leadsSheet);
  const rowByLeadId = getLeadsViewRowMapByLeadId_(leadsSheet);
  let checked = 0;
  let synced = 0;
  let failed = 0;

  for (let row = startRow; row <= lastRow; row++) {
    checked++;
    try {
      if (syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, rowByLeadId)) {
        synced++;
      }
    } catch (err) {
      failed++;
      Logger.log('syncRecentLeadsViewRows skipped LEADS_MAIN row ' + row + ': ' + err.message);
    }
  }

  const result = {
    startRow: startRow,
    endRow: lastRow,
    checked: checked,
    synced: synced,
    failed: failed,
  };
  Logger.log('syncRecentLeadsViewRows limit=' + rowLimit + ' startRow=' + startRow + ' endRow=' + lastRow + ' checked=' + checked + ' synced=' + synced + ' failed=' + failed);
  return result;
}

function syncLeadsViewCursorBatch_(limit) {
  return withLeadsViewScriptLock_('syncLeadsViewCursorBatch_', 1000, () => syncLeadsViewCursorBatchUnlocked_(limit));
}

function syncLeadsViewCursorBatchUnlocked_(limit) {
  const batchSize = Math.max(1, Number(limit) || LEADS_VIEW_SCHEDULED_BATCH_SIZE);
  const properties = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) {
    return {
      checked: 0,
      synced: 0,
      failed: 0,
      task_completed: true,
    };
  }

  const schema = validateLeadsViewSchemaForNormalSync_(leadsSheet);
  if (!schema.valid) {
    return stopLeadsViewSyncForInvalidSchema_('syncLeadsViewCursorBatch_', schema, {
      task_completed: false,
    });
  }

  const lastRow = leadMainSheet.getLastRow();
  const savedCursor = Number(properties.getProperty(LEADS_VIEW_SCHEDULED_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : Math.max(DATA_START_ROW, lastRow - batchSize + 1);
  const endRow = Math.min(startRow + batchSize - 1, lastRow);
  const manualByLeadId = getLeadsViewManualDataByLeadId_(leadsSheet);
  const rowByLeadId = getLeadsViewRowMapByLeadId_(leadsSheet);
  let checked = 0;
  let synced = 0;
  let failed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    try {
      if (syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, rowByLeadId)) {
        synced++;
      }
    } catch (err) {
      failed++;
      Logger.log('syncLeadsViewCursorBatch skipped LEADS_MAIN row ' + row + ': ' + err.message);
    }
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEADS_VIEW_SCHEDULED_CURSOR_KEY, String(nextCursor));

  const result = {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    synced: synced,
    failed: failed,
    task_completed: nextCursor === DATA_START_ROW,
  };
  Logger.log('syncLeadsViewCursorBatch batch_size=' + batchSize + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' synced=' + synced + ' failed=' + failed + ' nextCursor=' + nextCursor);
  return result;
}

function syncLeadsViewForLeadMainRow_(row) {
  return withLeadsViewScriptLock_('syncLeadsViewForLeadMainRow_', 1000, () => syncLeadsViewForLeadMainRowUnlocked_(row));
}

function syncLeadsViewForLeadMainRowUnlocked_(row) {
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadMainSheet || row < DATA_START_ROW || row > leadMainSheet.getLastRow()) return false;

  const schema = validateLeadsViewSchemaForNormalSync_(leadsSheet);
  if (!schema.valid) {
    stopLeadsViewSyncForInvalidSchema_('syncLeadsViewForLeadMainRow_', schema);
    return false;
  }
  const manualByLeadId = getLeadsViewManualDataByLeadId_(leadsSheet);
  const rowByLeadId = getLeadsViewRowMapByLeadId_(leadsSheet);
  return syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, rowByLeadId);
}

function syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, optionalRowByLeadId) {
  const lead = getRowObject_(leadMainSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return false;

  const rowByLeadId = optionalRowByLeadId || getLeadsViewRowMapByLeadId_(leadsSheet);
  const isExistingLeadsRow = !!rowByLeadId[leadId];
  const targetRow = getOrCreateLeadsViewRowByLeadId_(leadsSheet, leadId, rowByLeadId);
  const manual = manualByLeadId[leadId] || {};
  const object = sanitizeLeadsViewSyncObject_(buildLeadsViewObject_(lead, manual));
  prepareLeadsViewRowForSync_(leadsSheet, targetRow);
  setLeadsViewSyncObjectValues_(leadsSheet, targetRow, object, {
    skipSalesNoteHistory: isExistingLeadsRow,
  });
  setupLeadsViewRowUi(targetRow, leadsSheet);
  return true;
}

function setLeadsViewSyncObjectValues_(sheet, row, object, options) {
  const headerMap = getHeaderMap_(sheet);
  const skipSalesNoteHistory = options && options.skipSalesNoteHistory;
  Object.keys(object).forEach(header => {
    const normalizedHeader = normalizeHeaderName_(header);
    if (skipSalesNoteHistory && normalizedHeader === 'sales_note_history') return;
    if (headerMap[normalizedHeader]) {
      sheet.getRange(row, headerMap[normalizedHeader]).setValue(object[header]);
    }
  });
}

function setupLeadsViewRowUi(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet || sheet.getName() !== 'LEADS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const leadId = leadIdColumn ? String(sheet.getRange(row, leadIdColumn).getValue() || '').trim() : '';
  let changed = false;

  if (ensureLeadsViewStatusDropdownForRow(row, sheet)) changed = true;
  if (ensureLeadsViewCheckboxesForRow(row, sheet)) changed = true;

  if (leadId) {
    const dateColumn = headerMap.facebook_created_time;
    if (dateColumn) sheet.getRange(row, dateColumn).setNumberFormat(LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT);
    [headerMap.phone, headerMap.additional_phone].filter(Boolean).forEach(column => {
      sheet.getRange(row, column).setNumberFormat('@');
    });
  }

  return changed;
}

function handleLeadsViewEdit_(e, sheet, row) {
  if (!e || !e.range || !sheet || sheet.getName() !== 'LEADS' || row < DATA_START_ROW) return;

  const isSingleCellEdit = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
  const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
  setupLeadsViewRowUi(row, sheet);

  if (editedHeader === 'open_detail') {
    handleLeadsViewOpenDetailEdit_(e, sheet, row);
    return;
  }

  if (editedHeader === 'lead_status') {
    handleLeadsViewLeadStatusEdit_(e, sheet, row);
    return;
  }

  if (editedHeader === 'sales_note_input') {
    handleLeadsViewSalesNoteEdit_(e, sheet, row);
    return;
  }

  if (
    editedHeader === 'customer_name'
    || editedHeader === 'phone'
    || editedHeader === 'additional_phone'
    || editedHeader === 'preferred_call_day'
    || editedHeader === 'preferred_call_time'
    || editedHeader === 'sales_owner'
  ) {
    recordLeadsViewManualEditUndoIfSupported_(e, sheet, row, editedHeader, isSingleCellEdit);
    syncLeadsViewEditableFieldToLeadMain_(sheet, row, editedHeader);
    return;
  }

  if (
    editedHeader === 'sales_note_history'
    || editedHeader === 'follow_up_count'
  ) {
    recordLeadsViewManualEditUndoIfSupported_(e, sheet, row, editedHeader, isSingleCellEdit);
  }
}

function handleLeadsViewSalesNoteEdit_(e, sheet, row) {
  let note = '';
  let leadId = '';
  let inputColumn = 0;
  let headerMap = {};
  try {
    note = String(e.value || '').trim();
    if (!note) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'blank_note', '', '', 'No note text in edit event.');
      return;
    }

    const lead = getRowObject_(sheet, row);
    leadId = String(lead.lead_id || '').trim();
    headerMap = getHeaderMap_(sheet);
    inputColumn = headerMap.sales_note_input || headerMap.sales_note;
    if (!inputColumn) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'wrong_header_or_column', leadId, note, 'Sales Note Input header not found.');
      return;
    }
    if (!leadId) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'missing_lead_id', '', note, 'No Lead ID on edited LEADS row.');
      return;
    }

    const dedupe = claimLeadsViewSalesNoteEdit_(leadId, note);
    if (!dedupe.claimed) {
      sheet.getRange(row, inputColumn).clearContent();
      const reason = dedupe.reason === 'cache_duplicate'
        ? 'duplicate_guard_cache'
        : dedupe.reason === 'property_duplicate'
          ? 'duplicate_guard_property'
          : dedupe.reason === 'lock_timeout'
            ? 'lock_timeout'
            : dedupe.reason || 'duplicate_guard';
      logLeadsSalesNoteDiagnostic_(e, sheet, row, reason, leadId, note, 'Duplicate guard skipped Sales Note save.');
      Logger.log('LEADS Sales Note skipped duplicate lead_id=' + leadId + ' reason=' + dedupe.reason);
      return;
    }

    const savedAt = new Date();
    const activityId = 'ACT-' + Date.now();
    let activityRow = '';
    try {
      activityRow = appendObjectRow_('ACTIVITY_LOG', {
        activity_id: activityId,
        lead_id: leadId,
        sheet_name: 'LEADS',
        action_type: 'Sales Note',
        note: note,
        created_by: typeof getSafeCrmUserEmail_ === 'function' ? getSafeCrmUserEmail_() : 'unknown',
        created_at: savedAt,
      });
    } catch (err) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'append_activity_failed', leadId, note, err.message);
      err.crmDiagnosticLogged = true;
      throw err;
    }

    const appendedHistoryText = formatSalesNoteHistoryValue_(note, savedAt);
    try {
      appendSalesNoteHistoryToLeadsView_(sheet, row, appendedHistoryText, savedAt);
      if (typeof updateLeadsNoteSnapshotForLead_ === 'function') {
        try {
          const historyColumn = headerMap.sales_note_history;
          const historyValue = historyColumn ? sheet.getRange(row, historyColumn).getValue() : '';
          updateLeadsNoteSnapshotForLead_(leadId, row, historyValue, activityRow);
        } catch (snapshotErr) {
          Logger.log('LEADS Sales Note snapshot update skipped lead_id=' + leadId + ': ' + snapshotErr.message);
        }
      }
    } catch (err) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'append_history_failed', leadId, note, err.message);
      err.crmDiagnosticLogged = true;
      throw err;
    }

    if (typeof recordCrmUndoSalesNoteSave_ === 'function') {
      try {
        recordCrmUndoSalesNoteSave_({
          leadId: leadId,
          inputRangeA1: sheet.getRange(row, inputColumn).getA1Notation(),
          historyRangeA1: headerMap.sales_note_history ? sheet.getRange(row, headerMap.sales_note_history).getA1Notation() : '',
          oldInputValue: e.oldValue || '',
          newInputValue: note,
          appendedHistoryText: appendedHistoryText,
          relatedActivityLogRow: activityRow,
          relatedActivityId: activityId,
          userEmail: typeof getSafeCrmUserEmail_ === 'function' ? getSafeCrmUserEmail_() : 'unknown',
        });
      } catch (err) {
        logLeadsSalesNoteDiagnostic_(e, sheet, row, 'undo_log_failed', leadId, note, err.message);
        err.crmDiagnosticLogged = true;
        throw err;
      }
    }

    try {
      sheet.getRange(row, inputColumn).clearContent();
    } catch (err) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'clear_input_failed', leadId, note, err.message);
      err.crmDiagnosticLogged = true;
      throw err;
    }
  } catch (err) {
    if (!err.crmDiagnosticLogged) {
      logLeadsSalesNoteDiagnostic_(e, sheet, row, 'unexpected_error', leadId, note, err.message);
    }
    throw err;
  }
}

function logLeadsSalesNoteDiagnostic_(e, sheet, row, reason, leadId, note, details) {
  if (typeof logSalesNoteDiagnostic_ !== 'function') return;
  logSalesNoteDiagnostic_({
    sheetName: sheet ? sheet.getName() : '',
    row: row,
    column: e && e.range ? e.range.getColumn() : '',
    rangeA1: e && e.range ? e.range.getA1Notation() : '',
    editedHeader: e && e.range && sheet ? getEditedHeader_(sheet, e.range.getColumn()) : '',
    leadId: leadId || '',
    reason: reason,
    eValuePresent: Boolean(e && Object.prototype.hasOwnProperty.call(e, 'value') && String(e.value || '').trim()),
    notePreview: note || '',
    details: details || '',
  });
}

function recordLeadsViewManualEditUndoIfSupported_(e, sheet, row, editedHeader, isSingleCellEdit) {
  if (!isSingleCellEdit || typeof recordCrmUndoManualLeadsEdit_ !== 'function') return;
  if (!Object.prototype.hasOwnProperty.call(e, 'oldValue')) return;

  const supported = {
    preferred_call_day: true,
    preferred_call_time: true,
    sales_owner: true,
    sales_note_history: true,
    follow_up_count: true,
  };
  if (!supported[editedHeader]) return;

  const leadId = String(getRowObject_(sheet, row).lead_id || '').trim();
  if (!leadId) return;

  recordCrmUndoManualLeadsEdit_({
    fieldName: editedHeader,
    leadId: leadId,
    rangeA1: e.range.getA1Notation(),
    oldValue: e.oldValue,
    newValue: Object.prototype.hasOwnProperty.call(e, 'value') ? e.value : '',
    isMultiCell: false,
    hasOldValue: true,
  });
}

function claimLeadsViewSalesNoteEdit_(leadId, note) {
  const normalizedLeadId = String(leadId || '').trim();
  const normalizedNote = String(note || '').trim().replace(/\s+/g, ' ');
  const hash = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalizedLeadId + '|' + normalizedNote)
  ).slice(0, 40);
  const cacheKey = 'sales_note_' + hash;
  const propertyKey = 'LEADS_SALES_NOTE_LAST_' + normalizedLeadId;
  const now = Date.now();
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(5000);
  } catch (err) {
    return {
      claimed: false,
      reason: 'lock_timeout',
    };
  }

  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(cacheKey)) {
      return {
        claimed: false,
        reason: 'cache_duplicate',
      };
    }

    const properties = PropertiesService.getScriptProperties();
    const previous = String(properties.getProperty(propertyKey) || '').split('|');
    const previousHash = previous[0] || '';
    const previousTimestamp = Number(previous[1] || 0);
    if (previousHash === hash && now - previousTimestamp < 60000) {
      cache.put(cacheKey, '1', 60);
      return {
        claimed: false,
        reason: 'property_duplicate',
      };
    }

    cache.put(cacheKey, '1', 60);
    properties.setProperty(propertyKey, hash + '|' + now);
    return {
      claimed: true,
      reason: 'claimed',
    };
  } finally {
    lock.releaseLock();
  }
}

function handleLeadsViewOpenDetailEdit_(e, sheet, row) {
  if (String(e.value || '').toUpperCase() !== 'TRUE') return;

  const headerMap = getHeaderMap_(sheet);
  const openDetailColumn = headerMap.open_detail;
  const leadId = String(getRowObject_(sheet, row).lead_id || '').trim();
  if (openDetailColumn) sheet.getRange(row, openDetailColumn).setValue(false);

  if (!leadId || !navigateToLatestMatch_('LEADS_MAIN', 'lead_id', leadId)) {
    SpreadsheetApp.getActive().toast('à¹„à¸¡à¹ˆà¸žà¸šà¸£à¸²à¸¢à¸¥à¸°à¹€à¸­à¸µà¸¢à¸”à¸¥à¸¹à¸à¸„à¹‰à¸²', 'Open Detail', 5);
  }
}

function handleLeadsViewLeadStatusEdit_(e, sheet, row) {
  const lead = getRowObject_(sheet, row);
  const leadId = String(lead.lead_id || '').trim();
  const nextStatus = String(lead.lead_status || '').trim();
  if (!leadId || !nextStatus) return;

  const leadMain = getLeadMainObjectByLeadId_(leadId);
  if (!leadMain || !leadMain.row) return;

  const oldStatus = String(leadMain.object.lead_status || '').trim();
  setRowObjectValues_(SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN'), leadMain.row, {
    lead_status: nextStatus,
  });
  createLeadStatusActivity_(SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN'), leadMain.row, oldStatus, nextStatus);
  setupLeadsViewStatusConditionalFormatting_(sheet);
}

function syncLeadsViewEditableFieldToLeadMain_(sheet, row, fieldName) {
  const lead = getRowObject_(sheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return;

  const leadMain = getLeadMainObjectByLeadId_(leadId);
  if (!leadMain || !leadMain.row) return;

  const leadMainSheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  const leadMainHeaderMap = getHeaderMap_(leadMainSheet);
  const targetField = fieldName === 'additional_phone' && !leadMainHeaderMap.additional_phone
    ? ''
    : fieldName;
  if (!targetField || !leadMainHeaderMap[targetField]) {
    Logger.log('LEADS edit kept in LEADS only; LEADS_MAIN has no header for ' + fieldName);
    return;
  }

  let value = lead[fieldName] || '';
  if (fieldName === 'phone') {
    const normalizedPhone = normalizePhone(value);
    if (!normalizedPhone) {
      Logger.log('LEADS phone edit skipped because phone is invalid for lead_id=' + leadId);
      return;
    }
    value = normalizedPhone;
    const phoneColumn = getHeaderMap_(sheet).phone;
    if (phoneColumn) {
      sheet.getRange(row, phoneColumn).setNumberFormat('@').setValue(String(normalizedPhone));
    }
  }

  const update = {};
  update[targetField] = value;
  setRowObjectValues_(leadMainSheet, leadMain.row, update);
}

function getOrCreateLeadsViewSheet_() {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName('LEADS') || ss.insertSheet('LEADS');
}

function setLeadsViewHeaders_(sheet, options) {
  const config = options || {};
  const source = config.source || 'setLeadsViewHeaders_';
  const allowSchemaMigration = Boolean(config.allowSchemaMigration);

  if (sheet.getMaxColumns() < LEADS_VIEW_HEADERS.length) {
    if (!allowSchemaMigration) {
      throw new Error(source + ' stopped because LEADS has fewer columns than required. Run Admin Repair LEADS View.');
    }
    logCrmScriptFormatAudit_(
      'SCRIPT_INSERT_COLUMNS',
      sheet,
      'after max column ' + sheet.getMaxColumns(),
      source + ' inserting missing LEADS schema columns: ' + (LEADS_VIEW_HEADERS.length - sheet.getMaxColumns())
    );
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEADS_VIEW_HEADERS.length - sheet.getMaxColumns());
  }
  if (allowSchemaMigration) {
    migrateLeadsViewSchemaColumnsIfNeeded_(sheet, source);
  }
  if (!isLeadsViewHeaderOrderCurrent_(sheet)) {
    if (!allowSchemaMigration) {
      throw new Error(source + ' stopped because LEADS header order is invalid. Run Admin Repair LEADS View.');
    }
    logCrmScriptFormatAudit_('SCHEMA_PRESERVE_ROWS', sheet, 'A:O', source + ' preserving/remapping LEADS rows by header before header repair.');
    preserveLeadsViewRowsByHeader_(sheet);
  }
  writeLeadsViewHeadersOnly_(sheet, {
    allowStructureChange: allowSchemaMigration,
    source: source,
  });
}

function migrateLeadsViewSchemaColumnsIfNeeded_(sheet, source) {
  if (!sheet || sheet.getLastColumn() < 14) return;

  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const normalized = headers.map(header => normalizeHeaderName_(header));
  const hasNewHistory = normalized.indexOf('sales_note_history') !== -1;
  const oldJ = normalized[9] || '';
  const oldK = normalized[10] || '';
  const oldM = normalized[12] || '';
  const oldN = normalized[13] || '';

  if (!hasNewHistory && oldJ === 'sales_note' && oldK === 'follow_up_count' && oldN === 'open_detail') {
    logCrmScriptFormatAudit_('SCHEMA_MIGRATION_INSERT_COLUMN', sheet, 'after column 10', (source || 'schema migration') + ' inserting Sales Note History column for old LEADS schema.');
    sheet.insertColumnAfter(10);
  } else if (!hasNewHistory && oldJ === 'sales_note' && oldK === 'follow_up_count' && oldM === 'open_detail') {
    logCrmScriptFormatAudit_('SCHEMA_MIGRATION_INSERT_COLUMN', sheet, 'after column 10', (source || 'schema migration') + ' inserting Sales Note History column for old LEADS schema.');
    sheet.insertColumnAfter(10);
    logCrmScriptFormatAudit_('SCHEMA_MIGRATION_INSERT_COLUMN', sheet, 'after column 14', (source || 'schema migration') + ' inserting Facebook Search Name/Open Detail alignment column for old LEADS schema.');
    sheet.insertColumnAfter(14);
  }
}

function writeLeadsViewHeadersOnly_(sheet, options) {
  const config = options || {};
  const source = config.source || 'writeLeadsViewHeadersOnly_';
  const allowStructureChange = Boolean(config.allowStructureChange);

  if (sheet.getMaxColumns() < LEADS_VIEW_HEADERS.length) {
    if (!allowStructureChange) {
      throw new Error(source + ' stopped because LEADS has fewer columns than required. Run Admin Repair LEADS View.');
    }
    logCrmScriptFormatAudit_(
      'SCRIPT_INSERT_COLUMNS',
      sheet,
      'after max column ' + sheet.getMaxColumns(),
      source + ' inserting missing LEADS header columns: ' + (LEADS_VIEW_HEADERS.length - sheet.getMaxColumns())
    );
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEADS_VIEW_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(HEADER_ROW, 1, 1, LEADS_VIEW_HEADERS.length).setValues([LEADS_VIEW_HEADERS]);
  sheet.getRange(HEADER_ROW + 1, 1, 1, LEADS_VIEW_THAI_LABELS.length).setValues([LEADS_VIEW_THAI_LABELS]);
  clearStaleLeadsViewExtraColumns_(sheet);
}

function clearStaleLeadsViewExtraColumns_(sheet) {
  if (!sheet || sheet.getLastColumn() <= LEADS_VIEW_HEADERS.length) return;

  const staleHeaders = {
    fetch_audio: true,
    audio_save_status: true,
    open_detail: true,
    facebook_search_name: true,
  };
  const extraColumnCount = sheet.getLastColumn() - LEADS_VIEW_HEADERS.length;
  const headers = sheet.getRange(HEADER_ROW, LEADS_VIEW_HEADERS.length + 1, 1, extraColumnCount).getValues()[0];

  headers.forEach((header, index) => {
    const normalized = normalizeHeaderName_(header);
    if (!staleHeaders[normalized]) return;

    const column = LEADS_VIEW_HEADERS.length + index + 1;
    const rowCount = Math.max(sheet.getLastRow(), DATA_START_ROW) - HEADER_ROW + 1;
    sheet.getRange(HEADER_ROW, column, rowCount, 1).clearContent().clearDataValidations();
  });
}

function isLeadsViewHeaderOrderCurrent_(sheet) {
  if (!sheet || sheet.getLastColumn() < LEADS_VIEW_HEADERS.length) return false;

  const headers = sheet.getRange(HEADER_ROW, 1, 1, LEADS_VIEW_HEADERS.length).getValues()[0];
  return LEADS_VIEW_HEADERS.every((header, index) => normalizeHeaderName_(headers[index]) === normalizeHeaderName_(header));
}

function preserveLeadsViewRowsByHeader_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW || sheet.getLastColumn() < 1) return;

  const existingHeaders = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const existingMap = existingHeaders.reduce((map, header, index) => {
    const normalized = normalizeHeaderName_(header);
    if (normalized && !map[normalized]) map[normalized] = index;
    return map;
  }, {});
  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const existingValues = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const nextValues = existingValues.map(row => LEADS_VIEW_HEADERS.map(header => {
    const normalizedHeader = normalizeHeaderName_(header);
    const index = existingMap[normalizedHeader] === undefined && normalizedHeader === 'sales_note_input'
      ? existingMap.sales_note
      : existingMap[normalizedHeader];
    return index === undefined ? '' : row[index];
  }));

  sheet.getRange(DATA_START_ROW, 1, rowCount, LEADS_VIEW_HEADERS.length).setValues(nextValues);
}

function clearLeadsViewData_(sheet) {
  const rowCount = Math.max(sheet.getLastRow() - DATA_START_ROW + 1, 0);
  if (rowCount <= 0) return;

  const columnCount = LEADS_VIEW_HEADERS.length;
  sheet
    .getRange(DATA_START_ROW, 1, rowCount, columnCount)
    .clearContent();

  const headerMap = getHeaderMap_(sheet);
  const preserveValidationColumns = [
    headerMap.preferred_call_day,
    headerMap.preferred_call_time,
    headerMap.sales_owner,
  ].filter(Boolean);

  for (let column = 1; column <= columnCount; column++) {
    if (preserveValidationColumns.indexOf(column) !== -1) continue;
    sheet.getRange(DATA_START_ROW, column, rowCount, 1).clearDataValidations();
  }
}

function buildLeadsViewRowValues_(object) {
  return LEADS_VIEW_HEADERS.map(header => {
    const normalizedHeader = normalizeHeaderName_(header);
    return object[normalizedHeader] === undefined ? '' : object[normalizedHeader];
  });
}

function buildLeadsViewObject_(lead, manual) {
  const customerName = lead.customer_name || lead.full_name || lead.name || '';

  return {
    lead_id: lead.lead_id || '',
    customer_name: customerName,
    phone: lead.phone || '',
    additional_phone: manual.additional_phone || '',
    facebook_created_time: lead.facebook_created_time || lead.created_at || '',
    lead_status: lead.lead_status || 'New',
    preferred_call_day: manual.preferred_call_day || lead.preferred_call_day || '',
    preferred_call_time: manual.preferred_call_time || lead.preferred_call_time || '',
    sales_owner: manual.sales_owner || lead.sales_owner || '',
    sales_note_input: manual.sales_note_input || '',
    sales_note_history: manual.sales_note_history || '',
    follow_up_count: manual.follow_up_count || '',
    facebook_search_name: customerName,
    open_detail: false,
  };
}

function sanitizeLeadsViewSyncObject_(object) {
  const sanitized = Object.assign({}, object);
  const status = String(sanitized.lead_status || '').trim();
  sanitized.lead_status = LEAD_MAIN_STATUS_VALUES.indexOf(status) !== -1 ? status : 'New';

  return sanitized;
}

function getSafeLeadsViewManualDataByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();

  values.forEach(row => {
    const leadId = String(row[leadIdColumn - 1] || '').trim();
    if (!leadId) return;

    const manual = {};
    const additionalPhone = getLeadsViewRowValue_(row, headerMap, 'additional_phone');
    if (isSafeAdditionalPhone_(additionalPhone)) manual.additional_phone = String(additionalPhone).trim();

    const followUpCount = getLeadsViewRowValue_(row, headerMap, 'follow_up_count');
    if (isSafeFollowUpCount_(followUpCount)) manual.follow_up_count = followUpCount;

    const salesNoteInput = String(getLeadsViewRowValue_(row, headerMap, 'sales_note_input') || getLeadsViewRowValue_(row, headerMap, 'sales_note') || '').trim();
    if (salesNoteInput) manual.sales_note_input = salesNoteInput;

    const salesNoteHistory = String(getLeadsViewRowValue_(row, headerMap, 'sales_note_history') || '').trim();
    if (salesNoteHistory) manual.sales_note_history = salesNoteHistory;

    const latestAudioLink = String(getLeadsViewRowValue_(row, headerMap, 'latest_audio_link') || '').trim();
    if (latestAudioLink) manual.latest_audio_link = latestAudioLink;

    const salesOwner = String(getLeadsViewRowValue_(row, headerMap, 'sales_owner') || '').trim();
    if (salesOwner) manual.sales_owner = salesOwner;

    const preferredCallDay = String(getLeadsViewRowValue_(row, headerMap, 'preferred_call_day') || '').trim();
    if (preferredCallDay) manual.preferred_call_day = preferredCallDay;

    const preferredCallTime = String(getLeadsViewRowValue_(row, headerMap, 'preferred_call_time') || '').trim();
    if (preferredCallTime) manual.preferred_call_time = preferredCallTime;

    data[leadId] = manual;
  });

  return data;
}

function getLatestActivityAudioUrlByLeadId_() {
  if (typeof getLatestAudioActivityByLeadId_ === 'function') {
    const latestAudioByLeadId = getLatestAudioActivityByLeadId_();
    return Object.keys(latestAudioByLeadId).reduce((result, leadId) => {
      result[leadId] = latestAudioByLeadId[leadId].audioUrl || '';
      return result;
    }, {});
  }

  const sheet = SpreadsheetApp.getActive().getSheetByName('ACTIVITY_LOG');
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.audio_url) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const audioUrl = String(row[headerMap.audio_url - 1] || '').trim();
    if (!leadId || !audioUrl) return;

    const createdAt = headerMap.created_at ? parseLeadsViewDateTime_(row[headerMap.created_at - 1]) : null;
    const sortKey = createdAt ? createdAt.getTime() : DATA_START_ROW + index;
    if (!data[leadId] || data[leadId].sortKey <= sortKey) {
      data[leadId] = {
        url: audioUrl,
        sortKey: sortKey,
      };
    }
  });

  return Object.keys(data).reduce((result, leadId) => {
    result[leadId] = data[leadId].url;
    return result;
  }, {});
}

function getLeadsViewRowValue_(row, headerMap, header) {
  const column = headerMap[normalizeHeaderName_(header)];
  return column ? row[column - 1] : '';
}

function isSafeAdditionalPhone_(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  return Boolean(normalizePhone(raw));
}

function isSafeFollowUpCount_(value) {
  if (value === '' || value === null || value === undefined) return false;
  if (typeof value === 'number') return isFinite(value);
  return /^\d+$/.test(String(value).trim());
}

function getLeadDetailsFacebookCreatedTimeByLeadId_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEAD_DETAILS');
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.facebook_created_time) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach(row => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const value = row[headerMap.facebook_created_time - 1];
    if (leadId && value && !data[leadId]) data[leadId] = value;
  });

  return data;
}

function resolveLeadsViewFacebookCreatedTime_(lead, detailFacebookCreatedTime) {
  return parseLeadsViewDateTime_(lead.facebook_created_time)
    || parseLeadsViewDateTime_(detailFacebookCreatedTime)
    || parseLeadsViewDateTime_(lead.created_at)
    || '';
}

function parseLeadsViewDateTime_(value) {
  if (!value) return null;
  if (typeof parseCrmDateTimeValue_ === 'function') {
    const parsed = parseCrmDateTimeValue_(value);
    if (parsed && parsed instanceof Date && !isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) return parsed;
  }
  if (value instanceof Date && !isNaN(value.getTime()) && value.getFullYear() > 2000) return value;
  return null;
}

function auditLeadsFacebookCreatedTimeDryRun() {
  return runLeadsDateAuditReport();
}

function applyLeadsDateNormalizationAndSort() {
  if (!confirmLeadsDateNormalizationAndSort_()) {
    Logger.log('applyLeadsDateNormalizationAndSort cancelled by user.');
    return {
      cancelled: true,
    };
  }

  return withLeadsViewScriptLock_('applyLeadsDateNormalizationAndSort', 15000, () => applyLeadsDateNormalizationAndSortUnlocked_());
}

function confirmLeadsDateNormalizationAndSort_() {
  try {
    const ui = SpreadsheetApp.getUi();
    const response = ui.alert(
      'Apply Safe Date Format & Sort',
      'This administrator-only operation will validate the latest LEADS_DATE_AUDIT fingerprint against the current LEADS sheet, create a hidden backup copy of LEADS, format existing Date values as dd/MM/yyyy HH:mm, replace audited safe US-style text dates using the approved canonical source date, leave blank/no-canonical rows unchanged, and sort complete LEADS rows newest-first. Continue?',
      ui.ButtonSet.OK_CANCEL
    );
    return response === ui.Button.OK;
  } catch (err) {
    Logger.log('Apply Safe Date Format & Sort confirmation failed: ' + err.message);
    throw new Error('Apply Safe Date Format & Sort requires interactive confirmation.');
  }
}

function applyLeadsDateNormalizationAndSortUnlocked_() {
  const ss = SpreadsheetApp.getActive();
  const startedAt = new Date();
  const result = {
    timestamp: startedAt,
    backupSheetName: '',
    rowsChecked: 0,
    dateObjectsFormatted: 0,
    textDatesConverted: 0,
    blanksPreserved: 0,
    rowsSorted: 0,
    validationStatus: 'FAILED',
    errors: [],
    activeUser: typeof getSafeSessionEmail_ === 'function' ? getSafeSessionEmail_(true) : '',
    effectiveUser: typeof getSafeSessionEmail_ === 'function' ? getSafeSessionEmail_(false) : '',
  };

  try {
    const leadsSheet = ss.getSheetByName('LEADS');
    const auditSheet = ss.getSheetByName(LEADS_DATE_AUDIT_SHEET_NAME);
    if (!leadsSheet) throw new Error('Missing required sheet: LEADS');
    if (!auditSheet) throw new Error('Missing required sheet: ' + LEADS_DATE_AUDIT_SHEET_NAME);

    const headerMap = getHeaderMap_(leadsSheet);
    if (!headerMap.lead_id) throw new Error('Missing LEADS.Lead ID header.');
    if (!headerMap.facebook_created_time) throw new Error('Missing LEADS.Facebook Created Time header.');

    const plan = readLeadsDateApplyPlan_(auditSheet);
    result.rowsChecked = plan.rowsChecked;
    result.dateObjectsFormatted = plan.dateObjectsFormatted;
    result.textDatesConverted = plan.textDatesConverted;
    result.blanksPreserved = plan.blanksPreserved;

    const lastLeadRow = getLastPopulatedLeadIdRow_(leadsSheet, headerMap.lead_id);
    if (lastLeadRow < DATA_START_ROW) throw new Error('LEADS has no populated Lead ID rows.');
    const leadCountBefore = countPopulatedLeadIds_(leadsSheet, headerMap.lead_id, lastLeadRow);
    if (leadCountBefore !== plan.rowsChecked) {
      throw new Error('Date Audit is stale. Audit row count does not match current LEADS Lead ID count. Rerun Run Date Audit (Report Only). audit=' + plan.rowsChecked + ' current=' + leadCountBefore);
    }
    validateLeadsDateApplyFingerprint_(leadsSheet, headerMap, lastLeadRow, plan.metadata);

    validateLeadsDateApplyRowsBeforeWrite_(leadsSheet, headerMap, plan.actions);
    const beforeSnapshot = getLeadsDateApplySnapshot_(leadsSheet, headerMap, lastLeadRow);
    const backupSheet = createLeadsDateBackupSheet_(ss, leadsSheet, startedAt);
    result.backupSheetName = backupSheet.getName();

    applyLeadsDateAuditPlan_(leadsSheet, headerMap, plan.actions);
    validateLeadsDateApplyBeforeSort_(leadsSheet, headerMap, plan.actions, leadCountBefore);

    const finalColumn = Math.max(leadsSheet.getLastColumn(), LEADS_VIEW_HEADERS.length);
    const sortRowCount = lastLeadRow - DATA_START_ROW + 1;
    leadsSheet.getRange(DATA_START_ROW, 1, sortRowCount, finalColumn).sort({
      column: headerMap.facebook_created_time,
      ascending: false,
    });
    result.rowsSorted = sortRowCount;

    validateLeadsDateApplyAfterSort_(leadsSheet, headerMap, beforeSnapshot, leadCountBefore);
    result.validationStatus = 'OK';
    SpreadsheetApp.getActive().toast('LEADS dates normalized and sorted. Backup: ' + result.backupSheetName, 'Apply Safe Date Format & Sort', 8);
    Logger.log('applyLeadsDateNormalizationAndSort completed ' + JSON.stringify(result));
    return result;
  } catch (err) {
    result.validationStatus = 'FAILED';
    result.errors.push(err && err.message ? err.message : String(err));
    Logger.log('applyLeadsDateNormalizationAndSort failed: ' + result.errors.join('; '));
    throw err;
  } finally {
    writeLeadsDateApplyLog_(result);
  }
}

function readLeadsDateApplyPlan_(auditSheet) {
  if (!auditSheet || auditSheet.getLastRow() < 1) throw new Error('LEADS_DATE_AUDIT is empty.');

  const values = auditSheet.getDataRange().getValues();
  const metadata = readLeadsDateAuditMetadata_(values);
  validateLeadsDateAuditMetadataForApply_(metadata);
  let headerRowIndex = -1;
  let headerMap = {};
  for (let rowIndex = 0; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    const currentMap = {};
    row.forEach((value, index) => {
      const key = normalizeHeaderName_(value);
      if (key) currentMap[key] = index;
    });
    if (
      currentMap.leads_row
      && currentMap.lead_id
      && (currentMap.classification !== undefined || currentMap.detected_format_type !== undefined)
      && (currentMap.safe_to_apply !== undefined || currentMap.proposed_action !== undefined)
    ) {
      headerRowIndex = rowIndex;
      headerMap = currentMap;
      break;
    }
  }
  if (headerRowIndex < 0) throw new Error('Could not find row-level headers in LEADS_DATE_AUDIT.');

  const actions = [];
  const unexpected = [];
  let dateObjectsFormatted = 0;
  let textDatesConverted = 0;
  let blanksPreserved = 0;
  const classificationCounts = {};

  for (let rowIndex = headerRowIndex + 1; rowIndex < values.length; rowIndex++) {
    const row = values[rowIndex];
    const leadId = String(row[headerMap.lead_id] || '').trim();
    if (!leadId) continue;

    const leadsRow = Number(row[headerMap.leads_row]);
    const classificationValue = headerMap.classification !== undefined
      ? row[headerMap.classification]
      : row[headerMap.detected_format_type];
    const proposedAction = headerMap.proposed_action !== undefined
      ? String(row[headerMap.proposed_action] || '').trim().toLowerCase()
      : '';
    const safeToApply = headerMap.safe_to_apply !== undefined
      ? String(row[headerMap.safe_to_apply] || '').trim().toLowerCase() === 'yes'
      : ['safe_to_normalize', 'already_valid'].indexOf(proposedAction) !== -1;
    const proposedDateValue = headerMap.proposed_safe_datetime !== undefined
      ? row[headerMap.proposed_safe_datetime]
      : headerMap.proposed_normalized_datetime !== undefined
        ? row[headerMap.proposed_normalized_datetime]
        : '';
    const classification = normalizeLeadsDateApplyClassification_(classificationValue);
    const proposedDate = parseLeadsDateAuditCellValue_(proposedDateValue, proposedDateValue).parsedDate;
    let action = '';
    classificationCounts[classification] = (classificationCounts[classification] || 0) + 1;

    if (classification === 'date_object_safe' || classification === 'already_valid') {
      action = 'format_only';
      dateObjectsFormatted++;
    } else if ((classification === 'text_us_unambiguous' || classification === 'mm_dd_yyyy') && safeToApply && proposedDate) {
      action = 'convert_text';
      textDatesConverted++;
    } else if (classification === 'blank' || classification === 'canonical_source_missing' || classification === 'no_canonical_date') {
      action = 'preserve_blank';
      blanksPreserved++;
    } else {
      unexpected.push('audit row ' + (rowIndex + 1) + ' lead_id=' + leadId + ' classification=' + classification + ' safe_to_apply=' + safeToApply);
      continue;
    }

    if (!Number.isFinite(leadsRow) || leadsRow < DATA_START_ROW) {
      unexpected.push('audit row ' + (rowIndex + 1) + ' has invalid LEADS row: ' + row[headerMap.leads_row]);
      continue;
    }
    if (action === 'convert_text' && !proposedDate) {
      unexpected.push('audit row ' + (rowIndex + 1) + ' convert_text missing proposed datetime.');
      continue;
    }

    actions.push({
      auditRow: rowIndex + 1,
      leadsRow: leadsRow,
      leadId: leadId,
      classification: classification,
      action: action,
      proposedDate: proposedDate,
    });
  }

  if (unexpected.length) throw new Error('Unexpected Date Audit rows: ' + unexpected.slice(0, 10).join('; '));

  return {
    actions: actions,
    metadata: metadata,
    classificationCounts: classificationCounts,
    rowsChecked: actions.length,
    dateObjectsFormatted: dateObjectsFormatted,
    textDatesConverted: textDatesConverted,
    blanksPreserved: blanksPreserved,
  };
}

function readLeadsDateAuditMetadata_(values) {
  const metadata = {};
  values.forEach(row => {
    const key = normalizeHeaderName_(row[0]);
    if (key) metadata[key] = row[1];
  });
  return metadata;
}

function validateLeadsDateAuditMetadataForApply_(metadata) {
  const missing = [];
  ['audit_run_id', 'audit_timestamp', 'spreadsheet_id', 'leads_last_audited_row', 'audit_source_fingerprint'].forEach(key => {
    if (metadata[key] === '' || metadata[key] === null || metadata[key] === undefined) missing.push(key);
  });
  if (missing.length) {
    throw new Error('LEADS_DATE_AUDIT is missing apply-safety metadata (' + missing.join(', ') + '). Rerun Run Date Audit (Report Only).');
  }
}

function validateLeadsDateApplyFingerprint_(sheet, headerMap, lastLeadRow, metadata) {
  const ss = SpreadsheetApp.getActive();
  const auditedSpreadsheetId = String(metadata.spreadsheet_id || '').trim();
  if (auditedSpreadsheetId && auditedSpreadsheetId !== ss.getId()) {
    throw new Error('Date Audit was generated for a different spreadsheet. Rerun Run Date Audit (Report Only).');
  }

  const auditedLastRow = Number(metadata.leads_last_audited_row);
  if (!Number.isFinite(auditedLastRow) || auditedLastRow !== lastLeadRow) {
    throw new Error('Date Audit is stale. LEADS last audited row changed. Rerun Run Date Audit (Report Only). audit=' + auditedLastRow + ' current=' + lastLeadRow);
  }

  const liveFingerprint = buildLeadsDateAuditFingerprint_(sheet, headerMap, lastLeadRow);
  const auditFingerprint = String(metadata.audit_source_fingerprint || '').trim();
  if (!auditFingerprint || liveFingerprint.fingerprint !== auditFingerprint) {
    throw new Error('Date Audit is stale. Lead ID/date fingerprint changed. Rerun Run Date Audit (Report Only).');
  }
}

function normalizeLeadsDateApplyClassification_(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'date_object' || raw === 'date object') return 'date_object_safe';
  if (raw === 'already_valid') return 'already_valid';
  if (raw === 'safe_to_normalize') return 'text_us_unambiguous';
  if (raw === 'mm/dd/yyyy' || raw === 'mm_dd_yyyy') return 'mm_dd_yyyy';
  if (raw === 'no_canonical_date') return 'no_canonical_date';
  return raw;
}

function validateLeadsDateApplyRowsBeforeWrite_(sheet, headerMap, actions) {
  const errors = [];
  actions.forEach(action => {
    const rowLeadId = String(sheet.getRange(action.leadsRow, headerMap.lead_id).getValue() || '').trim();
    if (rowLeadId !== action.leadId) {
      errors.push('LEADS row ' + action.leadsRow + ' expected lead_id=' + action.leadId + ' actual=' + rowLeadId);
    }
  });
  if (errors.length) throw new Error('Date apply row validation failed before write: ' + errors.slice(0, 10).join('; '));
}

function createLeadsDateBackupSheet_(ss, sourceSheet, timestamp) {
  const backupNameBase = 'LEADS_DATE_BACKUP_' + Utilities.formatDate(timestamp, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
  let backupName = backupNameBase;
  let suffix = 1;
  while (ss.getSheetByName(backupName)) {
    backupName = backupNameBase + '_' + suffix;
    suffix++;
  }
  const backupSheet = sourceSheet.copyTo(ss).setName(backupName);
  backupSheet.hideSheet();
  return backupSheet;
}

function applyLeadsDateAuditPlan_(sheet, headerMap, actions) {
  const dateColumn = headerMap.facebook_created_time;
  actions.forEach(action => {
    const cell = sheet.getRange(action.leadsRow, dateColumn);
    if (action.action === 'format_only') {
      cell.setNumberFormat(LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT);
      return;
    }
    if (action.action === 'convert_text') {
      cell.setValue(action.proposedDate);
      cell.setNumberFormat(LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT);
    }
  });
}

function validateLeadsDateApplyBeforeSort_(sheet, headerMap, actions, expectedLeadCount) {
  const leadCount = countPopulatedLeadIds_(sheet, headerMap.lead_id, getLastPopulatedLeadIdRow_(sheet, headerMap.lead_id));
  if (leadCount !== expectedLeadCount) throw new Error('Lead ID count changed before sort. expected=' + expectedLeadCount + ' actual=' + leadCount);

  const errors = [];
  actions.forEach(action => {
    const value = sheet.getRange(action.leadsRow, headerMap.facebook_created_time).getValue();
    if (action.action === 'format_only' || action.action === 'convert_text') {
      if (!(value instanceof Date) || isNaN(value.getTime())) {
        errors.push('LEADS row ' + action.leadsRow + ' date is not a valid Date object after apply.');
      }
    } else if (action.action === 'preserve_blank') {
      if (value !== '' && value !== null) {
        errors.push('LEADS row ' + action.leadsRow + ' expected blank/no-canonical date to remain blank.');
      }
    }
  });
  if (errors.length) throw new Error('Date apply validation failed before sort: ' + errors.slice(0, 10).join('; '));
}

function getLastPopulatedLeadIdRow_(sheet, leadIdColumn) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW || !leadIdColumn) return DATA_START_ROW - 1;
  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, leadIdColumn, rowCount, 1).getValues();
  let lastRow = DATA_START_ROW - 1;
  values.forEach((row, index) => {
    if (String(row[0] || '').trim()) lastRow = DATA_START_ROW + index;
  });
  return lastRow;
}

function countPopulatedLeadIds_(sheet, leadIdColumn, lastLeadRow) {
  if (!sheet || !leadIdColumn || lastLeadRow < DATA_START_ROW) return 0;
  const values = sheet.getRange(DATA_START_ROW, leadIdColumn, lastLeadRow - DATA_START_ROW + 1, 1).getValues();
  return values.reduce((count, row) => count + (String(row[0] || '').trim() ? 1 : 0), 0);
}

function getLeadsDateApplySnapshot_(sheet, headerMap, lastLeadRow) {
  const snapshot = {};
  if (lastLeadRow < DATA_START_ROW) return snapshot;
  const lastColumn = sheet.getLastColumn();
  const values = sheet.getRange(DATA_START_ROW, 1, lastLeadRow - DATA_START_ROW + 1, lastColumn).getValues();
  values.forEach(row => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId) return;
    snapshot[leadId] = {
      customerName: headerMap.customer_name ? String(row[headerMap.customer_name - 1] || '') : '',
      phone: headerMap.phone ? String(row[headerMap.phone - 1] || '') : '',
      noteHistory: headerMap.sales_note_history ? String(row[headerMap.sales_note_history - 1] || '') : '',
      latestAudioLink: headerMap.latest_audio_link ? String(row[headerMap.latest_audio_link - 1] || '') : '',
      audioMemoValues: lastColumn >= LEADS_VIEW_MEMO_START_COLUMN
        ? row.slice(LEADS_VIEW_MEMO_START_COLUMN - 1).map(value => String(value || '')).join('\u001f')
        : '',
    };
  });
  return snapshot;
}

function validateLeadsDateApplyAfterSort_(sheet, headerMap, beforeSnapshot, expectedLeadCount) {
  const lastLeadRow = getLastPopulatedLeadIdRow_(sheet, headerMap.lead_id);
  const leadCount = countPopulatedLeadIds_(sheet, headerMap.lead_id, lastLeadRow);
  if (leadCount !== expectedLeadCount) throw new Error('Lead ID count changed after sort. expected=' + expectedLeadCount + ' actual=' + leadCount);

  const afterSnapshot = getLeadsDateApplySnapshot_(sheet, headerMap, lastLeadRow);
  const errors = [];
  const leadIdValues = sheet.getRange(DATA_START_ROW, headerMap.lead_id, lastLeadRow - DATA_START_ROW + 1, 1).getValues();
  const leadIdKeys = {};
  leadIdValues.forEach((row, index) => {
    const leadId = String(row[0] || '').trim();
    if (!leadId) return;
    if (leadIdKeys[leadId]) {
      errors.push('Duplicate Lead ID after sort: ' + leadId + ' at LEADS row ' + (DATA_START_ROW + index));
    }
    leadIdKeys[leadId] = true;
  });
  const seen = {};
  Object.keys(beforeSnapshot).forEach(leadId => {
    if (!afterSnapshot[leadId]) {
      errors.push('Lead ID missing after sort: ' + leadId);
      return;
    }
    if (seen[leadId]) errors.push('Duplicate Lead ID after sort: ' + leadId);
    seen[leadId] = true;
    ['customerName', 'phone', 'noteHistory', 'latestAudioLink', 'audioMemoValues'].forEach(field => {
      if (beforeSnapshot[leadId][field] !== afterSnapshot[leadId][field]) {
        errors.push('Row-associated field changed for lead_id=' + leadId + ' field=' + field);
      }
    });
  });

  const dateRange = sheet.getRange(DATA_START_ROW, headerMap.facebook_created_time, lastLeadRow - DATA_START_ROW + 1, 1);
  const dateValues = dateRange.getValues();
  const dateFormats = dateRange.getNumberFormats();
  let previousTime = null;
  let blankStarted = false;
  dateValues.forEach((row, index) => {
    const value = row[0];
    const sheetRow = DATA_START_ROW + index;
    if (value === '' || value === null) {
      blankStarted = true;
      return;
    }
    if (!(value instanceof Date) || isNaN(value.getTime())) {
      errors.push('Non-blank date is not a Date object after sort at LEADS row ' + sheetRow);
      return;
    }
    if (String(dateFormats[index][0] || '') !== LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT) {
      errors.push('Non-blank date does not use dd/MM/yyyy HH:mm format at LEADS row ' + sheetRow);
    }
    if (blankStarted) errors.push('Dated row appears after blank-date row at LEADS row ' + sheetRow);
    const time = value.getTime();
    if (previousTime !== null && time > previousTime) {
      errors.push('Dates are not sorted newest-first near LEADS row ' + sheetRow);
    }
    previousTime = time;
  });

  if (errors.length) throw new Error('Date apply post-sort validation failed: ' + errors.slice(0, 10).join('; '));
}

function getOrCreateLeadsDateApplyLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEADS_DATE_APPLY_LOG_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LEADS_DATE_APPLY_LOG_SHEET_NAME);
  return sheet;
}

function writeLeadsDateApplyLog_(result) {
  try {
    const sheet = getOrCreateLeadsDateApplyLogSheet_();
    const headers = [
      'timestamp',
      'backup sheet name',
      'rows checked',
      'Date objects formatted',
      'text dates converted',
      'blanks preserved',
      'rows sorted',
      'validation status',
      'errors',
      'active user',
      'effective user',
    ];
    if (sheet.getLastRow() < 1) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    sheet.appendRow([
      result.timestamp || new Date(),
      result.backupSheetName || '',
      result.rowsChecked || 0,
      result.dateObjectsFormatted || 0,
      result.textDatesConverted || 0,
      result.blanksPreserved || 0,
      result.rowsSorted || 0,
      result.validationStatus || '',
      (result.errors || []).join('; '),
      result.activeUser || '',
      result.effectiveUser || '',
    ]);
  } catch (err) {
    Logger.log('Unable to write LEADS date apply log: ' + (err && err.message ? err.message : err));
  }
}

function runLeadsDateAuditReport() {
  if (!confirmLeadsDateAuditReport_()) {
    Logger.log('runLeadsDateAuditReport cancelled by user.');
    return {
      cancelled: true,
    };
  }

  return withLeadsViewScriptLock_('runLeadsDateAuditReport', 15000, () => runLeadsDateAuditReportUnlocked_());
}

function confirmLeadsDateAuditReport_() {
  try {
    const ui = SpreadsheetApp.getUi();
    const response = ui.alert(
      'Run Date Audit (Report Only)',
      'This reads live CRM date data and writes only the LEADS_DATE_AUDIT report sheet. It does not change LEADS, LEADS_MAIN, LEAD_DETAILS, sorting, Sales Note History, audio fields, values, or number formats. Continue?',
      ui.ButtonSet.OK_CANCEL
    );
    return response === ui.Button.OK;
  } catch (err) {
    Logger.log('Run Date Audit confirmation failed: ' + err.message);
    throw new Error('Run Date Audit requires interactive confirmation.');
  }
}

function runLeadsDateAuditReportUnlocked_() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadDetailsSheet = ss.getSheetByName('LEAD_DETAILS');
  const auditSheet = getOrCreateLeadsDateAuditSheet_();
  const auditAt = new Date();

  if (!leadsSheet || !leadMainSheet) {
    const problem = !leadsSheet ? 'Missing required sheet: LEADS' : 'Missing required sheet: LEADS_MAIN';
    writeLeadsDateAuditReport_(auditSheet, auditAt, getLeadsDateAuditMetadata_(ss), getEmptyLeadsDateAuditCounts_(), [], problem);
    return {
      rows_checked: 0,
      error: problem,
    };
  }

  const leadsHeaderMap = getHeaderMap_(leadsSheet);
  const leadMainHeaderMap = getHeaderMap_(leadMainSheet);
  const missingHeaders = [];
  if (!leadsHeaderMap.lead_id) missingHeaders.push('LEADS.Lead ID');
  if (!leadsHeaderMap.facebook_created_time) missingHeaders.push('LEADS.Facebook Created Time');
  if (!leadMainHeaderMap.lead_id) missingHeaders.push('LEADS_MAIN.lead_id');
  if (missingHeaders.length) {
    const problem = 'Missing required header(s): ' + missingHeaders.join(', ');
    writeLeadsDateAuditReport_(auditSheet, auditAt, getLeadsDateAuditMetadata_(ss), getEmptyLeadsDateAuditCounts_(), [], problem);
    return {
      rows_checked: 0,
      error: problem,
    };
  }

    const metadata = getLeadsDateAuditMetadata_(ss);
    const leadMainByLeadId = getLeadsDateAuditLeadMainByLeadId_(leadMainSheet);
    const leadDetailsByLeadId = getLeadsDateAuditLeadDetailsByLeadId_(leadDetailsSheet);
    const rowCount = Math.max(leadsSheet.getLastRow() - DATA_START_ROW + 1, 0);
    const lastAuditedRow = getLastPopulatedLeadIdRow_(leadsSheet, leadsHeaderMap.lead_id);
    const fingerprint = buildLeadsDateAuditFingerprint_(leadsSheet, leadsHeaderMap, lastAuditedRow);
    metadata.audit_run_id = Utilities.getUuid();
    metadata.audit_timestamp = auditAt;
    metadata.leads_last_audited_row = fingerprint.lastAuditedRow;
    metadata.audit_source_fingerprint = fingerprint.fingerprint;
    metadata.audit_fingerprint_rows = fingerprint.rowsChecked;
    const rows = [];
    const counts = getEmptyLeadsDateAuditCounts_();

  if (rowCount > 0) {
    const lastColumn = leadsSheet.getLastColumn();
    const values = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getValues();
    const displayValues = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getDisplayValues();
    const numberFormats = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getNumberFormats();

    values.forEach((row, index) => {
    const displayRow = displayValues[index];
      const formatRow = numberFormats[index];
    const sheetRow = DATA_START_ROW + index;
    const leadId = String(row[leadsHeaderMap.lead_id - 1] || '').trim();
    if (!leadId) return;

      counts.total_rows_checked++;
    const customerName = leadsHeaderMap.customer_name ? displayRow[leadsHeaderMap.customer_name - 1] : '';
    const currentValue = row[leadsHeaderMap.facebook_created_time - 1];
    const currentDisplay = displayRow[leadsHeaderMap.facebook_created_time - 1];
      const currentFormat = formatRow[leadsHeaderMap.facebook_created_time - 1] || '';
      const currentAudit = parseLeadsDateAuditCellValue_(currentValue, currentDisplay);
      const canonical = resolveLeadsDateAuditCanonicalValue_(leadMainByLeadId[leadId], leadDetailsByLeadId[leadId]);
      const classification = classifyLeadsDateAuditRecord_(currentAudit, canonical, currentDisplay, currentFormat);
      incrementLeadsDateAuditCounts_(counts, currentAudit, classification);

    rows.push([
        auditAt,
      sheetRow,
      leadId,
      customerName,
        serializeLeadsDateAuditValue_(currentValue),
        currentDisplay,
        getLeadsDateAuditValueType_(currentValue),
        currentFormat,
        canonical.source,
        serializeLeadsDateAuditValue_(canonical.rawValue),
        canonical.parsedDate ? formatLeadsDateAuditDate_(canonical.parsedDate) : '',
        classification.classification,
        canonical.parsedDate ? formatLeadsDateAuditDate_(canonical.parsedDate) : '',
        canonical.parsedDate ? formatLeadsDateAuditDisplayValue_(canonical.parsedDate) : '',
        classification.safeToApply ? 'yes' : 'no',
        classification.reason,
    ]);
  });
  }

  metadata.classification_counts_json = JSON.stringify(counts.classification_counts || {});
  writeLeadsDateAuditReport_(auditSheet, auditAt, metadata, counts, rows, '');
  SpreadsheetApp.getActive().toast('LEADS date audit rows checked: ' + counts.total_rows_checked, 'Run Date Audit', 5);
  Logger.log('runLeadsDateAuditReport ' + JSON.stringify(counts));
  return counts;
}

function getLeadsDateAuditMetadata_(ss) {
  return {
    spreadsheet_id: ss.getId(),
    spreadsheet_locale: getSafeSpreadsheetLocale_(ss),
    spreadsheet_timezone: ss.getSpreadsheetTimeZone(),
    apps_script_timezone: Session.getScriptTimeZone() || 'Asia/Bangkok',
    target_datetime_format: LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT,
    target_date_format: LEADS_DATE_AUDIT_TARGET_DATE_FORMAT,
    audited_sheet: 'LEADS',
    audited_date_columns: 'Facebook Created Time',
    sort_plan: 'Future apply step only: sort complete LEADS data rows by Facebook Created Time newest to oldest, excluding rows 1-2 and keeping Lead ID, customer fields, K notes, M audio link, P+ audio memos, formatting, and validations attached to the same row.',
  };
}

function getSafeSpreadsheetLocale_(ss) {
  try {
    return typeof ss.getSpreadsheetLocale === 'function' ? ss.getSpreadsheetLocale() : '';
  } catch (err) {
    return '';
  }
}

function getEmptyLeadsDateAuditCounts_() {
  return {
    total_rows_checked: 0,
    blank_dates: 0,
    safe_date_objects: 0,
    safe_text_conversions: 0,
    ambiguous_values: 0,
    invalid_values: 0,
    missing_canonical_source: 0,
    timezone_mismatches: 0,
    display_only_mismatches: 0,
    safe_to_apply_yes: 0,
    safe_to_apply_no: 0,
    classification_counts: {},
  };
}

function buildLeadsDateAuditFingerprint_(sheet, headerMap, lastAuditedRow) {
  if (!sheet || !headerMap || !headerMap.lead_id || !headerMap.facebook_created_time || lastAuditedRow < DATA_START_ROW) {
    return {
      lastAuditedRow: DATA_START_ROW - 1,
      rowsChecked: 0,
      fingerprint: sha256Hex_(''),
    };
  }

  const rowCount = lastAuditedRow - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const displayValues = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getDisplayValues();
  const entries = [];
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId) return;
    const rawValue = serializeLeadsDateAuditValue_(row[headerMap.facebook_created_time - 1]);
    const displayValue = String(displayValues[index][headerMap.facebook_created_time - 1] || '');
    entries.push([DATA_START_ROW + index, leadId, rawValue, displayValue].join('\u001f'));
  });

  return {
    lastAuditedRow: lastAuditedRow,
    rowsChecked: entries.length,
    fingerprint: sha256Hex_(entries.join('\u001e')),
  };
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || ''), Utilities.Charset.UTF_8)
    .map(byte => {
      const normalized = byte < 0 ? byte + 256 : byte;
      return ('0' + normalized.toString(16)).slice(-2);
    })
    .join('');
}

function getLeadsDateAuditLeadMainByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id) return data;

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const displayValues = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getDisplayValues();
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId) return;

    data[leadId] = {
      facebook_created_time: headerMap.facebook_created_time ? row[headerMap.facebook_created_time - 1] : '',
      facebook_created_time_display: headerMap.facebook_created_time ? displayValues[index][headerMap.facebook_created_time - 1] : '',
      created_at: headerMap.created_at ? row[headerMap.created_at - 1] : '',
      created_at_display: headerMap.created_at ? displayValues[index][headerMap.created_at - 1] : '',
    };
  });
  return data;
}

function getLeadsDateAuditLeadDetailsByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.facebook_created_time) return data;

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const displayValues = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getDisplayValues();
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId || data[leadId]) return;

    data[leadId] = {
      facebook_created_time: row[headerMap.facebook_created_time - 1],
      facebook_created_time_display: displayValues[index][headerMap.facebook_created_time - 1],
    };
  });
  return data;
}

function resolveLeadsDateAuditCanonicalValue_(leadMainData, leadDetailsData) {
  const candidates = [
    {
      source: 'LEADS_MAIN.facebook_created_time',
      value: leadMainData ? leadMainData.facebook_created_time : '',
      display: leadMainData ? leadMainData.facebook_created_time_display : '',
    },
    {
      source: 'LEAD_DETAILS.facebook_created_time',
      value: leadDetailsData ? leadDetailsData.facebook_created_time : '',
      display: leadDetailsData ? leadDetailsData.facebook_created_time_display : '',
    },
    {
      source: 'LEADS_MAIN.created_at',
      value: leadMainData ? leadMainData.created_at : '',
      display: leadMainData ? leadMainData.created_at_display : '',
    },
  ];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const parsed = parseLeadsDateAuditCellValue_(candidate.value, candidate.display);
    if (parsed.parsedDate) {
      return {
        source: candidate.source,
        rawValue: candidate.value,
        rawDisplay: candidate.display,
        parsedDate: parsed.parsedDate,
        parsedKind: parsed.kind,
      };
    }
  }

  return {
    source: '',
    rawValue: '',
    rawDisplay: '',
    parsedDate: null,
    parsedKind: 'canonical_source_missing',
  };
}

function parseLeadsDateAuditCellValue_(value, displayValue) {
  const display = String(displayValue || '').trim();
  if ((value === '' || value === null || value === undefined) && !display) {
    return {
      kind: 'blank',
      parsedDate: null,
      ambiguous: false,
    };
  }

  if (value instanceof Date) {
    return {
      kind: isNaN(value.getTime()) ? 'invalid_date' : 'date_object_safe',
      parsedDate: isNaN(value.getTime()) ? null : value,
      ambiguous: false,
    };
  }

  const raw = String(value || display || '').trim();
  if (!raw) {
    return {
      kind: 'blank',
      parsedDate: null,
      ambiguous: false,
    };
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/);
  if (isoMatch) {
    return parseLeadsDateAuditIsoValue_(raw, isoMatch);
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (slashMatch) {
    return parseLeadsDateAuditSlashValue_(slashMatch);
  }

  return {
    kind: 'invalid_date',
    parsedDate: null,
    ambiguous: false,
  };
}

function parseLeadsDateAuditIsoValue_(raw, match) {
  const hasTimeZone = Boolean(match[7]);
  const hasTime = Boolean(match[4]);
  if (hasTimeZone) {
    const date = new Date(raw);
    return {
      kind: isNaN(date.getTime()) ? 'invalid_date' : 'text_iso_safe',
      parsedDate: isNaN(date.getTime()) ? null : date,
      ambiguous: false,
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = hasTime ? Number(match[4]) : 0;
  const minute = hasTime ? Number(match[5]) : 0;
  const date = new Date(year, month - 1, day, hour, minute);
  return {
    kind: isNaN(date.getTime()) ? 'invalid_date' : 'text_iso_safe',
    parsedDate: isNaN(date.getTime()) ? null : date,
    ambiguous: false,
  };
}

function parseLeadsDateAuditSlashValue_(match) {
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);

  if (first >= 1 && first <= 12 && second >= 1 && second <= 12) {
    return {
      kind: 'ambiguous_slash_date',
      parsedDate: null,
      ambiguous: true,
    };
  }
  if (first > 12 && second <= 12) {
    return {
      kind: 'text_day_first_unambiguous',
      parsedDate: new Date(year, second - 1, first, hour, minute),
      ambiguous: false,
    };
  }
  if (second > 12 && first <= 12) {
    return {
      kind: 'text_us_unambiguous',
      parsedDate: new Date(year, first - 1, second, hour, minute),
      ambiguous: false,
    };
  }

  return {
    kind: 'invalid_date',
    parsedDate: null,
    ambiguous: false,
  };
}

function classifyLeadsDateAuditRecord_(current, canonical, currentDisplay, currentNumberFormat) {
  if (current.kind === 'blank') {
    return {
      classification: 'blank',
      safeToApply: false,
      reason: 'LEADS Facebook Created Time is blank.',
    };
  }
  if (!canonical.parsedDate) {
    return {
      classification: 'canonical_source_missing',
      safeToApply: false,
      reason: 'No valid canonical timestamp found by Lead ID from LEADS_MAIN.facebook_created_time, LEAD_DETAILS.facebook_created_time, or LEADS_MAIN.created_at.',
    };
  }
  if (current.kind === 'ambiguous_slash_date') {
    return {
      classification: 'ambiguous_slash_date',
      safeToApply: true,
      reason: 'Current displayed slash date is ambiguous, but canonical source by Lead ID can be used for a safe apply step.',
    };
  }
  if (!current.parsedDate || current.kind === 'invalid_date') {
    return {
      classification: 'invalid_date',
      safeToApply: false,
      reason: 'Current LEADS date is not parseable as a Date object, ISO value, or unambiguous slash date.',
    };
  }

  const currentKey = formatLeadsDateAuditDate_(current.parsedDate);
  const canonicalKey = formatLeadsDateAuditDate_(canonical.parsedDate);
  if (currentKey !== canonicalKey) {
    const currentDay = Utilities.formatDate(current.parsedDate, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
    const canonicalDay = Utilities.formatDate(canonical.parsedDate, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd');
    return {
      classification: currentDay === canonicalDay ? 'timezone_mismatch' : 'invalid_date',
      safeToApply: false,
      reason: 'Current parsed datetime (' + currentKey + ') differs from canonical datetime (' + canonicalKey + ').',
    };
  }

  const targetDisplay = formatLeadsDateAuditDisplayValue_(canonical.parsedDate);
  const displayOnlyMismatch = String(currentDisplay || '').trim() !== targetDisplay
    || isUsStyleLeadsDateNumberFormat_(currentNumberFormat);
  return {
    classification: current.kind,
    safeToApply: true,
    displayOnlyMismatch: displayOnlyMismatch,
    reason: displayOnlyMismatch
      ? 'Underlying datetime matches canonical, but displayed value or number format is not target dd/MM/yyyy HH:mm.'
      : 'Current value is safe and already aligns with the canonical source.',
  };
}

function incrementLeadsDateAuditCounts_(counts, current, classification) {
  counts.classification_counts[classification.classification] = (counts.classification_counts[classification.classification] || 0) + 1;
  if (classification.classification === 'blank') counts.blank_dates++;
  if (current.kind === 'date_object_safe') counts.safe_date_objects++;
  if (classification.safeToApply && current.kind !== 'date_object_safe' && current.kind !== 'blank') counts.safe_text_conversions++;
  if (classification.classification === 'ambiguous_slash_date') counts.ambiguous_values++;
  if (classification.classification === 'invalid_date') counts.invalid_values++;
  if (classification.classification === 'canonical_source_missing') counts.missing_canonical_source++;
  if (classification.classification === 'timezone_mismatch') counts.timezone_mismatches++;
  if (classification.classification === 'display_only_mismatch' || classification.displayOnlyMismatch) counts.display_only_mismatches++;
  if (classification.safeToApply) {
    counts.safe_to_apply_yes++;
  } else {
    counts.safe_to_apply_no++;
  }
}

function isUsStyleLeadsDateNumberFormat_(numberFormat) {
  const raw = String(numberFormat || '');
  return raw.indexOf('MM/dd') !== -1 || /\bm{1,2}\/d{1,2}\/y{2,4}/.test(raw);
}

function serializeLeadsDateAuditValue_(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? 'Invalid Date'
      : Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function getLeadsDateAuditValueType_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? 'Invalid Date object' : 'Date object';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}

function getLeadMainDateAuditDataByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  const displayValues = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getDisplayValues();
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId) return;
    data[leadId] = {
      facebook_created_time: headerMap.facebook_created_time ? row[headerMap.facebook_created_time - 1] : '',
      facebook_created_time_display: headerMap.facebook_created_time ? displayValues[index][headerMap.facebook_created_time - 1] : '',
      created_at: headerMap.created_at ? row[headerMap.created_at - 1] : '',
      created_at_display: headerMap.created_at ? displayValues[index][headerMap.created_at - 1] : '',
    };
  });
  return data;
}

function resolveLeadsDateAuditCanonicalSource_(leadMainData, detailFacebookCreatedTime) {
  const candidates = [
    {
      source: 'LEADS_MAIN.facebook_created_time',
      raw: leadMainData ? leadMainData.facebook_created_time : '',
      rawDisplay: leadMainData ? leadMainData.facebook_created_time_display : '',
    },
    {
      source: 'LEAD_DETAILS.facebook_created_time',
      raw: detailFacebookCreatedTime || '',
      rawDisplay: detailFacebookCreatedTime || '',
    },
    {
      source: 'LEADS_MAIN.created_at',
      raw: leadMainData ? leadMainData.created_at : '',
      rawDisplay: leadMainData ? leadMainData.created_at_display : '',
    },
  ];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const parsed = parseLeadsDateAuditCanonicalDate_(candidate.raw);
    if (parsed) {
      return {
        source: candidate.source,
        rawDisplay: String(candidate.rawDisplay || candidate.raw || ''),
        parsedDate: parsed,
        reviewNote: '',
      };
    }
  }

  return {
    source: '',
    rawDisplay: '',
    parsedDate: null,
    reviewNote: 'No valid canonical date found by Lead ID.',
  };
}

function classifyLeadsDateAuditValue_(value, displayValue) {
  const display = String(displayValue || '').trim();
  if (!display && !value) {
    return {
      valueType: 'blank',
      detectedFormat: 'blank',
      countKey: 'blank',
      reviewNote: 'Current LEADS date is blank.',
    };
  }

  if (value instanceof Date && !isNaN(value.getTime())) {
    return {
      valueType: 'Date object',
      detectedFormat: 'Date object',
      countKey: 'date_object',
      reviewNote: '',
    };
  }

  const raw = String(value || display || '').trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?/.test(raw)) {
    return {
      valueType: 'string',
      detectedFormat: 'ISO string',
      countKey: 'iso_string',
      reviewNote: '',
    };
  }

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    if (first >= 1 && first <= 12 && second >= 1 && second <= 12) {
      return {
        valueType: 'string',
        detectedFormat: 'ambiguous slash date',
        countKey: 'ambiguous_slash_date',
        reviewNote: 'Both day and month are 1-12; do not infer dd/MM vs MM/dd from this value.',
      };
    }
    if (first > 12 && second <= 12) {
      return {
        valueType: 'string',
        detectedFormat: 'dd/MM/yyyy',
        countKey: 'dd_mm_yyyy',
        reviewNote: '',
      };
    }
    if (second > 12 && first <= 12) {
      return {
        valueType: 'string',
        detectedFormat: 'MM/dd/yyyy',
        countKey: 'mm_dd_yyyy',
        reviewNote: '',
      };
    }
  }

  return {
    valueType: typeof value,
    detectedFormat: 'invalid',
    countKey: 'invalid',
    reviewNote: 'Could not classify current LEADS date value.',
  };
}

function parseLeadsDateAuditCanonicalDate_(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value.getTime()) && value.getFullYear() > 2000) return value;

  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoDate = new Date(raw);
  if (!isNaN(isoDate.getTime()) && isoDate.getFullYear() > 2000 && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return isoDate;
  }

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const hour = Number(slash[4] || 0);
    const minute = Number(slash[5] || 0);
    if (first > 12 && second <= 12) return new Date(year, second - 1, first, hour, minute);
    if (second > 12 && first <= 12) return new Date(year, first - 1, second, hour, minute);
    return null;
  }

  return parseLeadsViewDateTime_(value);
}

function getLeadsDateAuditProposedAction_(currentClass, canonical) {
  if (currentClass.detectedFormat === 'Date object' && canonical.parsedDate) return 'ALREADY_VALID';
  if (currentClass.detectedFormat === 'ambiguous slash date' && !canonical.parsedDate) return 'AMBIGUOUS';
  if (!canonical.parsedDate) return 'NO_CANONICAL_DATE';
  if (currentClass.detectedFormat === 'invalid') return 'INVALID';
  return 'SAFE_TO_NORMALIZE';
}

function formatLeadsDateAuditDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
}

function formatLeadsDateAuditDisplayValue_(date) {
  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone() || 'Asia/Bangkok',
    LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT
  );
}

function getOrCreateLeadsDateAuditSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEADS_DATE_AUDIT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LEADS_DATE_AUDIT_SHEET_NAME);
  try {
    if (sheet.isSheetHidden()) sheet.showSheet();
  } catch (err) {
    Logger.log('Unable to show LEADS_DATE_AUDIT sheet: ' + (err && err.message ? err.message : err));
  }
  return sheet;
}

function writeLeadsDateAuditReport_(sheet, auditAt, metadata, counts, rows, problem) {
  sheet.clearContents();
  const summaryRows = [
    ['LEADS Date Audit Report', ''],
    ['audit run ID', metadata.audit_run_id || ''],
    ['audit timestamp', auditAt],
    ['audit metadata timestamp', metadata.audit_timestamp || auditAt],
    ['spreadsheet ID', metadata.spreadsheet_id || ''],
    ['spreadsheet locale', metadata.spreadsheet_locale || ''],
    ['spreadsheet timezone', metadata.spreadsheet_timezone || ''],
    ['Apps Script timezone', metadata.apps_script_timezone || ''],
    ['LEADS last audited row', metadata.leads_last_audited_row || ''],
    ['audit fingerprint rows', metadata.audit_fingerprint_rows || ''],
    ['audit source fingerprint', metadata.audit_source_fingerprint || ''],
    ['classification counts', metadata.classification_counts_json || ''],
    ['target datetime display', metadata.target_datetime_format || LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT],
    ['target date display', metadata.target_date_format || LEADS_DATE_AUDIT_TARGET_DATE_FORMAT],
    ['audited sheet', metadata.audited_sheet || 'LEADS'],
    ['audited date columns', metadata.audited_date_columns || 'Facebook Created Time'],
    ['future sort plan', metadata.sort_plan || ''],
    ['status', problem ? 'ERROR' : 'OK'],
    ['problem', problem || ''],
    ['', ''],
    ['Summary', 'Count'],
    ['total rows checked', counts.total_rows_checked || 0],
    ['blank dates', counts.blank_dates || 0],
    ['safe Date objects', counts.safe_date_objects || 0],
    ['safe text conversions', counts.safe_text_conversions || 0],
    ['ambiguous values', counts.ambiguous_values || 0],
    ['invalid values', counts.invalid_values || 0],
    ['missing canonical source', counts.missing_canonical_source || 0],
    ['timezone mismatches', counts.timezone_mismatches || 0],
    ['display-only mismatches', counts.display_only_mismatches || 0],
    ['safe to apply yes', counts.safe_to_apply_yes || 0],
    ['safe to apply no', counts.safe_to_apply_no || 0],
  ];

  sheet.getRange(1, 1, summaryRows.length, 2).setValues(summaryRows);

  const headerRow = summaryRows.length + 2;
  const headers = [
    'audit timestamp',
    'LEADS row',
    'Lead ID',
    'customer name',
    'raw cell value',
    'displayed value',
    'underlying value type',
    'current number format',
    'canonical source sheet',
    'canonical raw value',
    'parsed canonical datetime',
    'classification',
    'proposed safe datetime',
    'proposed display value',
    'safe to apply',
    'reason',
  ];
  sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    sheet.getRange(headerRow + 1, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.setFrozenRows(headerRow);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(headerRow, 1, Math.max(rows.length + 1, 1), headers.length).createFilter();
}

function setupLeadsViewDataRangeUi_(sheet, startRow, rowCount) {
  if (!sheet || rowCount <= 0) return;

  const headerMap = getHeaderMap_(sheet);
  const statusColumn = headerMap.lead_status;
  if (statusColumn) {
    sheet.getRange(startRow, statusColumn, rowCount, 1).setDataValidation(getLeadMainStatusValidation_());
  }

  [headerMap.open_detail].filter(Boolean).forEach(column => {
    sheet.getRange(startRow, column, rowCount, 1).insertCheckboxes();
  });

  const dateColumn = headerMap.facebook_created_time;
  if (dateColumn) {
    sheet.getRange(startRow, dateColumn, rowCount, 1).setNumberFormat(LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT);
  }

  [headerMap.phone, headerMap.additional_phone].filter(Boolean).forEach(column => {
    sheet.getRange(startRow, column, rowCount, 1).setNumberFormat('@');
  });
}

function getExistingColumnValidation_(sheet, headerName) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return null;

  const headerMap = getHeaderMap_(sheet);
  const column = headerMap[normalizeHeaderName_(headerName)];
  if (!column) return null;

  const validations = sheet
    .getRange(DATA_START_ROW, column, sheet.getLastRow() - DATA_START_ROW + 1, 1)
    .getDataValidations();

  for (let i = 0; i < validations.length; i++) {
    if (validations[i][0]) return validations[i][0];
  }

  return null;
}

function setupLeadsViewExistingRowsUi_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return;

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  setupLeadsViewDataRangeUi_(sheet, DATA_START_ROW, rowCount);
  Logger.log('setupLeadsViewExistingRowsUi rows=' + rowCount);
}

function hideDeprecatedLeadsSalesNoteInputColumn_(sheet) {
  if (!sheet || sheet.getName() !== 'LEADS') return false;

  const headerMap = getHeaderMap_(sheet);
  const inputColumn = headerMap.sales_note_input || headerMap.sales_note;
  if (!inputColumn) return false;

  sheet.hideColumns(inputColumn);
  return true;
}

function setupLeadsViewStatusConditionalFormatting_(optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet) return;

  const headerMap = getHeaderMap_(sheet);
  const statusColumn = headerMap.lead_status;
  if (!statusColumn) return;

  const lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  const range = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, Math.min(sheet.getLastColumn(), LEADS_VIEW_HEADERS.length));
  const statusColumnLetter = columnToLetter_(statusColumn);
  const managedStatuses = ['Done', 'Cancelled'];
  const managedFormulas = managedStatuses.map(status => '=$' + statusColumnLetter + DATA_START_ROW + '="' + status + '"');
  const statusColors = {
    Done: '#d9ead3',
    Cancelled: '#f4cccc',
  };

  const existingRules = sheet.getConditionalFormatRules().filter(rule => {
    const condition = rule.getBooleanCondition();
    const values = condition ? condition.getCriteriaValues() : [];
    return !values.some(value => managedFormulas.indexOf(String(value)) !== -1);
  });

  const statusRules = managedStatuses.map(status => SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied('=$' + statusColumnLetter + DATA_START_ROW + '="' + status + '"')
    .setBackground(statusColors[status])
    .setRanges([range])
    .build());

  logCrmScriptFormatAudit_('CONDITIONAL_FORMAT_UPDATE', sheet, range.getA1Notation(), 'Updating managed Done/Cancelled conditional background rules on LEADS.');
  sheet.setConditionalFormatRules(existingRules.concat(statusRules));
}

function prepareLeadsViewRowForSync_(sheet, row) {
  // Normal LEADS sync must not clear user-managed validations.
}

function getLeadsViewManualDataByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach(row => {
    const leadId = String(row[leadIdColumn - 1] || '').trim();
    if (!leadId) return;

    const manual = {};
    Object.keys(LEADS_VIEW_MANUAL_FIELDS).forEach(field => {
      const column = headerMap[field] || (field === 'sales_note_input' ? headerMap.sales_note : 0);
      if (column) manual[field] = row[column - 1];
    });
    ['preferred_call_day', 'preferred_call_time', 'sales_owner'].forEach(field => {
      const column = headerMap[field];
      if (column) manual[field] = row[column - 1];
    });
    data[leadId] = manual;
  });

  return data;
}

function getLeadsViewMemoDataByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW || sheet.getLastColumn() < LEADS_VIEW_MEMO_START_COLUMN) return data;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return data;

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const memoColumnCount = sheet.getLastColumn() - LEADS_VIEW_MEMO_START_COLUMN + 1;
  const leadIds = sheet.getRange(DATA_START_ROW, leadIdColumn, rowCount, 1).getValues();
  const memoValues = sheet.getRange(DATA_START_ROW, LEADS_VIEW_MEMO_START_COLUMN, rowCount, memoColumnCount).getValues();

  leadIds.forEach((row, index) => {
    const leadId = String(row[0] || '').trim();
    if (!leadId) return;

    const values = memoValues[index];
    let lastNonEmpty = -1;
    values.forEach((value, valueIndex) => {
      if (String(value || '').trim()) lastNonEmpty = valueIndex;
    });
    if (lastNonEmpty >= 0) {
      data[leadId] = values.slice(0, lastNonEmpty + 1);
    }
  });

  return data;
}

function getLeadsViewHistoryDataByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return data;

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const lastColumn = sheet.getLastColumn();
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getValues();

  values.forEach(row => {
    const leadId = String(row[leadIdColumn - 1] || '').trim();
    if (!leadId) return;

    const existingHistory = String(headerMap.sales_note_history ? row[headerMap.sales_note_history - 1] || '' : '').trim();
    const history = {
      noteHistory: existingHistory,
      audioMemos: [],
    };
    const audioMemoKeys = {};

    if (lastColumn >= LEADS_VIEW_MEMO_START_COLUMN) {
      for (let column = LEADS_VIEW_MEMO_START_COLUMN; column <= lastColumn; column++) {
        const rawValue = String(row[column - 1] || '').trim();
        if (!rawValue) continue;

        if (isLeadNoteMemoValue_(rawValue)) {
          history.noteHistory = mergeSalesNoteHistoryText_(history.noteHistory, convertLeadMemoNoteToHistoryEntry_(rawValue));
          continue;
        }

        const key = normalizeLeadMemoText_(rawValue);
        if (key && !audioMemoKeys[key]) {
          audioMemoKeys[key] = true;
          history.audioMemos.push(rawValue);
        }
      }
    }

    data[leadId] = history;
  });

  return data;
}

function getAudioMemoDataFromHistory_(historyByLeadId) {
  const data = {};
  Object.keys(historyByLeadId || {}).forEach(leadId => {
    const audioMemos = historyByLeadId[leadId].audioMemos || [];
    if (audioMemos.length) data[leadId] = audioMemos;
  });
  return data;
}

function isLeadNoteMemoValue_(value) {
  return /^\s*\[note\]/i.test(String(value || ''));
}

function convertLeadMemoNoteToHistoryEntry_(value) {
  return String(value || '')
    .trim()
    .replace(/^\[Note\]\s*/i, '[');
}

function mergeSalesNoteHistoryText_(existingHistory, nextEntry) {
  const existing = String(existingHistory || '').trim();
  const next = String(nextEntry || '').trim();
  if (!next) return existing;

  const existingKeys = existing
    ? existing.split(/\n\s*\n|\n/).reduce((keys, item) => {
      const key = normalizeLeadMemoText_(item);
      if (key) keys[key] = true;
      return keys;
    }, {})
    : {};
  const nextKey = normalizeLeadMemoText_(next);
  if (nextKey && existingKeys[nextKey]) return existing;

  return existing ? existing + '\n\n' + next : next;
}

function restoreLeadsViewMemoData_(sheet, memoByLeadId) {
  const leadIds = Object.keys(memoByLeadId || {});
  if (!sheet || !leadIds.length) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || sheet.getLastRow() < DATA_START_ROW) return;

  const rowByLeadId = getLeadsViewRowMapByLeadId_(sheet);
  let maxMemoLength = 0;
  leadIds.forEach(leadId => {
    maxMemoLength = Math.max(maxMemoLength, (memoByLeadId[leadId] || []).length);
  });
  if (!maxMemoLength) return;

  const endColumn = LEADS_VIEW_MEMO_START_COLUMN + maxMemoLength - 1;
  ensureLeadMemoColumnCapacity_(sheet, endColumn);
  ensureLeadMemoHeaders_(sheet, LEADS_VIEW_MEMO_START_COLUMN, endColumn);

  leadIds.forEach(leadId => {
    const row = rowByLeadId[leadId];
    if (!row) return;

    const values = memoByLeadId[leadId] || [];
    if (!values.length) return;
    sheet.getRange(row, LEADS_VIEW_MEMO_START_COLUMN, 1, values.length).setValues([values]);
  });
}

function appendLeadMemoToLeadsView_(leadId, value, options) {
  const targetLeadId = String(leadId || '').trim();
  const rawValue = String(value || '').trim();
  if (!targetLeadId || !rawValue) return false;

  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return false;

  const rowByLeadId = getLeadsViewRowMapByLeadId_(sheet);
  const row = rowByLeadId[targetLeadId];
  if (!row) {
    Logger.log('appendLeadMemoToLeadsView skipped missing LEADS row for lead_id=' + targetLeadId);
    return false;
  }

  const config = options || {};
  const displayValue = config.preformatted
    ? rawValue
    : formatLeadMemoValue_(config.type || 'Memo', rawValue, config.timestamp);
  const targetColumn = findFirstEmptyLeadMemoColumn_(sheet, row, LEADS_VIEW_MEMO_START_COLUMN);

  ensureLeadMemoColumnCapacity_(sheet, targetColumn);
  ensureLeadMemoHeaders_(sheet, LEADS_VIEW_MEMO_START_COLUMN, targetColumn);
  sheet.getRange(row, targetColumn).setValue(displayValue);
  return true;
}

function appendSalesNoteHistoryToLeadsView_(sheet, row, note, timestamp) {
  const headerMap = getHeaderMap_(sheet);
  const historyColumn = headerMap.sales_note_history;
  if (!historyColumn) return false;

  const rawNote = String(note || '').trim();
  const entry = /^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]/.test(rawNote)
    ? rawNote
    : formatSalesNoteHistoryValue_(rawNote, timestamp);
  const cell = sheet.getRange(row, historyColumn);
  const existing = String(cell.getValue() || '').trim();
  cell.setValue(mergeSalesNoteHistoryText_(existing, entry));
  return true;
}

function formatSalesNoteHistoryValue_(note, timestamp) {
  const rawNote = String(note || '').trim();
  const memoTimestamp = timestamp instanceof Date && !isNaN(timestamp.getTime())
    ? timestamp
    : new Date();
  const formattedTimestamp = Utilities.formatDate(memoTimestamp, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
  return '[' + formattedTimestamp + '] ' + rawNote;
}

function formatLeadMemoValue_(type, value, timestamp) {
  const memoType = String(type || 'Memo').trim();
  const rawValue = String(value || '').trim();
  const memoTimestamp = timestamp instanceof Date && !isNaN(timestamp.getTime())
    ? timestamp
    : new Date();
  const formattedTimestamp = Utilities.formatDate(memoTimestamp, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
  return '[' + memoType + '] ' + formattedTimestamp + ' - ' + rawValue;
}

function findFirstEmptyLeadMemoColumn_(sheet, rowIndex, startCol) {
  const startColumn = Math.max(Number(startCol) || LEADS_VIEW_MEMO_START_COLUMN, LEADS_VIEW_MEMO_START_COLUMN);
  const maxColumns = sheet.getMaxColumns();
  if (startColumn > maxColumns) return startColumn;

  const values = sheet.getRange(rowIndex, startColumn, 1, maxColumns - startColumn + 1).getValues()[0];
  for (let index = 0; index < values.length; index++) {
    if (!String(values[index] || '').trim()) return startColumn + index;
  }
  return maxColumns + 1;
}

function ensureLeadMemoColumnCapacity_(sheet, targetCol) {
  const targetColumn = Number(targetCol) || LEADS_VIEW_MEMO_START_COLUMN;
  const maxColumns = sheet.getMaxColumns();
  if (targetColumn <= maxColumns) return;

  logCrmScriptFormatAudit_('SCRIPT_INSERT_COLUMNS', sheet, 'after max column ' + maxColumns, 'Expanding LEADS audio memo columns through column ' + targetColumn + '.');
  sheet.insertColumnsAfter(maxColumns, targetColumn - maxColumns);
}

function ensureLeadMemoHeaders_(sheet, fromCol, toCol) {
  const startColumn = Math.max(Number(fromCol) || LEADS_VIEW_MEMO_START_COLUMN, LEADS_VIEW_MEMO_START_COLUMN);
  const endColumn = Math.max(Number(toCol) || startColumn, startColumn);
  ensureLeadMemoColumnCapacity_(sheet, endColumn);

  const columnCount = endColumn - startColumn + 1;
  const headers = sheet.getRange(HEADER_ROW, startColumn, 1, columnCount).getValues()[0];
  const nextHeaders = headers.map((header, index) => {
    const current = String(header || '').trim();
    if (/^memo\s+\d+$/i.test(current)) {
      return 'Audio Memo ' + (startColumn + index - LEADS_VIEW_MEMO_START_COLUMN + 1);
    }
    return current || 'Audio Memo ' + (startColumn + index - LEADS_VIEW_MEMO_START_COLUMN + 1);
  });
  sheet.getRange(HEADER_ROW, startColumn, 1, columnCount).setValues([nextHeaders]);
}

function getLeadsViewRowMapByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return data;

  const values = sheet.getRange(DATA_START_ROW, leadIdColumn, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
  values.forEach((row, index) => {
    const leadId = String(row[0] || '').trim();
    if (leadId && !data[leadId]) data[leadId] = DATA_START_ROW + index;
  });

  return data;
}

function getOrCreateLeadsViewRowByLeadId_(sheet, leadId, optionalRowByLeadId) {
  const target = String(leadId || '').trim();
  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!target || !leadIdColumn) return Math.max(sheet.getLastRow() + 1, DATA_START_ROW);

  const rowByLeadId = optionalRowByLeadId || getLeadsViewRowMapByLeadId_(sheet);
  if (rowByLeadId[target]) return rowByLeadId[target];

  const row = Math.max(sheet.getLastRow() + 1, DATA_START_ROW);
  if (optionalRowByLeadId) {
    optionalRowByLeadId[target] = row;
  }

  return row;
}

function ensureLeadsViewStatusDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet || sheet.getName() !== 'LEADS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const statusColumn = headerMap.lead_status;
  if (!leadIdColumn || !statusColumn) return false;

  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const cell = sheet.getRange(row, statusColumn);
  if (!leadId) {
    if (!String(cell.getValue() || '').trim() && cell.getDataValidation()) {
      cell.clearDataValidations();
      return true;
    }
    return false;
  }

  if (!isLeadStatusDropdownCell_(cell)) {
    cell.setDataValidation(getLeadMainStatusValidation_());
    return true;
  }
  return false;
}

function ensureLeadsViewSalesOwnerDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet || sheet.getName() !== 'LEADS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const salesOwnerColumn = headerMap.sales_owner;
  if (!leadIdColumn || !salesOwnerColumn) return false;

  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const cell = sheet.getRange(row, salesOwnerColumn);
  const values = getSettingsValuesForHeaders_(LEAD_MAIN_SALES_OWNER_SETTING_HEADERS);
  if (!values.length) return false;

  if (leadId) {
    if (!isValueInListDropdownCell_(cell, values)) {
      cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
      return true;
    }
    return false;
  }

  if (!String(cell.getValue() || '').trim() && cell.getDataValidation()) {
    cell.clearDataValidations();
    return true;
  }

  return false;
}

function ensureLeadsViewCheckboxesForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet || sheet.getName() !== 'LEADS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const leadId = leadIdColumn ? String(sheet.getRange(row, leadIdColumn).getValue() || '').trim() : '';
  const columns = [headerMap.open_detail].filter(Boolean);
  let changed = false;

  columns.forEach(column => {
    const cell = sheet.getRange(row, column);
    const value = String(cell.getValue() || '').trim().toUpperCase();
    if (leadId) {
      if (!isCheckboxCell_(cell)) {
        cell.insertCheckboxes();
        changed = true;
      }
      if (value !== 'TRUE') {
        cell.setValue(false);
      }
      return;
    }

    if (String(cell.getValue() || '').trim() || isCheckboxCell_(cell)) {
      cell.clearContent();
      cell.clearDataValidations();
      changed = true;
    }
  });

  return changed;
}
