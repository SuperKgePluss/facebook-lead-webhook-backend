// Payment slip automation for DEALS.
// Setup:
// 1. Paste this file into Apps Script alongside Code.gs.
// 2. Replace PAYMENT_SLIP_FOLDER_ID with the Google Drive folder that stores payment slip files.
// 3. Create an installable "On edit" trigger for onEdit so DriveApp authorization is available.
// 4. Test by changing DEALS.Payment Status to "paid" on a row whose Payment Slip URL is blank.
const PAYMENT_SLIP_FOLDER_ID = '13ntH9hor9cYnTEL_exsIJZ2T7Y9wyRma';
const PAYMENT_SLIP_MAX_FOLDERS_SCANNED = 50;
const PAYMENT_SLIP_MAX_FILES_SCANNED = 500;

function handleDealPaymentStatusEdit_(e) {
  try {
    if (!e || !e.range) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

    const sheet = e.range.getSheet();
    Logger.log('Payment slip edit sheet=' + sheet.getName() + ' row=' + e.range.getRow() + ' column=' + e.range.getColumn());
    if (sheet.getName() !== 'DEALS') return;
    if (e.range.getRow() < DATA_START_ROW) return;

    const headerMap = getHeaderMap_(sheet);
    const editedHeader = getEditedHeader_(sheet, e.range.getColumn());
    const paymentStatusColumn = headerMap.payment_status;
    const paymentSlipUrlColumn = headerMap.payment_slip_url;
    const leadIdColumn = headerMap.lead_id;
    const paymentDateColumn = headerMap.payment_date;

    Logger.log('Payment slip edited header=' + editedHeader);
    Logger.log('Payment slip detected columns payment_status=' + paymentStatusColumn + ' payment_slip_url=' + paymentSlipUrlColumn + ' lead_id=' + leadIdColumn + ' payment_date=' + paymentDateColumn);

    if (!paymentStatusColumn || !paymentSlipUrlColumn || !leadIdColumn) {
      Logger.log('Payment slip automation skipped: DEALS required headers missing.');
      return;
    }

    if (e.range.getColumn() !== paymentStatusColumn) {
      Logger.log('Payment slip automation skipped: edited column is not Payment Status.');
      return;
    }

    const currentPaymentStatus = String(e.range.getValue() || e.value || '').trim();
    Logger.log('Payment slip detected payment status=' + currentPaymentStatus);
    if (currentPaymentStatus.toLowerCase() !== 'paid') {
      Logger.log('Payment slip automation skipped: Payment Status is not paid.');
      return;
    }

    const row = e.range.getRow();
    const existingSlipUrl = String(sheet.getRange(row, paymentSlipUrlColumn).getValue() || '').trim();
    if (existingSlipUrl) {
      Logger.log('Payment slip automation skipped: Payment Slip URL already exists on row ' + row);
      return;
    }

    const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
    const paymentDate = paymentDateColumn ? sheet.getRange(row, paymentDateColumn).getValue() : '';
    Logger.log('Payment slip detected leadId=' + leadId);
    Logger.log('Payment slip detected payment date=' + paymentDate);
    Logger.log('Payment slip folder id=' + PAYMENT_SLIP_FOLDER_ID);
    if (!leadId) {
      Logger.log('Payment slip automation skipped: Lead ID missing on row ' + row);
      return;
    }

    const file = findPaymentSlipFile(leadId, paymentDate);
    if (!file) {
      Logger.log('Payment slip automation: no matching payment slip found for Lead ID ' + leadId);
      return;
    }

    sheet.getRange(row, paymentSlipUrlColumn).setValue(buildDriveFileUrl(file.getId()));
    Logger.log('Payment slip automation: wrote slip URL for Lead ID ' + leadId + ' from file ' + file.getName());
  } catch (err) {
    Logger.log('Payment slip automation failed safely: ' + err.message);
  }
}

function findPaymentSlipFile(leadId, paymentDate) {
  const targetLeadId = String(leadId || '').trim();
  const targetDate = formatDateForFileName(paymentDate);
  const targetDateCompact = targetDate ? targetDate.replace(/-/g, '') : '';
  const supportedMimeTypes = {
    'image/jpeg': true,
    'image/png': true,
    'application/pdf': true,
  };

  if (!targetLeadId || PAYMENT_SLIP_FOLDER_ID === 'PUT_PAYMENT_SLIP_FOLDER_ID_HERE') {
    Logger.log('Payment slip automation skipped: Lead ID or PAYMENT_SLIP_FOLDER_ID is not configured.');
    return null;
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(PAYMENT_SLIP_FOLDER_ID);
  } catch (err) {
    Logger.log('Payment slip automation skipped: cannot open configured folder. ' + err.message);
    return null;
  }

  const scanState = {
    foldersScanned: 0,
    filesScanned: 0,
    folderLimitExceeded: false,
    fileLimitExceeded: false,
  };
  const leadMatches = findPaymentSlipMatchesInFolder_(
    folder,
    targetLeadId,
    targetDate,
    targetDateCompact,
    supportedMimeTypes,
    scanState
  );

  Logger.log('Payment slip scan complete folders=' + scanState.foldersScanned + ' files=' + scanState.filesScanned);
  if (scanState.folderLimitExceeded) Logger.log('Payment slip scan stopped: folder scan limit exceeded (' + PAYMENT_SLIP_MAX_FOLDERS_SCANNED + ').');
  if (scanState.fileLimitExceeded) Logger.log('Payment slip scan stopped: file scan limit exceeded (' + PAYMENT_SLIP_MAX_FILES_SCANNED + ').');

  if (!leadMatches.length) {
    Logger.log('Payment slip no candidates found. Expected filename containing Lead ID ' + targetLeadId + ', e.g. ' + targetLeadId + '_slip.png or ' + targetLeadId + '_yyyy-MM-dd_HHmm.png');
    return null;
  }

  const best = leadMatches.reduce((latestMatch, match) => {
    if (!latestMatch) return match;
    if (match.score !== latestMatch.score) return match.score > latestMatch.score ? match : latestMatch;
    return match.updatedAt > latestMatch.updatedAt ? match : latestMatch;
  }, null);

  Logger.log('Payment slip selected file: ' + best.file.getName() + ' reason=' + best.reason);
  return best.file;
}

function findPaymentSlipMatchesInFolder_(folder, leadId, targetDate, targetDateCompact, supportedMimeTypes, scanState) {
  const matches = [];

  if (scanState.foldersScanned >= PAYMENT_SLIP_MAX_FOLDERS_SCANNED) {
    scanState.folderLimitExceeded = true;
    return matches;
  }

  scanState.foldersScanned++;
  Logger.log('Payment slip scanning folder: ' + folder.getName() + ' / ' + folder.getId());

  const files = folder.getFiles();
  while (files.hasNext()) {
    if (scanState.filesScanned >= PAYMENT_SLIP_MAX_FILES_SCANNED) {
      scanState.fileLimitExceeded = true;
      return matches;
    }

    const file = files.next();
    scanState.filesScanned++;
    const mimeType = file.getMimeType();
    if (!supportedMimeTypes[mimeType]) {
      Logger.log('Payment slip skipping unsupported file: ' + file.getName() + ' mime=' + mimeType);
      continue;
    }

    const fileName = String(file.getName() || '');
    const matchInfo = getPaymentSlipMatchInfo_(fileName, leadId, targetDate, targetDateCompact);
    if (!matchInfo.matched) {
      Logger.log('Payment slip skipping non-matching file: ' + fileName);
      continue;
    }

    Logger.log('Payment slip candidate file: ' + fileName + ' / ' + file.getId() + ' reason=' + matchInfo.reason + ' score=' + matchInfo.score);
    matches.push({
      file: file,
      score: matchInfo.score,
      reason: matchInfo.reason,
      updatedAt: file.getLastUpdated().getTime(),
    });
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    if (scanState.foldersScanned >= PAYMENT_SLIP_MAX_FOLDERS_SCANNED || scanState.filesScanned >= PAYMENT_SLIP_MAX_FILES_SCANNED) {
      scanState.folderLimitExceeded = scanState.foldersScanned >= PAYMENT_SLIP_MAX_FOLDERS_SCANNED;
      scanState.fileLimitExceeded = scanState.filesScanned >= PAYMENT_SLIP_MAX_FILES_SCANNED;
      break;
    }

    const subfolder = subfolders.next();
    Logger.log('Payment slip found subfolder: ' + subfolder.getName() + ' / ' + subfolder.getId());
    matches.push.apply(matches, findPaymentSlipMatchesInFolder_(
      subfolder,
      leadId,
      targetDate,
      targetDateCompact,
      supportedMimeTypes,
      scanState
    ));
  }

  return matches;
}

function getPaymentSlipMatchInfo_(fileName, leadId, targetDate, targetDateCompact) {
  const lowerFileName = String(fileName || '').toLowerCase();
  const lowerLeadId = String(leadId || '').toLowerCase();
  const lowerTargetDate = String(targetDate || '').toLowerCase();

  if (!lowerFileName || !lowerLeadId || lowerFileName.indexOf(lowerLeadId) === -1) {
    return { matched: false, score: 0, reason: 'lead_id_not_found' };
  }

  if (lowerTargetDate) {
    const dateTimePattern = new RegExp(lowerLeadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*' + lowerTargetDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\d{4}');
    if (dateTimePattern.test(lowerFileName)) {
      return { matched: true, score: 40, reason: 'lead_id_date_hhmm' };
    }

    if (lowerFileName.indexOf(lowerTargetDate) !== -1 || (targetDateCompact && lowerFileName.indexOf(targetDateCompact) !== -1)) {
      return { matched: true, score: 30, reason: 'lead_id_date' };
    }
  }

  if (lowerFileName.indexOf(lowerLeadId + '_slip') !== -1 || lowerFileName.indexOf(lowerLeadId + '-slip') !== -1) {
    return { matched: true, score: 20, reason: 'lead_id_slip' };
  }

  return { matched: true, score: 10, reason: 'lead_id_fallback' };
}

function buildDriveFileUrl(fileId) {
  const id = String(fileId || '').trim();
  return id ? 'https://drive.google.com/file/d/' + id + '/view' : '';
}

function formatDateForFileName(dateValue) {
  if (!dateValue) return '';

  let date = dateValue;
  if (!(date instanceof Date)) {
    date = new Date(dateValue);
  }

  if (!(date instanceof Date) || isNaN(date.getTime())) return '';

  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function debugPaymentSlipForActiveRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (!sheet || sheet.getName() !== 'DEALS') {
    Logger.log('Select a DEALS row before running debugPaymentSlipForActiveRow.');
    return;
  }

  const row = sheet.getActiveRange().getRow();
  if (row < DATA_START_ROW) {
    Logger.log('Select a data row before running debugPaymentSlipForActiveRow.');
    return;
  }

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  const paymentStatusColumn = headerMap.payment_status;
  const paymentDateColumn = headerMap.payment_date;
  const paymentSlipUrlColumn = headerMap.payment_slip_url;

  Logger.log('Debug payment slip row=' + row);
  Logger.log('Columns lead_id=' + leadIdColumn + ' payment_status=' + paymentStatusColumn + ' payment_date=' + paymentDateColumn + ' payment_slip_url=' + paymentSlipUrlColumn);

  const leadId = leadIdColumn ? String(sheet.getRange(row, leadIdColumn).getValue() || '').trim() : '';
  const paymentStatus = paymentStatusColumn ? String(sheet.getRange(row, paymentStatusColumn).getValue() || '').trim() : '';
  const paymentDate = paymentDateColumn ? sheet.getRange(row, paymentDateColumn).getValue() : '';
  const existingSlipUrl = paymentSlipUrlColumn ? String(sheet.getRange(row, paymentSlipUrlColumn).getValue() || '').trim() : '';

  Logger.log('Lead ID=' + leadId);
  Logger.log('Payment Status=' + paymentStatus);
  Logger.log('Payment Date=' + paymentDate);
  Logger.log('Payment Slip URL exists=' + Boolean(existingSlipUrl));
  Logger.log('Folder ID=' + PAYMENT_SLIP_FOLDER_ID);

  const file = findPaymentSlipFile(leadId, paymentDate);
  Logger.log(file ? 'Matched payment slip file: ' + file.getName() + ' / ' + file.getId() + ' / ' + buildDriveFileUrl(file.getId()) : 'No matching payment slip file found.');
}
