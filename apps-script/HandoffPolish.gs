// Final handoff polish helpers. These functions are manual-only and are not wired
// into onOpen so they cannot run unless an administrator explicitly invokes them.
const HANDOFF_DATE_REVIEW_SHEET_NAME = '_HANDOFF_DATE_VISUAL_REVIEW';
const HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME = '_HANDOFF_NOTE_HISTORY_MARKER_REPORT';
const HANDOFF_TEST_LEAD_CLEANUP_REPORT_SHEET_NAME = '_HANDOFF_TEST_LEAD_CLEANUP_DRY_RUN';
const HANDOFF_REPORT_SHEET_NOTE = 'created_by_handoff_polish_helper_v1';
const HANDOFF_NOTE_MARKER_BACKGROUND = '#fff2cc';
const HANDOFF_NOTE_MARKER_FONT = '#7f6000';
const HANDOFF_TEST_LEADS_ROWS = [314, 468, 469];
const HANDOFF_RELATED_LEAD_SHEETS = [
  'LEADS',
  'LEADS_MAIN',
  'LEAD_DETAILS',
  'ACTIVITY_LOG',
  'DEALS',
  'INSTALLATIONS',
  'LEADS_NOTE_SNAPSHOT',
];

function getHandoffPrePolishSafetyChecklist() {
  return {
    before_any_formatting_or_cleanup: [
      'Create a named Google Sheets version: File > Version history > Name current version.',
      'Confirm no sales users are actively editing during the polish window.',
      'Run report-only helpers before any visual marker or cleanup action.',
      'Do not run production date sort, import, repair, restore, backfill, or full sync.',
      'Do not delete rows by visible row number; resolve Lead ID and related records first.',
      'Keep Sales Note History editable for sales users.',
    ],
    recommended_version_name: 'Pre-handoff polish backup - ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm'),
  };
}

function buildHandoffDateVisualReviewReport() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_DATE_REVIEW_SHEET_NAME);
  const headers = [
    'audit_at',
    'row',
    'lead_id',
    'customer_name',
    'raw_date_value',
    'raw_type',
    'display_date_value',
    'number_format',
    'parsed_date',
    'epoch_ms',
    'source_field',
    'reason',
  ];
  const rows = [];
  const auditAt = new Date();

  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) {
    writeHandoffReport_(reportSheet, headers, [[auditAt, '', '', '', '', '', '', '', '', '', 'LEADS.facebook_created_time', 'missing_or_empty_LEADS_sheet']]);
    return { rows_written: 1, report_sheet: HANDOFF_DATE_REVIEW_SHEET_NAME };
  }

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id || !headerMap.facebook_created_time) {
    writeHandoffReport_(reportSheet, headers, [[auditAt, '', '', '', '', '', '', '', '', '', 'LEADS.facebook_created_time', 'missing_lead_id_or_facebook_created_time_header']]);
    return { rows_written: 1, report_sheet: HANDOFF_DATE_REVIEW_SHEET_NAME };
  }

  const rowCount = leadsSheet.getLastRow() - DATA_START_ROW + 1;
  const lastColumn = leadsSheet.getLastColumn();
  const values = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getValues();
  const displays = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getDisplayValues();
  const formats = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getNumberFormats();
  let previousEpoch = null;

  values.forEach(function (row, index) {
    const sheetRow = DATA_START_ROW + index;
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId) return;

    const customerName = headerMap.customer_name ? String(displays[index][headerMap.customer_name - 1] || '') : '';
    const rawValue = row[headerMap.facebook_created_time - 1];
    const displayValue = String(displays[index][headerMap.facebook_created_time - 1] || '');
    const numberFormat = String(formats[index][headerMap.facebook_created_time - 1] || '');
    const parsed = parseHandoffDateValue_(rawValue, displayValue);
    const reasons = getHandoffDateReviewReasons_(rawValue, displayValue, numberFormat, parsed, previousEpoch);

    if (parsed.epochMs !== null && parsed.epochMs !== undefined) {
      previousEpoch = parsed.epochMs;
    }

    if (!reasons.length) return;
    rows.push([
      auditAt,
      sheetRow,
      leadId,
      customerName,
      serializeHandoffValue_(rawValue),
      getHandoffValueType_(rawValue),
      displayValue,
      numberFormat,
      parsed.parsedDate ? formatHandoffDate_(parsed.parsedDate) : '',
      parsed.epochMs === null || parsed.epochMs === undefined ? '' : parsed.epochMs,
      'LEADS.facebook_created_time',
      reasons.join(', '),
    ]);
  });

  writeHandoffReport_(reportSheet, headers, rows);
  return { rows_written: rows.length, report_sheet: HANDOFF_DATE_REVIEW_SHEET_NAME };
}

function markSuspiciousSalesNoteHistoryRowsForHandoff() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME);
  const headers = [
    'marked_at',
    'row',
    'lead_id',
    'customer_name',
    'note_length',
    'newline_count',
    'duplicate_entry_count',
    'reason',
    'previous_background',
    'previous_font_color',
  ];
  const rows = [];
  const markedAt = new Date();
  const existingMarkerFormats = getExistingHandoffMarkerFormatMap_(reportSheet);

  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) {
    writeHandoffReport_(reportSheet, headers, [[markedAt, '', '', '', '', '', '', 'missing_or_empty_LEADS_sheet', '', '']]);
    return { marked: 0, report_sheet: HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME };
  }

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id || !headerMap.customer_name || !headerMap.sales_note_history) {
    writeHandoffReport_(reportSheet, headers, [[markedAt, '', '', '', '', '', '', 'missing_lead_id_customer_name_or_sales_note_history_header', '', '']]);
    return { marked: 0, report_sheet: HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME };
  }

  const rowCount = leadsSheet.getLastRow() - DATA_START_ROW + 1;
  const values = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, leadsSheet.getLastColumn()).getValues();
  const displays = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, leadsSheet.getLastColumn()).getDisplayValues();
  let marked = 0;
  let alreadyMarked = 0;
  let skippedAlreadyMarkedWithoutOriginalFormat = 0;

  values.forEach(function (row, index) {
    const noteHistory = String(row[headerMap.sales_note_history - 1] || '').trim();
    const reasons = getSuspiciousSalesNoteHistoryReasons_(noteHistory);
    if (!reasons.length) return;

    const sheetRow = DATA_START_ROW + index;
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const markerCell = leadsSheet.getRange(sheetRow, headerMap.customer_name);
    const currentBackground = String(markerCell.getBackground() || '').toLowerCase();
    const currentFontColor = String(markerCell.getFontColor() || '').trim();
    const previousFormat = existingMarkerFormats[leadId] || null;
    const isAlreadyMarked = currentBackground === HANDOFF_NOTE_MARKER_BACKGROUND;
    if (isAlreadyMarked && !previousFormat) {
      skippedAlreadyMarkedWithoutOriginalFormat++;
      return;
    }

    rows.push([
      markedAt,
      sheetRow,
      leadId,
      String(displays[index][headerMap.customer_name - 1] || ''),
      noteHistory.length,
      countMatches_(noteHistory, /\n/g),
      countDuplicateNoteHistoryEntries_(noteHistory),
      reasons.join(', '),
      previousFormat ? previousFormat.previousBackground : currentBackground,
      previousFormat ? previousFormat.previousFontColor : currentFontColor,
    ]);
    if (isAlreadyMarked) {
      alreadyMarked++;
      return;
    }

    markerCell
      .setBackground(HANDOFF_NOTE_MARKER_BACKGROUND)
      .setFontColor(HANDOFF_NOTE_MARKER_FONT);
    marked++;
  });

  writeHandoffReport_(reportSheet, headers, rows);
  return {
    marked: marked,
    already_marked: alreadyMarked,
    skipped_already_marked_without_original_format: skippedAlreadyMarkedWithoutOriginalFormat,
    report_sheet: HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME,
  };
}

function clearSuspiciousSalesNoteHistoryMarkersForHandoff() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const reportSheet = ss.getSheetByName(HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME);
  if (!leadsSheet || !reportSheet || reportSheet.getLastRow() < 2) {
    return { restored: 0 };
  }

  const headerMap = getHeaderMap_(reportSheet);
  const rows = reportSheet.getRange(2, 1, reportSheet.getLastRow() - 1, reportSheet.getLastColumn()).getValues();
  const leadsHeaderMap = getHeaderMap_(leadsSheet);
  let restored = 0;
  let skippedMovedOrMismatched = 0;

  rows.forEach(function (row) {
    const sheetRow = Number(row[headerMap.row - 1]);
    const reportLeadId = String(row[headerMap.lead_id - 1] || '').trim();
    const previousBackground = String(row[headerMap.previous_background - 1] || '').trim();
    const previousFontColor = String(row[headerMap.previous_font_color - 1] || '').trim();
    if (!sheetRow || sheetRow < DATA_START_ROW || !leadsHeaderMap.customer_name || !leadsHeaderMap.lead_id) return;

    const currentLeadId = String(leadsSheet.getRange(sheetRow, leadsHeaderMap.lead_id).getValue() || '').trim();
    if (!reportLeadId || currentLeadId !== reportLeadId) {
      skippedMovedOrMismatched++;
      return;
    }
    const cell = leadsSheet.getRange(sheetRow, leadsHeaderMap.customer_name);
    if (String(cell.getBackground() || '').toLowerCase() !== HANDOFF_NOTE_MARKER_BACKGROUND) return;
    if (previousBackground) cell.setBackground(previousBackground);
    if (previousFontColor) cell.setFontColor(previousFontColor);
    restored++;
  });

  return { restored: restored, skipped_moved_or_mismatched: skippedMovedOrMismatched };
}

function auditHandoffTestLeadCleanupCandidates() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_TEST_LEAD_CLEANUP_REPORT_SHEET_NAME);
  const headers = [
    'audit_at',
    'input_LEADS_row',
    'resolved_lead_id',
    'sheet_name',
    'matched_row',
    'customer_name',
    'phone',
    'source_or_type',
    'status',
    'clearly_test_candidate',
    'recommendation',
    'notes',
  ];
  const rows = [];
  const auditAt = new Date();

  if (!leadsSheet) {
    writeHandoffReport_(reportSheet, headers, [[auditAt, '', '', 'LEADS', '', '', '', '', '', 'no', 'manual_review', 'Missing LEADS sheet.']]);
    return { rows_written: 1, report_sheet: HANDOFF_TEST_LEAD_CLEANUP_REPORT_SHEET_NAME };
  }

  const targetLeadIdsByRow = resolveHandoffLeadIdsFromLeadsRows_(leadsSheet, HANDOFF_TEST_LEADS_ROWS);
  HANDOFF_TEST_LEADS_ROWS.forEach(function (inputRow) {
    const leadId = targetLeadIdsByRow[inputRow] || '';
    if (!leadId) {
      rows.push([auditAt, inputRow, '', 'LEADS', inputRow, '', '', '', '', 'no', 'leave_or_manual_review', 'No Lead ID found at this LEADS row. Do not delete by row number.']);
      return;
    }

    let relatedCount = 0;
    HANDOFF_RELATED_LEAD_SHEETS.forEach(function (sheetName) {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        rows.push([auditAt, inputRow, leadId, sheetName, '', '', '', '', '', 'no', 'manual_review', 'Related sheet not found.']);
        return;
      }

      const matches = findHandoffLeadIdRows_(sheet, leadId);
      if (!matches.length) {
        rows.push([auditAt, inputRow, leadId, sheetName, '', '', '', '', '', 'no', 'no_action_in_this_sheet', 'Lead ID not found in this sheet.']);
        return;
      }

      relatedCount += matches.length;
      matches.forEach(function (record) {
        const clearlyTest = isHandoffClearlyTestCandidate_(record.customerName, record.phone, record.sourceOrType, record.status, record.note);
        const recommendation = clearlyTest
          ? 'review_then_mark_cancelled_or_delete_by_lead_id_across_related_sheets'
          : 'leave_or_manual_review';
        rows.push([
          auditAt,
          inputRow,
          leadId,
          sheetName,
          record.row,
          record.customerName,
          record.phone,
          record.sourceOrType,
          record.status,
          clearlyTest ? 'yes' : 'no',
          recommendation,
          sheetName === 'LEADS' && relatedCount > 0 ? 'Deleting only from LEADS can be recreated by sync/repair if LEADS_MAIN remains.' : record.notePreview,
        ]);
      });
    });
  });

  writeHandoffReport_(reportSheet, headers, rows);
  return { rows_written: rows.length, report_sheet: HANDOFF_TEST_LEAD_CLEANUP_REPORT_SHEET_NAME };
}

function getHandoffSheetVisualPolishChecklist() {
  return {
    safe_now_manual_only: [
      'Name a version before visual work.',
      'Freeze row 1 and row 2 where applicable.',
      'Wrap Sales Note History and note-heavy columns.',
      'Use vertical align top for LEADS rows.',
      'Apply date format dd/MM/yyyy HH:mm only after date report review.',
      'Format phone/source ID columns as text.',
      'Hide internal report/audit/backup tabs after review.',
    ],
    do_not_do_without_approval: [
      'Do not protect Sales Note History.',
      'Do not delete rows by visible row number.',
      'Do not run broad production date sort.',
      'Do not run import, repair, restore, backfill, or full sync.',
    ],
  };
}

function parseHandoffDateValue_(rawValue, displayValue) {
  if (typeof parseLeadsDateAuditCellValue_ === 'function') {
    return parseLeadsDateAuditCellValue_(rawValue, displayValue, {
      source: 'LEADS.facebook_created_time',
      rejectAmbiguousSlashText: true,
    });
  }

  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    return { parsedDate: rawValue, epochMs: rawValue.getTime(), kind: 'date_object_safe', parserBranch: 'date_object' };
  }
  if (typeof rawValue === 'number' && isFinite(rawValue) && rawValue > 20000) {
    const parsed = new Date(Math.round((rawValue - 25569) * 86400 * 1000));
    return { parsedDate: isNaN(parsed.getTime()) ? null : parsed, epochMs: isNaN(parsed.getTime()) ? null : parsed.getTime(), kind: 'sheets_serial_number', parserBranch: 'fallback_sheets_serial' };
  }
  return { parsedDate: null, epochMs: null, kind: rawValue ? 'unsupported_text' : 'blank', parserBranch: 'fallback' };
}

function getHandoffDateReviewReasons_(rawValue, displayValue, numberFormat, parsed, previousEpoch) {
  const reasons = [];
  const display = String(displayValue || '').trim();
  const format = String(numberFormat || '').trim();
  const rawType = getHandoffValueType_(rawValue);

  if (!display && (rawValue === '' || rawValue === null || rawValue === undefined)) reasons.push('blank_date');
  if (rawType === 'string') reasons.push('string_date');
  if (parsed && parsed.kind === 'ambiguous_slash_date') reasons.push('ambiguous_date');
  if (parsed && parsed.kind === 'invalid_date') reasons.push('invalid_date');
  if (/m{1,2}\/d{1,2}\/y{2,4}/i.test(format) || format.indexOf('MM/dd') !== -1) reasons.push('mixed_format_number_format');
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(display) && format && format !== LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT) reasons.push('mixed_format_display');
  if (previousEpoch !== null && previousEpoch !== undefined && parsed && parsed.epochMs !== null && parsed.epochMs !== undefined && parsed.epochMs < previousEpoch) {
    reasons.push('out_of_order_candidate');
  }
  if (rawType === 'Date object' && reasons.length === 1 && reasons[0] === 'mixed_format_display') {
    reasons.push('underlying_date_may_be_valid_display_only');
  }
  return reasons;
}

function getSuspiciousSalesNoteHistoryReasons_(noteHistory) {
  const text = String(noteHistory || '').trim();
  const reasons = [];
  if (!text) return reasons;

  const newlineCount = countMatches_(text, /\n/g);
  const duplicateCount = countDuplicateNoteHistoryEntries_(text);
  if (text.length >= 1500) reasons.push('very_long_note_history');
  if (newlineCount >= 12) reasons.push('many_line_breaks');
  if (duplicateCount > 0) reasons.push('possible_repeated_note_blocks');
  return reasons;
}

function countDuplicateNoteHistoryEntries_(noteHistory) {
  const entries = splitHandoffNoteHistoryEntries_(noteHistory);
  const seen = {};
  let duplicates = 0;
  entries.forEach(function (entry) {
    const key = normalizeHandoffNoteEntry_(entry);
    if (!key) return;
    if (seen[key]) duplicates++;
    seen[key] = true;
  });
  return duplicates;
}

function splitHandoffNoteHistoryEntries_(noteHistory) {
  return String(noteHistory || '')
    .split(/\n\s*\n|\n(?=\[[^\]]+\])/)
    .map(function (entry) { return String(entry || '').trim(); })
    .filter(Boolean);
}

function normalizeHandoffNoteEntry_(entry) {
  return String(entry || '')
    .trim()
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getExistingHandoffMarkerFormatMap_(reportSheet) {
  const result = {};
  if (!reportSheet || reportSheet.getRange(1, 1).getNote() !== HANDOFF_REPORT_SHEET_NOTE || reportSheet.getLastRow() < 2) return result;

  const headerMap = getHeaderMap_(reportSheet);
  if (!headerMap.lead_id || !headerMap.previous_background || !headerMap.previous_font_color) return result;

  const values = reportSheet.getRange(2, 1, reportSheet.getLastRow() - 1, reportSheet.getLastColumn()).getValues();
  values.forEach(function (row) {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId || result[leadId]) return;
    result[leadId] = {
      previousBackground: String(row[headerMap.previous_background - 1] || '').trim(),
      previousFontColor: String(row[headerMap.previous_font_color - 1] || '').trim(),
    };
  });
  return result;
}

function resolveHandoffLeadIdsFromLeadsRows_(leadsSheet, rows) {
  const result = {};
  if (!leadsSheet || !rows || !rows.length) return result;
  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id) return result;
  rows.forEach(function (rowNumber) {
    if (rowNumber < DATA_START_ROW || rowNumber > leadsSheet.getLastRow()) return;
    result[rowNumber] = String(leadsSheet.getRange(rowNumber, headerMap.lead_id).getValue() || '').trim();
  });
  return result;
}

function findHandoffLeadIdRows_(sheet, leadId) {
  const records = [];
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return records;
  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id) return records;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach(function (row, index) {
    if (String(row[headerMap.lead_id - 1] || '').trim() !== leadId) return;
    records.push({
      row: DATA_START_ROW + index,
      customerName: getFirstHandoffField_(row, headerMap, ['customer_name', 'original_customer_name', 'name']),
      phone: getFirstHandoffField_(row, headerMap, ['phone', 'raw_phone']),
      sourceOrType: getFirstHandoffField_(row, headerMap, ['source', 'created_source', 'action_type', 'sheet_name']),
      status: getFirstHandoffField_(row, headerMap, ['lead_status', 'status', 'payment_status', 'install_status']),
      note: getFirstHandoffField_(row, headerMap, ['sales_note_history', 'note', 'additional_note']),
      notePreview: String(getFirstHandoffField_(row, headerMap, ['sales_note_history', 'note', 'additional_note']) || '').slice(0, 300),
    });
  });
  return records;
}

function getFirstHandoffField_(row, headerMap, fields) {
  for (let index = 0; index < fields.length; index++) {
    const column = headerMap[normalizeHeaderName_(fields[index])];
    const value = column ? String(row[column - 1] || '').trim() : '';
    if (value) return value;
  }
  return '';
}

function isHandoffClearlyTestCandidate_(customerName, phone, sourceOrType, status, note) {
  const haystack = [customerName, phone, sourceOrType, status, note].join(' ').toLowerCase();
  return haystack.indexOf('test manual lead') !== -1
    || haystack.indexOf('test manual note') !== -1
    || haystack.indexOf('test sales owner') !== -1
    || haystack.indexOf('0899999999') !== -1
    || haystack.indexOf('899999999') !== -1
    || haystack.indexOf('manual test') !== -1
    || haystack.indexOf('ทดสอบ') !== -1;
}

function getOrCreateHandoffReportSheet_(sheetName) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1).setNote(HANDOFF_REPORT_SHEET_NOTE);
  }
  return sheet;
}

function writeHandoffReport_(sheet, headers, rows) {
  if (sheet.getRange(1, 1).getNote() !== HANDOFF_REPORT_SHEET_NOTE) {
    throw new Error('Refusing to clear sheet without handoff helper marker note: ' + sheet.getName());
  }
  sheet.clearContents();
  sheet.getRange(1, 1).setNote(HANDOFF_REPORT_SHEET_NOTE);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows && rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  if (sheet.getMaxColumns() > headers.length) {
    sheet.getRange(1, headers.length + 1, Math.max(sheet.getLastRow(), 1), sheet.getMaxColumns() - headers.length).clearContent();
  }
}

function serializeHandoffValue_(value) {
  if (typeof serializeLeadsDateAuditValue_ === 'function') return serializeLeadsDateAuditValue_(value);
  if (value instanceof Date) return isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value === null || value === undefined) return '';
  return String(value);
}

function getHandoffValueType_(value) {
  if (typeof getLeadsDateAuditValueType_ === 'function') return getLeadsDateAuditValueType_(value);
  if (value instanceof Date) return isNaN(value.getTime()) ? 'Invalid Date object' : 'Date object';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}

function formatHandoffDate_(date) {
  if (typeof formatLeadsDateAuditDate_ === 'function') return formatLeadsDateAuditDate_(date);
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
}

function countMatches_(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}
