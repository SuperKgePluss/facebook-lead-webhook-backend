// Manual, resumable audio-library indexing. This module never applies CRM audio links.
const AUDIO_LIBRARY_INDEX_VERSION = 'audio-library-index-v1';
const AUDIO_LIBRARY_INDEX_SHEET_NAME = 'AUDIO_LIBRARY_INDEX';
const AUDIO_LIBRARY_REVIEW_SHEET_NAME = 'AUDIO_MAPPING_REVIEW';
const AUDIO_LIBRARY_STATE_SHEET_NAME = 'AUDIO_INDEX_STATE';
const AUDIO_LIBRARY_QUEUE_SHEET_NAME = 'AUDIO_INDEX_QUEUE';
const AUDIO_LIBRARY_STATE_ROW_KEY = 'CURRENT_SCAN';
const AUDIO_LIBRARY_MAX_FOLDERS_PER_RUN = 25;
const AUDIO_LIBRARY_MAX_FILES_PER_RUN = 200;
const AUDIO_LIBRARY_MAX_RUNTIME_MS = 240000;
const AUDIO_LIBRARY_SUPPORTED_EXTENSIONS = {
  mp3: true,
  m4a: true,
  wav: true,
  ogg: true,
  mp4: true,
  aac: true,
};

const AUDIO_LIBRARY_INDEX_HEADERS = [
  'Drive File ID',
  'Parent Folder ID',
  'Folder Path',
  'File Name',
  'Extension',
  'File Size',
  'Drive Created At',
  'Drive Modified At',
  'Detected Phone',
  'Matched Lead ID',
  'Match Status',
  'Duplicate Group',
  'Duplicate Status',
  'Indexed At',
  'Last Checked At',
  'Open File',
  'Duplicate Fingerprint',
  'Index Version',
];

const AUDIO_LIBRARY_REVIEW_HEADERS = [
  'Drive File ID',
  'File Name',
  'Folder Path',
  'Open File',
  'Match Status',
  'Detected Phone',
  'Matched Lead ID',
  'Customer Name',
  'CRM Phone',
  'Duplicate Group',
  'Duplicate Status',
  'Last Checked At',
];

const AUDIO_LIBRARY_STATE_HEADERS = ['State Key', 'State Value', 'Updated At'];
const AUDIO_LIBRARY_QUEUE_HEADERS = [
  'Folder ID',
  'Folder Path',
  'File Cursor',
  'Queue Status',
  'Last Checked At',
  'Error',
  'Scan Version',
  'Enqueued At',
];

const AUDIO_LIBRARY_INDEX_FIELD_ALIASES = {
  drive_file_id: ['drive_file_id', 'file_id', 'drive_id'],
  parent_folder_id: ['parent_folder_id', 'folder_id', 'parent_id'],
  folder_path: ['folder_path', 'relative_folder_path', 'path'],
  file_name: ['file_name', 'filename', 'name'],
  extension: ['extension', 'file_extension', 'ext'],
  file_size: ['file_size', 'size', 'bytes'],
  drive_created_at: ['drive_created_at', 'created_at', 'created_time'],
  drive_modified_at: ['drive_modified_at', 'modified_at', 'modified_time', 'updated_at'],
  detected_phone: ['detected_phone', 'phone', 'filename_phone'],
  matched_lead_id: ['matched_lead_id', 'lead_id', 'crm_lead_id'],
  match_status: ['match_status', 'status'],
  duplicate_group: ['duplicate_group', 'duplicate_group_id'],
  duplicate_status: ['duplicate_status', 'duplicate_candidate'],
  indexed_at: ['indexed_at', 'first_indexed_at'],
  last_checked_at: ['last_checked_at', 'checked_at'],
  open_file: ['open_file', 'file_url', 'drive_url', 'url'],
  duplicate_fingerprint: ['duplicate_fingerprint', 'fingerprint'],
  index_version: ['index_version', 'scan_version'],
};

const AUDIO_LIBRARY_REVIEW_FIELD_ALIASES = {
  drive_file_id: ['drive_file_id', 'file_id', 'drive_id'],
  file_name: ['file_name', 'filename', 'name'],
  folder_path: ['folder_path', 'relative_folder_path', 'path'],
  open_file: ['open_file', 'file_url', 'drive_url', 'url'],
  match_status: ['match_status', 'status'],
  detected_phone: ['detected_phone', 'phone', 'filename_phone'],
  matched_lead_id: ['matched_lead_id', 'lead_id', 'crm_lead_id'],
  customer_name: ['customer_name', 'name'],
  crm_phone: ['crm_phone', 'lead_phone'],
  duplicate_group: ['duplicate_group', 'duplicate_group_id'],
  duplicate_status: ['duplicate_status', 'duplicate_candidate'],
  last_checked_at: ['last_checked_at', 'checked_at'],
};

function buildResumeAudioLibraryIndex() {
  return runAudioLibraryIndex_('build');
}

function updateAudioLibraryIndex() {
  return runAudioLibraryIndex_('update');
}

function refreshAudioMappingReview() {
  const ss = SpreadsheetApp.getActive();
  const sheets = ensureAudioLibrarySheets_(ss);
  const indexContext = loadAudioLibraryIndexContext_(sheets.index);
  const leadMap = loadAudioLibraryLeadMap_(ss);
  const records = Object.keys(indexContext.recordsById).map(id => indexContext.recordsById[id]);
  upsertAudioLibraryReview_(sheets.review, records, leadMap);
  return {
    status: 'ok',
    indexed_records: records.length,
    review_rows_refreshed: records.length,
  };
}

function runAudioLibraryIndex_(requestedMode) {
  const startedAt = Date.now();
  const ss = SpreadsheetApp.getActive();
  const sheets = ensureAudioLibrarySheets_(ss);
  const rootFolderId = getAudioLibraryRootFolderId_();
  if (!rootFolderId) {
    return audioLibraryResult_('NEEDS_REVIEW', requestedMode, {
      error: 'missing_audio_root_folder',
    });
  }

  let state = readAudioLibraryState_(sheets.state);
  const canResume = state && ['IN_PROGRESS', 'PAUSED', 'NEEDS_REVIEW'].indexOf(state.status) !== -1;
  if (canResume) {
    resetAudioLibraryInterruptedQueueItems_(sheets.queue, state.scan_version);
  } else if (state && state.status === 'COMPLETE' && requestedMode === 'build') {
    return audioLibraryResult_('COMPLETE', 'build', {
      scan_version: state.scan_version,
      message: 'Existing completed index preserved; use Update Audio Index for a later scan.',
    });
  } else {
    state = initializeAudioLibraryState_(sheets, rootFolderId, requestedMode);
  }

  if (state.root_folder_id !== rootFolderId) {
    return audioLibraryResult_('NEEDS_REVIEW', requestedMode, {
      error: 'root_folder_changed_during_scan',
      scan_version: state.scan_version,
    });
  }

  state.status = 'IN_PROGRESS';
  state.last_run_at = new Date().toISOString();
  state.last_error = '';
  persistAudioLibraryState_(sheets.state, state);

  const queue = readAudioLibraryQueue_(sheets.queue, state.scan_version);
  const queueByFolderId = {};
  queue.forEach(item => {
    queueByFolderId[item.folder_id] = item;
  });

  const indexContext = loadAudioLibraryIndexContext_(sheets.index);
  const leadMap = loadAudioLibraryLeadMap_(ss);
  const runStats = {
    folders_scanned: 0,
    files_scanned: 0,
    supported_audio_files: 0,
    unsupported_extension_files: 0,
    inaccessible_folders: 0,
    inaccessible_files: 0,
    parseable_filenames: 0,
    malformed_filenames: 0,
    matched_candidates: 0,
    unmatched_files: 0,
    ambiguous_phone_files: 0,
    ambiguous_lead_files: 0,
    duplicate_candidates: 0,
    paused_by_limit: false,
  };

  while (runStats.folders_scanned < AUDIO_LIBRARY_MAX_FOLDERS_PER_RUN) {
    if (Date.now() - startedAt >= AUDIO_LIBRARY_MAX_RUNTIME_MS) {
      runStats.paused_by_limit = true;
      break;
    }

    const folderItem = getNextAudioLibraryQueueItem_(queue);
    if (!folderItem) break;

    folderItem.queue_status = 'IN_PROGRESS';
    folderItem.last_checked_at = new Date();
    updateAudioLibraryQueueItem_(sheets.queue, folderItem);
    runStats.folders_scanned++;
    state.current_folder_id = folderItem.folder_id;
    state.current_folder_path = folderItem.folder_path;

    let folderResult;
    try {
      folderResult = scanAudioLibraryFolder_(folderItem, queue, queueByFolderId, runStats, startedAt);
    } catch (err) {
      folderResult = {
        complete: false,
        error: 'folder_scan_failed',
        error_message: String(err && err.message || err).slice(0, 300),
        records: [],
      };
    }

    if (folderResult.records.length) {
      const changedRecords = upsertAudioLibraryIndexRecords_(indexContext, folderResult.records, state.mode);
      const duplicateRecords = updateAudioLibraryDuplicateGroups_(indexContext, changedRecords);
      const reviewRecords = uniqueAudioLibraryRecords_(changedRecords.concat(duplicateRecords));
      upsertAudioLibraryReview_(sheets.review, reviewRecords, leadMap);
      runStats.supported_audio_files += folderResult.supported_audio_files;
      runStats.unsupported_extension_files += folderResult.unsupported_extension_files;
      runStats.parseable_filenames += folderResult.parseable_filenames;
      runStats.malformed_filenames += folderResult.malformed_filenames;
      runStats.matched_candidates += folderResult.matched_candidates;
      runStats.unmatched_files += folderResult.unmatched_files;
      runStats.ambiguous_phone_files += folderResult.ambiguous_phone_files;
      runStats.ambiguous_lead_files += folderResult.ambiguous_lead_files;
      runStats.duplicate_candidates += duplicateRecords.length;
    }

    if (folderResult.error) {
      folderItem.queue_status = 'FAILED';
      folderItem.error = folderResult.error_message || folderResult.error;
      state.last_error = folderItem.error;
      runStats.inaccessible_folders++;
    } else if (folderResult.complete) {
      folderItem.queue_status = 'DONE';
      folderItem.error = '';
      state.processed_folder_count = Number(state.processed_folder_count || 0) + 1;
    } else {
      folderItem.queue_status = 'PENDING';
      runStats.paused_by_limit = true;
    }

    folderItem.last_checked_at = new Date();
    updateAudioLibraryQueueItem_(sheets.queue, folderItem);
    state.processed_file_count = Number(state.processed_file_count || 0) + folderResult.files_scanned;
    state.last_successful_checkpoint = new Date().toISOString();
    persistAudioLibraryState_(sheets.state, state);

    if (folderResult.error || !folderResult.complete || runStats.paused_by_limit) break;
  }

  const pending = queue.some(item => item.queue_status === 'PENDING' || item.queue_status === 'IN_PROGRESS');
  const failed = queue.some(item => item.queue_status === 'FAILED');
  if (!pending) {
    state.status = failed ? 'NEEDS_REVIEW' : 'COMPLETE';
    state.current_folder_id = '';
    state.current_folder_path = '';
  } else {
    state.status = 'PAUSED';
  }
  state.last_run_at = new Date().toISOString();
  persistAudioLibraryState_(sheets.state, state);

  const result = audioLibraryResult_(state.status, state.mode, Object.assign({}, runStats, {
    scan_version: state.scan_version,
    processed_folder_count: state.processed_folder_count,
    processed_file_count: state.processed_file_count,
    queue_history_pruned: Number(state.queue_history_pruned || 0),
    pending_folders: queue.filter(item => item.queue_status === 'PENDING' || item.queue_status === 'IN_PROGRESS').length,
    failed_folders: queue.filter(item => item.queue_status === 'FAILED').length,
  }));
  Logger.log('Audio library index ' + JSON.stringify(result));
  return result;
}

function scanAudioLibraryFolder_(folderItem, queue, queueByFolderId, runStats, startedAt) {
  let folder;
  try {
    folder = DriveApp.getFolderById(folderItem.folder_id);
  } catch (err) {
    return {
      complete: false,
      error: 'folder_access',
      error_message: 'Unable to access an indexed folder.',
      records: [],
      files_scanned: 0,
    };
  }

  const records = [];
  let filesScanned = 0;
  let complete = true;
  let files;
  try {
    files = folder.getFiles();
  } catch (err) {
    return {
      complete: false,
      error: 'folder_files_access',
      error_message: 'Unable to enumerate files in an indexed folder.',
      records: [],
      files_scanned: 0,
    };
  }

  let fileCursor = Math.max(0, Number(folderItem.file_cursor) || 0);
  let fileIndex = 0;
  while (files.hasNext()) {
    if (Date.now() - startedAt >= AUDIO_LIBRARY_MAX_RUNTIME_MS) {
      complete = false;
      break;
    }
    if (fileIndex < fileCursor) {
      try {
        files.next();
        fileIndex++;
        continue;
      } catch (err) {
        return {
          complete: false,
          error: 'file_cursor_access',
          error_message: 'Unable to resume file enumeration safely.',
          records: records,
          files_scanned: filesScanned,
        };
      }
    }

    if (
      runStats.files_scanned + filesScanned >= AUDIO_LIBRARY_MAX_FILES_PER_RUN
      || Date.now() - startedAt >= AUDIO_LIBRARY_MAX_RUNTIME_MS
    ) {
      complete = false;
      break;
    }

    let file;
    try {
      file = files.next();
      fileIndex++;
      filesScanned++;
      runStats.files_scanned++;
      records.push(buildAudioLibraryFileRecord_(file, folderItem));
    } catch (err) {
      runStats.inaccessible_files++;
      filesScanned++;
      runStats.files_scanned++;
    }
  }

  folderItem.file_cursor = files.hasNext() ? fileIndex : 0;

  if (complete) {
    let subfolders;
    try {
      subfolders = folder.getFolders();
    } catch (err) {
      return {
        complete: false,
        error: 'subfolder_access',
        error_message: 'Unable to enumerate nested folders.',
        records: records,
        files_scanned: filesScanned,
      };
    }

    while (subfolders.hasNext()) {
      if (Date.now() - startedAt >= AUDIO_LIBRARY_MAX_RUNTIME_MS) {
        complete = false;
        break;
      }
      const subfolder = subfolders.next();
      let subfolderId = '';
      let subfolderName = '';
      try {
        subfolderId = String(subfolder.getId() || '').trim();
        subfolderName = String(subfolder.getName() || '').trim();
      } catch (err) {
        runStats.inaccessible_folders++;
        continue;
      }
      if (!subfolderId || queueByFolderId[subfolderId]) continue;

      const child = {
        folder_id: subfolderId,
        folder_path: folderItem.folder_path ? folderItem.folder_path + '/' + subfolderName : subfolderName,
        file_cursor: 0,
        queue_status: 'PENDING',
        last_checked_at: '',
        error: '',
        scan_version: folderItem.scan_version,
        enqueued_at: new Date(),
        row: 0,
      };
      queueByFolderId[subfolderId] = child;
      queue.push(child);
      appendAudioLibraryQueueItem_(child);
    }
  }

  return {
    complete: complete,
    records: records,
    files_scanned: filesScanned,
    supported_audio_files: records.filter(record => record.extension && AUDIO_LIBRARY_SUPPORTED_EXTENSIONS[record.extension]).length,
    unsupported_extension_files: records.filter(record => !AUDIO_LIBRARY_SUPPORTED_EXTENSIONS[record.extension]).length,
    parseable_filenames: records.filter(record => record.filename_parse_status === 'PARSEABLE').length,
    malformed_filenames: records.filter(record => record.filename_parse_status === 'MALFORMED').length,
    matched_candidates: records.filter(record => record.match_status === 'MATCHED_CANDIDATE').length,
    unmatched_files: records.filter(record => ['PHONE_NOT_FOUND', 'NO_PHONE_IN_FILENAME'].indexOf(record.match_status) !== -1).length,
    ambiguous_phone_files: records.filter(record => record.match_status === 'AMBIGUOUS_PHONE').length,
    ambiguous_lead_files: records.filter(record => record.match_status === 'AMBIGUOUS_LEAD').length,
  };
}

function buildAudioLibraryFileRecord_(file, folderItem) {
  const now = new Date();
  const fileName = String(file.getName() || '').trim();
  const extension = audioLibraryExtension_(fileName);
  const supported = Boolean(AUDIO_LIBRARY_SUPPORTED_EXTENSIONS[extension]);
  let createdAt = '';
  let modifiedAt = '';
  let fileSize = '';
  let openFile = '';

  try { createdAt = file.getDateCreated(); } catch (err) { createdAt = ''; }
  try { modifiedAt = file.getLastUpdated(); } catch (err) { modifiedAt = ''; }
  try { fileSize = file.getSize(); } catch (err) { fileSize = ''; }
  try { openFile = file.getUrl(); } catch (err) { openFile = ''; }

  const parsed = supported ? audioLibraryParseFilename_(fileName) : null;
  const match = supported ? audioLibraryBuildMatch_(fileName, parsed, loadAudioLibraryLeadMapFromCache_()) : {
    status: 'UNSUPPORTED_EXTENSION',
    detectedPhone: '',
    matchedLeadId: '',
  };
  const fingerprint = supported && fileSize !== ''
    ? audioLibraryDuplicateFingerprint_(fileName, fileSize)
    : '';

  return {
    drive_file_id: String(file.getId() || '').trim(),
    parent_folder_id: folderItem.folder_id,
    folder_path: folderItem.folder_path,
    file_name: fileName,
    extension: extension,
    file_size: fileSize,
    drive_created_at: createdAt,
    drive_modified_at: modifiedAt,
    detected_phone: match.detectedPhone || '',
    matched_lead_id: match.matchedLeadId || '',
    match_status: match.status,
    duplicate_group: '',
    duplicate_status: fingerprint ? 'UNIQUE' : 'NOT_APPLICABLE',
    indexed_at: now,
    last_checked_at: now,
    open_file: openFile,
    duplicate_fingerprint: fingerprint,
    index_version: AUDIO_LIBRARY_INDEX_VERSION,
    filename_parse_status: supported ? (parsed ? 'PARSEABLE' : 'MALFORMED') : 'NOT_APPLICABLE',
  };
}

// The active lead map is supplied by the run before folder scanning.
let AUDIO_LIBRARY_LEAD_MAP_CACHE_ = null;

function loadAudioLibraryLeadMapFromCache_() {
  return AUDIO_LIBRARY_LEAD_MAP_CACHE_ || { byPhone: {}, byId: {} };
}

function loadAudioLibraryLeadMap_(ss) {
  const sheet = ss.getSheetByName('LEADS_MAIN');
  const result = { byPhone: {}, byId: {} };
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) {
    AUDIO_LIBRARY_LEAD_MAP_CACHE_ = result;
    return result;
  }

  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headerMap = headers.reduce((map, header, index) => {
    const key = typeof normalizeHeaderName_ === 'function'
      ? normalizeHeaderName_(header)
      : audioLibraryNormalizeHeader_(header);
    if (key) map[key] = index;
    return map;
  }, {});
  const leadIdIndex = audioLibraryFirstColumn_(headerMap, ['lead_id', 'id']);
  const phoneIndex = audioLibraryFirstColumn_(headerMap, ['phone', 'telephone', 'mobile', 'phone_number']);
  const nameIndex = audioLibraryFirstColumn_(headerMap, ['customer_name', 'full_name', 'name']);
  if (leadIdIndex === -1 || phoneIndex === -1) {
    AUDIO_LIBRARY_LEAD_MAP_CACHE_ = result;
    return result;
  }

  const rows = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  rows.forEach(row => {
    const leadId = String(row[leadIdIndex] || '').trim();
    const rawPhone = String(row[phoneIndex] || '').trim();
    if (!leadId) return;
    const lead = {
      leadId: leadId,
      customerName: nameIndex === -1 ? '' : String(row[nameIndex] || '').trim(),
      crmPhone: audioLibraryPhoneText_(rawPhone),
    };
    result.byId[leadId] = lead;

    const normalizedPhone = audioLibraryNormalizeCrmPhone_(rawPhone);
    if (!normalizedPhone) return;
    if (!result.byPhone[normalizedPhone]) result.byPhone[normalizedPhone] = [];
    result.byPhone[normalizedPhone].push(lead);
  });

  AUDIO_LIBRARY_LEAD_MAP_CACHE_ = result;
  return result;
}

function audioLibraryNormalizeCrmPhone_(value) {
  const normalized = typeof normalizeAudioPhoneKey_ === 'function'
    ? String(normalizeAudioPhoneKey_(value) || '').trim()
    : String(value || '').replace(/\D+/g, '');
  const textValue = audioLibraryPhoneText_(normalized);
  return /^0\d{9}$/.test(textValue) ? textValue : '';
}

function audioLibraryBuildMatch_(fileName, parsed, leadMap) {
  const candidates = audioLibraryExtractPhoneCandidates_(fileName);
  if (!candidates.length) {
    return { status: 'NO_PHONE_IN_FILENAME', detectedPhone: '', matchedLeadId: '' };
  }
  if (candidates.length > 1) {
    return { status: 'AMBIGUOUS_PHONE', detectedPhone: '', matchedLeadId: '' };
  }

  const phone = candidates[0];
  const leads = (leadMap && leadMap.byPhone && leadMap.byPhone[phone]) || [];
  if (!parsed && leads.length === 1) {
    return { status: 'MATCHED_CANDIDATE', detectedPhone: phone, matchedLeadId: leads[0].leadId };
  }
  if (!parsed) {
    return { status: 'MALFORMED_FILENAME', detectedPhone: '', matchedLeadId: '' };
  }
  if (!leads.length) {
    return { status: 'PHONE_NOT_FOUND', detectedPhone: phone, matchedLeadId: '' };
  }
  if (leads.length !== 1) {
    return { status: 'AMBIGUOUS_LEAD', detectedPhone: phone, matchedLeadId: '' };
  }
  return { status: 'MATCHED_CANDIDATE', detectedPhone: phone, matchedLeadId: leads[0].leadId };
}

function audioLibraryExtractPhoneCandidates_(value) {
  const runs = String(value || '').match(/\d+/g) || [];
  return runs.filter(run => /^0\d{9}$/.test(run));
}

function audioLibraryParseFilename_(fileName) {
  const raw = String(fileName || '').trim();
  const withoutExtension = raw.replace(/\.[^.]+$/, '');
  const match = withoutExtension.match(/^(.+)_(\d{6}|\d{8})_(\d{2})_(\d{2})$/);
  if (!match) return null;

  const parsedDate = audioLibraryParseDate_(match[2], match[3], match[4]);
  if (!parsedDate) return null;
  return {
    key: match[1],
    timestampKey: parsedDate.timestampKey,
    parsedTimestamp: parsedDate.parsedTimestamp,
  };
}

function audioLibraryParseDate_(datePart, hour, minute) {
  const rawDate = String(datePart || '');
  const rawHour = Number(hour);
  const rawMinute = Number(minute);
  if (!Number.isInteger(rawHour) || rawHour < 0 || rawHour > 23) return null;
  if (!Number.isInteger(rawMinute) || rawMinute < 0 || rawMinute > 59) return null;

  const candidates = [];
  if (/^\d{6}$/.test(rawDate)) {
    candidates.push(['20' + rawDate.slice(4, 6), rawDate.slice(2, 4), rawDate.slice(0, 2)]);
  } else if (/^(19|20)\d{6}$/.test(rawDate)) {
    candidates.push([rawDate.slice(0, 4), rawDate.slice(4, 6), rawDate.slice(6, 8)]);
  } else if (/^\d{4}(19|20)\d{2}$/.test(rawDate)) {
    candidates.push([rawDate.slice(4, 8), rawDate.slice(2, 4), rawDate.slice(0, 2)]);
    candidates.push([rawDate.slice(4, 8), rawDate.slice(0, 2), rawDate.slice(2, 4)]);
  } else {
    return null;
  }

  for (let i = 0; i < candidates.length; i++) {
    const year = Number(candidates[i][0]);
    const month = Number(candidates[i][1]);
    const day = Number(candidates[i][2]);
    const date = new Date(year, month - 1, day, rawHour, rawMinute);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
      || date.getHours() !== rawHour
      || date.getMinutes() !== rawMinute
    ) continue;

    const monthText = String(month).padStart(2, '0');
    const dayText = String(day).padStart(2, '0');
    const hourText = String(rawHour).padStart(2, '0');
    const minuteText = String(rawMinute).padStart(2, '0');
    return {
      timestampKey: String(year) + monthText + dayText + hourText + minuteText,
      parsedTimestamp: String(year) + '-' + monthText + '-' + dayText + ' ' + hourText + ':' + minuteText,
    };
  }
  return null;
}

function audioLibraryExtension_(fileName) {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function audioLibraryDuplicateFingerprint_(fileName, fileSize) {
  return String(fileName || '').trim().toLowerCase() + '|' + String(fileSize);
}

function ensureAudioLibrarySheets_(ss) {
  return {
    index: ensureAudioLibrarySheet_(ss, AUDIO_LIBRARY_INDEX_SHEET_NAME, AUDIO_LIBRARY_INDEX_HEADERS),
    review: ensureAudioLibrarySheet_(ss, AUDIO_LIBRARY_REVIEW_SHEET_NAME, AUDIO_LIBRARY_REVIEW_HEADERS),
    state: ensureAudioLibrarySheet_(ss, AUDIO_LIBRARY_STATE_SHEET_NAME, AUDIO_LIBRARY_STATE_HEADERS),
    queue: ensureAudioLibrarySheet_(ss, AUDIO_LIBRARY_QUEUE_SHEET_NAME, AUDIO_LIBRARY_QUEUE_HEADERS),
  };
}

function ensureAudioLibrarySheet_(ss, name, requiredHeaders) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const aliases = name === AUDIO_LIBRARY_INDEX_SHEET_NAME
    ? AUDIO_LIBRARY_INDEX_FIELD_ALIASES
    : name === AUDIO_LIBRARY_REVIEW_SHEET_NAME
      ? AUDIO_LIBRARY_REVIEW_FIELD_ALIASES
      : null;
  ensureAudioLibraryHeaders_(sheet, requiredHeaders, aliases);
  if (name === AUDIO_LIBRARY_INDEX_SHEET_NAME) {
    audioLibraryEnsurePhoneTextColumns_(sheet, AUDIO_LIBRARY_INDEX_FIELD_ALIASES, DATA_START_ROW, ['detected_phone']);
  } else if (name === AUDIO_LIBRARY_REVIEW_SHEET_NAME) {
    audioLibraryEnsurePhoneTextColumns_(sheet, AUDIO_LIBRARY_REVIEW_FIELD_ALIASES, HEADER_ROW + 1, ['detected_phone', 'crm_phone']);
  }
  return sheet;
}

function ensureAudioLibraryHeaders_(sheet, requiredHeaders, aliasDefinitions) {
  const columnCount = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(HEADER_ROW, 1, 1, columnCount).getValues()[0];
  if (!headers.some(value => String(value || '').trim())) headers = [];

  const existing = {};
  headers.forEach((header, index) => {
    const key = audioLibraryNormalizeHeader_(header);
    if (key) existing[key] = index + 1;
  });

  requiredHeaders.forEach(header => {
    const key = audioLibraryNormalizeHeader_(header);
    const aliases = aliasDefinitions && aliasDefinitions[key] ? aliasDefinitions[key] : [key];
    if (aliases.some(alias => existing[audioLibraryNormalizeHeader_(alias)])) return;
    headers.push(header);
    existing[key] = headers.length;
  });

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
}

function audioLibraryNormalizeHeader_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function audioLibraryFirstColumn_(headerMap, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    if (headerMap[candidates[i]] !== undefined) return headerMap[candidates[i]];
  }
  return -1;
}

function audioLibraryFieldMap_(sheet, definitions) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  const normalized = headers.map(audioLibraryNormalizeHeader_);
  const map = {};
  Object.keys(definitions).forEach(key => {
    const aliases = definitions[key];
    for (let i = 0; i < aliases.length; i++) {
      const index = normalized.indexOf(audioLibraryNormalizeHeader_(aliases[i]));
      if (index !== -1) {
        map[key] = index + 1;
        break;
      }
    }
  });
  return map;
}

function audioLibraryPhoneText_(value) {
  let digits = String(value === undefined || value === null ? '' : value).replace(/\D+/g, '');
  if (!digits) return '';
  if (/^\d{9}$/.test(digits)) digits = '0' + digits;
  return digits;
}

function audioLibraryOutputValue_(key, value) {
  if (key === 'detected_phone' || key === 'crm_phone') return audioLibraryPhoneText_(value);
  return value === undefined ? '' : value;
}

function audioLibraryEnsurePhoneTextColumns_(sheet, definitions, dataStartRow, keys) {
  if (sheet.getLastRow() < dataStartRow) return;
  const fieldMap = audioLibraryFieldMap_(sheet, definitions);
  const rowCount = sheet.getLastRow() - dataStartRow + 1;
  keys.forEach(key => {
    const column = fieldMap[key];
    if (!column) return;
    const range = sheet.getRange(dataStartRow, column, rowCount, 1);
    range.setNumberFormat('@');
    range.setValues(range.getValues().map(row => [audioLibraryPhoneText_(row[0])]));
  });
}

function initializeAudioLibraryState_(sheets, rootFolderId, mode) {
  const scanVersion = AUDIO_LIBRARY_INDEX_VERSION + '-' + Date.now();
  const queueHistoryPruned = pruneAudioLibraryCompletedQueueHistory_(sheets.queue);
  const state = {
    version: AUDIO_LIBRARY_INDEX_VERSION,
    scan_version: scanVersion,
    root_folder_id: rootFolderId,
    mode: mode,
    status: 'IN_PROGRESS',
    current_folder_id: '',
    current_folder_path: '',
    processed_folder_count: 0,
    processed_file_count: 0,
    last_successful_checkpoint: '',
    last_run_at: new Date().toISOString(),
    last_error: '',
    queue_history_pruned: queueHistoryPruned,
  };
  appendAudioLibraryQueueItem_({
    folder_id: rootFolderId,
    folder_path: '',
    file_cursor: 0,
    queue_status: 'PENDING',
    last_checked_at: '',
    error: '',
    scan_version: scanVersion,
    enqueued_at: new Date(),
    row: 0,
  });
  persistAudioLibraryState_(sheets.state, state);
  return state;
}

function pruneAudioLibraryCompletedQueueHistory_(sheet) {
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return 0;
  const fieldMap = audioLibraryFieldMap_(sheet, { queue_status: ['queue_status'] });
  if (!fieldMap.queue_status) return 0;
  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const statuses = sheet.getRange(DATA_START_ROW, fieldMap.queue_status, rowCount, 1).getValues();
  const rowsToDelete = [];
  statuses.forEach((row, index) => {
    if (audioLibraryQueueRowIsSafeToPrune_(row[0])) rowsToDelete.push(DATA_START_ROW + index);
  });
  rowsToDelete.sort((left, right) => right - left).forEach(rowNumber => sheet.deleteRow(rowNumber));
  return rowsToDelete.length;
}

function audioLibraryQueueRowIsSafeToPrune_(status) {
  return String(status || '').trim().toUpperCase() === 'DONE';
}

function readAudioLibraryState_(sheet) {
  if (sheet.getLastRow() < DATA_START_ROW) return null;
  const fieldMap = audioLibraryFieldMap_(sheet, {
    state_key: ['state_key'],
    state_value: ['state_value'],
  });
  if (!fieldMap.state_key || !fieldMap.state_value) return null;
  const rows = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][fieldMap.state_key - 1] || '') !== AUDIO_LIBRARY_STATE_ROW_KEY) continue;
    try {
      return JSON.parse(String(rows[i][fieldMap.state_value - 1] || '{}'));
    } catch (err) {
      return null;
    }
  }
  return null;
}

function persistAudioLibraryState_(sheet, state) {
  const fieldMap = audioLibraryFieldMap_(sheet, {
    state_key: ['state_key'],
    state_value: ['state_value'],
    updated_at: ['updated_at'],
  });
  const row = Math.max(sheet.getLastRow() + 1, DATA_START_ROW);
  const existingRows = sheet.getLastRow() >= DATA_START_ROW
    ? sheet.getRange(DATA_START_ROW, fieldMap.state_key, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues()
    : [];
  let targetRow = row;
  for (let i = existingRows.length - 1; i >= 0; i--) {
    if (String(existingRows[i][0] || '') === AUDIO_LIBRARY_STATE_ROW_KEY) {
      targetRow = DATA_START_ROW + i;
      break;
    }
  }
  sheet.getRange(targetRow, fieldMap.state_key).setValue(AUDIO_LIBRARY_STATE_ROW_KEY);
  sheet.getRange(targetRow, fieldMap.state_value).setValue(JSON.stringify(state));
  if (fieldMap.updated_at) sheet.getRange(targetRow, fieldMap.updated_at).setValue(new Date());
}

function readAudioLibraryQueue_(sheet, scanVersion) {
  if (sheet.getLastRow() < DATA_START_ROW) return [];
  const fieldMap = audioLibraryFieldMap_(sheet, {
    folder_id: ['folder_id'],
    folder_path: ['folder_path'],
    file_cursor: ['file_cursor'],
    queue_status: ['queue_status'],
    last_checked_at: ['last_checked_at'],
    error: ['error'],
    scan_version: ['scan_version'],
    enqueued_at: ['enqueued_at'],
  });
  const rows = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  return rows.map((row, index) => ({
    folder_id: String(row[fieldMap.folder_id - 1] || '').trim(),
    folder_path: String(row[fieldMap.folder_path - 1] || '').trim(),
    file_cursor: Number(row[fieldMap.file_cursor - 1] || 0),
    queue_status: String(row[fieldMap.queue_status - 1] || '').trim(),
    last_checked_at: row[fieldMap.last_checked_at - 1] || '',
    error: String(row[fieldMap.error - 1] || '').trim(),
    scan_version: String(row[fieldMap.scan_version - 1] || '').trim(),
    enqueued_at: row[fieldMap.enqueued_at - 1] || '',
    row: DATA_START_ROW + index,
  })).filter(item => item.scan_version === scanVersion && item.folder_id);
}

function resetAudioLibraryInterruptedQueueItems_(sheet, scanVersion) {
  const queue = readAudioLibraryQueue_(sheet, scanVersion);
  queue.filter(item => item.queue_status === 'IN_PROGRESS' || item.queue_status === 'FAILED').forEach(item => {
    item.queue_status = 'PENDING';
    updateAudioLibraryQueueItem_(sheet, item);
  });
}

function getNextAudioLibraryQueueItem_(queue) {
  return queue.find(item => item.queue_status === 'PENDING' || item.queue_status === 'IN_PROGRESS') || null;
}

function appendAudioLibraryQueueItem_(item) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(AUDIO_LIBRARY_QUEUE_SHEET_NAME);
  if (!sheet) throw new Error('Missing audio index queue sheet.');
  const fieldMap = audioLibraryFieldMap_(sheet, {
    folder_id: ['folder_id'],
    folder_path: ['folder_path'],
    file_cursor: ['file_cursor'],
    queue_status: ['queue_status'],
    last_checked_at: ['last_checked_at'],
    error: ['error'],
    scan_version: ['scan_version'],
    enqueued_at: ['enqueued_at'],
  });
  const row = Math.max(sheet.getLastRow() + 1, DATA_START_ROW);
  Object.keys(fieldMap).forEach(key => sheet.getRange(row, fieldMap[key]).setValue(item[key] || ''));
  item.row = row;
}

function updateAudioLibraryQueueItem_(sheet, item) {
  if (!item.row) return;
  const fieldMap = audioLibraryFieldMap_(sheet, {
    file_cursor: ['file_cursor'],
    queue_status: ['queue_status'],
    last_checked_at: ['last_checked_at'],
    error: ['error'],
  });
  if (fieldMap.queue_status) sheet.getRange(item.row, fieldMap.queue_status).setValue(item.queue_status || '');
  if (fieldMap.file_cursor) sheet.getRange(item.row, fieldMap.file_cursor).setValue(Number(item.file_cursor) || 0);
  if (fieldMap.last_checked_at) sheet.getRange(item.row, fieldMap.last_checked_at).setValue(item.last_checked_at || '');
  if (fieldMap.error) sheet.getRange(item.row, fieldMap.error).setValue(item.error || '');
}

function getAudioLibraryRootFolderId_() {
  if (typeof getAudioRootFolderId_ === 'function') {
    return String(getAudioRootFolderId_() || '').trim();
  }
  if (typeof AUDIO_ROOT_FOLDER_ID !== 'undefined') {
    return String(AUDIO_ROOT_FOLDER_ID || '').trim();
  }
  return '';
}

function loadAudioLibraryIndexContext_(sheet) {
  const fieldMap = audioLibraryFieldMap_(sheet, AUDIO_LIBRARY_INDEX_FIELD_ALIASES);
  const rows = sheet.getLastRow() >= DATA_START_ROW
    ? sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues()
    : [];
  const recordsById = {};
  rows.forEach((row, index) => {
    const id = fieldMap.drive_file_id ? String(row[fieldMap.drive_file_id - 1] || '').trim() : '';
    if (!id) return;
    const record = audioLibraryRecordFromRow_(row, fieldMap);
    record.row = DATA_START_ROW + index;
    recordsById[id] = record;
  });
  return {
    sheet: sheet,
    fieldMap: fieldMap,
    recordsById: recordsById,
    dataRowCount: rows.length,
  };
}

function audioLibraryRecordFromRow_(row, fieldMap) {
  const record = {};
  Object.keys(fieldMap).forEach(key => record[key] = row[fieldMap[key] - 1]);
  return record;
}

function upsertAudioLibraryIndexRecords_(context, records, mode) {
  const changed = [];
  const newRows = [];
  const now = new Date();

  records.forEach(nextRecord => {
    if (!nextRecord.drive_file_id) return;
    const existing = context.recordsById[nextRecord.drive_file_id];
    if (existing) {
      nextRecord.row = existing.row;
      if (mode === 'update' && !audioLibraryRecordNeedsRefresh_(existing, nextRecord)) {
        const retained = Object.assign({}, existing, {
          parent_folder_id: nextRecord.parent_folder_id,
          folder_path: nextRecord.folder_path,
          last_checked_at: nextRecord.last_checked_at,
        });
        retained._changed_keys = ['parent_folder_id', 'folder_path', 'last_checked_at'];
        context.recordsById[nextRecord.drive_file_id] = retained;
        changed.push(retained);
      } else {
        nextRecord.indexed_at = existing.indexed_at || now;
        nextRecord._changed_keys = Object.keys(context.fieldMap);
        if (existing.duplicate_fingerprint && existing.duplicate_fingerprint !== nextRecord.duplicate_fingerprint) {
          nextRecord._previous_duplicate_fingerprint = existing.duplicate_fingerprint;
        }
        context.recordsById[nextRecord.drive_file_id] = Object.assign({}, existing, nextRecord);
        changed.push(context.recordsById[nextRecord.drive_file_id]);
      }
    } else {
      nextRecord.row = DATA_START_ROW + context.dataRowCount + newRows.length;
      nextRecord.indexed_at = nextRecord.indexed_at || now;
      context.recordsById[nextRecord.drive_file_id] = nextRecord;
      newRows.push(nextRecord);
      changed.push(nextRecord);
    }
  });

  if (newRows.length) {
    const lastColumn = context.sheet.getLastColumn();
    const values = newRows.map(record => audioLibraryRowValues_(record, context.fieldMap, lastColumn));
    context.sheet.getRange(DATA_START_ROW + context.dataRowCount, 1, values.length, lastColumn).setValues(values);
    context.dataRowCount += newRows.length;
  }

  const existingChanged = changed.filter(record => record.row < DATA_START_ROW + context.dataRowCount - newRows.length);
  audioLibraryWriteIndexFieldChanges_(context, existingChanged);
  audioLibraryEnsurePhoneTextColumns_(context.sheet, AUDIO_LIBRARY_INDEX_FIELD_ALIASES, DATA_START_ROW, ['detected_phone']);
  return changed;
}

function audioLibraryRecordNeedsRefresh_(existing, nextRecord) {
  const metadataKeys = [
    'parent_folder_id',
    'folder_path',
    'file_name',
    'extension',
    'file_size',
    'drive_created_at',
    'drive_modified_at',
    'open_file',
  ];
  const metadataChanged = metadataKeys.some(key => String(existing[key] || '') !== String(nextRecord[key] || ''));
  if (metadataChanged) return true;
  return ['PHONE_NOT_FOUND', 'AMBIGUOUS_LEAD'].indexOf(String(existing.match_status || '')) !== -1;
}

function audioLibraryRowValues_(record, fieldMap, columnCount) {
  const row = new Array(columnCount).fill('');
  Object.keys(fieldMap).forEach(key => row[fieldMap[key] - 1] = audioLibraryOutputValue_(key, record[key]));
  return row;
}

function audioLibraryWriteIndexFieldChanges_(context, records) {
  if (!records.length) return;
  records.forEach(record => {
    const keys = record._changed_keys || Object.keys(context.fieldMap);
    keys.forEach(key => {
    const column = context.fieldMap[key];
    if (!column) return;
      context.sheet.getRange(record.row, column).setValue(audioLibraryOutputValue_(key, record[key]));
    });
  });
}

function updateAudioLibraryDuplicateGroups_(context, changedRecords) {
  const affected = {};
  changedRecords.forEach(record => {
    if (record.duplicate_fingerprint) affected[record.duplicate_fingerprint] = true;
    if (record._previous_duplicate_fingerprint) affected[record._previous_duplicate_fingerprint] = true;
  });
  const affectedRecords = [];
  Object.keys(affected).forEach(fingerprint => {
    const group = Object.keys(context.recordsById)
      .map(id => context.recordsById[id])
      .filter(record => record.duplicate_fingerprint === fingerprint);
    const groupId = group.length > 1 ? audioLibraryDuplicateGroupId_(fingerprint) : '';
    group.forEach(record => {
      record.duplicate_group = groupId;
      record.duplicate_status = group.length > 1 ? 'DUPLICATE_CANDIDATE' : 'UNIQUE';
      record._changed_keys = ['duplicate_group', 'duplicate_status'];
      affectedRecords.push(record);
    });
  });
  audioLibraryWriteIndexFieldChanges_(context, affectedRecords);
  return affectedRecords;
}

function audioLibraryDuplicateGroupId_(fingerprint) {
  let hash = 2166136261;
  String(fingerprint || '').split('').forEach(character => {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  });
  return 'DUP-' + (hash >>> 0).toString(16).padStart(8, '0');
}

function uniqueAudioLibraryRecords_(records) {
  const byId = {};
  records.forEach(record => {
    if (record && record.drive_file_id) byId[record.drive_file_id] = record;
  });
  return Object.keys(byId).map(id => byId[id]);
}

function upsertAudioLibraryReview_(sheet, records, leadMap) {
  if (!records.length) return;
  const fieldMap = audioLibraryFieldMap_(sheet, AUDIO_LIBRARY_REVIEW_FIELD_ALIASES);
  const reviewDataStartRow = HEADER_ROW + 1;
  let existingRows = sheet.getLastRow() >= reviewDataStartRow
    ? sheet.getRange(reviewDataStartRow, 1, sheet.getLastRow() - reviewDataStartRow + 1, sheet.getLastColumn()).getValues()
    : [];
  const rowsByFileId = {};
  const duplicateRows = [];
  existingRows.forEach((row, index) => {
    const fileId = fieldMap.drive_file_id ? String(row[fieldMap.drive_file_id - 1] || '').trim() : '';
    if (!fileId) return;
    if (rowsByFileId[fileId]) {
      duplicateRows.push(reviewDataStartRow + index);
    } else {
      rowsByFileId[fileId] = reviewDataStartRow + index;
    }
  });

  duplicateRows.sort((left, right) => right - left).forEach(rowNumber => sheet.deleteRow(rowNumber));
  if (duplicateRows.length) {
    existingRows = sheet.getLastRow() >= reviewDataStartRow
      ? sheet.getRange(reviewDataStartRow, 1, sheet.getLastRow() - reviewDataStartRow + 1, sheet.getLastColumn()).getValues()
      : [];
    Object.keys(rowsByFileId).forEach(fileId => delete rowsByFileId[fileId]);
    existingRows.forEach((row, index) => {
      const fileId = fieldMap.drive_file_id ? String(row[fieldMap.drive_file_id - 1] || '').trim() : '';
      if (fileId && !rowsByFileId[fileId]) rowsByFileId[fileId] = reviewDataStartRow + index;
    });
  }

  const newRows = [];
  const uniqueRecords = uniqueAudioLibraryRecords_(records);
  let nextNewRow = Math.max(sheet.getLastRow() + 1, reviewDataStartRow + existingRows.length);
  uniqueRecords.forEach(record => {
    const rowNumber = rowsByFileId[record.drive_file_id] || nextNewRow++;
    const lead = record.matched_lead_id && leadMap.byId[record.matched_lead_id]
      ? leadMap.byId[record.matched_lead_id]
      : { customerName: '', crmPhone: '' };
    const review = {
      drive_file_id: record.drive_file_id,
      file_name: record.file_name,
      folder_path: record.folder_path,
      open_file: record.open_file,
      match_status: record.match_status,
      detected_phone: record.detected_phone,
      matched_lead_id: record.matched_lead_id,
      customer_name: lead.customerName || '',
      crm_phone: lead.crmPhone || '',
      duplicate_group: record.duplicate_group || '',
      duplicate_status: record.duplicate_status || '',
      last_checked_at: record.last_checked_at,
    };
    if (!rowsByFileId[record.drive_file_id]) {
      const values = audioLibraryRowValues_(review, fieldMap, sheet.getLastColumn());
      newRows.push(values);
      rowsByFileId[record.drive_file_id] = rowNumber;
    } else {
      Object.keys(fieldMap).forEach(key => sheet.getRange(rowNumber, fieldMap[key]).setValue(audioLibraryOutputValue_(key, review[key])));
    }
  });

  if (newRows.length) {
    const appendStartRow = Math.max(sheet.getLastRow() + 1, reviewDataStartRow + existingRows.length);
    sheet.getRange(appendStartRow, 1, newRows.length, sheet.getLastColumn()).setValues(newRows);
  }
  audioLibraryEnsurePhoneTextColumns_(sheet, AUDIO_LIBRARY_REVIEW_FIELD_ALIASES, reviewDataStartRow, ['detected_phone', 'crm_phone']);
}

function audioLibraryResult_(status, mode, values) {
  return Object.assign({
    status: status,
    mode: mode,
    index_only: true,
    activity_log_written: false,
    leads_updated: false,
    latest_audio_link_updated: false,
    scheduled_trigger_changed: false,
  }, values || {});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractPhoneCandidates: audioLibraryExtractPhoneCandidates_,
    parseFilename: audioLibraryParseFilename_,
    buildMatch: audioLibraryBuildMatch_,
    normalizeCrmPhone: audioLibraryNormalizeCrmPhone_,
    phoneText: audioLibraryPhoneText_,
    queueRowIsSafeToPrune: audioLibraryQueueRowIsSafeToPrune_,
    extension: audioLibraryExtension_,
    isSupportedExtension: function (extension) {
      return Boolean(AUDIO_LIBRARY_SUPPORTED_EXTENSIONS[String(extension || '').toLowerCase()]);
    },
    duplicateFingerprint: audioLibraryDuplicateFingerprint_,
    duplicateGroupId: audioLibraryDuplicateGroupId_,
    recordNeedsRefresh: audioLibraryRecordNeedsRefresh_,
    mergeRecord: function (existing, next, now) {
      const merged = Object.assign({}, existing || {}, next || {});
      if (existing && existing.indexed_at) merged.indexed_at = existing.indexed_at;
      if (!merged.indexed_at) merged.indexed_at = now || '';
      return merged;
    },
    nextState: function (queueStatuses, paused) {
      const pending = queueStatuses.some(status => status === 'PENDING' || status === 'IN_PROGRESS');
      const failed = queueStatuses.some(status => status === 'FAILED');
      if (pending) return paused ? 'PAUSED' : 'IN_PROGRESS';
      return failed ? 'NEEDS_REVIEW' : 'COMPLETE';
    },
  };
}
