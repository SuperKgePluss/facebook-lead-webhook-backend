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
const DEALS_PAYMENT_STATUS_REFRESH_BATCH_SIZE = 50;
const DEALS_OPEN_INSTALLATION_REFRESH_BATCH_SIZE = 50;
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

    const paymentMatch = findPaymentSlipFile(leadId, paymentDate);
    if (!paymentMatch.file) {
      Logger.log('Payment slip automation: no matching payment slip found for Lead ID ' + leadId);
      writePaymentSlipSaveStatus_(sheet, row, 'ไม่พบไฟล์สลิปใน Google Drive ตามรูปแบบที่กำหนด');
      return;
    }

    sheet.getRange(row, paymentSlipUrlColumn).setValue(paymentMatch.fileUrl);
    writePaymentSlipSaveStatus_(sheet, row, 'บันทึกลิงก์สลิปแล้ว');
    appendPaymentSlipSavedActivity_(sheet, row, paymentMatch);
    Logger.log('Payment slip automation: wrote slip URL for Lead ID ' + leadId + ' from file ' + paymentMatch.fileName + ' parsed=' + paymentMatch.parsedTimestamp + ' matches=' + paymentMatch.matchCount);
  } catch (err) {
    Logger.log('Payment slip automation failed safely: ' + err.message);
    if (e && e.range && e.range.getSheet && e.range.getSheet().getName() === 'DEALS') {
      writePaymentSlipSaveStatus_(e.range.getSheet(), e.range.getRow(), 'บันทึกสลิปไม่สำเร็จ');
    }
  }
}

function appendPaymentSlipSavedActivity_(sheet, row, paymentMatch) {
  const deal = getRowObject_(sheet, row);
  const leadId = String(deal.lead_id || '').trim();
  if (!leadId || !paymentMatch || !paymentMatch.file) return;

  appendObjectRow_('ACTIVITY_LOG', {
    activity_id: 'ACT-' + Date.now(),
    lead_id: leadId,
    sheet_name: 'DEALS',
    action_type: 'payment_slip_saved',
    payment_url: paymentMatch.fileUrl,
    payment_file_name: paymentMatch.fileName,
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
  setupDealsPaymentStatusConditionalFormatting_();
  Logger.log('setupDealsPaymentUi completed lightweight setup. Run setupCrmUiBatch repeatedly to repair row-level dropdowns and checkboxes.');
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
  if (!sheet) return { task_completed: true };

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return { task_completed: true };

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.deal_id || !headerMap.lead_id || !headerMap.payment_status) return { task_completed: true };

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

  Logger.log('refreshDealsPaymentStatusDropdownsLight batch_size=' + DEALS_PAYMENT_STATUS_REFRESH_BATCH_SIZE + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
  return {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    fixed: fixed,
    task_completed: nextCursor === DATA_START_ROW,
  };
}

function refreshDealsPaymentStatusDropdownsAll() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.deal_id || !headerMap.lead_id || !headerMap.payment_status) return;

  let checked = 0;
  let fixed = 0;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    checked++;
    if (ensureDealsPaymentStatusDropdownForRow(row, sheet)) fixed++;
    if (ensureDealsOpenInstallationCheckboxForRow(row, sheet)) fixed++;
  }

  setupDealsPaymentStatusConditionalFormatting_();
  Logger.log('refreshDealsPaymentStatusDropdownsAll checked=' + checked + ' fixed=' + fixed);
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
  if (!sheet) return { task_completed: true };

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return { task_completed: true };

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.deal_id || !headerMap.lead_id || !headerMap.open_installation) return { task_completed: true };

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

  Logger.log('refreshDealsOpenInstallationCheckboxes batch_size=' + DEALS_OPEN_INSTALLATION_REFRESH_BATCH_SIZE + ' startRow=' + startRow + ' endRow=' + endRow + ' lastRow=' + lastRow + ' checked=' + checked + ' fixed=' + fixed + ' nextCursor=' + nextCursor);
  return {
    startRow: startRow,
    endRow: endRow,
    nextCursor: nextCursor,
    checked: checked,
    fixed: fixed,
    task_completed: nextCursor === DATA_START_ROW,
  };
}

function refreshDealsOpenInstallationCheckboxesAll() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('DEALS');
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const headerMap = getHeaderMap_(sheet);
  if (!headerMap.deal_id || !headerMap.lead_id || !headerMap.open_installation) return;

  let checked = 0;
  let fixed = 0;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    checked++;
    if (ensureDealsOpenInstallationCheckboxForRow(row, sheet)) fixed++;
  }

  Logger.log('refreshDealsOpenInstallationCheckboxesAll checked=' + checked + ' fixed=' + fixed);
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
  const supportedMimeTypes = {
    'image/jpeg': true,
    'image/png': true,
    'application/pdf': true,
  };
  return findLatestEvidenceFileByLeadId_(PAYMENT_SLIP_FOLDER_ID, leadId, {
    evidenceType: 'payment_slip',
    maxFolders: PAYMENT_SLIP_MAX_FOLDERS_SCANNED,
    maxFiles: PAYMENT_SLIP_MAX_FILES_SCANNED,
    allowedMimeTypes: supportedMimeTypes,
  });
}

function buildDriveFileUrl(fileId) {
  const id = String(fileId || '').trim();
  return id ? 'https://drive.google.com/file/d/' + id + '/view' : '';
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

  const paymentMatch = findPaymentSlipFile(leadId, paymentDate);
  Logger.log(paymentMatch.file ? 'Matched payment slip file: ' + paymentMatch.fileName + ' / ' + paymentMatch.file.getId() + ' / ' + paymentMatch.fileUrl + ' parsed=' + paymentMatch.parsedTimestamp + ' matches=' + paymentMatch.matchCount : 'No matching payment slip file found. Expected format: ' + leadId + '_YYYYMMDD_HH_MM');
}
