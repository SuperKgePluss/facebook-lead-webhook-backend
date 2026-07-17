# Isolated Apps Script Admin Tools

These files are intentionally outside the production `apps-script/` clasp deploy root. They are manual admin and diagnostic tools, not production runtime source, and must not be introduced into Production automatically.

## AudioMetadataAudit.gs

Dependencies: the production audio helpers `getAudioRootFolderId_`, `parseAudioFileName_`, `normalizeAudioPhoneKey_`, and `AUDIO_FILE_EXTENSION_PATTERN`; Drive access; optional Advanced Drive service.

Write side effects: creates or updates `AUDIO_METADATA_AUDIT`, clears its prior contents, writes sampled Drive metadata, expands columns, and resizes columns. It can materialize file identifiers, URLs, ownership details, and accessible metadata into a Sheet.

## Crm2MatchAudit.gs

Dependencies: production header/normalization helpers, LEADS view helpers, and the expected CRM import, LEADS, LEADS_MAIN, and ACTIVITY_LOG sheets.

Write side effects: creates, clears, or appends `CRM2_MATCH_AUDIT` and `LEGACY_NOTE_MATCH_AUDIT`; changes filters/frozen rows; writes Script Properties for cursors; and may set or clear font colors and notes in `LEADS`.

Before using either tool against real data, create a backup and obtain explicit approval for the target spreadsheet, scope, and expected write effects. Do not deploy these files through the production clasp project.

## LeadsMemoHistoryBackfill.gs

Entry functions:

- `backfillLeadsMemoHistoryFromActivityLogDryRun()` — read-only plan and sample output.
- `backfillLeadsMemoHistoryFromActivityLog(true)` — apply only after explicit approval; other arguments refuse to write.

Dependencies: production header/normalization helpers, LEADS view memo helpers, date/audio parsing helpers, and the `LEADS` and `ACTIVITY_LOG` sheets. It is not standalone unless those dependencies are intentionally supplied.

Sheets read: `ACTIVITY_LOG` and `LEADS`. Apply writes only memo/history fields through existing LEADS view helpers and may update existing memo columns.

Before apply, create a backup/export, review the dry-run result, and obtain explicit approval for the target spreadsheet and write scope. This file is outside the production clasp root, is not exposed in the production menu, and must not run as part of normal synchronization.
