// Shared Google Drive evidence file matching for audio, payment, and location files.
const EVIDENCE_DEFAULT_MAX_FOLDERS_SCANNED = 50;
const EVIDENCE_DEFAULT_MAX_FILES_SCANNED = 500;

function findLatestEvidenceFileByLeadId_(rootFolderId, leadId, options) {
  const config = options || {};
  const targetLeadId = String(leadId || '').trim();
  const maxFolders = config.maxFolders || EVIDENCE_DEFAULT_MAX_FOLDERS_SCANNED;
  const maxFiles = config.maxFiles || EVIDENCE_DEFAULT_MAX_FILES_SCANNED;
  const evidenceType = config.evidenceType || 'evidence';
  const allowedMimeTypes = config.allowedMimeTypes || null;
  const allowedExtensionPattern = config.allowedExtensionPattern || null;

  const result = {
    file: null,
    fileUrl: '',
    fileName: '',
    parsedTimestamp: '',
    matchCount: 0,
    duplicateTimestampCount: 0,
    chosenReason: '',
    foldersScanned: 0,
    filesScanned: 0,
    folderLimitExceeded: false,
    fileLimitExceeded: false,
    errorReason: '',
  };

  if (!targetLeadId) {
    result.errorReason = 'missing_lead_id';
    Logger.log('Evidence search skipped: missing Lead ID for ' + evidenceType);
    return result;
  }

  if (!rootFolderId || String(rootFolderId).indexOf('PASTE_') === 0 || String(rootFolderId).indexOf('PUT_') === 0) {
    result.errorReason = 'missing_root_folder';
    Logger.log('Evidence search skipped: root folder is not configured for ' + evidenceType);
    return result;
  }

  let rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(rootFolderId);
  } catch (err) {
    result.errorReason = 'folder_access';
    Logger.log('Evidence search skipped: cannot open folder for ' + evidenceType + '. ' + err.message);
    return result;
  }

  const matcher = new RegExp('^' + escapeRegExp_(targetLeadId) + '_(\\d{8})_(\\d{2})_(\\d{2})(?:\\..+)?$', 'i');
  const scanState = {
    foldersScanned: 0,
    filesScanned: 0,
    folderLimitExceeded: false,
    fileLimitExceeded: false,
  };

  const matches = findEvidenceMatchesInFolder_(
    rootFolder,
    matcher,
    allowedMimeTypes,
    allowedExtensionPattern,
    scanState,
    maxFolders,
    maxFiles,
    evidenceType
  );

  result.foldersScanned = scanState.foldersScanned;
  result.filesScanned = scanState.filesScanned;
  result.folderLimitExceeded = scanState.folderLimitExceeded;
  result.fileLimitExceeded = scanState.fileLimitExceeded;
  result.matchCount = matches.length;

  Logger.log('Evidence scan complete type=' + evidenceType + ' lead_id=' + targetLeadId + ' folders=' + result.foldersScanned + ' files=' + result.filesScanned + ' matches=' + result.matchCount);
  if (result.folderLimitExceeded) Logger.log('Evidence scan stopped: folder limit exceeded (' + maxFolders + ') for ' + evidenceType);
  if (result.fileLimitExceeded) Logger.log('Evidence scan stopped: file limit exceeded (' + maxFiles + ') for ' + evidenceType);

  if (!matches.length) {
    result.errorReason = 'not_found';
    Logger.log('Evidence file not found for ' + evidenceType + '. Expected format: ' + targetLeadId + '_YYYYMMDD_HH_MM');
    return result;
  }

  matches.sort((a, b) => {
    if (a.timestampKey !== b.timestampKey) return a.timestampKey < b.timestampKey ? 1 : -1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    const aStable = a.file.getId() + '|' + a.fileName;
    const bStable = b.file.getId() + '|' + b.fileName;
    return aStable.localeCompare(bStable);
  });

  const best = matches[0];
  result.file = best.file;
  result.fileUrl = best.file.getUrl();
  result.fileName = best.fileName;
  result.parsedTimestamp = best.parsedTimestamp;
  result.duplicateTimestampCount = matches.filter(match => match.timestampKey === best.timestampKey).length - 1;
  result.chosenReason = result.duplicateTimestampCount > 0
    ? 'latest_filename_timestamp_then_updated_time_then_file_id'
    : 'latest_filename_timestamp';

  Logger.log('Evidence selected type=' + evidenceType + ' file=' + result.fileName + ' timestamp=' + result.parsedTimestamp + ' match_count=' + result.matchCount + ' duplicate_timestamp_count=' + result.duplicateTimestampCount + ' chosen_reason=' + result.chosenReason);
  return result;
}

function findEvidenceMatchesInFolder_(folder, matcher, allowedMimeTypes, allowedExtensionPattern, scanState, maxFolders, maxFiles, evidenceType) {
  const matches = [];

  if (scanState.foldersScanned >= maxFolders) {
    scanState.folderLimitExceeded = true;
    return matches;
  }

  scanState.foldersScanned++;
  Logger.log('Evidence scanning folder type=' + evidenceType + ' folder=' + folder.getName() + ' / ' + folder.getId());

  const files = folder.getFiles();
  while (files.hasNext()) {
    if (scanState.filesScanned >= maxFiles) {
      scanState.fileLimitExceeded = true;
      break;
    }

    const file = files.next();
    scanState.filesScanned++;
    const fileName = String(file.getName() || '');
    const match = fileName.match(matcher);
    Logger.log('Evidence candidate type=' + evidenceType + ' file=' + fileName);

    if (!match) continue;
    if (allowedMimeTypes && !allowedMimeTypes[file.getMimeType()]) {
      Logger.log('Evidence candidate rejected by mime type=' + file.getMimeType() + ' file=' + fileName);
      continue;
    }
    if (allowedExtensionPattern && !allowedExtensionPattern.test(fileName)) {
      Logger.log('Evidence candidate rejected by extension file=' + fileName);
      continue;
    }

    matches.push({
      file: file,
      fileName: fileName,
      timestampKey: match[1] + match[2] + match[3],
      parsedTimestamp: formatEvidenceParsedTimestamp_(match[1], match[2], match[3]),
      updatedAt: file.getLastUpdated().getTime(),
    });
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    if (scanState.foldersScanned >= maxFolders || scanState.filesScanned >= maxFiles) {
      scanState.folderLimitExceeded = scanState.foldersScanned >= maxFolders;
      scanState.fileLimitExceeded = scanState.filesScanned >= maxFiles;
      break;
    }

    matches.push.apply(matches, findEvidenceMatchesInFolder_(
      subfolders.next(),
      matcher,
      allowedMimeTypes,
      allowedExtensionPattern,
      scanState,
      maxFolders,
      maxFiles,
      evidenceType
    ));
  }

  return matches;
}

function formatEvidenceParsedTimestamp_(yyyymmdd, hour, minute) {
  return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8) + ' ' + hour + ':' + minute;
}

function escapeRegExp_(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
