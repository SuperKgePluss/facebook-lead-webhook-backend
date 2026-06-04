// Sales-facing LEADS tab. LEADS_MAIN remains the backend/master sheet.
const LEADS_VIEW_REFRESH_CURSOR_KEY = 'LEADS_VIEW_REFRESH_NEXT_ROW';
const LEADS_VIEW_REFRESH_BATCH_SIZE = 70;
const LEADS_VIEW_SCHEDULED_CURSOR_KEY = 'LEADS_VIEW_SCHEDULED_NEXT_ROW';
const LEADS_VIEW_SCHEDULED_BATCH_SIZE = 20;
const LEADS_VIEW_MEMO_START_COLUMN = 15;
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
  'Sales Note',
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
  'โน้ตฝ่ายขาย',
  'จำนวนติดตาม',
  'ลิงก์ไฟล์เสียงล่าสุด',
  'ชื่อไว้ค้นหา Facebook',
  'เปิดรายละเอียด',
];
const LEADS_VIEW_MANUAL_FIELDS = {
  additional_phone: true,
  sales_note: true,
  follow_up_count: true,
  open_detail: true,
};

function setupLeadsViewUi() {
  const sheet = getOrCreateLeadsViewSheet_();
  setLeadsViewHeaders_(sheet);
  setupLeadsViewExistingRowsUi_(sheet);
  setupLeadsViewStatusConditionalFormatting_(sheet);
  resetLeadsViewRefreshCursor();
  Logger.log('setupLeadsViewUi completed lightweight setup. Run setupCrmUiBatch repeatedly to sync LEADS rows.');
}

function refreshLeadsViewLight() {
  const properties = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = getOrCreateLeadsViewSheet_();
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) return { task_completed: true };

  setLeadsViewHeaders_(leadsSheet);

  const leadMainLastRow = leadMainSheet.getLastRow();
  const savedCursor = Number(properties.getProperty(LEADS_VIEW_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= leadMainLastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + LEADS_VIEW_REFRESH_BATCH_SIZE - 1, leadMainLastRow);
  const manualByLeadId = getLeadsViewManualDataByLeadId_(leadsSheet);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    const lead = getRowObject_(leadMainSheet, row);
    const leadId = String(lead.lead_id || '').trim();
    if (!leadId) continue;

    const targetRow = getOrCreateLeadsViewRowByLeadId_(leadsSheet, leadId);
    const manual = manualByLeadId[leadId] || {};
    setRowObjectValues_(leadsSheet, targetRow, buildLeadsViewObject_(lead, manual));
    if (setupLeadsViewRowUi(targetRow, leadsSheet)) fixed++;
  }

  const nextCursor = endRow + 1 > leadMainLastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEADS_VIEW_REFRESH_CURSOR_KEY, String(nextCursor));

  Logger.log('refreshLeadsViewLight batch_size=' + LEADS_VIEW_REFRESH_BATCH_SIZE + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + leadMainLastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
  return {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    fixed: fixed,
    task_completed: nextCursor === DATA_START_ROW,
  };
}

function resetLeadsViewRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(LEADS_VIEW_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('LEADS view refresh cursor reset to ' + DATA_START_ROW);
}

function syncLeadsViewNow() {
  setupLeadsViewUi();
  const result = syncRecentLeadsViewRows_(200);
  SpreadsheetApp.getActive().toast('Synced recent LEADS rows: ' + result.synced, 'Sync LEADS View', 5);
  return result;
}

function syncLeadsViewScheduled() {
  return syncLeadsViewCursorBatch_(LEADS_VIEW_SCHEDULED_BATCH_SIZE);
}

function repairLeadsViewFromLeadMain() {
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = getOrCreateLeadsViewSheet_();
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) {
    writeLeadsViewHeadersOnly_(leadsSheet);
    setupLeadsViewExistingRowsUi_(leadsSheet);
    return {
      rebuilt: 0,
    };
  }

  const safeManualByLeadId = getSafeLeadsViewManualDataByLeadId_(leadsSheet);
  const memoByLeadId = getLeadsViewMemoDataByLeadId_(leadsSheet);
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
    const facebookCreatedTime = resolveLeadsViewFacebookCreatedTime_(lead, detailFacebookTimeByLeadId[leadId]);
    const object = sanitizeLeadsViewSyncObject_(buildLeadsViewObject_(Object.assign({}, lead, {
      facebook_created_time: facebookCreatedTime,
    }), manual));
    object.latest_audio_link = latestAudioUrlByLeadId[leadId] || '';
    rebuiltRows.push(buildLeadsViewRowValues_(object));
  });

  clearLeadsViewData_(leadsSheet);
  writeLeadsViewHeadersOnly_(leadsSheet);
  if (rebuiltRows.length) {
    leadsSheet.getRange(DATA_START_ROW, 1, rebuiltRows.length, LEADS_VIEW_HEADERS.length).setValues(rebuiltRows);
    setupLeadsViewDataRangeUi_(leadsSheet, DATA_START_ROW, rebuiltRows.length);
    restoreLeadsViewMemoData_(leadsSheet, memoByLeadId);
  }
  setupLeadsViewStatusConditionalFormatting_(leadsSheet);
  resetLeadsViewRefreshCursor();
  PropertiesService
    .getScriptProperties()
    .setProperty(LEADS_VIEW_SCHEDULED_CURSOR_KEY, String(DATA_START_ROW));

  const result = {
    rebuilt: rebuiltRows.length,
  };
  Logger.log('repairLeadsViewFromLeadMain rebuilt=' + rebuiltRows.length);
  SpreadsheetApp.getActive().toast('Rebuilt LEADS rows: ' + rebuiltRows.length, 'Repair LEADS View', 5);
  return result;
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
  const rowLimit = Math.max(1, Number(limit) || 200);
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = getOrCreateLeadsViewSheet_();
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) {
    return {
      checked: 0,
      synced: 0,
    };
  }

  setLeadsViewHeaders_(leadsSheet);

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
  const batchSize = Math.max(1, Number(limit) || LEADS_VIEW_SCHEDULED_BATCH_SIZE);
  const properties = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = getOrCreateLeadsViewSheet_();
  if (!leadMainSheet || leadMainSheet.getLastRow() < DATA_START_ROW) {
    return {
      checked: 0,
      synced: 0,
      failed: 0,
      task_completed: true,
    };
  }

  setLeadsViewHeaders_(leadsSheet);

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
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = getOrCreateLeadsViewSheet_();
  if (!leadMainSheet || row < DATA_START_ROW || row > leadMainSheet.getLastRow()) return false;

  setLeadsViewHeaders_(leadsSheet);
  const manualByLeadId = getLeadsViewManualDataByLeadId_(leadsSheet);
  const rowByLeadId = getLeadsViewRowMapByLeadId_(leadsSheet);
  return syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, rowByLeadId);
}

function syncLeadMainRowToLeadsView_(leadMainSheet, row, leadsSheet, manualByLeadId, optionalRowByLeadId) {
  const lead = getRowObject_(leadMainSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return false;

  const rowByLeadId = optionalRowByLeadId || getLeadsViewRowMapByLeadId_(leadsSheet);
  const targetRow = getOrCreateLeadsViewRowByLeadId_(leadsSheet, leadId, rowByLeadId);
  const manual = manualByLeadId[leadId] || {};
  const object = sanitizeLeadsViewSyncObject_(buildLeadsViewObject_(lead, manual));
  prepareLeadsViewRowForSync_(leadsSheet, targetRow);
  setRowObjectValues_(leadsSheet, targetRow, object);
  setupLeadsViewRowUi(targetRow, leadsSheet);
  return true;
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
    if (dateColumn) sheet.getRange(row, dateColumn).setNumberFormat('[$-en-US]MM/dd/yyyy HH:mm');
    [headerMap.phone, headerMap.additional_phone].filter(Boolean).forEach(column => {
      sheet.getRange(row, column).setNumberFormat('@');
    });
  }

  return changed;
}

function handleLeadsViewEdit_(e, sheet, row) {
  if (!e || !e.range || !sheet || sheet.getName() !== 'LEADS' || row < DATA_START_ROW) return;

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

  if (editedHeader === 'sales_note') {
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
    syncLeadsViewEditableFieldToLeadMain_(sheet, row, editedHeader);
  }
}

function handleLeadsViewSalesNoteEdit_(e, sheet, row) {
  const note = String(e.value || '').trim();
  if (!note) return;

  const lead = getRowObject_(sheet, row);
  const leadId = String(lead.lead_id || '').trim();
  const headerMap = getHeaderMap_(sheet);
  if (!leadId || !headerMap.sales_note) return;

  const dedupe = claimLeadsViewSalesNoteEdit_(leadId, note);
  if (!dedupe.claimed) {
    sheet.getRange(row, headerMap.sales_note).clearContent();
    Logger.log('LEADS Sales Note skipped duplicate lead_id=' + leadId + ' reason=' + dedupe.reason);
    return;
  }

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'LEADS',
    action_type: 'Sales Note',
    note: note,
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });

  appendLeadMemoToLeadsView_(leadId, note, {
    type: 'Note',
    timestamp: new Date(),
  });
  sheet.getRange(row, headerMap.sales_note).clearContent();
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

function setLeadsViewHeaders_(sheet) {
  if (sheet.getMaxColumns() < LEADS_VIEW_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEADS_VIEW_HEADERS.length - sheet.getMaxColumns());
  }
  if (!isLeadsViewHeaderOrderCurrent_(sheet)) {
    preserveLeadsViewRowsByHeader_(sheet);
  }
  writeLeadsViewHeadersOnly_(sheet);
}

function writeLeadsViewHeadersOnly_(sheet) {
  if (sheet.getMaxColumns() < LEADS_VIEW_HEADERS.length) {
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
    const index = existingMap[normalizeHeaderName_(header)];
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
    sales_note: manual.sales_note || '',
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

    const salesNote = String(getLeadsViewRowValue_(row, headerMap, 'sales_note') || '').trim();
    if (salesNote) manual.sales_note = salesNote;

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
    sheet.getRange(startRow, dateColumn, rowCount, 1).setNumberFormat('[$-en-US]MM/dd/yyyy HH:mm');
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
      const column = headerMap[field];
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
  const type = String(config.type || 'Memo').trim();
  const timestamp = config.timestamp instanceof Date && !isNaN(config.timestamp.getTime())
    ? config.timestamp
    : new Date();
  const formattedTimestamp = Utilities.formatDate(timestamp, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
  const displayValue = '[' + type + '] ' + formattedTimestamp + ' - ' + rawValue;
  const targetColumn = findFirstEmptyLeadMemoColumn_(sheet, row, LEADS_VIEW_MEMO_START_COLUMN);

  ensureLeadMemoColumnCapacity_(sheet, targetColumn);
  ensureLeadMemoHeaders_(sheet, LEADS_VIEW_MEMO_START_COLUMN, targetColumn);
  sheet.getRange(row, targetColumn).setValue(displayValue);
  return true;
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
    return current || 'Memo ' + (startColumn + index - LEADS_VIEW_MEMO_START_COLUMN + 1);
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
