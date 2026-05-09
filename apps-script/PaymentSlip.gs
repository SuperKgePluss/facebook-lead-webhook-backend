// Payment slip automation for DEALS.
// Setup:
// 1. Paste this file into Apps Script alongside Code.gs.
// 2. Replace PAYMENT_SLIP_FOLDER_ID with the Google Drive folder that stores payment slip files.
// 3. Create an installable "On edit" trigger for onEdit so DriveApp authorization is available.
// 4. Test by changing DEALS.Payment Status to "paid" on a row whose Payment Slip URL is blank.
const PAYMENT_SLIP_FOLDER_ID = '13ntH9hor9cYnTEL_exsIJZ2T7Y9wyRma';
const PAYMENT_SLIP_MAX_FOLDERS_SCANNED = 50;
const PAYMENT_SLIP_MAX_FILES_SCANNED = 500;
const DEALS_PAYMENT_STATUS_VALUES = ['Unpaid', 'Paid', 'Cancelled'];
const DEALS_PAYMENT_STATUS_REFRESH_CURSOR_KEY = 'DEALS_PAYMENT_STATUS_REFRESH_NEXT_ROW';
const DEALS_OPEN_INSTALLATION_REFRESH_CURSOR_KEY = 'DEALS_OPEN_INSTALLATION_REFRESH_NEXT_ROW';
const DEALS_PAYMENT_STATUS_REFRESH_BATCH_SIZE = 100;
const DEALS_OPEN_INSTALLATION_REFRESH_BATCH_SIZE = 100;
const DEALS_FINAL_HEADERS = [
  'Deal ID',
  'Lead ID',
  'Phone',
  'Product Model',
  'Package Type',
  'Full Amount',
  'Paid Amount',
  'Open Installation',
  'Payment Status',
  'Payment Date',
  'Payment Slip URL',
  'Payment Slip Save Status',
];
const DEALS_FINAL_THAI_LABELS = [
  'รหัสดีล',
  'รหัสลูกค้า',
  'เบอร์โทร',
  'รุ่นสินค้า',
  'แพ็กเกจ',
  'ยอดเต็ม',
  'ยอดที่ชำระแล้ว',
  'เปิดงานติดตั้ง',
  'สถานะการชำระเงิน',
  'วันที่ยืนยันการชำระเงิน',
  'ลิงก์สลิป',
  'สถานะการบันทึกสลิป',
];

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
    const paymentSlipSaveStatusColumn = headerMap.payment_slip_save_status;
    const leadIdColumn = headerMap.lead_id;
    const paymentDateColumn = headerMap.payment_date;

    Logger.log('Payment slip edited header=' + editedHeader);
    Logger.log('Payment slip detected columns payment_status=' + paymentStatusColumn + ' payment_slip_url=' + paymentSlipUrlColumn + ' payment_slip_save_status=' + paymentSlipSaveStatusColumn + ' lead_id=' + leadIdColumn + ' payment_date=' + paymentDateColumn);

    if (!paymentStatusColumn || !paymentSlipUrlColumn || !leadIdColumn) {
      Logger.log('Payment slip automation skipped: DEALS required headers missing.');
      return;
    }

    if (e.range.getColumn() !== paymentStatusColumn) {
      Logger.log('Payment slip automation skipped: edited column is not Payment Status.');
      return;
    }

    ensureDealsPaymentStatusDropdownForRow(e.range.getRow(), sheet);

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
      writePaymentSlipSaveStatus_(sheet, row, 'มีลิงก์สลิปแล้ว');
      return;
    }

    const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
    const paymentDate = paymentDateColumn ? sheet.getRange(row, paymentDateColumn).getValue() : '';
    Logger.log('Payment slip detected leadId=' + leadId);
    Logger.log('Payment slip detected payment date=' + paymentDate);
    Logger.log('Payment slip folder id=' + PAYMENT_SLIP_FOLDER_ID);
    if (!leadId) {
      Logger.log('Payment slip automation skipped: Lead ID missing on row ' + row);
      writePaymentSlipSaveStatus_(sheet, row, 'ไม่พบรหัสลูกค้า');
      return;
    }

    const file = findPaymentSlipFile(leadId, paymentDate);
    if (!file) {
      Logger.log('Payment slip automation: no matching payment slip found for Lead ID ' + leadId);
      writePaymentSlipSaveStatus_(sheet, row, 'ไม่พบไฟล์สลิป');
      return;
    }

    sheet.getRange(row, paymentSlipUrlColumn).setValue(buildDriveFileUrl(file.getId()));
    writePaymentSlipSaveStatus_(sheet, row, 'บันทึกลิงก์สลิปแล้ว');
    appendPaymentSlipSavedActivity_(sheet, row, file);
    Logger.log('Payment slip automation: wrote slip URL for Lead ID ' + leadId + ' from file ' + file.getName());
  } catch (err) {
    Logger.log('Payment slip automation failed safely: ' + err.message);
    if (e && e.range && e.range.getSheet && e.range.getSheet().getName() === 'DEALS') {
      writePaymentSlipSaveStatus_(e.range.getSheet(), e.range.getRow(), 'บันทึกสลิปไม่สำเร็จ');
    }
  }
}

function appendPaymentSlipSavedActivity_(sheet, row, file) {
  const deal = getRowObject_(sheet, row);
  const leadId = String(deal.lead_id || '').trim();
  if (!leadId || !file) return;

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'DEALS',
    action_type: 'payment_slip_saved',
    payment_url: buildDriveFileUrl(file.getId()),
    payment_file_name: file.getName(),
    created_by: 'SYSTEM',
    created_at: new Date(),
  });
}

function writePaymentSlipSaveStatus_(sheet, row, message) {
  if (!sheet || sheet.getName() !== 'DEALS' || row < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  const statusColumn = headerMap.payment_slip_save_status;
  if (!statusColumn) {
    Logger.log('Payment Slip Save Status column is missing; status message not written: ' + message);
    return;
  }

  sheet.getRange(row, statusColumn).setValue(message);
}

function setupDealsPaymentUi() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet) return;

  ensureDealsPaymentColumns_(sheet);
  resetDealsPaymentStatusDropdownRefreshCursor();
  resetDealsOpenInstallationCheckboxRefreshCursor();
  refreshDealsPaymentStatusDropdownsLight();
  refreshDealsOpenInstallationCheckboxes();
  setupDealsPaymentStatusConditionalFormatting_();
}

function ensureDealsPaymentColumns_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const dataRowCount = Math.max(lastRow - DATA_START_ROW + 1, 0);
  const dataValues = dataRowCount
    ? sheet.getRange(DATA_START_ROW, 1, dataRowCount, lastColumn).getValues()
    : [];

  const migratedRows = dataValues.map(row => {
    const object = headers.reduce((item, header, index) => {
      const key = normalizeHeaderName_(header);
      if (key) item[key] = row[index];
      return item;
    }, {});
    const leadId = String(object.lead_id || '').trim();
    const phone = String(object.phone || '').trim() || getLeadPhoneByLeadId_(leadId);

    return [
      object.deal_id || '',
      leadId,
      phone,
      object.product_model || '',
      object.package_type || '',
      object.full_amount || '',
      object.paid_amount || object.price || '',
      false,
      object.payment_status || '',
      object.payment_date || '',
      object.payment_slip_url || '',
      object.payment_slip_save_status || '',
    ];
  });

  if (sheet.getMaxColumns() < DEALS_FINAL_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), DEALS_FINAL_HEADERS.length - sheet.getMaxColumns());
  }

  setDealsHeaderLabels_(sheet);

  if (migratedRows.length) {
    sheet.getRange(DATA_START_ROW, 1, migratedRows.length, DEALS_FINAL_HEADERS.length).setValues(migratedRows);
  }

  if (sheet.getLastColumn() > DEALS_FINAL_HEADERS.length) {
    sheet.deleteColumns(DEALS_FINAL_HEADERS.length + 1, sheet.getLastColumn() - DEALS_FINAL_HEADERS.length);
  }
}

function setDealsHeaderLabels_(sheet) {
  sheet.getRange(HEADER_ROW, 1, 1, DEALS_FINAL_HEADERS.length).setValues([DEALS_FINAL_HEADERS]);
  sheet.getRange(HEADER_ROW + 1, 1, 1, DEALS_FINAL_THAI_LABELS.length).setValues([DEALS_FINAL_THAI_LABELS]);
}

function isDealsPaymentStatusDropdownCell_(cell) {
  const validation = cell.getDataValidation();
  if (!validation || validation.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return false;
  }

  const criteriaValues = validation.getCriteriaValues();
  const values = criteriaValues && criteriaValues[0] ? criteriaValues[0] : [];
  return values.join('|') === DEALS_PAYMENT_STATUS_VALUES.join('|');
}

function getDealsPaymentStatusValidation_() {
  return SpreadsheetApp
    .newDataValidation()
    .requireValueInList(DEALS_PAYMENT_STATUS_VALUES, true)
    .setAllowInvalid(false)
    .build();
}

function ensureDealsPaymentStatusDropdownForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet || sheet.getName() !== 'DEALS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const dealIdColumn = headerMap.deal_id;
  const leadIdColumn = headerMap.lead_id;
  const paymentStatusColumn = headerMap.payment_status;
  if (!dealIdColumn || !leadIdColumn || !paymentStatusColumn) return false;

  const dealId = String(sheet.getRange(row, dealIdColumn).getValue() || '').trim();
  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const statusCell = sheet.getRange(row, paymentStatusColumn);
  const currentStatus = String(statusCell.getValue() || '').trim();
  let changed = false;

  if (dealId && leadId) {
    if (!isDealsPaymentStatusDropdownCell_(statusCell)) {
      statusCell.setDataValidation(getDealsPaymentStatusValidation_());
      changed = true;
    }
    if (!currentStatus) {
      statusCell.setValue('Unpaid');
      changed = true;
    }
    return changed;
  }

  if (!dealId && !leadId && !currentStatus && statusCell.getDataValidation()) {
    statusCell.clearDataValidations();
    changed = true;
  }

  return changed;
}

function ensureDealsOpenInstallationCheckboxForRow(row, optionalSheet) {
  const sheet = optionalSheet || SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet || sheet.getName() !== 'DEALS' || row < DATA_START_ROW || row > sheet.getLastRow()) return false;

  const headerMap = getHeaderMap_(sheet);
  const dealIdColumn = headerMap.deal_id;
  const leadIdColumn = headerMap.lead_id;
  const openInstallationColumn = headerMap.open_installation;
  if (!dealIdColumn || !leadIdColumn || !openInstallationColumn) return false;

  const dealId = String(sheet.getRange(row, dealIdColumn).getValue() || '').trim();
  const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();
  const cell = sheet.getRange(row, openInstallationColumn);
  let changed = false;

  if (dealId && leadId) {
    if (!isCheckboxCell_(cell)) {
      cell.insertCheckboxes();
      changed = true;
    }
    if (String(cell.getValue()).toUpperCase() !== 'TRUE') {
      cell.setValue(false);
    }
    return changed;
  }

  if (!dealId && !leadId && (String(cell.getValue() || '').trim() || isCheckboxCell_(cell))) {
    cell.clearContent();
    cell.clearDataValidations();
    changed = true;
  }

  return changed;
}

function refreshDealsPaymentStatusDropdownsLight() {
  const properties = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.deal_id || !headerMap.lead_id || !headerMap.payment_status) return;

  const savedCursor = Number(properties.getProperty(DEALS_PAYMENT_STATUS_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + DEALS_PAYMENT_STATUS_REFRESH_BATCH_SIZE - 1, lastRow);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    if (ensureDealsPaymentStatusDropdownForRow(row, sheet)) fixed++;
    if (ensureDealsOpenInstallationCheckboxForRow(row, sheet)) fixed++;
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(DEALS_PAYMENT_STATUS_REFRESH_CURSOR_KEY, String(nextCursor));
  setupDealsPaymentStatusConditionalFormatting_();

  Logger.log('refreshDealsPaymentStatusDropdownsLight startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
}

function resetDealsPaymentStatusDropdownRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(DEALS_PAYMENT_STATUS_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('DEALS payment status dropdown refresh cursor reset to ' + DATA_START_ROW);
}

function refreshDealsOpenInstallationCheckboxes() {
  const properties = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.deal_id || !headerMap.lead_id || !headerMap.open_installation) return;

  const savedCursor = Number(properties.getProperty(DEALS_OPEN_INSTALLATION_REFRESH_CURSOR_KEY));
  const startRow = Number.isFinite(savedCursor) && savedCursor >= DATA_START_ROW && savedCursor <= lastRow
    ? savedCursor
    : DATA_START_ROW;
  const endRow = Math.min(startRow + DEALS_OPEN_INSTALLATION_REFRESH_BATCH_SIZE - 1, lastRow);
  let checked = 0;
  let fixed = 0;

  for (let row = startRow; row <= endRow; row++) {
    checked++;
    if (ensureDealsOpenInstallationCheckboxForRow(row, sheet)) fixed++;
  }

  const nextCursor = endRow + 1 > lastRow ? DATA_START_ROW : endRow + 1;
  properties.setProperty(DEALS_OPEN_INSTALLATION_REFRESH_CURSOR_KEY, String(nextCursor));

  Logger.log('refreshDealsOpenInstallationCheckboxes startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
}

function resetDealsOpenInstallationCheckboxRefreshCursor() {
  PropertiesService
    .getScriptProperties()
    .setProperty(DEALS_OPEN_INSTALLATION_REFRESH_CURSOR_KEY, String(DATA_START_ROW));
  Logger.log('DEALS open installation checkbox refresh cursor reset to ' + DATA_START_ROW);
}

function setupDealsPaymentStatusConditionalFormatting_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet) return;

  const headerMap = getHeaderMap_(sheet);
  const statusColumn = headerMap.payment_status;
  if (!statusColumn) return;

  const lastRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  const lastColumn = sheet.getLastColumn();
  const range = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastColumn);
  const statusColumnLetter = columnToLetter_(statusColumn);
  const paidFormula = '=$' + statusColumnLetter + DATA_START_ROW + '="Paid"';
  const cancelledFormula = '=$' + statusColumnLetter + DATA_START_ROW + '="Cancelled"';
  const managedFormulas = [paidFormula, cancelledFormula];

  const existingRules = sheet.getConditionalFormatRules().filter(rule => {
    const condition = rule.getBooleanCondition();
    const values = condition ? condition.getCriteriaValues() : [];
    return !values.some(value => managedFormulas.indexOf(String(value)) !== -1);
  });

  const paidRule = SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied(paidFormula)
    .setBackground('#d9ead3')
    .setRanges([range])
    .build();

  const cancelledRule = SpreadsheetApp
    .newConditionalFormatRule()
    .whenFormulaSatisfied(cancelledFormula)
    .setBackground('#f4cccc')
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules(existingRules.concat([paidRule, cancelledRule]));
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
