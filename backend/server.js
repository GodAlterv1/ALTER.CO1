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
const crypto = require('crypto')
const fs = require('fs')
const cookieParser = require('cookie-parser')
const sanitizeHtml = require('sanitize-html')
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
app.disable('x-powered-by')
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'alter-co-dev-secret-change-in-production'
const NODE_ENV = (process.env.NODE_ENV || 'development').trim()
const JWT_EXPIRES_IN = String(process.env.JWT_EXPIRES_IN || '90d').trim()
const PASSWORD_MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH || 10)
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'alco_token'
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || 'alco_csrf'

if (NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || JWT_SECRET === 'alter-co-dev-secret-change-in-production' || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a strong value in production (>= 32 chars).')
  }
}
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')

/** Google Calendar OAuth (optional). Set all three in .env to enable connect + sync. */
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim()
const GOOGLE_AUTH_CLIENT_ID = (process.env.GOOGLE_AUTH_CLIENT_ID || GOOGLE_CLIENT_ID).trim()
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim()
const GOOGLE_CLIENT_REDIRECT_URI = (process.env.GOOGLE_CLIENT_REDIRECT_URI || '').trim()
const GOOGLE_CALENDAR_SCOPES = (
  process.env.GOOGLE_CALENDAR_SCOPES ||
  'https://www.googleapis.com/auth/calendar.readonly'
).trim()

function isGoogleCalendarOAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CLIENT_REDIRECT_URI)
}

function buildGoogleOAuthUrl(userId) {
  const state = signGoogleOAuthState(userId)
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CLIENT_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  })
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
}

/** In-memory access token cache: userId -> { accessToken, expiresAt } */
const googleAccessTokenCache = new Map()

function signGoogleOAuthState(userId) {
  const payload = JSON.stringify({ userId, ts: Date.now() })
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url')
  const b64 = Buffer.from(payload, 'utf8').toString('base64url')
  return `${b64}.${sig}`
}

function verifyGoogleOAuthState(state) {
  if (!state || typeof state !== 'string') return null
  const dot = state.indexOf('.')
  if (dot < 0) return null
  const b64 = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  let payload
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8')
  } catch (e) {
    return null
  }
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url')
  if (expected !== sig) return null
  let obj
  try {
    obj = JSON.parse(payload)
  } catch (e) {
    return null
  }
  if (!obj.userId || !obj.ts) return null
  if (Date.now() - obj.ts > 15 * 60 * 1000) return null
  return obj.userId
}

function getGoogleRefreshTokenForUser(userId) {
  const users = readUsers()
  const row = users.find(u => u.id === userId)
  if (!row || !row.integrations || typeof row.integrations !== 'object') return null
  const g = row.integrations.googleCalendar
  if (!g || typeof g !== 'object') return null
  const t = g.refreshToken
  return typeof t === 'string' && t ? t : null
}

function setUserGoogleCalendarTokens(userId, { refreshToken, merge }) {
  const users = readUsers()
  const row = users.find(u => u.id === userId)
  if (!row) return false
  if (!row.integrations || typeof row.integrations !== 'object') row.integrations = {}
  if (!row.integrations.googleCalendar || typeof row.integrations.googleCalendar !== 'object') {
    row.integrations.googleCalendar = {}
  }
  const prev = row.integrations.googleCalendar.refreshToken
  if (refreshToken) {
    row.integrations.googleCalendar.refreshToken = refreshToken
  } else if (merge && prev) {
    row.integrations.googleCalendar.refreshToken = prev
  }
  row.integrations.googleCalendar.connectedAt = new Date().toISOString()
  writeUsers(users)
  googleAccessTokenCache.delete(userId)
  return true
}

function clearUserGoogleCalendar(userId) {
  const users = readUsers()
  const row = users.find(u => u.id === userId)
  if (!row || !row.integrations || typeof row.integrations !== 'object') return
  if (row.integrations.googleCalendar) delete row.integrations.googleCalendar
  writeUsers(users)
  googleAccessTokenCache.delete(userId)
}

async function exchangeGoogleAuthCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_CLIENT_REDIRECT_URI,
    grant_type: 'authorization_code'
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || 'token_exchange_failed')
    err.details = data
    throw err
  }
  return data
}

async function getGoogleAccessTokenForUser(userId) {
  const refreshToken = getGoogleRefreshTokenForUser(userId)
  if (!refreshToken) return null

  const cached = googleAccessTokenCache.get(userId)
  if (cached && cached.expiresAt > Date.now() + 60 * 1000) {
    return cached.accessToken
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error('[Google Calendar] refresh token failed:', data.error || res.status)
    return null
  }
  const accessToken = data.access_token
  const expiresIn = Number(data.expires_in) || 3600
  if (!accessToken) return null
  googleAccessTokenCache.set(userId, {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000
  })
  return accessToken
}

function mapGoogleEventToApp(ev) {
  const startObj = ev.start || {}
  const endObj = ev.end || {}
  let start
  let end
  if (startObj.dateTime) {
    start = new Date(startObj.dateTime).toISOString()
  } else if (startObj.date) {
    start = startObj.date + 'T00:00:00.000Z'
  } else {
    start = new Date().toISOString()
  }
  if (endObj.dateTime) {
    end = new Date(endObj.dateTime).toISOString()
  } else if (endObj.date) {
    end = endObj.date + 'T23:59:59.999Z'
  } else {
    end = start
  }
  return {
    id: 'google-' + String(ev.id || '').replace(/[^a-zA-Z0-9_-]/g, '_'),
    title: ev.summary || '(No title)',
    description: ev.description || '',
    start,
    end,
    color: 'event-green',
    source: 'google'
  }
}

function htmlMessagePage(title, message, extraLink) {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title}</title></head>` +
    '<body style="font-family:system-ui,sans-serif;background:#0B0F18;color:#E5E7EB;margin:0;padding:2rem;line-height:1.6;text-align:center;">' +
    `<h1 style="font-size:1.25rem;">${title}</h1>` +
    `<p style="color:#9CA3AF;max-width:28rem;margin:1rem auto;">${message}</p>` +
    (extraLink || '<p><a href="/" style="color:#60A5FA;">← Back to ALTER.CO</a></p>') +
    '</body></html>'
  )
}

function verifyGoogleCalendarOnStartup() {
  if (!GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_SECRET && !GOOGLE_CLIENT_REDIRECT_URI) {
    return
  }
  if (!isGoogleCalendarOAuthConfigured()) {
    console.warn(
      '[Google Calendar] OAuth partially configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CLIENT_REDIRECT_URI together.'
    )
  } else {
    console.log('[Google Calendar] OAuth env present — connect flow enabled.')
  }
}

// Hardening: custom CSP — Chart.js UMD may use eval(); inline script is the whole app
const SPA_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://accounts.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http: ws: wss:",
  "frame-src 'self' https://accounts.google.com https://www.gstatic.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ')

// Report-only CSP (safe tightening path without breaking the SPA yet).
// Goal: remove unsafe-eval and eventually remove unsafe-inline by migrating inline handlers.
const SPA_CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://accounts.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http: ws: wss:",
  "frame-src 'self' https://accounts.google.com https://www.gstatic.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "report-uri /api/csp-report"
].join('; ')

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', SPA_CONTENT_SECURITY_POLICY)
  res.setHeader('Content-Security-Policy-Report-Only', SPA_CONTENT_SECURITY_POLICY_REPORT_ONLY)
  // Extra hardening headers (in addition to Helmet)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader(
    'Permissions-Policy',
    [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'interest-cohort=()'
    ].join(', ')
  )
  next()
})

// CSP report receiver (kept minimal; logs only)
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/json'] }), (req, res) => {
  try {
    const body = req.body || {}
    // Avoid logging huge payloads
    const compact = JSON.stringify(body).slice(0, 5000)
    console.warn('[CSP report]', compact)
  } catch (e) {}
  res.status(204).end()
})

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // Default COOP can break Google Identity Services popups / gsi/transform postMessage back to the app.
    crossOriginOpenerPolicy: false,
    // Safe defaults (won't break your current frontend)
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 15552000, includeSubDomains: true, preload: true }
        : false
  })
)
app.use(compression())

function buildCorsOriginChecker() {
  const raw = String(process.env.CORS_ORIGIN || '').trim()
  if (!raw) return true // dev-friendly default
  const allowed = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return function (origin, cb) {
    if (!origin) return cb(null, true)
    if (allowed.includes(origin)) return cb(null, true)
    return cb(new Error('CORS blocked for origin'), false)
  }
}

app.use(cors({ origin: buildCorsOriginChecker(), credentials: true }))
// Reduce payload DoS risk (workspace/doc blobs can still be large; keep reasonable)
app.use(express.json({ limit: process.env.JSON_LIMIT || '2mb' }))
app.use(cookieParser())

const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API_PER_MIN || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
})
app.use('/api/', apiGeneralLimiter)
app.use('/api/workspace', workspaceWriteLimiter)
app.use('/api/workspace/', workspaceWriteLimiter)
app.use('/api/integrations/', integrationsLimiter)

const workspaceWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WORKSPACE_WRITES_PER_MIN || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many workspace writes, slow down.' }
})

const integrationsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_INTEGRATIONS_PER_MIN || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many integration requests, slow down.' }
})

function makeCookieOptions() {
  // Note: 'secure' requires HTTPS; keep false for local dev.
  return {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  }
}

function setAuthCookies(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...makeCookieOptions(),
    maxAge: 1000 * 60 * 60 * 24 * 90
  })
  // CSRF: double-submit cookie token (readable by JS)
  const csrf = crypto.randomBytes(24).toString('base64url')
  res.cookie(CSRF_COOKIE_NAME, csrf, {
    httpOnly: false,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 90
  })
  return csrf
}

function clearAuthCookies(res) {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' })
  res.clearCookie(CSRF_COOKIE_NAME, { path: '/' })
}

function getAuthTokenFromRequest(req) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) return header.slice(7)
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) return String(req.cookies[AUTH_COOKIE_NAME])
  return ''
}

function csrfMiddleware(req, res, next) {
  const m = (req.method || 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next()
  // Only enforce CSRF when cookie auth is present (Bearer tokens are not CSRFable)
  const hasCookieAuth = Boolean(req.cookies && req.cookies[AUTH_COOKIE_NAME])
  if (!hasCookieAuth) return next()
  const cookieToken = req.cookies[CSRF_COOKIE_NAME] ? String(req.cookies[CSRF_COOKIE_NAME]) : ''
  const headerToken = req.headers['x-csrf-token'] ? String(req.headers['x-csrf-token']) : ''
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'csrf_failed', message: 'Missing or invalid CSRF token' })
  }
  return next()
}

app.use('/api/', csrfMiddleware)

function sanitizeRichHtml(input) {
  const raw = typeof input === 'string' ? input : ''
  return sanitizeHtml(raw, {
    allowedTags: [
      'b', 'strong', 'i', 'em', 'u', 'br',
      'p', 'div', 'span',
      'ul', 'ol', 'li',
      'blockquote',
      'code', 'pre',
      'a'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true)
    }
  })
}

function sanitizeWorkspaceKey(key, value) {
  if (!key) return value
  if (!Array.isArray(value)) return value
  if (key !== 'pages') return value
  // pages[].blocks[].text can contain rich HTML; sanitize to prevent stored XSS
  return value.map(p => {
    if (!p || typeof p !== 'object') return p
    const out = { ...p }
    if (Array.isArray(out.blocks)) {
      out.blocks = out.blocks.map(b => {
        if (!b || typeof b !== 'object') return b
        if (typeof b.text === 'string') return { ...b, text: sanitizeRichHtml(b.text) }
        return b
      })
    }
    return out
  })
}

const WORKSPACE_LIMITS = {
  projects: 1000,
  tasks: 20000,
  ideas: 5000,
  events: 10000,
  goals: 5000,
  timeEntries: 20000,
  team: 500,
  notifications: 20000,
  activity: 20000,
  auditLogs: 20000,
  apiKeys: 200,
  pages: 5000
}

function assertWorkspaceKeyWithinLimits(key, value) {
  if (!key) return { ok: true }
  if (key === 'userSettings') return { ok: true }
  if (!Array.isArray(value)) return { ok: true }
  const lim = WORKSPACE_LIMITS[key]
  if (!lim) return { ok: true }
  if (value.length > lim) return { ok: false, error: 'payload_too_large', message: `"${key}" exceeds limit (${value.length} > ${lim})` }
  return { ok: true }
}

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

function normalizeInviteCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function findWorkspaceOwnerByInviteCode(rawCode) {
  const normalized = normalizeInviteCode(rawCode)
  if (normalized.length < 4) return null
  if (!fs.existsSync(WORKSPACE_DIR)) return null
  let files
  try {
    files = fs.readdirSync(WORKSPACE_DIR)
  } catch (e) {
    return null
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const userId = f.slice(0, -5)
    const ws = readWorkspace(userId)
    if (!ws || !ws.userSettings || typeof ws.userSettings.workspaceInviteCode !== 'string') continue
    const c = normalizeInviteCode(ws.userSettings.workspaceInviteCode)
    if (c && c === normalized) return userId
  }
  return null
}

/** Adds an existing user account to another user's workspace team (accepted). */
function addUserToOwnerTeam(ownerId, joinerUserId) {
  if (!ownerId) return { ok: false, error: 'invalid_code' }
  if (ownerId === joinerUserId) return { ok: false, error: 'self' }
  const users = readUsers()
  const joiner = users.find(u => u.id === joinerUserId)
  if (!joiner) return { ok: false, error: 'no_user' }
  const ownerWs = readWorkspace(ownerId) || emptyWorkspace()
  if (!ownerWs.userSettings || typeof ownerWs.userSettings !== 'object') ownerWs.userSettings = {}
  let team = Array.isArray(ownerWs.team) ? ownerWs.team.slice() : []
  const emailLower = (joiner.email || '').toLowerCase()
  // Drop stale email invites so joining by code works after an email invite was sent
  team = team.filter(m => {
    if (!m || m.status !== 'pending') return true
    return (m.email || '').toLowerCase() !== emailLower
  })
  if (team.some(m => (m.email || '').toLowerCase() === emailLower || m.id === joiner.id)) {
    return { ok: false, error: 'already_member' }
  }
  team.push({
    id: joiner.id,
    email: joiner.email || '',
    role: 'member',
    department: '',
    status: 'accepted',
    created: new Date().toISOString()
  })
  ownerWs.team = team
  writeWorkspace(ownerId, ownerWs)

  // Point the joiner's workspace at the owner's shared data so tasks/projects sync for the whole team
  const joinerWs = readWorkspace(joinerUserId) || emptyWorkspace()
  if (!joinerWs.userSettings || typeof joinerWs.userSettings !== 'object') joinerWs.userSettings = {}
  joinerWs.userSettings.workspaceOwnerId = ownerId
  writeWorkspace(joinerUserId, joinerWs)

  const owner = users.find(u => u.id === ownerId)
  return { ok: true, ownerUsername: owner ? owner.username : '' }
}

function isAcceptedTeamMember(teamArr, memberUserId) {
  if (!Array.isArray(teamArr)) return false
  return teamArr.some(m => m && m.id === memberUserId && m.status === 'accepted')
}

/**
 * Workspace JSON file to load/save for this account.
 * Team members use the owner's file so tasks, projects, and goals are shared.
 */
function resolveWorkspaceFileUserId(userId) {
  const mine = readWorkspace(userId)
  const settings = mine && mine.userSettings && typeof mine.userSettings === 'object' ? mine.userSettings : {}
  const linked = settings.workspaceOwnerId
  if (linked && typeof linked === 'string' && linked !== userId) {
    const ownerWs = readWorkspace(linked) || emptyWorkspace()
    if (isAcceptedTeamMember(ownerWs.team, userId)) return linked
  }
  if (!fs.existsSync(WORKSPACE_DIR)) return userId
  let files
  try {
    files = fs.readdirSync(WORKSPACE_DIR)
  } catch (e) {
    return userId
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const oid = f.slice(0, -5)
    if (oid === userId) continue
    const ws = readWorkspace(oid)
    if (ws && isAcceptedTeamMember(ws.team, userId)) {
      const mw = readWorkspace(userId) || emptyWorkspace()
      if (!mw.userSettings || typeof mw.userSettings !== 'object') mw.userSettings = {}
      mw.userSettings.workspaceOwnerId = oid
      writeWorkspace(userId, mw)
      return oid
    }
  }
  return userId
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

const WORKSPACE_META_KEY = '_keyUpdatedAt'

function emptyWorkspace() {
  const out = {}
  for (const k of WORKSPACE_KEYS) {
    out[k] = k === 'userSettings' ? {} : []
  }
  out[WORKSPACE_META_KEY] = {}
  return out
}

function ensureWorkspaceMeta(data) {
  if (!data || typeof data !== 'object') return {}
  if (!data[WORKSPACE_META_KEY] || typeof data[WORKSPACE_META_KEY] !== 'object' || Array.isArray(data[WORKSPACE_META_KEY])) {
    data[WORKSPACE_META_KEY] = {}
  }
  return data[WORKSPACE_META_KEY]
}

function touchWorkspaceKeyMeta(data, key) {
  const meta = ensureWorkspaceMeta(data)
  meta[key] = new Date().toISOString()
  return meta[key]
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

function normalizeUsernameBase(input) {
  const raw = String(input || '').trim().toLowerCase()
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, '_').replace(/^[_\-.]+|[_\-.]+$/g, '')
  return cleaned || 'user'
}

function nextAvailableUsername(users, desired) {
  const taken = new Set((users || []).map(u => String(u.username || '').toLowerCase()))
  const base = normalizeUsernameBase(desired)
  if (!taken.has(base)) return base
  for (let i = 1; i <= 9999; i += 1) {
    const candidate = `${base}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`
}

// Auth middleware — role always loaded from users.json (source of truth), not only from JWT
function authMiddleware(req, res, next) {
  const token = getAuthTokenFromRequest(req)
  if (!token) return res.status(401).json({ error: 'Missing authentication' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    const users = readUsers()
    const row = users.find(u => u.id === payload.userId)
    if (!row) {
      return res.status(401).json({ error: 'User not found' })
    }
    req.userId = row.id
    req.username = row.username
    req.userRole = String(row.role || 'member').toLowerCase()
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function requireAdmin(req, res, next) {
  const r = req.userRole
  if (r === 'admin' || r === 'owner') return next()
  return res.status(403).json({ error: 'Admin access required' })
}

// ----- Routes: Auth -----
app.post('/api/auth/register', authBurstLimiter, async (req, res) => {
  const { username, email, password, fullName, inviteCode } = req.body || {}
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password required' })
  }
  if (username.length < 4) {
    return res.status(400).json({ error: 'Username must be at least 4 characters' })
  }
  if (String(password).length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` })
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

  const ownerFromCode = inviteCode ? findWorkspaceOwnerByInviteCode(inviteCode) : null
  if (ownerFromCode) {
    addUserToOwnerTeam(ownerFromCode, id)
  }

  const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
  setAuthCookies(res, token)
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
  if (!row) {
    return res.status(401).json({ error: 'Invalid username or password' })
  }
  if (!row.password_hash) {
    return res.status(400).json({ error: 'This account uses Google sign-in. Continue with Google.' })
  }
  if (!comparePassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' })
  }

  const token = jwt.sign({ userId: row.id, username: row.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
  setAuthCookies(res, token)
  res.json({ token, user: userToClient(row) })
})

app.post('/api/auth/google', authBurstLimiter, async (req, res) => {
  const idToken = String((req.body && req.body.credential) || '').trim()
  if (!idToken) {
    return res.status(400).json({ error: 'Missing Google credential' })
  }
  if (!GOOGLE_AUTH_CLIENT_ID) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server' })
  }

  try {
    const verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken)
    const verifyRes = await fetch(verifyUrl)
    const verifyBody = await verifyRes.json().catch(() => ({}))
    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'Invalid Google credential' })
    }
    const aud = String(verifyBody.aud || '')
    if (aud !== GOOGLE_AUTH_CLIENT_ID) {
      return res.status(401).json({ error: 'Google token audience mismatch' })
    }
    if (String(verifyBody.email_verified || '').toLowerCase() !== 'true') {
      return res.status(400).json({ error: 'Google account email is not verified' })
    }

    const email = String(verifyBody.email || '').trim().toLowerCase()
    if (!email) {
      return res.status(400).json({ error: 'Google account did not provide an email address' })
    }

    const users = readUsers()
    const googleSub = String(verifyBody.sub || '').trim()
    let row = users.find(u => String(u.google_sub || '') === googleSub) || null
    if (!row) {
      row = users.find(u => String(u.email || '').toLowerCase() === email) || null
    }

    const nowIso = new Date().toISOString()
    if (!row) {
      const id = genId()
      const emailName = email.split('@')[0] || 'user'
      const username = nextAvailableUsername(users, emailName)
      row = {
        id,
        username,
        email,
        password_hash: '',
        full_name: String(verifyBody.name || '').trim(),
        bio: '',
        timezone: 'UTC',
        role: 'member',
        plan: 'free',
        created_at: nowIso,
        google_sub: googleSub,
        auth_provider: 'google',
        avatar_url: String(verifyBody.picture || '').trim()
      }
      users.push(row)
      writeUsers(users)
      writeWorkspace(id, emptyWorkspace())
    } else {
      let dirty = false
      if (!row.google_sub && googleSub) {
        row.google_sub = googleSub
        dirty = true
      }
      if (!row.auth_provider) {
        row.auth_provider = 'google'
        dirty = true
      }
      if (!row.full_name && verifyBody.name) {
        row.full_name = String(verifyBody.name).trim()
        dirty = true
      }
      if (!row.avatar_url && verifyBody.picture) {
        row.avatar_url = String(verifyBody.picture).trim()
        dirty = true
      }
      if (dirty) writeUsers(users)
    }

    const token = jwt.sign({ userId: row.id, username: row.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
    setAuthCookies(res, token)
    return res.json({ token, user: userToClient(row) })
  } catch (e) {
    console.error('Google auth failed', e)
    return res.status(500).json({ error: 'Google sign-in failed' })
  }
})

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookies(res)
  res.json({ ok: true })
})

app.get('/api/auth/csrf', (req, res) => {
  // Allows frontend to bootstrap CSRF cookie even before auth.
  const csrf = crypto.randomBytes(24).toString('base64url')
  res.cookie(CSRF_COOKIE_NAME, csrf, {
    httpOnly: false,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 7
  })
  res.json({ ok: true })
})

// Login/register are POST-only; a GET (e.g. opening the URL in a tab) would otherwise show "Cannot GET"
app.get('/api/auth/login', (req, res) => {
  res.set('Allow', 'POST')
  res.status(405).json({
    error: 'Method not allowed',
    hint:
      'Sign in from the app home page (POST /api/auth/login with JSON { "username", "password" }). Do not open this path in the browser address bar.'
  })
})

app.get('/api/auth/register', (req, res) => {
  res.set('Allow', 'POST')
  res.status(405).json({
    error: 'Method not allowed',
    hint: 'Create an account from the app (POST /api/auth/register). Do not open this path in the browser address bar.'
  })
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

// ----- Admin (authoritative role in users.json; JWT does not carry role alone) -----
app.get('/api/admin/users', authMiddleware, requireAdmin, (req, res) => {
  const users = readUsers()
  res.json({
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email || '',
      role: u.role || 'member',
      plan: u.plan || 'free',
      created_at: u.created_at
    }))
  })
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
  const fileUserId = resolveWorkspaceFileUserId(req.userId)
  let data = readWorkspace(fileUserId)
  if (!data || typeof data !== 'object') data = emptyWorkspace()
  const meta = ensureWorkspaceMeta(data)
  const out = emptyWorkspace()
  for (const k of WORKSPACE_KEYS) {
    if (data[k] !== undefined && data[k] !== null) {
      out[k] = Array.isArray(data[k]) ? data[k] : (k === 'userSettings' && typeof data[k] === 'object' ? data[k] : out[k])
    }
  }
  out[WORKSPACE_META_KEY] = meta
  // team[] only lists invitees — the JSON file owner is implicit. Expose owner so members can see who runs the workspace.
  const users = readUsers()
  const ownerRow = users.find(u => u.id === fileUserId)
  const workspaceOwnerSummary = ownerRow
    ? {
        id: ownerRow.id,
        username: ownerRow.username || '',
        email: ownerRow.email || '',
        fullName: ownerRow.full_name || '',
        role: ownerRow.role || 'member'
      }
    : null
  res.json({ ...out, workspaceOwnerSummary })
})

app.put('/api/workspace', authMiddleware, (req, res) => {
  const fileUserId = resolveWorkspaceFileUserId(req.userId)
  const data = req.body || {}
  const current = readWorkspace(fileUserId) || emptyWorkspace()
  ensureWorkspaceMeta(current)
  for (const key of WORKSPACE_KEYS) {
    if (data[key] !== undefined) {
      const check = assertWorkspaceKeyWithinLimits(key, data[key])
      if (!check.ok) return res.status(413).json({ error: check.error, message: check.message, key })
      current[key] = sanitizeWorkspaceKey(key, data[key])
      touchWorkspaceKeyMeta(current, key)
    }
  }
  writeWorkspace(fileUserId, current)
  res.json({ ok: true, keyUpdatedAt: current[WORKSPACE_META_KEY] || {} })
})

// Partial workspace update for backend-first writes (e.g. tasks/team updates)
app.patch('/api/workspace/:key', authMiddleware, (req, res) => {
  const key = String(req.params.key || '').trim()
  if (!WORKSPACE_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Invalid workspace key' })
  }

  const data = req.body || {}
  if (!Object.prototype.hasOwnProperty.call(data, 'value')) {
    return res.status(400).json({ error: 'Missing "value" in request body' })
  }

  const value = data.value
  const expectedUpdatedAt = data.expectedUpdatedAt ? String(data.expectedUpdatedAt) : ''
  const expectObject = key === 'userSettings'
  if (expectObject && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    return res.status(400).json({ error: `"${key}" must be an object` })
  }
  if (!expectObject && !Array.isArray(value)) {
    return res.status(400).json({ error: `"${key}" must be an array` })
  }
  const check = assertWorkspaceKeyWithinLimits(key, value)
  if (!check.ok) return res.status(413).json({ error: check.error, message: check.message, key })

  const fileUserId = resolveWorkspaceFileUserId(req.userId)
  const current = readWorkspace(fileUserId) || emptyWorkspace()
  const meta = ensureWorkspaceMeta(current)
  const currentUpdatedAt = meta[key] ? String(meta[key]) : ''
  if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
    return res.status(409).json({
      error: 'stale_write',
      message: 'Workspace data changed since last read',
      key,
      currentUpdatedAt
    })
  }
  current[key] = sanitizeWorkspaceKey(key, value)
  const updatedAt = touchWorkspaceKeyMeta(current, key)
  writeWorkspace(fileUserId, current)
  res.json({ ok: true, key, updatedAt })
})

// Join another user's workspace team using their workspace invite code (from userSettings.workspaceInviteCode)
app.post('/api/team/join-with-code', authMiddleware, authBurstLimiter, (req, res) => {
  const { code } = req.body || {}
  const ownerId = findWorkspaceOwnerByInviteCode(code || '')
  if (!ownerId) {
    return res.status(404).json({ error: 'Invalid invite code' })
  }
  const result = addUserToOwnerTeam(ownerId, req.userId)
  if (!result.ok) {
    if (result.error === 'already_member') {
      return res.status(409).json({ error: 'You are already on this team' })
    }
    if (result.error === 'self') {
      return res.status(400).json({ error: 'You cannot use your own workspace code' })
    }
    return res.status(400).json({ error: 'Could not join workspace' })
  }
  res.json({ ok: true, workspaceOwnerUsername: result.ownerUsername || '' })
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

app.post('/api/integrations/email/mention', authMiddleware, async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(503).json({ error: 'Email not configured on server' })
    }
    const { to, contextLabel, snippet, linkType, linkId } = req.body || {}
    if (!to || !String(to).includes('@')) {
      return res.status(400).json({ error: 'Missing or invalid "to" email' })
    }
    const fromUser = req.username || 'A teammate'
    const ctx = contextLabel ? String(contextLabel).slice(0, 200) : 'ALTER.CO'
    const snip = snippet ? String(snippet).slice(0, 800) : ''
    const lt = linkType ? String(linkType) : ''
    const lid = linkId ? String(linkId) : ''
    const ok = await sendEmailSafe({
      to: String(to).trim(),
      subject: `You were mentioned in ALTER.CO — ${ctx}`,
      text:
        `${fromUser} mentioned you.\n\n` +
        `Where: ${ctx}\n` +
        (snip ? `\n"${snip}"\n` : '\n') +
        (lt && lid ? `\nContext: ${lt} (${lid})\n` : '') +
        `\nOpen ALTER.CO to see the full thread and reply.\n`
    })
    if (!ok) {
      return res.status(500).json({ error: 'Failed to send mention email' })
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('Error sending mention email', e)
    res.status(500).json({ error: 'Failed to send mention email' })
  }
})

// ----- Integrations: Google Calendar OAuth + read-only sync -----
app.get('/api/integrations/google/calendar/start', authMiddleware, (req, res) => {
  if (!isGoogleCalendarOAuthConfigured()) {
    return res.status(503).json({
      error: 'Google Calendar OAuth is not configured on this server',
      configured: false
    })
  }
  const authUrl = buildGoogleOAuthUrl(req.userId)
  res.json({ configured: true, authUrl })
})

/**
 * Start OAuth: GET /auth/google/calendar?token=JWT
 * (Browser navigation cannot send Authorization headers; token is short-lived JWT from login.)
 */
app.get('/auth/google/calendar', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  if (!isGoogleCalendarOAuthConfigured()) {
    return res.send(
      htmlMessagePage(
        'Google Calendar',
        'OAuth is not configured on this server yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CLIENT_REDIRECT_URI to the backend environment (see backend/.env.example), then restart.'
      )
    )
  }

  const token = typeof req.query.token === 'string' ? req.query.token.trim() : ''
  if (!token) {
    return res.send(
      htmlMessagePage(
        'Sign in required',
        'Open ALTER.CO, sign in, then click “Connect Google Calendar” again so your session can be linked.'
      )
    )
  }

  let userId
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    userId = payload.userId
  } catch (e) {
    return res.status(401).send(htmlMessagePage('Session expired', 'Please sign in to ALTER.CO again, then retry connecting Google Calendar.'))
  }

  if (!userId) {
    return res.status(401).send(htmlMessagePage('Invalid session', 'Please sign in again.'))
  }

  res.redirect(302, buildGoogleOAuthUrl(userId))
})

app.get('/auth/google/calendar/callback', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  const frontendBase = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '')
  const fallbackRedirect = `${req.protocol}://${req.get('host')}`
  const appBase = frontendBase || fallbackRedirect

  if (req.query.error) {
    const msg = encodeURIComponent(String(req.query.error))
    return res.redirect(302, `${appBase}/?google_calendar=error&reason=${msg}`)
  }

  if (!isGoogleCalendarOAuthConfigured()) {
    return res.send(htmlMessagePage('Google Calendar', 'OAuth is not configured on this server.'))
  }

  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const userId = verifyGoogleOAuthState(state)
  if (!code || !userId) {
    return res.send(htmlMessagePage('Google Calendar', 'Invalid or expired OAuth state. Try connecting again from ALTER.CO.'))
  }

  try {
    const tokens = await exchangeGoogleAuthCode(code)
    const refresh = tokens.refresh_token || null
    const users = readUsers()
    const existing = users.find(u => u.id === userId)
    const existingRefresh =
      existing &&
      existing.integrations &&
      existing.integrations.googleCalendar &&
      existing.integrations.googleCalendar.refreshToken

    if (!refresh && !existingRefresh) {
      return res.redirect(
        302,
        `${appBase}/?google_calendar=error&reason=${encodeURIComponent('no_refresh_token')}`
      )
    }

    setUserGoogleCalendarTokens(userId, {
      refreshToken: refresh || undefined,
      merge: true
    })
    return res.redirect(302, `${appBase}/?google_calendar=connected`)
  } catch (e) {
    console.error('[Google Calendar] callback error:', e && e.message ? e.message : e)
    return res.redirect(302, `${appBase}/?google_calendar=error&reason=token_exchange`)
  }
})

app.get('/api/integrations/google/calendar/status', authMiddleware, (req, res) => {
  const configured = isGoogleCalendarOAuthConfigured()
  const connected = Boolean(getGoogleRefreshTokenForUser(req.userId))
  res.json({ configured, connected })
})

app.post('/api/integrations/google/calendar/disconnect', authMiddleware, (req, res) => {
  clearUserGoogleCalendar(req.userId)
  res.json({ ok: true })
})

app.get('/api/calendar/events', authMiddleware, async (req, res) => {
  if (!isGoogleCalendarOAuthConfigured()) {
    return res.status(503).json({
      error: 'Google Calendar OAuth is not configured on this server',
      configured: false,
      connected: false,
      events: []
    })
  }

  const refresh = getGoogleRefreshTokenForUser(req.userId)
  if (!refresh) {
    return res.json({ configured: true, connected: false, events: [] })
  }

  const timeMin = typeof req.query.start === 'string' ? req.query.start : new Date().toISOString()
  const timeMax = typeof req.query.end === 'string' ? req.query.end : new Date(Date.now() + 86400000 * 31).toISOString()

  const accessToken = await getGoogleAccessTokenForUser(req.userId)
  if (!accessToken) {
    return res.status(401).json({
      error: 'Could not refresh Google access token. Try disconnecting and connecting again.',
      configured: true,
      connected: true,
      events: []
    })
  }

  const calParams = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250'
  })
  const calUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + calParams.toString()

  try {
    const gRes = await fetch(calUrl, {
      headers: { Authorization: 'Bearer ' + accessToken }
    })
    const data = await gRes.json().catch(() => ({}))
    if (!gRes.ok) {
      console.error('[Google Calendar] events.list error:', gRes.status, data.error || data)
      return res.status(502).json({
        error: 'Google Calendar API error',
        configured: true,
        connected: true,
        events: []
      })
    }
    const items = Array.isArray(data.items) ? data.items : []
    const events = items.map(mapGoogleEventToApp)
    res.json({ configured: true, connected: true, events })
  } catch (e) {
    console.error('[Google Calendar] fetch events:', e)
    res.status(500).json({ error: 'Failed to load calendar events', events: [] })
  }
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
        : 'none',
    googleCalendarOAuthConfigured: isGoogleCalendarOAuthConfigured(),
    googleAuthConfigured: Boolean(GOOGLE_AUTH_CLIENT_ID),
    googleAuthClientId: GOOGLE_AUTH_CLIENT_ID || ''
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
  verifyGoogleCalendarOnStartup()
})
