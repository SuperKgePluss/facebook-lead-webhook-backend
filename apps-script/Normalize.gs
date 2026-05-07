// Phone, source, province, zone, and updated_at normalization for LEADS_MAIN edits.
function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '').trim();
  if (!digits) return '';

  if (digits.indexOf('66') === 0 && digits.length > 2) {
    digits = '0' + digits.slice(2);
  }

  if (digits.length === 9 && digits.indexOf('0') !== 0) {
    digits = '0' + digits;
  }

  return digits;
}

function normalizeLeadMainRow(sheet, row) {
  return normalizeLeadMainRow_(sheet, row, true);
}

function normalizeLeadMainRowAfterSync_(sheet, row) {
  return normalizeLeadMainRow_(sheet, row, false);
}

function normalizeLeadMainRow_(sheet, row, alwaysUpdateTimestamp) {
  const rowObject = getRowObject_(sheet, row);
  const normalizedPhone = normalizePhone(rowObject.phone);
  const normalizedSource = normalizeByRule('source', rowObject.source);
  const normalizedProvince = normalizeByRule('province', rowObject.province);
  const zone = normalizeByRule('zone', normalizedProvince);
  const changed =
    String(rowObject.phone || '') !== normalizedPhone ||
    String(rowObject.source || '') !== normalizedSource ||
    String(rowObject.province || '') !== normalizedProvince ||
    String(rowObject.zone || '') !== zone;

  if (!changed && !alwaysUpdateTimestamp) {
    return false;
  }

  const updates = {
    phone: normalizedPhone,
    source: normalizedSource,
    province: normalizedProvince,
    zone: zone,
  };

  if (changed || alwaysUpdateTimestamp) {
    updates.updated_at = new Date();
  }

  setRowObjectValues_(sheet, row, updates);
  return changed;
}

function refreshLeadMainRowsAfterSync(rowNumbers) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  const rows = (Array.isArray(rowNumbers) ? rowNumbers : [])
    .map(row => Number(row))
    .filter(row => Number.isFinite(row) && row >= DATA_START_ROW && row <= lastRow);

  rows.forEach(row => {
    const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();

    if (leadId) {
      refreshOpenDealCheckboxForRow_(sheet, row);
      normalizeLeadMainRowAfterSync_(sheet, row);
      return;
    }

    refreshOpenDealCheckboxForRow_(sheet, row);
  });
}

// Full maintenance cleanup. Run manually or on a low-frequency schedule, not after every Facebook sync.
function refreshLeadMainAfterSync() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('LEADS_MAIN');
  if (!sheet) return;

  const headerMap = getHeaderMap_(sheet);
  const leadIdColumn = headerMap.lead_id;
  if (!leadIdColumn) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    const leadId = String(sheet.getRange(row, leadIdColumn).getValue() || '').trim();

    if (leadId) {
      refreshOpenDealCheckboxForRow_(sheet, row);
      normalizeLeadMainRowAfterSync_(sheet, row);
      continue;
    }

    refreshOpenDealCheckboxForRow_(sheet, row);
  }
}
