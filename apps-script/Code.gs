const HEADER_ROW = 1;
const DATA_START_ROW = 3;

function getHeaderMap_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.reduce((map, header, index) => {
    const name = String(header || '').trim();
    if (name) {
      map[name] = index + 1;
    }
    return map;
  }, {});
}

function getHeaderColumn_(sheet, headerName) {
  const map = getHeaderMap_(sheet);
  const column = map[headerName];
  if (!column) {
    throw new Error('Missing header: ' + headerName);
  }
  return column;
}

function getRowObject_(sheet, row) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.reduce((object, header, index) => {
    const name = String(header || '').trim();
    if (name) {
      object[name] = values[index];
    }
    return object;
  }, {});
}

function setRowObjectValues_(sheet, row, object) {
  const headerMap = getHeaderMap_(sheet);
  Object.keys(object).forEach(header => {
    if (headerMap[header]) {
      sheet.getRange(row, headerMap[header]).setValue(object[header]);
    }
  });
}

function appendObjectRow_(sheetName, object) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Missing sheet: ' + sheetName);
  }

  const row = Math.max(sheet.getLastRow() + 1, DATA_START_ROW);
  setRowObjectValues_(sheet, row, object);
  return row;
}

function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'LEADS_MAIN') return;
  if (e.range.getRow() < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  const editedHeader = Object.keys(headerMap).find(header => headerMap[header] === e.range.getColumn());

  normalizeLeadMainRow(sheet, e.range.getRow());

  if (editedHeader === 'lead_status') {
    createLeadStatusActivity_(sheet, e.range.getRow(), e.oldValue || '', e.value || '');
  }

  const rowObject = getRowObject_(sheet, e.range.getRow());
  if (String(rowObject.lead_status || '').trim() === 'Closed lost' && !String(rowObject.reason || '').trim()) {
    if (headerMap.reason) {
      sheet.getRange(e.range.getRow(), headerMap.reason).setBackground('#fce8e6');
    }
    SpreadsheetApp.getActive().toast('Please select a reason for Closed lost.', 'Missing reason', 5);
  } else if (headerMap.reason) {
    sheet.getRange(e.range.getRow(), headerMap.reason).setBackground(null);
  }
}
