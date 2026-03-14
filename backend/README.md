# ALTER.CO Backend

Backend with **auth** (JWT) and **JSON file storage** (no database install, no native build). Works on Windows, Mac, Linux, and services like Render.

## Quick start

```bash
cd backend
npm install
npm start
```

API runs at **http://localhost:3000**.

## Use the backend from the frontend

1. Start the backend: `npm start` in the `backend` folder.
2. In `index.html`, the meta tag `<meta name="alter-api-base" content="http://localhost:3000" ...>` tells the app to use this API.  
   - `content="http://localhost:3000"` → use backend for login and workspace data.  
   - `content=""` → use **localStorage only** (no backend).
3. Open the app (e.g. open `index.html` in the browser or use a local server). Register or sign in; data is saved in `backend/data/` and synced on change.

## Where data is stored

- **Users:** `backend/data/users.json`
- **Workspace per user:** `backend/data/workspace/<userId>.json`

No SQLite or other database needed.

## Environment (optional)

Copy `.env.example` to `.env` and adjust if needed:

- `PORT` – server port (default 3000)
- `JWT_SECRET` – secret for signing tokens (use a long random string in production)

## API

- `POST /api/auth/register` – body: `{ username, email, password [, fullName ] }` → `{ token, user }`
- `POST /api/auth/login` – body: `{ username, password }` → `{ token, user }`
- `GET /api/workspace` – header: `Authorization: Bearer <token>` → full workspace JSON
- `PUT /api/workspace` – same header + body: same shape as GET → save workspace
- `GET /api/health` – no auth → `{ status: 'ok', storage: 'json' }`
