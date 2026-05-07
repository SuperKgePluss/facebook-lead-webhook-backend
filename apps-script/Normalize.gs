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
  const rowObject = getRowObject_(sheet, row);
  const normalizedPhone = normalizePhone(rowObject.phone);
  const normalizedSource = normalizeByRule('source', rowObject.source);
  const normalizedProvince = normalizeByRule('province', rowObject.province);
  const zone = normalizeByRule('zone', normalizedProvince);

  setRowObjectValues_(sheet, row, {
    phone: normalizedPhone,
    source: normalizedSource,
    province: normalizedProvince,
    zone: zone,
    updated_at: new Date(),
  });
}
