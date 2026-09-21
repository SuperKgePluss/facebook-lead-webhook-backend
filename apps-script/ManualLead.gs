// Manual leads should be created through this helper, not by typing raw rows into LEADS or LEADS_MAIN.
// LEADS is a sales view only; LEADS_MAIN remains the master sheet.
function createManualLead() {
  const ui = SpreadsheetApp.getUi();
  const customerName = promptManualLeadValue_(ui, 'Customer Name', 'Enter customer name. Phone is still required for safe dedupe.', false);
  if (customerName === null) return;

  const rawPhone = promptManualLeadValue_(ui, 'Phone', 'Enter phone number. This is required and used as the CRM matching key.', true);
  if (rawPhone === null) return;

  const phone = normalizePhone(rawPhone);
  if (!phone) {
    ui.alert('Invalid phone number. Please use a Thai mobile format such as 0812345678.');
    return;
  }

  const note = promptManualLeadValue_(ui, 'Additional Note', 'Optional note. Leave blank if not needed.', false);
  if (note === null) return;

  const salesOwner = promptManualLeadValue_(ui, 'Sales Owner', 'Optional sales owner. Leave blank if not needed.', false);
  if (salesOwner === null) return;

  const preferredCallDay = promptManualLeadValue_(ui, 'Preferred Call Day', 'Optional preferred call day. Leave blank if not needed.', false);
  if (preferredCallDay === null) return;

  const preferredCallTime = promptManualLeadValue_(ui, 'Preferred Call Time', 'Optional preferred call time. Leave blank if not needed.', false);
  if (preferredCallTime === null) return;

  const ss = SpreadsheetApp.getActive();
  const leadSheet = ss.getSheetByName('LEADS_MAIN');
  const detailSheet = ss.getSheetByName('LEAD_DETAILS');
  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadSheet || !detailSheet || !leadsSheet) {
    const missingSheets = [
      !leadSheet ? 'LEADS_MAIN' : '',
      !detailSheet ? 'LEAD_DETAILS' : '',
      !leadsSheet ? 'LEADS' : '',
    ].filter(Boolean).join(', ');
    ui.alert('Manual lead preflight failed. Missing sheet(s): ' + missingSheets);
    return;
  }

  const validationError = validateManualLeadDropdownInputs_(leadSheet, salesOwner, preferredCallDay, preferredCallTime);
  if (validationError) {
    ui.alert(validationError);
    return;
  }

  const existing = findLeadMainRowByPhone_(phone);
  if (existing) {
    navigateToLeadMainRow_(existing.row);
    ui.alert('Lead with this phone already exists.');
    return;
  }

  const now = new Date();
  const leadId = generateManualLeadId_();
  if (findManualLeadIdRows_(leadId).length) {
    ui.alert('Manual lead ID collision detected. No data was written.');
    return;
  }

  let leadRow = null;
  let detailRow = null;
  try {
    // Keep the write order bounded: master row, detail row, then the targeted view sync.
    leadRow = appendObjectRow_('LEADS_MAIN', {
      lead_id: leadId,
      customer_name: customerName,
      phone: phone,
      source: 'Manual',
      lead_status: 'New',
      sales_owner: salesOwner,
      preferred_call_day: preferredCallDay,
      preferred_call_time: preferredCallTime,
      created_at: now,
      updated_at: now,
    });

    if (note) {
      setRowObjectValues_(leadSheet, leadRow, {
        follow_up_note: note,
      });
    }

    detailRow = appendManualLeadDetail_(leadId, phone, customerName);
    setupLeadMainRowUi(leadRow, leadSheet);
    if (syncLeadsViewForLeadMainRow_(leadRow) !== true) {
      throw new Error('Targeted LEADS sync did not complete.');
    }

    if (findManualLeadIdRows_(leadId).length !== 3) {
      throw new Error('Manual lead did not resolve exactly once across the three layers.');
    }

    navigateToLeadMainRow_(leadRow);
    ui.alert('Manual lead created: ' + leadId);
    return leadId;
  } catch (error) {
    const rollback = rollbackManualLeadRows_(leadId);
    Logger.log('createManualLead failed for ' + leadId + ': ' + error + '; rollback=' + JSON.stringify(rollback));
    if (rollback.failed.length) {
      ui.alert('Manual lead creation failed and rollback requires review. Lead ID: ' + leadId + '. Failed rollback sheets: ' + rollback.failed.join(', '));
    } else {
      ui.alert('Manual lead was not created. All touched rows were rolled back.');
    }
    return null;
  }
}

function validateManualLeadDropdownInputs_(leadSheet, salesOwner, preferredCallDay, preferredCallTime) {
  const owner = String(salesOwner || '').trim();
  if (owner && getManualLeadSettingsColumnValues_(4).indexOf(owner) === -1) {
    return 'Invalid Sales Owner. Choose a current value from SETTINGS!D2:D or leave it blank.';
  }

  const dropdownFields = [
    { header: 'preferred_call_day', value: preferredCallDay, label: 'Preferred Call Day' },
    { header: 'preferred_call_time', value: preferredCallTime, label: 'Preferred Call Time' },
  ];
  for (let i = 0; i < dropdownFields.length; i++) {
    const field = dropdownFields[i];
    const value = String(field.value || '').trim();
    if (!value) continue;

    const allowedValues = getManualLeadDropdownValues_(leadSheet, field.header);
    if (allowedValues && allowedValues.indexOf(value) === -1) {
      return 'Invalid ' + field.label + '. Choose a current dropdown value or leave it blank.';
    }
  }
  return '';
}

function getManualLeadSettingsColumnValues_(column) {
  const settingsSheet = SpreadsheetApp.getActive().getSheetByName('SETTINGS');
  const settingsStartRow = 2;
  if (!settingsSheet || settingsSheet.getLastRow() < settingsStartRow) return [];
  return settingsSheet
    .getRange(settingsStartRow, column, settingsSheet.getLastRow() - settingsStartRow + 1, 1)
    .getValues()
    .map(row => String(row[0] || '').trim())
    .filter(Boolean);
}

function getManualLeadDropdownValues_(sheet, header) {
  const headerMap = getHeaderMap_(sheet);
  const column = headerMap[normalizeHeaderName_(header)];
  if (!column) return null;

  const validation = sheet.getRange(DATA_START_ROW, column).getDataValidation();
  if (!validation) return null;

  const criteriaType = validation.getCriteriaType();
  const criteriaValues = validation.getCriteriaValues() || [];
  if (criteriaType === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return (criteriaValues[0] || []).map(value => String(value || '').trim()).filter(Boolean);
  }
  if (criteriaType === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && criteriaValues[0]) {
    return criteriaValues[0]
      .getValues()
      .reduce((values, row) => values.concat(row), [])
      .map(value => String(value || '').trim())
      .filter(Boolean);
  }

  return [];
}

function findManualLeadIdRows_(leadId) {
  const target = String(leadId || '').trim();
  if (!target) return [];

  const ss = SpreadsheetApp.getActive();
  const matches = [];
  ['LEADS_MAIN', 'LEAD_DETAILS', 'LEADS'].forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < DATA_START_ROW) return;

    const headerMap = getHeaderMap_(sheet);
    const leadIdColumn = headerMap.lead_id;
    if (!leadIdColumn) return;

    const values = sheet.getRange(DATA_START_ROW, leadIdColumn, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
    values.forEach((row, index) => {
      if (String(row[0] || '').trim() === target) {
        matches.push({ sheetName: sheetName, row: DATA_START_ROW + index });
      }
    });
  });
  return matches;
}

function rollbackManualLeadRows_(leadId) {
  const matches = findManualLeadIdRows_(leadId);
  const cleared = [];
  const failed = [];
  const ss = SpreadsheetApp.getActive();
  matches.forEach(match => {
    try {
      const sheet = ss.getSheetByName(match.sheetName);
      if (!sheet) throw new Error('Missing sheet: ' + match.sheetName);
      sheet.getRange(match.row, 1, 1, sheet.getLastColumn()).clearContent();
      cleared.push(match.sheetName + '!R' + match.row);
    } catch (error) {
      failed.push(match.sheetName + '!R' + match.row);
    }
  });
  return { cleared: cleared, failed: failed };
}

function appendManualLeadDetail_(leadId, phone, customerName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEAD_DETAILS');
  if (!sheet) throw new Error('Missing sheet: LEAD_DETAILS');

  return appendObjectRow_('LEAD_DETAILS', {
    lead_id: leadId,
    raw_phone: phone,
    original_customer_name: customerName,
    created_source: 'Manual',
  });
}

function promptManualLeadValue_(ui, title, message, required) {
  const response = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return null;

  const value = String(response.getResponseText() || '').trim();
  if (required && !value) {
    ui.alert(title + ' is required.');
    return null;
  }

  return value;
}

function generateManualLeadId_() {
  return 'LEAD-' + Date.now() + Math.floor(Math.random() * 1000);
}

function findLeadMainRowByPhone_(phone) {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  const normalizedPhone = normalizePhone(phone);
  if (!sheet || !normalizedPhone || sheet.getLastRow() < DATA_START_ROW) return null;

  const headerMap = getHeaderMap_(sheet);
  const phoneColumn = headerMap.phone;
  if (!phoneColumn) return null;

  const values = sheet.getRange(DATA_START_ROW, phoneColumn, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (normalizePhone(values[i][0]) === normalizedPhone) {
      return {
        row: DATA_START_ROW + i,
      };
    }
  }

  return null;
}

function navigateToLeadMainRow_(row) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet || !row) return;

  ss.setActiveSheet(sheet);
  sheet.setActiveSelection(sheet.getRange(row, 1, 1, sheet.getLastColumn()));
}