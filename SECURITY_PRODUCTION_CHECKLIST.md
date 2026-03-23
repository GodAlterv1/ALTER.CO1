# ALTER.CO Security and Production Checklist

Use this list before each production release.

## 1) Secrets and Environment

- [ ] Set strong `JWT_SECRET` in production (not default value).
- [ ] Set Google OAuth env vars in backend:
  - [ ] `GOOGLE_CLIENT_ID`
  - [ ] `GOOGLE_CLIENT_SECRET`
  - [ ] `GOOGLE_CLIENT_REDIRECT_URI`
- [ ] Ensure no secrets are committed to git (`.env`, tokens, keys).
- [ ] Rotate any leaked key immediately.

## 2) Google OAuth Setup

- [ ] OAuth consent screen is configured in Google Cloud Console.
- [ ] Authorized redirect URI exactly matches `GOOGLE_CLIENT_REDIRECT_URI`.
- [ ] Required test users are added (if app is in testing mode).
- [ ] App verification plan is documented for public launch.

## 3) API Security Controls

- [ ] `helmet` middleware enabled in backend.
- [ ] CORS limited to trusted origins (do not use wide-open origin in production).
- [ ] Auth endpoints rate-limited (`/api/auth/*`).
- [ ] Contact/invite endpoints rate-limited.
- [ ] Integration endpoints require auth middleware.

## 4) Session and Auth Behavior

- [ ] Expired tokens force sign-in again cleanly.
- [ ] Logout clears client token/session data.
- [ ] Privileged routes protected by role checks (`admin`/`owner` where needed).
- [ ] Password reset and change flows tested end-to-end.

## 5) Data Safety and Reliability

- [ ] Backup strategy in place for JSON data files.
- [ ] Restore drill tested at least once.
- [ ] Audit log captures destructive actions (delete/update auth-sensitive changes).
- [ ] Error handling returns safe messages (no secret leakage in responses).

## 6) Calendar Quality Checks

- [ ] Create/edit/delete event works for local events.
- [ ] Recurring events: edit/delete supports series vs occurrence.
- [ ] Drag-drop in week view works and can be undone.
- [ ] Conflict alerts render for overlapping events.
- [ ] Google Calendar connect/disconnect status updates correctly after reload.

## 7) Deployment and Monitoring

- [ ] Health endpoint checked after deploy (`/api/health`).
- [ ] Basic uptime monitoring enabled.
- [ ] Backend logs monitored for OAuth/token errors.
- [ ] Alerting configured for repeated 5xx spikes.

## 8) Final Release Gate

- [ ] Run smoke test: login, tasks, calendar, integrations, logout.
- [ ] Verify no console errors on main pages.
- [ ] Confirm latest commit/tag is deployed.
- [ ] Record release notes and rollback plan.

