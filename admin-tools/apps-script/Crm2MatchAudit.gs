const CRM2_MATCH_AUDIT_SHEET_NAME = 'CRM2_MATCH_AUDIT';
const LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME = 'LEGACY_NOTE_MATCH_AUDIT';
const CRM3_ONLY_NOTE_TEXT = 'CRM3 only: not found in CRM2 import by phone/name';
const CRM3_ONLY_FONT_COLOR = '#800080';
const CRM3_DEFAULT_FONT_COLOR = '#000000';
const CRM3_ONLY_HIGHLIGHT_START_DATE = new Date(2026, 2, 18);
const LEGACY_NOTE_SOURCE_SHEETS = [
  'IMPORT_RAW_CRM2',
  'IMPORT_RAW_CRM1',
  'IMPORT_RAW_CRM1_LEAD_NEW',
  'IMPORT_RAW_CRM1_CLOSE_WON',
  'IMPORT_RAW_CRM1_INSTALLATION',
];
const LEGACY_NOTE_AUDIT_SOURCE_INDEX_KEY = 'LEGACY_NOTE_AUDIT_SOURCE_INDEX';
const LEGACY_NOTE_AUDIT_ROW_KEY = 'LEGACY_NOTE_AUDIT_ROW';
const LEGACY_NOTE_AUDIT_DONE_KEY = 'LEGACY_NOTE_AUDIT_DONE';
const LEGACY_NOTE_AUDIT_OUTPUT_ROWS_KEY = 'LEGACY_NOTE_AUDIT_OUTPUT_ROWS';
const LEGACY_NOTE_AUDIT_BATCH_SIZE = 50;
const LEGACY_NOTE_AUDIT_TIME_LIMIT_MS = 270000;
const CRM2_MATCH_AUDIT_HEADERS = [
  'audit_at',
  'crm2_import_row',
  'crm2_customer_name',
  'crm2_phone',
  'crm2_note_or_audio_source',
  'crm3_lead_id',
  'crm3_leads_row',
  'crm3_customer_name',
  'crm3_phone',
  'match_method',
  'match_confidence',
  'activity_log_row',
  'activity_type',
  'activity_text_or_url',
  'leads_history_found',
  'leads_history_cell',
  'status',
  'notes',
];
const LEGACY_NOTE_MATCH_AUDIT_HEADERS = [
  'Source System',
  'Source Sheet',
  'Source Row',
  'Source Customer Name',
  'Source Phone',
  'Normalized Phone',
  'Source Date if available',
  'Source Note/History',
  'Matched Lead ID',
  'Matched CRM3 Customer Name',
  'Matched CRM3 Phone',
  'Match Key Used',
  'Name Similarity / Name Warning',
  'Activity Log Found',
  'LEADS History Found',
  'Status',
  'Review Note',
];

function highlightCrm3OnlyLeads() {
  const data = loadCrm2Crm3AuditData_();
  const result = {
    crm3_leads_checked: 0,
    crm2_rows_checked: data.crm2Rows.length,
    matched_by_phone: 0,
    matched_by_name: 0,
    crm3_only_count: 0,
    crm3_only_before_cutoff_count: 0,
    crm3_only_date_unable_to_evaluate: 0,
    ambiguous_count: 0,
    invalid_phone_count: 0,
  };

  const leadsSheet = data.leadsSheet;
  if (!leadsSheet) {
    SpreadsheetApp.getActive().toast('LEADS sheet not found.', 'CRM2 Match Audit', 8);
    return Object.assign(result, { error: 'missing_leads_sheet' });
  }

  const leadsMap = getHeaderMap_(leadsSheet);
  const leadIdColumn = leadsMap.lead_id;
  const customerNameColumn = leadsMap.customer_name;
  const phoneColumn = leadsMap.phone;
  if (!leadIdColumn || !customerNameColumn || !phoneColumn) {
    SpreadsheetApp.getActive().toast('LEADS missing Lead ID, Customer Name, or Phone header.', 'CRM2 Match Audit', 8);
    return Object.assign(result, { error: 'missing_leads_headers' });
  }

  data.crm3Leads.forEach(function (lead) {
    result.crm3_leads_checked++;
    if (!lead.phone) result.invalid_phone_count++;

    const match = findCrm2MatchForLead_(lead, data.crm2Index);
    const leadsRow = data.leadsRowByLeadId[lead.lead_id];
    if (!leadsRow) return;

    const nameCell = leadsSheet.getRange(leadsRow, customerNameColumn);
    const phoneCell = leadsSheet.getRange(leadsRow, phoneColumn);

    if (match.method === 'ambiguous') {
      result.ambiguous_count++;
      clearCrm3OnlyFormattingIfApplied_(nameCell);
      clearCrm3OnlyFormattingIfApplied_(phoneCell);
      nameCell.setNote('CRM2 match ambiguous: multiple CRM2 rows match this phone/name');
      phoneCell.setNote('CRM2 match ambiguous: multiple CRM2 rows match this phone/name');
      return;
    }

    if (match.method === 'phone') {
      result.matched_by_phone++;
      clearCrm3OnlyFormattingIfApplied_(nameCell);
      clearCrm3OnlyFormattingIfApplied_(phoneCell);
      return;
    }

    if (match.method === 'name') {
      result.matched_by_name++;
      clearCrm3OnlyFormattingIfApplied_(nameCell);
      clearCrm3OnlyFormattingIfApplied_(phoneCell);
      return;
    }

    if (lead.createdDate && lead.createdDate.getTime() < CRM3_ONLY_HIGHLIGHT_START_DATE.getTime()) {
      result.crm3_only_before_cutoff_count++;
      clearCrm3OnlyFormattingIfApplied_(nameCell);
      clearCrm3OnlyFormattingIfApplied_(phoneCell);
      return;
    }

    if (!lead.createdDate) {
      result.crm3_only_date_unable_to_evaluate++;
    }

    result.crm3_only_count++;
    nameCell.setFontColor(CRM3_ONLY_FONT_COLOR).setNote(CRM3_ONLY_NOTE_TEXT);
    phoneCell.setFontColor(CRM3_ONLY_FONT_COLOR).setNote(CRM3_ONLY_NOTE_TEXT);
  });

  Logger.log('Highlight CRM3-only Leads ' + JSON.stringify(result));
  SpreadsheetApp.getActive().toast('CRM3-only leads: ' + result.crm3_only_count + ', ambiguous: ' + result.ambiguous_count, 'CRM2 Match Audit', 8);
  return result;
}

function buildCrm2MatchAudit() {
  const data = loadCrm2Crm3AuditData_();
  const auditAt = new Date();
  const rows = [];
  const activityIndex = buildCrm2ActivityIndex_(data.activityRows);
  const leadsHistoryIndex = buildLeadsHistoryIndex_(data.leadsSheet);

  data.crm2Rows.forEach(function (crm2Row) {
    const candidates = buildCrm2AuditCandidatesForRow_(crm2Row);
    const match = findCrm3MatchForCrm2Row_(crm2Row, data.crm3Index);
    if (!candidates.length) {
      candidates.push({
        source: 'row',
        text: '',
        type: 'CRM2 Row',
      });
    }

    candidates.forEach(function (candidate) {
      rows.push(buildCrm2MatchAuditRow_({
        auditAt: auditAt,
        crm2Row: crm2Row,
        candidate: candidate,
        match: match,
        activityIndex: activityIndex,
        leadsHistoryIndex: leadsHistoryIndex,
        leadsRowByLeadId: data.leadsRowByLeadId,
      }));
    });
  });

  data.crm3Leads.forEach(function (lead) {
    const match = findCrm2MatchForLead_(lead, data.crm2Index);
    if (match.method !== 'none') return;
    rows.push(buildCrm3OnlyAuditRow_(auditAt, lead, data.leadsRowByLeadId));
  });

  writeCrm2MatchAuditRows_(rows);
  const summary = summarizeCrm2MatchAuditRows_(rows);
  Logger.log('CRM2 Match Audit ' + JSON.stringify(summary));
  SpreadsheetApp.getActive().toast('CRM2 Match Audit rows: ' + rows.length + ', OK: ' + summary.OK + ', warnings: ' + (rows.length - summary.OK), 'CRM2 Match Audit', 8);
  return summary;
}

function buildLegacyNoteMatchAudit() {
  return startLegacyNoteMatchAudit();
}

function startLegacyNoteMatchAudit() {
  const sheet = ensureLegacyNoteMatchAuditSheet_();
  resetLegacyNoteMatchAuditProperties_();
  Logger.log('Legacy Note Match Audit started. Source sheets=' + LEGACY_NOTE_SOURCE_SHEETS.join(', '));
  SpreadsheetApp.getActive().toast('Legacy Note Match Audit started. Click Continue to process batches.', 'Legacy Note Match Audit', 8);
  return {
    started: true,
    output_sheet: LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME,
    source_sheets: LEGACY_NOTE_SOURCE_SHEETS,
    next_source_index: 0,
    next_row: 1,
    output_rows: 0,
    sheet_name: sheet.getName(),
  };
}

function continueLegacyNoteMatchAudit() {
  const startedAt = Date.now();
  const ss = SpreadsheetApp.getActive();
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const properties = PropertiesService.getScriptProperties();
  const done = String(properties.getProperty(LEGACY_NOTE_AUDIT_DONE_KEY) || '').trim().toLowerCase() === 'true';
  if (done) {
    SpreadsheetApp.getActive().toast('Legacy Note Match Audit is already complete. Start again to rebuild.', 'Legacy Note Match Audit', 8);
    return {
      complete: true,
      already_complete: true,
    };
  }

  const crm3Leads = leadMainSheet ? readCrm3LeadsForMatchAudit_(leadMainSheet) : [];
  const crm3PhoneIndex = buildMultiIndex_(crm3Leads, 'phone');
  const outputRows = [];
  let sourceIndex = Math.max(0, Number(properties.getProperty(LEGACY_NOTE_AUDIT_SOURCE_INDEX_KEY)) || 0);
  let sourceRowCursor = Math.max(1, Number(properties.getProperty(LEGACY_NOTE_AUDIT_ROW_KEY)) || 1);
  let currentSourceSheet = '';
  let processedRows = 0;
  const summary = {
    source_sheets_checked_this_run: 0,
    source_sheets_missing: 0,
    source_rows_checked_this_run: 0,
    output_rows_this_run: 0,
    output_rows_total: Number(properties.getProperty(LEGACY_NOTE_AUDIT_OUTPUT_ROWS_KEY)) || 0,
    OK: 0,
    SOURCE_UNMATCHED: 0,
    AMBIGUOUS: 0,
    MISSING_ACTIVITY_LOG: 0,
    MISSING_LEADS_HISTORY: 0,
    DATE_BEFORE_2026_03_18: 0,
    NO_NOTE_FOUND: 0,
    NEED_MANUAL_REVIEW: 0,
  };

  while (sourceIndex < LEGACY_NOTE_SOURCE_SHEETS.length) {
    const sheetName = LEGACY_NOTE_SOURCE_SHEETS[sourceIndex];
    currentSourceSheet = sheetName;
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      summary.source_sheets_missing++;
      Logger.log('Legacy Note Match Audit skipped missing source sheet: ' + sheetName);
      sourceIndex++;
      sourceRowCursor = 1;
      continue;
    }

    summary.source_sheets_checked_this_run++;
    const sourceSystem = sheetName.indexOf('CRM2') !== -1 ? 'CRM2' : 'CRM1';
    const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    const headerRowIndex = findLegacyAuditHeaderRowIndex_(values);
    if (headerRowIndex === -1 || values.length <= headerRowIndex + 1) {
      sourceIndex++;
      sourceRowCursor = 1;
      continue;
    }

    const headers = values[headerRowIndex] || [];
    let rowIndex = Math.max(sourceRowCursor - 1, headerRowIndex + 1);
    for (; rowIndex < values.length; rowIndex++) {
      if (processedRows >= LEGACY_NOTE_AUDIT_BATCH_SIZE || Date.now() - startedAt > LEGACY_NOTE_AUDIT_TIME_LIMIT_MS) {
        properties.setProperty(LEGACY_NOTE_AUDIT_SOURCE_INDEX_KEY, String(sourceIndex));
        properties.setProperty(LEGACY_NOTE_AUDIT_ROW_KEY, String(rowIndex + 1));
        appendLegacyNoteMatchAuditRows_(outputRows);
        summary.output_rows_this_run = outputRows.length;
        summary.output_rows_total += outputRows.length;
        properties.setProperty(LEGACY_NOTE_AUDIT_OUTPUT_ROWS_KEY, String(summary.output_rows_total));
        logAndToastLegacyNoteAuditContinueResult_(summary, currentSourceSheet, rowIndex + 1, false);
        return Object.assign(summary, {
          complete: false,
          current_source_sheet: currentSourceSheet,
          next_source_index: sourceIndex,
          next_row: rowIndex + 1,
        });
      }

      const sourceRow = buildLegacyAuditSourceRowFromValues_(sheet.getName(), sourceSystem, headers, values[rowIndex], rowIndex + 1);
      if (!sourceRow) continue;
      processedRows++;
      summary.source_rows_checked_this_run++;
      const candidates = buildLegacyNoteCandidatesForAudit_(sourceRow);
      if (!candidates.length) {
        const row = buildLegacyNoteMatchAuditRow_({
          sourceRow: sourceRow,
          candidate: {
            source: '',
            text: '',
            date: sourceRow.sourceDate,
          },
          crm3PhoneIndex: crm3PhoneIndex,
        });
        outputRows.push(row);
        summary[row[15]] = (summary[row[15]] || 0) + 1;
        continue;
      }

      candidates.forEach(function (candidate) {
        const row = buildLegacyNoteMatchAuditRow_({
          sourceRow: sourceRow,
          candidate: candidate,
          crm3PhoneIndex: crm3PhoneIndex,
        });
        outputRows.push(row);
        summary[row[15]] = (summary[row[15]] || 0) + 1;
      });
    }

    sourceIndex++;
    sourceRowCursor = 1;
  }

  appendLegacyNoteMatchAuditRows_(outputRows);
  summary.output_rows_this_run = outputRows.length;
  summary.output_rows_total += outputRows.length;
  properties.setProperty(LEGACY_NOTE_AUDIT_OUTPUT_ROWS_KEY, String(summary.output_rows_total));
  properties.setProperty(LEGACY_NOTE_AUDIT_DONE_KEY, 'true');
  properties.setProperty(LEGACY_NOTE_AUDIT_SOURCE_INDEX_KEY, String(LEGACY_NOTE_SOURCE_SHEETS.length));
  properties.setProperty(LEGACY_NOTE_AUDIT_ROW_KEY, '1');
  logAndToastLegacyNoteAuditContinueResult_(summary, currentSourceSheet, 1, true);
  Logger.log('Legacy Note Match Audit ' + JSON.stringify(summary));
  return Object.assign(summary, {
    complete: true,
    current_source_sheet: currentSourceSheet,
    next_source_index: sourceIndex,
    next_row: 1,
  });
}

function loadCrm2Crm3AuditData_() {
  const ss = SpreadsheetApp.getActive();
  const crm2Sheet = ss.getSheetByName('IMPORT_RAW_CRM2') || ss.getSheetByName('IMPORT_RAW');
  const leadMainSheet = ss.getSheetByName('LEADS_MAIN');
  const leadsSheet = ss.getSheetByName('LEADS');
  const activitySheet = ss.getSheetByName('ACTIVITY_LOG');
  const crm2Rows = crm2Sheet ? readCrm2RowsForMatchAudit_(crm2Sheet) : [];
  const crm3Leads = leadMainSheet ? readCrm3LeadsForMatchAudit_(leadMainSheet) : [];
  const leadsRowByLeadId = leadsSheet ? getLeadsViewRowMapByLeadId_(leadsSheet) : {};

  return {
    crm2Sheet: crm2Sheet,
    leadMainSheet: leadMainSheet,
    leadsSheet: leadsSheet,
    activitySheet: activitySheet,
    crm2Rows: crm2Rows,
    crm3Leads: crm3Leads,
    crm2Index: buildCrm2Index_(crm2Rows),
    crm3Index: buildCrm3Index_(crm3Leads),
    activityRows: activitySheet ? readSheetObjectsForAudit_(activitySheet) : [],
    leadsRowByLeadId: leadsRowByLeadId,
  };
}

function readCrm2RowsForMatchAudit_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values[0] || [];
  const rows = [];
  for (let index = 1; index < values.length; index++) {
    const row = values[index];
    if (!row.some(function (cell) { return String(cell || '').trim(); })) continue;

    const object = objectFromHeaders_(headers, row);
    const customerName = getFirstObjectValue_(object, ['name', 'customer_name', 'full_name']);
    const phone = getFirstObjectValue_(object, ['phone_number', 'phone', 'mobile_phone']);
    rows.push({
      rowNumber: index + 1,
      object: object,
      customerName: customerName,
      normalizedName: normalizeCrm2AuditName_(customerName),
      rawPhone: phone,
      phone: normalizePhone(phone),
    });
  }
  return rows;
}

function readCrm3LeadsForMatchAudit_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return [];

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  return values.map(function (row, index) {
    const object = objectFromHeaders_(headers, row);
    return {
      rowNumber: DATA_START_ROW + index,
      object: object,
      lead_id: String(object.lead_id || '').trim(),
      customer_name: String(object.customer_name || object.full_name || object.name || '').trim(),
      normalizedName: normalizeCrm2AuditName_(object.customer_name || object.full_name || object.name),
      phone: normalizePhone(object.phone),
      rawPhone: String(object.phone || '').trim(),
      createdDate: parseCrm3OnlyLeadDate_(object),
    };
  }).filter(function (lead) {
    return lead.lead_id;
  });
}

function readSheetObjectsForAudit_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return [];

  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  return values.map(function (row, index) {
    return {
      rowNumber: DATA_START_ROW + index,
      object: objectFromHeaders_(headers, row),
    };
  });
}

function readLegacyRowsForNoteMatchAudit_(sheet, sourceSystem) {
  if (!sheet || sheet.getLastRow() < 1) return [];

  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headerRowIndex = findLegacyAuditHeaderRowIndex_(values);
  if (headerRowIndex === -1) return [];

  const headers = values[headerRowIndex] || [];
  const rows = [];
  for (let index = headerRowIndex + 1; index < values.length; index++) {
    const row = values[index];
    if (!row.some(function (cell) { return String(cell || '').trim(); })) continue;

    const object = objectFromHeaders_(headers, row);
    const customerName = getFirstObjectValue_(object, [
      'customer_name',
      'name',
      'full_name',
      'lead_name',
      'client_name',
      'contact_name',
      'ชื่อลูกค้า',
      'ชื่อ',
    ]);
    const rawPhone = getFirstObjectValue_(object, [
      'phone',
      'phone_number',
      'mobile_phone',
      'tel',
      'telephone',
      'เบอร์โทร',
      'เบอร์',
    ]);
    rows.push({
      sourceSystem: sourceSystem,
      sourceSheet: sheet.getName(),
      rowNumber: index + 1,
      object: object,
      customerName: customerName,
      normalizedName: normalizeCrm2AuditName_(customerName),
      rawPhone: rawPhone,
      phone: normalizePhone(rawPhone),
      sourceDate: getLegacyAuditSourceDate_(object),
    });
  }
  return rows;
}

function buildLegacyAuditSourceRowFromValues_(sheetName, sourceSystem, headers, row, rowNumber) {
  if (!row.some(function (cell) { return String(cell || '').trim(); })) return null;

  const object = objectFromHeaders_(headers, row);
  const customerName = getFirstObjectValue_(object, [
    'customer_name',
    'name',
    'full_name',
    'lead_name',
    'client_name',
    'contact_name',
    'ชื่อลูกค้า',
    'ชื่อ',
  ]);
  const rawPhone = getFirstObjectValue_(object, [
    'phone',
    'phone_number',
    'mobile_phone',
    'tel',
    'telephone',
    'เบอร์โทร',
    'เบอร์',
  ]);
  return {
    sourceSystem: sourceSystem,
    sourceSheet: sheetName,
    rowNumber: rowNumber,
    object: object,
    customerName: customerName,
    normalizedName: normalizeCrm2AuditName_(customerName),
    rawPhone: rawPhone,
    phone: normalizePhone(rawPhone),
    sourceDate: getLegacyAuditSourceDate_(object),
  };
}

function findLegacyAuditHeaderRowIndex_(values) {
  const maxRows = Math.min(values.length, 8);
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < maxRows; index++) {
    const normalizedHeaders = (values[index] || []).map(function (header) {
      return normalizeHeaderName_(header);
    });
    const joined = normalizedHeaders.join('|');
    let score = 0;
    if (/(^|_|\|)(phone|phone_number|mobile_phone|tel|telephone)(\||_|$)/.test(joined)) score += 3;
    if (/(^|_|\|)(customer_name|name|full_name|lead_name|client_name|contact_name)(\||_|$)/.test(joined)) score += 2;
    if (joined.indexOf('follow_up') !== -1 || joined.indexOf('note') !== -1 || joined.indexOf('comment') !== -1 || joined.indexOf('recording') !== -1) score += 2;
    if (joined.indexOf('created') !== -1 || joined.indexOf('date') !== -1 || joined.indexOf('lead_in') !== -1) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 2 ? bestIndex : 0;
}

function getLegacyAuditSourceDate_(object) {
  const raw = getFirstObjectValue_(object, [
    'facebook_created_time',
    'created_at',
    'lead_in_date',
    'lead_in',
    'created_time',
    'date',
    'วันที่',
    'follow_up_1_date_time',
  ]);
  return raw;
}

function buildCrm2Index_(rows) {
  return {
    byPhone: buildMultiIndex_(rows, 'phone'),
    byName: buildMultiIndex_(rows, 'normalizedName'),
  };
}

function buildCrm3Index_(leads) {
  return {
    byPhone: buildMultiIndex_(leads, 'phone'),
    byName: buildMultiIndex_(leads, 'normalizedName'),
  };
}

function buildMultiIndex_(items, fieldName) {
  const index = {};
  items.forEach(function (item) {
    const key = String(item[fieldName] || '').trim();
    if (!key) return;
    index[key] = index[key] || [];
    index[key].push(item);
  });
  return index;
}

function findCrm2MatchForLead_(lead, crm2Index) {
  if (lead.phone && crm2Index.byPhone[lead.phone]) {
    return crm2Index.byPhone[lead.phone].length === 1
      ? { method: 'phone', rows: crm2Index.byPhone[lead.phone] }
      : { method: 'ambiguous', rows: crm2Index.byPhone[lead.phone] };
  }

  if (lead.normalizedName && crm2Index.byName[lead.normalizedName]) {
    return crm2Index.byName[lead.normalizedName].length === 1
      ? { method: 'name', rows: crm2Index.byName[lead.normalizedName] }
      : { method: 'ambiguous', rows: crm2Index.byName[lead.normalizedName] };
  }

  return { method: 'none', rows: [] };
}

function findCrm3MatchForCrm2Row_(crm2Row, crm3Index) {
  if (crm2Row.phone && crm3Index.byPhone[crm2Row.phone]) {
    const rows = crm3Index.byPhone[crm2Row.phone];
    return rows.length === 1
      ? { method: 'phone', confidence: 'high', lead: rows[0], ambiguous: false }
      : { method: 'phone', confidence: 'ambiguous', lead: null, ambiguous: true, rows: rows };
  }

  if (crm2Row.normalizedName && crm3Index.byName[crm2Row.normalizedName]) {
    const rows = crm3Index.byName[crm2Row.normalizedName];
    return rows.length === 1
      ? { method: 'name', confidence: 'medium', lead: rows[0], ambiguous: false }
      : { method: 'name', confidence: 'ambiguous', lead: null, ambiguous: true, rows: rows };
  }

  return { method: 'none', confidence: 'none', lead: null, ambiguous: false, rows: [] };
}

function buildCrm2AuditCandidatesForRow_(crm2Row) {
  const candidates = [];
  const object = crm2Row.object || {};
  const followUpFields = [
    ['follow_up_1_date_time', 'Follow-up 1 Date/Time'],
    ['follow_up_1_details', 'Follow-up 1 Details'],
    ['follow_up_2_date_time', 'Follow-up 2 Date/Time'],
    ['follow_up_2_details', 'Follow-up 2 Details'],
    ['follow_up_3_date_time', 'Follow-up 3 Date/Time'],
    ['follow_up_3_details', 'Follow-up 3 Details'],
  ];

  followUpFields.forEach(function (pair) {
    const value = String(object[pair[0]] || '').trim();
    if (value) {
      candidates.push({
        source: pair[1],
        text: value,
        type: 'Legacy Follow-up',
      });
    }
  });

  Object.keys(object).forEach(function (key) {
    if (key.indexOf('call_recording') === -1 && key.indexOf('audio') === -1 && key.indexOf('recording') === -1) return;
    const value = String(object[key] || '').trim();
    if (!value) return;
    candidates.push({
      source: key,
      text: value,
      type: value.indexOf('http') !== -1 ? 'Audio' : 'Legacy Follow-up',
    });
  });

  return candidates;
}

function buildLegacyNoteCandidatesForAudit_(sourceRow) {
  const candidates = [];
  const seen = {};
  const object = sourceRow.object || {};
  const preferredFields = [
    ['follow_up_1_date_time', 'Follow-up 1 Date/Time'],
    ['follow_up_1_details', 'Follow-up 1 Details'],
    ['follow_up_2_date_time', 'Follow-up 2 Date/Time'],
    ['follow_up_2_details', 'Follow-up 2 Details'],
    ['follow_up_3_date_time', 'Follow-up 3 Date/Time'],
    ['follow_up_3_details', 'Follow-up 3 Details'],
    ['next_follow_up', 'Next Follow-up'],
    ['follow_up_note', 'Follow-up Note'],
    ['note', 'Note'],
    ['notes', 'Notes'],
    ['comment', 'Comment'],
    ['comments', 'Comments'],
    ['call_recording', 'Call Recording'],
  ];

  preferredFields.forEach(function (pair) {
    addLegacyNoteCandidateIfPresent_(candidates, seen, object, pair[0], pair[1], sourceRow.sourceDate);
  });

  Object.keys(object).forEach(function (key) {
    if (!isLegacyNoteAuditField_(key)) return;
    addLegacyNoteCandidateIfPresent_(candidates, seen, object, key, key, sourceRow.sourceDate);
  });

  return candidates;
}

function addLegacyNoteCandidateIfPresent_(candidates, seen, object, key, label, sourceDate) {
  const value = String(object[key] || '').trim();
  if (!value) return;

  const normalized = normalizeCrm2AuditTextForSearch_(value);
  if (!normalized || seen[normalized]) return;
  seen[normalized] = true;
  candidates.push({
    source: label,
    text: value,
    date: sourceDate,
  });
}

function isLegacyNoteAuditField_(key) {
  const normalized = normalizeHeaderName_(key);
  if (!normalized) return false;
  if ([
    'phone',
    'phone_number',
    'mobile_phone',
    'tel',
    'telephone',
    'customer_name',
    'name',
    'full_name',
    'lead_name',
    'client_name',
    'contact_name',
    'lead_id',
  ].indexOf(normalized) !== -1) return false;

  return normalized.indexOf('follow') !== -1
    || normalized.indexOf('note') !== -1
    || normalized.indexOf('comment') !== -1
    || normalized.indexOf('remark') !== -1
    || normalized.indexOf('history') !== -1
    || normalized.indexOf('log') !== -1
    || normalized.indexOf('recording') !== -1
    || normalized.indexOf('audio') !== -1
    || normalized.indexOf('next_step') !== -1;
}

function buildCrm2ActivityIndex_(activityRows) {
  const byLead = {};
  activityRows.forEach(function (item) {
    const object = item.object;
    const leadId = String(object.lead_id || '').trim();
    if (!leadId) return;
    byLead[leadId] = byLead[leadId] || [];
    byLead[leadId].push({
      rowNumber: item.rowNumber,
      actionType: String(object.action_type || '').trim(),
      text: [object.note, object.audio_url, object.audio_file_name].filter(Boolean).join(' '),
    });
  });
  return byLead;
}

function buildLeadsHistoryIndex_(leadsSheet) {
  const data = {};
  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id) return data;
  const values = leadsSheet.getRange(DATA_START_ROW, 1, leadsSheet.getLastRow() - DATA_START_ROW + 1, leadsSheet.getLastColumn()).getValues();
  values.forEach(function (row, index) {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    if (!leadId) return;

    const entries = [];
    if (headerMap.sales_note_history) {
      entries.push({
        cell: leadsSheet.getRange(DATA_START_ROW + index, headerMap.sales_note_history).getA1Notation(),
        text: String(row[headerMap.sales_note_history - 1] || ''),
      });
    }
    if (leadsSheet.getLastColumn() >= LEADS_VIEW_MEMO_START_COLUMN) {
      for (let column = LEADS_VIEW_MEMO_START_COLUMN; column <= leadsSheet.getLastColumn(); column++) {
        const value = String(row[column - 1] || '').trim();
        if (!value) continue;
        entries.push({
          cell: leadsSheet.getRange(DATA_START_ROW + index, column).getA1Notation(),
          text: value,
        });
      }
    }
    data[leadId] = entries;
  });
  return data;
}

function buildCrm2MatchAuditRow_(params) {
  const crm2Row = params.crm2Row;
  const candidate = params.candidate;
  const match = params.match;
  const lead = match.lead;
  let status = 'OK';
  let notes = '';
  let activityMatch = null;
  let historyMatch = null;

  if (match.ambiguous) {
    status = 'AMBIGUOUS';
    notes = 'Multiple CRM3 leads matched by ' + match.method;
  } else if (!lead) {
    status = 'CRM2_UNMATCHED';
    notes = 'No CRM3 lead matched by phone/name';
  } else if (candidate.text) {
    activityMatch = findCandidateInActivityLog_(params.activityIndex[lead.lead_id] || [], candidate.text);
    historyMatch = findCandidateInLeadsHistory_(params.leadsHistoryIndex[lead.lead_id] || [], candidate.text);

    if (!activityMatch) {
      status = 'MISSING_ACTIVITY_LOG';
      notes = 'CRM2 candidate text/url was not found in ACTIVITY_LOG for matched lead';
    } else if (!historyMatch) {
      status = 'MISSING_LEADS_HISTORY';
      notes = 'CRM2 candidate text/url was found in ACTIVITY_LOG but not visible in LEADS history';
    }
  }

  return [
    params.auditAt,
    crm2Row.rowNumber,
    crm2Row.customerName,
    crm2Row.rawPhone,
    candidate.source,
    lead ? lead.lead_id : '',
    lead && params.leadsRowByLeadId[lead.lead_id] ? params.leadsRowByLeadId[lead.lead_id] : '',
    lead ? lead.customer_name : '',
    lead ? lead.rawPhone : '',
    match.method,
    match.confidence,
    activityMatch ? activityMatch.rowNumber : '',
    activityMatch ? activityMatch.actionType : '',
    candidate.text,
    historyMatch ? 'YES' : '',
    historyMatch ? historyMatch.cell : '',
    status,
    notes,
  ];
}

function buildLegacyNoteMatchAuditRow_(params) {
  const sourceRow = params.sourceRow;
  const candidate = params.candidate;
  const phone = sourceRow.phone;
  let lead = null;
  let matchKey = '';
  let status = 'OK';
  let reviewNote = '';
  const activityFound = 'NOT_CHECKED_FAST_MODE';
  const historyFound = 'NOT_CHECKED_FAST_MODE';

  if (!candidate.text) {
    status = 'NO_NOTE_FOUND';
    reviewNote = 'No note/history-like source field found on this row.';
  } else if (!phone) {
    status = 'NEED_MANUAL_REVIEW';
    reviewNote = 'Source phone is missing or invalid; name-only matching is not used automatically.';
  } else if (!params.crm3PhoneIndex[phone]) {
    status = 'SOURCE_UNMATCHED';
    reviewNote = 'No CRM3 lead matched by normalized phone.';
  } else if (params.crm3PhoneIndex[phone].length > 1) {
    status = 'AMBIGUOUS';
    reviewNote = 'Multiple CRM3 leads matched the same normalized phone.';
  } else {
    lead = params.crm3PhoneIndex[phone][0];
    matchKey = 'normalized_phone';
    const sourceDate = parseCrm3OnlyLeadDate_({ facebook_created_time: candidate.date });
    const comparisonDate = sourceDate || lead.createdDate;
    if (comparisonDate && comparisonDate.getTime() < CRM3_ONLY_HIGHLIGHT_START_DATE.getTime()) {
      status = 'DATE_BEFORE_2026_03_18';
      reviewNote = 'Source/matched lead date is before 2026-03-18.';
    } else {
      reviewNote = 'Fast mode: matched by normalized phone; ACTIVITY_LOG and LEADS history text verification not checked.';
    }
  }

  return [
    sourceRow.sourceSystem,
    sourceRow.sourceSheet,
    sourceRow.rowNumber,
    sourceRow.customerName,
    sourceRow.rawPhone,
    sourceRow.phone,
    candidate.date || sourceRow.sourceDate || '',
    candidate.text || '',
    lead ? lead.lead_id : '',
    lead ? lead.customer_name : '',
    lead ? lead.rawPhone : '',
    matchKey,
    buildLegacyNameWarning_(sourceRow, lead),
    activityFound,
    historyFound,
    status,
    reviewNote,
  ];
}

function buildCrm3OnlyAuditRow_(auditAt, lead, leadsRowByLeadId) {
  return [
    auditAt,
    '',
    '',
    '',
    '',
    lead.lead_id,
    leadsRowByLeadId[lead.lead_id] || '',
    lead.customer_name,
    lead.rawPhone,
    'none',
    'none',
    '',
    '',
    '',
    '',
    '',
    'CRM3_ONLY',
    'CRM3 lead not found in CRM2 import by phone/name',
  ];
}

function findCandidateInActivityLog_(activities, text) {
  const needle = normalizeCrm2AuditTextForSearch_(text);
  if (!needle) return null;
  return activities.find(function (activity) {
    const haystack = normalizeCrm2AuditTextForSearch_(activity.text);
    if (!haystack) return false;
    return haystack.indexOf(needle) !== -1 || needle.indexOf(haystack) !== -1;
  }) || null;
}

function findCandidateInLeadsHistory_(entries, text) {
  const needle = normalizeCrm2AuditTextForSearch_(text);
  if (!needle) return null;
  return entries.find(function (entry) {
    const haystack = normalizeCrm2AuditTextForSearch_(entry.text);
    if (!haystack) return false;
    return haystack.indexOf(needle) !== -1 || needle.indexOf(haystack) !== -1;
  }) || null;
}

function writeCrm2MatchAuditRows_(rows) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CRM2_MATCH_AUDIT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CRM2_MATCH_AUDIT_SHEET_NAME);

  sheet.clearContents();
  if (sheet.getMaxColumns() < CRM2_MATCH_AUDIT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), CRM2_MATCH_AUDIT_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, CRM2_MATCH_AUDIT_HEADERS.length).setValues([CRM2_MATCH_AUDIT_HEADERS]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, CRM2_MATCH_AUDIT_HEADERS.length).setValues(rows);
  }
  sheet.autoResizeColumns(1, CRM2_MATCH_AUDIT_HEADERS.length);
}

function writeLegacyNoteMatchAuditRows_(rows) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME);

  sheet.clearContents();
  if (sheet.getMaxColumns() < LEGACY_NOTE_MATCH_AUDIT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEGACY_NOTE_MATCH_AUDIT_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, LEGACY_NOTE_MATCH_AUDIT_HEADERS.length).setValues([LEGACY_NOTE_MATCH_AUDIT_HEADERS]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, LEGACY_NOTE_MATCH_AUDIT_HEADERS.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.getRange(1, 1, Math.max(rows.length + 1, 1), LEGACY_NOTE_MATCH_AUDIT_HEADERS.length).createFilter();
  sheet.autoResizeColumns(1, LEGACY_NOTE_MATCH_AUDIT_HEADERS.length);
}

function ensureLegacyNoteMatchAuditSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME);

  sheet.clearContents();
  if (sheet.getMaxColumns() < LEGACY_NOTE_MATCH_AUDIT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEGACY_NOTE_MATCH_AUDIT_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, LEGACY_NOTE_MATCH_AUDIT_HEADERS.length).setValues([LEGACY_NOTE_MATCH_AUDIT_HEADERS]);
  sheet.setFrozenRows(1);
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.getRange(1, 1, 1, LEGACY_NOTE_MATCH_AUDIT_HEADERS.length).createFilter();
  return sheet;
}

function appendLegacyNoteMatchAuditRows_(rows) {
  if (!rows || !rows.length) return 0;

  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(LEGACY_NOTE_MATCH_AUDIT_SHEET_NAME);
  if (!sheet) sheet = ensureLegacyNoteMatchAuditSheet_();

  if (sheet.getMaxColumns() < LEGACY_NOTE_MATCH_AUDIT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LEGACY_NOTE_MATCH_AUDIT_HEADERS.length - sheet.getMaxColumns());
  }
  const startRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(startRow, 1, rows.length, LEGACY_NOTE_MATCH_AUDIT_HEADERS.length).setValues(rows);
  return rows.length;
}

function resetLegacyNoteMatchAuditProperties_() {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(LEGACY_NOTE_AUDIT_SOURCE_INDEX_KEY, '0');
  properties.setProperty(LEGACY_NOTE_AUDIT_ROW_KEY, '1');
  properties.setProperty(LEGACY_NOTE_AUDIT_DONE_KEY, 'false');
  properties.setProperty(LEGACY_NOTE_AUDIT_OUTPUT_ROWS_KEY, '0');
}

function logAndToastLegacyNoteAuditContinueResult_(summary, currentSourceSheet, nextRow, complete) {
  Logger.log('Legacy Note Match Audit continue ' + JSON.stringify(Object.assign({}, summary, {
    current_source_sheet: currentSourceSheet,
    next_row: nextRow,
    complete: complete,
  })));
  SpreadsheetApp.getActive().toast(
    'Processed=' + summary.source_rows_checked_this_run
    + ' output=' + summary.output_rows_this_run
    + ' total=' + summary.output_rows_total
    + ' source=' + (currentSourceSheet || '-')
    + ' nextRow=' + nextRow
    + ' complete=' + complete,
    'Legacy Note Match Audit',
    8
  );
}

function summarizeCrm2MatchAuditRows_(rows) {
  return rows.reduce(function (summary, row) {
    const status = row[16] || 'UNKNOWN';
    summary[status] = (summary[status] || 0) + 1;
    summary.total = (summary.total || 0) + 1;
    return summary;
  }, { total: 0, OK: 0 });
}

function clearCrm3OnlyFormattingIfApplied_(cell) {
  if (String(cell.getFontColor() || '').toLowerCase() === CRM3_ONLY_FONT_COLOR.toLowerCase()) {
    cell.setFontColor(CRM3_DEFAULT_FONT_COLOR);
  }
  if (String(cell.getNote() || '') === CRM3_ONLY_NOTE_TEXT) {
    cell.setNote('');
  }
}

function buildLegacyNameWarning_(sourceRow, lead) {
  const sourceName = normalizeCrm2AuditName_(sourceRow.customerName);
  const leadName = lead ? normalizeCrm2AuditName_(lead.customer_name) : '';
  if (!sourceName || !leadName) return '';
  if (sourceName === leadName) return 'NAME_MATCH';
  return 'NAME_DIFF: source="' + sourceRow.customerName + '" crm3="' + lead.customer_name + '"';
}

function parseCrm3OnlyLeadDate_(object) {
  const value = object.facebook_created_time || object.created_at || '';
  if (!value) return null;

  if (typeof parseLeadsViewDateTime_ === 'function') {
    const parsed = parseLeadsViewDateTime_(value);
    if (parsed && parsed instanceof Date && !isNaN(parsed.getTime())) return parsed;
  }

  if (value instanceof Date && !isNaN(value.getTime())) return value;

  const fallback = new Date(value);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function objectFromHeaders_(headers, row) {
  return headers.reduce(function (object, header, index) {
    const normalized = normalizeHeaderName_(header);
    if (normalized) object[normalized] = row[index];
    return object;
  }, {});
}

function getFirstObjectValue_(object, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = String(object[keys[i]] || '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeCrm2AuditName_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeCrm2AuditTextForSearch_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
