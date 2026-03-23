# Deploy ALTER.CO to Render (one URL = site + API)

One Render **Web Service** serves both the app and the API. No separate hosting for the frontend.

---

## What you need

- **GitHub** account  
- **Render** account (free at [render.com](https://render.com))

---

## Step 1: Push your project to GitHub

Your repo must have this structure (Render runs from the **root** of the repo):

```
ALTER.CO/
  package.json       ← build + start run from here
  index.html
  js/app.js          ← main app script (loaded by index.html)
  render.yaml
  backend/
    package.json
    server.js
    ...
```

1. Open **PowerShell** or **Command Prompt**.
2. Go to your project and push:

```powershell
cd D:\GITHUB\ALTER.CO
git init
git add .
git commit -m "Ready for Render"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

(If the repo already exists, just `git add .` then `git commit -m "Deploy"` and `git push`.)

3. On GitHub, confirm the **backend** folder and **backend/package.json** are there. If not, add them and push again.

---

## Step 2: Create the Web Service on Render

1. Go to **[render.com](https://render.com)** and sign in (e.g. with GitHub).
2. Click **New +** → **Web Service**.
3. Connect GitHub if needed, then select your **ALTER.CO** repo.
4. Use these settings **exactly**:

   | Field | Value |
   |-------|--------|
   | **Name** | `alter-co` (or any name you like) |
   | **Region** | e.g. Oregon or Frankfurt |
   | **Branch** | `main` |
   | **Root Directory** | **Leave completely empty** |
   | **Runtime** | `Node` |
   | **Build Command** | `npm run build` |
   | **Start Command** | `npm start` |

5. Click **Advanced** and add:

   - **Key:** `JWT_SECRET`  
   - **Value:** a long random string (e.g. from [randomkeygen.com](https://randomkeygen.com) – “CodeIgniter Encryption Keys” or similar).

   **Important:** Keep the same `JWT_SECRET` across every deploy. If you change it or omit it, existing login tokens stop working and everyone must sign in again.

6. Click **Create Web Service**.

---

## Step 3: Why “Root Directory” must be empty

- Render runs **Build** and **Start** from the **Root Directory**.
- If Root Directory is **empty**, that’s the **repo root**, where your root `package.json` and the `backend/` folder live.
- Then:
  - `npm run build` → `npm install --prefix backend` → installs backend deps.
  - `npm start` → `node backend/server.js` → starts the API and serves `index.html` from the repo root.
- If you set Root Directory to `backend`, Render would look for `backend/package.json` **inside** `backend`, and the start command would not find `index.html` in the parent. **So leave Root Directory blank.**

---

## Step 4: After the first deploy

- Wait until the deploy is **green** (a few minutes).
- Your URL will look like: **https://alter-co.onrender.com** (or whatever name you chose).
- Open that URL: you should see the ALTER.CO login page. Sign up and use the app; the same URL is used for the site and the API.

---

## Smoke tests against production

After deploy, you can run the same smoke suite against your live URL (PowerShell):

```powershell
$env:SMOKE_BASE_URL="https://YOUR-SERVICE.onrender.com"
npm run smoke
```

Use your **HTTPS** service URL (no trailing slash). This runs register/login, workspace PUT + PATCH, calendar endpoints, and deletes the temp user.

---

## If the build failed last time

| Problem | Fix |
|--------|-----|
| **“cd: can't cd to backend”** or **“No such file or directory: backend”** | Root Directory must be **empty**. Repo root must contain the `backend` folder. |
| **“Could not read package.json” in backend** | Make sure `backend/package.json` and `backend/server.js` are committed and pushed to GitHub. |
| **Build fails on a native module** | The app now uses **JSON file storage** only (no SQLite). Run `npm install` in `backend` locally to confirm it installs without errors. |

---

## Free tier notes

- The service may **sleep** after ~15 minutes of no traffic; the next visit can take 30–60 seconds to wake it.
- On the **free tier**, the filesystem is **ephemeral**: data in `backend/data/` can be lost on redeploy or restart. For long-term data you’d need a database or persistent disk (paid option).

---

## Summary

| What | Where |
|------|--------|
| Site + API | One Render Web Service |
| Your live link | `https://YOUR-SERVICE-NAME.onrender.com` |
| Root Directory | **Empty** |
| Build | `npm run build` |
| Start | `npm start` |
