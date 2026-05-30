// Sales-facing LEADS tab. LEADS_MAIN remains the backend/master sheet.
const LEADS_VIEW_REFRESH_CURSOR_KEY = 'LEADS_VIEW_REFRESH_NEXT_ROW';
const LEADS_VIEW_REFRESH_BATCH_SIZE = 70;
const LEADS_VIEW_SCHEDULED_CURSOR_KEY = 'LEADS_VIEW_SCHEDULED_NEXT_ROW';
const LEADS_VIEW_SCHEDULED_BATCH_SIZE = 20;
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
  'Follow-up Count',
  'Fetch Audio',
  'Audio Save Status',
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
  'จำนวนติดตาม',
  'ดึงไฟล์เสียง',
  'สถานะไฟล์เสียง',
  'ชื่อไว้ค้นหา Facebook',
  'เปิดรายละเอียด',
];
const LEADS_VIEW_MANUAL_FIELDS = {
  additional_phone: true,
  follow_up_count: true,
  fetch_audio: true,
  audio_save_status: true,
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
    return {
      rebuilt: 0,
    };
  }

  const safeManualByLeadId = getSafeLeadsViewManualDataByLeadId_(leadsSheet);
  const detailFacebookTimeByLeadId = getLeadDetailsFacebookCreatedTimeByLeadId_();
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
    rebuiltRows.push(buildLeadsViewRowValues_(object));
  });

  clearLeadsViewData_(leadsSheet);
  writeLeadsViewHeadersOnly_(leadsSheet);
  if (rebuiltRows.length) {
    leadsSheet.getRange(DATA_START_ROW, 1, rebuiltRows.length, LEADS_VIEW_HEADERS.length).setValues(rebuiltRows);
    setupLeadsViewDataRangeUi_(leadsSheet, DATA_START_ROW, rebuiltRows.length);
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
  if (ensureLeadsViewSalesOwnerDropdownForRow(row, sheet)) changed = true;
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

  if (editedHeader === 'fetch_audio') {
    handleLeadsViewFetchAudioEdit_(e, sheet, row);
    return;
  }

  if (editedHeader === 'lead_status') {
    handleLeadsViewLeadStatusEdit_(e, sheet, row);
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

function handleLeadsViewFetchAudioEdit_(e, sheet, row) {
  if (String(e.value || '').toUpperCase() !== 'TRUE') return;

  const headerMap = getHeaderMap_(sheet);
  const fetchAudioColumn = headerMap.fetch_audio;
  if (fetchAudioColumn) sheet.getRange(row, fetchAudioColumn).setValue(false);

  const lead = getRowObject_(sheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) {
    writeLeadsViewAudioStatus_(sheet, row, 'à¹„à¸¡à¹ˆà¸žà¸šà¸£à¸«à¸±à¸ªà¸¥à¸¹à¸à¸„à¹‰à¸²');
    return;
  }

  const audioMatch = findLatestLeadAudioFileByPhoneOrName_(lead);
  if (!audioMatch.file) {
    writeLeadsViewAudioStatus_(sheet, row, 'à¹„à¸¡à¹ˆà¸žà¸šà¹„à¸Ÿà¸¥à¹Œà¹€à¸ªà¸µà¸¢à¸‡à¸•à¸²à¸¡à¸£à¸¹à¸›à¹à¸šà¸šà¸—à¸µà¹ˆà¸à¸³à¸«à¸™à¸”');
    return;
  }

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'LEADS',
    action_type: 'Fetch Audio',
    note: 'Audio fetched from LEADS tab',
    audio_url: audioMatch.fileUrl,
    audio_file_name: audioMatch.fileName,
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });

  writeLeadsViewAudioStatus_(sheet, row, 'à¸šà¸±à¸™à¸—à¸¶à¸à¹„à¸Ÿà¸¥à¹Œà¹€à¸ªà¸µà¸¢à¸‡à¹à¸¥à¹‰à¸§: ' + audioMatch.fileName);
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

function writeLeadsViewAudioStatus_(sheet, row, message) {
  setRowObjectValues_(sheet, row, {
    audio_save_status: message,
  });
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

  sheet
    .getRange(DATA_START_ROW, 1, rowCount, Math.max(sheet.getLastColumn(), LEADS_VIEW_HEADERS.length))
    .clearContent()
    .clearDataValidations();
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
    follow_up_count: manual.follow_up_count || '',
    fetch_audio: false,
    audio_save_status: manual.audio_save_status || '',
    facebook_search_name: customerName,
    open_detail: false,
  };
}

function sanitizeLeadsViewSyncObject_(object) {
  const sanitized = Object.assign({}, object);
  const status = String(sanitized.lead_status || '').trim();
  sanitized.lead_status = LEAD_MAIN_STATUS_VALUES.indexOf(status) !== -1 ? status : 'New';

  const salesOwner = String(sanitized.sales_owner || '').trim();
  const allowedSalesOwners = getSettingsValuesForHeaders_(LEAD_MAIN_SALES_OWNER_SETTING_HEADERS);
  if (salesOwner && allowedSalesOwners.length && allowedSalesOwners.indexOf(salesOwner) === -1) {
    Logger.log('LEADS sync skipped invalid Sales Owner: ' + salesOwner);
    sanitized.sales_owner = '';
  }

  return sanitized;
}

function getSafeLeadsViewManualDataByLeadId_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return data;

  const allowedSalesOwners = getSettingsValuesForHeaders_(LEAD_MAIN_SALES_OWNER_SETTING_HEADERS);
  const allowedCallDays = getSettingsValuesForHeaders_(['Preferred Call Day', 'Preferred Call Days', 'preferred_call_day']);
  const allowedCallTimes = getSettingsValuesForHeaders_(['Preferred Call Time', 'Preferred Call Times', 'preferred_call_time']);
  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();

  values.forEach(row => {
    const leadId = String(row[leadIdColumn - 1] || '').trim();
    if (!leadId) return;

    const manual = {};
    const additionalPhone = getLeadsViewRowValue_(row, headerMap, 'additional_phone');
    if (isSafeAdditionalPhone_(additionalPhone)) manual.additional_phone = String(additionalPhone).trim();

    const followUpCount = getLeadsViewRowValue_(row, headerMap, 'follow_up_count');
    if (isSafeFollowUpCount_(followUpCount)) manual.follow_up_count = followUpCount;

    const audioSaveStatus = getLeadsViewRowValue_(row, headerMap, 'audio_save_status');
    if (String(audioSaveStatus || '').trim()) manual.audio_save_status = audioSaveStatus;

    const salesOwner = String(getLeadsViewRowValue_(row, headerMap, 'sales_owner') || '').trim();
    if (salesOwner && allowedSalesOwners.indexOf(salesOwner) !== -1) manual.sales_owner = salesOwner;

    const preferredCallDay = String(getLeadsViewRowValue_(row, headerMap, 'preferred_call_day') || '').trim();
    if (preferredCallDay && (!allowedCallDays.length || allowedCallDays.indexOf(preferredCallDay) !== -1)) {
      manual.preferred_call_day = preferredCallDay;
    }

    const preferredCallTime = String(getLeadsViewRowValue_(row, headerMap, 'preferred_call_time') || '').trim();
    if (preferredCallTime && (!allowedCallTimes.length || allowedCallTimes.indexOf(preferredCallTime) !== -1)) {
      manual.preferred_call_time = preferredCallTime;
    }

    data[leadId] = manual;
  });

  return data;
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

  const salesOwnerColumn = headerMap.sales_owner;
  const salesOwners = getSettingsValuesForHeaders_(LEAD_MAIN_SALES_OWNER_SETTING_HEADERS);
  if (salesOwnerColumn && salesOwners.length) {
    sheet
      .getRange(startRow, salesOwnerColumn, rowCount, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(salesOwners, true).setAllowInvalid(true).build());
  }

  [headerMap.fetch_audio, headerMap.open_detail].filter(Boolean).forEach(column => {
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
  const headerMap = getHeaderMap_(sheet);
  [headerMap.lead_status, headerMap.sales_owner].filter(Boolean).forEach(column => {
    sheet.getRange(row, column).clearDataValidations();
  });
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
  const columns = [headerMap.fetch_audio, headerMap.open_detail].filter(Boolean);
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
