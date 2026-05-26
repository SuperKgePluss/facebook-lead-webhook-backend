// Trigger entrypoints and shared sheet helpers. Row 1 contains headers, row 2 is reserved, and data starts at row 3.
const HEADER_ROW = 1;
const DATA_START_ROW = 3;
const CRM_UI_BATCH_TASK_CURSOR_KEY = 'CRM_UI_BATCH_CURRENT_TASK';
const CRM_UI_BATCH_TASKS = [
  'leads_view_sync',
  'lead_main_checkboxes',
  'lead_main_status_dropdowns',
  'deals_payment_status',
  'deals_open_installation',
  'installations_status',
];

function normalizeHeaderName_(headerName) {
  const aliases = {
    facebook_lead_id: 'facebook_leadgen_id',
    fb_lead_id: 'facebook_leadgen_id',
    ad_set_name: 'adset_name',
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
  setupLeadsViewUi();
  setupDealsPaymentUi();
  setupInstallationsUi();
  PropertiesService
    .getScriptProperties()
    .setProperty(CRM_UI_BATCH_TASK_CURSOR_KEY, CRM_UI_BATCH_TASKS[0]);
}

function setupCrmUiBatch() {
  const properties = PropertiesService.getScriptProperties();
  const savedTask = String(properties.getProperty(CRM_UI_BATCH_TASK_CURSOR_KEY) || CRM_UI_BATCH_TASKS[0]).trim();
  const currentTask = CRM_UI_BATCH_TASKS.indexOf(savedTask) === -1 ? CRM_UI_BATCH_TASKS[0] : savedTask;
  const taskIndex = CRM_UI_BATCH_TASKS.indexOf(currentTask);
  let result;

  if (savedTask === 'completed') {
    Logger.log('setupCrmUiBatch current_task=completed task_completed=true next_task=completed');
    return;
  }

  if (currentTask === 'leads_view_sync') {
    result = refreshLeadsViewLight();
  } else if (currentTask === 'lead_main_checkboxes') {
    result = refreshLeadMainCheckboxesLight();
  } else if (currentTask === 'lead_main_status_dropdowns') {
    result = refreshLeadMainStatusDropdownsLight();
  } else if (currentTask === 'deals_payment_status') {
    result = refreshDealsPaymentStatusDropdownsLight();
  } else if (currentTask === 'deals_open_installation') {
    result = refreshDealsOpenInstallationCheckboxes();
  } else if (currentTask === 'installations_status') {
    result = refreshInstallationStatusDropdownsLight();
  }

  result = result || {};
  const taskCompleted = Boolean(result.task_completed);
  const nextTask = taskCompleted
    ? CRM_UI_BATCH_TASKS[taskIndex + 1] || 'completed'
    : currentTask;

  properties.setProperty(CRM_UI_BATCH_TASK_CURSOR_KEY, nextTask);
  Logger.log(
    'setupCrmUiBatch current_task=' + currentTask
    + ' startRow=' + (result.startRow || '')
    + ' endRow=' + (result.endRow || '')
    + ' nextCursor=' + (result.nextCursor || '')
    + ' task_completed=' + taskCompleted
    + ' next_task=' + nextTask
  );
}

function resetCrmUiBatchCursor() {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(CRM_UI_BATCH_TASK_CURSOR_KEY);
  Logger.log('CRM UI batch cursor reset.');
}

function installCrmTriggers() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'onEdit' || trigger.getHandlerFunction() === 'onChange') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp
    .newTrigger('onEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  ScriptApp
    .newTrigger('onChange')
    .forSpreadsheet(ss)
    .onChange()
    .create();
}

function onChange(e) {
  setupRecentlyAppendedRows_();
}

function setupRecentlyAppendedRows_() {
  const ss = SpreadsheetApp.getActive();
  const leadSheet = ss.getSheetByName('LEADS_MAIN');
  if (leadSheet && typeof setupLeadMainRowUi === 'function') {
    const lastRow = leadSheet.getLastRow();
    const startRow = Math.max(DATA_START_ROW, lastRow - 49);
    for (let row = startRow; row <= lastRow; row++) {
      setupLeadMainRowUi(row, leadSheet);
    }
  }

  const dealsSheet = ss.getSheetByName('DEALS');
  if (dealsSheet && typeof setupDealsRowUi === 'function') {
    const lastRow = dealsSheet.getLastRow();
    const startRow = Math.max(DATA_START_ROW, lastRow - 49);
    for (let row = startRow; row <= lastRow; row++) {
      setupDealsRowUi(row, dealsSheet);
    }
  }

  if (typeof refreshLeadsViewLight === 'function') {
    refreshLeadsViewLight();
  }
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
    ensureInstallationStatusDropdownForRow(e.range.getRow(), sheet);
    // Location links are now manual. Save Location auto-fetch is disabled by client request.
    handleInstallationStatusEdit_(e);
    return;
  }

  if (sheet.getName() === 'LEADS') {
    handleLeadsViewEdit_(e, sheet, e.range.getRow());
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
  ensureLeadMainSalesOwnerDropdownForRow(e.range.getRow(), sheet);
  ensureLeadMainCustomerTypeDropdownForRow(e.range.getRow(), sheet);

  if (editedHeader === 'lead_status') {
    createLeadStatusActivity_(sheet, e.range.getRow(), e.oldValue || '', e.value || '');
  }
}
