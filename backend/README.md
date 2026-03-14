# ALTER.CO Backend

Real backend with **auth** (JWT) and **SQLite** for the ALTER.CO app.

## Quick start

```bash
cd backend
npm install
npm start
```

API runs at **http://localhost:3000**.

## Use the backend from the frontend

1. Start the backend: `npm start` in the `backend` folder.
2. In your `index.html`, set the API base URL so the app uses the backend instead of only localStorage:
   - Find the meta tag: `<meta name="alter-api-base" content="" id="alterApiBaseMeta">`
   - Set `content` to your API URL, e.g. `content="http://localhost:3000"`.
3. Open the app (e.g. by opening `index.html` or via a local server). Sign up or sign in; data is stored in the database and synced on each change.

With `content=""` (default), the app keeps using **localStorage only** (no backend). With `content="http://localhost:3000"`, it uses the backend for auth and workspace data.

## Environment (optional)

Create a `.env` file (see `.env.example`):

- `PORT` – server port (default 3000)
- `JWT_SECRET` – secret for signing tokens (change in production)
- `DB_PATH` – path to the SQLite file (default `./alter.db`)

## API

- `POST /api/auth/register` – body: `{ username, email, password [, fullName ] }` → `{ token, user }`
- `POST /api/auth/login` – body: `{ username, password }` → `{ token, user }`
- `GET /api/workspace` – auth: `Authorization: Bearer <token>` → full workspace JSON
- `PUT /api/workspace` – auth + body: same shape as GET → save workspace
