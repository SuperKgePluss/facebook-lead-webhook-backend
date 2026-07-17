const AUDIO_METADATA_AUDIT_SHEET_NAME = 'AUDIO_METADATA_AUDIT';
const AUDIO_METADATA_AUDIT_LIMIT = 50;
const AUDIO_METADATA_AUDIT_HEADERS = [
  'scanned_at',
  'folder_path',
  'file_name',
  'file_id',
  'mime_type',
  'drive_url',
  'date_created',
  'last_updated',
  'size_bytes',
  'description',
  'owner_email_or_name_if_available',
  'parsed_phone_from_filename',
  'parsed_date_from_filename',
  'parsed_time_from_filename',
  'possible_phone_from_metadata',
  'possible_date_from_metadata',
  'metadata_raw_summary',
  'audit_notes',
];

function auditAudioMetadata() {
  const startedAt = new Date();
  const result = {
    files_checked: 0,
    audio_files_found: 0,
    phone_found_in_filename: 0,
    phone_found_in_metadata: 0,
    date_found_in_metadata: 0,
    metadata_fields_available: {},
    inaccessible_files: 0,
    inaccessible_folders: 0,
    timeout_or_cursor_info: 'limited_to_first_' + AUDIO_METADATA_AUDIT_LIMIT + '_audio_files',
  };
  const rows = [];
  const rootFolderId = getAudioRootFolderId_();

  if (!rootFolderId) {
    writeAudioMetadataAuditRows_(rows);
    SpreadsheetApp.getActive().toast('Audio metadata audit failed: missing AUDIO_ROOT_FOLDER_ID', 'Audio Metadata Audit', 8);
    return Object.assign(result, { error: 'missing_audio_root_folder_id' });
  }

  let rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(rootFolderId);
  } catch (err) {
    writeAudioMetadataAuditRows_(rows);
    SpreadsheetApp.getActive().toast('Audio metadata audit failed: cannot open audio folder', 'Audio Metadata Audit', 8);
    return Object.assign(result, {
      error: 'folder_access',
      message: err.message,
    });
  }

  scanAudioMetadataFolder_(rootFolder, rootFolder.getName(), rows, result, startedAt);
  writeAudioMetadataAuditRows_(rows);

  if (!result.phone_found_in_filename && !result.phone_found_in_metadata) {
    result.audit_conclusion = 'No phone number found in filename or accessible Drive metadata sample; filename/source-side fix is still required.';
  } else if (!result.phone_found_in_metadata) {
    result.audit_conclusion = 'Phone was found only in filenames, not accessible Drive metadata sample.';
  } else {
    result.audit_conclusion = 'Potential phone data found in accessible Drive metadata sample; review AUDIO_METADATA_AUDIT.';
  }

  Logger.log('Audio metadata audit summary ' + JSON.stringify(result));
  SpreadsheetApp.getActive().toast(
    'Checked ' + result.files_checked + ' audio files. Metadata phones: ' + result.phone_found_in_metadata,
    'Audio Metadata Audit',
    8
  );
  return result;
}

function scanAudioMetadataFolder_(folder, folderPath, rows, result, scannedAt) {
  if (rows.length >= AUDIO_METADATA_AUDIT_LIMIT) return;

  const folderInfo = getSafeAudioMetadataFolderInfo_(folder);
  const currentPath = folderPath || folderInfo.name;

  let files;
  try {
    files = folder.getFiles();
  } catch (err) {
    result.inaccessible_folders++;
    Logger.log('Audio metadata audit inaccessible folder files path=' + currentPath + ' id=' + folderInfo.id + ' error=' + err.message);
    return;
  }

  while (files.hasNext() && rows.length < AUDIO_METADATA_AUDIT_LIMIT) {
    let file;
    try {
      file = files.next();
    } catch (err) {
      result.inaccessible_files++;
      Logger.log('Audio metadata audit inaccessible file iterator path=' + currentPath + ' error=' + err.message);
      continue;
    }

    const fileName = getSafeAudioMetadataValue_(function () { return file.getName(); });
    if (!AUDIO_FILE_EXTENSION_PATTERN.test(fileName)) continue;

    result.audio_files_found++;
    result.files_checked++;
    const auditRow = buildAudioMetadataAuditRow_(file, currentPath, scannedAt, result);
    if (auditRow.parsed_phone_from_filename) result.phone_found_in_filename++;
    if (auditRow.possible_phone_from_metadata) result.phone_found_in_metadata++;
    if (auditRow.possible_date_from_metadata) result.date_found_in_metadata++;
    rows.push(AUDIO_METADATA_AUDIT_HEADERS.map(function (header) { return auditRow[header] || ''; }));
  }

  if (rows.length >= AUDIO_METADATA_AUDIT_LIMIT) return;

  let subfolders;
  try {
    subfolders = folder.getFolders();
  } catch (err) {
    result.inaccessible_folders++;
    Logger.log('Audio metadata audit inaccessible subfolder list path=' + currentPath + ' id=' + folderInfo.id + ' error=' + err.message);
    return;
  }

  while (subfolders.hasNext() && rows.length < AUDIO_METADATA_AUDIT_LIMIT) {
    let subfolder;
    try {
      subfolder = subfolders.next();
    } catch (err) {
      result.inaccessible_folders++;
      Logger.log('Audio metadata audit inaccessible subfolder under path=' + currentPath + ' error=' + err.message);
      continue;
    }

    const subfolderInfo = getSafeAudioMetadataFolderInfo_(subfolder);
    scanAudioMetadataFolder_(subfolder, currentPath + '/' + subfolderInfo.name, rows, result, scannedAt);
  }
}

function buildAudioMetadataAuditRow_(file, folderPath, scannedAt, result) {
  const fileName = getSafeAudioMetadataValue_(function () { return file.getName(); });
  const fileId = getSafeAudioMetadataValue_(function () { return file.getId(); });
  const mimeType = getSafeAudioMetadataValue_(function () { return file.getMimeType(); });
  const driveUrl = getSafeAudioMetadataValue_(function () { return file.getUrl(); });
  const dateCreated = getSafeAudioMetadataValue_(function () { return file.getDateCreated(); });
  const lastUpdated = getSafeAudioMetadataValue_(function () { return file.getLastUpdated(); });
  const sizeBytes = getSafeAudioMetadataValue_(function () { return file.getSize(); });
  const description = getSafeAudioMetadataValue_(function () { return file.getDescription(); });
  const owner = getSafeAudioMetadataOwner_(file);
  const advancedMetadata = getAdvancedDriveFileMetadataIfAvailable_(fileId);
  const metadataStrings = buildAudioMetadataStringBag_({
    file_name: fileName,
    mime_type: mimeType,
    description: description,
    owner: owner,
    advanced: advancedMetadata,
  });
  const parsed = parseAudioMetadataFileName_(fileName);
  const metadataPhone = detectThaiPhoneInText_(metadataStrings.metadataOnly);
  const metadataDate = detectDateInText_(metadataStrings.all);
  const notes = [];

  markAudioMetadataFieldsAvailable_(result, {
    driveapp_name: fileName,
    driveapp_mime_type: mimeType,
    driveapp_date_created: dateCreated,
    driveapp_last_updated: lastUpdated,
    driveapp_description: description,
    driveapp_owner: owner,
    advanced_drive: advancedMetadata.available ? 'available' : '',
    advanced_original_filename: advancedMetadata.originalFilename,
    advanced_properties: advancedMetadata.propertiesSummary,
    advanced_app_properties: advancedMetadata.appPropertiesSummary,
  });

  if (!metadataPhone) notes.push('no_phone_found_in_accessible_metadata');
  if (!advancedMetadata.available) notes.push('advanced_drive_service_unavailable_or_not_enabled');

  return {
    scanned_at: scannedAt,
    folder_path: folderPath,
    file_name: fileName,
    file_id: fileId,
    mime_type: mimeType,
    drive_url: driveUrl,
    date_created: dateCreated,
    last_updated: lastUpdated,
    size_bytes: sizeBytes,
    description: description,
    owner_email_or_name_if_available: owner,
    parsed_phone_from_filename: parsed.phone,
    parsed_date_from_filename: parsed.date,
    parsed_time_from_filename: parsed.time,
    possible_phone_from_metadata: metadataPhone,
    possible_date_from_metadata: metadataDate,
    metadata_raw_summary: metadataStrings.summary,
    audit_notes: notes.join('; '),
  };
}

function writeAudioMetadataAuditRows_(rows) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(AUDIO_METADATA_AUDIT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(AUDIO_METADATA_AUDIT_SHEET_NAME);

  sheet.clearContents();
  if (sheet.getMaxColumns() < AUDIO_METADATA_AUDIT_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), AUDIO_METADATA_AUDIT_HEADERS.length - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, AUDIO_METADATA_AUDIT_HEADERS.length).setValues([AUDIO_METADATA_AUDIT_HEADERS]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, AUDIO_METADATA_AUDIT_HEADERS.length).setValues(rows);
  }
  sheet.autoResizeColumns(1, AUDIO_METADATA_AUDIT_HEADERS.length);
}

function parseAudioMetadataFileName_(fileName) {
  const result = {
    phone: detectThaiPhoneInText_(fileName),
    date: '',
    time: '',
  };
  const parsed = typeof parseAudioFileName_ === 'function' ? parseAudioFileName_(fileName) : null;
  if (parsed) {
    result.phone = normalizeAudioPhoneKey_(parsed.key) || result.phone;
    result.date = String(parsed.parsedTimestamp || '').slice(0, 10);
    result.time = String(parsed.parsedTimestamp || '').slice(11, 16);
    return result;
  }

  const dotDate = String(fileName || '').match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/);
  if (dotDate) {
    result.date = dotDate[1] + '/' + dotDate[2] + '/' + dotDate[3];
  }
  const timeMatch = String(fileName || '').match(/\b([01]?\d|2[0-3])[:._-]([0-5]\d)\b/);
  if (timeMatch) {
    result.time = timeMatch[1] + ':' + timeMatch[2];
  }
  return result;
}

function getAdvancedDriveFileMetadataIfAvailable_(fileId) {
  const result = {
    available: false,
    originalFilename: '',
    propertiesSummary: '',
    appPropertiesSummary: '',
    rawSummary: '',
  };
  if (!fileId || typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.get !== 'function') return result;

  try {
    const metadata = Drive.Files.get(fileId, {
      fields: 'name,mimeType,createdTime,modifiedTime,originalFilename,description,properties,appProperties,owners,parents,webViewLink',
    });
    result.available = true;
    result.originalFilename = metadata.originalFilename || '';
    result.propertiesSummary = summarizeObjectValues_(metadata.properties);
    result.appPropertiesSummary = summarizeObjectValues_(metadata.appProperties);
    result.rawSummary = safeJsonSummary_(metadata, 1500);
  } catch (err) {
    result.rawSummary = 'advanced_drive_error=' + err.message;
  }
  return result;
}

function buildAudioMetadataStringBag_(metadata) {
  const metadataOnlyParts = [
    metadata.description,
    metadata.owner,
    metadata.advanced.originalFilename,
    metadata.advanced.propertiesSummary,
    metadata.advanced.appPropertiesSummary,
    metadata.advanced.rawSummary,
  ].filter(Boolean);
  const allParts = [
    metadata.file_name,
    metadata.mime_type,
  ].concat(metadataOnlyParts).filter(Boolean);

  return {
    metadataOnly: metadataOnlyParts.join(' | '),
    all: allParts.join(' | '),
    summary: allParts.join(' | ').slice(0, 1500),
  };
}

function detectThaiPhoneInText_(value) {
  const raw = String(value || '');
  const candidates = raw.match(/(?:\+?66|0)[\d\s().-]{8,16}/g) || [];
  for (let i = 0; i < candidates.length; i++) {
    const normalized = normalizeAudioPhoneKey_(candidates[i]);
    if (/^0\d{9}$/.test(normalized)) return normalized;
  }
  return '';
}

function detectDateInText_(value) {
  const raw = String(value || '');
  const isoDate = raw.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoDate) return isoDate[0];
  const looseDate = raw.match(/\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/);
  return looseDate ? looseDate[0] : '';
}

function getSafeAudioMetadataValue_(getter) {
  try {
    const value = getter();
    return value === null || value === undefined ? '' : value;
  } catch (err) {
    return '';
  }
}

function getSafeAudioMetadataOwner_(file) {
  try {
    const owner = file.getOwner();
    if (!owner) return '';
    if (typeof owner.getEmail === 'function') {
      const email = owner.getEmail();
      if (email) return email;
    }
    if (typeof owner.getName === 'function') {
      return owner.getName() || '';
    }
  } catch (err) {
    return '';
  }
  return '';
}

function getSafeAudioMetadataFolderInfo_(folder) {
  return {
    name: getSafeAudioMetadataValue_(function () { return folder.getName(); }) || 'UNKNOWN',
    id: getSafeAudioMetadataValue_(function () { return folder.getId(); }) || 'UNKNOWN',
  };
}

function markAudioMetadataFieldsAvailable_(result, fields) {
  Object.keys(fields).forEach(function (field) {
    if (String(fields[field] || '').trim()) {
      result.metadata_fields_available[field] = true;
    }
  });
}

function summarizeObjectValues_(object) {
  if (!object) return '';
  try {
    return Object.keys(object).map(function (key) {
      return key + '=' + object[key];
    }).join('; ');
  } catch (err) {
    return '';
  }
}

function safeJsonSummary_(object, limit) {
  try {
    return JSON.stringify(object).slice(0, limit || 1500);
  } catch (err) {
    return '';
  }
}
function getAudioRootFolderId_() {
  let configured = '';
  try {
    if (typeof AUDIO_ROOT_FOLDER_ID !== 'undefined') configured = String(AUDIO_ROOT_FOLDER_ID || '').trim();
  } catch (err) {
    configured = '';
  }
  if (!configured && typeof PropertiesService !== 'undefined') {
    configured = String(PropertiesService.getScriptProperties().getProperty('AUDIO_ROOT_FOLDER_ID') || '').trim();
  }
  if (!configured || /^((PASTE|PUT)_|CHANGE_ME)/i.test(configured)) {
    throw new Error('AUDIO_ROOT_FOLDER_ID is not configured for the isolated audit tool.');
  }
  return configured;
}
