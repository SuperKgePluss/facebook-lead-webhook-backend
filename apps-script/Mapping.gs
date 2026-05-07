// Mapping rule lookup helpers for the long-table MAPPING_RULES sheet.
function normalizeMappingKey_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeByRule(ruleType, value) {
  const input = String(value || '').trim();
  if (!input) return '';

  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('MAPPING_RULES');
  if (!sheet || sheet.getLastRow() < DATA_START_ROW) {
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

  return input;
}
