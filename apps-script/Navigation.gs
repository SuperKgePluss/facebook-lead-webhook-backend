// Navigation helpers for Open Deal checkbox actions and ACTIVITY_LOG open_audio selection.
const LEAD_MAIN_STATUS_VALUES = ['New', 'Ongoing', 'Installed', 'Done', 'Cancelled'];
const LEAD_MAIN_STATUS_REFRESH_CURSOR_KEY = 'LEADS_MAIN_STATUS_REFRESH_NEXT_ROW';
const LEAD_MAIN_STATUS_REFRESH_BATCH_SIZE = 70;
const LEAD_MAIN_SALES_OWNER_SETTING_HEADERS = ['Sales Owner', 'Sales Owners', 'sales_owner'];
const LEAD_MAIN_CUSTOMER_TYPE_SETTING_HEADERS = ['Customer Type', 'Customer Types', 'customer_type'];
var SETTINGS_VALUES_CACHE_ = {};
function onSelectionChange(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const row = e.range.getRow();
  if (row < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  const selectedHeader = Object.keys(headerMap).find(header => headerMap[header] === e.range.getColumn());

  if (sheet.getName() === 'ACTIVITY_LOG' && selectedHeader === 'open_audio') {
    const activity = getRowObject_(sheet, row);
    const activityId = String(activity.activity_id || '').trim();
    const leadId = String(activity.lead_id || '').trim();

    if (activityId && navigateToLatestMatch_('AUDIO_FILES', 'activity_id', activityId)) {
      return;
    }

    if (leadId) {
      navigateToLatestMatch_('AUDIO_FILES', 'lead_id', leadId);
    }
  }
}

function handleOpenDealEdit_(e, sheet, row) {
  if (String(e.value || '').toUpperCase() !== 'TRUE') {
    return;
  }

  const headerMap = getHeaderMap_(sheet);
  const openDealColumn = headerMap.open_deal;
  if (!openDealColumn) return;

  const openDealCell = sheet.getRange(row, openDealColumn);
  const leadId = String(getRowObject_(sheet, row).lead_id || '').trim();

  openDealCell.setValue(false);

  if (!leadId || !navigateToLatestMatch_('DEALS', 'lead_id', leadId)) {
    SpreadsheetApp.getActive().toast('\u0e44\u0e21\u0e48\u0e1e\u0e1a Deal \u0e02\u0e2d\u0e07 Lead \u0e19\u0e35\u0e49', 'Open Deal', 5);
  }
}

function handleSaveFollowUpEdit_(e, sheet, row) {
  if (!e || !e.range || !sheet || !row) return;

  if (String(e.value || '').toUpperCase() !== 'TRUE') {
    return;
  }

  const headerMap = getHeaderMap_(sheet);
  const saveFollowUpColumn = headerMap.save_follow_up;
  if (!saveFollowUpColumn) return;

  sheet.getRange(row, saveFollowUpColumn).setValue(false);

  try {
    saveLeadFollowUp_(sheet, row);
  } catch (err) {
    Logger.log('Follow-up save failed: ' + err.message);
    writeFollowUpSaveStatus_(sheet, row, 'บันทึกไม่สำเร็จ: โปรดลองอีกครั้ง');
  }
}

function refreshLeadMainActionCheckboxes() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    refreshLeadMainActionCheckboxesForRow_(sheet, row);
  }
}

function refreshLeadMainActionCheckboxesForRow_(sheet, row) {
  ensureLeadMainCheckboxesForRow(row, sheet);
}

function isCheckboxCell_(cell) {
  const validation = cell.getDataValidation();
  return Boolean(validation && validation.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX);
}

function ensureLeadMainCheckboxesForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet || sheet.getName() !== 'LEADS_MAIN' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const openDealColumn = headerMap.open_deal;
  const saveFollowUpColumn = headerMap.save_follow_up;
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return false;

  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const actionColumns = [openDealColumn, saveFollowUpColumn].filter(Boolean);
  let changed = false;

  if (leadId) {
    actionColumns.forEach(column => {
      const cell = sheet.getRange(row, column);
      const value = String(cell.getValue()).trim().toUpperCase();
      if (!isCheckboxCell_(cell)) {
        cell.insertCheckboxes();
        changed = true;
      }
      if (String(cell.getValue()).toUpperCase() !== 'TRUE') {
        cell.setValue(false);
        if (value !== 'FALSE') changed = true;
      }
    });
    return changed;
  }

  actionColumns.forEach(column => {
    const cell = sheet.getRange(row, column);
    if (String(cell.getValue() || '').trim() || isCheckboxCell_(cell)) {
      cell.clearContent();
      cell.clearDataValidations();
      changed = true;
    }
  });

  return changed;
}

function refreshLeadMainCheckboxesLight() {
  const cursorKey = 'LEADS_MAIN_CHECKBOX_REFRESH_NEXT_ROW';
  const batchSize = 70;
  const properties = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet) return { task_completed: true };

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return { task_completed: true };

  const headerMap = getHeaderMap_(sheet);
  const openDealColumn = headerMap.open_deal;
  const saveFollowUpColumn = headerMap.save_follow_up;
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn || (!openDealColumn && !saveFollowUpColumn)) return { task_completed: true };

  const savedCursor = Number(properties.getProperty(cursorKey));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + batchSize - 1, lastRow);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    if (ensureLeadMainCheckboxesForRow(row, sheet)) fixed++;
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(cursorKey, String(nextCursor));

  Logger.log('refreshLeadMainCheckboxesLight batch_size=' + batchSize + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
  return {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    fixed: fixed,
    task_completed: nextCursor === DATA_START_ROW,
  };
}

function resetLeadMainCheckboxRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty('LEADS_MAIN_CHECKBOX_REFRESH_NEXT_ROW', String(DATA_START_ROW));
  Logger.log('LEADS_MAIN checkbox refresh cursor reset to ' + DATA_START_ROW);
}

function isLeadStatusDropdownCell_(cell) {
  const validation = cell.getDataValidation();
  if (!validation || validation.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return false;
  }

  const criteriaValues = validation.getCriteriaValues();
  const values = criteriaValues && criteriaValues[0] ? criteriaValues[0] : [];
  return values.join('|') === LEAD_MAIN_STATUS_VALUES.join('|');
}

function getLeadMainStatusValidation_() {
  return SpreadsheetApp
    .newDataValidation()
    .requireValueInList(LEAD_MAIN_STATUS_VALUES, true)
    .setAllowInvalid(false)
    .build();
}

function getSettingsValuesForHeaders_(candidateHeaders) {
  const cacheKey = candidateHeaders.map(header => normalizeHeaderName_(header)).join('|');
  if (SETTINGS_VALUES_CACHE_[cacheKey]) return SETTINGS_VALUES_CACHE_[cacheKey];

  const sheet = SpreadsheetApp.getActive().getSheetByName('SETTINGS');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) {
    SETTINGS_VALUES_CACHE_[cacheKey] = [];
    return SETTINGS_VALUES_CACHE_[cacheKey];
  }

  const headerMap = getHeaderMap_(sheet);
  const values = [];

  candidateHeaders.forEach(header => {
    const column = headerMap[normalizeHeaderName_(header)];
    if (!column) return;

    sheet
      .getRange(DATA_START_ROW, column, sheet.getLastRow() - DATA_START_ROW + 1, 1)
      .getValues()
      .forEach(row => {
        const value = String(row[0] || '').trim();
        if (value && values.indexOf(value) === -1) values.push(value);
      });
  });

  const settingColumn = headerMap.setting || headerMap.setting_name || headerMap.type || headerMap.key;
  const valueColumn = headerMap.value || headerMap.option || headerMap.display_value || headerMap.name;
  if (settingColumn && valueColumn) {
    sheet
      .getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn())
      .getValues()
      .forEach(row => {
        const setting = normalizeHeaderName_(row[settingColumn - 1]);
        const value = String(row[valueColumn - 1] || '').trim();
        if (candidateHeaders.map(header => normalizeHeaderName_(header)).indexOf(setting) !== -1 && value && values.indexOf(value) === -1) {
          values.push(value);
        }
      });
  }

  SETTINGS_VALUES_CACHE_[cacheKey] = values;
  return values;
}

function isValueInListDropdownCell_(cell, expectedValues) {
  const validation = cell.getDataValidation();
  if (!validation || validation.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return false;
  }

  const criteriaValues = validation.getCriteriaValues();
  const values = criteriaValues && criteriaValues[0] ? criteriaValues[0] : [];
  return values.join('|') === expectedValues.join('|');
}

function ensureLeadMainSalesOwnerDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet || sheet.getName() !== 'LEADS_MAIN' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const phoneColumn = headerMap.phone;
  const salesOwnerColumn = headerMap.sales_owner;
  if (!leadIdColumn || !phoneColumn || !salesOwnerColumn) return false;

  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const phone = String(sheet.getRange(row, phoneColumn).getValue() || '').trim();
  const cell = sheet.getRange(row, salesOwnerColumn);
  const values = getSettingsValuesForHeaders_(LEAD_MAIN_SALES_OWNER_SETTING_HEADERS);
  if (!values.length) return false;

  if (leadId && phone) {
    if (!isValueInListDropdownCell_(cell, values)) {
      cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
      return true;
    }
    return false;
  }

  if (!leadId && !phone && !String(cell.getValue() || '').trim() && cell.getDataValidation()) {
    cell.clearDataValidations();
    return true;
  }

  return false;
}

function ensureLeadMainCustomerTypeDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet || sheet.getName() !== 'LEADS_MAIN' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const phoneColumn = headerMap.phone;
  const customerTypeColumn = headerMap.customer_type;
  if (!leadIdColumn || !phoneColumn || !customerTypeColumn) return false;

  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const phone = String(sheet.getRange(row, phoneColumn).getValue() || '').trim();
  const cell = sheet.getRange(row, customerTypeColumn);
  const values = getSettingsValuesForHeaders_(LEAD_MAIN_CUSTOMER_TYPE_SETTING_HEADERS);
  if (!values.length) return false;

  if (leadId && phone) {
    if (!isValueInListDropdownCell_(cell, values)) {
      cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
      return true;
    }
    return false;
  }

  if (!leadId && !phone && !String(cell.getValue() || '').trim() && cell.getDataValidation()) {
    cell.clearDataValidations();
    return true;
  }

  return false;
}

function ensureLeadMainStatusDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet || sheet.getName() !== 'LEADS_MAIN' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const phoneColumn = headerMap.phone;
  const statusColumn = headerMap.lead_status;
  if (!leadIdColumn || !phoneColumn || !statusColumn) return false;

  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const phone = String(sheet.getRange(row, phoneColumn).getValue() || '').trim();
  const statusCell = sheet.getRange(row, statusColumn);
  const currentStatus = String(statusCell.getValue() || '').trim();
  let changed = false;

  if (leadId && phone) {
    if (!isLeadStatusDropdownCell_(statusCell)) {
      statusCell.setDataValidation(getLeadMainStatusValidation_());
      changed = true;
    }
    if (!currentStatus) {
      statusCell.setValue('New');
      changed = true;
    }
    return changed;
  }

  if (!leadId && !phone && !currentStatus && statusCell.getDataValidation()) {
    statusCell.clearDataValidations();
    changed = true;
  }

  return changed;
}

function refreshLeadMainStatusDropdownsLight() {
  const properties = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet) return { task_completed: true };

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return { task_completed: true };

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.phone || !headerMap.lead_status) return { task_completed: true };

  const savedCursor = Number(properties.getProperty(LEAD_MAIN_STATUS_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + LEAD_MAIN_STATUS_REFRESH_BATCH_SIZE - 1, lastRow);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    if (ensureLeadMainStatusDropdownForRow(row, sheet)) fixed++;
    if (ensureLeadMainSalesOwnerDropdownForRow(row, sheet)) fixed++;
    if (ensureLeadMainCustomerTypeDropdownForRow(row, sheet)) fixed++;
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEAD_MAIN_STATUS_REFRESH_CURSOR_KEY, String(nextCursor));
  setupLeadMainStatusConditionalFormatting_();

  Logger.log('refreshLeadMainStatusDropdownsLight batch_size=' + LEAD_MAIN_STATUS_REFRESH_BATCH_SIZE + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
  return {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    fixed: fixed,
    task_completed: nextCursor === DATA_START_ROW,
  };
}

function refreshLeadMainStatusDropdownsAll() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.phone || !headerMap.lead_status) return;

  let checked = 0;
  let fixed = 0;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    checked++;
    if (ensureLeadMainStatusDropdownForRow(row, sheet)) fixed++;
    if (ensureLeadMainSalesOwnerDropdownForRow(row, sheet)) fixed++;
    if (ensureLeadMainCustomerTypeDropdownForRow(row, sheet)) fixed++;
  }

  setupLeadMainStatusConditionalFormatting_();
  Logger.log('refreshLeadMainStatusDropdownsAll checked=' + checked + ' fixed=' + fixed);
}

function resetLeadMainStatusDropdownRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(LEAD_MAIN_STATUS_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('LEADS_MAIN status dropdown refresh cursor reset to ' + DATA_START_ROW);
}

function columnToLetter_(column) {
  let letter = '';
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    value = Math.floor((value - remainder - 1) / 26);
  }
  return letter;
}

function setupLeadMainStatusConditionalFormatting_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const headerMap = getHeaderMap_(sheet);
  const statusColumn = headerMap.lead_status;
  if (!statusColumn) return;

  const lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  const lastColumn = sheet.getLastColumn();
  const range = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastColumn);
  const statusColumnLetter = columnToLetter_(statusColumn);
  const statusColors = {
    Done: '#d9ead3',
    Cancelled: '#f4cccc',
  };
  const managedStatuses = ['Done', 'Cancelled'];
  const managedFormulas = managedStatuses.map(status => '=$' + statusColumnLetter + DATA_START_ROW + '="' + status + '"');

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

function setupLeadMainMetadataHeaders_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const headers = [
    'Lead Form Name',
    'Ad Name',
    'Ad Set Name',
    'Campaign Name',
    'Facebook Created Time',
  ];
  const thaiLabels = [
    '\u0e0a\u0e37\u0e48\u0e2d\u0e1f\u0e2d\u0e23\u0e4c\u0e21\u0e25\u0e35\u0e14',
    '\u0e0a\u0e37\u0e48\u0e2d\u0e42\u0e06\u0e29\u0e13\u0e32',
    '\u0e0a\u0e37\u0e48\u0e2d\u0e0a\u0e38\u0e14\u0e42\u0e06\u0e29\u0e13\u0e32',
    '\u0e0a\u0e37\u0e48\u0e2d\u0e41\u0e04\u0e21\u0e40\u0e1b\u0e0d',
    '\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48\u0e2a\u0e23\u0e49\u0e32\u0e07\u0e25\u0e35\u0e14\u0e08\u0e32\u0e01 Facebook',
  ];
  const startColumn = 20;
  const requiredLastColumn = startColumn + headers.length - 1;
  if (sheet.getMaxColumns() < requiredLastColumn) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredLastColumn - sheet.getMaxColumns());
  }
  sheet.getRange(HEADER_ROW, startColumn, 1, headers.length).setValues([headers]);
  sheet.getRange(2, startColumn, 1, thaiLabels.length).setValues([thaiLabels]);
}

function applyCrmDateTimeFormats_() {
  const ss = SpreadsheetApp.getActive();
  const targets = {
    LEADS_MAIN: ['latest_follow_up_at', 'created_at', 'updated_at', 'facebook_created_time'],
    LEAD_DETAILS: ['facebook_created_time'],
    DEALS: ['payment_date'],
    INSTALLATIONS: ['preferred_install_date'],
    ACTIVITY_LOG: ['created_at'],
    SUMMARY_DAILY: ['date', 'created_at', 'updated_at'],
  };

  Object.keys(targets).forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < DATA_START_ROW) return;
    const headerMap = getHeaderMap_(sheet);
    targets[sheetName].forEach(header => {
      const column = headerMap[header];
      if (!column) return;
      sheet.getRange(DATA_START_ROW, column, sheet.getLastRow() - DATA_START_ROW + 1, 1).setNumberFormat('MM/dd/yyyy HH:mm');
    });
  });
}

function setupLeadMainBasicFilter_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  const lastColumn = sheet.getLastColumn();
  if (!sheet.getFilter()) {
    sheet.getRange(HEADER_ROW, 1, lastRow - HEADER_ROW + 1, lastColumn).createFilter();
  }
}

function setupLeadMainRowUi(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!sheet || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  let changed = false;
  normalizeLeadMainRow(sheet, row);
  refreshOpenDealCheckboxForRow_(sheet, row);
  if (ensureLeadMainStatusDropdownForRow(row, sheet)) changed = true;
  if (ensureLeadMainSalesOwnerDropdownForRow(row, sheet)) changed = true;
  if (ensureLeadMainCustomerTypeDropdownForRow(row, sheet)) changed = true;
  return changed;
}

function refreshOpenDealCheckboxes() {
  refreshLeadMainActionCheckboxes();
}

function refreshOpenDealCheckboxForRow_(sheet, row) {
  refreshLeadMainActionCheckboxesForRow_(sheet, row);
}

function setupLeadMainUi() {
  setupLeadMainMetadataHeaders_();
  resetLeadMainCheckboxRefreshCursor();
  resetLeadMainStatusDropdownRefreshCursor();
  applyCrmDateTimeFormats_();
  setupLeadMainBasicFilter_();
  setupLeadMainStatusConditionalFormatting_();
  Logger.log('setupLeadMainUi completed lightweight setup. Run setupCrmUiBatch repeatedly to repair row-level checkboxes and dropdowns.');
}

function refreshLeadMainImportCheckboxes() {
  refreshLeadMainActionCheckboxes();
}

function navigateToLatestMatch_(targetSheetName, matchHeader, matchValue) {
  const value = String(matchValue || '').trim();
  if (!value) return false;

  const ss = SpreadsheetApp.getActive();
  const targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) return false;

  const headerMap = getHeaderMap_(targetSheet);
  const matchColumn = headerMap[normalizeHeaderName_(matchHeader)];
  if (!matchColumn) return false;

  let matchedRow = null;
  const lastRow = targetSheet.getLastRow();
  if (lastRow < DATA_START_ROW) return false;

  const values = targetSheet
    .getRange(DATA_START_ROW, matchColumn, lastRow - DATA_START_ROW + 1, 1)
    .getValues();

  values.forEach((row, index) => {
    if (String(row[0] || '').trim() === value) {
      matchedRow = DATA_START_ROW + index;
    }
  });

  if (!matchedRow) return false;

  ss.setActiveSheet(targetSheet);
  targetSheet.setActiveSelection(targetSheet.getRange(matchedRow, 1, 1, targetSheet.getLastColumn()));
  return true;
}
