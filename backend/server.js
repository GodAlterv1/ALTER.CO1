'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const rateLimit = require('express-rate-limit')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const fs = require('fs')
// Nodemailer is only required if SMTP email integration is enabled.
// This keeps the backend running even if dependencies aren't installed yet.
let nodemailer = null
try {
  nodemailer = require('nodemailer')
} catch (e) {
  nodemailer = null
}

const app = express()
const startedAt = Date.now()
app.set('trust proxy', 1)
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'alter-co-dev-secret-change-in-production'
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')

// Hardening: CSP disabled — index.html uses inline scripts/styles
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
)
app.use(compression())
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

const authBurstLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later.' }
})

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CONTACT_MAX || 8),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages sent, try again later.' }
})

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

function deleteWorkspaceFile(userId) {
  const file = path.join(WORKSPACE_DIR, userId + '.json')
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.error('deleteWorkspaceFile', e)
  }
}

function userToClient(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    fullName: row.full_name || '',
    role: row.role || 'member',
    plan: row.plan || 'free',
    bio: row.bio || '',
    timezone: row.timezone || 'UTC',
    created: row.created_at
  }
}

// ----- Email (SMTP via Nodemailer) -----
let mailTransporter = null
let smtpConfigWarningLogged = false

/** Gmail App Passwords are 16 chars; Google often shows them with spaces — remove all spaces. */
function normalizeSmtpPassword(pass, isGmail) {
  const p = String(pass || '').trim()
  if (!isGmail) return p
  return p.replace(/\s+/g, '')
}

/**
 * For Gmail, "Name <x@gmail.com>" is OK only if x matches SMTP_USER; otherwise use SMTP_USER.
 */
function normalizeMailFrom() {
  const user = (process.env.SMTP_USER || '').trim()
  let from = (process.env.EMAIL_FROM || user || '').trim()
  const m = from.match(/<([^>]+)>/)
  const addrInFrom = m ? m[1].trim() : from
  if (user && addrInFrom && addrInFrom.toLowerCase() !== user.toLowerCase()) {
    console.warn('[SMTP] EMAIL_FROM address does not match SMTP_USER; using SMTP_USER as From to satisfy Gmail.')
    return user
  }
  return from || user
}

function createGmailTransport(SMTP_USER, SMTP_PASS) {
  // SMTP_GMAIL_USE_SERVICE=true → nodemailer built-in preset
  if (String(process.env.SMTP_GMAIL_USE_SERVICE || '').toLowerCase() === 'true') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      debug: String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true',
      logger: String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true'
    })
  }

  const mode = String(process.env.SMTP_GMAIL_MODE || '587').toLowerCase()
  // 587 + STARTTLS often works better on cloud hosts (e.g. Render) than 465 SSL.
  if (mode === '465') {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      debug: String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true',
      logger: String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true'
    })
  }

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' },
    debug: String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true',
    logger: String(process.env.SMTP_DEBUG || '').toLowerCase() === 'true'
  })
}

function getMailTransporter() {
  if (mailTransporter) return mailTransporter

  if (!nodemailer) {
    console.error('nodemailer dependency missing; cannot send email.')
    return null
  }

  const SMTP_USER = (process.env.SMTP_USER || '').trim()
  const { SMTP_SERVICE, SMTP_HOST, SMTP_PORT, SMTP_SECURE } = process.env
  const isGmail = String(SMTP_SERVICE || '').toLowerCase() === 'gmail'
  const SMTP_PASS = normalizeSmtpPassword(process.env.SMTP_PASS, isGmail)

  if (!SMTP_USER || !SMTP_PASS) {
    if (!smtpConfigWarningLogged) {
      console.error(
        'SMTP not configured. Set SMTP_USER and SMTP_PASS. For Gmail also set SMTP_SERVICE=gmail (recommended).'
      )
      smtpConfigWarningLogged = true
    }
    return null
  }

  const svc = String(SMTP_SERVICE || '').toLowerCase()
  if (svc === 'gmail') {
    mailTransporter = createGmailTransport(SMTP_USER, SMTP_PASS)
    const mode = String(process.env.SMTP_GMAIL_USE_SERVICE || '').toLowerCase() === 'true'
      ? 'service'
      : String(process.env.SMTP_GMAIL_MODE || '587')
    console.log('[SMTP] Gmail transport:', mode === 'service' ? 'nodemailer service:gmail' : 'smtp.gmail.com port ' + mode)
    return mailTransporter
  }

  const missing = []
  if (!SMTP_HOST) missing.push('SMTP_HOST')
  if (!SMTP_PORT) missing.push('SMTP_PORT')
  if (missing.length) {
    if (!smtpConfigWarningLogged) {
      console.error(
        'SMTP not configured. For Gmail set SMTP_SERVICE=gmail with SMTP_USER and SMTP_PASS. Otherwise set:',
        missing.join(', ')
      )
      smtpConfigWarningLogged = true
    }
    return null
  }

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

function isSmtpConfigured() {
  const u = (process.env.SMTP_USER || '').trim()
  const p = (process.env.SMTP_PASS || '').trim()
  const { SMTP_SERVICE, SMTP_HOST, SMTP_PORT } = process.env
  if (!u || !p) return false
  if (String(SMTP_SERVICE || '').toLowerCase() === 'gmail') return true
  return Boolean(SMTP_HOST && SMTP_PORT)
}

function isResendConfigured() {
  const key = (process.env.RESEND_API_KEY || '').trim()
  if (!key) return false
  const from = (process.env.RESEND_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || '').trim()
  return Boolean(from)
}

/** True if Resend (HTTPS) or classic SMTP env is complete */
function isEmailConfigured() {
  if (isResendConfigured()) return true
  return isSmtpConfigured()
}

/**
 * Resend uses HTTPS (port 443) — works on Render free tier, which blocks outbound SMTP (25, 465, 587).
 * https://resend.com/docs
 */
async function sendEmailViaResend({ to, subject, text }) {
  const key = (process.env.RESEND_API_KEY || '').trim()
  if (!key) return false
  const from = (process.env.RESEND_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || '').trim()
  if (!from) {
    console.error('sendEmailViaResend: set RESEND_FROM or EMAIL_FROM')
    return false
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text
      })
    })
    if (!res.ok) {
      const body = await res.text()
      console.error('sendEmailViaResend failed:', res.status, body)
      return false
    }
    return true
  } catch (e) {
    console.error('sendEmailViaResend', e && e.message ? e.message : e)
    return false
  }
}

async function sendEmailSafe({ to, subject, text }) {
  try {
    if ((process.env.RESEND_API_KEY || '').trim()) {
      return await sendEmailViaResend({ to, subject, text })
    }

    const transporter = getMailTransporter()
    if (!transporter || !to) {
      if (!transporter) console.error('sendEmailSafe: transporter null (SMTP not configured?)')
      return false
    }
    const from = normalizeMailFrom()
    await transporter.sendMail({ from, to, subject, text })
    return true
  } catch (e) {
    const msg = e && (e.message || String(e))
    console.error('sendEmailSafe failed:', msg)
    if (e && e.response) console.error('sendEmailSafe SMTP response:', e.response)
    if (/invalid login|authentication failed|535|534/i.test(String(msg))) {
      console.error(
        '[SMTP] Gmail usually needs an App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal Gmail password.'
      )
    }
    return false
  }
}

/** Logs SMTP verify or notes when using Resend (no SMTP on Render free tier) */
function verifyEmailOnStartup() {
  if ((process.env.RESEND_API_KEY || '').trim()) {
    if (isResendConfigured()) {
      console.log(
        '[Email] Resend API enabled (HTTPS). Outbound SMTP is blocked on Render free Web Services — Resend avoids SMTP entirely.'
      )
    } else {
      console.error('[Email] RESEND_API_KEY is set; add RESEND_FROM (or EMAIL_FROM) with a sender Resend allows (e.g. onboarding@resend.dev for testing).')
    }
    return
  }

  if (!isSmtpConfigured() || !nodemailer) return
  const t = getMailTransporter()
  if (!t || typeof t.verify !== 'function') return
  t.verify()
    .then(() => {
      console.log('[SMTP] Verify OK — Gmail accepted SMTP_USER / SMTP_PASS.')
    })
    .catch(err => {
      console.error('[SMTP] VERIFY FAILED — mail will not work until this passes.')
      const msg = err && err.message ? err.message : String(err)
      console.error('[SMTP] Reason:', msg)
      if (err && err.code) console.error('[SMTP] code:', err.code)
      if (err && err.response) console.error('[SMTP] response:', err.response)
      if (err && err.responseCode) console.error('[SMTP] responseCode:', err.responseCode)
      if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(String(msg))) {
        console.error(
          '[Email] Render free Web Services block outbound SMTP (ports 25, 465, 587). Use Resend: set RESEND_API_KEY + RESEND_FROM in Environment, or upgrade Render / use another host.'
        )
      } else {
        console.error(
          '[SMTP] Fix checklist: (1) SMTP_SERVICE=gmail (2) SMTP_USER=your Gmail (3) SMTP_PASS=App Password (4) EMAIL_FROM matches SMTP_USER (5) try SMTP_GMAIL_MODE=465 or SMTP_GMAIL_USE_SERVICE=true for TLS issues'
        )
      }
    })
}

// Must match keys the frontend sends in PUT /api/workspace (see index.html syncWorkspaceToBackend)
const WORKSPACE_KEYS = [
  'projects', 'tasks', 'ideas', 'events', 'goals', 'timeEntries', 'team',
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
app.post('/api/auth/register', authBurstLimiter, async (req, res) => {
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
    bio: '',
    timezone: 'UTC',
    role: 'member',
    plan: 'free',
    created_at
  }
  users.push(newUser)
  writeUsers(users)

  // Create empty workspace for new user
  writeWorkspace(id, emptyWorkspace())

  const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: '30d' })
  const user = userToClient(newUser)

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

app.post('/api/auth/login', authBurstLimiter, (req, res) => {
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
  res.json({ token, user: userToClient(row) })
})

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' })
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' })
  }

  const users = readUsers()
  const row = users.find(u => u.id === req.userId)
  if (!row || !comparePassword(currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' })
  }

  row.password_hash = hashPassword(newPassword)
  writeUsers(users)
  res.json({ ok: true })
})

app.post('/api/auth/forgot-password', authBurstLimiter, async (req, res) => {
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

    if (String(row.email || '').indexOf('@') === -1) {
      console.error('Forgot password: stored user email is invalid:', row.email)
    }

    // Generate a temporary password — only apply it after email sends successfully,
    // otherwise the user would be locked out with a password they never received.
    const tempPassword = Math.random().toString(36).slice(-10)
    const emailed = await sendEmailSafe({
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

    if (!emailed) {
      console.error(
        'Forgot password: email could not be sent. Check SMTP env (SMTP_SERVICE=gmail, SMTP_USER, SMTP_PASS) and Render logs. Password was NOT changed.'
      )
      return res.json({ ok: true })
    }

    row.password_hash = hashPassword(tempPassword)
    writeUsers(users)

    res.json({ ok: true })
  } catch (e) {
    console.error('Error in /api/auth/forgot-password', e)
    // Don't expose details to client
    res.json({ ok: true })
  }
})

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim())
}

// ----- Routes: Account (matches frontend Settings / Billing) -----
app.get('/api/me', authMiddleware, (req, res) => {
  const users = readUsers()
  const row = users.find(u => u.id === req.userId)
  if (!row) return res.status(404).json({ error: 'User not found' })
  res.json(userToClient(row))
})

app.put('/api/me/profile', authMiddleware, (req, res) => {
  const { email, fullName, bio, timezone } = req.body || {}
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: 'Email is required' })
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' })
  }

  const users = readUsers()
  const row = users.find(u => u.id === req.userId)
  if (!row) return res.status(404).json({ error: 'User not found' })

  const emailLower = String(email).trim().toLowerCase()
  const clash = users.find(u => u.id !== req.userId && (u.email || '').toLowerCase() === emailLower)
  if (clash) {
    return res.status(409).json({ error: 'That email is already in use' })
  }

  row.email = emailLower
  if (fullName != null) row.full_name = String(fullName).trim()
  if (bio != null) row.bio = String(bio).trim()
  if (timezone != null) row.timezone = String(timezone).trim() || 'UTC'

  writeUsers(users)
  res.json(userToClient(row))
})

app.put('/api/me/plan', authMiddleware, (req, res) => {
  const { plan, billingPeriod } = req.body || {}
  if (!plan) {
    return res.status(400).json({ error: 'Plan is required' })
  }

  const users = readUsers()
  const row = users.find(u => u.id === req.userId)
  if (!row) return res.status(404).json({ error: 'User not found' })

  row.plan = String(plan)
  if (billingPeriod != null) row.billing_period = String(billingPeriod)

  writeUsers(users)
  res.json({ ok: true, plan: row.plan, billingPeriod: row.billing_period })
})

app.delete('/api/me', authMiddleware, (req, res) => {
  const users = readUsers()
  const idx = users.findIndex(u => u.id === req.userId)
  if (idx >= 0) {
    users.splice(idx, 1)
    writeUsers(users)
  }
  deleteWorkspaceFile(req.userId)
  res.status(204).end()
})

// ----- Routes: Public -----
app.post('/api/public/contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body || {}
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' })
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' })
    }

    const to = (process.env.CONTACT_INBOX || process.env.SMTP_USER || process.env.RESEND_FROM || '').trim()
    if (!to) {
      return res.status(503).json({ error: 'Contact email is not configured on this server' })
    }

    const fromName = String(name || 'Visitor').trim().slice(0, 120)
    const subject = `ALTER.CO contact: ${fromName || 'Message'}`
    const text =
      `From: ${fromName}\n` +
      `Email: ${String(email).trim()}\n\n` +
      String(message).trim().slice(0, 8000)

    const ok = await sendEmailSafe({ to, subject, text })
    if (!ok) {
      return res.status(500).json({ error: 'Could not send message' })
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('contact', e)
    res.status(500).json({ error: 'Could not send message' })
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
    if (!isEmailConfigured()) {
      return res.status(500).json({ error: 'Email not configured on server' })
    }

    const { to, subject, message } = req.body || {}
    if (!to) {
      return res.status(400).json({ error: 'Missing "to" email address' })
    }

    const mailSubject = subject || 'You are invited to join ALTER.CO'
    const textBody =
      message ||
      `You've been invited to collaborate in ALTER.CO.\n\n` +
      `Sign in or create an account using this email address to access the workspace.\n\n` +
      `If you were not expecting this invitation, you can safely ignore this email.`

    const ok = await sendEmailSafe({
      to,
      subject: mailSubject,
      text: textBody
    })
    if (!ok) {
      return res.status(500).json({ error: 'Failed to send email' })
    }

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

// ----- Integrations: Google Calendar (stub until OAuth env is wired) -----
app.get('/auth/google/calendar', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Google Calendar · ALTER.CO</title></head>' +
      '<body style="font-family:system-ui,sans-serif;background:#0B0F18;color:#E5E7EB;margin:0;padding:2rem;line-height:1.6;text-align:center;">' +
      '<h1 style="font-size:1.25rem;">Google Calendar</h1>' +
      '<p style="color:#9CA3AF;max-width:28rem;margin:1rem auto;">OAuth is not configured on this server yet. Add Google API credentials to the backend to enable sync.</p>' +
      '<p><a href="/" style="color:#60A5FA;">← Back to ALTER.CO</a></p>' +
      '</body></html>'
  )
})

app.get('/api/calendar/events', (req, res) => {
  res.json({ events: [], configured: false })
})

// ----- Health -----
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    storage: 'json',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    emailConfigured: isEmailConfigured(),
    emailProvider: (process.env.RESEND_API_KEY || '').trim()
      ? 'resend'
      : isSmtpConfigured()
        ? 'smtp'
        : 'none'
  })
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
  verifyEmailOnStartup()
})
