'use strict'

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const Database = require('better-sqlite3')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'alter-co-dev-secret-change-in-production'
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'alter.db')

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

const db = new Database(DB_PATH)

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT DEFAULT 'member',
    plan TEXT DEFAULT 'free',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_data (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_user ON workspace_data(user_id);
`)

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

// Helpers
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

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email)
  if (existing) {
    return res.status(409).json({ error: 'Username or email already exists' })
  }

  const id = genId()
  const password_hash = hashPassword(password)
  const created_at = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, full_name, role, plan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, username, email, password_hash, fullName || '', 'member', 'free', created_at)

  const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: '30d' })
  const user = {
    id,
    username,
    email,
    fullName: fullName || '',
    role: 'member',
    plan: 'free',
    bio: '',
    timezone: 'UTC',
    created: created_at
  }
  res.json({ token, user })
})

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
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

// ----- Workspace (full load/save) -----
const WORKSPACE_KEYS = [
  'projects', 'tasks', 'ideas', 'events', 'timeEntries', 'team',
  'notifications', 'activity', 'auditLogs', 'invoices', 'apiKeys', 'userSettings'
]

app.get('/api/workspace', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM workspace_data WHERE user_id = ?').all(req.userId)
  const out = {}
  for (const k of WORKSPACE_KEYS) out[k] = null
  for (const { key, value } of rows) {
    try {
      out[key] = JSON.parse(value)
    } catch (e) {
      out[key] = null
    }
  }
  // Default arrays/object so frontend never gets undefined
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
  const put = db.prepare('INSERT OR REPLACE INTO workspace_data (user_id, key, value) VALUES (?, ?, ?)')
  for (const key of WORKSPACE_KEYS) {
    if (data[key] !== undefined) {
      const value = JSON.stringify(data[key])
      put.run(req.userId, key, value)
    }
  }
  res.json({ ok: true })
})

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: 'sqlite' })
})

app.listen(PORT, () => {
  console.log(`ALTER.CO API running on http://localhost:${PORT}`)
})
