// Payment slip automation for DEALS.
// Setup:
// 1. Paste this file into Apps Script alongside Code.gs.
// 2. Replace PAYMENT_SLIP_FOLDER_ID with the Google Drive folder that stores payment slip files.
// 3. Create an installable "On edit" trigger for onEdit so DriveApp authorization is available.
// 4. Test by changing DEALS.Payment Status to "paid" on a row whose Payment Slip URL is blank.
const PAYMENT_SLIP_FOLDER_ID = '13ntH9hor9cYnTEL_exsIJZ2T7Y9wyRma';

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

  const leadMatches = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const mimeType = file.getMimeType();
    if (!supportedMimeTypes[mimeType]) {
      Logger.log('Payment slip skipping unsupported file: ' + file.getName() + ' mime=' + mimeType);
      continue;
    }

    const fileName = String(file.getName() || '');
    if (fileName.indexOf(targetLeadId) === -1) {
      Logger.log('Payment slip skipping non-matching file: ' + fileName);
      continue;
    }

    Logger.log('Payment slip candidate file: ' + fileName + ' / ' + file.getId());
    leadMatches.push(file);
  }

  if (!leadMatches.length) return null;

  const dateMatches = targetDate
    ? leadMatches.filter(file => String(file.getName() || '').indexOf(targetDate) !== -1)
    : [];
  const candidates = dateMatches.length ? dateMatches : leadMatches;

  return candidates.reduce((latestFile, file) => {
    if (!latestFile) return file;
    return file.getLastUpdated().getTime() > latestFile.getLastUpdated().getTime()
      ? file
      : latestFile;
  }, null);
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
