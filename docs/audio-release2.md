# CRM4 Audio Release 2

## Current local design

- `scripts/audio-index-once.js` is an isolated, one-shot scan. `scripts/audio-index-worker.js` is a prepared 15–30 minute loop (20 minutes by default). The Dashboard refresh route does not call it, and this change does not register a hosted scheduler or change the existing Facebook Cron.
- Drive access uses the `drive.metadata.readonly` scope. The worker lists the selected folder tree and Drive change feed; it never downloads or plays audio.
- The Drive change token, folder tree, file-ID index, and aggregate scan state are saved in one atomic JSON snapshot. The configured path must be on durable private storage. A lock file prevents overlapping runs; a leftover lock after a process crash needs operator review.
- The worker reads only the LEADS_MAIN header row, Lead ID column, and columns whose normalized headers contain `phone`; it fetches those columns as formatted strings to preserve leading zeroes. It does not read the rest of the Lead row.
- Pagination, total pages, and file count are bounded. The worker writes a new checkpoint only after the listing and CRM Lead read both complete.
- Drive file ID is the canonical identity. Phone collisions fail closed. Matching is disabled by default until the filename pattern is confirmed against source metadata. Recording times stay unverified until confirmed separately.
- Dashboard counts, date/time, and links are returned only in the existing authenticated operational Lead projection. Dates and links are off unless their confirmation flags are enabled. Links use the regular Drive file URL and rely on the intended Dashboard users having Drive access.
- No CRM4 source tab is written. The state file contains derived Lead/file identities, filename metadata for future rematching, aggregate counters, and timestamps; keep it private and outside the static site directory.

## Configuration names

The worker expects the existing read-only Sheets configuration plus:

- `AUDIO_GOOGLE_CLIENT_EMAIL`
- `AUDIO_GOOGLE_PRIVATE_KEY`
- `AUDIO_DRIVE_FOLDER_ID`
- `AUDIO_DRIVE_ID` (optional; set only when the approved folder is in a Shared Drive so listing and change tokens stay drive-scoped)
- `AUDIO_INDEX_PATH`
- `AUDIO_FILENAME_PATTERN_CONFIRMED`
- `AUDIO_RECORDING_TIMESTAMP_CONFIRMED`

The Dashboard reads `AUDIO_INDEX_PATH` and has a separate flag:

- `AUDIO_DASHBOARD_LINKS_AUTHORIZED`

Only names are recorded here. Do not place credential values in source control. Keep both confirmation flags false until the corresponding source evidence and client approval are recorded. Keep links disabled until intended user access has been verified.

## Release and operations gate

Before any real scan, verify the exact folder link/ID, service-account identity, applied Viewer share, API access, listing completeness, actual filename/date interpretation, and CRM Lead phone-field coverage. Report only aggregates. The worker should initially run as a manual, isolated job. A 15–30 minute schedule is a target for review, not an enabled setting; first confirm a durable private volume, host compatibility, cost, alerting, and rollback. Do not attach it to the Facebook Cron or trigger it from Dashboard refresh.

After a verified initial index, confirm that the intended Dashboard users can open the Drive links without making files public. The JSON state requires durable storage. On Render, a Cron Job cannot attach a persistent disk; use a background worker with a disk or approve a separate durable data store before selecting a Cron Job design. Confirm the exact service plan and storage charge before creating a paid service. Then request one consolidated Production release approval for the minimum Web/API/Static/worker targets. Roll back by disabling the Dashboard gates and restoring the previous Web/Static revisions; retain a copy of the last valid private index snapshot before any worker-state format change.
