# Bug Bash Mode

Use this process before major pushes or releases.

## Commands

- Run smoke suite:
  - `npm run smoke`
- Start bug bash guide:
  - `npm run bugbash`

If your API is not on `http://localhost:3000`, set:

- PowerShell: `$env:SMOKE_BASE_URL="https://your-api-url"`

Then run commands again.

## What smoke suite validates

- Health endpoint responds.
- Register/login/auth works.
- Workspace read/write round-trip works.
- `PATCH /api/workspace/:key` partial update (e.g. `userSettings`) round-trip works.
- Google Calendar status endpoint responds for authenticated user.
- Calendar events endpoint responds.
- Temp smoke user cleanup works.

## Manual bug bash checklist

- Auth: login, logout, and session persistence.
- Calendar create/edit/delete and recurrence behavior.
- Week drag/drop + undo.
- Quick add natural language input.
- Google Calendar connect/sync/disconnect.
- Task-to-calendar conversion.
- Notifications: @mentions (task/event), **Open** link navigates to correct task or calendar day.
- **What’s new** (✨) opens once and marks seen after dismiss.
- **Settings → Workspace**: local analytics summary (export/clear optional).
- Comment edit/delete on tasks and calendar event comments (author vs admin).
- No console errors on core pages.

## Notes

- Smoke tests are intentionally lightweight and fast.
- Keep manual bug bash short (10-15 minutes) but consistent.
- Log findings immediately as reproducible steps.

