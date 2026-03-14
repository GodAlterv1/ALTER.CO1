# ALTER.CO

All-in-one SaaS app: projects, tasks (Kanban), ideas, team, time tracking, calendar, billing.

- **Frontend:** single `index.html` (no build step).
- **Backend:** Node.js API in `/backend` (auth + JSON file storage).

## Run locally

1. **Backend:** `cd backend` → `npm install` → `npm start`
2. **Frontend:** open `index.html` in a browser (meta tag points to `http://localhost:3000` for the API).

Or from repo root: `npm run build` then `npm start` — then open http://localhost:3000.

## Put the whole site online (so others can use it)

See **[DEPLOY.md](DEPLOY.md)**. One deploy on **Render** (connect GitHub, one Web Service) — same URL for the app and API. No GitHub Pages, no URL changes in code.
