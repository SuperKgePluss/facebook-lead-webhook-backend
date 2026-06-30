# AGENTS.md

## Project Context
This repository is a Node.js backend with Google Sheets integration and Google Apps Script code deployed via clasp.

Key areas:
- `server.js`: Express backend entrypoint.
- `services/`: backend service modules.
- `apps-script/`: Google Apps Script source, with `apps-script/appsscript.json` manifest.
- `tests/`: Node test files.
- `.github/workflows/main.yml`: deploys Apps Script on pushes to `main`.

## Default Operating Mode
- Use Worktree by default for code edits.
- Use Local only when the task explicitly requires local `.env`, existing `node_modules`, clasp credentials, manual GUI state, or deployment validation.
- Keep each thread to one phase when possible: analysis, implement, validate, deploy, or handoff.

## Safety Rules
- Before editing, run `git status --short`.
- Do not touch unrelated dirty files.
- Do not read or print `.env` or credential files unless explicitly approved.
- Do not install dependencies unless explicitly approved.
- Do not commit, push, deploy, migrate, delete data, or run cleanup commands unless explicitly approved.
- Treat Google Sheets, Apps Script, clasp, GitHub Actions, and deployment settings as production-adjacent.
- Never run `clasp push -f` without explicit approval.

## Scope Control
- Prefer targeted file reads over broad scans.
- Do not run broad repository searches unless the task requires it.
- Preserve existing behavior unless the user explicitly asks for a behavior change.
- Avoid unrelated refactors, formatting churn, dependency updates, or config rewrites.

## Validation Commands
There is no `npm test` script currently defined.

Use targeted checks:

```powershell
git status --short
```

For backend JavaScript syntax checks:

```powershell
node --check server.js
node --check services/googleSheets.js
```

For the current checked-in tests:

```powershell
node --test tests/facebookLeadParser.test.js tests/googleSheetsDateSerial.test.js tests/historicalFacebookDateAudit.test.js tests/leadsDateSortLogic.test.js
```

For a single targeted test:

```powershell
node --test tests/googleSheetsDateSerial.test.js
```

If backend runtime behavior changes, use only with appropriate local environment context:

```powershell
npm start
```

Deployment command, approval-only:

```powershell
clasp push -f
```

## Reporting
When finishing work, report:
- What changed
- Files touched
- Validation run
- Risks or unknowns
- Exact next action
