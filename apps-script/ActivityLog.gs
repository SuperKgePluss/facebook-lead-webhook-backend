// Activity log creation helpers for user-driven lead changes.
const AUDIO_ROOT_FOLDER_ID = '1wXq0bgxy9mMmLALw2B7IOhty1X1EAew';
const AUDIO_FILE_EXTENSION_PATTERN = /\.(mp3|m4a|wav|ogg|mp4)$/i;
const LEAD_AUDIO_SYNC_CURSOR_KEY = 'LEAD_AUDIO_SYNC_NEXT_ROW';
const LEAD_AUDIO_SYNC_SCHEDULED_BATCH_SIZE = 5;
const LEAD_AUDIO_SYNC_MANUAL_BATCH_SIZE = 20;
let FOLLOW_UP_AUDIO_LAST_ERROR_REASON = '';

function createLeadStatusActivity_(leadSheet, row, oldValue, newValue) {
  const lead = getRowObject_(leadSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return;

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'LEADS_MAIN',
    action_type: 'lead_status_changed',
    old_value: String(oldValue || '').trim(),
    new_value: String(newValue || '').trim(),
    lead_status: String(newValue || '').trim(),
    note: 'Lead status changed from "' + String(oldValue || '') + '" to "' + String(newValue || '') + '"',
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });
}

function saveLeadFollowUp_(leadSheet, row) {
  FOLLOW_UP_AUDIO_LAST_ERROR_REASON = '';
  const lead = getRowObject_(leadSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  const note = String(lead.follow_up_note || '').trim();

  Logger.log('Follow-up save row=' + row + ' lead_id=' + leadId + ' note_present=' + Boolean(note));

  if (!leadId) {
    writeFollowUpSaveStatus_(leadSheet, row, 'บันทึกไม่สำเร็จ: ไม่พบรหัสลูกค้า');
    return false;
  }

  if (!note) {
    writeFollowUpSaveStatus_(leadSheet, row, 'บันทึกไม่สำเร็จ: กรุณาใส่บันทึกติดตาม');
    return false;
  }

  const audioMatch = findLatestLeadAudioFileByPhoneOrName_(lead);

  if (!audioMatch.file) {
    const message = FOLLOW_UP_AUDIO_LAST_ERROR_REASON === 'folder_access'
      ? 'บันทึกแล้ว แต่ระบบเข้าโฟลเดอร์เสียงไม่ได้'
      : 'ไม่พบไฟล์เสียงใน Google Drive ตามรูปแบบที่กำหนด';
    writeFollowUpSaveStatus_(leadSheet, row, message);
    return false;
  }

  const followUpNo = getNextFollowUpNo_(leadId);
  const createdAt = new Date();

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'LEADS_MAIN',
    action_type: 'Follow-up',
    lead_status: String(lead.lead_status || '').trim(),
    note: note,
    audio_url: audioMatch.fileUrl,
    audio_file_name: audioMatch.fileName,
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: createdAt,
  });

  setRowObjectValues_(leadSheet, row, {
    follow_up_note: '',
    follow_up_save_status: 'บันทึกการติดตามแล้ว #' + followUpNo,
    latest_follow_up_no: followUpNo,
    latest_follow_up_at: createdAt,
  });

  updateLeadStatusAfterSuccessfulFollowUp_(leadSheet, row, lead.lead_status);

  return true;
}

function updateLeadStatusAfterSuccessfulFollowUp_(leadSheet, row, currentStatus) {
  const normalizedStatus = String(currentStatus || '').trim();
  if (normalizedStatus && normalizedStatus !== 'New') return;

  setRowObjectValues_(leadSheet, row, {
    lead_status: 'Ongoing',
  });

  if (typeof ensureLeadMainStatusDropdownForRow === 'function') {
    ensureLeadMainStatusDropdownForRow(row, leadSheet);
  }
  if (typeof setupLeadMainStatusConditionalFormatting_ === 'function') {
    setupLeadMainStatusConditionalFormatting_();
  }

  createLeadStatusActivity_(leadSheet, row, normalizedStatus || 'New', 'Ongoing');
}

function writeFollowUpSaveStatus_(sheet, row, message) {
  setRowObjectValues_(sheet, row, {
    follow_up_save_status: message,
  });
}

function getNextFollowUpNo_(leadId) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('ACTIVITY_LOG');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) {
    return 1;
  }

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const actionTypeColumn = headerMap.action_type;
  const followUpNoColumn = headerMap.follow_up_no;
  if (!leadIdColumn || (!actionTypeColumn && !followUpNoColumn)) {
    return 1;
  }

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  let maxNo = 0;

  values.forEach(row => {
    if (String(row[leadIdColumn - 1] || '').trim() !== leadId) return;

    if (actionTypeColumn && String(row[actionTypeColumn - 1] || '').trim() === 'Follow-up') {
      maxNo++;
      return;
    }

    if (followUpNoColumn) {
      const followUpNo = Number(row[followUpNoColumn - 1]);
      if (Number.isFinite(followUpNo) && followUpNo > maxNo) {
        maxNo = followUpNo;
      }
    }
  });

  return maxNo + 1;
}

function findLatestLeadAudioFile_(leadId) {
  return findLatestEvidenceFileByLeadId_(AUDIO_ROOT_FOLDER_ID, leadId, {
    evidenceType: 'audio_legacy_lead_id',
    allowedExtensionPattern: AUDIO_FILE_EXTENSION_PATTERN,
  });
}

function findLatestLeadAudioFileByPhoneOrName_(leadContext) {
  const lead = leadContext || {};
  const phoneKey = normalizeAudioPhoneKey_(lead.phone);
  const nameKeys = getAudioNameKeys_(lead);

  const phoneResult = findLatestLeadAudioFileByKey_(phoneKey, 'phone');
  if (phoneResult.file) {
    FOLLOW_UP_AUDIO_LAST_ERROR_REASON = phoneResult.errorReason || '';
    return phoneResult;
  }
  if (phoneResult.errorReason === 'folder_access' || phoneResult.errorReason === 'missing_root_folder') {
    FOLLOW_UP_AUDIO_LAST_ERROR_REASON = phoneResult.errorReason || '';
    return phoneResult;
  }

  for (const nameKey of nameKeys) {
    if (isAudioNameAmbiguous_(nameKey, lead.lead_id)) {
      Logger.log('Audio name fallback skipped because customer name is ambiguous: ' + nameKey);
      continue;
    }
    const nameResult = findLatestLeadAudioFileByKey_(nameKey, 'customer_name');
    if (nameResult.file) {
      FOLLOW_UP_AUDIO_LAST_ERROR_REASON = nameResult.errorReason || '';
      return nameResult;
    }
    if (nameResult.errorReason === 'folder_access' || nameResult.errorReason === 'missing_root_folder') {
      FOLLOW_UP_AUDIO_LAST_ERROR_REASON = nameResult.errorReason || '';
      return nameResult;
    }
  }

  const legacyLeadId = String(lead.lead_id || '').trim();
  if (legacyLeadId) {
    const legacyResult = findLatestLeadAudioFile_(legacyLeadId);
    if (legacyResult.file) {
      legacyResult.matchStrategy = 'legacy_lead_id';
      FOLLOW_UP_AUDIO_LAST_ERROR_REASON = legacyResult.errorReason || '';
      return legacyResult;
    }
  }

  const result = createEmptyAudioMatchResult_();
  result.errorReason = phoneKey || nameKeys.length || legacyLeadId ? 'not_found' : 'missing_audio_match_key';
  FOLLOW_UP_AUDIO_LAST_ERROR_REASON = result.errorReason || '';
  return result;
}

function findLatestLeadAudioFileByKey_(targetKey, matchStrategy) {
  const result = createEmptyAudioMatchResult_();
  const normalizedTarget = matchStrategy === 'phone'
    ? normalizeAudioPhoneKey_(targetKey)
    : normalizeAudioNameKey_(targetKey);

  result.matchStrategy = matchStrategy;
  result.targetKey = normalizedTarget;

  if (!normalizedTarget) {
    result.errorReason = 'missing_audio_match_key';
    return result;
  }

  if (!AUDIO_ROOT_FOLDER_ID || String(AUDIO_ROOT_FOLDER_ID).indexOf('PASTE_') === 0 || String(AUDIO_ROOT_FOLDER_ID).indexOf('PUT_') === 0) {
    result.errorReason = 'missing_root_folder';
    Logger.log('Audio search skipped: audio root folder is not configured.');
    return result;
  }

  let rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(AUDIO_ROOT_FOLDER_ID);
  } catch (err) {
    result.errorReason = 'folder_access';
    Logger.log('Audio search skipped: cannot open audio folder. ' + err.message);
    return result;
  }

  const scanState = {
    foldersScanned: 0,
    filesScanned: 0,
    folderLimitExceeded: false,
    fileLimitExceeded: false,
  };
  const matches = findAudioMatchesInFolder_(rootFolder, normalizedTarget, matchStrategy, scanState, 50, 500);
  result.foldersScanned = scanState.foldersScanned;
  result.filesScanned = scanState.filesScanned;
  result.folderLimitExceeded = scanState.folderLimitExceeded;
  result.fileLimitExceeded = scanState.fileLimitExceeded;
  result.matchCount = matches.length;

  Logger.log('Audio scan complete strategy=' + matchStrategy + ' target=' + normalizedTarget + ' folders=' + result.foldersScanned + ' files=' + result.filesScanned + ' matches=' + result.matchCount);

  if (!matches.length) {
    result.errorReason = 'not_found';
    return result;
  }

  matches.sort((a, b) => {
    if (a.timestampKey !== b.timestampKey) return a.timestampKey < b.timestampKey ? 1 : -1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    const aStable = a.file.getId() + '|' + a.fileName;
    const bStable = b.file.getId() + '|' + b.fileName;
    return aStable.localeCompare(bStable);
  });

  const best = matches[0];
  result.file = best.file;
  result.fileUrl = best.file.getUrl();
  result.fileName = best.fileName;
  result.parsedTimestamp = best.parsedTimestamp;
  result.duplicateTimestampCount = matches.filter(match => match.timestampKey === best.timestampKey).length - 1;
  result.chosenReason = result.duplicateTimestampCount > 0
    ? matchStrategy + '_latest_filename_timestamp_then_updated_time_then_file_id'
    : matchStrategy + '_latest_filename_timestamp';

  Logger.log('Audio selected strategy=' + matchStrategy + ' file=' + result.fileName + ' timestamp=' + result.parsedTimestamp + ' match_count=' + result.matchCount + ' duplicate_timestamp_count=' + result.duplicateTimestampCount);
  return result;
}

function findAudioMatchesInFolder_(folder, targetKey, matchStrategy, scanState, maxFolders, maxFiles) {
  const matches = [];

  if (scanState.foldersScanned >= maxFolders) {
    scanState.folderLimitExceeded = true;
    return matches;
  }

  scanState.foldersScanned++;
  Logger.log('Audio scanning folder=' + folder.getName() + ' / ' + folder.getId());

  const files = folder.getFiles();
  while (files.hasNext()) {
    if (scanState.filesScanned >= maxFiles) {
      scanState.fileLimitExceeded = true;
      break;
    }

    const file = files.next();
    scanState.filesScanned++;
    const fileName = String(file.getName() || '');
    const parsed = parseAudioFileName_(fileName);
    Logger.log('Audio candidate file=' + fileName);

    if (!parsed) continue;
    if (!AUDIO_FILE_EXTENSION_PATTERN.test(fileName)) continue;

    const normalizedFileKey = matchStrategy === 'phone'
      ? normalizeAudioPhoneKey_(parsed.key)
      : normalizeAudioNameKey_(parsed.key);
    if (!normalizedFileKey || normalizedFileKey !== targetKey) continue;

    matches.push({
      file: file,
      fileName: fileName,
      timestampKey: parsed.timestampKey,
      parsedTimestamp: parsed.parsedTimestamp,
      updatedAt: file.getLastUpdated().getTime(),
    });
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    if (scanState.foldersScanned >= maxFolders || scanState.filesScanned >= maxFiles) {
      scanState.folderLimitExceeded = scanState.foldersScanned >= maxFolders;
      scanState.fileLimitExceeded = scanState.filesScanned >= maxFiles;
      break;
    }

    matches.push.apply(matches, findAudioMatchesInFolder_(
      subfolders.next(),
      targetKey,
      matchStrategy,
      scanState,
      maxFolders,
      maxFiles
    ));
  }

  return matches;
}

function parseAudioFileName_(fileName) {
  const match = String(fileName || '').match(/^(.+)_(\d{6}|\d{8})_(\d{2})_(\d{2})(?:\.[^.]+)?$/);
  if (!match) return null;

  const parsedDate = parseAudioDatePart_(match[2], match[3], match[4]);
  if (!parsedDate) return null;

  return {
    key: match[1],
    timestampKey: parsedDate.timestampKey,
    parsedTimestamp: parsedDate.parsedTimestamp,
  };
}

function parseAudioDatePart_(datePart, hour, minute) {
  const rawDate = String(datePart || '');
  const rawHour = String(hour || '');
  const rawMinute = String(minute || '');
  const candidates = [];

  if (/^\d{6}$/.test(rawDate)) {
    candidates.push({
      year: '20' + rawDate.slice(4, 6),
      month: rawDate.slice(2, 4),
      day: rawDate.slice(0, 2),
    });
  } else if (typeof parseEvidenceDatePart_ === 'function') {
    return parseEvidenceDatePart_(rawDate, rawHour, rawMinute);
  } else {
    return null;
  }

  for (let i = 0; i < candidates.length; i++) {
    const year = candidates[i].year;
    const month = candidates[i].month;
    const day = candidates[i].day;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(rawHour), Number(rawMinute));
    if (
      date.getFullYear() !== Number(year)
      || date.getMonth() !== Number(month) - 1
      || date.getDate() !== Number(day)
      || date.getHours() !== Number(rawHour)
      || date.getMinutes() !== Number(rawMinute)
    ) {
      continue;
    }

    return {
      timestampKey: year + month + day + rawHour + rawMinute,
      parsedTimestamp: year + '-' + month + '-' + day + ' ' + rawHour + ':' + rawMinute,
    };
  }

  return null;
}

function normalizeAudioPhoneKey_(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 9 && /^[689]/.test(digits)) return '0' + digits;
  if (digits.length === 11 && digits.indexOf('66') === 0) return '0' + digits.slice(2);
  if (digits.length === 10 && digits.indexOf('0') === 0) return digits;
  return digits;
}

function normalizeAudioNameKey_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function getAudioNameKeys_(lead) {
  const rawNames = [
    lead.customer_name,
    lead.full_name,
    lead.facebook_name,
    lead.name,
    lead.original_customer_name,
  ];
  const keys = [];

  rawNames.forEach(name => {
    const key = normalizeAudioNameKey_(name);
    if (key && keys.indexOf(key) === -1) keys.push(key);
  });

  return keys;
}

function isAudioNameAmbiguous_(nameKey, currentLeadId) {
  const targetName = normalizeAudioNameKey_(nameKey);
  const currentId = String(currentLeadId || '').trim();
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  if (!targetName || !sheet || sheet.getLastRow() < DATA_START_ROW) return false;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const nameColumn = headerMap.customer_name;
  if (!leadIdColumn || !nameColumn) return false;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  const matchingLeadIds = {};

  values.forEach(row => {
    const rowName = normalizeAudioNameKey_(row[nameColumn - 1]);
    if (rowName !== targetName) return;

    const rowLeadId = String(row[leadIdColumn - 1] || '').trim();
    if (rowLeadId) matchingLeadIds[rowLeadId] = true;
  });

  const ids = Object.keys(matchingLeadIds);
  return ids.length > 1 || (ids.length === 1 && currentId && ids[0] !== currentId);
}

function createEmptyAudioMatchResult_() {
  return {
    file: null,
    fileUrl: '',
    fileName: '',
    parsedTimestamp: '',
    matchCount: 0,
    duplicateTimestampCount: 0,
    chosenReason: '',
    foldersScanned: 0,
    filesScanned: 0,
    folderLimitExceeded: false,
    fileLimitExceeded: false,
    errorReason: '',
    matchStrategy: '',
    targetKey: '',
  };
}

function syncLeadAudioFilesNow() {
  const result = syncLeadAudioFilesCursorBatch_(LEAD_AUDIO_SYNC_MANUAL_BATCH_SIZE);
  SpreadsheetApp.getActive().toast('Audio sync checked=' + result.checked + ' appended=' + result.appended, 'Sync Audio Files', 5);
  return result;
}

function syncLeadAudioFilesScheduled() {
  return syncLeadAudioFilesCursorBatch_(LEAD_AUDIO_SYNC_SCHEDULED_BATCH_SIZE);
}

function installLeadAudioSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'syncLeadAudioFilesScheduled') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp
    .newTrigger('syncLeadAudioFilesScheduled')
    .timeBased()
    .everyMinutes(10)
    .create();
}

function resetLeadAudioSyncCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(LEAD_AUDIO_SYNC_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('Lead audio sync cursor reset to ' + DATA_START_ROW);
}

function debugAudioSyncForPhone(phone) {
  const targetPhone = normalizeAudioPhoneKey_(phone);
  const ss = SpreadsheetApp.getActive();
  const leadSheet = ss.getSheetByName('LEADS_MAIN');
  const activitySheet = ss.getSheetByName('ACTIVITY_LOG');
  const properties = PropertiesService.getScriptProperties();
  const cursorValue = properties.getProperty(LEAD_AUDIO_SYNC_CURSOR_KEY) || '';
  const result = {
    input_phone: String(phone || ''),
    normalized_phone: targetPhone,
    cursor_key: LEAD_AUDIO_SYNC_CURSOR_KEY,
    cursor_value: cursorValue,
    lead_rows: [],
    duplicate_phone: false,
    current_batch: null,
    current_batch_includes_phone: false,
    parser_example: parseAudioFileName_(targetPhone ? targetPhone + '_20260509_21_55.mp3' : ''),
    drive_match: null,
    existing_activity_matches: [],
  };

  if (!targetPhone || !leadSheet || leadSheet.getLastRow() < DATA_START_ROW) {
    Logger.log(JSON.stringify(result));
    return result;
  }

  const headerMap = getHeaderMap_(leadSheet);
  if (!headerMap.lead_id || !headerMap.phone) {
    Logger.log(JSON.stringify(result));
    return result;
  }

  const lastRow = leadSheet.getLastRow();
  const savedCursor = Number(cursorValue);
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : Math.max(DATA_START_ROW, lastRow - LEAD_AUDIO_SYNC_MANUAL_BATCH_SIZE + 1);
  const endRow = Math.min(startRow + LEAD_AUDIO_SYNC_MANUAL_BATCH_SIZE - 1, lastRow);
  result.current_batch = {
    startRow: startRow,
    endRow: endRow,
    batch_size: LEAD_AUDIO_SYNC_MANUAL_BATCH_SIZE,
  };

  const values = leadSheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, leadSheet.getLastColumn()).getValues();
  values.forEach((row, index) => {
    const normalizedRowPhone = normalizeAudioPhoneKey_(row[headerMap.phone - 1]);
    if (normalizedRowPhone !== targetPhone) return;

    const rowNumber = DATA_START_ROW + index;
    result.lead_rows.push({
      row: rowNumber,
      lead_id: String(row[headerMap.lead_id - 1] || '').trim(),
      phone: String(row[headerMap.phone - 1] || '').trim(),
      normalized_phone: normalizedRowPhone,
    });
    if (rowNumber >= startRow && rowNumber <= endRow) {
      result.current_batch_includes_phone = true;
    }
  });
  result.duplicate_phone = result.lead_rows.length > 1;

  const driveMatch = findLeadAudioFilesByKey_(targetPhone, 'phone');
  result.drive_match = {
    errorReason: driveMatch.errorReason || '',
    match_count: driveMatch.matches.length,
    folders_scanned: driveMatch.foldersScanned || 0,
    files_scanned: driveMatch.filesScanned || 0,
    files: driveMatch.matches.slice(0, 10).map(match => ({
      file_name: match.fileName,
      file_url: match.file.getUrl(),
      parsed_timestamp: match.parsedTimestamp,
    })),
  };

  if (activitySheet && activitySheet.getLastRow() >= DATA_START_ROW) {
    const activityMap = getHeaderMap_(activitySheet);
    if (activityMap.audio_file_name || activityMap.audio_url) {
      const activityValues = activitySheet.getRange(DATA_START_ROW, 1, activitySheet.getLastRow() - DATA_START_ROW + 1, activitySheet.getLastColumn()).getValues();
      activityValues.forEach((row, index) => {
        const fileName = activityMap.audio_file_name ? String(row[activityMap.audio_file_name - 1] || '') : '';
        const audioUrl = activityMap.audio_url ? String(row[activityMap.audio_url - 1] || '') : '';
        if (fileName.indexOf(targetPhone + '_') !== 0 && !audioUrl) return;
        if (fileName.indexOf(targetPhone + '_') !== 0) return;

        result.existing_activity_matches.push({
          row: DATA_START_ROW + index,
          lead_id: activityMap.lead_id ? String(row[activityMap.lead_id - 1] || '').trim() : '',
          audio_file_name: fileName,
          audio_url: audioUrl,
        });
      });
    }
  }

  Logger.log(JSON.stringify(result));
  return result;
}

function syncLeadAudioFilesForPhone_(phone) {
  const targetPhone = normalizeAudioPhoneKey_(phone);
  const result = {
    phone: String(phone || ''),
    normalized_phone: targetPhone,
    matched_lead_id: '',
    status: '',
    matched_files: 0,
    appended: 0,
    duplicates: 0,
    latest_audio_url: '',
  };

  if (!targetPhone) {
    result.status = 'invalid_phone';
    Logger.log(JSON.stringify(result));
    return result;
  }

  const phoneMap = getLeadMainPhoneMatchMap_();
  const phoneRecord = phoneMap[targetPhone];
  if (!phoneRecord) {
    result.status = 'no_match';
    Logger.log(JSON.stringify(result));
    return result;
  }
  if (phoneRecord.ambiguous) {
    result.status = 'ambiguous_phone';
    result.matched_lead_ids = phoneRecord.leadIds || [];
    Logger.log(JSON.stringify(result));
    return result;
  }

  const matchResult = findLeadAudioFilesByKey_(targetPhone, 'phone');
  if (!matchResult.matches.length) {
    result.status = matchResult.errorReason || 'no_file_found';
    Logger.log(JSON.stringify(result));
    return result;
  }

  const safeMatches = matchResult.matches.filter(match => {
    const parsed = parseAudioFileName_(match.fileName);
    const filenamePhone = parsed ? normalizeAudioPhoneKey_(parsed.key) : '';
    return filenamePhone === targetPhone;
  });
  if (!safeMatches.length) {
    result.status = 'no_exact_phone_file_match';
    Logger.log(JSON.stringify(result));
    return result;
  }

  const existingByLeadId = getExistingAudioActivityUrlsByLeadId_([phoneRecord.leadId]);
  const existingUrls = existingByLeadId[phoneRecord.leadId] || {};
  safeMatches.slice().reverse().forEach((match, index) => {
    const fileUrl = match.file.getUrl();
    if (existingUrls[fileUrl]) {
      result.duplicates++;
      return;
    }

    appendObjectRow_('ACTIVITY_LOG', {
      activity_id: 'ACT-' + Date.now() + '-target-audio-' + index,
      lead_id: phoneRecord.leadId,
      sheet_name: 'LEADS',
      action_type: 'Audio Sync',
      note: 'Audio synced from Google Drive. Filename timestamp: ' + (match.parsedTimestamp || ''),
      audio_url: fileUrl,
      audio_file_name: match.fileName,
      created_by: 'Audio Sync',
      created_at: new Date(),
    });
    existingUrls[fileUrl] = true;
    appendLeadMemoToLeadsView_(phoneRecord.leadId, match.fileName + ' - ' + fileUrl, {
      type: 'Audio',
      timestamp: parseActivityLogDate_(match.parsedTimestamp) || new Date(),
    });
    result.appended++;
  });

  result.status = 'ok';
  result.matched_lead_id = phoneRecord.leadId;
  result.matched_files = safeMatches.length;
  result.latest_audio_url = safeMatches[0].file.getUrl();
  updateLeadsLatestAudioLinkOnly_(phoneRecord.leadId, result.latest_audio_url);
  Logger.log(JSON.stringify(result));
  return result;
}

function syncLeadAudioFilesCursorBatch_(limit) {
  const batchSize = Math.max(1, Number(limit) || LEAD_AUDIO_SYNC_SCHEDULED_BATCH_SIZE);
  const ss = SpreadsheetApp.getActive();
  const leadSheet = ss.getSheetByName('LEADS_MAIN');
  if (!leadSheet || leadSheet.getLastRow() < DATA_START_ROW) {
    return {
      checked: 0,
      matched: 0,
      appended: 0,
      duplicates: 0,
      failed: 0,
      task_completed: true,
    };
  }

  const properties = PropertiesService.getScriptProperties();
  const lastRow = leadSheet.getLastRow();
  const savedCursor = Number(properties.getProperty(LEAD_AUDIO_SYNC_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : Math.max(DATA_START_ROW, lastRow - batchSize + 1);
  const endRow = Math.min(startRow + batchSize - 1, lastRow);
  const leadRows = [];

  for (let row = startRow; row <= endRow; row++) {
    const lead = getRowObject_(leadSheet, row);
    const leadId = String(lead.lead_id || '').trim();
    if (leadId) {
      leadRows.push({
        row: row,
        lead: lead,
        leadId: leadId,
      });
    }
  }

  const phoneMatchMap = getLeadMainPhoneMatchMap_();
  const existingAudioByLeadId = getExistingAudioActivityUrlsByLeadId_(leadRows.map(item => item.leadId));
  let checked = 0;
  let matched = 0;
  let appended = 0;
  let duplicates = 0;
  let skippedNoMatch = 0;
  let skippedAmbiguous = 0;
  let failed = 0;

  leadRows.forEach(item => {
    checked++;
    try {
      const leadPhone = normalizeAudioPhoneKey_(item.lead.phone);
      const matchResult = findLeadAudioFilesByKey_(leadPhone, 'phone');
      if (!matchResult.matches.length) {
        skippedNoMatch++;
        return;
      }

      const safeMatches = [];
      matchResult.matches.forEach(match => {
        const parsed = parseAudioFileName_(match.fileName);
        const filenamePhone = parsed ? normalizeAudioPhoneKey_(parsed.key) : '';
        const phoneRecord = filenamePhone ? phoneMatchMap[filenamePhone] : null;

        if (!phoneRecord) {
          skippedNoMatch++;
          Logger.log('Audio sync skipped no_match filename=' + match.fileName + ' parsed_phone=' + filenamePhone);
          return;
        }

        if (phoneRecord.ambiguous) {
          skippedAmbiguous++;
          Logger.log('Audio sync skipped ambiguous_phone filename=' + match.fileName + ' parsed_phone=' + filenamePhone);
          return;
        }

        if (phoneRecord.leadId !== item.leadId || filenamePhone !== leadPhone) {
          skippedNoMatch++;
          Logger.log('Audio sync skipped cursor_mismatch filename=' + match.fileName + ' parsed_phone=' + filenamePhone + ' matched_lead_id=' + phoneRecord.leadId + ' cursor_lead_id=' + item.leadId);
          return;
        }

        Logger.log('Audio sync matched filename=' + match.fileName + ' parsed_phone=' + filenamePhone + ' matched_lead_id=' + phoneRecord.leadId + ' matched_lead_phone=' + phoneRecord.phone + ' strategy=phone');
        safeMatches.push(match);
      });

      if (!safeMatches.length) return;

      matched++;
      const existingUrls = existingAudioByLeadId[item.leadId] || {};
      const matchesOldestFirst = safeMatches.slice().reverse();
      matchesOldestFirst.forEach((match, index) => {
        const fileUrl = match.file.getUrl();
        if (existingUrls[fileUrl]) {
          duplicates++;
          return;
        }

        appendObjectRow_('ACTIVITY_LOG', {
          activity_id: 'ACT-' + Date.now() + '-' + item.row + '-' + index,
          lead_id: item.leadId,
          sheet_name: 'LEADS',
          action_type: 'Audio Sync',
          note: 'Audio synced from Google Drive. Filename timestamp: ' + (match.parsedTimestamp || ''),
          audio_url: fileUrl,
          audio_file_name: match.fileName,
          created_by: 'Audio Sync',
          created_at: new Date(),
        });
        existingUrls[fileUrl] = true;
        appendLeadMemoToLeadsView_(item.leadId, match.fileName + ' - ' + fileUrl, {
          type: 'Audio',
          timestamp: parseActivityLogDate_(match.parsedTimestamp) || new Date(),
        });
        appended++;
      });

      existingAudioByLeadId[item.leadId] = existingUrls;
      updateLeadsLatestAudioLinkOnly_(item.leadId, matchResult.matches[0].file.getUrl());
    } catch (err) {
      failed++;
      Logger.log('syncLeadAudioFiles skipped LEADS_MAIN row ' + item.row + ': ' + err.message);
    }
  });

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(LEAD_AUDIO_SYNC_CURSOR_KEY, String(nextCursor));

  const result = {
    batch_size: batchSize,
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    matched: matched,
    appended: appended,
    duplicates: duplicates,
    skipped_no_match: skippedNoMatch,
    skipped_ambiguous_phone: skippedAmbiguous,
    failed: failed,
    task_completed: nextCursor === DATA_START_ROW,
  };
  Logger.log('syncLeadAudioFilesCursorBatch ' + JSON.stringify(result));
  return result;
}

function findLeadAudioFilesByPhoneOrName_(leadContext) {
  const lead = leadContext || {};
  const phoneKey = normalizeAudioPhoneKey_(lead.phone);
  const phoneResult = findLeadAudioFilesByKey_(phoneKey, 'phone');
  if (phoneResult.matches.length || phoneResult.errorReason === 'folder_access' || phoneResult.errorReason === 'missing_root_folder') {
    return phoneResult;
  }

  const nameKeys = getAudioNameKeys_(lead);
  for (const nameKey of nameKeys) {
    if (isAudioNameAmbiguous_(nameKey, lead.lead_id)) {
      Logger.log('Audio sync name fallback skipped because customer name is ambiguous: ' + nameKey);
      continue;
    }

    const nameResult = findLeadAudioFilesByKey_(nameKey, 'customer_name');
    if (nameResult.matches.length || nameResult.errorReason === 'folder_access' || nameResult.errorReason === 'missing_root_folder') {
      return nameResult;
    }
  }

  return {
    matches: [],
    errorReason: phoneKey || nameKeys.length ? 'not_found' : 'missing_audio_match_key',
    matchStrategy: '',
  };
}

function findLeadAudioFilesByKey_(targetKey, matchStrategy) {
  const normalizedTarget = matchStrategy === 'phone'
    ? normalizeAudioPhoneKey_(targetKey)
    : normalizeAudioNameKey_(targetKey);
  const result = {
    matches: [],
    errorReason: '',
    matchStrategy: matchStrategy,
    targetKey: normalizedTarget,
    foldersScanned: 0,
    filesScanned: 0,
  };

  if (!normalizedTarget) {
    result.errorReason = 'missing_audio_match_key';
    return result;
  }

  if (!AUDIO_ROOT_FOLDER_ID || String(AUDIO_ROOT_FOLDER_ID).indexOf('PASTE_') === 0 || String(AUDIO_ROOT_FOLDER_ID).indexOf('PUT_') === 0) {
    result.errorReason = 'missing_root_folder';
    return result;
  }

  let rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(AUDIO_ROOT_FOLDER_ID);
  } catch (err) {
    result.errorReason = 'folder_access';
    Logger.log('Audio sync skipped: cannot open audio folder. ' + err.message);
    return result;
  }

  const scanState = {
    foldersScanned: 0,
    filesScanned: 0,
    folderLimitExceeded: false,
    fileLimitExceeded: false,
  };
  result.matches = findAudioMatchesInFolder_(rootFolder, normalizedTarget, matchStrategy, scanState, 50, 500);
  result.foldersScanned = scanState.foldersScanned;
  result.filesScanned = scanState.filesScanned;
  result.folderLimitExceeded = scanState.folderLimitExceeded;
  result.fileLimitExceeded = scanState.fileLimitExceeded;

  result.matches.sort((a, b) => {
    if (a.timestampKey !== b.timestampKey) return a.timestampKey < b.timestampKey ? 1 : -1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    const aStable = a.file.getId() + '|' + a.fileName;
    const bStable = b.file.getId() + '|' + b.fileName;
    return aStable.localeCompare(bStable);
  });

  result.errorReason = result.matches.length ? '' : 'not_found';
  return result;
}

function getExistingAudioActivityUrlsByLeadId_(leadIds) {
  const idSet = leadIds.reduce((map, leadId) => {
    const key = String(leadId || '').trim();
    if (key) map[key] = true;
    return map;
  }, {});
  const data = {};
  const sheet = SpreadsheetApp.getActive().getSheetByName('ACTIVITY_LOG');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW || !Object.keys(idSet).length) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.audio_url) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach(row => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const audioUrl = String(row[headerMap.audio_url - 1] || '').trim();
    if (!idSet[leadId] || !audioUrl) return;

    data[leadId] = data[leadId] || {};
    data[leadId][audioUrl] = true;
  });

  return data;
}

function getLeadMainPhoneMatchMap_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS_MAIN');
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.phone) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const normalizedPhone = normalizeAudioPhoneKey_(row[headerMap.phone - 1]);
    if (!leadId || !normalizedPhone) return;

    if (!data[normalizedPhone]) {
      data[normalizedPhone] = {
        leadId: leadId,
        phone: String(row[headerMap.phone - 1] || '').trim(),
        row: DATA_START_ROW + index,
        ambiguous: false,
        leadIds: [leadId],
      };
      return;
    }

    if (data[normalizedPhone].leadIds.indexOf(leadId) === -1) {
      data[normalizedPhone].ambiguous = true;
      data[normalizedPhone].leadIds.push(leadId);
    }
  });

  return data;
}

function updateLeadsLatestAudioLinkOnly_(leadId, audioUrl) {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEADS');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return false;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.latest_audio_link) return false;

  const rows = sheet.getRange(DATA_START_ROW, headerMap.lead_id, sheet.getLastRow() - DATA_START_ROW + 1, 1).getValues();
  for (let index = 0; index < rows.length; index++) {
    if (String(rows[index][0] || '').trim() !== String(leadId || '').trim()) continue;

    sheet.getRange(DATA_START_ROW + index, headerMap.latest_audio_link).setValue(audioUrl || '');
    return true;
  }

  return false;
}

function repairLeadsLatestAudioLinksFromActivityLog() {
  const ss = SpreadsheetApp.getActive();
  const leadsSheet = ss.getSheetByName('LEADS');
  if (!leadsSheet || leadsSheet.getLastRow() < DATA_START_ROW) {
    return {
      checked: 0,
      updated: 0,
      cleared: 0,
    };
  }

  const headerMap = getHeaderMap_(leadsSheet);
  if (!headerMap.lead_id || !headerMap.latest_audio_link) {
    return {
      checked: 0,
      updated: 0,
      cleared: 0,
      error: 'missing_leads_headers',
    };
  }

  const rowCount = leadsSheet.getLastRow() - DATA_START_ROW + 1;
  const linkRange = leadsSheet.getRange(DATA_START_ROW, headerMap.latest_audio_link, rowCount, 1);
  linkRange.clearContent();

  const latestAudioByLeadId = getLatestAudioActivityByLeadId_();
  const leadIds = leadsSheet.getRange(DATA_START_ROW, headerMap.lead_id, rowCount, 1).getValues();
  let updated = 0;

  leadIds.forEach((row, index) => {
    const leadId = String(row[0] || '').trim();
    const latest = latestAudioByLeadId[leadId];
    if (!leadId || !latest || !latest.audioUrl) return;

    leadsSheet.getRange(DATA_START_ROW + index, headerMap.latest_audio_link).setValue(latest.audioUrl);
    updated++;
  });

  const result = {
    checked: rowCount,
    updated: updated,
    cleared: rowCount,
  };
  Logger.log('repairLeadsLatestAudioLinksFromActivityLog ' + JSON.stringify(result));
  return result;
}

function cleanupAudioSyncTestFile() {
  return cleanupAudioSyncByFileName('0987899159_20260509_21_55.mp3');
}

function cleanupAudioSyncByFileName(fileName) {
  const targetFileName = String(fileName || '').trim();
  const sheet = SpreadsheetApp.getActive().getSheetByName('ACTIVITY_LOG');
  const result = {
    file_name: targetFileName,
    deleted_rows: 0,
    matched_rows: [],
  };
  if (!targetFileName || !sheet || sheet.getLastRow() < DATA_START_ROW) {
    Logger.log('cleanupAudioSyncByFileName ' + JSON.stringify(result));
    return result;
  }

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.audio_file_name) {
    result.error = 'missing_audio_file_name_header';
    Logger.log('cleanupAudioSyncByFileName ' + JSON.stringify(result));
    return result;
  }

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const rowsToDelete = [];
  const urlsFromMatchedFile = {};

  values.forEach((row, index) => {
    const currentFileName = String(row[headerMap.audio_file_name - 1] || '').trim();
    if (currentFileName !== targetFileName) return;

    const rowNumber = DATA_START_ROW + index;
    rowsToDelete.push(rowNumber);
    if (headerMap.audio_url) {
      const audioUrl = String(row[headerMap.audio_url - 1] || '').trim();
      if (audioUrl) urlsFromMatchedFile[audioUrl] = true;
    }
    result.matched_rows.push({
      row: rowNumber,
      lead_id: headerMap.lead_id ? String(row[headerMap.lead_id - 1] || '').trim() : '',
      audio_url: headerMap.audio_url ? String(row[headerMap.audio_url - 1] || '').trim() : '',
    });
  });

  if (headerMap.audio_url && Object.keys(urlsFromMatchedFile).length) {
    values.forEach((row, index) => {
      const rowNumber = DATA_START_ROW + index;
      if (rowsToDelete.indexOf(rowNumber) !== -1) return;

      const audioUrl = String(row[headerMap.audio_url - 1] || '').trim();
      if (!urlsFromMatchedFile[audioUrl]) return;

      rowsToDelete.push(rowNumber);
      result.matched_rows.push({
        row: rowNumber,
        lead_id: headerMap.lead_id ? String(row[headerMap.lead_id - 1] || '').trim() : '',
        audio_url: audioUrl,
      });
    });
  }

  rowsToDelete
    .sort((a, b) => b - a)
    .forEach(row => {
      sheet.deleteRow(row);
      result.deleted_rows++;
    });

  repairLeadsLatestAudioLinksFromActivityLog();
  Logger.log('cleanupAudioSyncByFileName ' + JSON.stringify(result));
  return result;
}

function getLatestAudioActivityByLeadId_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('ACTIVITY_LOG');
  const data = {};
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) return data;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.lead_id || !headerMap.audio_url) return data;

  const values = sheet.getRange(DATA_START_ROW, 1, sheet.getLastRow() - DATA_START_ROW + 1, sheet.getLastColumn()).getValues();
  values.forEach((row, index) => {
    const leadId = String(row[headerMap.lead_id - 1] || '').trim();
    const audioUrl = String(row[headerMap.audio_url - 1] || '').trim();
    if (!leadId || !audioUrl) return;

    const audioFileName = headerMap.audio_file_name ? String(row[headerMap.audio_file_name - 1] || '').trim() : '';
    const parsedFileName = audioFileName ? parseAudioFileName_(audioFileName) : null;
    const createdAt = headerMap.created_at ? parseActivityLogDate_(row[headerMap.created_at - 1]) : null;
    const sortKey = parsedFileName
      ? '3|' + parsedFileName.timestampKey
      : createdAt
        ? '2|' + String(createdAt.getTime()).padStart(15, '0')
        : '1|' + String(DATA_START_ROW + index).padStart(15, '0');

    if (!data[leadId] || data[leadId].sortKey <= sortKey) {
      data[leadId] = {
        audioUrl: audioUrl,
        audioFileName: audioFileName,
        sortKey: sortKey,
      };
    }
  });

  return data;
}

function parseActivityLogDate_(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof parseCrmDateTimeValue_ === 'function') {
    const parsed = parseCrmDateTimeValue_(value);
    if (parsed && parsed instanceof Date && !isNaN(parsed.getTime())) return parsed;
  }

  const fallback = new Date(value);
  return fallback instanceof Date && !isNaN(fallback.getTime()) ? fallback : null;
}

function debugFollowUpForActiveRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (!sheet || sheet.getName() !== 'LEADS_MAIN') {
    Logger.log('Select a LEADS_MAIN row before running debugFollowUpForActiveRow.');
    return;
  }

  const row = sheet.getActiveRange().getRow();
  if (row < DATA_START_ROW) {
    Logger.log('Select a data row before running debugFollowUpForActiveRow.');
    return;
  }

  const lead = getRowObject_(sheet, row);
  Logger.log('Debug follow-up row: ' + row);
  Logger.log('Lead ID: ' + lead.lead_id);
  Logger.log('Phone: ' + lead.phone);
  Logger.log('Customer name: ' + lead.customer_name);
  Logger.log('Follow-up Note exists: ' + Boolean(String(lead.follow_up_note || '').trim()));
  Logger.log('Audio root folder id: ' + AUDIO_ROOT_FOLDER_ID);

  const match = findLatestLeadAudioFileByPhoneOrName_(lead);
  Logger.log(match.file ? 'Matched audio file: ' + match.fileName + ' / ' + match.file.getId() + ' strategy=' + match.matchStrategy + ' parsed=' + match.parsedTimestamp + ' matches=' + match.matchCount : 'No matching audio file found. Expected format: PHONE_DDMMYY_HH_MM.ext or CUSTOMER_NAME_DDMMYY_HH_MM.ext');
}

function syncLeadStatusFromActivityLogDryRun() {
  return syncLeadStatusFromActivityLog_(true);
}

function syncLeadStatusFromActivityLogApply() {
  return syncLeadStatusFromActivityLog_(false);
}

function syncLeadStatusFromActivityLog_(dryRun) {
  const ss = SpreadsheetApp.getActive();
  const activitySheet = ss.getSheetByName('ACTIVITY_LOG');
  const leadSheet = ss.getSheetByName('LEADS_MAIN');
  if (!activitySheet || !leadSheet || activitySheet.getLastRow() < DATA_START_ROW || leadSheet.getLastRow() < DATA_START_ROW) {
    return { dry_run: dryRun, checked: 0, updates: 0, samples: [] };
  }

  const activityMap = getHeaderMap_(activitySheet);
  const leadMap = getHeaderMap_(leadSheet);
  if (!activityMap.lead_id || !activityMap.lead_status || !leadMap.lead_id || !leadMap.lead_status) {
    return { dry_run: dryRun, checked: 0, updates: 0, samples: [], error: 'missing_required_headers' };
  }

  const activityValues = activitySheet
    .getRange(DATA_START_ROW, 1, activitySheet.getLastRow() - DATA_START_ROW + 1, activitySheet.getLastColumn())
    .getValues();
  const latestByLeadId = {};

  activityValues.forEach((row, index) => {
    const leadId = String(row[activityMap.lead_id - 1] || '').trim();
    const leadStatus = String(row[activityMap.lead_status - 1] || '').trim();
    if (!leadId || !leadStatus || leadStatus === 'New') return;

    const createdAtColumn = activityMap.created_at;
    const createdAtValue = createdAtColumn ? row[createdAtColumn - 1] : '';
    const createdAt = createdAtValue instanceof Date && !isNaN(createdAtValue.getTime())
      ? createdAtValue.getTime()
      : 0;
    const sortKey = createdAt || (DATA_START_ROW + index);
    if (!latestByLeadId[leadId] || latestByLeadId[leadId].sortKey <= sortKey) {
      latestByLeadId[leadId] = {
        leadStatus: normalizeLeadStatusForSync_(leadStatus),
        sortKey: sortKey,
      };
    }
  });

  const leadValues = leadSheet
    .getRange(DATA_START_ROW, 1, leadSheet.getLastRow() - DATA_START_ROW + 1, leadSheet.getLastColumn())
    .getValues();
  const samples = [];
  let updates = 0;

  leadValues.forEach((row, index) => {
    const leadId = String(row[leadMap.lead_id - 1] || '').trim();
    if (!leadId || !latestByLeadId[leadId]) return;

    const currentStatus = normalizeLeadStatusForSync_(row[leadMap.lead_status - 1]);
    const nextStatus = latestByLeadId[leadId].leadStatus;
    if (!nextStatus || nextStatus === 'New' || currentStatus === nextStatus) return;
    if (!shouldApplyLeadStatusFromActivity_(currentStatus, nextStatus)) return;

    updates++;
    if (samples.length < 10) {
      samples.push({
        lead_id: leadId,
        old_status: currentStatus,
        new_status: nextStatus,
        row: DATA_START_ROW + index,
      });
    }
    if (!dryRun) {
      leadSheet.getRange(DATA_START_ROW + index, leadMap.lead_status).setValue(nextStatus);
      if (typeof ensureLeadMainStatusDropdownForRow === 'function') {
        ensureLeadMainStatusDropdownForRow(DATA_START_ROW + index, leadSheet);
      }
    }
  });

  if (!dryRun && typeof setupLeadMainStatusConditionalFormatting_ === 'function') {
    setupLeadMainStatusConditionalFormatting_();
  }

  const result = {
    dry_run: dryRun,
    checked: leadValues.length,
    updates: updates,
    samples: samples,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function normalizeLeadStatusForSync_(status) {
  const value = String(status || '').trim();
  const lower = value.toLowerCase();
  if (!value) return 'New';
  if (lower === 'done' || lower === 'closed' || lower === 'closed won') return 'Done';
  if (lower === 'cancelled' || lower === 'canceled' || lower === 'not interested') return 'Cancelled';
  if (lower === 'installed') return 'Installed';
  if (lower === 'ongoing' || lower === 'contacted' || lower === 'interested' || lower === 'follow-up' || lower === 'pending') return 'Ongoing';
  if (lower === 'new') return 'New';
  return value;
}

function shouldApplyLeadStatusFromActivity_(currentStatus, nextStatus) {
  const rank = {
    New: 1,
    Ongoing: 2,
    Installed: 3,
    Done: 4,
    Cancelled: 5,
  };
  return (rank[nextStatus] || 0) >= (rank[currentStatus] || 0);
}
