function onSelectionChange(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const row = e.range.getRow();
  if (row < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  const selectedHeader = Object.keys(headerMap).find(header => headerMap[header] === e.range.getColumn());

  if (sheet.getName() === 'LEADS_MAIN' && selectedHeader === 'open_deal') {
    navigateToLatestMatch_('DEALS', 'lead_id', getRowObject_(sheet, row).lead_id);
    return;
  }

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

function navigateToLatestMatch_(targetSheetName, matchHeader, matchValue) {
  const value = String(matchValue || '').trim();
  if (!value) return false;

  const ss = SpreadsheetApp.getActive();
  const targetSheet = ss.getSheetByName(targetSheetName);
  if (!targetSheet) return false;

  const headerMap = getHeaderMap_(targetSheet);
  const matchColumn = headerMap[matchHeader];
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
