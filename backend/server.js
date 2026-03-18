'use strict'

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const path = require('path')
// Nodemailer is only required if SMTP email integration is enabled.
// This keeps the backend running even if dependencies aren't installed yet.
let nodemailer = null
try {
  nodemailer = require('nodemailer')
} catch (e) {
  nodemailer = null
}

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'alter-co-dev-secret-change-in-production'
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

// ----- Ensure data dirs exist -----
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8')

// ----- Helpers: JSON file read/write -----
function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    return []
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8')
}

function readWorkspace(userId) {
  const file = path.join(WORKSPACE_DIR, userId + '.json')
  if (!fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

function writeWorkspace(userId, data) {
  const file = path.join(WORKSPACE_DIR, userId + '.json')
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ----- Email (SMTP via Nodemailer) -----
let mailTransporter = null

function getMailTransporter() {
  if (mailTransporter) return mailTransporter

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null
  }
  if (!nodemailer) return null

  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  })

  return mailTransporter
}

async function sendEmailSafe({ to, subject, text }) {
  try {
    const transporter = getMailTransporter()
    if (!transporter || !to) return false
    const from = process.env.EMAIL_FROM || process.env.SMTP_USER
    await transporter.sendMail({ from, to, subject, text })
    return true
  } catch (e) {
    console.error('sendEmailSafe failed', e)
    return false
  }
}

const WORKSPACE_KEYS = [
  'projects', 'tasks', 'ideas', 'events', 'timeEntries', 'team',
  'notifications', 'activity', 'auditLogs', 'invoices', 'apiKeys', 'userSettings',
  'pages'
]

function emptyWorkspace() {
  const out = {}
  for (const k of WORKSPACE_KEYS) {
    out[k] = k === 'userSettings' ? {} : []
  }
  return out
}

// ----- Auth -----
function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10)
}

function comparePassword(pw, hash) {
  return bcrypt.compareSync(pw, hash)
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
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

// ----- Routes: Auth -----
app.post('/api/auth/register', async (req, res) => {
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
  const existing = users.find(u => u.username === username || (u.email && u.email.toLowerCase() === String(email).toLowerCase()))
  if (existing) {
    return res.status(409).json({ error: 'Username or email already exists' })
  }

  const id = genId()
  const created_at = new Date().toISOString()
  const newUser = {
    id,
    username,
    email: email || '',
    password_hash: hashPassword(password),
    full_name: fullName || '',
    role: 'member',
    plan: 'free',
    created_at
  }
  users.push(newUser)
  writeUsers(users)

  // Create empty workspace for new user
  writeWorkspace(id, emptyWorkspace())

  const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: '30d' })
  const user = {
    id,
    username,
    email: newUser.email,
    fullName: newUser.full_name || '',
    role: 'member',
    plan: 'free',
    bio: '',
    timezone: 'UTC',
    created: created_at
  }

  // Fire-and-forget welcome email (does not block registration)
  if (newUser.email) {
    sendEmailSafe({
      to: newUser.email,
      subject: 'Welcome to ALTER.CO',
      text:
        `Hi ${fullName || username},\n\n` +
        `Welcome to ALTER.CO – your new home for projects, tasks, and docs.\n\n` +
        `You can sign in anytime with this email and start creating projects, tracking time, and writing pages.\n\n` +
        `If you did not sign up, you can safely ignore this email.\n\n` +
        `— ALTER.CO`
    }).catch(() => {})
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
    email: row.email || '',
    fullName: row.full_name || '',
    role: row.role || 'member',
    plan: row.plan || 'free',
    bio: '',
    timezone: 'UTC',
    created: row.created_at
  }
  res.json({ token, user })
})

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const users = readUsers()
    const row = users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase())

    // Always respond 200 to avoid leaking which emails exist
    if (!row) {
      return res.json({ ok: true })
    }

    // Generate a temporary password
    const tempPassword = Math.random().toString(36).slice(-10)
    row.password_hash = hashPassword(tempPassword)
    writeUsers(users)

    const ok = await sendEmailSafe({
      to: row.email,
      subject: 'Your ALTER.CO temporary password',
      text:
        `Hi ${row.full_name || row.username},\n\n` +
        `A password reset was requested for your ALTER.CO account.\n\n` +
        `Temporary password: ${tempPassword}\n\n` +
        `Use this temporary password to sign in, then change it from Settings → Account.\n` +
        `If you did NOT request this, we recommend signing in and changing your password.\n\n` +
        `— ALTER.CO`
    })

    if (!ok) {
      // Still return ok, but log on server for debugging
      console.error('Forgot password email could not be sent (SMTP not configured).')
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error in /api/auth/forgot-password', e)
    // Don't expose details to client
    res.json({ ok: true })
  }
})

// ----- Routes: Workspace -----
app.get('/api/workspace', authMiddleware, (req, res) => {
  let data = readWorkspace(req.userId)
  if (!data || typeof data !== 'object') data = emptyWorkspace()
  const out = emptyWorkspace()
  for (const k of WORKSPACE_KEYS) {
    if (data[k] !== undefined && data[k] !== null) {
      out[k] = Array.isArray(data[k]) ? data[k] : (k === 'userSettings' && typeof data[k] === 'object' ? data[k] : out[k])
    }
  }
  res.json(out)
})

app.put('/api/workspace', authMiddleware, (req, res) => {
  const data = req.body || {}
  const current = readWorkspace(req.userId) || emptyWorkspace()
  for (const key of WORKSPACE_KEYS) {
    if (data[key] !== undefined) {
      current[key] = data[key]
    }
  }
  writeWorkspace(req.userId, current)
  res.json({ ok: true })
})

// ----- Routes: Integrations - Email -----
app.post('/api/integrations/email/send-invite', authMiddleware, async (req, res) => {
  try {
    const transporter = getMailTransporter()
    if (!transporter) {
      return res.status(500).json({ error: 'Email not configured on server' })
    }

    const { to, subject, message } = req.body || {}
    if (!to) {
      return res.status(400).json({ error: 'Missing "to" email address' })
    }

    const from = process.env.EMAIL_FROM || process.env.SMTP_USER
    const mailSubject = subject || 'You are invited to join ALTER.CO'
    const textBody =
      message ||
      `You've been invited to collaborate in ALTER.CO.\n\n` +
      `Sign in or create an account using this email address to access the workspace.\n\n` +
      `If you were not expecting this invitation, you can safely ignore this email.`

    await transporter.sendMail({
      from,
      to,
      subject: mailSubject,
      text: textBody
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('Error sending invite email', err)
    res.status(500).json({ error: 'Failed to send email' })
  }
})

app.post('/api/integrations/email/task-assigned', authMiddleware, async (req, res) => {
  try {
    const { to, taskTitle, projectName, dueDate } = req.body || {}
    if (!to || !taskTitle) {
      return res.status(400).json({ error: 'Missing "to" or "taskTitle"' })
    }

    const ok = await sendEmailSafe({
      to,
      subject: `New task assigned to you: ${taskTitle}`,
      text:
        `You have been assigned a new task in ALTER.CO.\n\n` +
        `Task: ${taskTitle}\n` +
        (projectName ? `Project: ${projectName}\n` : '') +
        (dueDate ? `Due: ${dueDate}\n` : '') +
        `\nSign in to ALTER.CO to view the details and update the status.\n`
    })

    if (!ok) {
      return res.status(500).json({ error: 'Email not configured on server' })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Error sending task assigned email', e)
    res.status(500).json({ error: 'Failed to send task assignment email' })
  }
})

// ----- Health -----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', storage: 'json' })
})

// ----- Optional: serve frontend from parent (for single-server deploy) -----
const parentDir = path.join(__dirname, '..')
const indexPath = path.join(parentDir, 'index.html')
if (fs.existsSync(indexPath)) {
  app.use(express.static(parentDir, { index: false }))
  app.get('/', (req, res) => {
    res.sendFile(indexPath)
  })
}

app.listen(PORT, () => {
  console.log('ALTER.CO API running on http://localhost:' + PORT)
  console.log('Storage: JSON files in ' + DATA_DIR)
})
