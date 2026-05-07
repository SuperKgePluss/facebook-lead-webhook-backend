// Navigation helpers for Open Deal checkbox actions and ACTIVITY_LOG open_audio selection.
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

function refreshOpenDealCheckboxes() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    refreshOpenDealCheckboxForRow_(sheet, row);
  }
}

function refreshOpenDealCheckboxForRow_(sheet, row) {
  if (!sheet || sheet.getName() !== 'LEADS_MAIN' || row < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  const openDealColumn = headerMap.open_deal;
  const leadIdColumn = headerMap.lead_id;
  if (!openDealColumn || !leadIdColumn) return;

  const openDealCell = sheet.getRange(row, openDealColumn);
  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();

  if (leadId) {
    openDealCell.insertCheckboxes();
    if (String(openDealCell.getValue()).toUpperCase() !== 'TRUE') {
      openDealCell.setValue(false);
    }
    return;
  }

  openDealCell.clearContent();
  openDealCell.clearDataValidations();
}

function setupLeadMainUi() {
  refreshOpenDealCheckboxes();
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
