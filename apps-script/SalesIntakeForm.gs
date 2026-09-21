/*
 * Blue Oak Sales Intake Form processor.
 *
 * This file is intentionally self-contained. It is not installed, triggered,
 * or connected to CRM_V3 by this implementation slice.
 */
var SALES_INTAKE_RESPONSE_SHEET_NAME = 'การตอบแบบฟอร์ม 1';
var SALES_INTAKE_SPREADSHEET_ID = '1BOCNBgiWi62BnD_tjnA1tnY9stPsd_e6pzROCUV30UI';
var SALES_INTAKE_RESPONSE_HEADER_ROW = 1;
var SALES_INTAKE_RESPONSE_DATA_START_ROW = 2;
var SALES_INTAKE_CRM_DATA_START_ROW = 3;
var SALES_INTAKE_SETTINGS_DATA_START_ROW = 2;
var SALES_INTAKE_SETTINGS_SALES_OWNER_HEADERS = ['Sales Owner', 'Sales', 'Owner'];
var SALES_INTAKE_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
var SALES_INTAKE_LOCK_TIMEOUT_MS = 30 * 1000;
var SALES_INTAKE_PROCESSOR_HEADERS = [
  'Submission Key',
  'Processing Status',
  'Lead Resolution',
  'Lead ID',
  'Deal ID',
  'Install ID',
  'Processed At',
  'Error',
];
var SALES_INTAKE_STATUSES = {
  PROCESSING: true,
  CREATED: true,
  DUPLICATE_RESPONSE: true,
  EXISTING_LEAD_USED: true,
  REVIEW_REQUIRED: true,
  FAILED: true,
  ROLLED_BACK: true,
};
var SALES_INTAKE_SOURCE_FIELDS = {
  timestamp: ['ประทับเวลา', 'timestamp', 'form timestamp'],
  responder_email: ['ที่อยู่อีเมล', 'email address', 'responder email', 'email'],
  customer_name: ['customer name'],
  phone: ['phone'],
  sales_owner: ['sales owner'],
  additional_note: ['additional note'],
  product_model: ['product model / รุ่นสินค้า', 'product model'],
  package_type: ['package type / แพ็กเกจ', 'package type'],
  full_amount: ['full amount / ยอดเต็ม', 'full amount'],
  paid_amount: ['paid amount / ยอดที่ชำระแล้ว', 'paid amount'],
  payment_date: ['payment date / วันที่ชำระ', 'payment date'],
  payment_slip_url: ['payment slip url / ลิงก์สลิป', 'payment slip url'],
  need_installation: ['ต้องเปิดงานติดตั้งหรือไม่', 'need installation'],
  preferred_install_date: ['preferred install date'],
  preferred_install_time: ['preferred install time'],
  installation_location: ['installation location'],
  machine_count: ['machine count'],
  installation_note: ['installation note'],
};
var SALES_INTAKE_TARGET_HEADERS = {
  LEADS_MAIN: [
    'Lead ID', 'Open Deal', 'Customer Name', 'Phone', 'Lead Status',
    'Sales Owner', 'Follow-up Note', 'Save Follow-up', 'Follow-up Save Status',
    'Latest Follow-up No.', 'Latest Follow-up At', 'Source', 'Customer Type',
    'Province', 'Zone', 'Preferred Call Day', 'Preferred Call Time',
    'Created At', 'Updated At', 'Lead Form Name', 'Ad Name', 'Ad Set Name',
    'Campaign Name', 'Facebook Created Time',
  ],
  LEAD_DETAILS: [
    'Lead ID', 'Facebook Leadgen ID', 'Raw Phone', 'Raw Province',
    'Line User ID', 'Line Display Name', 'Original Customer Name', 'Created Source',
  ],
  DEALS: [
    'Deal ID', 'Lead ID', 'Phone', 'Product Model', 'Package Type',
    'Full Amount', 'Paid Amount', 'Open Installation', 'Payment Status',
    'Payment Date', 'Payment Slip URL', 'Payment Slip Save Status',
  ],
  INSTALLATIONS: [
    'Install ID', 'Lead ID', 'Phone', 'Save Location', 'Install Status',
    'Preferred Install Date', 'Preferred Install Time', 'Location',
    'Install Save Status', 'Machine Count', 'Install Contact Count', 'Note',
  ],
  LEADS: ['Lead ID'],
};

function salesIntakeNormalizeHeader_(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function salesIntakeKey_(value) {
  return salesIntakeNormalizeHeader_(value).replace(/\s/g, '_');
}

function salesIntakeBuildHeaderMap_(headers) {
  var map = {};
  (headers || []).forEach(function(header, index) {
    var key = salesIntakeKey_(header);
    if (key && !map[key]) map[key] = index + 1;
  });
  return map;
}

function salesIntakeFindHeader_(headers, aliases) {
  var wanted = (aliases || []).map(salesIntakeNormalizeHeader_);
  for (var i = 0; i < headers.length; i++) {
    if (wanted.indexOf(salesIntakeNormalizeHeader_(headers[i])) !== -1) return i;
  }
  return -1;
}

function salesIntakeFindSourceColumns_(headers) {
  var columns = {};
  Object.keys(SALES_INTAKE_SOURCE_FIELDS).forEach(function(field) {
    columns[field] = salesIntakeFindHeader_(headers, SALES_INTAKE_SOURCE_FIELDS[field]);
  });
  return columns;
}

function salesIntakeMissingSourceHeaders_(headers) {
  var columns = salesIntakeFindSourceColumns_(headers);
  return Object.keys(columns).filter(function(field) { return columns[field] < 0; });
}

function salesIntakeMissingTargetHeaders_(tableName, headers) {
  var missing = [];
  (SALES_INTAKE_TARGET_HEADERS[tableName] || []).forEach(function(header) {
    if (salesIntakeFindHeader_(headers, [header]) < 0) missing.push(header);
  });
  return missing;
}

function salesIntakeNormalizePhone_(value) {
  var raw = String(value == null ? '' : value).trim();
  if (!raw || /[A-Za-z]/.test(raw)) return '';
  if (!/^[+0-9()\-\s.]+$/.test(raw)) return '';
  var digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.indexOf('0066') === 0 && digits.length > 4) digits = digits.slice(2);
  if (digits.indexOf('66') === 0 && digits.length === 11) digits = '0' + digits.slice(2);
  if (digits.length === 9 && /^[689]/.test(digits)) digits = '0' + digits;
  return /^0\d{9}$/.test(digits) ? digits : '';
}

function salesIntakeMaskPhone_(value) {
  var phone = String(value == null ? '' : value).replace(/\D/g, '');
  return phone.length >= 4 ? '******' + phone.slice(-4) : '****';
}

function salesIntakeSafeError_(error) {
  var message = String(error && error.message || error || 'Unknown error')
    .replace(/0\d{9}/g, '**********')
    .replace(/\b\d{9,}\b/g, '##########');
  return message.slice(0, 240);
}

function salesIntakeReadValue_(values, columns, field) {
  var index = columns[field];
  return index == null || index < 0 ? '' : values[index];
}

function salesIntakeText_(value) {
  return String(value == null ? '' : value).trim();
}

function salesIntakeIsBlank_(value) {
  return salesIntakeText_(value) === '';
}

function salesIntakeParseAmount_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  var text = salesIntakeText_(value).replace(/,/g, '');
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  var number = Number(text);
  return isFinite(number) ? number : null;
}

function salesIntakeParseYesNo_(value) {
  var text = salesIntakeNormalizeHeader_(value);
  if (['yes', 'y', 'true', '1', 'ใช่', 'ต้องการ'].indexOf(text) !== -1) return true;
  if (['no', 'n', 'false', '0', 'ไม่', 'ไม่ต้องการ'].indexOf(text) !== -1) return false;
  return null;
}

function salesIntakeParseDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  var text = salesIntakeText_(value);
  if (!text) return null;
  var parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function salesIntakeTimestampText_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();
  return salesIntakeText_(value);
}

function salesIntakeValidateInput_(values, columns, salesOwners) {
  var name = salesIntakeText_(salesIntakeReadValue_(values, columns, 'customer_name'));
  var rawPhone = salesIntakeText_(salesIntakeReadValue_(values, columns, 'phone'));
  var phone = salesIntakeNormalizePhone_(rawPhone);
  var owner = salesIntakeText_(salesIntakeReadValue_(values, columns, 'sales_owner'));
  var fullAmount = salesIntakeParseAmount_(salesIntakeReadValue_(values, columns, 'full_amount'));
  var paidAmount = salesIntakeParseAmount_(salesIntakeReadValue_(values, columns, 'paid_amount'));
  var paymentDateValue = salesIntakeReadValue_(values, columns, 'payment_date');
  var paymentDate = salesIntakeParseDate_(paymentDateValue);
  var slip = salesIntakeText_(salesIntakeReadValue_(values, columns, 'payment_slip_url'));
  var needInstallation = salesIntakeParseYesNo_(salesIntakeReadValue_(values, columns, 'need_installation'));
  var location = salesIntakeText_(salesIntakeReadValue_(values, columns, 'installation_location'));
  var machineValue = salesIntakeReadValue_(values, columns, 'machine_count');
  var machineText = salesIntakeText_(machineValue);
  var machineCount = machineText && /^\d+$/.test(machineText) ? Number(machineText) : (typeof machineValue === 'number' ? machineValue : null);

  function invalid(code, detail) {
    return { valid: false, code: code, detail: detail || code };
  }

  if (!name) return invalid('CUSTOMER_NAME_REQUIRED');
  if (!phone) return invalid('INVALID_PHONE_' + salesIntakeMaskPhone_(rawPhone));
  if (!owner || salesOwners.indexOf(owner) === -1) return invalid('INVALID_SALES_OWNER');
  if (fullAmount == null || fullAmount <= 0) return invalid('INVALID_FULL_AMOUNT');
  if (paidAmount == null || paidAmount < 0) return invalid('INVALID_PAID_AMOUNT');
  if (paidAmount > fullAmount) return invalid('PAID_AMOUNT_EXCEEDS_FULL_AMOUNT');
  if (paidAmount > 0 && !paymentDate) return invalid('PAYMENT_DATE_REQUIRED');
  if (slip && !/^https?:\/\//i.test(slip)) return invalid('INVALID_PAYMENT_SLIP_URL');
  if (needInstallation === null) return invalid('INVALID_NEED_INSTALLATION');
  if (needInstallation) {
    if (!location) return invalid('INSTALLATION_LOCATION_REQUIRED');
    if (machineCount == null || !isFinite(machineCount) || machineCount <= 0 || Math.floor(machineCount) !== machineCount) {
      return invalid('MACHINE_COUNT_MUST_BE_POSITIVE_INTEGER');
    }
  } else if ([
    location,
    salesIntakeText_(salesIntakeReadValue_(values, columns, 'preferred_install_date')),
    salesIntakeText_(salesIntakeReadValue_(values, columns, 'preferred_install_time')),
    machineText,
    salesIntakeText_(salesIntakeReadValue_(values, columns, 'installation_note')),
  ].some(function(value) { return value !== ''; })) {
    return invalid('CONFLICTING_INSTALLATION_DATA');
  }

  return {
    valid: true,
    name: name,
    rawPhone: rawPhone,
    phone: phone,
    salesOwner: owner,
    additionalNote: salesIntakeText_(salesIntakeReadValue_(values, columns, 'additional_note')),
    productModel: salesIntakeText_(salesIntakeReadValue_(values, columns, 'product_model')),
    packageType: salesIntakeText_(salesIntakeReadValue_(values, columns, 'package_type')),
    fullAmount: fullAmount,
    paidAmount: paidAmount,
    paymentDate: paymentDate,
    paymentDateRaw: paymentDateValue,
    paymentSlipUrl: slip,
    needInstallation: needInstallation,
    preferredInstallDate: salesIntakeReadValue_(values, columns, 'preferred_install_date'),
    preferredInstallTime: salesIntakeReadValue_(values, columns, 'preferred_install_time'),
    installationLocation: location,
    machineCount: machineCount,
    installationNote: salesIntakeText_(salesIntakeReadValue_(values, columns, 'installation_note')),
    timestamp: salesIntakeReadValue_(values, columns, 'timestamp'),
    responderEmail: salesIntakeText_(salesIntakeReadValue_(values, columns, 'responder_email')),
  };
}

function salesIntakeHash_(text) {
  if (typeof Utilities !== 'undefined' && Utilities.computeDigest && Utilities.DigestAlgorithm) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
    return bytes.map(function(byte) {
      var value = byte < 0 ? byte + 256 : byte;
      return ('0' + value.toString(16)).slice(-2);
    }).join('').slice(0, 32);
  }
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return ('00000000' + hash.toString(16)).slice(-8);
}

function salesIntakeSubmissionKey_(headers, values) {
  var columns = salesIntakeFindSourceColumns_(headers);
  var evidence = Object.keys(SALES_INTAKE_SOURCE_FIELDS).sort().map(function(field) {
    var value = salesIntakeReadValue_(values, columns, field);
    if (field === 'phone') value = salesIntakeNormalizePhone_(value) || salesIntakeText_(value);
    return field + '=' + salesIntakeText_(value);
  }).join('|');
  return 'SIF-' + salesIntakeHash_(evidence);
}

function salesIntakeValidateTableHeaders_(tableName, table) {
  var missing = salesIntakeMissingTargetHeaders_(tableName, table.headers);
  if (missing.length) throw new Error('MISSING_' + tableName + '_HEADERS:' + missing.join(','));
  return true;
}

function salesIntakeRowsForField_(table, field, value) {
  var key = salesIntakeKey_(field);
  return (table.rows || []).filter(function(row) { return salesIntakeText_(row.fields[key]) === salesIntakeText_(value); });
}

function salesIntakeIsSkeletonDeal_(fields) {
  return salesIntakeIsBlank_(fields.product_model)
    && salesIntakeIsBlank_(fields.package_type)
    && salesIntakeIsBlank_(fields.full_amount)
    && salesIntakeIsBlank_(fields.paid_amount)
    && salesIntakeIsBlank_(fields.payment_slip_url)
    && salesIntakeIsBlank_(fields.payment_date)
    && (salesIntakeIsBlank_(fields.payment_status) || salesIntakeNormalizeHeader_(fields.payment_status) === 'unpaid')
    && !(fields.open_installation === true || salesIntakeNormalizeHeader_(fields.open_installation) === 'true');
}

function salesIntakeInstallationIsSubstantive_(fields) {
  return !salesIntakeIsBlank_(fields.install_id)
    || !salesIntakeIsBlank_(fields.phone)
    || !salesIntakeIsBlank_(fields.install_status)
    || !salesIntakeIsBlank_(fields.location)
    || !salesIntakeIsBlank_(fields.preferred_install_date)
    || !salesIntakeIsBlank_(fields.preferred_install_time)
    || !salesIntakeIsBlank_(fields.machine_count)
    || !salesIntakeIsBlank_(fields.note);
}

function salesIntakeId_(store, prefix, tableName, field) {
  var base = prefix + '-' + new Date(store.now()).getTime();
  var index = 0;
  var id = base;
  while (store.countExact(tableName, field, id) > 0) id = base + (++index);
  return id;
}

function salesIntakePrepare_(store, input, response) {
  var tables = {};
  ['LEADS_MAIN', 'LEAD_DETAILS', 'DEALS', 'INSTALLATIONS', 'LEADS'].forEach(function(name) {
    tables[name] = store.getTable(name);
    salesIntakeValidateTableHeaders_(name, tables[name]);
  });
  if (!store.getSalesOwners || !store.getSalesOwners().length) throw new Error('MISSING_SALES_OWNER_SETTINGS');
  var validation = salesIntakeValidateInput_(response.values, response.sourceColumns, store.getSalesOwners());
  if (!validation.valid) throw new Error(validation.detail);

  var leadRows = tables.LEADS_MAIN.rows.filter(function(row) {
    return salesIntakeNormalizePhone_(row.fields.phone) === validation.phone;
  }).filter(function(row) {
    return !salesIntakeIsBlank_(row.fields.lead_id);
  });
  if (leadRows.length > 1) throw new Error('MULTIPLE_LEADS_FOR_PHONE_' + salesIntakeMaskPhone_(validation.phone));

  var now = store.now();
  var leadId;
  var leadIsNew = leadRows.length === 0;
  if (leadIsNew) leadId = salesIntakeId_(store, 'LEAD', 'LEADS_MAIN', 'lead_id');
  else leadId = salesIntakeText_(leadRows[0].fields.lead_id);
  if (!leadId) throw new Error('AMBIGUOUS_LEAD_ID');

  var dealRows = salesIntakeRowsForField_(tables.DEALS, 'lead_id', leadId);
  var dealIsNew = false;
  var dealReuse = null;
  var dealId = '';
  if (!dealRows.length) {
    dealIsNew = true;
    dealId = salesIntakeId_(store, 'DEAL', 'DEALS', 'deal_id');
  } else if (dealRows.length === 1 && salesIntakeIsSkeletonDeal_(dealRows[0].fields)) {
    dealReuse = dealRows[0];
    dealId = salesIntakeText_(dealRows[0].fields.deal_id);
    if (!dealId) throw new Error('AMBIGUOUS_DEAL_ID');
  } else {
    throw new Error('SUBSTANTIVE_OR_MULTIPLE_DEALS_REQUIRE_REVIEW');
  }

  var installId = '';
  var installIsNew = false;
  if (validation.needInstallation) {
    var installRows = salesIntakeRowsForField_(tables.INSTALLATIONS, 'lead_id', leadId);
    if (installRows.some(function(row) { return salesIntakeInstallationIsSubstantive_(row.fields); })) {
      throw new Error('EXISTING_INSTALLATION_REQUIRES_REVIEW');
    }
    if (installRows.length) throw new Error('EXISTING_INSTALLATION_SKELETON_REQUIRES_REVIEW');
    installIsNew = true;
    installId = salesIntakeId_(store, 'INST', 'INSTALLATIONS', 'install_id');
  }

  var sourceMarker = '[Sales Intake Form]\n'
    + 'Submission Key: ' + response.submissionKey + '\n'
    + 'Submitted By: ' + validation.responderEmail + '\n'
    + 'Form Timestamp: ' + salesIntakeTimestampText_(validation.timestamp);
  var installNote = validation.installationNote ? validation.installationNote + '\n\n' + sourceMarker : sourceMarker;
  return {
    now: now,
    input: validation,
    tables: tables,
    leadId: leadId,
    leadIsNew: leadIsNew,
    dealId: dealId,
    dealIsNew: dealIsNew,
    dealReuse: dealReuse,
    installId: installId,
    installIsNew: installIsNew,
    leadObject: {
      lead_id: leadId,
      customer_name: validation.name,
      phone: validation.phone,
      lead_status: 'Ongoing',
      sales_owner: validation.salesOwner,
      follow_up_note: validation.additionalNote,
      source: 'Manual',
      created_at: now,
      updated_at: now,
    },
    detailObject: {
      lead_id: leadId,
      facebook_leadgen_id: '',
      raw_phone: validation.rawPhone,
      raw_province: '',
      line_user_id: '',
      line_display_name: '',
      original_customer_name: validation.name,
      created_source: 'Manual',
    },
    dealObject: {
      deal_id: dealId,
      lead_id: leadId,
      phone: validation.phone,
      product_model: validation.productModel,
      package_type: validation.packageType,
      full_amount: validation.fullAmount,
      paid_amount: validation.paidAmount,
      open_installation: validation.needInstallation,
      payment_status: validation.paidAmount > 0 ? 'Paid' : 'Unpaid',
      payment_date: validation.paymentDate || '',
      payment_slip_url: validation.paymentSlipUrl,
      payment_slip_save_status: dealReuse ? dealReuse.fields.payment_slip_save_status || '' : '',
    },
    installObject: {
      install_id: installId,
      lead_id: leadId,
      phone: validation.phone,
      save_location: false,
      install_status: 'Pending',
      preferred_install_date: validation.preferredInstallDate,
      preferred_install_time: validation.preferredInstallTime,
      location: validation.installationLocation,
      install_save_status: '',
      machine_count: validation.machineCount,
      install_contact_count: 0,
      note: installNote,
    },
  };
}

function salesIntakeWriteResponse_(store, rowNumber, fields) {
  store.writeResponseMeta(rowNumber, fields);
}

function salesIntakeRollback_(store, actions) {
  var ok = true;
  (actions || []).slice().reverse().forEach(function(action) {
    try {
      if (action.type === 'created') {
        if (!store.clearFieldsIfExact(action.tableName, action.rowNumber, action.idField, action.id, action.fields)) ok = false;
      } else if (action.type === 'reused') {
        if (!store.restoreFieldsIfUnchanged(action.tableName, action.rowNumber, action.before, action.after)) ok = false;
      }
    } catch (error) {
      ok = false;
    }
  });
  return ok;
}

function salesIntakeVerify_(store, tableName, field, id) {
  return store.countExact(tableName, field, id) === 1;
}

function salesIntakeProcessSubmission_(store, rowNumber) {
  var response = store.getResponse(rowNumber);
  if (!response) return { status: 'REJECTED', error: 'INVALID_RESPONSE_ROW' };
  var currentStatus = salesIntakeText_(response.fields.processing_status).toUpperCase();
  var currentKey = salesIntakeText_(response.fields.submission_key);
  var key = currentKey || salesIntakeSubmissionKey_(response.headers, response.values);
  var now = store.now();

  if (currentStatus === 'CREATED' || currentStatus === 'EXISTING_LEAD_USED' || currentStatus === 'DUPLICATE_RESPONSE' || currentStatus === 'REVIEW_REQUIRED' || currentStatus === 'FAILED' || currentStatus === 'ROLLED_BACK') {
    return { status: currentStatus, submissionKey: key, noop: true };
  }
  if (currentStatus === 'PROCESSING') {
    var processedAt = store.parseStoredDate(response.fields.processed_at);
    if (processedAt && now - processedAt < SALES_INTAKE_PROCESSING_TIMEOUT_MS) {
      return { status: 'PROCESSING', submissionKey: key, noop: true };
    }
    salesIntakeWriteResponse_(store, rowNumber, {
      submission_key: key,
      processing_status: 'FAILED',
      error: 'RECOVERY_REQUIRED: stale PROCESSING response; inspect by Submission Key before retry.',
      processed_at: now,
    });
    return { status: 'FAILED', submissionKey: key, error: 'RECOVERY_REQUIRED' };
  }

  var duplicate = store.findResponseByKey(key).filter(function(item) { return item.rowNumber !== rowNumber; });
  if (duplicate.length) {
    salesIntakeWriteResponse_(store, rowNumber, {
      submission_key: key,
      processing_status: 'DUPLICATE_RESPONSE',
      error: 'Duplicate Submission Key; no CRM writes performed.',
      processed_at: now,
    });
    return { status: 'DUPLICATE_RESPONSE', submissionKey: key, noop: true };
  }

  response.submissionKey = key;
  try {
    var missingSourceHeaders = salesIntakeMissingSourceHeaders_(response.headers);
    if (missingSourceHeaders.length) throw new Error('MISSING_FORM_HEADERS:' + missingSourceHeaders.join(','));
    var prepared = salesIntakePrepare_(store, null, response);
    salesIntakeWriteResponse_(store, rowNumber, {
      submission_key: key,
      processing_status: 'PROCESSING',
      lead_resolution: prepared.leadIsNew ? 'NEW' : 'EXISTING',
      lead_id: prepared.leadId,
      deal_id: prepared.dealId,
      install_id: prepared.installId,
      processed_at: now,
      error: '',
    });

    var actions = [];
    try {
      if (prepared.leadIsNew) {
        var leadRow = store.append('LEADS_MAIN', prepared.leadObject);
        actions.push({ type: 'created', tableName: 'LEADS_MAIN', rowNumber: leadRow, idField: 'lead_id', id: prepared.leadId, fields: Object.keys(prepared.leadObject) });
        if (!salesIntakeVerify_(store, 'LEADS_MAIN', 'lead_id', prepared.leadId)) throw new Error('VERIFY_LEADS_MAIN_FAILED');

        var detailRow = store.append('LEAD_DETAILS', prepared.detailObject);
        actions.push({ type: 'created', tableName: 'LEAD_DETAILS', rowNumber: detailRow, idField: 'lead_id', id: prepared.leadId, fields: Object.keys(prepared.detailObject) });
        if (!salesIntakeVerify_(store, 'LEAD_DETAILS', 'lead_id', prepared.leadId)) throw new Error('VERIFY_LEAD_DETAILS_FAILED');

        var leadsRow = store.append('LEADS', { lead_id: prepared.leadId });
        actions.push({ type: 'created', tableName: 'LEADS', rowNumber: leadsRow, idField: 'lead_id', id: prepared.leadId, fields: ['lead_id'] });
        if (!salesIntakeVerify_(store, 'LEADS', 'lead_id', prepared.leadId)) throw new Error('VERIFY_LEADS_FAILED');
      }

      if (prepared.dealIsNew) {
        var dealRow = store.append('DEALS', prepared.dealObject);
        actions.push({ type: 'created', tableName: 'DEALS', rowNumber: dealRow, idField: 'deal_id', id: prepared.dealId, fields: Object.keys(prepared.dealObject) });
        if (!salesIntakeVerify_(store, 'DEALS', 'deal_id', prepared.dealId)) throw new Error('VERIFY_DEALS_FAILED');
      } else {
        var before = {};
        var after = {};
        Object.keys(prepared.dealObject).forEach(function(field) {
          before[field] = prepared.dealReuse.fields[field];
          after[field] = prepared.dealObject[field];
        });
        store.update('DEALS', prepared.dealReuse.rowNumber, prepared.dealObject);
        actions.push({ type: 'reused', tableName: 'DEALS', rowNumber: prepared.dealReuse.rowNumber, before: before, after: after });
        if (!salesIntakeVerify_(store, 'DEALS', 'deal_id', prepared.dealId)) throw new Error('VERIFY_REUSED_DEAL_FAILED');
      }

      if (prepared.installIsNew) {
        var installRow = store.append('INSTALLATIONS', prepared.installObject);
        actions.push({ type: 'created', tableName: 'INSTALLATIONS', rowNumber: installRow, idField: 'install_id', id: prepared.installId, fields: Object.keys(prepared.installObject) });
        if (!salesIntakeVerify_(store, 'INSTALLATIONS', 'install_id', prepared.installId)) throw new Error('VERIFY_INSTALLATIONS_FAILED');
      }

      var finalStatus = prepared.leadIsNew ? 'CREATED' : 'EXISTING_LEAD_USED';
      salesIntakeWriteResponse_(store, rowNumber, {
        processing_status: finalStatus,
        processed_at: store.now(),
        error: '',
      });
      return {
        status: finalStatus,
        submissionKey: key,
        leadId: prepared.leadId,
        dealId: prepared.dealId,
        installId: prepared.installId,
        leadResolution: prepared.leadIsNew ? 'NEW' : 'EXISTING',
      };
    } catch (error) {
      var rolledBack = salesIntakeRollback_(store, actions);
      var status = rolledBack ? 'ROLLED_BACK' : 'FAILED';
      salesIntakeWriteResponse_(store, rowNumber, {
        processing_status: status,
        processed_at: store.now(),
        error: salesIntakeSafeError_(error),
      });
      return { status: status, submissionKey: key, error: salesIntakeSafeError_(error), rolledBack: rolledBack };
    }
  } catch (error) {
    var status = /REVIEW|MULTIPLE|SUBSTANTIVE|AMBIGUOUS|INVALID|REQUIRED|EXCEEDS|MACHINE|CONFLICTING|MISSING_SALES/.test(String(error.message || error)) ? 'REVIEW_REQUIRED' : 'FAILED';
    salesIntakeWriteResponse_(store, rowNumber, {
      submission_key: key,
      processing_status: status,
      processed_at: now,
      error: salesIntakeSafeError_(error),
    });
    return { status: status, submissionKey: key, error: salesIntakeSafeError_(error) };
  }
}

function salesIntakeReadTableFromSheet_(sheet) {
  if (!sheet) return { name: '', headers: [], rows: [] };
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(SALES_INTAKE_RESPONSE_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  var rowCount = Math.max(sheet.getLastRow() - SALES_INTAKE_CRM_DATA_START_ROW + 1, 0);
  var values = rowCount ? sheet.getRange(SALES_INTAKE_CRM_DATA_START_ROW, 1, rowCount, lastColumn).getValues() : [];
  return {
    name: sheet.getName(),
    headers: headers,
    rows: values.map(function(row, index) {
      var fields = {};
      headers.forEach(function(header, column) { fields[salesIntakeKey_(header)] = row[column]; });
      return { rowNumber: SALES_INTAKE_CRM_DATA_START_ROW + index, fields: fields, values: row };
    }),
  };
}

function salesIntakeReadSettingsSalesOwners_(settings) {
  if (!settings) return [];
  var lastColumn = Math.max(settings.getLastColumn(), 1);
  var headers = settings.getRange(SALES_INTAKE_RESPONSE_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  var salesOwnerColumn = salesIntakeFindHeader_(headers, SALES_INTAKE_SETTINGS_SALES_OWNER_HEADERS);
  if (salesOwnerColumn < 0) return [];

  var rowCount = Math.max(settings.getLastRow() - SALES_INTAKE_SETTINGS_DATA_START_ROW + 1, 0);
  if (!rowCount) return [];
  var values = settings.getRange(
    SALES_INTAKE_SETTINGS_DATA_START_ROW,
    salesOwnerColumn + 1,
    rowCount,
    1
  ).getValues();
  var owners = [];
  values.forEach(function(row) {
    var owner = salesIntakeText_(row[0]);
    if (owner && owners.indexOf(owner) === -1) owners.push(owner);
  });
  return owners;
}

function salesIntakeWriteObjectToSheet_(sheet, rowNumber, object) {
  var headers = sheet.getRange(SALES_INTAKE_RESPONSE_HEADER_ROW, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  var columns = salesIntakeBuildHeaderMap_(headers);
  Object.keys(object).forEach(function(field) {
    var column = columns[salesIntakeKey_(field)];
    if (column) sheet.getRange(rowNumber, column).setValue(object[field]);
  });
}

function salesIntakeCreateSheetStore_(ss) {
  function sheet(name) { return ss.getSheetByName(name); }
  function readResponse(rowNumber) {
    var responseSheet = sheet(SALES_INTAKE_RESPONSE_SHEET_NAME);
    if (!responseSheet || rowNumber < SALES_INTAKE_RESPONSE_DATA_START_ROW || rowNumber > responseSheet.getLastRow()) return null;
    var lastColumn = Math.max(responseSheet.getLastColumn(), 1);
    var headers = responseSheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var values = responseSheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
    var sourceColumns = salesIntakeFindSourceColumns_(headers);
    var fields = {};
    headers.forEach(function(header, index) { fields[salesIntakeKey_(header)] = values[index]; });
    return { rowNumber: rowNumber, headers: headers, values: values, sourceColumns: sourceColumns, fields: fields };
  }
  function readTable(name) { return salesIntakeReadTableFromSheet_(sheet(name)); }
  return {
    now: function() { return new Date(); },
    parseStoredDate: function(value) { return salesIntakeParseDate_(value); },
    getResponse: readResponse,
    getTable: readTable,
    writeResponseMeta: function(row, fields) { salesIntakeWriteObjectToSheet_(sheet(SALES_INTAKE_RESPONSE_SHEET_NAME), row, fields); },
    getSalesOwners: function() {
      var settings = sheet('SETTINGS');
      return salesIntakeReadSettingsSalesOwners_(settings);
    },
    append: function(name, object) {
      var target = sheet(name);
      var row = Math.max(target.getLastRow() + 1, SALES_INTAKE_CRM_DATA_START_ROW);
      salesIntakeWriteObjectToSheet_(target, row, object);
      return row;
    },
    update: function(name, row, object) { salesIntakeWriteObjectToSheet_(sheet(name), row, object); },
    countExact: function(name, field, value) { return salesIntakeRowsForField_(readTable(name), field, value).length; },
    clearFieldsIfExact: function(name, row, idField, id, fields) {
      var target = sheet(name);
      var table = readTable(name);
      var item = table.rows.filter(function(candidate) { return candidate.rowNumber === row; })[0];
      if (!item || salesIntakeText_(item.fields[salesIntakeKey_(idField)]) !== salesIntakeText_(id)) return false;
      var object = {}; (fields || []).forEach(function(field) { object[field] = ''; });
      salesIntakeWriteObjectToSheet_(target, row, object); return true;
    },
    restoreFieldsIfUnchanged: function(name, row, before, after) {
      var table = readTable(name);
      var item = table.rows.filter(function(candidate) { return candidate.rowNumber === row; })[0];
      if (!item) return false;
      var safe = true;
      Object.keys(after).forEach(function(field) { if (String(item.fields[salesIntakeKey_(field)] || '') !== String(after[field] || '')) safe = false; });
      if (!safe) return false;
      salesIntakeWriteObjectToSheet_(sheet(name), row, before); return true;
    },
    findResponseByKey: function(key) {
      var responseSheet = sheet(SALES_INTAKE_RESPONSE_SHEET_NAME);
      if (!responseSheet) return [];
      var lastRow = responseSheet.getLastRow();
      var results = [];
      for (var row = SALES_INTAKE_RESPONSE_DATA_START_ROW; row <= lastRow; row++) {
        var response = readResponse(row);
        if (response && salesIntakeText_(response.fields.submission_key) === key) results.push(response);
      }
      return results;
    },
  };
}

function salesIntakeEnsureProcessorColumns_(sheet) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  var missingSource = salesIntakeMissingSourceHeaders_(headers);
  if (missingSource.length) throw new Error('MISSING_FORM_HEADERS:' + missingSource.join(','));
  var missing = SALES_INTAKE_PROCESSOR_HEADERS.filter(function(header) { return salesIntakeFindHeader_(headers, [header]) < 0; });
  if (missing.length) {
    sheet.insertColumnsAfter(lastColumn, missing.length);
    sheet.getRange(1, lastColumn + 1, 1, missing.length).setValues([missing]);
  }
  return { responseSheet: sheet.getName(), addedColumns: missing, headers: headers.concat(missing) };
}

function setupSalesIntakeFormProcessor() {
  var ss = SpreadsheetApp.getActive();
  var responseSheet = ss.getSheetByName(SALES_INTAKE_RESPONSE_SHEET_NAME);
  if (!responseSheet) throw new Error('Missing response sheet: ' + SALES_INTAKE_RESPONSE_SHEET_NAME);
  return salesIntakeEnsureProcessorColumns_(responseSheet);
}

function salesIntakeRequiredHeadersReport_(ss) {
  var responseSheet = ss.getSheetByName(SALES_INTAKE_RESPONSE_SHEET_NAME);
  var report = {
    spreadsheetId: typeof ss.getId === 'function' ? ss.getId() : '',
    responseSheet: Boolean(responseSheet),
    missingFormHeaders: [],
    processorColumns: [],
    sheets: {},
    salesOwners: [],
    trigger: false,
  };
  if (responseSheet) {
    var responseHeaders = responseSheet.getRange(1, 1, 1, Math.max(responseSheet.getLastColumn(), 1)).getValues()[0];
    report.missingFormHeaders = salesIntakeMissingSourceHeaders_(responseHeaders);
    report.processorColumns = SALES_INTAKE_PROCESSOR_HEADERS.map(function(header) {
      return { header: header, present: salesIntakeFindHeader_(responseHeaders, [header]) >= 0 };
    });
  }
  ['LEADS_MAIN', 'LEAD_DETAILS', 'DEALS', 'INSTALLATIONS', 'LEADS'].forEach(function(name) {
    var target = ss.getSheetByName(name);
    report.sheets[name] = target ? { exists: true, missingHeaders: salesIntakeMissingTargetHeaders_(name, target.getRange(1, 1, 1, Math.max(target.getLastColumn(), 1)).getValues()[0]) } : { exists: false, missingHeaders: SALES_INTAKE_TARGET_HEADERS[name] };
  });
  var store = salesIntakeCreateSheetStore_(ss);
  report.salesOwners = store.getSalesOwners();
  if (typeof ScriptApp !== 'undefined' && ScriptApp.getProjectTriggers) {
    report.trigger = ScriptApp.getProjectTriggers().some(function(trigger) { return salesIntakeIsEquivalentTrigger_(trigger); });
  }
  return report;
}

function diagnoseSalesIntakeFormSetup() {
  return salesIntakeRequiredHeadersReport_(SpreadsheetApp.getActive());
}

function salesIntakeIsEquivalentTrigger_(trigger) {
  if (!trigger || trigger.getHandlerFunction() !== 'onSalesIntakeFormSubmit') return false;
  var eventType = typeof trigger.getEventType === 'function' ? trigger.getEventType() : '';
  var source = typeof trigger.getTriggerSource === 'function' ? trigger.getTriggerSource() : '';
  return String(eventType).toUpperCase().indexOf('ON_FORM_SUBMIT') !== -1
    && (!source || String(source).toUpperCase().indexOf('SPREADSHEET') !== -1);
}

function installSalesIntakeFormTrigger() {
  var ss = SpreadsheetApp.getActive();
  if (typeof ss.getId === 'function' && ss.getId() !== SALES_INTAKE_SPREADSHEET_ID) throw new Error('WRONG_SPREADSHEET');
  var triggers = ScriptApp.getProjectTriggers();
  var existing = triggers.some(salesIntakeIsEquivalentTrigger_);
  if (!existing) ScriptApp.newTrigger('onSalesIntakeFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  return {
    handler: 'onSalesIntakeFormSubmit',
    spreadsheetId: typeof ss.getId === 'function' ? ss.getId() : '',
    existing: existing,
    created: !existing,
    triggerCountBefore: triggers.length,
    note: existing ? 'Equivalent spreadsheet form-submit trigger already exists.' : 'Created one spreadsheet form-submit trigger; existing triggers were not modified.',
  };
}

function onSalesIntakeFormSubmit(e) {
  if (!e || !e.range || !e.triggerUid || !e.namedValues || !e.values || typeof e.range.getSheet !== 'function') {
    return { status: 'REJECTED', error: 'INSTALLABLE_FORM_SUBMIT_EVENT_REQUIRED' };
  }
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SALES_INTAKE_RESPONSE_SHEET_NAME || (e.range.getNumRows && e.range.getNumRows() !== 1)) {
    return { status: 'REJECTED', error: 'WRONG_RESPONSE_SHEET' };
  }
  var ss = e.source || SpreadsheetApp.getActive();
  if (typeof ss.getId === 'function' && ss.getId() !== SALES_INTAKE_SPREADSHEET_ID) return { status: 'REJECTED', error: 'WRONG_SPREADSHEET' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(SALES_INTAKE_LOCK_TIMEOUT_MS)) return { status: 'FAILED', error: 'PROCESSING_LOCK_TIMEOUT' };
  try {
    salesIntakeEnsureProcessorColumns_(sheet);
    var store = salesIntakeCreateSheetStore_(ss);
    return salesIntakeProcessSubmission_(store, e.range.getRow());
  } catch (error) {
    return { status: 'FAILED', error: salesIntakeSafeError_(error) };
  } finally {
    lock.releaseLock();
  }
}

/* Pure fixture hooks used only by the focused local test harness. */
function salesIntakeCreateFixtureStore_(fixture) {
  function clone(value) { return JSON.parse(JSON.stringify(value, function(key, item) { return item instanceof Date ? { __date: item.toISOString() } : item; })); }
  function revive(value) { if (value && value.__date) return new Date(value.__date); return value; }
  var data = fixture;
  function table(name) { return data.tables[name]; }
  function response(rowNumber) {
    var item = data.responses.filter(function(candidate) { return candidate.rowNumber === rowNumber; })[0] || null;
    if (!item) return null;
    item.sourceColumns = item.sourceColumns || salesIntakeFindSourceColumns_(item.headers);
    return item;
  }
  function normalizeRows(target) {
    target.rows.forEach(function(row) { row.fields = row.fields || {}; });
  }
  Object.keys(data.tables).forEach(function(name) { normalizeRows(table(name)); });
  return {
    now: function() { return data.now instanceof Date ? data.now : new Date(data.now || '2026-07-28T00:00:00.000Z'); },
    parseStoredDate: function(value) { return salesIntakeParseDate_(value); },
    getResponse: response,
    getTable: table,
    getSalesOwners: function() { return data.salesOwners.slice(); },
    writeResponseMeta: function(rowNumber, fields) {
      var item = response(rowNumber);
      Object.keys(fields).forEach(function(field) { item.fields[salesIntakeKey_(field)] = fields[field]; });
      data.writes.push({ type: 'response', rowNumber: rowNumber, fields: clone(fields) });
    },
    append: function(name, object) {
      if (data.failAt === name) throw new Error('FIXTURE_FAILURE_AFTER_' + name);
      var target = table(name);
      var rowNumber = Math.max(target.nextRow || SALES_INTAKE_CRM_DATA_START_ROW, SALES_INTAKE_CRM_DATA_START_ROW);
      target.nextRow = rowNumber + 1;
      var fields = {}; Object.keys(object).forEach(function(field) { fields[salesIntakeKey_(field)] = revive(clone(object[field])); });
      target.rows.push({ rowNumber: rowNumber, fields: fields });
      data.writes.push({ type: 'append', table: name, rowNumber: rowNumber, fields: clone(fields) });
      return rowNumber;
    },
    update: function(name, rowNumber, object) {
      var item = table(name).rows.filter(function(row) { return row.rowNumber === rowNumber; })[0];
      Object.keys(object).forEach(function(field) { item.fields[salesIntakeKey_(field)] = revive(clone(object[field])); });
      data.writes.push({ type: 'update', table: name, rowNumber: rowNumber, fields: clone(object) });
    },
    countExact: function(name, field, value) { return salesIntakeRowsForField_(table(name), field, value).length; },
    clearFieldsIfExact: function(name, rowNumber, idField, id, fields) {
      var item = table(name).rows.filter(function(row) { return row.rowNumber === rowNumber; })[0];
      if (!item || salesIntakeText_(item.fields[salesIntakeKey_(idField)]) !== salesIntakeText_(id)) return false;
      (fields || []).forEach(function(field) { item.fields[salesIntakeKey_(field)] = ''; });
      data.writes.push({ type: 'rollback', table: name, rowNumber: rowNumber, fields: fields });
      return true;
    },
    restoreFieldsIfUnchanged: function(name, rowNumber, before, after) {
      var item = table(name).rows.filter(function(row) { return row.rowNumber === rowNumber; })[0];
      if (!item) return false;
      var safe = Object.keys(after).every(function(field) { return String(item.fields[salesIntakeKey_(field)] || '') === String(after[field] || ''); });
      if (!safe) return false;
      Object.keys(before).forEach(function(field) { item.fields[salesIntakeKey_(field)] = before[field]; });
      data.writes.push({ type: 'restore', table: name, rowNumber: rowNumber });
      return true;
    },
    findResponseByKey: function(key) { return data.responses.filter(function(item) { return salesIntakeText_(item.fields.submission_key) === key; }); },
  };
}
