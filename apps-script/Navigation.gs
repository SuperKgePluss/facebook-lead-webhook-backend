// Navigation helpers for Open Deal checkbox actions and ACTIVITY_LOG open_audio selection.
const LEAD_MAIN_STATUS_VALUES = ['New', 'Ongoing', 'Installed', 'Done', 'Cancelled'];
const LEAD_MAIN_STATUS_REFRESH_CURSOR_KEY = 'LEADS_MAIN_STATUS_REFRESH_NEXT_ROW';
const LEAD_MAIN_STATUS_REFRESH_BATCH_SIZE = 25;
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
  const batchSize = 25;
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

  Logger.log('refreshLeadMainCheckboxesLight startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
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
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEAD_MAIN_STATUS_REFRESH_CURSOR_KEY, String(nextCursor));
  setupLeadMainStatusConditionalFormatting_();

  Logger.log('refreshLeadMainStatusDropdownsLight startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
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
  const doneFormula = '=$' + statusColumnLetter + DATA_START_ROW + '="Done"';
  const cancelledFormula = '=$' + statusColumnLetter + DATA_START_ROW + '="Cancelled"';
  const managedFormulas = [doneFormula, cancelledFormula];

  const existingRules = sheet.getConditionalFormatRules().filter(rule => {
    const condition = rule.getBooleanCondition();
    const values = condition ? condition.getCriteriaValues() : [];
    return !values.some(value => managedFormulas.indexOf(String(value)) !== -1);
  });

  const doneRule = SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied(doneFormula)
    .setBackground('#d9ead3')
    .setRanges([range])
    .build();

  const cancelledRule = SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied(cancelledFormula)
    .setBackground('#f4cccc')
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules(existingRules.concat([doneRule, cancelledRule]));
}

function refreshOpenDealCheckboxes() {
  refreshLeadMainActionCheckboxes();
}

function refreshOpenDealCheckboxForRow_(sheet, row) {
  refreshLeadMainActionCheckboxesForRow_(sheet, row);
}

function setupLeadMainUi() {
  resetLeadMainCheckboxRefreshCursor();
  resetLeadMainStatusDropdownRefreshCursor();
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
