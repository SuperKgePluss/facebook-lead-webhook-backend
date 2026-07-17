// Isolated recovery tool. Keep this file outside the production clasp root.

function backfillLeadsMemoHistoryFromActivityLogDryRun() {
  return backfillLeadsMemoHistoryFromActivityLog_(true, false);
}

function backfillLeadsMemoHistoryFromActivityLog(confirm) {
  if (confirm !== true) return { refused: true, reason: 'explicit_confirm_true_required', no_write_performed: true };
  return backfillLeadsMemoHistoryFromActivityLog_(false, true);
}

function backfillLeadsMemoHistoryFromActivityLog_(dryRun, confirmed) {
  const ss = SpreadsheetApp.getActive();
  const activitySheet = ss.getSheetByName('ACTIVITY_LOG');
  const leadsSheet = ss.getSheetByName('LEADS');
  const result = { dry_run: dryRun, total_activity_rows_read: 0, leads_matched: 0, memo_entries: 0, duplicates_skipped: 0, missing_lead_id: 0, lead_not_found: 0, unsupported_rows: 0, samples: [] };
  if (!dryRun && confirmed !== true) return { refused: true, reason: 'explicit_confirm_true_required', no_write_performed: true };
  if (!activitySheet || activitySheet.getLastRow() < DATA_START_ROW || !leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) return result;
  const activityMap = getHeaderMap_(activitySheet);
  if (!activityMap.lead_id) return Object.assign(result, { error: 'missing_activity_lead_id_header' });
  const rowByLeadId = getLeadsViewRowMapByLeadId_(leadsSheet);
  const existingMemoKeysByLeadId = getLeadsViewMemoKeysByLeadIdForBackfill_(leadsSheet);
  const matchedLeadIds = {};
  const activityValues = activitySheet.getRange(DATA_START_ROW, 1, activitySheet.getLastRow() - DATA_START_ROW + 1, activitySheet.getLastColumn()).getValues();
  result.total_activity_rows_read = activityValues.length;
  activityValues.forEach(function (row, index) {
    const leadId = String(row[activityMap.lead_id - 1] || '').trim();
    if (!leadId) { result.missing_lead_id++; return; }
    const memo = buildLeadMemoFromActivityRowForBackfill_(row, activityMap);
    if (!memo) { result.unsupported_rows++; return; }
    if (!rowByLeadId[leadId]) { result.lead_not_found++; return; }
    const isNoteMemo = typeof isLeadNoteMemoValue_ === 'function' && isLeadNoteMemoValue_(memo);
    const displayMemo = isNoteMemo && typeof convertLeadMemoNoteToHistoryEntry_ === 'function' ? convertLeadMemoNoteToHistoryEntry_(memo) : memo;
    const memoKey = normalizeLeadMemoTextForBackfill_(displayMemo);
    existingMemoKeysByLeadId[leadId] = existingMemoKeysByLeadId[leadId] || {};
    if (existingMemoKeysByLeadId[leadId][memoKey]) { result.duplicates_skipped++; return; }
    matchedLeadIds[leadId] = true;
    result.memo_entries++;
    existingMemoKeysByLeadId[leadId][memoKey] = true;
    if (result.samples.length < 10) result.samples.push({ activity_row: DATA_START_ROW + index, lead_id: leadId, memo: displayMemo });
    if (!dryRun) {
      if (isNoteMemo && typeof appendSalesNoteHistoryToLeadsView_ === 'function') appendSalesNoteHistoryToLeadsView_(leadsSheet, rowByLeadId[leadId], displayMemo, new Date());
      else appendLeadMemoToLeadsView_(leadId, displayMemo, { preformatted: true });
    }
  });
  result.leads_matched = Object.keys(matchedLeadIds).length;
  if (!dryRun) SpreadsheetApp.getActive().toast('Backfilled LEADS memo entries: ' + result.memo_entries, 'Backfill LEADS Memo History', 5);
  return result;
}

function buildLeadMemoFromActivityRowForBackfill_(row, headerMap) {
  const actionType = String(headerMap.action_type ? row[headerMap.action_type - 1] : '').trim();
  const note = String(headerMap.note ? row[headerMap.note - 1] : '').trim();
  const audioUrl = String(headerMap.audio_url ? row[headerMap.audio_url - 1] : '').trim();
  const audioFileName = String(headerMap.audio_file_name ? row[headerMap.audio_file_name - 1] : '').trim();
  const createdAt = headerMap.created_at && typeof parseActivityLogDate_ === 'function' ? parseActivityLogDate_(row[headerMap.created_at - 1]) : null;
  const parsedFileName = audioFileName && typeof parseAudioFileName_ === 'function' ? parseAudioFileName_(audioFileName) : null;
  const timestamp = parsedFileName && typeof parseActivityLogDate_ === 'function' ? parseActivityLogDate_(parsedFileName.parsedTimestamp) : createdAt || new Date();
  if (audioUrl) return formatLeadMemoValue_('Audio', (audioFileName || 'Audio file') + ' - ' + audioUrl, timestamp);
  if (note && isActivityNoteMemoActionForBackfill_(actionType)) return formatLeadMemoValue_('Note', note, timestamp);
  return '';
}

function isActivityNoteMemoActionForBackfill_(actionType) {
  const normalized = normalizeHeaderName_(actionType);
  return normalized === 'sales_note' || normalized === 'follow_up' || normalized === 'follow_up_note' || normalized === 'legacy_follow_up' || normalized === 'note';
}

function getLeadsViewMemoKeysByLeadIdForBackfill_(sheet) {
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;
  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id) return data;
  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const memoValues = sheet.getLastColumn() >= LEADS_VIEW_MEMO_START_COLUMN ? sheet.getRange(DATA_START_ROW, LEADS_VIEW_MEMO_START_COLUMN, rowCount, sheet.getLastColumn() - LEADS_VIEW_MEMO_START_COLUMN + 1).getValues() : [];
  const leadIds = sheet.getRange(DATA_START_ROW, headerMap.lead_id, rowCount, 1).getValues();
  const noteHistoryValues = headerMap.sales_note_history ? sheet.getRange(DATA_START_ROW, headerMap.sales_note_history, rowCount, 1).getValues() : [];
  leadIds.forEach(function (row, index) {
    const leadId = String(row[0] || '').trim();
    if (!leadId) return;
    data[leadId] = data[leadId] || {};
    String(noteHistoryValues[index] ? noteHistoryValues[index][0] || '' : '').trim().split(/\n\s*\n|\n/).forEach(function (value) {
      const normalized = normalizeLeadMemoTextForBackfill_(value);
      if (normalized) data[leadId][normalized] = true;
    });
    (memoValues[index] || []).forEach(function (value) {
      const normalized = normalizeLeadMemoTextForBackfill_(value);
      if (normalized) data[leadId][normalized] = true;
    });
  });
  return data;
}

function normalizeLeadMemoTextForBackfill_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
