// Activity log creation helpers for user-driven lead changes.
const AUDIO_ROOT_FOLDER_ID = '1wXq0bgxy9mMmLALw2B7IOhty1X1EAew';
const AUDIO_FILE_EXTENSION_PATTERN = /\.(mp3|m4a|wav|ogg|mp4)$/i;
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
