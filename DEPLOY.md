# Deploy ALTER.CO so anyone can use it (one place)

Your app and API are set up so **one deployment on Render** serves everything. You don’t need GitHub Pages or to change any URLs in the code.

---

## What you need

- A **GitHub** account  
- A **Render** account (free at [render.com](https://render.com))

---

## Step 1: Push your project to GitHub

1. Open **Command Prompt** or **PowerShell**.
2. Run:

```bash
cd D:\GITHUB\ALTER.CO
git init
git add .
git commit -m "Ready for deploy"
```

3. On GitHub, create a **new repository** (e.g. name: `ALTER.CO`). Don’t add a README.
4. Then run (replace `YOUR_USERNAME` and `YOUR_REPO_NAME` with yours):

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

---

## Step 2: Deploy on Render (one service = whole site)

1. Go to **[render.com](https://render.com)** and sign up or log in (with GitHub if you like).
2. Click **New +** → **Web Service**.
3. Connect your **GitHub** account if you haven’t, then choose the repo you just pushed (e.g. **ALTER.CO**).
4. Use these settings:

   | Field | Value |
   |-------|--------|
   | **Name** | `alter-co` (or any name) |
   | **Region** | Pick one (e.g. Frankfurt or Oregon) |
   | **Branch** | `main` |
   | **Root Directory** | Leave **empty** |
   | **Runtime** | `Node` |
   | **Build Command** | `npm run build` |
   | **Start Command** | `npm start` |

5. Click **Advanced** and add one **Environment Variable** (recommended):

   - **Key:** `JWT_SECRET`  
   - **Value:** any long random string (e.g. copy from [randomkeygen.com](https://randomkeygen.com))

6. Click **Create Web Service**.
7. Wait for the first deploy (a few minutes). When it’s green, you’ll see a URL like:

   **https://alter-co.onrender.com**

---

## Step 3: Use and share your site

- Open that URL in your browser. You should see the ALTER.CO login page.
- Click **Create Account**, sign up, and use the app. Everything (site + API + data) runs from that one link.
- Share the same URL with others so they can sign up and use it too.

No need to change `index.html` or the meta tag: when people open the Render URL, the app uses that same URL for the API.

---

## Summary

| What | Where |
|------|--------|
| Website + API + data | **One Render Web Service** |
| Your live link | **https://YOUR-SERVICE-NAME.onrender.com** |

- **Free tier:** the service may sleep after ~15 minutes without visits; the next visit wakes it up (can take ~30–60 seconds). Data is stored on the server; on free tier it can be lost on redeploy/restart.
- To keep the same link working from your repo, push changes to GitHub; Render will redeploy automatically if auto-deploy is on.
