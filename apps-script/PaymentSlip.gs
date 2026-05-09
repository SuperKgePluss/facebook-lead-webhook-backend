// Payment slip automation for DEALS.
// Setup:
// 1. Paste this file into Apps Script alongside Code.gs.
// 2. Replace PAYMENT_SLIP_FOLDER_ID with the Google Drive folder that stores payment slip files.
// 3. Create an installable "On edit" trigger for onEdit so DriveApp authorization is available.
// 4. Test by changing DEALS.Payment Status to "paid" on a row whose Payment Slip URL is blank.
const PAYMENT_SLIP_FOLDER_ID = 'PUT_PAYMENT_SLIP_FOLDER_ID_HERE';

function handleDealPaymentStatusEdit_(e) {
  try {
    if (!e || !e.range) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

    const sheet = e.range.getSheet();
    if (sheet.getName() !== 'DEALS') return;
    if (e.range.getRow() < DATA_START_ROW) return;

    const headerMap = getHeaderMap_(sheet);
    const paymentStatusColumn = headerMap.payment_status;
    const paymentSlipUrlColumn = headerMap.payment_slip_url;
    const leadIdColumn = headerMap.lead_id;
    const paymentDateColumn = headerMap.payment_date;

    if (!paymentStatusColumn || !paymentSlipUrlColumn || !leadIdColumn) {
      Logger.log('Payment slip automation skipped: DEALS required headers missing.');
      return;
    }

    if (e.range.getColumn() !== paymentStatusColumn) return;
    if (String(e.value || '').trim().toLowerCase() !== 'paid') return;

    const row = e.range.getRow();
    const existingSlipUrl = String(sheet.getRange(row, paymentSlipUrlColumn).getValue() || '').trim();
    if (existingSlipUrl) {
      Logger.log('Payment slip automation skipped: Payment Slip URL already exists on row ' + row);
      return;
    }

    const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
    const paymentDate = paymentDateColumn ? sheet.getRange(row, paymentDateColumn).getValue() : '';
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
    if (!supportedMimeTypes[mimeType]) continue;

    const fileName = String(file.getName() || '');
    if (fileName.indexOf(targetLeadId) === -1) continue;

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
