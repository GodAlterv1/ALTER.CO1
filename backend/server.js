'use strict'

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'alter-co-dev-secret-change-in-production'
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8')

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

// Serve the frontend (index.html and assets) from repo root when deployed
const FRONTEND_ROOT = path.join(__dirname, '..')
if (fs.existsSync(path.join(FRONTEND_ROOT, 'index.html'))) {
  app.use(express.static(FRONTEND_ROOT, { index: false }))
}

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  } catch (e) {
    return []
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8')
}

function getWorkspacePath(userId) {
  const safe = (userId || '').replace(/[^a-zA-Z0-9-_]/g, '_')
  return path.join(WORKSPACE_DIR, safe + '.json')
}

function readWorkspace(userId) {
  const file = getWorkspacePath(userId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

function writeWorkspace(userId, data) {
  fs.writeFileSync(getWorkspacePath(userId), JSON.stringify(data, null, 2), 'utf8')
}

const WORKSPACE_KEYS = [
  'projects', 'tasks', 'ideas', 'events', 'timeEntries', 'team',
  'notifications', 'activity', 'auditLogs', 'invoices', 'apiKeys', 'userSettings'
]

function emptyWorkspace() {
  const out = {}
  for (const k of WORKSPACE_KEYS) out[k] = k === 'userSettings' ? {} : []
  return out
}

// Auth middleware
function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization' })
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.userId = payload.userId
    req.username = payload.username
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10)
}
function comparePassword(pw, hash) {
  return bcrypt.compareSync(pw, hash)
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

// ----- Auth -----
app.post('/api/auth/register', (req, res) => {
  const { username, email, password, fullName } = req.body || {}
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password required' })
  }
  if (username.length < 4) {
    return res.status(400).json({ error: 'Username must be at least 4 characters' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }

  const users = readUsers()
  if (users.some(u => u.username === username || u.email === email)) {
    return res.status(409).json({ error: 'Username or email already exists' })
  }

  const id = genId()
  const password_hash = hashPassword(password)
  const created_at = new Date().toISOString()
  users.push({
    id, username, email, password_hash,
    full_name: fullName || '', role: 'member', plan: 'free', created_at
  })
  writeUsers(users)
  writeWorkspace(id, emptyWorkspace())

  const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: '30d' })
  const user = {
    id, username, email,
    fullName: fullName || '', role: 'member', plan: 'free',
    bio: '', timezone: 'UTC', created: created_at
  }
  res.json({ token, user })
})

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  const users = readUsers()
  const row = users.find(u => u.username === username)
  if (!row || !comparePassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' })
  }

  const token = jwt.sign({ userId: row.id, username: row.username }, JWT_SECRET, { expiresIn: '30d' })
  const user = {
    id: row.id,
    username: row.username,
    email: row.email,
    fullName: row.full_name || '',
    role: row.role,
    plan: row.plan,
    bio: '',
    timezone: 'UTC',
    created: row.created_at
  }
  res.json({ token, user })
})

// ----- Workspace -----
app.get('/api/workspace', authMiddleware, (req, res) => {
  const data = readWorkspace(req.userId) || emptyWorkspace()
  const out = { ...emptyWorkspace() }
  for (const k of WORKSPACE_KEYS) {
    if (data[k] !== undefined) out[k] = data[k]
  }
  if (!Array.isArray(out.projects)) out.projects = []
  if (!Array.isArray(out.tasks)) out.tasks = []
  if (!Array.isArray(out.ideas)) out.ideas = []
  if (!Array.isArray(out.events)) out.events = []
  if (!Array.isArray(out.timeEntries)) out.timeEntries = []
  if (!Array.isArray(out.team)) out.team = []
  if (!Array.isArray(out.notifications)) out.notifications = []
  if (!Array.isArray(out.activity)) out.activity = []
  if (!Array.isArray(out.auditLogs)) out.auditLogs = []
  if (!Array.isArray(out.invoices)) out.invoices = []
  if (!Array.isArray(out.apiKeys)) out.apiKeys = []
  if (typeof out.userSettings !== 'object' || out.userSettings === null) out.userSettings = {}
  res.json(out)
})

app.put('/api/workspace', authMiddleware, (req, res) => {
  const data = req.body || {}
  const current = readWorkspace(req.userId) || emptyWorkspace()
  for (const key of WORKSPACE_KEYS) {
    if (data[key] !== undefined) current[key] = data[key]
  }
  writeWorkspace(req.userId, current)
  res.json({ ok: true })
})

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storage: 'json' })
})

app.get('/', (req, res) => {
  const indexPath = path.join(FRONTEND_ROOT, 'index.html')
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath)
  }
  res.type('html').send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>ALTER.CO API</title></head>
    <body style="font-family:sans-serif;max-width:520px;margin:40px auto;padding:20px;">
      <h1>ALTER.CO API</h1>
      <p>Backend is running. Use the frontend app with this URL as the API base.</p>
      <p><strong>Endpoints:</strong></p>
      <ul>
        <li><code>POST /api/auth/register</code> – create account</li>
        <li><code>POST /api/auth/login</code> – sign in</li>
        <li><code>GET /api/workspace</code> – get workspace (auth required)</li>
        <li><code>PUT /api/workspace</code> – save workspace (auth required)</li>
        <li><a href="/api/health">GET /api/health</a> – health check</li>
      </ul>
    </body>
    </html>
  `)
})

app.listen(PORT, () => {
  console.log('ALTER.CO API running on http://localhost:' + PORT)
})
