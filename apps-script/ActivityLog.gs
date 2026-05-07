// Activity log creation helpers for user-driven lead changes.
const AUDIO_ROOT_FOLDER_ID = '1wXq0bgxy9mMmLALw2B7IOhty1X1EAew';
const AUDIO_FILE_EXTENSION_PATTERN = /\.(mp3|m4a|wav|ogg|mp4)$/i;

function createLeadStatusActivity_(leadSheet, row, oldValue, newValue) {
  const lead = getRowObject_(leadSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  if (!leadId) return;

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    action_type: 'lead_status_changed',
    result: String(newValue || '').trim(),
    note: 'Lead status changed from "' + String(oldValue || '') + '" to "' + String(newValue || '') + '"',
    created_by: Session.getActiveUser().getEmail() || 'Sheet user',
    created_at: new Date(),
  });
}

function saveLeadFollowUp_(leadSheet, row) {
  const lead = getRowObject_(leadSheet, row);
  const leadId = String(lead.lead_id || '').trim();
  const phone = normalizePhone(lead.phone);
  const salesOwner = String(lead.sales_owner || '').trim();
  const note = String(lead.follow_up_note || '').trim();

  if (!leadId) {
    writeFollowUpSaveStatus_(leadSheet, row, 'Lead ID is missing.');
    return false;
  }

  if (!phone) {
    writeFollowUpSaveStatus_(leadSheet, row, 'Phone is missing.');
    return false;
  }

  if (!note) {
    writeFollowUpSaveStatus_(leadSheet, row, 'Follow-up Note is missing.');
    return false;
  }

  const audioFile = findLatestLeadAudioFile_(phone);

  if (!audioFile) {
    writeFollowUpSaveStatus_(leadSheet, row, 'Audio file not found. Check filename format.');
    return false;
  }

  const followUpNo = getNextFollowUpNo_(leadId);
  const createdAt = new Date();

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    follow_up_no: followUpNo,
    action_type: 'Follow-up',
    result: '',
    note: note,
    audio_url: audioFile.getUrl(),
    audio_file_name: audioFile.getName(),
    created_by: salesOwner,
    created_at: createdAt,
  });

  setRowObjectValues_(leadSheet, row, {
    follow_up_note: '',
    follow_up_save_status: 'Saved follow-up #' + followUpNo,
    latest_follow_up_no: followUpNo,
    latest_follow_up_at: createdAt,
  });

  return true;
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
  const followUpNoColumn = headerMap.follow_up_no;
  if (!leadIdColumn || !followUpNoColumn) {
    return 1;
  }

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  let maxNo = 0;

  values.forEach(row => {
    if (String(row[leadIdColumn - 1] || '').trim() !== leadId) return;

    const followUpNo = Number(row[followUpNoColumn - 1]);
    if (Number.isFinite(followUpNo) && followUpNo > maxNo) {
      maxNo = followUpNo;
    }
  });

  return maxNo + 1;
}

function findLatestLeadAudioFile_(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const prefix = 'LEAD_' + normalizedPhone + '_';
  const rootFolder = DriveApp.getFolderById(AUDIO_ROOT_FOLDER_ID);

  return findLatestLeadAudioFileInFolder_(rootFolder, prefix, null);
}

function findLatestLeadAudioFileInFolder_(folder, prefix, latestFile) {
  let currentLatestFile = latestFile;
  const files = folder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();

    if (
      fileName.indexOf(prefix) === 0 &&
      AUDIO_FILE_EXTENSION_PATTERN.test(fileName) &&
      (!currentLatestFile || file.getLastUpdated() > currentLatestFile.getLastUpdated())
    ) {
      currentLatestFile = file;
    }
  }

  const folders = folder.getFolders();

  while (folders.hasNext()) {
    currentLatestFile = findLatestLeadAudioFileInFolder_(folders.next(), prefix, currentLatestFile);
  }

  return currentLatestFile;
}
