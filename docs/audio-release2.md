# CRM4 Audio Release 2

## Diskless runtime

- The existing Web service may host the prepared Audio scheduler only when `AUDIO_WORKER_ENABLED=true`; it remains disabled unless explicitly configured and approved. The Dashboard refresh route reads the process-local snapshot and never starts a Drive scan. The existing Facebook Cron is unchanged.
- Each scheduled pass builds a bounded full Drive metadata snapshot (page size at most 1,000, at most 100 pages and 10,000 listed items/candidates), including nested folders. File ID is the stable deduplication key. A complete snapshot replaces the previous snapshot only after pagination and CRM reads both succeed.
- The only index is in process memory. There is no JSON checkpoint, lock file, persistent disk, or filesystem dependency. After restart the index is unavailable until a complete rebuild succeeds. An incomplete or failed scan invalidates the published snapshot, so stale/partial data and false zero counts are not shown.
- Drive access uses `drive.metadata.readonly`; no audio content is downloaded or played. The scan is serial and defaults to 30 minutes, with an allowed interval of 15–30 minutes. A single instance is required; horizontal replicas would each hold different memory snapshots and are unsupported.
- The worker reads canonical Lead IDs from `LEADS`, then reads only `LEADS_MAIN` header, Lead ID, and phone columns. It intersects by stable Lead ID before matching phone identity. Phone collisions fail closed. The dedicated Sheets client uses `spreadsheets.readonly`.
- Matching remains disabled unless the filename pattern is confirmed. Recording times require separate confirmation, and Drive links remain hidden unless intended Dashboard user access is confirmed. The `.m4a`/Drive MIME discrepancy and recording-time interpretation are unresolved, so the existing 67 candidates remain inactive.
- The Dashboard returns audio only through its authenticated operational Lead projection. No CRM4 source tab is written, and Facebook/LINE ingestion, CRMV3, Apps Script and existing Cron are out of scope.

## Configuration names

Dashboard Reader / CRM4 Sheets identity:

- `CRM4_GOOGLE_CLIENT_EMAIL`
- `CRM4_GOOGLE_PRIVATE_KEY`
- `CRM4_SPREADSHEET_ID`

Audio Worker / Drive metadata identity:

- `AUDIO_GOOGLE_CLIENT_EMAIL`
- `AUDIO_GOOGLE_PRIVATE_KEY`
- `AUDIO_DRIVE_FOLDER_ID`
- `AUDIO_DRIVE_ID` (optional; omit for the approved My Drive folder)
- `AUDIO_WORKER_ENABLED` (must be exactly `true`; keep disabled until the consolidated Production approval)
- `AUDIO_SCAN_INTERVAL_MINUTES` (15–30; default 30)
- `AUDIO_FILENAME_PATTERN_CONFIRMED`
- `AUDIO_RECORDING_TIMESTAMP_CONFIRMED`
- `AUDIO_DASHBOARD_LINKS_AUTHORIZED`

Only configuration names belong in source control. Never copy credential values into source, logs, reports or artifacts. Keep all confirmation flags disabled until supported by evidence and owner approval.

## Request and cost estimate

For the observed one-folder, 237-item source, page size 1,000 requires one Drive `files.list` request per scan. The read-only Lead identity provider uses two Sheets header reads plus one batch read: three Sheets requests per scan. At a 30-minute cadence, that is approximately 48 Drive metadata calls/day (4,800 quota units/day at Google's published 100 units per list; 1,440 calls or 144,000 units per 30-day month) and 144 Sheets reads/day (4,320/month). The Sheets API currently documents 300 read requests/project/minute and 60/user/project/minute; the Drive API currently documents 1,000,000 quota units/project/minute and 325,000/user/project/minute. Nested folders or pagination increase Drive calls by one per folder/page, bounded by the configured limits; transient retries can add at most two retry calls per operation. These figures are estimates, not the CRM4 project's effective quota configuration or current utilization; verify those in its Google Cloud project before recurring activation.

The owner-authorized Drive-only live scan completed in 1.29 seconds: one metadata request/page for 237 candidates, 71,831 bytes of serialized metadata, and zero content downloads. It found one folder, 237 `.m4a` names reported as `video/3gpp`, and 87 parseable phone/date/time filename patterns. It did not use the unavailable CRM4 workbook binding in that local process, so no CRM matches were produced by this redesign scan.

This design adds no Render service, worker, disk, database, Cron Job or plan increase. Incremental recurring Render cost is $0. It uses the existing Web instance and its current plan. If the Web service cannot safely sustain scans alongside Dashboard traffic, keep scans disabled and hand over a manual, owner-run preflight process; do not add paid infrastructure under this release.

## Acceptance and rollback gates

Before production use, confirm actual Dashboard-user Drive access, MIME/extension expectations, timestamp semantics, filename coverage, Google API quotas, and measured Web CPU/memory/latency during a bounded scan. Keep links and verified timestamps off until approved. Do not deploy or change Production settings from this checkpoint.

Rollback is to disable `AUDIO_WORKER_ENABLED` and the Dashboard audio confirmation flags, then restore the approved Web and Static baselines. The index rebuilds from Drive metadata after restart; no durable state needs restoration. Do not modify the Facebook Cron.
