const CRM_DIAGNOSTIC_REPORT_SHEET_NAME = 'CRM_DIAGNOSTIC_REPORT';
const CRM_DIAGNOSTIC_LOG_SHEET_NAME = 'CRM_DIAGNOSTIC_LOG';
const CRM_DIAGNOSTIC_LOG_HEADERS = [
  'timestamp',
  'sheet',
  'row',
  'column',
  'range_a1',
  'edited_header',
  'lead_id',
  'user_email_safe',
  'reason',
  'e_value_present',
  'note_preview',
  'details',
];

function diagnoseCrmSetup() {
  const ss = SpreadsheetApp.getActive();
  const rows = [];
  const warnings = [];
  const triggerCounts = {};
  const triggers = ScriptApp.getProjectTriggers();
  const leadsSheet = ss.getSheetByName('LEADS');
  const undoSheet = ss.getSheetByName('CRM_UNDO_LOG');
  const activitySheet = ss.getSheetByName('ACTIVITY_LOG');

  addDiagnosticRow_(rows, 'spreadsheet_id', ss.getId(), '');
  addDiagnosticRow_(rows, 'spreadsheet_name', ss.getName(), '');
  addDiagnosticRow_(rows, 'active_sheet_name', ss.getActiveSheet() ? ss.getActiveSheet().getName() : '', '');
  addDiagnosticRow_(rows, 'safe_active_user_email', getDiagnosticActiveUserEmail_(), '');
  addDiagnosticRow_(rows, 'safe_effective_user_email', getDiagnosticEffectiveUserEmail_(), '');

  triggers.forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    triggerCounts[handler] = (triggerCounts[handler] || 0) + 1;
    addDiagnosticRow_(rows, 'trigger', handler, describeDiagnosticTrigger_(trigger));
  });

  ['onEdit', 'onChange', 'syncLeadsViewScheduled', 'syncLeadAudioFilesScheduled'].forEach(function (handler) {
    addDiagnosticRow_(rows, 'trigger_count_' + handler, triggerCounts[handler] || 0, '');
  });
  if ((triggerCounts.onEdit || 0) !== 1) warnings.push('Expected exactly one onEdit trigger; found ' + (triggerCounts.onEdit || 0));
  if ((triggerCounts.onChange || 0) !== 1) warnings.push('Expected exactly one onChange trigger; found ' + (triggerCounts.onChange || 0));
  if ((triggerCounts.syncLeadsViewScheduled || 0) !== 1) warnings.push('Expected exactly one syncLeadsViewScheduled trigger; found ' + (triggerCounts.syncLeadsViewScheduled || 0));

  const protectionSummary = getDiagnosticProtectionSummary_(ss, leadsSheet);
  addDiagnosticRow_(rows, 'protected_range_count', protectionSummary.rangeCount, '');
  addDiagnosticRow_(rows, 'protected_sheet_count', protectionSummary.sheetCount, '');
  addDiagnosticRow_(rows, 'leads_j_protected', protectionSummary.jProtected, '');
  addDiagnosticRow_(rows, 'leads_k_protected', protectionSummary.kProtected, '');
  addDiagnosticRow_(rows, 'current_user_can_edit_j', protectionSummary.canEditJ, '');
  addDiagnosticRow_(rows, 'current_user_can_edit_k', protectionSummary.canEditK, '');

  addDiagnosticRow_(rows, 'leads_sheet_exists', Boolean(leadsSheet), '');
  const schemaResult = checkDiagnosticLeadsSchema_(leadsSheet);
  Object.keys(schemaResult.values).forEach(function (key) {
    addDiagnosticRow_(rows, key, schemaResult.values[key], schemaResult.notes[key] || '');
  });
  warnings.push.apply(warnings, schemaResult.warnings);

  let audioFolderId = '';
  try {
    audioFolderId = typeof getAudioRootFolderId_ === 'function' ? getAudioRootFolderId_() : '';
  } catch (err) {
    warnings.push('AUDIO_ROOT_FOLDER_ID resolution failed: ' + err.message);
  }
  addDiagnosticRow_(rows, 'audio_root_folder_id_resolves', Boolean(audioFolderId), audioFolderId ? 'resolved' : 'missing');

  addDiagnosticRow_(rows, 'crm_undo_log_active_record_count', countDiagnosticUndoActiveRecords_(undoSheet), '');
  addDiagnosticRow_(rows, 'recent_activity_log_sales_note_count', countDiagnosticRecentSalesNotes_(activitySheet), 'last 100 ACTIVITY_LOG rows');

  warnings.forEach(function (warning) {
    addDiagnosticRow_(rows, 'WARNING', warning, '');
  });

  writeDiagnosticReport_(rows);
  Logger.log('CRM diagnostic setup warnings=' + JSON.stringify(warnings));
  SpreadsheetApp.getActive().toast('CRM diagnostics complete. Warnings: ' + warnings.length, 'Diagnose CRM Setup', 8);
  return {
    warnings: warnings,
    rows: rows.length,
  };
}

function logSalesNoteDiagnostic_(payload) {
  try {
    const sheet = ensureCrmDiagnosticLogSheet_();
    appendObjectRow_(CRM_DIAGNOSTIC_LOG_SHEET_NAME, {
      timestamp: new Date(),
      sheet: payload.sheetName || '',
      row: payload.row || '',
      column: payload.column || '',
      range_a1: payload.rangeA1 || '',
      edited_header: payload.editedHeader || '',
      lead_id: payload.leadId || '',
      user_email_safe: typeof getSafeCrmUserEmail_ === 'function' ? getSafeCrmUserEmail_() : getDiagnosticActiveUserEmail_(),
      reason: payload.reason || '',
      e_value_present: payload.eValuePresent || false,
      note_preview: String(payload.notePreview || '').slice(0, 80),
      details: payload.details || '',
    });
    if (!sheet.isSheetHidden()) sheet.hideSheet();
  } catch (err) {
    Logger.log('Failed to write CRM diagnostic log: ' + err.message);
  }
}

function ensureCrmDiagnosticLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CRM_DIAGNOSTIC_LOG_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CRM_DIAGNOSTIC_LOG_SHEET_NAME);
  if (sheet.getMaxColumns() < CRM_DIAGNOSTIC_LOG_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), CRM_DIAGNOSTIC_LOG_HEADERS.length - sheet.getMaxColumns());
  }
  const headers = sheet.getRange(HEADER_ROW, 1, 1, CRM_DIAGNOSTIC_LOG_HEADERS.length).getValues()[0];
  const needsHeaders = CRM_DIAGNOSTIC_LOG_HEADERS.some(function (header, index) {
    return normalizeHeaderName_(headers[index]) !== normalizeHeaderName_(header);
  });
  if (needsHeaders) {
    sheet.getRange(HEADER_ROW, 1, 1, CRM_DIAGNOSTIC_LOG_HEADERS.length).setValues([CRM_DIAGNOSTIC_LOG_HEADERS]);
  }
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function writeDiagnosticReport_(rows) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CRM_DIAGNOSTIC_REPORT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CRM_DIAGNOSTIC_REPORT_SHEET_NAME);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 3).setValues([['key', 'value', 'notes']]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  sheet.autoResizeColumns(1, 3);
}

function addDiagnosticRow_(rows, key, value, notes) {
  rows.push([key, value, notes || '']);
}

function describeDiagnosticTrigger_(trigger) {
  const parts = [];
  try { parts.push('event=' + trigger.getEventType()); } catch (err) {}
  try { parts.push('source=' + trigger.getTriggerSource()); } catch (err) {}
  try { parts.push('source_id=' + (trigger.getTriggerSourceId ? trigger.getTriggerSourceId() : '')); } catch (err) {}
  return parts.join('; ');
}

function getDiagnosticProtectionSummary_(ss, leadsSheet) {
  const result = {
    rangeCount: 0,
    sheetCount: 0,
    jProtected: false,
    kProtected: false,
    canEditJ: '',
    canEditK: '',
  };
  ss.getSheets().forEach(function (sheet) {
    result.rangeCount += sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).length;
    result.sheetCount += sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).length;
  });
  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) return result;

  const headerMap = getHeaderMap_(leadsSheet);
  const jColumn = headerMap.sales_note_input || headerMap.sales_note;
  const kColumn = headerMap.sales_note_history;
  if (jColumn) {
    const range = leadsSheet.getRange(DATA_START_ROW, jColumn);
    result.jProtected = isDiagnosticRangeProtected_(leadsSheet, range);
    result.canEditJ = canDiagnosticCurrentUserEditRange_(leadsSheet, range);
  }
  if (kColumn) {
    const range = leadsSheet.getRange(DATA_START_ROW, kColumn);
    result.kProtected = isDiagnosticRangeProtected_(leadsSheet, range);
    result.canEditK = canDiagnosticCurrentUserEditRange_(leadsSheet, range);
  }
  return result;
}

function isDiagnosticRangeProtected_(sheet, range) {
  const row = range.getRow();
  const column = range.getColumn();
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  return protections.some(function (protection) {
    const protectedRange = protection.getRange();
    return row >= protectedRange.getRow()
      && row <= protectedRange.getLastRow()
      && column >= protectedRange.getColumn()
      && column <= protectedRange.getLastColumn();
  });
}

function canDiagnosticCurrentUserEditRange_(sheet, range) {
  try {
    const protection = range.protect();
    const canEdit = protection.canEdit();
    protection.remove();
    return canEdit;
  } catch (err) {
    return 'unknown: ' + err.message;
  }
}

function checkDiagnosticLeadsSchema_(sheet) {
  const result = {
    values: {},
    notes: {},
    warnings: [],
  };
  const expected = {
    10: 'Sales Note Input',
    11: 'Sales Note History',
    12: 'Follow-up Count',
    13: 'Latest Audio Link',
    14: 'Facebook Search Name',
    15: 'Open Detail',
  };
  if (!sheet) {
    result.warnings.push('LEADS sheet missing');
    return result;
  }
  const headers = sheet.getRange(HEADER_ROW, 1, 1, Math.max(sheet.getLastColumn(), 15)).getValues()[0];
  Object.keys(expected).forEach(function (columnText) {
    const column = Number(columnText);
    const actual = String(headers[column - 1] || '').trim();
    const key = 'leads_column_' + columnToLetter_(column);
    result.values[key] = actual;
    result.notes[key] = 'expected=' + expected[column];
    if (actual !== expected[column]) {
      result.warnings.push('LEADS ' + columnToLetter_(column) + ' expected "' + expected[column] + '" but found "' + actual + '"');
    }
  });
  result.values.leads_headers_match_expected_schema = result.warnings.length === 0;
  return result;
}

function countDiagnosticUndoActiveRecords_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return 0;
  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.status) return 0;
  const values = sheet.getRange(DATA_START_ROW, headerMap.status, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
  return values.filter(function (row) {
    return String(row[0] || '').trim().toLowerCase() === 'active';
  }).length;
}

function countDiagnosticRecentSalesNotes_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return 0;
  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.action_type) return 0;
  const lastRow = sheet.getLastRow();
  const startRow = Math.max(DATA_START_ROW, lastRow - 99);
  const values = sheet.getRange(startRow, headerMap.action_type, lastRow - startRow + 1, 1).getValues();
  return values.filter(function (row) {
    return String(row[0] || '').trim() === 'Sales Note';
  }).length;
}

function getDiagnosticActiveUserEmail_() {
  try {
    const user = Session.getActiveUser();
    return user && user.getEmail ? String(user.getEmail() || '').trim() : '';
  } catch (err) {
    return 'unknown: ' + err.message;
  }
}

function getDiagnosticEffectiveUserEmail_() {
  try {
    const user = Session.getEffectiveUser();
    return user && user.getEmail ? String(user.getEmail() || '').trim() : '';
  } catch (err) {
    return 'unknown: ' + err.message;
  }
}
