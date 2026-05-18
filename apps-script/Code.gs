// Trigger entrypoints and shared sheet helpers. Row 1 contains headers, row 2 is reserved, and data starts at row 3.
const HEADER_ROW = 1;
const DATA_START_ROW = 3;

function normalizeHeaderName_(headerName) {
  const aliases = {
    facebook_lead_id: 'facebook_leadgen_id',
    fb_lead_id: 'facebook_leadgen_id',
    activity_type: 'action_type',
    activity_result: 'new_value',
    result: 'new_value',
    audio_link: 'audio_url',
    activity_date: 'created_at',
    import_source: 'created_source',
  };

  const normalized = String(headerName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return aliases[normalized] || normalized;
}

function getHeaderMap_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.reduce((map, header, index) => {
    const name = normalizeHeaderName_(header);
    if (name) {
      map[name] = index + 1;
    }
    return map;
  }, {});
}

function getHeaderColumn_(sheet, headerName) {
  const map = getHeaderMap_(sheet);
  const column = map[normalizeHeaderName_(headerName)];
  if (!column) {
    throw new Error('Missing header: ' + headerName);
  }
  return column;
}

function getRowObject_(sheet, row) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.reduce((object, header, index) => {
    const name = normalizeHeaderName_(header);
    if (name) {
      object[name] = values[index];
    }
    return object;
  }, {});
}

function setRowObjectValues_(sheet, row, object) {
  const headerMap = getHeaderMap_(sheet);
  Object.keys(object).forEach(header => {
    const normalizedHeader = normalizeHeaderName_(header);
    if (headerMap[normalizedHeader]) {
      sheet.getRange(row, headerMap[normalizedHeader]).setValue(object[header]);
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

function setupCrmUi() {
  setupCrmUiLight();
}

function setupCrmUiLight() {
  setupLeadMainUi();
  setupDealsPaymentUi();
  setupInstallationsUi();
}

function setupCrmUiBatch() {
  refreshLeadMainCheckboxesLight();
  refreshLeadMainStatusDropdownsLight();
  refreshDealsPaymentStatusDropdownsLight();
  refreshDealsOpenInstallationCheckboxes();
  refreshInstallationStatusDropdownsLight();
  refreshInstallationSaveLocationCheckboxes();
}

function installCrmTriggers() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'onEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp
    .newTrigger('onEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();
}

function getEditedHeader_(sheet, column) {
  const headerMap = getHeaderMap_(sheet);
  return Object.keys(headerMap).find(header => headerMap[header] === column) || '';
}

function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() === 'DEALS') {
    const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
    ensureDealsPaymentStatusDropdownForRow(e.range.getRow(), sheet);
    ensureDealsOpenInstallationCheckboxForRow(e.range.getRow(), sheet);
    if (editedHeader === 'open_installation') {
      handleOpenInstallationEdit_(e, sheet, e.range.getRow());
      return;
    }
    handleDealPaymentStatusEdit_(e);
    handleDealPaymentStatusLeadPropagation_(e);
    setupDealsPaymentStatusConditionalFormatting_();
    return;
  }

  if (sheet.getName() === 'INSTALLATIONS') {
    const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
    ensureInstallationStatusDropdownForRow(e.range.getRow(), sheet);
    ensureInstallationSaveLocationCheckboxForRow(e.range.getRow(), sheet);
    if (editedHeader === 'save_location') {
      handleSaveLocationEdit_(e, sheet, e.range.getRow());
      return;
    }
    handleInstallationStatusEdit_(e);
    return;
  }

  if (sheet.getName() !== 'LEADS_MAIN') return;
  if (e.range.getRow() < DATA_START_ROW) return;

  const editedHeader = getEditedHeader_(sheet, e.range.getColumn());

  if (editedHeader === 'open_deal') {
    handleOpenDealEdit_(e, sheet, e.range.getRow());
    return;
  }

  if (editedHeader === 'save_follow_up') {
    handleSaveFollowUpEdit_(e, sheet, e.range.getRow());
    return;
  }

  normalizeLeadMainRow(sheet, e.range.getRow());
  refreshOpenDealCheckboxForRow_(sheet, e.range.getRow());
  ensureLeadMainStatusDropdownForRow(e.range.getRow(), sheet);

  if (editedHeader === 'lead_status') {
    createLeadStatusActivity_(sheet, e.range.getRow(), e.oldValue || '', e.value || '');
  }
}
