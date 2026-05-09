// INSTALLATIONS sheet setup, row-level status dropdowns, and Lead Status propagation.
const INSTALLATION_STATUS_VALUES = ['In Progress', 'Installed', 'Cancelled'];
const INSTALLATION_STATUS_REFRESH_CURSOR_KEY = 'INSTALLATION_STATUS_REFRESH_NEXT_ROW';
const INSTALLATION_STATUS_REFRESH_BATCH_SIZE = 100;

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

    return [
      object.install_id || '',
      object.lead_id || '',
      (object.install_status || object.installation_status)
        ? normalizeInstallationStatusForUi_(object.install_status || object.installation_status)
        : '',
      object.preferred_install_date || object.install_date || '',
      object.preferred_install_time || object.install_time || object.time_slot || '',
      object.location || object.address || object.zone || '',
      object.machine_count || object.quantity || object.device_count || '',
      note,
    ];
  });

  if (sheet.getMaxColumns() < 8) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 8 - sheet.getMaxColumns());
  }

  sheet.getRange(HEADER_ROW, 1, 1, 8).setValues([[
    'Install ID',
    'Lead ID',
    'Install Status',
    'Preferred Install Date',
    'Preferred Install Time',
    'Location',
    'Machine Count',
    'Note',
  ]]);

  sheet.getRange(HEADER_ROW + 1, 1, 1, 8).setValues([[
    'รหัสติดตั้ง',
    'รหัสลูกค้า',
    'สถานะติดตั้ง',
    'วันที่สะดวกติดตั้ง',
    'ช่วงเวลาที่สะดวก',
    'สถานที่ติดตั้ง',
    'จำนวนเครื่องที่ติดตั้ง',
    'หมายเหตุ',
  ]]);

  if (migratedRows.length) {
    sheet.getRange(DATA_START_ROW, 1, migratedRows.length, 8).setValues(migratedRows);
  }

  if (sheet.getLastColumn() > 8) {
    sheet.deleteColumns(9, sheet.getLastColumn() - 8);
  }

  const formatRows = Math.max(sheet.getMaxRows() - DATA_START_ROW + 1, 1);
  sheet.getRange(DATA_START_ROW, 4, formatRows, 1).setNumberFormat('dd/MM/yyyy');
  sheet.getRange(DATA_START_ROW, 5, formatRows, 1).setNumberFormat('@');

  refreshInstallationStatusDropdownsLight();
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
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(INSTALLATION_STATUS_REFRESH_CURSOR_KEY, String(nextCursor));

  Logger.log('refreshInstallationStatusDropdownsLight startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
}

function resetInstallationStatusDropdownRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(INSTALLATION_STATUS_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('INSTALLATIONS status dropdown refresh cursor reset to ' + DATA_START_ROW);
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
    Installed: 'Done',
    Cancelled: 'Cancelled',
  }[installStatus];

  if (leadId && leadStatus) {
    updateLeadMainStatusByLeadId_(leadId, leadStatus);
    appendStatusChangeActivity_(leadId, 'INSTALLATIONS', 'installation_status_changed', e.oldValue || '', installStatus, leadStatus);
  }
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
