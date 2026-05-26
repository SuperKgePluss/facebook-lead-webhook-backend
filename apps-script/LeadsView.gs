// Sales-facing LEADS tab. LEADS_MAIN remains the backend/master sheet.
const LEADS_VIEW_REFRESH_CURSOR_KEY = 'LEADS_VIEW_REFRESH_NEXT_ROW';
const LEADS_VIEW_REFRESH_BATCH_SIZE = 70;
const LEADS_VIEW_HEADERS = [
  'Lead ID',
  'Customer Name',
  'Phone',
  'Additional Phone',
  'Facebook Created Time',
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
  'ชื่อลูกค้า',
  'เบอร์โทร',
  'เบอร์โทรเพิ่มเติม',
  'เวลาสร้างลีดจาก Facebook',
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

  if (editedHeader === 'preferred_call_day' || editedHeader === 'preferred_call_time' || editedHeader === 'sales_owner') {
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
    SpreadsheetApp.getActive().toast('ไม่พบรายละเอียดลูกค้า', 'Open Detail', 5);
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
    writeLeadsViewAudioStatus_(sheet, row, 'ไม่พบรหัสลูกค้า');
    return;
  }

  const audioMatch = findLatestLeadAudioFileByPhoneOrName_(lead);
  if (!audioMatch.file) {
    writeLeadsViewAudioStatus_(sheet, row, 'ไม่พบไฟล์เสียงตามรูปแบบที่กำหนด');
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

  writeLeadsViewAudioStatus_(sheet, row, 'บันทึกไฟล์เสียงแล้ว: ' + audioMatch.fileName);
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
}

function syncLeadsViewEditableFieldToLeadMain_(sheet, row, fieldName) {
  const lead = getRowObject_(sheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return;

  const leadMain = getLeadMainObjectByLeadId_(leadId);
  if (!leadMain || !leadMain.row) return;

  const update = {};
  update[fieldName] = lead[fieldName] || '';
  setRowObjectValues_(SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN'), leadMain.row, update);
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
  sheet.getRange(HEADER_ROW, 1, 1, LEADS_VIEW_HEADERS.length).setValues([LEADS_VIEW_HEADERS]);
  sheet.getRange(HEADER_ROW + 1, 1, 1, LEADS_VIEW_THAI_LABELS.length).setValues([LEADS_VIEW_THAI_LABELS]);
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

function getOrCreateLeadsViewRowByLeadId_(sheet, leadId) {
  const target = String(leadId || '').trim();
  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!target || !leadIdColumn) return Math.max(sheet.getLastRow() + 1, DATA_START_ROW);

  if (sheet.getLastRow() >= DATA_START_ROW) {
    const values = sheet.getRange(DATA_START_ROW, leadIdColumn, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === target) return DATA_START_ROW + i;
    }
  }

  return Math.max(sheet.getLastRow() + 1, DATA_START_ROW);
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
