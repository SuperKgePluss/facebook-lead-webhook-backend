// Manual one-time schema setup helpers. Run explicitly from the Apps Script editor.
function setupActivityLogSchema() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('ACTIVITY_LOG');
  if (!sheet) return;

  const finalHeaders = [
    'Activity ID',
    'Lead ID',
    'Sheet Name',
    'Action Type',
    'Old Value',
    'New Value',
    'Lead Status',
    'Note',
    'Audio URL',
    'Audio File Name',
    'Payment URL',
    'Payment File Name',
    'Location URL',
    'Location File Name',
    'Created By',
    'Created At',
  ];
  const thaiLabels = [
    'รหัสกิจกรรม',
    'รหัสลูกค้า',
    'ชื่อชีต',
    'ประเภทกิจกรรม',
    'ค่าเดิม',
    'ค่าใหม่',
    'สถานะลูกค้า',
    'หมายเหตุ',
    'ลิงก์ไฟล์เสียง',
    'ชื่อไฟล์เสียง',
    'ลิงก์สลิป',
    'ชื่อไฟล์สลิป',
    'ลิงก์สถานที่',
    'ชื่อไฟล์สถานที่',
    'ผู้บันทึก',
    'วันที่บันทึก',
  ];

  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const dataRowCount = Math.max(lastRow - DATA_START_ROW + 1, 0);
  const dataValues = dataRowCount
    ? sheet.getRange(DATA_START_ROW, 1, dataRowCount, lastColumn).getValues()
    : [];

  const migratedRows = dataValues.map(row => {
    const object = rowToSchemaObject_(headers, row);
    const actionType = object.action_type || object.activity_type || '';
    const newValue = object.new_value || object.result || object.activity_result || '';
    const leadStatus = object.lead_status || (actionType === 'lead_status_changed' ? newValue : '');

    return [
      object.activity_id || '',
      object.lead_id || '',
      object.sheet_name || inferActivitySheetName_(actionType, object.created_by),
      actionType,
      object.old_value || '',
      newValue,
      leadStatus,
      object.note || '',
      object.audio_url || object.audio_link || '',
      object.audio_file_name || '',
      object.payment_url || object.payment_slip_url || object.link_slip || '',
      object.payment_file_name || '',
      object.location_url || '',
      object.location_file_name || '',
      object.created_by || '',
      object.created_at || object.activity_date || '',
    ];
  });

  ensureSheetColumnCount_(sheet, finalHeaders.length);
  sheet.getRange(HEADER_ROW, 1, 1, finalHeaders.length).setValues([finalHeaders]);
  sheet.getRange(HEADER_ROW + 1, 1, 1, thaiLabels.length).setValues([thaiLabels]);

  if (migratedRows.length) {
    sheet.getRange(DATA_START_ROW, 1, migratedRows.length, finalHeaders.length).setValues(migratedRows);
  }

  trimSheetColumns_(sheet, finalHeaders.length);
}

function setupLeadDetailsSchema() {
  const sheet = SpreadsheetApp.getActive().getSheetByName('LEAD_DETAILS');
  if (!sheet) return;

  const finalHeaders = [
    'Lead ID',
    'Facebook Leadgen ID',
    'Raw Phone',
    'Raw Province',
    'Line User ID',
    'Line Display Name',
    'Original Customer Name',
    'Created Source',
  ];
  const thaiLabels = [
    'รหัสลูกค้า',
    'รหัส Facebook Lead',
    'เบอร์ดิบ',
    'จังหวัดดิบ',
    'รหัสผู้ใช้ LINE',
    'ชื่อ LINE',
    'ชื่อลูกค้าเดิม',
    'แหล่งที่สร้าง',
  ];

  const lastRow = sheet.getLastRow();
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const dataRowCount = Math.max(lastRow - DATA_START_ROW + 1, 0);
  const dataValues = dataRowCount
    ? sheet.getRange(DATA_START_ROW, 1, dataRowCount, lastColumn).getValues()
    : [];

  const migratedRows = dataValues.map(row => {
    const object = rowToSchemaObject_(headers, row);

    return [
      object.lead_id || '',
      object.facebook_leadgen_id || '',
      object.raw_phone || '',
      object.raw_province || '',
      object.line_user_id || '',
      object.line_display_name || '',
      object.original_customer_name || object.customer_name || '',
      object.created_source || object.import_source || '',
    ];
  });

  ensureSheetColumnCount_(sheet, finalHeaders.length);
  sheet.getRange(HEADER_ROW, 1, 1, finalHeaders.length).setValues([finalHeaders]);
  sheet.getRange(HEADER_ROW + 1, 1, 1, thaiLabels.length).setValues([thaiLabels]);

  if (migratedRows.length) {
    sheet.getRange(DATA_START_ROW, 1, migratedRows.length, finalHeaders.length).setValues(migratedRows);
  }

  trimSheetColumns_(sheet, finalHeaders.length);
}

function rowToSchemaObject_(headers, row) {
  return headers.reduce((object, header, index) => {
    const key = normalizeHeaderName_(header);
    if (key) object[key] = row[index];
    return object;
  }, {});
}

function inferActivitySheetName_(actionType, createdBy) {
  const action = String(actionType || '').trim().toLowerCase();
  const actor = String(createdBy || '').trim().toLowerCase();

  if (actor.indexOf('crm1') !== -1 || actor.indexOf('crm2') !== -1) return 'IMPORT';
  if (actor === 'line') return 'LINE';
  if (actor === 'facebook') return 'Facebook';
  if (action.indexOf('payment') !== -1) return 'DEALS';
  if (action.indexOf('install') !== -1) return 'INSTALLATIONS';
  if (action.indexOf('lead_status') !== -1 || action === 'follow-up') return 'LEADS_MAIN';

  return 'SYSTEM';
}

function ensureSheetColumnCount_(sheet, requiredColumns) {
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
}

function trimSheetColumns_(sheet, finalColumnCount) {
  const maxColumns = sheet.getMaxColumns();
  if (maxColumns > finalColumnCount) {
    sheet.deleteColumns(finalColumnCount + 1, maxColumns - finalColumnCount);
  }
}
