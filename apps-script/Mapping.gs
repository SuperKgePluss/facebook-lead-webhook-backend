// Mapping rule lookup helpers for the long-table MAPPING_RULES sheet.
function normalizeMappingKey_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
    .replace(/\s+/g, ' ');
}

function isInvalidMappingValue_(value) {
  const input = String(value || '').trim();
  if (!input) return true;

  const invalid = normalizeMappingKey_(input);
  if (invalid === 'unknown' || invalid === 'ไม่ระบุ' || invalid === '???' || invalid === '-' || invalid === 'n/a') {
    return true;
  }

  return false;
}

function fallbackProvinceNormalize_(value) {
  const compact = normalizeMappingKey_(value).replace(/\s+/g, '');
  const bangkok = '\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e\u0e21\u0e2b\u0e32\u0e19\u0e04\u0e23';

  if (compact === 'bangkok' || compact === 'bkk' || compact === 'bangkokmetropolis' || compact === '\u0e01\u0e17\u0e21' || compact === '\u0e01\u0e17\u0e21.' || compact === '\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e') {
    return bangkok;
  }

  return '';
}

function normalizeByRule(ruleType, value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (isInvalidMappingValue_(input)) return '';

  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('MAPPING_RULES');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) {
    if (normalizeMappingKey_(ruleType) === 'province') return fallbackProvinceNormalize_(input) || input;
    if (normalizeMappingKey_(ruleType) === 'zone') return '';
    return input;
  }

  const headerMap = getHeaderMap_(sheet);
  const required = ['rule_type', 'input_value', 'output_value'];
  required.forEach(header => {
    if (!headerMap[header]) {
      throw new Error('MAPPING_RULES missing header: ' + header);
    }
  });

  const rowCount = sheet.getLastRow() - DATA_START_ROW + 1;
  const values = sheet.getRange(DATA_START_ROW, 1, rowCount, sheet.getLastColumn()).getValues();
  const targetRule = normalizeMappingKey_(ruleType);
  const targetInput = normalizeMappingKey_(input);

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const rowRuleType = normalizeMappingKey_(row[headerMap.rule_type - 1]);
    const rowInput = normalizeMappingKey_(row[headerMap.input_value - 1]);

    if (rowRuleType === targetRule && rowInput === targetInput) {
      return String(row[headerMap.output_value - 1] || '').trim();
    }
  }

  if (targetRule !== 'invalid value') {
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const rowRuleType = normalizeMappingKey_(row[headerMap.rule_type - 1]);
      const rowInput = normalizeMappingKey_(row[headerMap.input_value - 1]);

      if (rowRuleType === 'invalid value' && rowInput === targetInput) {
        return '';
      }
    }
  }

  if (targetRule === 'province') return fallbackProvinceNormalize_(input) || input;
  if (targetRule === 'zone') return '';

  return input;
}
