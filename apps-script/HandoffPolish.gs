// Final handoff polish helpers. These functions are manual-only and are not wired
// into onOpen so they cannot run unless an administrator explicitly invokes them.
const HANDOFF_DATE_REVIEW_SHEET_NAME = '_HANDOFF_DATE_VISUAL_REVIEW';
const HANDOFF_NOTE_MARKER_REPORT_SHEET_NAME = '_HANDOFF_NOTE_HISTORY_MARKER_REPORT';
const HANDOFF_TEST_LEAD_CLEANUP_REPORT_SHEET_NAME = '_HANDOFF_TEST_LEAD_CLEANUP_DRY_RUN';
const HANDOFF_TEST_LEAD_DELETE_DRY_RUN_SHEET_NAME = '_HANDOFF_TEST_LEAD_DELETE_DRY_RUN';
const HANDOFF_TEST_LEAD_DELETE_APPLY_REPORT_SHEET_NAME = '_HANDOFF_TEST_LEAD_DELETE_APPLY_REPORT';
const HANDOFF_DATE_STRING_CONVERT_DRY_RUN_SHEET_NAME = '_HANDOFF_DATE_STRING_CONVERT_DRY_RUN';
const HANDOFF_DATE_STRING_CONVERT_APPLY_REPORT_SHEET_NAME = '_HANDOFF_DATE_STRING_CONVERT_APPLY_REPORT';
const HANDOFF_SALES_NOTE_DUP_DRY_RUN_SHEET_NAME = '_HANDOFF_SALES_NOTE_DUPLICATE_CLEANUP_DRY_RUN';
const HANDOFF_SALES_NOTE_DUP_APPLY_REPORT_SHEET_NAME = '_HANDOFF_SALES_NOTE_DUPLICATE_CLEANUP_APPLY_REPORT';
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

function dryRunHandoffSalesNoteHistoryDuplicateCleanup() {
  const ss = SpreadsheetApp.getActive();
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_SALES_NOTE_DUP_DRY_RUN_SHEET_NAME);
  const headers = getHandoffSalesNoteDuplicateCleanupReportHeaders_();
  const auditAt = new Date();
  const rows = [];
  let leadsCandidates = 0;
  let leadsMainCandidates = 0;

  ['LEADS', 'LEADS_MAIN'].forEach(function (sheetName) {
    const scope = sheetName === 'LEADS' ? 'apply_eligible' : 'report_only_not_apply_scope';
    const candidates = scanHandoffSalesNoteDuplicateCandidates_(ss, sheetName, auditAt, scope);
    if (sheetName === 'LEADS') leadsCandidates += candidates.candidateCount;
    if (sheetName === 'LEADS_MAIN') leadsMainCandidates += candidates.candidateCount;
    candidates.rows.forEach(function (row) { rows.push(row); });
  });

  rows.push(getHandoffSalesNoteDuplicateSummaryRow_(
    auditAt,
    'dry_run_summary',
    'leads_candidates=' + leadsCandidates + '; leads_main_report_only_candidates=' + leadsMainCandidates,
    'Dry run only. No Sales Note History cells were modified.'
  ));

  writeHandoffReport_(reportSheet, headers, rows);
  return {
    report_sheet: HANDOFF_SALES_NOTE_DUP_DRY_RUN_SHEET_NAME,
    leads_candidates: leadsCandidates,
    leads_main_report_only_candidates: leadsMainCandidates,
  };
}

function applyHandoffSalesNoteHistoryDuplicateCleanup(confirm) {
  const ss = SpreadsheetApp.getActive();
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_SALES_NOTE_DUP_APPLY_REPORT_SHEET_NAME);
  const headers = getHandoffSalesNoteDuplicateCleanupReportHeaders_();
  const auditAt = new Date();
  const rows = [];
  let cleaned = 0;
  let skipped = 0;

  if (confirm !== 'CONFIRM') {
    rows.push(getHandoffSalesNoteDuplicateSummaryRow_(
      auditAt,
      'refused',
      'confirm_required',
      'Call applyHandoffSalesNoteHistoryDuplicateCleanup("CONFIRM") only after reviewing the dry-run report.'
    ));
    writeHandoffReport_(reportSheet, headers, rows);
    return { cleaned: 0, skipped: 0, refused: true, reason: 'confirm_required', report_sheet: HANDOFF_SALES_NOTE_DUP_APPLY_REPORT_SHEET_NAME };
  }

  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) {
    rows.push(getHandoffSalesNoteDuplicateSummaryRow_(auditAt, 'refused', 'missing_or_empty_LEADS_sheet', 'LEADS sheet was not available.'));
    writeHandoffReport_(reportSheet, headers, rows);
    return { cleaned: 0, skipped: 0, refused: true, reason: 'missing_or_empty_LEADS_sheet', report_sheet: HANDOFF_SALES_NOTE_DUP_APPLY_REPORT_SHEET_NAME };
  }

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id || !headerMap.customer_name || !headerMap.sales_note_history) {
    rows.push(getHandoffSalesNoteDuplicateSummaryRow_(auditAt, 'refused', 'missing_required_headers', 'LEADS requires lead_id, customer_name, and sales_note_history headers.'));
    writeHandoffReport_(reportSheet, headers, rows);
    return { cleaned: 0, skipped: 0, refused: true, reason: 'missing_required_headers', report_sheet: HANDOFF_SALES_NOTE_DUP_APPLY_REPORT_SHEET_NAME };
  }

  const candidates = scanHandoffSalesNoteDuplicateCandidates_(ss, 'LEADS', auditAt, 'apply_eligible');
  candidates.items.forEach(function (item) {
    const leadIdCell = leadsSheet.getRange(item.row, headerMap.lead_id);
    const noteCell = leadsSheet.getRange(item.row, headerMap.sales_note_history);
    const currentLeadId = String(leadIdCell.getValue() || '').trim();
    const currentText = String(noteCell.getValue() || '');
    const currentCleanup = buildHandoffSalesNoteExactDuplicateCleanup_(currentText);

    if (!currentLeadId || currentLeadId !== item.leadId || currentText !== item.beforeText || !currentCleanup.changed) {
      skipped++;
      rows.push(getHandoffSalesNoteDuplicateReportRow_(
        auditAt,
        'LEADS',
        item.row,
        item.leadId,
        item.customerName,
        currentText.length,
        currentCleanup.cleanedText.length,
        currentCleanup.duplicateCount,
        currentCleanup.sampleDuplicate,
        currentCleanup.changed ? 'high_exact_block_match' : 'none',
        'Skipped because lead_id/value changed or no exact duplicate proof remained at apply time.',
        'skipped',
        'current_cell_not_eligible_or_changed',
        'No Sales Note History content was changed for this row.'
      ));
      return;
    }

    noteCell.setValue(currentCleanup.cleanedText);
    noteCell.setWrap(true);
    noteCell.setVerticalAlignment('top');
    cleaned++;
    rows.push(getHandoffSalesNoteDuplicateReportRow_(
      auditAt,
      'LEADS',
      item.row,
      item.leadId,
      item.customerName,
      item.beforeText.length,
      currentCleanup.cleanedText.length,
      currentCleanup.duplicateCount,
      currentCleanup.sampleDuplicate,
      'high_exact_block_match',
      'Exact duplicate note blocks removed; first occurrence preserved.',
      'cleaned',
      'duplicate_blocks_removed',
      'Sales Note History was rewritten only for this cell. Unique blocks were preserved in original order.'
    ));
  });

  rows.push(getHandoffSalesNoteDuplicateSummaryRow_(
    auditAt,
    'apply_summary',
    'cleaned=' + cleaned + '; skipped=' + skipped,
    'Apply scope was LEADS.sales_note_history only. LEADS_MAIN was not modified.'
  ));

  writeHandoffReport_(reportSheet, headers, rows);
  return { cleaned: cleaned, skipped: skipped, refused: false, report_sheet: HANDOFF_SALES_NOTE_DUP_APPLY_REPORT_SHEET_NAME };
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

function dryRunConfirmedTestLeadCleanupForHandoff() {
  const ss = SpreadsheetApp.getActive();
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_TEST_LEAD_DELETE_DRY_RUN_SHEET_NAME);
  const headers = getConfirmedTestLeadCleanupReportHeaders_();
  const plan = buildConfirmedTestLeadCleanupPlan_(ss);
  const rows = [];

  plan.resolutionRows.forEach(function (row) {
    rows.push(row);
  });

  plan.matches.forEach(function (match) {
    rows.push([
      plan.auditAt,
      match.inputRow,
      match.leadId,
      match.sheetName,
      match.row,
      match.customerName,
      match.phone,
      match.sourceOrType,
      match.status,
      'would_delete',
      'dry_run_only',
      'Exact lead_id match. No deletion performed by dry run.',
    ]);
  });

  plan.notFoundRows.forEach(function (row) {
    rows.push(row);
  });

  rows.push([
    plan.auditAt,
    '',
    plan.targetLeadIds.join(', '),
    'SUMMARY',
    '',
    '',
    '',
    '',
    '',
    'dry_run_summary',
    'total_rows_would_delete=' + plan.matches.length,
    plan.unresolvedRows.length ? 'WARNING: unresolved target LEADS rows: ' + plan.unresolvedRows.join(', ') : 'All target LEADS rows resolved to Lead ID.',
  ]);

  writeHandoffReport_(reportSheet, headers, rows);
  return {
    report_sheet: HANDOFF_TEST_LEAD_DELETE_DRY_RUN_SHEET_NAME,
    target_lead_ids: plan.targetLeadIds,
    unresolved_target_rows: plan.unresolvedRows,
    total_rows_would_delete: plan.matches.length,
  };
}

function applyConfirmedTestLeadCleanupForHandoff(confirm) {
  const ss = SpreadsheetApp.getActive();
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_TEST_LEAD_DELETE_APPLY_REPORT_SHEET_NAME);
  const headers = getConfirmedTestLeadCleanupReportHeaders_();
  const plan = buildConfirmedTestLeadCleanupPlan_(ss);
  const rows = [];
  let deleted = 0;
  let skipped = 0;

  if (confirm !== true) {
    rows.push([
      plan.auditAt,
      '',
      plan.targetLeadIds.join(', '),
      'SAFETY',
      '',
      '',
      '',
      '',
      '',
      'refused',
      'confirm_required',
      'Call applyConfirmedTestLeadCleanupForHandoff(true) only after reviewing dry-run output.',
    ]);
    writeHandoffReport_(reportSheet, headers, rows);
    return { deleted: 0, skipped: 0, refused: true, reason: 'confirm_required', report_sheet: HANDOFF_TEST_LEAD_DELETE_APPLY_REPORT_SHEET_NAME };
  }

  if (plan.unresolvedRows.length || !plan.targetLeadIds.length) {
    rows.push([
      plan.auditAt,
      '',
      plan.targetLeadIds.join(', '),
      'SAFETY',
      '',
      '',
      '',
      '',
      '',
      'refused',
      'unresolved_target_lead_ids',
      'Refusing to delete because every target LEADS row must resolve to a nonblank Lead ID. Unresolved rows: ' + plan.unresolvedRows.join(', '),
    ]);
    writeHandoffReport_(reportSheet, headers, rows);
    return { deleted: 0, skipped: 0, refused: true, reason: 'unresolved_target_lead_ids', unresolved_target_rows: plan.unresolvedRows, report_sheet: HANDOFF_TEST_LEAD_DELETE_APPLY_REPORT_SHEET_NAME };
  }

  plan.resolutionRows.forEach(function (row) {
    rows.push(row);
  });

  const matchesBySheet = groupConfirmedTestLeadMatchesBySheet_(plan.matches);
  Object.keys(matchesBySheet).forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    const sheetMatches = matchesBySheet[sheetName].sort(function (a, b) { return b.row - a.row; });
    const headerMap = sheet ? getHeaderMap_(sheet) : {};

    sheetMatches.forEach(function (match) {
      if (!sheet || !headerMap.lead_id) {
        skipped++;
        rows.push(getConfirmedTestLeadApplyRow_(plan.auditAt, match, 'skipped', 'missing_sheet_or_lead_id_header', 'Sheet or lead_id header was not available at apply time.'));
        return;
      }

      const currentLeadId = String(sheet.getRange(match.row, headerMap.lead_id).getValue() || '').trim();
      if (!currentLeadId || currentLeadId !== match.leadId || plan.targetLeadIdSet[currentLeadId] !== true) {
        skipped++;
        rows.push(getConfirmedTestLeadApplyRow_(plan.auditAt, match, 'skipped', 'lead_id_mismatch_or_blank', 'Current row lead_id did not exactly match the confirmed target Lead ID at apply time.'));
        return;
      }

      sheet.deleteRow(match.row);
      deleted++;
      rows.push(getConfirmedTestLeadApplyRow_(plan.auditAt, match, 'deleted', 'exact_lead_id_match', 'Deleted bottom-up within sheet after exact lead_id verification.'));
    });
  });

  plan.notFoundRows.forEach(function (row) {
    rows.push(row);
  });

  rows.push([
    plan.auditAt,
    '',
    plan.targetLeadIds.join(', '),
    'SUMMARY',
    '',
    '',
    '',
    '',
    '',
    'apply_summary',
    'deleted=' + deleted + '; skipped=' + skipped,
    'Only exact lead_id matches from the confirmed target list were eligible for deletion.',
  ]);

  writeHandoffReport_(reportSheet, headers, rows);
  return { deleted: deleted, skipped: skipped, refused: false, report_sheet: HANDOFF_TEST_LEAD_DELETE_APPLY_REPORT_SHEET_NAME };
}

function dryRunHandoffFacebookCreatedTimeStringDateConversion() {
  const ss = SpreadsheetApp.getActive();
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_DATE_STRING_CONVERT_DRY_RUN_SHEET_NAME);
  const headers = getHandoffDateStringConversionReportHeaders_();
  const plan = buildHandoffFacebookCreatedTimeStringDateConversionPlan_(ss);
  const rows = plan.reportRows.slice();

  rows.push(getHandoffDateStringConversionSummaryRow_(
    plan.auditAt,
    'dry_run_summary',
    'would_convert=' + plan.eligibleCount + '; skipped=' + plan.skippedCount,
    'Dry run only. No LEADS cells were modified.'
  ));

  writeHandoffReport_(reportSheet, headers, rows);
  return {
    report_sheet: HANDOFF_DATE_STRING_CONVERT_DRY_RUN_SHEET_NAME,
    would_convert: plan.eligibleCount,
    skipped: plan.skippedCount,
  };
}

function applyHandoffFacebookCreatedTimeStringDateConversion(confirm) {
  const ss = SpreadsheetApp.getActive();
  const reportSheet = getOrCreateHandoffReportSheet_(HANDOFF_DATE_STRING_CONVERT_APPLY_REPORT_SHEET_NAME);
  const headers = getHandoffDateStringConversionReportHeaders_();
  const plan = buildHandoffFacebookCreatedTimeStringDateConversionPlan_(ss);
  const rows = [];
  let converted = 0;
  let skipped = 0;

  if (confirm !== true) {
    rows.push(getHandoffDateStringConversionSummaryRow_(
      plan.auditAt,
      'refused',
      'confirm_required',
      'Call applyHandoffFacebookCreatedTimeStringDateConversion(true) only after reviewing the dry-run report.'
    ));
    writeHandoffReport_(reportSheet, headers, rows);
    return { converted: 0, skipped: 0, refused: true, reason: 'confirm_required', report_sheet: HANDOFF_DATE_STRING_CONVERT_APPLY_REPORT_SHEET_NAME };
  }

  if (!plan.leadsSheet || !plan.headerMap.facebook_created_time) {
    rows.push(getHandoffDateStringConversionSummaryRow_(
      plan.auditAt,
      'refused',
      'missing_LEADS_or_facebook_created_time_header',
      'Refusing to apply because LEADS or facebook_created_time header was not available.'
    ));
    writeHandoffReport_(reportSheet, headers, rows);
    return { converted: 0, skipped: 0, refused: true, reason: 'missing_LEADS_or_facebook_created_time_header', report_sheet: HANDOFF_DATE_STRING_CONVERT_APPLY_REPORT_SHEET_NAME };
  }

  plan.items.forEach(function (item) {
    const currentCell = plan.leadsSheet.getRange(item.row, plan.headerMap.facebook_created_time);
    const currentValue = currentCell.getValue();
    const currentDisplay = currentCell.getDisplayValue();
    const currentRawType = getHandoffValueType_(currentValue);
    const currentText = typeof currentValue === 'string' ? String(currentValue).trim() : '';
    const currentCandidate = parseHandoffUsFacebookCreatedTimeString_(currentText, item.isReviewTarget);

    if (!item.eligible || currentRawType !== 'string' || currentText !== item.rawValue || !currentCandidate.eligible) {
      skipped++;
      rows.push(getHandoffDateStringConversionReportRow_(
        plan.auditAt,
        item.row,
        item.leadId,
        item.customerName,
        serializeHandoffValue_(currentValue),
        currentRawType,
        currentDisplay,
        currentCandidate.parsedDate ? formatHandoffDateStringTargetDisplay_(currentCandidate.parsedDate) : '',
        currentCandidate.parsedDate ? formatHandoffDateStringTargetDisplay_(currentCandidate.parsedDate) : '',
        'LEADS.facebook_created_time',
        'skipped',
        'current_cell_not_eligible_or_changed',
        'Apply re-read skipped this cell because the current value no longer exactly matches an eligible string.'
      ));
      return;
    }

    currentCell.setValue(currentCandidate.parsedDate);
    currentCell.setNumberFormat(LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT);
    converted++;
    rows.push(getHandoffDateStringConversionReportRow_(
      plan.auditAt,
      item.row,
      item.leadId,
      item.customerName,
      item.rawValue,
      item.rawType,
      item.currentDisplayValue,
      item.parsedAs,
      item.targetDisplayValue,
      'LEADS.facebook_created_time',
      'converted',
      'converted',
      'Converted string MM/DD/YYYY time to Date object and applied dd/MM/yyyy HH:mm format. No sorting performed.'
    ));
  });

  plan.skippedReportRows.forEach(function (row) {
    skipped++;
    rows.push(row);
  });

  rows.push(getHandoffDateStringConversionSummaryRow_(
    plan.auditAt,
    'apply_summary',
    'converted=' + converted + '; skipped=' + skipped,
    'No sort, row move, or other date column updates were performed.'
  ));

  writeHandoffReport_(reportSheet, headers, rows);
  return { converted: converted, skipped: skipped, refused: false, report_sheet: HANDOFF_DATE_STRING_CONVERT_APPLY_REPORT_SHEET_NAME };
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

function getConfirmedTestLeadCleanupReportHeaders_() {
  return [
    'audit_at',
    'input_LEADS_row',
    'resolved_lead_id',
    'sheet_name',
    'matched_row',
    'customer_name',
    'phone',
    'source_or_type',
    'status',
    'action',
    'result',
    'notes',
  ];
}

function buildConfirmedTestLeadCleanupPlan_(ss) {
  const auditAt = new Date();
  const leadsSheet = ss.getSheetByName('LEADS');
  const targetLeadIdsByRow = resolveHandoffLeadIdsFromLeadsRows_(leadsSheet, HANDOFF_TEST_LEADS_ROWS);
  const targetLeadIdSet = {};
  const targetLeadIds = [];
  const unresolvedRows = [];
  const resolutionRows = [];
  const notFoundRows = [];
  const matches = [];

  HANDOFF_TEST_LEADS_ROWS.forEach(function (inputRow) {
    const leadId = String(targetLeadIdsByRow[inputRow] || '').trim();
    if (!leadId) {
      unresolvedRows.push(inputRow);
      resolutionRows.push([
        auditAt,
        inputRow,
        '',
        'LEADS',
        inputRow,
        '',
        '',
        '',
        '',
        'resolve_target',
        'unresolved',
        'No Lead ID found at this LEADS row. Cleanup must not delete by row number alone.',
      ]);
      return;
    }

    if (!targetLeadIdSet[leadId]) {
      targetLeadIdSet[leadId] = true;
      targetLeadIds.push(leadId);
    }
    resolutionRows.push([
      auditAt,
      inputRow,
      leadId,
      'LEADS',
      inputRow,
      '',
      '',
      '',
      '',
      'resolve_target',
      'resolved',
      'Target LEADS row resolved to Lead ID. Deletion eligibility still requires exact lead_id matches in each sheet.',
    ]);
  });

  HANDOFF_RELATED_LEAD_SHEETS.forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      targetLeadIds.forEach(function (leadId) {
        notFoundRows.push([
          auditAt,
          getInputRowForHandoffLeadId_(targetLeadIdsByRow, leadId),
          leadId,
          sheetName,
          '',
          '',
          '',
          '',
          '',
          'scan',
          'skipped_missing_sheet',
          'Related sheet not found.',
        ]);
      });
      return;
    }

    const headerMap = getHeaderMap_(sheet);
    if (!headerMap.lead_id) {
      targetLeadIds.forEach(function (leadId) {
        notFoundRows.push([
          auditAt,
          getInputRowForHandoffLeadId_(targetLeadIdsByRow, leadId),
          leadId,
          sheetName,
          '',
          '',
          '',
          '',
          '',
          'scan',
          'skipped_missing_lead_id_header',
          'Sheet does not have a lead_id header, so no rows are eligible for deletion here.',
        ]);
      });
      return;
    }

    targetLeadIds.forEach(function (leadId) {
      const found = findHandoffLeadIdRows_(sheet, leadId);
      if (!found.length) {
        notFoundRows.push([
          auditAt,
          getInputRowForHandoffLeadId_(targetLeadIdsByRow, leadId),
          leadId,
          sheetName,
          '',
          '',
          '',
          '',
          '',
          'scan',
          'not_found',
          'Lead ID not found in this sheet.',
        ]);
        return;
      }

      found.forEach(function (record) {
        matches.push({
          inputRow: getInputRowForHandoffLeadId_(targetLeadIdsByRow, leadId),
          leadId: leadId,
          sheetName: sheetName,
          row: record.row,
          customerName: record.customerName,
          phone: record.phone,
          sourceOrType: record.sourceOrType,
          status: record.status,
        });
      });
    });
  });

  return {
    auditAt: auditAt,
    targetLeadIdsByRow: targetLeadIdsByRow,
    targetLeadIds: targetLeadIds,
    targetLeadIdSet: targetLeadIdSet,
    unresolvedRows: unresolvedRows,
    resolutionRows: resolutionRows,
    matches: matches,
    notFoundRows: notFoundRows,
  };
}

function groupConfirmedTestLeadMatchesBySheet_(matches) {
  const result = {};
  matches.forEach(function (match) {
    if (!result[match.sheetName]) result[match.sheetName] = [];
    result[match.sheetName].push(match);
  });
  return result;
}

function getConfirmedTestLeadApplyRow_(auditAt, match, action, result, notes) {
  return [
    auditAt,
    match.inputRow,
    match.leadId,
    match.sheetName,
    match.row,
    match.customerName,
    match.phone,
    match.sourceOrType,
    match.status,
    action,
    result,
    notes,
  ];
}

function getInputRowForHandoffLeadId_(leadIdsByRow, leadId) {
  const rows = Object.keys(leadIdsByRow || {});
  for (let index = 0; index < rows.length; index++) {
    const rowNumber = rows[index];
    if (String(leadIdsByRow[rowNumber] || '').trim() === leadId) return Number(rowNumber);
  }
  return '';
}

function getHandoffDateStringConversionReportHeaders_() {
  return [
    'audit_at',
    'row',
    'lead_id',
    'customer_name',
    'raw_value',
    'raw_type',
    'current_display_value',
    'parsed_as',
    'target_display_value',
    'source_field',
    'action',
    'result',
    'notes',
  ];
}

function buildHandoffFacebookCreatedTimeStringDateConversionPlan_(ss) {
  const auditAt = new Date();
  const leadsSheet = ss.getSheetByName('LEADS');
  const reportRows = [];
  const skippedReportRows = [];
  const items = [];
  let eligibleCount = 0;
  let skippedCount = 0;

  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) {
    skippedCount++;
    reportRows.push(getHandoffDateStringConversionSummaryRow_(auditAt, 'skipped', 'missing_or_empty_LEADS_sheet', 'LEADS sheet was not available.'));
    return { auditAt: auditAt, leadsSheet: leadsSheet, headerMap: {}, reportRows: reportRows, skippedReportRows: skippedReportRows, items: items, eligibleCount: eligibleCount, skippedCount: skippedCount };
  }

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id || !headerMap.facebook_created_time) {
    skippedCount++;
    reportRows.push(getHandoffDateStringConversionSummaryRow_(auditAt, 'skipped', 'missing_required_headers', 'LEADS requires lead_id and facebook_created_time headers.'));
    return { auditAt: auditAt, leadsSheet: leadsSheet, headerMap: headerMap, reportRows: reportRows, skippedReportRows: skippedReportRows, items: items, eligibleCount: eligibleCount, skippedCount: skippedCount };
  }

  const reviewTargets = getHandoffDateStringReviewTargetMap_(ss);
  const rowCount = leadsSheet.getLastRow() - DATA_START_ROW + 1;
  const lastColumn = leadsSheet.getLastColumn();
  const values = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getValues();
  const displays = leadsSheet.getRange(DATA_START_ROW, 1, rowCount, lastColumn).getDisplayValues();

  values.forEach(function (row, index) {
    const sheetRow = DATA_START_ROW + index;
    const rawValue = row[headerMap.facebook_created_time - 1];
    if (rawValue === '' || rawValue === null || rawValue === undefined || rawValue instanceof Date || typeof rawValue !== 'string') return;

    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const customerName = headerMap.customer_name ? String(displays[index][headerMap.customer_name - 1] || '') : '';
    const currentDisplayValue = String(displays[index][headerMap.facebook_created_time - 1] || '');
    const rawText = String(rawValue || '').trim();
    const isReviewTarget = reviewTargets[sheetRow] === true;
    const candidate = parseHandoffUsFacebookCreatedTimeString_(rawText, isReviewTarget);
    const base = {
      row: sheetRow,
      leadId: leadId,
      customerName: customerName,
      rawValue: rawText,
      rawType: getHandoffValueType_(rawValue),
      currentDisplayValue: currentDisplayValue,
      parsedAs: candidate.parsedDate ? formatHandoffDateStringTargetDisplay_(candidate.parsedDate) : '',
      targetDisplayValue: candidate.parsedDate ? formatHandoffDateStringTargetDisplay_(candidate.parsedDate) : '',
      isReviewTarget: isReviewTarget,
      eligible: candidate.eligible,
    };

    if (candidate.eligible) {
      eligibleCount++;
      items.push(base);
      reportRows.push(getHandoffDateStringConversionReportRow_(
        auditAt,
        sheetRow,
        leadId,
        customerName,
        rawText,
        base.rawType,
        currentDisplayValue,
        base.parsedAs,
        base.targetDisplayValue,
        'LEADS.facebook_created_time',
        'would_convert',
        'eligible',
        candidate.reason
      ));
      return;
    }

    skippedCount++;
    const skippedRow = getHandoffDateStringConversionReportRow_(
      auditAt,
      sheetRow,
      leadId,
      customerName,
      rawText,
      base.rawType,
      currentDisplayValue,
      base.parsedAs,
      base.targetDisplayValue,
      'LEADS.facebook_created_time',
      'skipped',
      candidate.result,
      candidate.reason
    );
    reportRows.push(skippedRow);
    skippedReportRows.push(skippedRow);
  });

  return {
    auditAt: auditAt,
    leadsSheet: leadsSheet,
    headerMap: headerMap,
    reportRows: reportRows,
    skippedReportRows: skippedReportRows,
    items: items,
    eligibleCount: eligibleCount,
    skippedCount: skippedCount,
  };
}

function parseHandoffUsFacebookCreatedTimeString_(value, isReviewTarget) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return { eligible: false, result: 'not_clear_us_datetime_string', reason: 'String does not match MM/DD/YYYY HH:mm or MM/DD/YYYY HH:mm:ss.', parsedDate: null };
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return { eligible: false, result: 'invalid_datetime_parts', reason: 'Date/time parts are outside allowed ranges.', parsedDate: null };
  }

  const parsedDate = new Date(year, month - 1, day, hour, minute, second);
  if (parsedDate.getFullYear() !== year || parsedDate.getMonth() !== month - 1 || parsedDate.getDate() !== day || parsedDate.getHours() !== hour || parsedDate.getMinutes() !== minute || parsedDate.getSeconds() !== second) {
    return { eligible: false, result: 'invalid_calendar_date', reason: 'Date does not round-trip as a real calendar date.', parsedDate: null };
  }

  if (day <= 12 && !isReviewTarget) {
    return { eligible: false, result: 'ambiguous_day_month_without_review_target', reason: 'Day is 12 or less; skipped unless latest handoff date visual review scoped this row as string_date/ambiguous_date.', parsedDate: parsedDate };
  }

  return {
    eligible: true,
    result: 'eligible_us_style_string',
    reason: day > 12 ? 'Clear US-style string because day is greater than 12.' : 'Eligible because latest handoff date visual review scoped this row as string_date/ambiguous_date.',
    parsedDate: parsedDate,
  };
}

function getHandoffDateStringReviewTargetMap_(ss) {
  const result = {};
  const sheet = ss.getSheetByName(HANDOFF_DATE_REVIEW_SHEET_NAME);
  if (!sheet || sheet.getRange(1, 1).getNote() !== HANDOFF_REPORT_SHEET_NOTE || sheet.getLastRow() < 2) return result;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.row || !headerMap.source_field || !headerMap.reason) return result;

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  values.forEach(function (row) {
    const sheetRow = Number(row[headerMap.row - 1]);
    const sourceField = String(row[headerMap.source_field - 1] || '').trim();
    const reason = String(row[headerMap.reason - 1] || '').trim();
    if (!sheetRow || sourceField !== 'LEADS.facebook_created_time') return;
    if (reason.indexOf('string_date') !== -1 || reason.indexOf('ambiguous_date') !== -1) result[sheetRow] = true;
  });
  return result;
}

function getHandoffDateStringConversionReportRow_(auditAt, row, leadId, customerName, rawValue, rawType, currentDisplayValue, parsedAs, targetDisplayValue, sourceField, action, result, notes) {
  return [
    auditAt,
    row,
    leadId,
    customerName,
    rawValue,
    rawType,
    currentDisplayValue,
    parsedAs,
    targetDisplayValue,
    sourceField,
    action,
    result,
    notes,
  ];
}

function getHandoffDateStringConversionSummaryRow_(auditAt, action, result, notes) {
  return getHandoffDateStringConversionReportRow_(
    auditAt,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'LEADS.facebook_created_time',
    action,
    result,
    notes
  );
}

function formatHandoffDateStringTargetDisplay_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Bangkok', LEADS_DATE_AUDIT_TARGET_DATETIME_FORMAT);
}

function getHandoffSalesNoteDuplicateCleanupReportHeaders_() {
  return [
    'audit_at',
    'sheet_name',
    'row',
    'lead_id',
    'customer_name',
    'before_length',
    'after_length',
    'duplicate_block_count',
    'sample_duplicated_block',
    'confidence',
    'reason',
    'action',
    'result',
    'notes',
  ];
}

function scanHandoffSalesNoteDuplicateCandidates_(ss, sheetName, auditAt, scope) {
  const sheet = ss.getSheetByName(sheetName);
  const rows = [];
  const items = [];
  let candidateCount = 0;

  if (!sheet || sheet.getLastRow() < DATA_START_ROW) {
    rows.push(getHandoffSalesNoteDuplicateReportRow_(
      auditAt,
      sheetName,
      '',
      '',
      '',
      '',
      '',
      0,
      '',
      'none',
      'Sheet missing or empty.',
      'skipped',
      'missing_or_empty_sheet',
      'No Sales Note History cells were inspected for this sheet.'
    ));
    return { rows: rows, items: items, candidateCount: candidateCount };
  }

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.customer_name || !headerMap.sales_note_history) {
    rows.push(getHandoffSalesNoteDuplicateReportRow_(
      auditAt,
      sheetName,
      '',
      '',
      '',
      '',
      '',
      0,
      '',
      'none',
      'Required headers are missing.',
      'skipped',
      'missing_required_headers',
      'Requires lead_id, customer_name, and sales_note_history headers.'
    ));
    return { rows: rows, items: items, candidateCount: candidateCount };
  }

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const displays = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getDisplayValues();

  values.forEach(function (row, index) {
    const sheetRow = DATA_START_ROW + index;
    const beforeText = String(row[headerMap.sales_note_history - 1] || '');
    if (!beforeText.trim()) return;

    const cleanup = buildHandoffSalesNoteExactDuplicateCleanup_(beforeText);
    if (!cleanup.changed) return;

    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const customerName = String(displays[index][headerMap.customer_name - 1] || '');
    const action = sheetName === 'LEADS' ? 'would_clean' : 'report_only';
    const result = sheetName === 'LEADS' ? 'eligible_exact_duplicate_blocks' : 'not_apply_scope';
    const notes = sheetName === 'LEADS'
      ? 'Dry run only. Apply will re-read and verify this exact cell before rewriting.'
      : 'Reported separately only. Apply helper does not modify ' + sheetName + '.';

    candidateCount++;
    rows.push(getHandoffSalesNoteDuplicateReportRow_(
      auditAt,
      sheetName,
      sheetRow,
      leadId,
      customerName,
      beforeText.length,
      cleanup.cleanedText.length,
      cleanup.duplicateCount,
      cleanup.sampleDuplicate,
      'high_exact_block_match',
      'Exact duplicate note blocks found within the same Sales Note History cell; first occurrence would be preserved.',
      action,
      result,
      notes
    ));

    if (scope === 'apply_eligible' && sheetName === 'LEADS') {
      items.push({
        sheetName: sheetName,
        row: sheetRow,
        leadId: leadId,
        customerName: customerName,
        beforeText: beforeText,
        cleanedText: cleanup.cleanedText,
        duplicateCount: cleanup.duplicateCount,
        sampleDuplicate: cleanup.sampleDuplicate,
      });
    }
  });

  return { rows: rows, items: items, candidateCount: candidateCount };
}

function buildHandoffSalesNoteExactDuplicateCleanup_(text) {
  const originalText = String(text || '');
  const blocks = splitHandoffSalesNoteHistoryBlocks_(originalText);
  const seen = {};
  const kept = [];
  let duplicateCount = 0;
  let sampleDuplicate = '';

  blocks.forEach(function (block) {
    const key = normalizeHandoffSalesNoteExactBlockKey_(block);
    if (!key) return;
    if (seen[key]) {
      duplicateCount++;
      if (!sampleDuplicate) sampleDuplicate = block.slice(0, 500);
      return;
    }
    seen[key] = true;
    kept.push(block);
  });

  if (!duplicateCount || kept.length === blocks.length) {
    return {
      changed: false,
      cleanedText: originalText,
      duplicateCount: 0,
      sampleDuplicate: '',
    };
  }

  return {
    changed: true,
    cleanedText: kept.join('\n\n'),
    duplicateCount: duplicateCount,
    sampleDuplicate: sampleDuplicate,
  };
}

function splitHandoffSalesNoteHistoryBlocks_(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n\s*\n|\n(?=\[[^\]]+\])/)
    .map(function (block) { return String(block || '').trim(); })
    .filter(Boolean);
}

function normalizeHandoffSalesNoteExactBlockKey_(block) {
  return String(block || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function getHandoffSalesNoteDuplicateReportRow_(auditAt, sheetName, row, leadId, customerName, beforeLength, afterLength, duplicateBlockCount, sampleDuplicatedBlock, confidence, reason, action, result, notes) {
  return [
    auditAt,
    sheetName,
    row,
    leadId,
    customerName,
    beforeLength,
    afterLength,
    duplicateBlockCount,
    sampleDuplicatedBlock,
    confidence,
    reason,
    action,
    result,
    notes,
  ];
}

function getHandoffSalesNoteDuplicateSummaryRow_(auditAt, action, result, notes) {
  return getHandoffSalesNoteDuplicateReportRow_(
    auditAt,
    'SUMMARY',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    action,
    result,
    notes
  );
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
  } else if (sheet.getRange(1, 1).getNote() !== HANDOFF_REPORT_SHEET_NOTE) {
    throw new Error('Refusing to use existing sheet without handoff helper marker note: ' + sheetName);
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
