const CRM_UNDO_LOG_SHEET_NAME = 'CRM_UNDO_LOG';
const CRM_UNDO_EXPIRY_MINUTES = 60;
const CRM_UNDO_HEADERS = [
  'undo_id',
  'timestamp',
  'user_email',
  'action_type',
  'scope',
  'sheet_name',
  'lead_id',
  'input_range_a1',
  'history_range_a1',
  'old_input_value',
  'new_input_value',
  'appended_history_text',
  'related_activity_log_row',
  'related_activity_id',
  'status',
  'expires_at',
  'notes',
];
const CRM_UNDO_MANUAL_LEADS_FIELDS = {
  preferred_call_day: true,
  preferred_call_time: true,
  sales_owner: true,
  sales_note_history: true,
  follow_up_count: true,
};

function undoLastCrmAction() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    SpreadsheetApp.getActive().toast('Undo is busy. Please try again.', 'CRM Undo', 5);
    return {
      success: false,
      error: 'lock_timeout',
    };
  }

  try {
    return undoLastCrmAction_();
  } finally {
    lock.releaseLock();
  }
}

function undoLastCrmAction_() {
  const undoSheet = ensureCrmUndoLogSheet_();
  const selectedContext = getSelectedLeadsViewUndoContext_();
  const record = findLatestActiveCrmUndoRecord_(undoSheet, selectedContext);

  if (!record) {
    const message = selectedContext.leadId
      ? 'No active CRM undo found for the selected LEADS row.'
      : 'No active CRM undo found.';
    SpreadsheetApp.getActive().toast(message, 'CRM Undo', 6);
    return {
      success: false,
      error: 'no_active_undo_record',
      selected_lead_id: selectedContext.leadId,
    };
  }

  if (String(record.object.action_type || '').trim() === 'Manual LEADS Edit') {
    return undoManualLeadsEdit_(undoSheet, record);
  }

  return undoSalesNoteSave_(undoSheet, record);
}

function undoSalesNoteSave_(undoSheet, record) {
  const validation = validateSalesNoteUndoRecord_(record);
  if (!validation.ok) {
    markCrmUndoRecord_(undoSheet, record.rowNumber, 'blocked', validation.reason);
    SpreadsheetApp.getActive().toast(validation.message, 'CRM Undo', 8);
    return {
      success: false,
      error: validation.reason,
      undo_id: record.object.undo_id,
    };
  }

  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const historyRange = leadsSheet.getRange(record.object.history_range_a1);
  const inputRange = leadsSheet.getRange(record.object.input_range_a1);
  const currentHistory = String(historyRange.getValue() || '');
  const appendedText = String(record.object.appended_history_text || '');
  const nextHistory = removeExactSalesNoteHistoryBlock_(currentHistory, appendedText);

  historyRange.setValue(nextHistory);

  let restoredInput = false;
  if (!String(inputRange.getValue() || '').trim()) {
    inputRange.setValue(record.object.new_input_value || '');
    restoredInput = true;
  }

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now() + '-undo-sales-note',
    lead_id: record.object.lead_id,
    sheet_name: 'LEADS',
    action_type: 'Undo Sales Note',
    note: 'Undo Sales Note for activity_id=' + (record.object.related_activity_id || '') + (restoredInput ? '' : ' (input cell not restored because it was not blank)'),
    created_by: getSafeCrmUserEmail_(),
    created_at: new Date(),
  });

  markCrmUndoRecord_(undoSheet, record.rowNumber, 'undone', restoredInput ? 'undone; input restored' : 'undone; input not restored because cell was not blank');
  SpreadsheetApp.getActive().toast('Undid last Sales Note save for lead ' + record.object.lead_id, 'CRM Undo', 5);
  return {
    success: true,
    undo_id: record.object.undo_id,
    lead_id: record.object.lead_id,
    input_restored: restoredInput,
  };
}

function undoManualLeadsEdit_(undoSheet, record) {
  const validation = validateManualLeadsEditUndoRecord_(record);
  if (!validation.ok) {
    markCrmUndoRecord_(undoSheet, record.rowNumber, 'blocked', validation.reason);
    SpreadsheetApp.getActive().toast(validation.message, 'CRM Undo', 8);
    return {
      success: false,
      error: validation.reason,
      undo_id: record.object.undo_id,
    };
  }

  const leadsSheet = SpreadsheetApp.getActive().getSheetByName('LEADS');
  const targetRange = leadsSheet.getRange(record.object.input_range_a1);
  targetRange.setValue(record.object.old_input_value || '');
  syncManualLeadsUndoBackToLeadMain_(leadsSheet, targetRange.getRow(), record.object.notes);
  markCrmUndoRecord_(undoSheet, record.rowNumber, 'undone', 'manual LEADS edit undone');
  SpreadsheetApp.getActive().toast('Undid manual LEADS edit for lead ' + record.object.lead_id, 'CRM Undo', 5);
  return {
    success: true,
    undo_id: record.object.undo_id,
    lead_id: record.object.lead_id,
    range_a1: record.object.input_range_a1,
  };
}

function recordCrmUndoSalesNoteSave_(payload) {
  const sheet = ensureCrmUndoLogSheet_();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CRM_UNDO_EXPIRY_MINUTES * 60 * 1000);

  appendObjectRow_(CRM_UNDO_LOG_SHEET_NAME, {
    undo_id: 'UNDO-' + now.getTime(),
    timestamp: now,
    user_email: payload.userEmail || getSafeCrmUserEmail_(),
    action_type: 'Sales Note Save',
    scope: 'LEADS',
    sheet_name: 'LEADS',
    lead_id: payload.leadId || '',
    input_range_a1: payload.inputRangeA1 || '',
    history_range_a1: payload.historyRangeA1 || '',
    old_input_value: payload.oldInputValue || '',
    new_input_value: payload.newInputValue || '',
    appended_history_text: payload.appendedHistoryText || '',
    related_activity_log_row: payload.relatedActivityLogRow || '',
    related_activity_id: payload.relatedActivityId || '',
    status: 'active',
    expires_at: expiresAt,
    notes: '',
  });

  if (!sheet.isSheetHidden()) sheet.hideSheet();
}

function recordCrmUndoManualLeadsEdit_(payload) {
  if (!payload || !CRM_UNDO_MANUAL_LEADS_FIELDS[payload.fieldName]) return false;
  if (payload.isMultiCell) return false;
  if (!payload.hasOldValue) return false;
  if (!payload.rangeA1 || !payload.leadId) return false;

  const oldValue = String(payload.oldValue);
  const newValue = payload.newValue === undefined ? '' : String(payload.newValue);
  if (oldValue === newValue) return false;

  const sheet = ensureCrmUndoLogSheet_();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CRM_UNDO_EXPIRY_MINUTES * 60 * 1000);

  appendObjectRow_(CRM_UNDO_LOG_SHEET_NAME, {
    undo_id: 'UNDO-' + now.getTime(),
    timestamp: now,
    user_email: getSafeCrmUserEmail_(),
    action_type: 'Manual LEADS Edit',
    scope: 'LEADS',
    sheet_name: 'LEADS',
    lead_id: payload.leadId || '',
    input_range_a1: payload.rangeA1 || '',
    history_range_a1: '',
    old_input_value: oldValue,
    new_input_value: newValue,
    appended_history_text: '',
    related_activity_log_row: '',
    related_activity_id: '',
    status: 'active',
    expires_at: expiresAt,
    notes: 'field=' + payload.fieldName,
  });

  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return true;
}

function ensureCrmUndoLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CRM_UNDO_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CRM_UNDO_LOG_SHEET_NAME);
  }

  if (sheet.getMaxColumns() < CRM_UNDO_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), CRM_UNDO_HEADERS.length - sheet.getMaxColumns());
  }

  const existingHeaders = sheet.getRange(HEADER_ROW, 1, 1, CRM_UNDO_HEADERS.length).getValues()[0];
  const needsHeaders = CRM_UNDO_HEADERS.some((header, index) => normalizeHeaderName_(existingHeaders[index]) !== normalizeHeaderName_(header));
  if (needsHeaders) {
    sheet.getRange(HEADER_ROW, 1, 1, CRM_UNDO_HEADERS.length).setValues([CRM_UNDO_HEADERS]);
  }

  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function getSelectedLeadsViewUndoContext_() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const context = {
    leadId: '',
    rangeA1: '',
    fieldName: '',
    isSupportedManualCell: false,
  };
  if (!sheet || sheet.getName() !== 'LEADS') return context;

  const range = sheet.getActiveRange();
  if (!range || range.getRow() < DATA_START_ROW) return context;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id) return context;

  context.leadId = String(sheet.getRange(range.getRow(), headerMap.lead_id).getValue() || '').trim();
  if (range.getNumRows() === 1 && range.getNumColumns() === 1) {
    context.rangeA1 = range.getA1Notation();
    context.fieldName = getEditedHeader_(sheet, range.getColumn());
    context.isSupportedManualCell = Boolean(CRM_UNDO_MANUAL_LEADS_FIELDS[context.fieldName]);
  }
  return context;
}

function findLatestActiveCrmUndoRecord_(sheet, selectedContext) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return null;

  const headerMap = getHeaderMap_(sheet);
  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  const selectedLeadId = selectedContext && selectedContext.leadId ? selectedContext.leadId : '';
  const selectedRangeA1 = selectedContext && selectedContext.rangeA1 ? selectedContext.rangeA1 : '';

  if (selectedLeadId && selectedRangeA1) {
    const exactCellRecord = findLatestValidManualLeadsEditRecordForCell_(sheet, values, headerMap, selectedLeadId, selectedRangeA1);
    if (exactCellRecord) return exactCellRecord;
    if (selectedContext && selectedContext.isSupportedManualCell) return null;
  }

  return findLatestActiveCrmUndoRecordInValues_(values, headerMap, selectedLeadId, '', false);
}

function findLatestValidManualLeadsEditRecordForCell_(sheet, values, headerMap, selectedLeadId, selectedRangeA1) {
  for (let index = values.length - 1; index >= 0; index--) {
    const object = values[index].reduce((result, value, valueIndex) => {
      const header = Object.keys(headerMap).find(key => headerMap[key] === valueIndex + 1);
      if (header) result[header] = value;
      return result;
    }, {});

    if (String(object.status || '').trim().toLowerCase() !== 'active') continue;
    if (String(object.action_type || '').trim() !== 'Manual LEADS Edit') continue;
    if (String(object.scope || '').trim() !== 'LEADS') continue;
    if (String(object.lead_id || '').trim() !== selectedLeadId) continue;
    if (String(object.input_range_a1 || '').trim() !== selectedRangeA1) continue;

    const record = {
      rowNumber: DATA_START_ROW + index,
      object: object,
    };
    const validation = validateManualLeadsEditUndoRecord_(record, true);
    Logger.log('CRM undo exact-cell candidate undo_id=' + object.undo_id
      + ' selected_range=' + selectedRangeA1
      + ' selected_lead_id=' + selectedLeadId
      + ' candidate_range=' + object.input_range_a1
      + ' old_value=' + object.old_input_value
      + ' new_value=' + object.new_input_value
      + ' current_value=' + (validation.current_value || '')
      + ' reason=' + (validation.ok ? 'ok' : validation.reason));
    if (validation.ok) return record;
  }

  return null;
}

function findLatestActiveCrmUndoRecordInValues_(values, headerMap, selectedLeadId, selectedRangeA1, requireManualCellMatch) {
  for (let index = values.length - 1; index >= 0; index--) {
    const object = values[index].reduce((result, value, valueIndex) => {
      const header = Object.keys(headerMap).find(key => headerMap[key] === valueIndex + 1);
      if (header) result[header] = value;
      return result;
    }, {});

    if (String(object.status || '').trim().toLowerCase() !== 'active') continue;
    const actionType = String(object.action_type || '').trim();
    if (actionType !== 'Sales Note Save' && actionType !== 'Manual LEADS Edit') continue;
    if (!selectedRangeA1 && actionType === 'Manual LEADS Edit') continue;
    if (String(object.scope || '').trim() !== 'LEADS') continue;
    if (selectedLeadId && String(object.lead_id || '').trim() !== selectedLeadId) continue;
    if (requireManualCellMatch && actionType !== 'Manual LEADS Edit') continue;
    if (selectedRangeA1 && String(object.input_range_a1 || '').trim() !== selectedRangeA1) continue;

    return {
      rowNumber: DATA_START_ROW + index,
      object: object,
    };
  }

  return null;
}

function validateSalesNoteUndoRecord_(record) {
  const object = record.object || {};
  const now = new Date();
  const expiresAt = parseCrmUndoDate_(object.expires_at);
  if (!expiresAt || expiresAt.getTime() < now.getTime()) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Undo record has expired.',
    };
  }

  const leadsSheet = SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!leadsSheet) {
    return {
      ok: false,
      reason: 'missing_leads_sheet',
      message: 'LEADS sheet was not found.',
    };
  }

  const historyRangeA1 = String(object.history_range_a1 || '').trim();
  const inputRangeA1 = String(object.input_range_a1 || '').trim();
  if (!historyRangeA1 || !inputRangeA1) {
    return {
      ok: false,
      reason: 'missing_ranges',
      message: 'Undo record is missing target ranges.',
    };
  }

  const historyRange = leadsSheet.getRange(historyRangeA1);
  const inputRange = leadsSheet.getRange(inputRangeA1);
  if (historyRange.getNumRows() !== 1 || historyRange.getNumColumns() !== 1 || inputRange.getNumRows() !== 1 || inputRange.getNumColumns() !== 1) {
    return {
      ok: false,
      reason: 'invalid_range_shape',
      message: 'Undo target is not a single cell.',
    };
  }

  const row = historyRange.getRow();
  const headerMap = getHeaderMap_(leadsSheet);
  const currentLeadId = headerMap.lead_id ? String(leadsSheet.getRange(row, headerMap.lead_id).getValue() || '').trim() : '';
  if (!currentLeadId || currentLeadId !== String(object.lead_id || '').trim()) {
    return {
      ok: false,
      reason: 'lead_id_mismatch',
      message: 'Undo skipped because the target LEADS row no longer matches the recorded Lead ID.',
    };
  }

  const currentHistory = String(historyRange.getValue() || '');
  const appendedText = String(object.appended_history_text || '');
  if (!appendedText || currentHistory.indexOf(appendedText) === -1) {
    return {
      ok: false,
      reason: 'history_text_not_found',
      message: 'Undo skipped because the saved note text was not found in the recorded history cell.',
    };
  }

  return {
    ok: true,
  };
}

function validateManualLeadsEditUndoRecord_(record, suppressToast) {
  const object = record.object || {};
  const now = new Date();
  const expiresAt = parseCrmUndoDate_(object.expires_at);
  if (!expiresAt || expiresAt.getTime() < now.getTime()) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Undo record has expired.',
    };
  }

  const leadsSheet = SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!leadsSheet) {
    return {
      ok: false,
      reason: 'missing_leads_sheet',
      message: 'LEADS sheet was not found.',
    };
  }

  const rangeA1 = String(object.input_range_a1 || '').trim();
  if (!rangeA1) {
    return {
      ok: false,
      reason: 'missing_range',
      message: 'Undo record is missing target range.',
    };
  }

  const targetRange = leadsSheet.getRange(rangeA1);
  if (targetRange.getNumRows() !== 1 || targetRange.getNumColumns() !== 1) {
    return {
      ok: false,
      reason: 'invalid_range_shape',
      message: 'Undo target is not a single cell.',
    };
  }

  const row = targetRange.getRow();
  const headerMap = getHeaderMap_(leadsSheet);
  const currentLeadId = headerMap.lead_id ? String(leadsSheet.getRange(row, headerMap.lead_id).getValue() || '').trim() : '';
  if (!currentLeadId || currentLeadId !== String(object.lead_id || '').trim()) {
    return {
      ok: false,
      reason: 'lead_id_mismatch',
      message: 'Undo skipped because the target LEADS row no longer matches the recorded Lead ID.',
    };
  }

  const currentValue = String(targetRange.getValue() || '');
  const recordedNewValue = String(object.new_input_value || '');
  if (currentValue !== recordedNewValue) {
    return {
      ok: false,
      reason: 'current_value_changed',
      current_value: currentValue,
      message: 'Undo skipped because the cell was changed after this undo record was created.',
    };
  }

  return {
    ok: true,
    current_value: currentValue,
  };
}

function removeExactSalesNoteHistoryBlock_(historyText, appendedText) {
  const history = String(historyText || '');
  const target = String(appendedText || '');
  if (!target) return history;

  if (history === target) return '';

  const patterns = [
    '\n\n' + target,
    target + '\n\n',
    '\n' + target,
    target + '\n',
    target,
  ];
  let result = history;
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    const position = result.indexOf(pattern);
    if (position !== -1) {
      result = result.slice(0, position) + result.slice(position + pattern.length);
      break;
    }
  }

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function markCrmUndoRecord_(sheet, row, status, notes) {
  const headerMap = getHeaderMap_(sheet);
  if (headerMap.status) sheet.getRange(row, headerMap.status).setValue(status);
  if (headerMap.notes) sheet.getRange(row, headerMap.notes).setValue(notes || '');
}

function parseCrmUndoDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function syncManualLeadsUndoBackToLeadMain_(sheet, row, notes) {
  const fieldMatch = String(notes || '').match(/field=([a-z0-9_]+)/i);
  const fieldName = fieldMatch ? fieldMatch[1] : '';
  if (!fieldName) return;

  const writebackFields = {
    preferred_call_day: true,
    preferred_call_time: true,
    sales_owner: true,
  };
  if (!writebackFields[fieldName]) return;
  if (typeof syncLeadsViewEditableFieldToLeadMain_ !== 'function') return;

  syncLeadsViewEditableFieldToLeadMain_(sheet, row, fieldName);
}

function getSafeCrmUserEmail_() {
  try {
    const user = Session.getActiveUser();
    return user && typeof user.getEmail === 'function' ? String(user.getEmail() || '').trim() : '';
  } catch (err) {
    return 'unknown';
  }
}
