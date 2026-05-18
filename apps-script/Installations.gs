// INSTALLATIONS sheet setup, row-level status dropdowns, and Lead Status propagation.
const INSTALLATION_STATUS_VALUES = ['In Progress', 'Installed', 'Cancelled'];
const INSTALLATION_STATUS_REFRESH_CURSOR_KEY = 'INSTALLATION_STATUS_REFRESH_NEXT_ROW';
const INSTALLATION_SAVE_LOCATION_REFRESH_CURSOR_KEY = 'INSTALLATION_SAVE_LOCATION_REFRESH_NEXT_ROW';
const INSTALLATION_STATUS_REFRESH_BATCH_SIZE = 100;
const INSTALLATION_SAVE_LOCATION_REFRESH_BATCH_SIZE = 100;
const LOCATION_ROOT_FOLDER_ID = 'PASTE_FOLDER_ID_HERE';
const LOCATION_MAX_FOLDERS_SCANNED = 50;
const LOCATION_MAX_FILES_SCANNED = 500;
const INSTALLATIONS_FINAL_HEADERS = [
  'Install ID',
  'Lead ID',
  'Phone',
  'Save Location',
  'Install Status',
  'Preferred Install Date',
  'Preferred Install Time',
  'Location',
  'Install Save Status',
  'Machine Count',
  'Install Contact Count',
  'Note',
];
const INSTALLATIONS_FINAL_THAI_LABELS = [
  'รหัสติดตั้ง',
  'รหัสลูกค้า',
  'เบอร์โทร',
  'บันทึกสถานที่',
  'สถานะติดตั้ง',
  'วันที่สะดวกติดตั้ง',
  'ช่วงเวลาที่สะดวก',
  'สถานที่ติดตั้ง',
  'สถานะการบันทึก',
  'จำนวนเครื่องที่ติดตั้ง',
  'จำนวนครั้งที่ติดต่อ',
  'หมายเหตุ',
];

function normalizeInstallationStatusForUi_(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();

  if (lower === 'installed') return 'Installed';
  if (lower === 'cancelled' || lower === 'canceled') return 'Cancelled';
  if (lower.indexOf('cancel') !== -1) return 'Cancelled';
  if (lower.indexOf('install') !== -1 && lower.indexOf('progress') === -1) return 'Installed';

  return 'In Progress';
}

function setupInstallationsUi() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const dataRowCount = Math.max(lastRow - DATA_START_ROW + 1, 0);
  const dataValues = dataRowCount
    ? sheet.getRange(DATA_START_ROW, 1, dataRowCount, lastColumn).getValues()
    : [];

  const migratedRows = dataValues.map(row => {
    const object = headers.reduce((item, header, index) => {
      const key = normalizeHeaderName_(header);
      if (key) item[key] = row[index];
      return item;
    }, {});

    const note = [
      object.note,
      object.product_model ? 'Product Model: ' + object.product_model : '',
      object.zone ? 'Zone: ' + object.zone : '',
      object.technician ? 'Technician: ' + object.technician : '',
      object.cancel_reason ? 'Cancel Reason: ' + object.cancel_reason : '',
    ].filter(Boolean).join('\n');
    const leadId = String(object.lead_id || '').trim();
    const phone = String(object.phone || '').trim() || getLeadPhoneByLeadId_(leadId);

    return [
      object.install_id || '',
      leadId,
      phone,
      String(object.save_location || '').toUpperCase() === 'TRUE',
      (object.install_status || object.installation_status)
        ? normalizeInstallationStatusForUi_(object.install_status || object.installation_status)
        : '',
      object.preferred_install_date || object.install_date || '',
      object.preferred_install_time || object.install_time || object.time_slot || '',
      object.location || object.address || object.zone || '',
      object.install_save_status || object.location_save_status || '',
      object.machine_count || object.quantity || object.device_count || '',
      object.install_contact_count || '',
      note,
    ];
  });

  if (sheet.getMaxColumns() < INSTALLATIONS_FINAL_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), INSTALLATIONS_FINAL_HEADERS.length - sheet.getMaxColumns());
  }

  sheet.getRange(HEADER_ROW, 1, 1, INSTALLATIONS_FINAL_HEADERS.length).setValues([INSTALLATIONS_FINAL_HEADERS]);

  sheet.getRange(HEADER_ROW + 1, 1, 1, INSTALLATIONS_FINAL_THAI_LABELS.length).setValues([INSTALLATIONS_FINAL_THAI_LABELS]);
  if (migratedRows.length) {
    sheet.getRange(DATA_START_ROW, 1, migratedRows.length, INSTALLATIONS_FINAL_HEADERS.length).setValues(migratedRows);
  }

  if (sheet.getLastColumn() > INSTALLATIONS_FINAL_HEADERS.length) {
    sheet.deleteColumns(INSTALLATIONS_FINAL_HEADERS.length + 1, sheet.getLastColumn() - INSTALLATIONS_FINAL_HEADERS.length);
  }

  const formatRows = Math.max(sheet.getMaxRows() - DATA_START_ROW + 1, 1);
  sheet.getRange(DATA_START_ROW, 6, formatRows, 1).setNumberFormat('dd/MM/yyyy');
  sheet.getRange(DATA_START_ROW, 7, formatRows, 1).setNumberFormat('@');

  resetInstallationStatusDropdownRefreshCursor();
  resetInstallationSaveLocationCheckboxRefreshCursor();
  setupInstallationsStatusConditionalFormatting_();
  Logger.log('setupInstallationsUi completed lightweight setup. Run setupCrmUiBatch repeatedly to repair row-level dropdowns and checkboxes.');
}

function getInstallationStatusValidation_() {
  return SpreadsheetApp
    .newDataValidation()
    .requireValueInList(INSTALLATION_STATUS_VALUES, true)
    .setAllowInvalid(false)
    .build();
}

function isInstallationStatusDropdownCell_(cell) {
  const validation = cell.getDataValidation();
  if (!validation || validation.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return false;
  }

  const criteriaValues = validation.getCriteriaValues();
  const values = criteriaValues && criteriaValues[0] ? criteriaValues[0] : [];
  return values.join('|') === INSTALLATION_STATUS_VALUES.join('|');
}

function ensureInstallationStatusDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet || sheet.getName() !== 'INSTALLATIONS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const installIdColumn = headerMap.install_id;
  const leadIdColumn = headerMap.lead_id;
  const statusColumn = headerMap.install_status;
  if (!installIdColumn || !leadIdColumn || !statusColumn) return false;

  const installId = String(sheet.getRange(row, installIdColumn).getValue() || '').trim();
  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const statusCell = sheet.getRange(row, statusColumn);
  const currentStatus = String(statusCell.getValue() || '').trim();
  let changed = false;

  if (installId && leadId) {
    if (!isInstallationStatusDropdownCell_(statusCell)) {
      statusCell.setDataValidation(getInstallationStatusValidation_());
      changed = true;
    }
    const normalizedStatus = normalizeInstallationStatusForUi_(currentStatus);
    if (!currentStatus || currentStatus !== normalizedStatus) {
      statusCell.setValue(normalizedStatus);
      changed = true;
    }
    return changed;
  }

  if (!installId && !leadId && !currentStatus && statusCell.getDataValidation()) {
    statusCell.clearDataValidations();
    changed = true;
  }

  return changed;
}

function ensureInstallationSaveLocationCheckboxForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet || sheet.getName() !== 'INSTALLATIONS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const installIdColumn = headerMap.install_id;
  const leadIdColumn = headerMap.lead_id;
  const saveLocationColumn = headerMap.save_location;
  if (!installIdColumn || !leadIdColumn || !saveLocationColumn) return false;

  const installId = String(sheet.getRange(row, installIdColumn).getValue() || '').trim();
  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const cell = sheet.getRange(row, saveLocationColumn);
  let changed = false;

  if (installId && leadId) {
    if (!isCheckboxCell_(cell)) {
      cell.insertCheckboxes();
      changed = true;
    }
    return changed;
  }

  if (!installId && !leadId && (String(cell.getValue() || '').trim() || isCheckboxCell_(cell))) {
    cell.clearContent();
    cell.clearDataValidations();
    changed = true;
  }

  return changed;
}

function refreshInstallationStatusDropdownsLight() {
  const properties = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.install_id || !headerMap.lead_id || !headerMap.install_status) return;

  const savedCursor = Number(properties.getProperty(INSTALLATION_STATUS_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + INSTALLATION_STATUS_REFRESH_BATCH_SIZE - 1, lastRow);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    if (ensureInstallationStatusDropdownForRow(row, sheet)) fixed++;
    if (ensureInstallationSaveLocationCheckboxForRow(row, sheet)) fixed++;
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(INSTALLATION_STATUS_REFRESH_CURSOR_KEY, String(nextCursor));
  setupInstallationsStatusConditionalFormatting_();

  Logger.log('refreshInstallationStatusDropdownsLight startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
}

function refreshInstallationStatusDropdownsAll() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.install_id || !headerMap.lead_id || !headerMap.install_status) return;

  let checked = 0;
  let fixed = 0;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    checked++;
    if (ensureInstallationStatusDropdownForRow(row, sheet)) fixed++;
    if (ensureInstallationSaveLocationCheckboxForRow(row, sheet)) fixed++;
  }

  setupInstallationsStatusConditionalFormatting_();
  Logger.log('refreshInstallationStatusDropdownsAll checked=' + checked + ' fixed=' + fixed);
}

function resetInstallationStatusDropdownRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(INSTALLATION_STATUS_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('INSTALLATIONS status dropdown refresh cursor reset to ' + DATA_START_ROW);
}

function refreshInstallationSaveLocationCheckboxes() {
  const properties = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.install_id || !headerMap.lead_id || !headerMap.save_location) return;

  const savedCursor = Number(properties.getProperty(INSTALLATION_SAVE_LOCATION_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + INSTALLATION_SAVE_LOCATION_REFRESH_BATCH_SIZE - 1, lastRow);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    if (ensureInstallationSaveLocationCheckboxForRow(row, sheet)) fixed++;
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(INSTALLATION_SAVE_LOCATION_REFRESH_CURSOR_KEY, String(nextCursor));

  Logger.log('refreshInstallationSaveLocationCheckboxes startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
}

function refreshInstallationSaveLocationCheckboxesAll() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.install_id || !headerMap.lead_id || !headerMap.save_location) return;

  let checked = 0;
  let fixed = 0;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    checked++;
    if (ensureInstallationSaveLocationCheckboxForRow(row, sheet)) fixed++;
  }

  Logger.log('refreshInstallationSaveLocationCheckboxesAll checked=' + checked + ' fixed=' + fixed);
}

function resetInstallationSaveLocationCheckboxRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(INSTALLATION_SAVE_LOCATION_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('INSTALLATIONS save location checkbox refresh cursor reset to ' + DATA_START_ROW);
}

function getLeadMainObjectByLeadId_(leadId) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  const targetLeadId = String(leadId || '').trim();
  if (!sheet || !targetLeadId || sheet.getLastRow() < DATA_START_ROW) return null;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return null;

  const values = sheet.getRange(DATA_START_ROW, leadIdColumn, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === targetLeadId) {
      const row = DATA_START_ROW + i;
      return {
        row: row,
        object: getRowObject_(sheet, row),
      };
    }
  }

  return null;
}

function getLeadPhoneByLeadId_(leadId) {
  const lead = getLeadMainObjectByLeadId_(leadId);
  return lead ? String(lead.object.phone || '').trim() : '';
}

function findLatestInstallationRowByLeadId_(leadId) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('INSTALLATIONS');
  const targetLeadId = String(leadId || '').trim();
  if (!sheet || !targetLeadId || sheet.getLastRow() < DATA_START_ROW) return 0;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return 0;

  const values = sheet.getRange(DATA_START_ROW, leadIdColumn, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || '').trim() === targetLeadId) {
      return DATA_START_ROW + i;
    }
  }

  return 0;
}

function handleOpenInstallationEdit_(e, sheet, row) {
  if (!e || !e.range || !sheet || sheet.getName() !== 'DEALS' || row < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  const openInstallationColumn = headerMap.open_installation;
  if (!openInstallationColumn || e.range.getColumn() !== openInstallationColumn) return;
  if (String(e.value || '').toUpperCase() !== 'TRUE') return;

  const openInstallationCell = sheet.getRange(row, openInstallationColumn);
  openInstallationCell.setValue(false);

  const deal = getRowObject_(sheet, row);
  const leadId = String(deal.lead_id || '').trim();
  if (!leadId) {
    SpreadsheetApp.getActive().toast('ไม่พบรหัสลูกค้า', 'Open Installation', 5);
    return;
  }

  const installSheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!installSheet) {
    SpreadsheetApp.getActive().toast('ไม่พบชีต INSTALLATIONS', 'Open Installation', 5);
    return;
  }

  const dealPhone = String(deal.phone || '').trim();
  const phone = dealPhone || getLeadPhoneByLeadId_(leadId);
  let installRow = findLatestInstallationRowByLeadId_(leadId);
  let created = false;

  if (!installRow) {
    installRow = appendObjectRow_('INSTALLATIONS', {
      install_id: 'INST-' + Date.now(),
      lead_id: leadId,
      phone: phone,
      install_status: 'In Progress',
    });
    created = true;
  } else {
    const installation = getRowObject_(installSheet, installRow);
    const updates = {};
    if (!String(installation.phone || '').trim() && phone) updates.phone = phone;
    if (!String(installation.install_status || '').trim()) updates.install_status = 'In Progress';
    if (Object.keys(updates).length) {
      setRowObjectValues_(installSheet, installRow, updates);
    }
  }

  ensureInstallationStatusDropdownForRow(installRow, installSheet);
  navigateToInstallationRow_(installSheet, installRow);
  appendOpenInstallationActivity_(leadId, created);
}

function navigateToInstallationRow_(sheet, row) {
  SpreadsheetApp.setActiveSheet(sheet);
  sheet.setActiveRange(sheet.getRange(row, 1, 1, Math.max(sheet.getLastColumn(), 1)));
}

function appendOpenInstallationActivity_(leadId, created) {
  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: String(leadId || '').trim(),
    sheet_name: 'DEALS',
    action_type: 'open_installation',
    note: created
      ? 'Created installation task from DEALS'
      : 'Opened installation task from DEALS',
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });
}

function handleSaveLocationEdit_(e, sheet, row) {
  if (!e || !e.range || !sheet || sheet.getName() !== 'INSTALLATIONS' || row < DATA_START_ROW) return;

  const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
  if (editedHeader !== 'save_location') return;
  if (String(e.value || '').toUpperCase() !== 'TRUE') return;

  ensureInstallationSaveLocationCheckboxForRow(row, sheet);

  const installation = getRowObject_(sheet, row);
  const leadId = String(installation.lead_id || '').trim();
  const missingFields = getMissingInstallLocationFields_(installation);

  if (!leadId) {
    writeInstallSaveStatus_(sheet, row, 'บันทึกไม่สำเร็จ: ไม่พบรหัสลูกค้า');
    return;
  }

  if (missingFields.length) {
    writeInstallSaveStatus_(sheet, row, 'บันทึกไม่สำเร็จ: กรุณากรอก ' + missingFields.join(', '));
    return;
  }

  const locationFile = findInstallationLocationFile_(
    leadId
  );

  if (!locationFile.file) {
    writeInstallSaveStatus_(sheet, row, 'ไม่พบไฟล์สถานที่ติดตั้งใน Google Drive ตามรูปแบบที่กำหนด');
    return;
  }

  const locationUrl = locationFile.fileUrl;
  const locationFileName = locationFile.fileName;
  const note = String(installation.note || '').trim() || buildInstallLocationSummary_(installation);

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'INSTALLATIONS',
    action_type: 'save_location',
    note: note,
    location_url: locationUrl,
    location_file_name: locationFileName,
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });

  const currentCount = Number(installation.install_contact_count || 0);
  setRowObjectValues_(sheet, row, {
    location: locationUrl,
    install_contact_count: Number.isFinite(currentCount) ? currentCount + 1 : 1,
    install_save_status: 'บันทึกสถานที่ติดตั้งแล้ว',
  });
}

function getMissingInstallLocationFields_(installation) {
  const requiredFields = [
    ['preferred_install_date', 'วันที่สะดวกติดตั้ง'],
    ['preferred_install_time', 'ช่วงเวลาที่สะดวก'],
    ['machine_count', 'จำนวนเครื่อง'],
  ];

  return requiredFields
    .filter(item => !String(installation[item[0]] || '').trim())
    .map(item => item[1]);
}

function writeInstallSaveStatus_(sheet, row, message) {
  setRowObjectValues_(sheet, row, {
    install_save_status: message,
  });
}

function buildInstallLocationSummary_(installation) {
  return [
    installation.preferred_install_date ? 'Preferred Install Date: ' + installation.preferred_install_date : '',
    installation.preferred_install_time ? 'Preferred Install Time: ' + installation.preferred_install_time : '',
    installation.location ? 'Location: ' + installation.location : '',
    installation.machine_count ? 'Machine Count: ' + installation.machine_count : '',
  ].filter(Boolean).join('\n');
}

function findInstallationLocationFile_(leadId) {
  return findLatestEvidenceFileByLeadId_(LOCATION_ROOT_FOLDER_ID, leadId, {
    evidenceType: 'location',
    maxFolders: LOCATION_MAX_FOLDERS_SCANNED,
    maxFiles: LOCATION_MAX_FILES_SCANNED,
  });
}

function handleInstallationStatusEdit_(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (!sheet || sheet.getName() !== 'INSTALLATIONS' || e.range.getRow() < DATA_START_ROW) return;

  const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
  ensureInstallationStatusDropdownForRow(e.range.getRow(), sheet);
  if (editedHeader !== 'install_status') return;

  const rowObject = getRowObject_(sheet, e.range.getRow());
  const leadId = String(rowObject.lead_id || '').trim();
  const installStatus = normalizeInstallationStatusForUi_(rowObject.install_status);
  const leadStatus = {
    'In Progress': 'Installed',
    Installed: 'Installed',
    Cancelled: 'Cancelled',
  }[installStatus];

  if (leadId && leadStatus) {
    updateLeadMainStatusByLeadId_(leadId, leadStatus);
    appendStatusChangeActivity_(leadId, 'INSTALLATIONS', 'installation_status_changed', e.oldValue || '', installStatus, leadStatus);
  }

  setupInstallationsStatusConditionalFormatting_();
}

function handleDealPaymentStatusLeadPropagation_(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (!sheet || sheet.getName() !== 'DEALS' || e.range.getRow() < DATA_START_ROW) return;

  const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
  if (editedHeader !== 'payment_status') return;

  const rowObject = getRowObject_(sheet, e.range.getRow());
  const leadId = String(rowObject.lead_id || '').trim();
  const paymentStatus = String(rowObject.payment_status || '').trim().toLowerCase();
  const leadStatus = paymentStatus === 'paid'
    ? 'Installed'
    : paymentStatus === 'cancelled'
      ? 'Cancelled'
      : '';

  if (leadId && leadStatus) {
    updateLeadMainStatusByLeadId_(leadId, leadStatus);
    appendStatusChangeActivity_(leadId, 'DEALS', 'payment_status_changed', e.oldValue || '', rowObject.payment_status || '', leadStatus);
  }
}

function appendStatusChangeActivity_(leadId, sheetName, actionType, oldValue, newValue, leadStatus) {
  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: sheetName,
    action_type: actionType,
    old_value: String(oldValue || '').trim(),
    new_value: String(newValue || '').trim(),
    lead_status: String(leadStatus || '').trim(),
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });
}

function setupInstallationsStatusConditionalFormatting_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('INSTALLATIONS');
  if (!sheet) return;

  const headerMap = getHeaderMap_(sheet);
  const statusColumn = headerMap.install_status;
  if (!statusColumn) return;

  const lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  const lastColumn = sheet.getLastColumn();
  const range = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastColumn);
  const statusColumnLetter = columnToLetter_(statusColumn);
  const installedFormula = '=$' + statusColumnLetter + DATA_START_ROW + '="Installed"';
  const cancelledFormula = '=$' + statusColumnLetter + DATA_START_ROW + '="Cancelled"';
  const managedFormulas = [installedFormula, cancelledFormula];

  const existingRules = sheet.getConditionalFormatRules().filter(rule => {
    const condition = rule.getBooleanCondition();
    const values = condition ? condition.getCriteriaValues() : [];
    return !values.some(value => managedFormulas.indexOf(String(value)) !== -1);
  });

  const installedRule = SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied(installedFormula)
    .setBackground('#d9ead3')
    .setRanges([range])
    .build();

  const cancelledRule = SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied(cancelledFormula)
    .setBackground('#f4cccc')
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules(existingRules.concat([installedRule, cancelledRule]));
}

function updateLeadMainStatusByLeadId_(leadId, leadStatus) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const leadStatusColumn = headerMap.lead_status;
  if (!leadIdColumn || !leadStatusColumn) return false;

  const targetLeadId = String(leadId || '').trim();
  if (!targetLeadId) return false;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return false;

  const values = sheet.getRange(DATA_START_ROW, leadIdColumn, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() !== targetLeadId) continue;

    const row = DATA_START_ROW + i;
    sheet.getRange(row, leadStatusColumn).setValue(leadStatus);
    if (typeof ensureLeadMainStatusDropdownForRow === 'function') {
      ensureLeadMainStatusDropdownForRow(row, sheet);
    }
    if (typeof setupLeadMainStatusConditionalFormatting_ === 'function') {
      setupLeadMainStatusConditionalFormatting_();
    }
    return true;
  }

  return false;
}
