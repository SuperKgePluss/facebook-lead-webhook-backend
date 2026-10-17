# CRM4 Audio Release 2

## Current local design

- `scripts/audio-index-once.js` is an isolated, one-shot scan. `scripts/audio-index-worker.js` is a prepared 15–30 minute loop (20 minutes by default). The existing Web process can host that loop only when `AUDIO_WORKER_ENABLED=true`; it is disabled unless explicitly configured. The Dashboard refresh route never starts a scan, and the existing Facebook Cron is unchanged.
- Drive access uses the `drive.metadata.readonly` scope. The worker lists the selected folder tree and Drive change feed; it never downloads or plays audio.
- The Drive change token, folder tree, file-ID index, and aggregate scan state are saved in one atomic JSON snapshot. The configured path must be on durable private storage and inside `AUDIO_PERSISTENT_DIR`; enabled Web startup fails closed when the index path is outside that mount. Keeping the scheduler and Dashboard reader on the same Web service lets both use the same JSON state. A lock file prevents overlapping runs; a leftover lock after a process crash needs operator review.
- The worker reads canonical Lead IDs from `LEADS`, then reads only the `LEADS_MAIN` header row, Lead ID column, and columns whose normalized headers contain `phone`. It intersects by stable Lead ID before phone matching, fetches selected columns as formatted strings to preserve leading zeroes, and does not read the rest of either Lead row. Its dedicated client uses the `spreadsheets.readonly` OAuth scope.
- Pagination, total pages, and file count are bounded. The worker writes a new checkpoint only after the listing and CRM Lead read both complete.
- Drive file ID is the canonical identity. Phone collisions fail closed. Matching is disabled by default until the filename pattern is confirmed against source metadata. Recording times stay unverified until confirmed separately.
- Dashboard counts, date/time, and links are returned only in the existing authenticated operational Lead projection. Dates and links are off unless their confirmation flags are enabled. Links use the regular Drive file URL and rely on the intended Dashboard users having Drive access.
- No CRM4 source tab is written. The state file contains derived Lead/file identities, filename metadata for future rematching, aggregate counters, and timestamps; keep it private and outside the static site directory.

## Configuration names

The worker uses the same dedicated CRM4 Dashboard Reader binding:

- `CRM4_GOOGLE_CLIENT_EMAIL`
- `CRM4_GOOGLE_PRIVATE_KEY`
- `CRM4_SPREADSHEET_ID`

The worker additionally expects:

- `AUDIO_GOOGLE_CLIENT_EMAIL`
- `AUDIO_GOOGLE_PRIVATE_KEY`
- `AUDIO_DRIVE_FOLDER_ID`
- `AUDIO_DRIVE_ID` (optional; set only when the approved folder is in a Shared Drive so listing and change tokens stay drive-scoped)
- `AUDIO_WORKER_ENABLED` (must be exactly `true` to start recurring scans; keep unset/false until explicit Production approval)
- `AUDIO_PERSISTENT_DIR` (the mounted private disk directory)
- `AUDIO_INDEX_PATH`
- `AUDIO_SCAN_INTERVAL_MINUTES` (15–30; default 20)
- `AUDIO_FILENAME_PATTERN_CONFIRMED`
- `AUDIO_RECORDING_TIMESTAMP_CONFIRMED`

The Dashboard reads `AUDIO_INDEX_PATH` and has a separate flag:

- `AUDIO_DASHBOARD_LINKS_AUTHORIZED`

Only names are recorded here. Do not place credential values in source control. Keep both confirmation flags false until the corresponding source evidence and client approval are recorded. Keep links disabled until intended user access has been verified.

## Release and operations gate

Before any real scan, verify the exact folder link/ID, service-account identity, effective metadata read/list access, API access, listing completeness, actual filename/date interpretation, and canonical CRM Lead/phone-field coverage. Report only aggregates. Treat MIME/extension discrepancies as unverified media; do not download or serve files to resolve them without separate approval. A 15–30 minute schedule is a target for review, not an enabled setting; first confirm a durable private volume, host compatibility, cost, alerting, and rollback. Do not attach it to the Facebook Cron or trigger it from Dashboard refresh.

After a verified initial index, confirm that the intended Dashboard users can open the Drive links without making files public. The least incremental-cost Render candidate is a 1 GB persistent disk mounted on the existing single-instance Web service, with the JSON index and disabled-by-default in-process worker on that same service. Render lists disk storage at $0.25/GB/month; the current Web compute plan would remain unchanged. A disk cannot attach to a Cron Job, is private to one service instance, prevents scaling to multiple instances, and causes a brief interruption on deploy. Verify that tradeoff with the owner before adding the disk. A separate Background Worker with its own disk cannot share the JSON file with the Web API; it would require a shared datastore or an API handoff. Confirm actual workspace billing, service plan, monitoring, and rollback before any infrastructure change. Then request one consolidated Production release approval for Web/API, Static, and the selected storage/scheduler approach. Roll back by disabling the worker and Dashboard gates, retaining a private copy of the last valid index, and restoring the previous Web/Static revisions.
