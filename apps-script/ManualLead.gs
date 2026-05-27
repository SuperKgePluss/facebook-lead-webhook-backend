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

  const existing = findLeadMainRowByPhone_(phone);
  if (existing) {
    navigateToLeadMainRow_(existing.row);
    ui.alert('Lead with this phone already exists.');
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
  if (!leadSheet) {
    ui.alert('Missing LEADS_MAIN sheet.');
    return;
  }

  const now = new Date();
  const leadId = generateManualLeadId_();
  const leadRow = appendObjectRow_('LEADS_MAIN', {
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

  appendManualLeadDetail_(leadId, phone, customerName);
  setupLeadMainRowUi(leadRow, leadSheet);
  refreshLeadsViewLight();
  navigateToLeadMainRow_(leadRow);
  ui.alert('Manual lead created: ' + leadId);
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

function appendManualLeadDetail_(leadId, phone, customerName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEAD_DETAILS');
  if (!sheet) return;

  appendObjectRow_('LEAD_DETAILS', {
    lead_id: leadId,
    raw_phone: phone,
    original_customer_name: customerName,
    created_source: 'Manual',
  });
}

function navigateToLeadMainRow_(row) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet || !row) return;

  ss.setActiveSheet(sheet);
  sheet.setActiveSelection(sheet.getRange(row, 1, 1, sheet.getLastColumn()));
}
