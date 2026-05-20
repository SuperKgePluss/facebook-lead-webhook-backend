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

  const audioMatch = findLatestLeadAudioFile_(leadId);

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
  const result = findLatestEvidenceFileByLeadId_(AUDIO_ROOT_FOLDER_ID, leadId, {
    evidenceType: 'audio',
    allowedExtensionPattern: AUDIO_FILE_EXTENSION_PATTERN,
  });
  FOLLOW_UP_AUDIO_LAST_ERROR_REASON = result.errorReason || '';
  return result;
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
  Logger.log('Follow-up Note exists: ' + Boolean(String(lead.follow_up_note || '').trim()));
  Logger.log('Audio root folder id: ' + AUDIO_ROOT_FOLDER_ID);

  const match = findLatestLeadAudioFile_(lead.lead_id);
  Logger.log(match.file ? 'Matched audio file: ' + match.fileName + ' / ' + match.file.getId() + ' parsed=' + match.parsedTimestamp + ' matches=' + match.matchCount : 'No matching audio file found. Expected format: ' + lead.lead_id + '_YYYYMMDD_HH_MM.ext, ' + lead.lead_id + '_DDMMYYYY_HH_MM.ext, or ' + lead.lead_id + '_MMDDYYYY_HH_MM.ext');
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
