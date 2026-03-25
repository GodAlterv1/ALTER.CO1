/* ===================================================
   STATE
=================================================== */
let currentUser   = null

/** Safe JSON parse from localStorage — avoids blank screen if storage is corrupted */
function loadStored(key, defaultValue) {
  try {
    const raw = localStorage.getItem('alco_' + key)
    if (raw == null || raw === '') return defaultValue
    return JSON.parse(raw)
  } catch (e) {
    console.warn('ALTER.CO: could not parse alco_' + key, e)
    return defaultValue
  }
}

let users         = loadStored('users', [{ id:'1', username:'admin', password:'admin123', email:'admin@alter.co', fullName:'Admin User', role:'admin', bio:'', timezone:'UTC', plan:'free', created: new Date().toISOString() }])
let projects      = loadStored('projects', [])
let tasks         = loadStored('tasks', [])
let ideas         = loadStored('ideas', [])
let events        = loadStored('events', [])
let goals         = loadStored('goals', [])
// Google Calendar integration state (frontend-only; backend will fill these)
let googleCalendarConnected = false
let googleCalendarEvents    = []
let googleCalendarConfigured = true
let preferredTaskAssigneeId = ''
let team          = loadStored('team', [])
let notifications = loadStored('notifications', [])
let activity      = loadStored('activity', [])
let timeEntries   = loadStored('time', [])
let auditLogs     = loadStored('audit', [])
let apiKeys       = loadStored('apikeys', [])
let invoices      = loadStored('invoices', [])
let userSettings  = loadStored('usersettings', {})
let pages         = loadStored('pages', [])
// Ensure calendar state exists before any boot logic runs
var currentDate  = new Date()

function applyThemeFromSettings() {
  // Dark mode only
  try {
    document.documentElement.setAttribute('data-theme', 'dark')
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', '#0B0F18')
  } catch (e) {}
}

;(function () {
  var meta = document.getElementById('alterApiBaseMeta')
  var fromMeta = meta && meta.getAttribute('content') && meta.getAttribute('content').trim()
  if (typeof window.location !== 'undefined' && window.location.origin && window.location.protocol !== 'file:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    window.ALTER_API_BASE = window.location.origin
    return
  }
  window.ALTER_API_BASE = fromMeta || ''
})()
var ALTER_API_BASE = window.ALTER_API_BASE || ''

// Accessibility: auto-associate <label> with the nearest form control id.
// This avoids hundreds of manual markup fixes in this single-file HTML app.
function autoAssociateLabelsWithInputs() {
  /** @type {NodeListOf<HTMLLabelElement>} */
  const labels = document.querySelectorAll('label:not([for])')
  let autoIdCounter = 0
  labels.forEach(label => {
    // If the label already wraps a form control, the association is already valid.
    if (label.querySelector('input[id], textarea[id], select[id]')) return

    // Most of our markup uses a structure like:
    // <div class="form-group"><label>Text</label><input id="..."></div>
    const parent = label.parentElement
    if (!parent) return

    const control = parent.querySelector('input[id], textarea[id], select[id]')
    if (!control) return

    let id = control.getAttribute('id')
    if (!id) {
      // Some of your markup has inputs without ids; create a stable one so labels associate correctly.
      autoIdCounter += 1
      id = 'alco_auto_input_' + autoIdCounter
      control.setAttribute('id', id)
    }
    label.setAttribute('for', id)
  })
}

// Run after the script loads (script tag is near the end of <body>).
autoAssociateLabelsWithInputs()
applyThemeFromSettings()

var syncWorkspaceTimeout = null
var currentNotificationFilter = 'all'
var workspaceKeyUpdatedAt = {}
/** Set from GET /api/workspace — owner of the shared JSON file (not duplicated in team[]). */
var workspaceOwnerSummary = null
var googleAuthClientId = ''
var googleAuthInitAttempted = false
var liveWorkspaceRefreshTimer = null
var liveWorkspaceRefreshInFlight = false
var lastLiveWorkspaceRefreshAt = ''
var liveWorkspaceErrorCount = 0
var presenceHeartbeatTimer = null
let pendingConfirm = null

function getAuthToken() {
  var raw = localStorage.getItem('alco_token') || ''
  if (raw === 'undefined' || raw === 'null') return ''
  return raw
}
function setAuthToken(t) { if (t) localStorage.setItem('alco_token', t); else localStorage.removeItem('alco_token') }
function clearAuthToken() { localStorage.removeItem('alco_token') }

function getCookieValue(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : ''
  } catch (e) {
    return ''
  }
}

function getCsrfToken() {
  return getCookieValue('alco_csrf')
}

// Security: make API calls cookie-friendly (httpOnly auth cookies + CSRF header)
;(function patchFetchForAlterApi() {
  if (window.__alcoFetchPatched) return
  window.__alcoFetchPatched = true
  const origFetch = window.fetch.bind(window)
  window.fetch = function (url, opts) {
    try {
      const u = String(url || '')
      const base = String(ALTER_API_BASE || '')
      const isAlterApi = base && u.startsWith(base)
      if (!isAlterApi) return origFetch(url, opts)

      const o = opts ? { ...opts } : {}
      o.credentials = 'include'
      o.headers = o.headers ? { ...o.headers } : {}

      const method = String(o.method || 'GET').toUpperCase()
      const csrf = getCsrfToken()
      if (csrf && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        if (!o.headers['X-CSRF-Token'] && !o.headers['x-csrf-token']) {
          o.headers['X-CSRF-Token'] = csrf
        }
      }

      // Backward compatibility: keep Bearer header if localStorage token exists.
      const t = getAuthToken()
      if (t && !o.headers['Authorization'] && !o.headers['authorization']) {
        o.headers['Authorization'] = 'Bearer ' + t
      }

      return origFetch(url, o)
    } catch (e) {
      return origFetch(url, opts)
    }
  }
})()

function ensureCurrentUser() {
  if (currentUser && currentUser.id) return currentUser
  try {
    const session = JSON.parse(localStorage.getItem('alco_session'))
    if (session && session.id) {
      currentUser = session
      return currentUser
    }
  } catch (e) {}
  return null
}

function loadWorkspaceFromBackend() {
  if (!ALTER_API_BASE) return Promise.resolve(null)
  return fetch(ALTER_API_BASE + '/api/workspace', {
    headers: {}
  }).then(function (r) {
    if (r.status === 401) {
      clearAuthToken()
      throw new Error('Unauthorized')
    }
    if (!r.ok) throw new Error('Load failed')
    return r.json()
  })
}

function setLiveSyncStatus(text, color) {
  var el = document.getElementById('topbarSyncStatus')
  if (!el) return
  el.textContent = text
  if (color) el.style.color = color
}

function getChangedWorkspaceKeys(prevMeta, nextMeta) {
  var keys = ['projects', 'tasks', 'events', 'goals', 'team', 'notifications', 'activity', 'auditLogs']
  var out = []
  keys.forEach(function (k) {
    var a = prevMeta && prevMeta[k] ? String(prevMeta[k]) : ''
    var b = nextMeta && nextMeta[k] ? String(nextMeta[k]) : ''
    if (a && b && a !== b) out.push(k)
  })
  return out
}

function stopLiveWorkspaceRefreshLoop() {
  if (liveWorkspaceRefreshTimer) clearTimeout(liveWorkspaceRefreshTimer)
  liveWorkspaceRefreshTimer = null
  liveWorkspaceRefreshInFlight = false
  liveWorkspaceErrorCount = 0
  setLiveSyncStatus('Live sync off', '#6B7280')
}

function scheduleLiveWorkspaceRefresh(delayMs) {
  if (liveWorkspaceRefreshTimer) clearTimeout(liveWorkspaceRefreshTimer)
  liveWorkspaceRefreshTimer = setTimeout(function () {
    liveWorkspaceRefreshTimer = null
    refreshWorkspaceLive(false)
  }, Math.max(1000, delayMs || 15000))
}

function refreshWorkspaceLive(forceToast) {
  if (!ALTER_API_BASE || !currentUser) return
  if (liveWorkspaceRefreshInFlight) return
  liveWorkspaceRefreshInFlight = true
  setLiveSyncStatus('Syncing...', '#9CA3AF')
  loadWorkspaceFromBackend()
    .then(function (fresh) {
      if (!fresh) return
      var oldMeta = workspaceKeyUpdatedAt || {}
      var nextMeta = (fresh && fresh._keyUpdatedAt && typeof fresh._keyUpdatedAt === 'object') ? fresh._keyUpdatedAt : {}
      var changed = getChangedWorkspaceKeys(oldMeta, nextMeta)
      applyWorkspaceToState(fresh)
      if (changed.length) {
        renderAllPages()
        renderNotifications()
        if (forceToast || document.visibilityState === 'visible') {
          showToast('Workspace updated: ' + changed.join(', '), 'info')
        }
      }
      liveWorkspaceErrorCount = 0
      lastLiveWorkspaceRefreshAt = new Date().toISOString()
      setLiveSyncStatus('Live · ' + timeAgo(lastLiveWorkspaceRefreshAt), '#6B7280')
    })
    .catch(function (err) {
      liveWorkspaceErrorCount += 1
      if (err && err.message === 'Unauthorized') {
        stopLiveWorkspaceRefreshLoop()
        return
      }
      if (!currentUser) {
        stopLiveWorkspaceRefreshLoop()
        return
      }
      if (liveWorkspaceErrorCount >= 3) {
        setLiveSyncStatus('Live sync paused', '#f59e0b')
        showToast('Live sync paused due to repeated server errors. Refresh to retry.', 'warning')
        if (liveWorkspaceRefreshTimer) clearTimeout(liveWorkspaceRefreshTimer)
        liveWorkspaceRefreshTimer = null
        liveWorkspaceRefreshInFlight = false
        return
      }
      setLiveSyncStatus('Sync issue', '#f59e0b')
    })
    .finally(function () {
      liveWorkspaceRefreshInFlight = false
      var nextDelay = document.visibilityState === 'visible' ? 15000 : 30000
      scheduleLiveWorkspaceRefresh(nextDelay)
    })
}

function startLiveWorkspaceRefreshLoop() {
  if (!ALTER_API_BASE || !currentUser) {
    stopLiveWorkspaceRefreshLoop()
    return
  }
  liveWorkspaceErrorCount = 0
  setLiveSyncStatus('Live sync on', '#10B981')
  scheduleLiveWorkspaceRefresh(2500)
}

/**
 * When live sync GET runs before a PATCH finishes, the server snapshot may omit rows
 * just created locally. Re-attach any local-only items (same pattern as offline-first).
 */
function mergeWorkspaceArrayWithPendingLocal(serverArr, localArr) {
  const server = Array.isArray(serverArr) ? serverArr : []
  const local = Array.isArray(localArr) ? localArr : []
  const serverIds = new Set(server.filter(x => x && x.id).map(x => x.id))
  const pending = local.filter(x => x && x.id && !serverIds.has(x.id))
  return server.concat(pending)
}

function applyWorkspaceToState(data) {
  if (!data) return
  if (Array.isArray(data.projects)) projects = data.projects
  if (Array.isArray(data.tasks)) tasks = data.tasks
  if (Array.isArray(data.ideas)) ideas = data.ideas
  if (Array.isArray(data.events)) events = data.events
  if (Array.isArray(data.goals)) {
    const serverIds = new Set(data.goals.filter(x => x && x.id).map(x => x.id))
    const pendingLocalGoals = goals.filter(x => x && x.id && !serverIds.has(x.id))
    goals = mergeWorkspaceArrayWithPendingLocal(data.goals, goals)
    try {
      localStorage.setItem('alco_goals', JSON.stringify(goals))
    } catch (e) {}
    if (pendingLocalGoals.length && ALTER_API_BASE) {
      scheduleSyncWorkspace()
    }
  }
  if (Array.isArray(data.timeEntries)) timeEntries = data.timeEntries
  if (Array.isArray(data.team)) team = data.team
  if (Array.isArray(data.notifications)) notifications = data.notifications
  if (Array.isArray(data.activity)) activity = data.activity
  if (Array.isArray(data.auditLogs)) auditLogs = data.auditLogs
  if (Array.isArray(data.invoices)) invoices = data.invoices
  if (Array.isArray(data.apiKeys)) apiKeys = data.apiKeys
  if (Array.isArray(data.pages)) pages = data.pages
  if (data.userSettings && typeof data.userSettings === 'object') userSettings = data.userSettings
  if (data._keyUpdatedAt && typeof data._keyUpdatedAt === 'object') {
    workspaceKeyUpdatedAt = data._keyUpdatedAt
  }
  if (data.workspaceOwnerSummary && typeof data.workspaceOwnerSummary === 'object' && data.workspaceOwnerSummary.id) {
    workspaceOwnerSummary = data.workspaceOwnerSummary
  } else {
    workspaceOwnerSummary = null
  }
}

function syncWorkspaceToBackend() {
  var token = getAuthToken()
  if (!ALTER_API_BASE || !token) return Promise.resolve()
  var payload = {
    projects: projects,
    tasks: tasks,
    ideas: ideas,
    events: events,
    goals: goals,
    timeEntries: timeEntries,
    team: team,
    notifications: notifications,
    activity: activity,
    auditLogs: auditLogs,
    invoices: invoices,
    apiKeys: apiKeys,
    userSettings: userSettings,
    pages: pages
  }
  return fetch(ALTER_API_BASE + '/api/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(payload)
  }).then(function (r) {
    if (r.status === 401) clearAuthToken()
    if (!r.ok) return null
    return r.json().catch(function () { return null })
  }).then(function (body) {
    if (body && body.keyUpdatedAt && typeof body.keyUpdatedAt === 'object') {
      workspaceKeyUpdatedAt = body.keyUpdatedAt
    }
  }).catch(function () {})
}

function syncWorkspaceKeyToBackend(key, value) {
  var token = getAuthToken()
  if (!ALTER_API_BASE || !token || !key) return Promise.resolve(false)
  var expectedUpdatedAt = workspaceKeyUpdatedAt && workspaceKeyUpdatedAt[key] ? workspaceKeyUpdatedAt[key] : ''
  return fetch(ALTER_API_BASE + '/api/workspace/' + encodeURIComponent(key), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ value: value, expectedUpdatedAt: expectedUpdatedAt })
  }).then(function (r) {
    if (r.status === 401) clearAuthToken()
    if (r.status === 409) {
      loadWorkspaceFromBackend().then(function (fresh) {
        if (!fresh) return
        applyWorkspaceToState(fresh)
        renderAllPages()
        showToast('Workspace data changed by another user. Reloaded latest.', 'warning')
      }).catch(function () {})
      return false
    }
    if (!r.ok) return false
    return r.json().then(function (body) {
      if (body && body.key && body.updatedAt) {
        workspaceKeyUpdatedAt[body.key] = body.updatedAt
      }
      return true
    }).catch(function () { return true })
  }).catch(function () {
    return false
  })
}

function toWorkspaceStorageKey(localKey) {
  if (localKey === 'audit') return 'auditLogs'
  if (localKey === 'time') return 'timeEntries'
  if (localKey === 'usersettings') return 'userSettings'
  return localKey
}

function scheduleSyncWorkspace() {
  if (!ALTER_API_BASE) return
  if (syncWorkspaceTimeout) clearTimeout(syncWorkspaceTimeout)
  syncWorkspaceTimeout = setTimeout(function () {
    syncWorkspaceTimeout = null
    syncWorkspaceToBackend()
  }, 600)
}

var charts       = {}
currentDate  = new Date()
let draggedTaskId= null
let currentTaskDetailId = null
let currentProjectDetailId = null
// Calendar view state
var calendarView = 'month'           // 'month' or 'week' (week is UI-only for now)
var selectedCalendarDate = null      // 'YYYY-MM-DD'
var draggedCalendarEventId = null
var draggedCalendarOccurrenceId = null
var lastCalendarUndoAction = null
var calendarConflictSuggestions = []

// Billing state
let billingPeriod = 'monthly' // 'monthly' or 'yearly'

// Pages / Blocks editor state
let currentPageId = null
let blockInsertIndex = null
let blockInsertMenuVisible = false
let docsZoom = 1
let docsTemplatesBuilt = false
let blocksEditorHandlersBound = false
let currentBlockIndex = null

// Docs history (per page) for undo/redo
const DOCS_HISTORY_LIMIT = 80
const docsHistoryByPageId = {}
let docsInputDebounceT = null
let docsEditSessionKey = '' // used to avoid snapshot spam while typing in same block

// Timer state (session = started but not finished with Stop)
let timerRunning   = false
let timerSessionActive = false
let timerStartTime = null
let timerInterval  = null
let timerSeconds   = 0

// Keyboard shortcut state
let keySequence = []
let keyTimer    = null
let keyboardShortcutsBound = false

// Onboarding
const ONBOARDING_STEPS = [
  { icon: '🚀', title: 'Welcome to ALTER.CO!', desc: 'Your all-in-one workspace for managing projects, tracking time, and collaborating with your team. Let\'s get you set up.' },
  { icon: '📁', title: 'Create Your First Project', desc: 'Projects are the backbone of your workspace. Head to Projects and click "+ New Project" to organize your work.' },
  { icon: '✅', title: 'Manage Tasks with Kanban', desc: 'Break projects into tasks and drag them across columns — To Do, In Progress, Review, and Done.' },
  { icon: '⏱', title: 'Track Your Time', desc: 'Use the built-in time tracker to log hours against projects and get accurate reports on team productivity.' },
  { icon: '💡', title: 'Capture & Vote on Ideas', desc: 'Submit ideas, vote on them, and convert the best ones directly into actionable tasks.' },
  { icon: '🎉', title: 'You\'re All Set!', desc: 'Explore the Analytics, Audit Log, and Billing sections to get the most out of ALTER.CO. Let\'s build something great!' }
]

let currentOnboardingStep = 0

// Billing plans (must be before boot so renderBilling can use it)
const PLANS = [
  { id: 'free', name: 'Free', price: 0, priceYearly: 0, priceLabel: 'Forever free', priceLabelYearly: 'Forever free', desc: 'For individuals and small teams getting started', features: [ { text: '3 projects', ok: true }, { text: 'Unlimited tasks', ok: true }, { text: 'Basic analytics', ok: true }, { text: 'Time tracking', ok: true }, { text: 'Team (up to 3)', ok: true }, { text: 'Priority support', ok: false }, { text: 'Advanced reports', ok: false }, { text: 'API access', ok: false } ] },
  { id: 'pro', name: 'Pro', price: 29, priceYearly: 23, priceLabel: 'per workspace / month', priceLabelYearly: 'billed yearly (save ~20%)', desc: 'For growing teams that need more power', features: [ { text: 'Unlimited projects', ok: true }, { text: 'Unlimited tasks', ok: true }, { text: 'Advanced analytics', ok: true }, { text: 'Time tracking & reports', ok: true }, { text: 'Team (up to 25)', ok: true }, { text: 'Priority support', ok: true }, { text: 'Advanced reports', ok: true }, { text: 'API access (coming soon)', ok: false } ], popular: true },
  { id: 'enterprise', name: 'Enterprise', price: 99, priceYearly: 79, priceLabel: 'per workspace / month', priceLabelYearly: 'billed yearly (save ~20%)', desc: 'For large organizations with advanced needs', features: [ { text: 'Unlimited everything', ok: true }, { text: 'Custom integrations', ok: true }, { text: 'Advanced analytics', ok: true }, { text: 'Time tracking & reports', ok: true }, { text: 'Unlimited team members', ok: true }, { text: 'Dedicated support', ok: true }, { text: 'SLA guarantee', ok: true }, { text: 'Full API access', ok: true } ] }
]

/* ===================================================
   HELPERS
=================================================== */
// Global error capture (keeps app from failing silently)
var lastAppError = null

function getLastErrorText() {
  if (!lastAppError) return ''
  try {
    return JSON.stringify(lastAppError, null, 2)
  } catch (e) {
    return String(lastAppError?.message || 'Unknown error')
  }
}

function showAppErrorBanner(summary) {
  let banner = document.getElementById('appErrorBanner')
  let msgEl  = document.getElementById('appErrorBannerMsg')
  if (!banner || !msgEl) return
  msgEl.textContent = summary || 'An unexpected error happened.'
  banner.classList.add('active')
}

function dismissAppError() {
  let banner = document.getElementById('appErrorBanner')
  if (banner) banner.classList.remove('active')
}

function copyLastError() {
  let text = getLastErrorText()
  if (!text) return showToast('No error details available', 'info')
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Error details copied', 'success'))
      .catch(() => {
        console.log('Error details:', text)
        showToast('Copy failed — details logged in console', 'warning')
      })
  } else {
    console.log('Error details:', text)
    showToast('Clipboard not available — details logged in console', 'info')
  }
}

function logAppError(payload) {
  lastAppError = payload
  try {
    let key = 'alco_errorlog'
    let list = JSON.parse(localStorage.getItem(key) || '[]')
    list.unshift(payload)
    if (list.length > 25) list = list.slice(0, 25)
    localStorage.setItem(key, JSON.stringify(list))
  } catch (e) {
    // ignore storage failures
  }
}

function initGlobalErrorCapture() {
  if (window.__alcoErrorCaptureInit) return
  window.__alcoErrorCaptureInit = true

  window.addEventListener('error', function (event) {
    let payload = {
      type: 'error',
      message: String(event?.message || 'Unknown error'),
      source: event?.filename || '',
      line: event?.lineno || null,
      col: event?.colno || null,
      stack: event?.error?.stack || '',
      time: new Date().toISOString(),
      page: document.getElementById('topbarTitle')?.textContent || ''
    }
    logAppError(payload)
    showAppErrorBanner(payload.message)
  })

  window.addEventListener('unhandledrejection', function (event) {
    let reason = event?.reason
    let message = (reason && (reason.message || reason.toString)) ? (reason.message || String(reason)) : 'Unhandled promise rejection'
    let payload = {
      type: 'unhandledrejection',
      message: String(message || 'Unhandled promise rejection'),
      stack: reason?.stack || '',
      time: new Date().toISOString(),
      page: document.getElementById('topbarTitle')?.textContent || ''
    }
    logAppError(payload)
    showAppErrorBanner(payload.message)
  })
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;')
}

function save(key, data) {
  localStorage.setItem('alco_' + key, JSON.stringify(data))
  if (ALTER_API_BASE && getAuthToken()) {
    // Backend-first for collaboration-heavy keys. Keep local cache as fallback/offline copy.
    var workspaceKey = toWorkspaceStorageKey(key)
    var backendFirstKeys = {
      projects: true,
      tasks: true,
      events: true,
      goals: true,
      team: true,
      notifications: true,
      activity: true,
      auditLogs: true
    }
    if (backendFirstKeys[workspaceKey]) {
      syncWorkspaceKeyToBackend(workspaceKey, data).then(function (ok) {
        // If partial sync fails, fall back to full workspace sync attempt.
        if (!ok) scheduleSyncWorkspace()
      })
      return
    }
    scheduleSyncWorkspace()
  }
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5) }

function formatDuration(seconds) {
  let h = Math.floor(seconds / 3600)
  let m = Math.floor((seconds % 3600) / 60)
  let s = seconds % 60
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

function formatHours(seconds) {
  return (seconds / 3600).toFixed(1) + 'h'
}

function timeAgo(iso) {
  let diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago'
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago'
  return Math.floor(diff/86400000) + 'd ago'
}

function toLocalDateTimeInputValue(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${hh}:${mm}`
}

function toLocalDateOnlyValue(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike)
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getWorkspaceMentionTargets() {
  const out = []
  if (currentUser && currentUser.id) {
    out.push({
      id: currentUser.id,
      username: String(currentUser.username || '').toLowerCase(),
      label: currentUser.username || currentUser.fullName || 'you'
    })
  }
  if (workspaceOwnerSummary && workspaceOwnerSummary.id && currentUser && workspaceOwnerSummary.id !== currentUser.id) {
    const email = String(workspaceOwnerSummary.email || '').trim()
    const handleFromEmail = email ? email.split('@')[0].toLowerCase() : ''
    const un = String(workspaceOwnerSummary.username || '').toLowerCase()
    out.push({
      id: workspaceOwnerSummary.id,
      username: un || handleFromEmail || 'owner',
      label: workspaceOwnerSummary.username || workspaceOwnerSummary.fullName || handleFromEmail || 'owner'
    })
  }
  team.filter(m => m && m.status === 'accepted' && (!currentUser || m.id !== currentUser.id)).forEach(m => {
    const email = String(m.email || '').trim()
    const handle = email ? email.split('@')[0].toLowerCase() : ''
    out.push({ id: m.id, username: handle, label: handle || email || 'member' })
  })
  const seen = new Set()
  return out.filter(x => {
    if (!x.id || !x.username) return false
    if (seen.has(x.id)) return false
    seen.add(x.id)
    return true
  })
}

function extractMentionedUserIds(text) {
  const raw = String(text || '')
  const matches = raw.match(/@([a-zA-Z0-9._-]{2,40})/g) || []
  if (!matches.length) return []
  const targets = getWorkspaceMentionTargets()
  const ids = []
  matches.forEach(m => {
    const handle = m.slice(1).toLowerCase()
    const row = targets.find(t => t.username === handle)
    if (row && row.id && row.id !== currentUser?.id && !ids.includes(row.id)) ids.push(row.id)
  })
  return ids
}

function fireMentionNotifications(contextLabel, text, link) {
  const mentionedUserIds = extractMentionedUserIds(text)
  if (!mentionedUserIds.length) return
  const meta = link && link.type && link.id
    ? { linkType: link.type, linkId: link.id, eventStart: link.start || '' }
    : {}
  mentionedUserIds.forEach(function (uid) {
    const target = team.find(t => t.id === uid) || null
    const label = target && target.email ? target.email.split('@')[0] : uid
    addNotification(`@${label} mentioned in ${contextLabel}: ${String(text).slice(0, 120)}`, 'mention', meta)
    if (ALTER_API_BASE && getAuthToken() && target && target.email && userSettings && userSettings.notifEmailEnabled !== false && userSettings.notifMentionEnabled !== false) {
      fetch(ALTER_API_BASE + '/api/integrations/email/mention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
        body: JSON.stringify({
          to: target.email,
          contextLabel,
          snippet: String(text).slice(0, 500),
          linkType: meta.linkType || '',
          linkId: meta.linkId || ''
        })
      }).catch(function () {})
    }
  })
  logAnalyticsEvent('mention_sent', { count: mentionedUserIds.length })
  addAuditLog('update', `Added mention in ${contextLabel}`, 'update', link && link.type === 'task' && link.id ? { taskId: link.id } : {})
}

function canModerateWorkspace() {
  return currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner')
}
function canEditComment(authorId) {
  return currentUser && authorId && (authorId === currentUser.id || canModerateWorkspace())
}

const WHATS_NEW_VERSION = '2025.03.24'

function getWhatsNewHtml() {
  return `<ul style="margin:0;padding-left:18px;">
    <li><strong>Mentions & notifications</strong> — click a mention notification to jump to the task or calendar day</li>
    <li><strong>Comments</strong> — edit/delete task & event comments (author or admin)</li>
    <li><strong>Mention email</strong> — optional (Settings → Notifications) when server email is configured</li>
    <li><strong>Weekly digest</strong> — dashboard card + reminder</li>
    <li><strong>Local analytics</strong> — export from Settings → Workspace</li>
  </ul><p style="margin:12px 0 0 0;font-size:12px;color:#6B7280;">Run <code style="background:#111827;padding:2px 6px;border-radius:4px;">npm run smoke</code> with <code style="background:#111827;padding:2px 6px;border-radius:4px;">SMOKE_BASE_URL</code> pointed at production before releases.</p>`
}

function openWhatsNewModal(userOpened) {
  const m = document.getElementById('whatsNewModal')
  const b = document.getElementById('whatsNewBody')
  if (b) b.innerHTML = getWhatsNewHtml()
  if (m) m.classList.add('active')
  if (userOpened) logAnalyticsEvent('whats_new_opened', {})
}

function markWhatsNewSeen() {
  try {
    localStorage.setItem('alco_whats_new_seen_' + WHATS_NEW_VERSION, '1')
  } catch (e) {}
}

function maybePromptWhatsNew() {
  try {
    if (localStorage.getItem('alco_whats_new_seen_' + WHATS_NEW_VERSION) === '1') return
    setTimeout(function () { openWhatsNewModal(false) }, 700)
  } catch (e) {}
}

function logAnalyticsEvent(name, props) {
  try {
    const key = 'alco_analytics_events'
    var list = JSON.parse(localStorage.getItem(key) || '[]')
    list.unshift({ name: name, props: props || {}, t: new Date().toISOString(), uid: currentUser && currentUser.id })
    if (list.length > 500) list = list.slice(0, 500)
    localStorage.setItem(key, JSON.stringify(list))
  } catch (e) {}
}

function renderSettingsAnalyticsSummary() {
  const el = document.getElementById('settingsAnalyticsSummary')
  if (!el) return
  try {
    const list = JSON.parse(localStorage.getItem('alco_analytics_events') || '[]')
    const counts = {}
    list.forEach(function (e) { counts[e.name] = (counts[e.name] || 0) + 1 })
    const lines = Object.keys(counts).slice(0, 16).map(function (k) { return k + ': ' + counts[k] })
    el.innerHTML = lines.length ? lines.join('<br>') : 'No events recorded yet.'
  } catch (e) {
    el.textContent = 'Could not read analytics.'
  }
}

function exportAnalyticsJson() {
  try {
    const raw = localStorage.getItem('alco_analytics_events') || '[]'
    navigator.clipboard.writeText(raw).then(function () { showToast('Analytics copied', 'success') }).catch(function () { console.log(raw); showToast('Logged to console', 'info') })
  } catch (e) {
    showToast('Export failed', 'error')
  }
}

function clearAnalyticsEvents() {
  if (!window.confirm('Clear all local analytics events?')) return
  localStorage.removeItem('alco_analytics_events')
  renderSettingsAnalyticsSummary()
  showToast('Analytics cleared', 'success')
}

function getPresenceMap() {
  if (!userSettings || typeof userSettings !== 'object') return {}
  const map = userSettings.presenceLastSeen
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
  return map
}

function isUserOnline(userId) {
  const map = getPresenceMap()
  const raw = map && map[userId] ? String(map[userId]) : ''
  if (!raw) return false
  const ts = new Date(raw).getTime()
  if (!ts || isNaN(ts)) return false
  return (Date.now() - ts) <= 2 * 60 * 1000
}

function getLastSeenLabel(userId) {
  const map = getPresenceMap()
  const raw = map && map[userId] ? String(map[userId]) : ''
  if (!raw) return 'Offline'
  if (isUserOnline(userId)) return 'Online now'
  return 'Last seen ' + timeAgo(raw)
}

function updatePresenceHeartbeat() {
  if (!currentUser || !currentUser.id) return
  if (!userSettings || typeof userSettings !== 'object') userSettings = {}
  if (!userSettings.presenceLastSeen || typeof userSettings.presenceLastSeen !== 'object') userSettings.presenceLastSeen = {}
  userSettings.presenceLastSeen[currentUser.id] = new Date().toISOString()
  save('usersettings', userSettings)
}

function setCalendarUndoAction(label, fn) {
  lastCalendarUndoAction = typeof fn === 'function' ? { label: label || 'Undo', fn } : null
  const btn = document.getElementById('calendarUndoBtn')
  if (!btn) return
  btn.disabled = !lastCalendarUndoAction
  btn.textContent = lastCalendarUndoAction ? `Undo ${lastCalendarUndoAction.label}` : 'Undo'
}

function undoCalendarAction() {
  if (!lastCalendarUndoAction || typeof lastCalendarUndoAction.fn !== 'function') return
  const action = lastCalendarUndoAction
  lastCalendarUndoAction = null
  setCalendarUndoAction('', null)
  action.fn()
}

function greeting() {
  let h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/* ===================================================
   BOOT
=================================================== */
;(function boot() {
  // Dark mode only
  try {
    if (userSettings && typeof userSettings === 'object') {
      if (userSettings.theme) delete userSettings.theme
      save('usersettings', userSettings)
    }
    applyThemeFromSettings()
  } catch (e0) {}

  if (ALTER_API_BASE && getAuthToken()) {
    fetch(ALTER_API_BASE + '/api/me', {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    })
      .then(function (r) {
        if (r.status === 401) throw new Error('Unauthorized')
        if (!r.ok) throw new Error('me_failed')
        return r.json()
      })
      .then(function (me) {
        currentUser = me
        save('session', currentUser)
        return loadWorkspaceFromBackend()
      })
      .then(function (data) {
        if (data) applyWorkspaceToState(data)
        showApp()
      })
      .catch(function (err) {
        if (err && err.message === 'Unauthorized') {
          clearAuthToken()
          localStorage.removeItem('alco_session')
          try {
            var lm = document.getElementById('loginMessage')
            if (lm) {
              lm.textContent = 'Session expired. Please sign in again.'
              lm.className = 'login-message error'
              lm.classList.remove('hidden')
            }
          } catch (e) {}
          return
        }
        if (currentUser) {
          showApp()
          return
        }
        try {
          var sess = JSON.parse(localStorage.getItem('alco_session') || 'null')
          if (sess && sess.id && getAuthToken()) {
            currentUser = sess
            showApp()
          }
        } catch (e2) {}
      })
    return
  }
  var session = null
  try {
    session = JSON.parse(localStorage.getItem('alco_session') || 'null')
  } catch (e) {}
  if (session && session.id) {
    var freshUser = users.find(function (u) { return u.id === session.id })
    if (freshUser) {
      currentUser = freshUser
      showApp()
    }
  }
  if (!invoices.length) {
    invoices = [
      { id:'inv001', date:'2024-01-01', amount:'$0.00',  status:'paid',    plan:'Free' },
      { id:'inv002', date:'2024-02-01', amount:'$0.00',  status:'paid',    plan:'Free' },
    ]
    save('invoices', invoices)
  }
})()

/* ===================================================
   AUTH
=================================================== */
function switchLoginTab(tab, el) {
  document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'))
  el.classList.add('active')
  document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login')
  document.getElementById('registerForm').classList.toggle('hidden', tab !== 'register')
}

function setGoogleLoginButtonState(text) {
  var wrap = document.getElementById('googleLoginBtn')
  if (!wrap) return
  if (text) {
    wrap.className = 'google-signin-slot google-signin-slot--text'
    wrap.textContent = text
  }
}

function setGoogleRegisterButtonState(text) {
  var wrap = document.getElementById('googleRegisterBtn')
  if (!wrap) return
  if (text) {
    wrap.className = 'google-signin-slot google-signin-slot--text'
    wrap.textContent = text
  }
}

function loadGoogleAuthConfigAndInit() {
  if (!ALTER_API_BASE || googleAuthInitAttempted) return
  googleAuthInitAttempted = true
  setGoogleLoginButtonState('Loading Google sign-in...')
  setGoogleRegisterButtonState('Loading Google sign-up...')
  fetch(ALTER_API_BASE + '/api/health')
    .then(function (r) { return r.json().catch(function () { return {} }) })
    .then(function (body) {
      googleAuthClientId = (body && body.googleAuthClientId) ? String(body.googleAuthClientId).trim() : ''
      if (!googleAuthClientId) {
        setGoogleLoginButtonState('Google sign-in is unavailable')
        setGoogleRegisterButtonState('Google sign-up is unavailable')
        return
      }
      initializeGoogleSignIn()
    })
    .catch(function () {
      setGoogleLoginButtonState('Google sign-in is unavailable')
      setGoogleRegisterButtonState('Google sign-up is unavailable')
    })
}

function initializeGoogleSignIn() {
  var wrap = document.getElementById('googleLoginBtn')
  var registerWrap = document.getElementById('googleRegisterBtn')
  if (!wrap && !registerWrap) return
  if (!googleAuthClientId) {
    setGoogleLoginButtonState('Google sign-in is unavailable')
    setGoogleRegisterButtonState('Google sign-up is unavailable')
    return
  }
  if (!window.google || !google.accounts || !google.accounts.id) {
    setGoogleLoginButtonState('Google sign-in failed to load')
    setGoogleRegisterButtonState('Google sign-up failed to load')
    return
  }
  try {
    // use_fedcm_for_prompt: false avoids Chrome FedCM / gsi/transform flows hanging on a blank page
    // when third‑party cookies are restricted or COOP blocks the handoff back to this origin.
    try {
      if (typeof google.accounts.id.cancel === 'function') google.accounts.id.cancel()
    } catch (eCancel) {}
    google.accounts.id.initialize({
      client_id: googleAuthClientId,
      auto_select: false,
      use_fedcm_for_prompt: false,
      callback: function (response) {
        if (!response || !response.credential) {
          showLoginMessage('Google sign-in was cancelled. Please try again.', 'error')
          return
        }
        loginWithGoogleCredential(response.credential)
      }
    })

    function computeGoogleBtnWidth(containerEl) {
      try {
        var r = containerEl.getBoundingClientRect()
        var w = Math.floor(r.width || 0)
        if (!w || w < 120) w = 260
        return Math.max(200, Math.min(340, w))
      } catch (e) {
        return 260
      }
    }

    if (wrap) {
      wrap.textContent = ''
      wrap.className = 'google-signin-slot'
      var w1 = computeGoogleBtnWidth(wrap)
      google.accounts.id.renderButton(wrap, {
        theme: 'filled_black',
        size: 'large',
        width: w1,
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left'
      })
    }
    if (registerWrap) {
      registerWrap.textContent = ''
      registerWrap.className = 'google-signin-slot'
      var w2 = computeGoogleBtnWidth(registerWrap)
      google.accounts.id.renderButton(registerWrap, {
        theme: 'filled_black',
        size: 'large',
        width: w2,
        text: 'signup_with',
        shape: 'rectangular',
        logo_alignment: 'left'
      })
    }
  } catch (e) {
    console.error('Google sign-in init failed', e)
    setGoogleLoginButtonState('Google sign-in failed to load')
    setGoogleRegisterButtonState('Google sign-up failed to load')
  }
}

function loginWithGoogleCredential(credential) {
  if (!ALTER_API_BASE) {
    showLoginMessage('Google sign-in requires the backend server.', 'error')
    return
  }
  showLoginMessage('Signing you in with Google...', 'info')
  fetch(ALTER_API_BASE + '/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: credential })
  })
    .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body } }) })
    .then(function (res) {
      if (!res.ok) {
        showLoginMessage((res.body && res.body.error) || 'Google sign-in failed', 'error')
        return { skip: true }
      }
      // Auth is now stored in httpOnly cookies; don't persist tokens in localStorage.
      clearAuthToken()
      save('session', res.body.user)
      currentUser = res.body.user
      return loadWorkspaceFromBackend().then(function (data) {
        return { skip: false, data: data }
      })
    })
    .then(function (result) {
      if (!result || result.skip) return
      if (result.data) applyWorkspaceToState(result.data)
      addAuditLog('login', currentUser.username + ' signed in with Google', 'login')
      showApp()
    })
    .catch(function () {
      showLoginMessage('Network error. Could not complete Google sign-in.', 'error')
    })
}

function register() {
  var u  = document.getElementById('regUsername').value.trim()
  var e  = document.getElementById('regEmail').value.trim()
  var p  = document.getElementById('regPassword').value.trim()
  var c  = document.getElementById('regConfirm').value.trim()
  var inv = (document.getElementById('regInviteCode') && document.getElementById('regInviteCode').value.trim()) || ''
  if (u.length < 4)     return showLoginMessage('Username must be at least 4 characters', 'error')
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return showLoginMessage('Please enter a valid email address', 'error')
  if (p.length < 6)     return showLoginMessage('Password must be at least 6 characters', 'error')
  if (p !== c)          return showLoginMessage('Passwords do not match', 'error')
  if (ALTER_API_BASE) {
    fetch(ALTER_API_BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, email: e, password: p, fullName: '', inviteCode: inv })
    }).then(function (r) { return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body } }) })
      .then(function (res) {
        if (!res.ok) {
          showLoginMessage(res.body.error || 'Registration failed', 'error')
          return Promise.reject('register_failed')
        }
        // Auth is now stored in httpOnly cookies; don't persist tokens in localStorage.
        clearAuthToken()
        save('session', res.body.user)
        currentUser = res.body.user
        return loadWorkspaceFromBackend()
      })
      .then(function (data) {
        if (!currentUser) return
        if (data) applyWorkspaceToState(data)
        else applyWorkspaceToState({ projects: [], tasks: [], ideas: [], events: [], goals: [], timeEntries: [], team: [], notifications: [], activity: [], auditLogs: [], invoices: [], apiKeys: [], userSettings: {}, pages: [] })
        addAuditLog('login', 'Account created', 'login')
        showApp()
      })
      .catch(function (err) {
        if (err === 'register_failed') return
        showLoginMessage('Network error. Is the backend running?', 'error')
      })
    return
  }
  if (users.find(function (x) { return x.username === u })) return showLoginMessage('Username already exists', 'error')
  var newUser = { id: genId(), username: u, email: e, password: p, fullName: '', role: 'member', bio: '', timezone: 'UTC', plan: 'free', created: new Date().toISOString() }
  users.push(newUser)
  save('users', users)
  showLoginMessage('Account created! You can now sign in.', 'success')
}

function login() {
  var u   = document.getElementById('usernameInput').value.trim()
  var p   = document.getElementById('passwordInput').value.trim()
  if (ALTER_API_BASE) {
    fetch(ALTER_API_BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (r) { return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body } }) })
      .then(function (res) {
        if (!res.ok) {
          showLoginMessage(res.body.error || 'Invalid username or password', 'error')
          return { skip: true }
        }
        // Auth is now stored in httpOnly cookies; don't persist tokens in localStorage.
        clearAuthToken()
        save('session', res.body.user)
        currentUser = res.body.user
        return loadWorkspaceFromBackend().then(function (data) {
          return { skip: false, data: data }
        })
      })
      .then(function (result) {
        if (!result || result.skip) return
        if (result.data) applyWorkspaceToState(result.data)
        addAuditLog('login', u + ' signed in', 'login')
        showApp()
      })
      .catch(function () { showLoginMessage('Network error. Is the backend running?', 'error') })
    return
  }
  var acc = users.find(function (x) { return x.username === u && x.password === p })
  if (!acc) return showLoginMessage('Invalid username or password', 'error')
  currentUser = acc
  save('session', acc)
  addAuditLog('login', u + ' signed in', 'login')
  showApp()
}

function forgotPassword() {
  if (!ALTER_API_BASE) {
    showLoginMessage('Password reset is only available when connected to the backend.', 'info')
    return
  }
  var email = window.prompt('Enter the email associated with your ALTER.CO account:')
  if (!email) return
  email = email.trim()
  if (!email) return

  fetch(ALTER_API_BASE + '/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  })
    .then(function (r) {
      if (r.status === 429) {
        showLoginMessage('Too many attempts. Wait a few minutes and try again.', 'error')
        return
      }
      if (!r.ok) {
        showLoginMessage('Unable to process reset right now. Try again later.', 'error')
        return
      }
      showLoginMessage('If an account exists for that email, a temporary password has been sent.', 'success')
    })
    .catch(function () {
      showLoginMessage('Unable to process reset right now. Try again later.', 'error')
    })
}

function getPublicApiBase() {
  if (typeof ALTER_API_BASE === 'string' && ALTER_API_BASE) return ALTER_API_BASE
  if (typeof window !== 'undefined' && window.location && window.location.protocol !== 'file:') {
    return window.location.origin
  }
  return ''
}

function submitContactForm(ev) {
  if (ev && ev.preventDefault) ev.preventDefault()
  var base = getPublicApiBase()
  var nameEl = document.getElementById('contactName')
  var emailEl = document.getElementById('contactEmail')
  var msgEl = document.getElementById('contactMessage')
  var statusEl = document.getElementById('contactFormStatus')
  if (!emailEl || !msgEl) return
  var name = nameEl ? nameEl.value.trim() : ''
  var email = emailEl.value.trim()
  var message = msgEl.value.trim()
  if (!message) {
    if (statusEl) statusEl.textContent = 'Please enter a message.'
    return
  }
  if (!base) {
    if (statusEl) {
      statusEl.textContent = 'Open this site from the server (e.g. http://localhost:3000) so messages can be sent.'
    }
    return
  }
  if (statusEl) statusEl.textContent = 'Sending…'
  fetch(base + '/api/public/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, email: email, message: message })
  })
    .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body } }) })
    .then(function (res) {
      if (!res.ok) {
        if (statusEl) statusEl.textContent = (res.body && res.body.error) ? res.body.error : 'Could not send.'
        return
      }
      if (statusEl) statusEl.textContent = 'Thanks — we received your message.'
      if (nameEl) nameEl.value = ''
      emailEl.value = ''
      msgEl.value = ''
    })
    .catch(function () {
      if (statusEl) statusEl.textContent = 'Network error. Try again later.'
    })
}

function demoLogin() {
  if (ALTER_API_BASE) {
    showLoginMessage('Create an account or sign in with your credentials', 'info')
    return
  }
  var acc = users.find(function (x) { return x.username === 'admin' })
  if (!acc) return
  currentUser = acc
  save('session', acc)
  addAuditLog('login', 'Demo login', 'login')
  showApp()
}

/** Marketing landing vs auth vs app */
function showLandingScreen() {
  stopLiveWorkspaceRefreshLoop()
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer)
  presenceHeartbeatTimer = null
  var land = document.getElementById('landingScreen')
  var login = document.getElementById('loginScreen')
  var app = document.getElementById('app')
  if (land) land.classList.remove('hidden')
  if (login) login.classList.add('hidden')
  if (app) app.classList.add('hidden')
}

if (typeof document !== 'undefined' && !window.__alcoLiveSyncVisibilityBound) {
  window.__alcoLiveSyncVisibilityBound = true
  document.addEventListener('visibilitychange', function () {
    if (!currentUser || !ALTER_API_BASE || !getAuthToken()) return
    if (document.visibilityState === 'visible') {
      refreshWorkspaceLive(false)
      updatePresenceHeartbeat()
    } else {
      scheduleLiveWorkspaceRefresh(30000)
    }
  })
}

function showAuthScreen(tab) {
  var land = document.getElementById('landingScreen')
  var login = document.getElementById('loginScreen')
  var appEl = document.getElementById('app')
  if (land) land.classList.add('hidden')
  if (login) login.classList.remove('hidden')
  if (appEl) appEl.classList.add('hidden')
  var tabs = document.querySelectorAll('.login-tab')
  if (tab === 'register' && tabs[1]) switchLoginTab('register', tabs[1])
  else if (tabs[0]) switchLoginTab('login', tabs[0])
  loadGoogleAuthConfigAndInit()
}

function showApp() {
  if (!ensureCurrentUser()) {
    document.getElementById('app').classList.add('hidden')
    showLandingScreen()
    return
  }
  var land = document.getElementById('landingScreen')
  if (land) land.classList.add('hidden')
  document.getElementById('loginScreen').classList.add('hidden')
  document.getElementById('app').classList.remove('hidden')
  initGlobalErrorCapture()
  initializeApp()
  // Show onboarding for new users who haven't seen it
  if (!localStorage.getItem('alco_onboarded_' + currentUser.id)) {
    setTimeout(() => startOnboarding(), 800)
  }
}

function logout() {
  openConfirmModal({
    type: 'logout',
    title: 'Sign out',
    message: 'You will be signed out of ALTER.CO on this device.',
    level: 'normal'
  })
}

function showLoginMessage(msg, type) {
  let el = document.getElementById('loginMessage')
  el.textContent = msg
  el.className = `login-message ${type}`
  el.classList.remove('hidden')
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 4000)
}

/* ===================================================
   INIT
=================================================== */
function initializeApp() {
  if (!currentUser) return
  handleGoogleCalendarOAuthReturn()
  const quickAddInput = document.getElementById('calendarQuickAddInput')
  if (quickAddInput && !quickAddInput.dataset.boundEnter) {
    quickAddInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        quickAddCalendarEvent()
      }
    })
    quickAddInput.dataset.boundEnter = '1'
  }
  updateSidebarUser()
  renderAllPages()
  renderNotifications()
  updatePresenceHeartbeat()
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer)
  presenceHeartbeatTimer = setInterval(updatePresenceHeartbeat, 60000)
  setupKeyboardShortcuts()
  var greetEl = document.getElementById('dashboardGreeting')
  if (greetEl) greetEl.textContent = greeting() + ', ' + (currentUser.fullName || currentUser.username) + ' 👋'
  if (ALTER_API_BASE && getAuthToken()) {
    syncGoogleCalendarConnectionState().then(function () {
      if (googleCalendarConnected) refreshGoogleCalendarEvents()
    })
  }
  startLiveWorkspaceRefreshLoop()
  maybeSendWeeklyDigestReminder()
  maybePromptWhatsNew()
  setupChartZoom()
}

function renderAllPages() {
  updateStats()
  populateTaskProjectFilter()
  renderTaskSavedViews()
  renderProjects()
  renderTasks()
  renderIdeas()
  renderCalendar()
  renderTeam()
  renderActivityFeed()
  renderDashboardActivationInsights()
  renderWeeklyDigestCard()
  renderDashboardCharts()
  renderProfile()
  populateTimerProjectSelect()
}

function updateSidebarUser() {
  if (!currentUser) return
  let initial = (currentUser.fullName || currentUser.username).charAt(0).toUpperCase()
  var av = document.getElementById('sidebarAvatar')
  if (av) av.textContent = initial
  var sun = document.getElementById('sidebarUsername')
  if (sun) sun.textContent = currentUser.fullName || currentUser.username
  var srt = document.getElementById('sidebarRoleText')
  if (srt) srt.textContent = currentUser.role
  var spb = document.getElementById('sidebarPlanBadge')
  if (spb) spb.textContent = (currentUser.plan || 'free').toUpperCase()
  var pfa = document.getElementById('profileAvatar')
  if (pfa) pfa.textContent = initial
  // Also keep dedicated Profile page in sync
  let ppAvatar = document.getElementById('profilePageAvatar')
  if (ppAvatar) ppAvatar.textContent = initial
  let ppName = document.getElementById('profilePageName')
  if (ppName) ppName.textContent = currentUser.fullName || currentUser.username
  let ppEmail = document.getElementById('profilePageEmail')
  if (ppEmail) ppEmail.textContent = currentUser.email || ''
  let ppRole = document.getElementById('profilePageRole')
  if (ppRole) ppRole.textContent = currentUser.role || 'member'
  let ppPlan = document.getElementById('profilePagePlan')
  if (ppPlan) ppPlan.textContent = (currentUser.plan || 'free').toUpperCase()
  let ppTz = document.getElementById('profilePageTimezone')
  if (ppTz) ppTz.textContent = currentUser.timezone || 'UTC'
  let ppCreated = document.getElementById('profilePageCreated')
  if (ppCreated && currentUser.created) ppCreated.textContent = currentUser.created.split('T')[0]
  let ppBio = document.getElementById('profilePageBio')
  if (ppBio) ppBio.textContent = currentUser.bio || 'Add a short bio from Settings to introduce yourself to your team.'

  // Hydrate notification toggles from userSettings if present
  try {
    const map = {
      notifEmailToggle: 'notifEmailEnabled',
      notifTaskToggle: 'notifTaskEnabled',
      notifMentionToggle: 'notifMentionEnabled',
      notifProjectToggle: 'notifProjectEnabled',
      notifDeadlineToggle: 'notifDeadlineEnabled',
      notifWeeklyToggle: 'notifWeeklyEnabled'
    }
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id)
      if (!el) return
      const key = map[id]
      const val = userSettings && Object.prototype.hasOwnProperty.call(userSettings, key)
        ? !!userSettings[key]
        : el.classList.contains('active') // default from HTML
      el.classList.toggle('active', val)
    })
  } catch (e) {}
}

/* ===================================================
   ONBOARDING
=================================================== */
function startOnboarding() {
  currentOnboardingStep = 0
  renderOnboardingStep()
  document.getElementById('onboardingOverlay').classList.add('active')
}

function renderOnboardingStep() {
  if (currentOnboardingStep < 0 || currentOnboardingStep >= ONBOARDING_STEPS.length) {
    currentOnboardingStep = 0
  }
  let step = ONBOARDING_STEPS[currentOnboardingStep]
  if (!step) return
  let dots = document.getElementById('onboardingDots')
  if (!dots) return
  dots.innerHTML = ONBOARDING_STEPS.map((_, i) =>
    `<div class="onboarding-step-dot ${i < currentOnboardingStep ? 'done' : i === currentOnboardingStep ? 'active' : ''}"></div>`
  ).join('')
  document.getElementById('onboardingIcon').textContent  = step.icon
  document.getElementById('onboardingTitle').textContent = step.title
  document.getElementById('onboardingDesc').textContent  = step.desc

  let btn = document.querySelector('#onboardingOverlay button:first-child')
  if (btn) btn.textContent = currentOnboardingStep < ONBOARDING_STEPS.length - 1 ? 'Next →' : '🚀 Let\'s Go!'
}

function nextOnboardingStep() {
  currentOnboardingStep++
  if (currentOnboardingStep >= ONBOARDING_STEPS.length) {
    skipOnboarding()
  } else {
    renderOnboardingStep()
  }
}

function skipOnboarding() {
  document.getElementById('onboardingOverlay').classList.remove('active')
  if (currentUser && currentUser.id) {
    localStorage.setItem('alco_onboarded_' + currentUser.id, '1')
  }
}

/* ===================================================
   PAGE NAVIGATION
=================================================== */
function switchPage(pageId, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'))
  let page = document.getElementById(pageId)
  if (page) {
    page.classList.remove('hidden')
    try { page.scrollTop = 0 } catch (e) {}
  }

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  if (el && el.classList) {
    el.classList.add('active')
  } else {
    document.querySelectorAll('.nav-item').forEach(n => {
      let oc = n.getAttribute('onclick') || ''
      if (oc.includes(`'${pageId}'`)) n.classList.add('active')
    })
  }

  let titles = {
    dashboard:'Dashboard',
    profile:'Profile',
    projects:'Projects',
    tasks:'Tasks',
    pages:'Docs',
    timetracking:'Time Tracking',
    ideas:'Ideas',
    calendar:'Calendar',
    goals:'Goals & OKRs',
    team:'Team',
    analytics:'Analytics',
    overview:'Overview',
    auditlog:'Audit Log',
    billing:'Billing',
    settings:'Settings'
  }
  let title = titles[pageId] || pageId
  let topbar = document.getElementById('topbarTitle')
  if (topbar) topbar.textContent = title

  if (pageId === 'calendar') {
    renderCalendar()
    if (ALTER_API_BASE && getAuthToken()) {
      syncGoogleCalendarConnectionState().then(function () {
        if (googleCalendarConnected) refreshGoogleCalendarEvents()
      })
    }
  }
  if (pageId === 'analytics') {
    setTimeout(function () { renderAnalyticsCharts() }, 50)
  }
  if (pageId === 'timetracking') renderTimeTracking()
  if (pageId === 'pages') renderPagesEditor()
  if (pageId === 'billing') {
    renderBilling()
    setTimeout(function () {
      var sec = document.getElementById('billingPlansSection')
      if (sec && typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 50)
  }
  if (pageId === 'auditlog') renderAuditLog()
  if (pageId === 'goals') renderGoals()
  if (pageId === 'overview') renderOverview()
  if (pageId === 'tasks') {
    populateTaskProjectFilter()
  }
  if (pageId === 'team') renderTeam()
}

/* ===================================================
   COMMAND PALETTE
=================================================== */
let commandSelectedIndex = -1
let commandItems = []

function openCommandPalette() {
  document.getElementById('commandPalette').classList.add('active')
  setTimeout(() => {
    document.getElementById('commandInput').focus()
    document.getElementById('commandInput').value = ''
    updateCommandResults()
  }, 50)
}

function closeCommandPalette(e) {
  if (!e || e.target.id === 'commandPalette') {
    document.getElementById('commandPalette').classList.remove('active')
    commandSelectedIndex = -1
  }
}

function updateCommandResults() {
  let q = document.getElementById('commandInput').value.toLowerCase().trim()
  commandSelectedIndex = -1
  commandItems = []

  let html = ''

  function hi(text) {
    const s = String(text || '')
    if (!q) return escapeHtml(s)
    const i = s.toLowerCase().indexOf(q)
    if (i < 0) return escapeHtml(s)
    const before = escapeHtml(s.slice(0, i))
    const mid = escapeHtml(s.slice(i, i + q.length))
    const after = escapeHtml(s.slice(i + q.length))
    return before + '<mark style="background:rgba(99,102,241,0.25);color:#E5E7EB;border-radius:4px;padding:0 2px;">' + mid + '</mark>' + after
  }

  // Navigation commands
  let pages = [
    { icon:'📊', label:'Dashboard', sub:'Go to dashboard', action: () => switchPage('dashboard', null) },
    { icon:'👤', label:'Profile', sub:'View your profile', action: () => switchPage('profile', null) },
    { icon:'📁', label:'Projects', sub:'View all projects', action: () => switchPage('projects', null) },
    { icon:'✅', label:'Tasks', sub:'Kanban board', action: () => switchPage('tasks', null) },
    { icon:'📄', label:'Docs', sub:'Documentation & internal pages', action: () => switchPage('pages', null) },
    { icon:'⏱', label:'Time Tracking', sub:'Log and track time', action: () => switchPage('timetracking', null) },
    { icon:'💡', label:'Ideas', sub:'Ideas board', action: () => switchPage('ideas', null) },
    { icon:'📅', label:'Calendar', sub:'Events & deadlines', action: () => switchPage('calendar', null) },
    { icon:'👥', label:'Team', sub:'Manage team', action: () => switchPage('team', null) },
    { icon:'📈', label:'Analytics', sub:'Reports & insights', action: () => switchPage('analytics', null) },
    { icon:'📋', label:'Audit Log', sub:'Activity history', action: () => switchPage('auditlog', null) },
    { icon:'💳', label:'Billing', sub:'Plans & invoices', action: () => switchPage('billing', null) },
    { icon:'⚙️', label:'Settings', sub:'Profile & preferences', action: () => switchPage('settings', null) },
  ]

  // Create commands
  let creates = [
    { icon:'➕', label:'New Project', sub:'Create a project', action: openCreateProjectModal },
    { icon:'➕', label:'New Task', sub:'Create a task', action: openCreateTaskModal },
    { icon:'➕', label:'New Idea', sub:'Submit an idea', action: openCreateIdeaModal },
    { icon:'➕', label:'New Event', sub:'Schedule an event', action: openCreateEventModal },
    { icon:'➕', label:'Log Time', sub:'Manual time entry', action: openManualTimeModal },
    { icon:'➕', label:'Invite Member', sub:'Invite to workspace', action: openInviteTeamModal },
  ]

  let filteredPages   = q ? pages.filter(p => p.label.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q)) : pages
  let filteredCreates = q ? creates.filter(c => c.label.toLowerCase().includes(q)) : creates

  // Projects search
  let filteredProjects = q ? projects.filter(p => p.name.toLowerCase().includes(q)).slice(0, 3) : []

  // Tasks search
  let filteredTasks = q ? tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 3) : []

  // Ideas search
  let filteredIdeas = q ? ideas.filter(i => (i.title || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q)).slice(0, 3) : []

  // Goals search
  let filteredGoals = q ? goals.filter(g => {
    const t = String(g.title || '').toLowerCase()
    if (t.includes(q)) return true
    try {
      const krs = Array.isArray(g.keyResults) ? g.keyResults : []
      return krs.some(kr => String((kr && kr.title) ? kr.title : kr || '').toLowerCase().includes(q))
    } catch (e) { return false }
  }).slice(0, 3) : []

  // Docs search (titles + block text)
  ensurePageInitialized()
  let filteredDocs = []
  if (q) {
    filteredDocs = pages.filter(p => {
      if (String(p.title || '').toLowerCase().includes(q)) return true
      try { return (p.blocks || []).some(b => stripHtmlForPreview(b.text || '').toLowerCase().includes(q)) } catch (e) { return false }
    }).slice(0, 5)
  }

  let savedViews = Array.isArray(userSettings.taskSavedViews) ? userSettings.taskSavedViews : []
  let filteredTaskViews = q ? savedViews.filter(v => (v.name || '').toLowerCase().includes(q)).slice(0, 6) : savedViews.slice(0, 4)

  if (filteredPages.length) {
    html += `<div class="command-section-label">Navigation</div>`
    filteredPages.forEach(item => {
      commandItems.push(item)
      html += commandItemHtml(item)
    })
  }

  if (filteredCreates.length) {
    html += `<div class="command-section-label">Create</div>`
    filteredCreates.forEach(item => {
      commandItems.push(item)
      html += commandItemHtml(item)
    })
  }

  if (filteredProjects.length) {
    html += `<div class="command-section-label">Projects</div>`
    filteredProjects.forEach(p => {
      let item = { icon:'📁', label: p.name, sub: p.priority + ' priority', action: () => switchPage('projects', null) }
      commandItems.push(item)
      html += commandItemHtml(item)
    })
  }

  if (filteredTasks.length) {
    html += `<div class="command-section-label">Tasks</div>`
    filteredTasks.forEach(t => {
      let item = { icon:'✅', label: t.title, sub: t.status, action: () => switchPage('tasks', null) }
      commandItems.push(item)
      html += commandItemHtml(item)
    })
  }

  if (filteredIdeas.length) {
    html += `<div class="command-section-label">Ideas</div>`
    filteredIdeas.forEach(i => {
      let item = { icon:'💡', label: i.title, sub: i.category || 'idea', action: () => switchPage('ideas', null) }
      commandItems.push(item)
      html += commandItemHtml(item)
    })
  }

  if (filteredGoals.length) {
    html += `<div class="command-section-label">Goals</div>`
    filteredGoals.forEach(g => {
      let item = {
        icon: '🎯',
        label: (q ? hi(g.title || 'Untitled goal') : escapeHtml(g.title || 'Untitled goal')),
        sub: 'Open goal',
        action: () => {
          switchPage('goals', null)
          setTimeout(function () { try { openEditGoalModal(g.id) } catch (e) {} }, 80)
        }
      }
      commandItems.push(item)
      html += `<div class="command-item" onclick="executeCommand(${commandItems.length - 1})">
        <div class="command-item-icon">${item.icon}</div>
        <div class="command-item-text">
          <div class="command-item-label">${item.label}</div>
          <div class="command-item-sub">${escapeHtml(item.sub)}</div>
        </div>
      </div>`
    })
  }

  if (filteredDocs.length) {
    html += `<div class="command-section-label">Docs</div>`
    filteredDocs.forEach(p => {
      let item = {
        icon: '📄',
        label: (q ? hi(p.title || 'Untitled') : escapeHtml(p.title || 'Untitled')),
        sub: 'Open doc',
        action: () => {
          switchPage('pages', null)
          setTimeout(function () { openPage(p.id) }, 100)
        }
      }
      commandItems.push(item)
      html += `<div class="command-item" onclick="executeCommand(${commandItems.length - 1})">
        <div class="command-item-icon">${item.icon}</div>
        <div class="command-item-text">
          <div class="command-item-label">${item.label}</div>
          <div class="command-item-sub">${escapeHtml(item.sub)}</div>
        </div>
      </div>`
    })
  }

  if (filteredTaskViews.length) {
    html += `<div class="command-section-label">Task Views</div>`
    filteredTaskViews.forEach(v => {
      let item = {
        icon:'🧭',
        label: v.name || 'Saved view',
        sub: 'Apply saved task filters',
        action: () => {
          switchPage('tasks', null)
          setTimeout(function () {
            const sel = document.getElementById('taskSavedViewSelect')
            if (sel) sel.value = v.id
            applyTaskFilterState(v.state || {})
          }, 120)
        }
      }
      commandItems.push(item)
      html += commandItemHtml(item)
    })
  }

  if (!html) {
    html = `<div style="text-align:center;padding:30px;color:#4B5563;font-size:14px;">No results for "${escapeHtml(q)}"</div>`
  }

  document.getElementById('commandResults').innerHTML = html
}

function commandItemHtml(item) {
  return `<div class="command-item" onclick="executeCommand(${commandItems.length - 1})">
    <div class="command-item-icon">${item.icon}</div>
    <div class="command-item-text">
      <div class="command-item-label">${escapeHtml(item.label)}</div>
      ${item.sub ? `<div class="command-item-sub">${escapeHtml(item.sub)}</div>` : ''}
    </div>
  </div>`
}

function executeCommand(idx) {
  let item = commandItems[idx]
  if (item && item.action) {
    closeCommandPalette()
    setTimeout(() => item.action(), 100)
  }
}

function handleCommandKey(e) {
  let items = document.querySelectorAll('.command-item')
  if (e.key === 'ArrowDown') {
    commandSelectedIndex = Math.min(commandSelectedIndex + 1, items.length - 1)
    highlightCommandItem(items)
    e.preventDefault()
  } else if (e.key === 'ArrowUp') {
    commandSelectedIndex = Math.max(commandSelectedIndex - 1, 0)
    highlightCommandItem(items)
    e.preventDefault()
  } else if (e.key === 'Enter') {
    if (commandSelectedIndex >= 0) executeCommand(commandSelectedIndex)
    e.preventDefault()
  } else if (e.key === 'Escape') {
    closeCommandPalette()
  }
}

function highlightCommandItem(items) {
  items.forEach((item, i) => item.classList.toggle('selected', i === commandSelectedIndex))
  if (commandSelectedIndex >= 0) items[commandSelectedIndex]?.scrollIntoView({ block:'nearest' })
}

/* ===================================================
   KEYBOARD SHORTCUTS
=================================================== */
function setupKeyboardShortcuts() {
  if (keyboardShortcutsBound) return
  document.addEventListener('keydown', handleKeyDown)
  keyboardShortcutsBound = true
}

function handleKeyDown(e) {
  let tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : ''
  let inField = tag === 'input' || tag === 'textarea' || tag === 'select'
  let inContentEditable = e.target && e.target.isContentEditable

  // ⌘K / Ctrl+K - Command palette (always, even in inputs)
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    openCommandPalette()
    return
  }
  // ⌘E / Ctrl+E - Export
  if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
    e.preventDefault()
    exportData()
    return
  }
  // Escape - close modals, palette, overlays
  if (e.key === 'Escape') {
    var cz = document.getElementById('chartZoomModal')
    if (cz && cz.classList.contains('active')) {
      e.preventDefault()
      closeChartZoomModal()
      return
    }
    e.preventDefault()
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'))
    var cp = document.getElementById('commandPalette')
    if (cp) cp.classList.remove('active')
    var so = document.getElementById('shortcutsOverlay')
    if (so) so.classList.remove('active')
    var np = document.getElementById('notificationsPanel')
    if (np) np.classList.remove('active')
    return
  }
  // ? or Shift+/ — show shortcuts (works when not typing in a field)
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    if (!inField && !inContentEditable) {
      e.preventDefault()
      showShortcuts()
    }
    return
  }

  if (inField || inContentEditable) return

  // N - notifications (only when not in a field)
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey) { toggleNotifications(); return }

  // Two-key sequences
  keySequence.push(e.key.toLowerCase())
  clearTimeout(keyTimer)
  keyTimer = setTimeout(() => { keySequence = [] }, 1000)

  if (keySequence.length === 2) {
    let seq = keySequence.join('')
    let pageMap = { 'gd':'dashboard','gp':'projects','gt':'tasks','gc':'calendar','gi':'ideas','ga':'analytics' }
    let createMap = { 'np': openCreateProjectModal, 'nt': openCreateTaskModal, 'ni': openCreateIdeaModal }
    if (pageMap[seq]) { switchPage(pageMap[seq], null); keySequence = [] }
    if (createMap[seq]) { createMap[seq](); keySequence = [] }
  }
}

function showShortcuts() {
  document.getElementById('shortcutsOverlay').classList.add('active')
}

function closeShortcuts(e) {
  if (e.target.id === 'shortcutsOverlay') document.getElementById('shortcutsOverlay').classList.remove('active')
}

/* ===================================================
   STATS
=================================================== */
function parseTaskDueDate(t) {
  if (!t || !t.dueDate) return null
  const d = new Date(t.dueDate.includes('T') ? t.dueDate : t.dueDate + 'T09:00')
  return isNaN(d.getTime()) ? null : d
}

function onboardingDismissStorageKey() {
  return 'alter_dashboard_onboarding_dismissed_' + (currentUser && currentUser.id ? String(currentUser.id) : 'anon')
}

function isDashboardOnboardingDismissed() {
  try {
    return localStorage.getItem(onboardingDismissStorageKey()) === '1'
  } catch (e) {
    return false
  }
}

function dismissDashboardOnboarding() {
  try {
    localStorage.setItem(onboardingDismissStorageKey(), '1')
  } catch (e) {}
  const onboard = document.getElementById('dashboardOnboarding')
  if (onboard) onboard.classList.add('hidden')
}

function renderDashboardPulseAndOnboarding() {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const endWeek = new Date(startOfToday.getTime() + 7 * 86400000)

  const overdue = tasks.filter(t => {
    if (t.status === 'done') return false
    const d = parseTaskDueDate(t)
    return d && d < startOfToday
  }).length

  const dueWeek = tasks.filter(t => {
    if (t.status === 'done') return false
    const d = parseTaskDueDate(t)
    return d && d >= startOfToday && d <= endWeek
  }).length

  const inMotion = tasks.filter(t => t.status === 'in-progress' || t.status === 'review').length

  const po = document.getElementById('pulseOverdue')
  const pw = document.getElementById('pulseDueWeek')
  const pi = document.getElementById('pulseInProgress')
  if (po) po.textContent = overdue
  if (pw) pw.textContent = dueWeek
  if (pi) pi.textContent = inMotion

  const oc = document.getElementById('pulseOverdueCard')
  if (oc) {
    oc.className = 'pulse-card' + (overdue > 0 ? ' warning' : ' ok')
  }

  const onboard = document.getElementById('dashboardOnboarding')
  const stepsEl = document.getElementById('dashboardOnboardingSteps')
  const leadEl = document.getElementById('dashboardOnboardingLead')
  if (!onboard || !stepsEl) return

  if (isDashboardOnboardingDismissed()) {
    onboard.classList.add('hidden')
    return
  }

  const hasProject = projects.length > 0
  const hasTask = tasks.length > 0
  const hasEvent = events.length > 0
  const hasGoogleConnected = !!googleCalendarConnected
  const hasTeammate = Array.isArray(team) && team.length > 0
  const doneCount = [hasProject, hasTask, hasEvent, hasGoogleConnected, hasTeammate].filter(Boolean).length
  const totalSteps = 5
  const progressPct = Math.round((doneCount / totalSteps) * 100)
  if (leadEl) {
    if (doneCount === totalSteps) {
      leadEl.textContent = 'Nice work. Your workspace is activated and ready for real execution.'
    } else {
      leadEl.textContent = `${doneCount}/${totalSteps} complete (${progressPct}%). Finish the checklist to unlock your first 10-minute success.`
    }
  }

  if (doneCount === totalSteps) {
    onboard.classList.add('hidden')
    return
  }
  onboard.classList.remove('hidden')

  const steps = [
    { ok: hasProject, label: 'Create a project', action: 'openCreateProjectModal()' },
    { ok: hasTask, label: 'Add your first task', action: "switchPage('tasks', null);setTimeout(function(){openCreateTaskModal()},120)" },
    { ok: hasEvent, label: 'Add your first calendar event', action: "switchPage('calendar', null);setTimeout(function(){openCreateEventModal()},120)" },
    { ok: hasGoogleConnected, label: 'Connect Google Calendar', action: "switchPage('calendar', null);setTimeout(function(){connectGoogleCalendar()},120)" },
    { ok: hasTeammate, label: 'Invite a teammate', action: "switchPage('team',null);setTimeout(function(){openInviteTeamModal()},120)" }
  ]
  stepsEl.innerHTML = steps.map(s => {
    if (s.ok) {
      return `<button type="button" class="onboarding-step done" disabled>✓ ${escapeHtml(s.label)}</button>`
    }
    return `<button type="button" class="onboarding-step" onclick="${s.action}">○ ${escapeHtml(s.label)}</button>`
  }).join('')
}

function renderDashboardSuggestions() {
  const el = document.getElementById('dashboardSuggestions')
  if (!el) return
  const items = []
  if (!projects.length) {
    items.push({ label: 'Create a project so tasks and time roll up here', action: "openCreateProjectModal()" })
  }
  if (projects.length && !tasks.length) {
    items.push({ label: 'Add tasks to your board', action: "switchPage('tasks',null);setTimeout(function(){openCreateTaskModal()},120)" })
  }
  if (projects.length && !timeEntries.length) {
    items.push({ label: 'Log time on work (timer or manual)', action: "switchPage('timetracking',null)" })
  }
  if (!goals.length) {
    items.push({ label: 'Set a goal or OKR', action: "switchPage('goals',null);setTimeout(function(){openCreateGoalModal()},120)" })
  }
  if (!ideas.length) {
    items.push({ label: 'Capture an idea for the backlog', action: "switchPage('ideas',null);setTimeout(function(){openCreateIdeaModal()},120)" })
  }
  if (projects.length && !events.length) {
    items.push({ label: 'Add a calendar event or milestone', action: "switchPage('calendar',null);setTimeout(function(){openCreateEventModal()},120)" })
  }
  if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner') && !team.length) {
    items.push({ label: 'Invite someone (email or invite code)', action: "switchPage('team',null);setTimeout(function(){openInviteTeamModal()},120)" })
  }
  const slice = items.slice(0, 4)
  if (!slice.length) {
    el.innerHTML = '<span style="font-size:12px;color:#6B7280;">You have things in motion — open Analytics or Overview for trends, or use the board to move tasks forward.</span>'
    return
  }
  el.innerHTML = slice.map(s => `<button type="button" class="workspace-suggestion-chip" onclick="${s.action}">${escapeHtml(s.label)}</button>`).join('')
}

function renderDashboardActivationInsights() {
  const el = document.getElementById('dashboardActivationInsights')
  if (!el) return
  const hasProject = projects.length > 0
  const hasTask = tasks.length > 0
  const hasEvent = events.length > 0
  const hasGoogleConnected = !!googleCalendarConnected
  const hasTeammate = Array.isArray(team) && team.length > 0
  const done = [hasProject, hasTask, hasEvent, hasGoogleConnected, hasTeammate].filter(Boolean).length
  const score = Math.round((done / 5) * 100)
  const lines = [
    `Activation score: <strong style="color:#E5E7EB;">${score}%</strong>`,
    `Projects: ${hasProject ? 'Yes' : 'No'} · Tasks: ${hasTask ? 'Yes' : 'No'} · Events: ${hasEvent ? 'Yes' : 'No'}`,
    `Google Calendar: ${hasGoogleConnected ? 'Connected' : 'Not connected'} · Team: ${hasTeammate ? 'Invited' : 'No teammate yet'}`
  ]
  el.innerHTML = lines.join('<br>')
}

function getWeeklyDigestStats() {
  const now = new Date()
  const weekEnd = new Date(now.getTime() + 7 * 86400000)
  const overdue = tasks.filter(t => {
    if (t.status === 'done' || t.status === 'completed') return false
    const d = parseTaskDueDate(t)
    return d && d < now
  }).length
  const dueSoon = tasks.filter(t => {
    if (t.status === 'done' || t.status === 'completed') return false
    const d = parseTaskDueDate(t)
    return d && d >= now && d <= weekEnd
  }).length
  const mentionsUnread = notifications.filter(n => !n.read && n.type === 'mention').length
  return { overdue, dueSoon, mentionsUnread }
}

function renderWeeklyDigestCard() {
  const el = document.getElementById('dashboardWeeklyDigest')
  if (!el) return
  const stats = getWeeklyDigestStats()
  const summary = []
  summary.push(`Overdue tasks: <strong style="color:${stats.overdue ? '#fca5a5' : '#86efac'};">${stats.overdue}</strong>`)
  summary.push(`Due in 7 days: <strong style="color:#bfdbfe;">${stats.dueSoon}</strong>`)
  summary.push(`Unread mentions: <strong style="color:${stats.mentionsUnread ? '#fde68a' : '#86efac'};">${stats.mentionsUnread}</strong>`)
  summary.push(stats.overdue || stats.dueSoon || stats.mentionsUnread
    ? 'Focus this week: clear overdue first, then close due-soon tasks.'
    : 'Everything looks healthy this week. Keep momentum.')
  el.innerHTML = summary.join('<br>') + '<div style="margin-top:10px;"><button type="button" class="btn-xs btn-secondary" onclick="logWeeklyDigestAck()">I reviewed this digest</button></div>'
}

function logWeeklyDigestAck() {
  logAnalyticsEvent('weekly_digest_ack', {})
  showToast('Thanks — logged.', 'success')
}

function maybeSendWeeklyDigestReminder() {
  if (!currentUser || !currentUser.id) return
  if (userSettings && userSettings.notifWeeklyEnabled === false) return
  const key = 'alco_weekly_digest_last_' + currentUser.id
  const now = new Date()
  const weekNumber = `${now.getFullYear()}-W${Math.ceil((((now - new Date(now.getFullYear(),0,1)) / 86400000) + new Date(now.getFullYear(),0,1).getDay()+1) / 7)}`
  let last = ''
  try { last = localStorage.getItem(key) || '' } catch (e) {}
  if (last === weekNumber) return
  const stats = getWeeklyDigestStats()
  addNotification(`Weekly digest: ${stats.overdue} overdue, ${stats.dueSoon} due soon, ${stats.mentionsUnread} unread mentions.`, 'digest')
  logAnalyticsEvent('weekly_digest_notification', { overdue: stats.overdue, dueSoon: stats.dueSoon })
  try { localStorage.setItem(key, weekNumber) } catch (e) {}
}

/** Pending row is obsolete if someone accepted with the same email (data can lag behind join-with-code). */
function isTeamPendingSuperseded(m) {
  if (!m || m.status !== 'pending') return false
  const e = (m.email || '').toLowerCase()
  if (!e) return false
  return team.some(x => x && x.status === 'accepted' && (x.email || '').toLowerCase() === e)
}

/** You + accepted teammates + workspace owner when owner is not you (owner is not stored in team[]). */
function workspacePeopleHeadcount() {
  if (!currentUser) return Math.max(1, team.filter(m => m.status === 'accepted').length)
  const acceptedOthers = team.filter(m => m.status === 'accepted' && m.id !== currentUser.id).length
  const ownerExtra =
    workspaceOwnerSummary &&
    workspaceOwnerSummary.id &&
    workspaceOwnerSummary.id !== currentUser.id &&
    !team.some(m => m && m.id === workspaceOwnerSummary.id)
      ? 1
      : 0
  return acceptedOthers + 1 + ownerExtra
}

function updateStats() {
  let doneTasks = tasks.filter(t => t.status === 'done').length
  let rate      = tasks.length > 0 ? Math.round((doneTasks / tasks.length) * 100) : 0
  // Stats for entire workspace (not per-user)
  let totalSecs = timeEntries.reduce((s, e) => s + (e.duration || 0), 0)
  let weekSecs  = timeEntries.filter(e => {
    let d = new Date(e.date)
    let now = new Date()
    let weekAgo = new Date(now - 7*86400000)
    return d >= weekAgo
  }).reduce((s, e) => s + (e.duration || 0), 0)

  const activeTasks = tasks.filter(t => t.status !== 'done').length
  const nTodo = tasks.filter(t => t.status === 'todo').length
  const nMotion = tasks.filter(t => t.status === 'in-progress' || t.status === 'review').length
  const activeProjCount = projects.filter(p => p.status === 'active').length
  const completedProjCount = projects.filter(p => p.status === 'completed').length
  const pendingInvites = team.filter(m => m.status === 'pending' && !isTeamPendingSuperseded(m)).length

  const setTrendText = (id, text) => {
    const el = document.getElementById(id)
    if (el) el.textContent = text
  }

  document.getElementById('statProjects').textContent   = projects.length
  document.getElementById('statTasks').textContent      = activeTasks
  document.getElementById('statTeam').textContent       = String(workspacePeopleHeadcount())
  document.getElementById('statCompletion').textContent = rate + '%'
  document.getElementById('statHours').textContent      = formatHours(weekSecs)
  document.getElementById('statIdeas').textContent      = ideas.length
  document.getElementById('quickIdeas').textContent     = ideas.length
  document.getElementById('quickEvents').textContent    = events.length
  document.getElementById('quickCompleted').textContent = doneTasks
  document.getElementById('quickHours').textContent     = formatHours(totalSecs)

  setTrendText('statProjectsTrendText', `${activeProjCount} active • ${completedProjCount} completed`)
  setTrendText('statTasksTrendText', `${nTodo} todo • ${nMotion} in progress / review`)
  setTrendText('statTeamTrendText', pendingInvites ? `${pendingInvites} invite(s) pending` : `${workspacePeopleHeadcount()} people in workspace`)
  setTrendText('statCompletionTrendText', tasks.length ? `${doneTasks} of ${tasks.length} tasks done` : 'Add tasks to measure throughput')
  setTrendText('statHoursTrendText', `${formatHours(totalSecs)} all-time • ${formatHours(weekSecs)} this week`)
  setTrendText('statIdeasTrendText', ideas.length ? `${ideas.length} in backlog` : 'Capture ideas from the team')

  if (currentUser) {
    const owned = projects.filter(p => p.owner === currentUser.id).length
    const assignedOpen = tasks.filter(t => t.assignee === currentUser.id && t.status !== 'done').length
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const monthSecs = timeEntries.filter(e => {
      if (!e.userId || e.userId !== currentUser.id) return false
      const d = new Date(e.date)
      return !isNaN(d.getTime()) && d >= monthStart
    }).reduce((s, e) => s + (e.duration || 0), 0)
    const psp = document.getElementById('profileStatProjects')
    const pst = document.getElementById('profileStatTasks')
    const psh = document.getElementById('profileStatHoursMonth')
    if (psp) psp.textContent = owned
    if (pst) pst.textContent = assignedOpen
    if (psh) psh.textContent = formatHours(monthSecs)
  }

  renderDashboardPulseAndOnboarding()
  renderDashboardSuggestions()
  renderDashboardWorkload()

  // Today for you (dashboard)
  const myTodayEl = document.getElementById('dashboardMyToday')
  if (myTodayEl && currentUser) {
    const now = new Date()
    const todayStr = now.toISOString().split('T')[0]

    const myTasks = tasks.filter(t => t.assignee === currentUser.id)
    const upcomingMyTasks = myTasks
      .filter(t => t.dueDate)
      .map(t => ({ t, d: new Date(t.dueDate.includes('T') ? t.dueDate : (t.dueDate + 'T09:00')) }))
      .filter(x => !isNaN(x.d.getTime()))
      .sort((a,b) => a.d - b.d)
      .slice(0, 3)

    const myGoals = goals.filter(g => g.ownerId === currentUser.id)
    const todayGoals = myGoals.filter(g => (g.dueDate || '').startsWith(todayStr))

    let html = ''
    if (!upcomingMyTasks.length && !todayGoals.length) {
      html = `<div style="font-size:13px;color:#9CA3AF;line-height:1.5;">
        <p style="margin:0 0 8px 0;">Nothing urgent assigned to you for today.</p>
        <p style="margin:0;font-size:12px;color:#6B7280;">Use the focus for deep work, or pull the next item from your task list.</p>
      </div>
      <button type="button" class="btn-secondary" style="margin-top:12px;" onclick="switchPage('tasks', null)">View tasks</button>`
    } else {
      if (upcomingMyTasks.length) {
        html += '<div class="section-label">Your next tasks</div>'
        html += '<ul style="list-style:none;padding:0;margin:6px 0 10px 0;display:flex;flex-direction:column;gap:6px;">'
        html += upcomingMyTasks.map(x => {
          const label = x.d.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
          return `<li style="display:flex;justify-content:space-between;gap:8px;">
            <span style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(x.t.title)}</span>
            <span style="font-size:11px;color:#9CA3AF;">${label}</span>
          </li>`
        }).join('')
        html += '</ul>'
      }
      if (todayGoals.length) {
        html += '<div class="section-label" style="margin-top:6px;">Goals due today</div>'
        html += '<ul style="list-style:none;padding:0;margin:6px 0 0 0;display:flex;flex-direction:column;gap:4px;">'
        html += todayGoals.map(g => `<li style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🎯 ${escapeHtml(g.title)}</li>`).join('')
        html += '</ul>'
      }
    }
    myTodayEl.innerHTML = html
  }
}

/* ===================================================
   PROJECTS
=================================================== */
function openCreateProjectModal() {
  if (!ensureCurrentUser()) {
    showToast('Please sign in to create a project', 'error')
    return
  }
  fillAssigneeSelect(document.getElementById('modalProjectOwner'), currentUser.id)
  document.getElementById('createProjectModal').classList.add('active')
  document.getElementById('modalProjectDeadline').value = ''
  document.getElementById('modalProjectStart').value    = new Date().toISOString().split('T')[0]
}

function closeCreateProjectModal() {
  document.getElementById('createProjectModal').classList.remove('active')
  ;['modalProjectName','modalProjectDesc','modalProjectTags'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  document.getElementById('modalProjectPriority').value = 'medium'
  document.getElementById('modalProjectStatus').value   = 'active'
}

function saveProject() {
  if (!ensureCurrentUser()) {
    showToast('Please sign in to create a project', 'error')
    return
  }
  let name     = document.getElementById('modalProjectName').value.trim()
  let desc     = document.getElementById('modalProjectDesc').value.trim()
  let deadline = document.getElementById('modalProjectDeadline').value
  let start    = document.getElementById('modalProjectStart').value
  let priority = document.getElementById('modalProjectPriority').value
  let status   = document.getElementById('modalProjectStatus').value
  let tagsRaw  = document.getElementById('modalProjectTags').value.trim()
  let tags     = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : []

  if (!name) return showToast('Please enter a project name', 'error')

  const nowIso = new Date().toISOString()
  const ownerId = (document.getElementById('modalProjectOwner') && document.getElementById('modalProjectOwner').value) || currentUser.id
  let project = {
    id: genId(), name, description: desc, deadline, startDate: start,
    priority, status, tags, owner: ownerId, progress: 0,
    created: nowIso,
    updated: nowIso
  }

  projects.push(project)
  save('projects', projects)
  if (projects.length === 1) logAnalyticsEvent('first_project_created', { name: name })
  closeCreateProjectModal()
  renderProjects()
  renderDashboardCharts()
  addActivity(`Created project: ${name}`)
  addNotification(`Project "${name}" created`, 'project')
  addAuditLog('create', `Created project "${name}"`, 'create', { projectId: project.id })
  showToast('Project created!', 'success')
  updateStats()
  populateTimerProjectSelect()
  populateTaskProjectFilter()
}

function projectPrioritySortVal(pr) {
  const o = { critical: 4, high: 3, medium: 2, low: 1 }
  return o[pr] || 0
}

function getProjectTaskStats(projectId) {
  const ts = tasks.filter(t => t.projectId === projectId)
  return {
    total: ts.length,
    done: ts.filter(t => t.status === 'done').length,
    todo: ts.filter(t => t.status === 'todo').length,
    ip: ts.filter(t => t.status === 'in-progress').length,
    rev: ts.filter(t => t.status === 'review').length
  }
}

function formatDetailTimestamp(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function renderDetailKvRow(label, valueHtml) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #1F2937;font-size:12px;">
    <span style="color:#9CA3AF;flex-shrink:0;">${escapeHtml(label)}</span>
    <span style="color:#E5E7EB;text-align:right;word-break:break-word;max-width:68%;">${valueHtml}</span>
  </div>`
}

function collectAuditLogsForProject(projectId) {
  const p = projects.find(x => x.id === projectId)
  if (!p) return []
  const taskIdSet = new Set(tasks.filter(t => t.projectId === projectId).map(t => t.id))
  const quoted = p.name ? `"${p.name}"` : ''
  return auditLogs.filter(l => {
    if (l.projectId === projectId) return true
    if (l.taskId && taskIdSet.has(l.taskId)) return true
    if (quoted && String(l.text || '').includes(quoted)) return true
    return false
  })
}

function collectAuditLogsForTask(task) {
  if (!task) return []
  const tid = task.id
  const quoted = task.title ? `"${task.title}"` : ''
  return auditLogs.filter(l => {
    if (l.taskId === tid) return true
    if (quoted && String(l.text || '').includes(quoted) && /task/i.test(String(l.text || ''))) return true
    return false
  })
}

function renderDetailAuditHtml(logs, max) {
  const cap = typeof max === 'number' ? max : 50
  const slice = logs.slice(0, cap)
  const iconMap = { create: '➕', update: '✏️', delete: '🗑', login: '🔑', other: '⚡' }
  if (!slice.length) {
    return '<div style="color:#6B7280;font-size:12px;">No matching audit entries yet.</div>'
  }
  return slice.map(log => `
    <div style="padding:8px 0;border-bottom:1px solid #1F2937;">
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <span style="flex-shrink:0;">${iconMap[log.iconType] || '⚡'}</span>
        <div style="min-width:0;flex:1;">
          <div style="color:#E5E7EB;font-size:12px;">${escapeHtml(log.text)}</div>
          <div style="color:#6B7280;font-size:11px;">${escapeHtml(log.user)} · ${escapeHtml(timeAgo(log.timestamp))}</div>
        </div>
      </div>
    </div>
  `).join('')
}

function getTimeEntriesForProject(projectId) {
  const taskIdSet = new Set(tasks.filter(t => t.projectId === projectId).map(t => t.id))
  return timeEntries.filter(e => e.projectId === projectId || (e.taskId && taskIdSet.has(e.taskId)))
}

function openProjectDetail(projectId) {
  closeTaskDetail()
  const p = projects.find(x => x.id === projectId)
  if (!p) return
  currentProjectDetailId = projectId
  const titleEl = document.getElementById('projectDetailTitle')
  if (titleEl) titleEl.textContent = p.name

  const ownerLabel = p.owner && currentUser && p.owner === currentUser.id
    ? 'You'
    : (team.find(m => m.id === p.owner)?.email || '').split('@')[0] || p.owner || '—'

  const st = getProjectTaskStats(p.id)
  const taskCount = st.total
  const doneCount = st.done
  const progress = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0

  let deadlineLine = '—'
  if (p.deadline) {
    const raw = new Date(p.deadline)
    if (!isNaN(raw.getTime())) deadlineLine = formatDetailTimestamp(p.deadline)
  }
  let startLine = '—'
  if (p.startDate) {
    const sd = new Date(p.startDate.includes('T') ? p.startDate : p.startDate + 'T12:00')
    if (!isNaN(sd.getTime())) startLine = formatDetailTimestamp(sd.toISOString())
  }

  let projEntries = getTimeEntriesForProject(p.id)
  projEntries = projEntries.slice().sort((a, b) => {
    const ta = new Date(a.created || a.date || 0).getTime()
    const tb = new Date(b.created || b.date || 0).getTime()
    return tb - ta
  })
  const totalSecs = projEntries.reduce((s, e) => s + (e.duration || 0), 0)
  const projTasks = tasks.filter(t => t.projectId === p.id)
  const byTask = {}
  projTasks.forEach(t => { byTask[t.id] = { title: t.title, secs: 0 } })
  projEntries.forEach(e => {
    const dur = e.duration || 0
    if (e.taskId && byTask[e.taskId]) byTask[e.taskId].secs += dur
    else if (e.taskId && !byTask[e.taskId]) {
      if (!byTask['__orphan']) byTask['__orphan'] = { title: 'Other task (moved/removed)', secs: 0 }
      byTask['__orphan'].secs += dur
    } else if (!e.taskId) {
      if (!byTask['__proj']) byTask['__proj'] = { title: 'Project time (no task)', secs: 0 }
      byTask['__proj'].secs += dur
    }
  })
  const breakdownRows = Object.keys(byTask).map(k => {
    const row = byTask[k]
    if (!row.secs) return ''
    return renderDetailKvRow(row.title, escapeHtml(formatHours(row.secs)))
  }).join('')

  const recentEntries = projEntries.slice(0, 15).map(e => {
    const who = e.userName || '—'
    const d = e.date || (e.created ? e.created.split('T')[0] : '')
    const tk = e.taskId ? (tasks.find(t => t.id === e.taskId)?.title || 'Task') : ''
    return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px solid #1F2937;color:#E5E7EB;">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.description || '—')}${tk ? ` <span style="color:#6B7280;">(${escapeHtml(tk)})</span>` : ''}</span>
      <span style="flex-shrink:0;color:#9CA3AF;">${escapeHtml(d)} · ${escapeHtml(who)} · ${escapeHtml(formatHours(e.duration || 0))}</span>
    </div>`
  }).join('')

  const projectAuditSlice = collectAuditLogsForProject(p.id)
  const goalCount = goals.filter(g => g.projectId === p.id).length
  const tagsHtml = (p.tags || []).length ? escapeHtml((p.tags || []).join(', ')) : '—'

  const body = document.getElementById('projectDetailBody')
  if (body) {
    body.innerHTML = `
      <div style="font-size:11px;color:#6B7280;margin-bottom:10px;">Full project snapshot — fields, time, and audit lines for this project and its tasks.</div>
      <div style="font-size:12px;color:#9CA3AF;margin-bottom:4px;">Properties</div>
      <div style="margin-bottom:14px;">
        ${renderDetailKvRow('Project ID', `<code style="font-size:11px;">${escapeHtml(p.id)}</code>`)}
        ${renderDetailKvRow('Status', escapeHtml(p.status || '—'))}
        ${renderDetailKvRow('Priority', escapeHtml(p.priority || '—'))}
        ${renderDetailKvRow('Owner', escapeHtml(ownerLabel))}
        ${renderDetailKvRow('Start', escapeHtml(startLine))}
        ${renderDetailKvRow('Deadline', escapeHtml(deadlineLine))}
        ${renderDetailKvRow('Tags', tagsHtml)}
        ${renderDetailKvRow('Description', escapeHtml((p.description || '').trim() || '—'))}
        ${renderDetailKvRow('Task progress', escapeHtml(`${doneCount}/${taskCount} done (${progress}%)`))}
        ${renderDetailKvRow('Goals linked', escapeHtml(String(goalCount)))}
        ${renderDetailKvRow('Created', escapeHtml(formatDetailTimestamp(p.created)))}
        ${renderDetailKvRow('Updated', escapeHtml(formatDetailTimestamp(p.updated)))}
      </div>
      <div style="font-size:12px;color:#9CA3AF;margin-bottom:4px;">Time on this project</div>
      <div style="margin-bottom:8px;font-size:13px;color:#E5E7EB;">${totalSecs > 0 ? escapeHtml(formatHours(totalSecs)) + ' total logged' : '<span style="color:#6B7280;">No time logged yet</span>'}</div>
      ${breakdownRows ? `<div style="font-size:11px;color:#6B7280;margin-bottom:4px;">By task</div><div style="margin-bottom:14px;">${breakdownRows}</div>` : ''}
      <div style="font-size:11px;color:#6B7280;margin-bottom:4px;">Recent entries (up to 15)</div>
      <div style="margin-bottom:14px;max-height:220px;overflow-y:auto;">${recentEntries || '<span style="color:#6B7280;font-size:12px;">No entries.</span>'}</div>
      <div style="font-size:12px;color:#9CA3AF;margin-bottom:4px;">Audit log</div>
      <div style="max-height:260px;overflow-y:auto;">${renderDetailAuditHtml(projectAuditSlice, 60)}</div>
    `
  }

  const panel = document.getElementById('projectDetailPanel')
  if (panel) {
    panel.classList.add('active')
    panel.classList.remove('hidden')
  }
}

function closeProjectDetail() {
  currentProjectDetailId = null
  const panel = document.getElementById('projectDetailPanel')
  if (panel) panel.classList.remove('active')
}

/** Used with “My projects” filter: lead, or has at least one task assigned in this project */
function projectInvolvesUser(p, userId) {
  if (!userId || !p) return false
  if (p.owner === userId) return true
  return tasks.some(t => t.projectId === p.id && t.assignee === userId)
}

function formatRelativeActivity(iso) {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '—'
  const diff = Date.now() - t
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 14) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getProjectsForList() {
  let search = (document.getElementById('projectSearch')?.value || '').toLowerCase()
  let priority = document.getElementById('projectFilter')?.value || ''
  let status = document.getElementById('projectStatusFilter')?.value || ''
  let myOnly = document.getElementById('projectMyOnly')?.checked
  let sortBy = document.getElementById('projectSortBy')?.value || 'recent'

  let filtered = projects.filter(p => {
    let matchSearch = p.name.toLowerCase().includes(search) ||
      (p.description || '').toLowerCase().includes(search) ||
      (p.tags || []).some(t => (t || '').toLowerCase().includes(search))
    let matchPriority = !priority || p.priority === priority
    let matchStatus = !status || p.status === status
    let matchMine = !myOnly || !currentUser || projectInvolvesUser(p, currentUser.id)
    return matchSearch && matchPriority && matchStatus && matchMine
  })

  const deadlineTs = (p) => {
    if (!p.deadline) return null
    const d = new Date(p.deadline)
    return isNaN(d.getTime()) ? null : d.getTime()
  }
  const recentTs = (p) => {
    const u = p.updated || p.created
    return u ? new Date(u).getTime() : 0
  }

  filtered.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    if (sortBy === 'deadline') {
      const da = deadlineTs(a), db = deadlineTs(b)
      if (da === null && db === null) return recentTs(b) - recentTs(a)
      if (da === null) return 1
      if (db === null) return -1
      return da - db
    }
    if (sortBy === 'progress') {
      const pa = getProjectTaskStats(a.id), pb = getProjectTaskStats(b.id)
      const pra = pa.total ? pa.done / pa.total : 0
      const prb = pb.total ? pb.done / pb.total : 0
      if (prb !== pra) return prb - pra
      return recentTs(b) - recentTs(a)
    }
    if (sortBy === 'tasks') {
      const ca = getProjectTaskStats(a.id).total
      const cb = getProjectTaskStats(b.id).total
      if (cb !== ca) return cb - ca
      return recentTs(b) - recentTs(a)
    }
    if (sortBy === 'priority') {
      const diff = projectPrioritySortVal(b.priority) - projectPrioritySortVal(a.priority)
      if (diff !== 0) return diff
      return recentTs(b) - recentTs(a)
    }
    return recentTs(b) - recentTs(a)
  })

  return filtered
}

function updateProjectsSummaryBar(filteredCount) {
  const el = document.getElementById('projectsSummaryBar')
  if (!el) return
  const total = projects.length
  if (!total) {
    el.textContent = 'No projects yet — create one to see workload, deadlines, and time in this portfolio.'
    return
  }
  const active = projects.filter(p => p.status === 'active').length
  const mine = currentUser ? projects.filter(p => p.owner === currentUser.id).length : 0
  let line = `${total} project${total === 1 ? '' : 's'} · ${active} active · ${mine} owned by you`
  if (filteredCount !== total) {
    line += ` · showing ${filteredCount} match${filteredCount === 1 ? '' : 'es'}`
  }
  el.textContent = line
}

function buildProjectCard(p) {
  const st = getProjectTaskStats(p.id)
  const taskCount = st.total
  const doneCount = st.done
  const progress = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0
  let daysLeft = null
  if (p.deadline) {
    const raw = new Date(p.deadline)
    if (!isNaN(raw.getTime())) daysLeft = Math.ceil((raw - new Date()) / 86400000)
  }
  let deadlineHtml = ''
  if (daysLeft !== null) {
    deadlineHtml = daysLeft < 0
      ? `<span style="color:#ef4444;">Overdue ${Math.abs(daysLeft)}d</span>`
      : daysLeft === 0 ? `<span style="color:#f59e0b;">Due today</span>`
      : `<span>${daysLeft}d to deadline</span>`
  }
  let tagsHtml = (p.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
  const projectSecs = timeEntries.filter(e => e.projectId === p.id).reduce((s, e) => s + (e.duration || 0), 0)
  const goalCount = goals.filter(g => g.projectId === p.id).length

  let healthClass = 'ok'
  let healthLabel = 'On track'
  if (daysLeft !== null) {
    if (daysLeft < 0 && progress < 85) {
      healthClass = 'bad'
      healthLabel = 'Overdue'
    } else if (daysLeft <= 3 && progress < 40 && p.status === 'active') {
      healthClass = 'risk'
      healthLabel = 'At risk'
    }
  }

  const desc = (p.description || '').trim()
  const descHtml = desc
    ? `<p style="color:#9CA3AF;font-size:13px;margin-bottom:10px;line-height:1.5;">${escapeHtml(desc)}</p>`
    : `<p class="project-desc-placeholder" style="font-size:13px;margin-bottom:10px;line-height:1.5;">No description — add context in Edit so teammates know what “done” means.</p>`

  let startHint = ''
  if (p.startDate) {
    const sd = new Date(p.startDate.includes('T') ? p.startDate : p.startDate + 'T12:00')
    if (!isNaN(sd.getTime())) {
      startHint = `Started ${sd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    }
  }

  const activityIso = p.updated || p.created
  const activityLine = `Updated ${formatRelativeActivity(activityIso)}`

  const ownerLabel = p.owner && currentUser && p.owner === currentUser.id
    ? 'You'
    : (team.find(m => m.id === p.owner)?.email || '').split('@')[0] || 'Member'

  return `
    <div class="project-card ${escapeHtml(p.priority)}">
      <div class="project-header">
        <h3>${escapeHtml(p.name)}</h3>
        <span class="priority-badge ${escapeHtml(p.priority)}">${escapeHtml(p.priority)}</span>
      </div>
      ${descHtml}
      ${tagsHtml ? `<div class="project-tags">${tagsHtml}</div>` : ''}
      <div class="project-task-pipeline" title="Task counts by column">
        <span class="pp-todo">To do ${st.todo}</span>
        <span class="pp-ip">In prog ${st.ip}</span>
        <span class="pp-rev">Review ${st.rev}</span>
        <span class="pp-done">Done ${st.done}</span>
      </div>
      <div class="project-progress">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
          <span style="color:#6B7280;">${doneCount}/${taskCount} tasks complete</span>
          <span>${progress}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
      </div>
      <div class="project-meta">
        <span>${projectSecs > 0 ? formatHours(projectSecs) + ' logged' : 'No time logged'}</span>
        ${deadlineHtml || '<span>No deadline</span>'}
      </div>
      <div class="project-card-foot">
        <span class="project-health ${healthClass}">${healthLabel}</span>
        <span>${goalCount} goal${goalCount === 1 ? '' : 's'} linked · ${ownerLabel === 'You' ? 'Owned by you' : 'Lead: ' + escapeHtml(ownerLabel)}</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px;font-size:11px;color:#6B7280;">
        <span style="font-size:11px;padding:2px 8px;border-radius:12px;font-weight:600;${p.status === 'active' ? 'background:#1b4332;color:#86efac;' : p.status === 'completed' ? 'background:#1e3a5f;color:#93c5fd;' : 'background:#3b2a0d;color:#fcd34d;'}">${escapeHtml(p.status)}</span>
        <span>${activityLine}</span>
        ${startHint ? `<span>· ${startHint}</span>` : ''}
      </div>
      <div class="project-actions">
        <button class="btn-sm btn-outline" onclick="goToTasksForProject('${p.id}')">Board</button>
        <button class="btn-sm btn-outline" onclick="openProjectDetail('${p.id}')">Details</button>
        <button class="btn-sm" onclick="editProject('${p.id}')">✏ Edit</button>
        <button class="btn-sm btn-secondary" onclick="addTaskToProject('${p.id}')">+ Task</button>
        <button class="btn-sm btn-danger" onclick="deleteProject('${p.id}')">Delete</button>
      </div>
    </div>
  `
}

function paintProjectsList() {
  const list = getProjectsForList()
  updateProjectsSummaryBar(list.length)
  const html = list.map(buildProjectCard).join('')
  const container = document.getElementById('projectsList')
  if (!container) return
  if (html) {
    container.innerHTML = html
    return
  }
  if (projects.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📁</div><h3>No projects yet</h3><p>Create a project to group tasks, time, and goals. You will see workload, deadlines, and health on each card.</p><button class="btn-primary btn-sm" onclick="openCreateProjectModal()">+ New Project</button></div>`
  } else {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No matching projects</h3><p>Adjust search, status, priority, or “My projects” — or reset everything.</p><button class="btn-secondary btn-sm" onclick="clearProjectFilters()">Reset filters</button></div>`
  }
}

function renderProjects() {
  paintProjectsList()
}

function clearProjectFilters() {
  let searchEl = document.getElementById('projectSearch')
  let priorityEl = document.getElementById('projectFilter')
  let statusEl = document.getElementById('projectStatusFilter')
  let sortEl = document.getElementById('projectSortBy')
  let myEl = document.getElementById('projectMyOnly')
  if (searchEl) searchEl.value = ''
  if (priorityEl) priorityEl.value = ''
  if (statusEl) statusEl.value = ''
  if (sortEl) sortEl.value = 'recent'
  if (myEl) myEl.checked = false
  paintProjectsList()
}

function filterProjects() {
  paintProjectsList()
}

function populateTaskProjectFilter() {
  const sel = document.getElementById('taskProjectFilter')
  if (!sel) return
  const prev = sel.value
  sel.innerHTML = '<option value="">All projects</option>'
  projects.forEach(p => {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    sel.appendChild(opt)
  })
  if (prev && projects.some(p => p.id === prev)) sel.value = prev
}

/** Me + accepted teammates — for tasks, goals, project lead */
function fillAssigneeSelect(selectEl, selectedId) {
  if (!selectEl || !currentUser) return
  selectEl.innerHTML = ''
  const me = document.createElement('option')
  me.value = currentUser.id
  me.textContent = currentUser.fullName || currentUser.username || 'Me'
  selectEl.appendChild(me)
  if (workspaceOwnerSummary && workspaceOwnerSummary.id && workspaceOwnerSummary.id !== currentUser.id) {
    const oo = document.createElement('option')
    oo.value = workspaceOwnerSummary.id
    const em = (workspaceOwnerSummary.email || '').trim()
    const lab = workspaceOwnerSummary.fullName || workspaceOwnerSummary.username || 'Workspace owner'
    oo.textContent = em ? (lab + ' · ' + em) : lab
    selectEl.appendChild(oo)
  }
  team.filter(m => m.status === 'accepted' && m.id !== currentUser.id && (!workspaceOwnerSummary || m.id !== workspaceOwnerSummary.id)).forEach(m => {
    const opt = document.createElement('option')
    opt.value = m.id
    const em = (m.email || '').trim()
    opt.textContent = em ? (em.split('@')[0] + ' · ' + em) : (m.id || 'Teammate')
    selectEl.appendChild(opt)
  })
  const want = selectedId || currentUser.id
  selectEl.value = [...selectEl.options].some(o => o.value === want) ? want : currentUser.id
}

function goToTasksForProject(projectId) {
  switchPage('tasks', null)
  setTimeout(() => {
    populateTaskProjectFilter()
    const sel = document.getElementById('taskProjectFilter')
    if (sel) sel.value = projectId
    filterTasks()
  }, 0)
}

function editProject(id) {
  let p = projects.find(x => x.id === id)
  if (!p) return
  document.getElementById('editProjectId').value        = p.id
  document.getElementById('editProjectName').value      = p.name
  document.getElementById('editProjectDesc').value      = p.description || ''
  document.getElementById('editProjectPriority').value  = p.priority
  document.getElementById('editProjectStatus').value    = p.status
  fillAssigneeSelect(document.getElementById('editProjectOwner'), p.owner || currentUser.id)
  // Keep backward compatibility with old date-only deadlines
  let dl = p.deadline || ''
  if (dl && typeof dl === 'string' && !dl.includes('T')) dl = dl + 'T09:00'
  document.getElementById('editProjectDeadline').value  = dl
  document.getElementById('editProjectModal').classList.add('active')
}

function saveEditProject() {
  let id   = document.getElementById('editProjectId').value
  let proj = projects.find(p => p.id === id)
  if (!proj) return
  let name = document.getElementById('editProjectName').value.trim()
  if (!name) return showToast('Project name is required', 'error')

  proj.name        = name
  proj.description = document.getElementById('editProjectDesc').value.trim()
  proj.priority    = document.getElementById('editProjectPriority').value
  proj.status      = document.getElementById('editProjectStatus').value
  const leadEl = document.getElementById('editProjectOwner')
  proj.owner       = (leadEl && leadEl.value) || currentUser.id
  proj.deadline    = document.getElementById('editProjectDeadline').value
  proj.updated     = new Date().toISOString()

  save('projects', projects)
  document.getElementById('editProjectModal').classList.remove('active')
  renderProjects()
  renderDashboardCharts()
  addAuditLog('update', `Updated project "${name}"`, 'update', { projectId: id })
  if (currentProjectDetailId === id) openProjectDetail(id)
  showToast('Project updated!', 'success')
  updateStats()
}

function deleteProject(id) {
  let p = projects.find(x => x.id === id)
  if (!p) return
  openConfirmModal({
    type: 'delete_project',
    id,
    title: 'Delete project',
    message: `This will delete project "${p.name}" and all its tasks and time entries.`,
    level: 'danger'
  })
}

function reallyDeleteProject(id) {
  let p = projects.find(x => x.id === id)
  // Collect related tasks and time entries so we can clean them up too
  let projectTaskIds = tasks.filter(t => t.projectId === id).map(t => t.id)

  projects   = projects.filter(x => x.id !== id)
  tasks      = tasks.filter(t => t.projectId !== id)
  timeEntries = timeEntries.filter(e => e.projectId !== id && !projectTaskIds.includes(e.taskId))

  save('projects', projects)
  save('tasks', tasks)
  save('time', timeEntries)
  renderProjects()
  renderTasks()
  renderTimeTracking()
  renderDashboardCharts()
  populateTaskProjectFilter()
  addAuditLog('delete', `Deleted project "${p?.name}"`, 'delete', { projectId: id })
  if (currentProjectDetailId === id) closeProjectDetail()
  showToast('Project deleted', 'success')
  updateStats()
}

function addTaskToProject(projectId) {
  openCreateTaskModal()
  setTimeout(() => {
    document.getElementById('modalTaskProject').value = projectId
  }, 100)
}

/* ===================================================
   TASKS
=================================================== */
function populateProjectSelect(selectId) {
  let sel = document.getElementById(selectId)
  if (!sel) return
  sel.innerHTML = '<option value="">No project</option>'
  projects.forEach(p => {
    let opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    sel.appendChild(opt)
  })
}

function openCreateTaskModal() {
  if (!ensureCurrentUser()) {
    showToast('Please sign in to create a task', 'error')
    return
  }
  populateProjectSelect('modalTaskProject')
  fillAssigneeSelect(document.getElementById('modalTaskAssignee'), preferredTaskAssigneeId || currentUser.id)
  populateGoalSelect('modalTaskGoal', '')
  populateGoalKrSelect('', 'modalTaskGoalKR', '')
  preferredTaskAssigneeId = ''
  document.getElementById('modalTaskStatus').value    = 'todo'
  document.getElementById('modalTaskInitStatus').value= 'todo'
  document.getElementById('modalTaskRecurrence').value = ''
  document.getElementById('modalTaskRepeatOnDone').checked = true
  document.getElementById('createTaskModal').classList.add('active')
}

function openCreateTaskModalWithStatus(status) {
  openCreateTaskModal()
  document.getElementById('modalTaskStatus').value     = status
  document.getElementById('modalTaskInitStatus').value = status
}

function closeCreateTaskModal() {
  document.getElementById('createTaskModal').classList.remove('active')
  ;['modalTaskTitle','modalTaskDesc','modalTaskEstimate'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  document.getElementById('modalTaskDue').value      = ''
  document.getElementById('modalTaskPriority').value = 'medium'
  document.getElementById('modalTaskStatus').value   = 'todo'
  document.getElementById('modalTaskRecurrence').value = ''
  document.getElementById('modalTaskRepeatOnDone').checked = true
  const g = document.getElementById('modalTaskGoal'); if (g) g.value = ''
  const kr = document.getElementById('modalTaskGoalKR'); if (kr) kr.value = ''
}

function saveTask() {
  if (!ensureCurrentUser()) {
    showToast('Please sign in to create a task', 'error')
    return
  }
  let title    = document.getElementById('modalTaskTitle').value.trim()
  let desc     = document.getElementById('modalTaskDesc').value.trim()
  let projId   = document.getElementById('modalTaskProject').value
  let priority = document.getElementById('modalTaskPriority').value
  let status   = document.getElementById('modalTaskStatus').value
  let dueDate  = document.getElementById('modalTaskDue').value
  let estimate = parseFloat(document.getElementById('modalTaskEstimate').value) || 0
  const recurrence = document.getElementById('modalTaskRecurrence')?.value || ''
  const repeatOnDone = !!document.getElementById('modalTaskRepeatOnDone')?.checked
  const goalId = document.getElementById('modalTaskGoal')?.value || ''
  const goalKrId = document.getElementById('modalTaskGoalKR')?.value || ''
  const assignTo = (document.getElementById('modalTaskAssignee') && document.getElementById('modalTaskAssignee').value) || currentUser.id

  if (!title) return showToast('Please enter a task title', 'error')

  let task = {
    id: genId(), title, description: desc, projectId: projId,
    priority, status, dueDate, assignee: assignTo,
    estimatedHours: estimate,
    recurrence: recurrence ? { freq: recurrence, createNextOnDone: repeatOnDone } : null,
    goalId: goalId || null,
    goalKrId: goalKrId || null,
    created: new Date().toISOString()
  }

  tasks.push(task)
  save('tasks', tasks)
  if (tasks.length === 1) logAnalyticsEvent('first_task_created', { title: title })
  closeCreateTaskModal()
  renderTasks()
  renderActivityFeed()
  renderDashboardCharts()
  addActivity(`Created task: ${title}`)
  addNotification(`Task "${title}" created`, 'task')
  addAuditLog('create', `Created task "${title}"`, 'create', { projectId: projId || null, taskId: task.id })
  showToast('Task created!', 'success')
  updateStats()
  if (task.status === 'done') runTaskStatusAutomations(task, 'todo', 'done', 'create')
  try { runCustomAutomations({ type: 'task_created', task, oldStatus: '', newStatus: task.status || '', source: 'create' }) } catch (e) {}
}

function buildTaskCard(t) {
  let cls = t.priority || 'medium'
  let project = t.projectId ? projects.find(p => p.id === t.projectId) : null
  let dueLabel = ''
  if (t.dueDate) {
    const d = new Date(t.dueDate.includes('T') ? t.dueDate : (t.dueDate + 'T09:00'))
    dueLabel = isNaN(d.getTime())
      ? t.dueDate
      : d.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
  }
  let dueHtml = t.dueDate ? `<span style="font-size:10px;color:${new Date(t.dueDate.includes('T') ? t.dueDate : (t.dueDate + 'T09:00')) < new Date() ? '#ef4444' : '#6B7280'};">📅 ${escapeHtml(dueLabel)}</span>` : ''
  let tracked = timeEntries.filter(e => e.taskId === t.id).reduce((s, e) => s + (e.duration || 0), 0)
  let timeHtml = tracked > 0 ? `<span class="time-badge" style="font-size:10px;color:#4f46e5;">⏱ ${formatHours(tracked)}</span>` : ''

  let assigneeName = '—'
  if (t.assignee && currentUser && t.assignee === currentUser.id) {
    assigneeName = currentUser.fullName || currentUser.username || 'Me'
  } else if (t.assignee) {
    const member = team.find(m => m.id === t.assignee)
    const em = member && (member.email || '').trim()
    assigneeName = em ? em.split('@')[0] : 'Member'
  }

  return `
    <div class="task-card" data-task-id="${escapeHtml(t.id)}" draggable="true"
         ondragstart="dragStart(event)" ondragend="dragEnd(event)"
         ondblclick="openTaskDetail('${t.id}')">
      ${project ? `<div style="font-size:10px;color:#4f46e5;margin-bottom:5px;font-weight:600;">📁 ${escapeHtml(project.name)}</div>` : ''}
      <h4>${escapeHtml(t.title)}</h4>
      ${t.description ? `<p>${escapeHtml(t.description).substring(0, 80)}${t.description.length > 80 ? '...' : ''}</p>` : ''}
      <div class="task-footer">
        <span class="task-priority-badge ${cls}">${escapeHtml(t.priority)}</span>
        <div style="display:flex;align-items:center;gap:5px;">
          ${timeHtml}
          ${dueHtml}
          <span class="task-assignee" title="${escapeHtml(assigneeName)}">${escapeHtml(assigneeName.charAt(0).toUpperCase())}</span>
        </div>
      </div>
      <div class="task-card-actions">
        <button type="button" class="task-calendar-btn" onclick="event.stopPropagation();convertTaskToCalendarEvent('${t.id}')" title="Add to calendar" aria-label="Add to calendar">📅</button>
        <button type="button" class="task-delete-btn" id="taskDelTrigger-${t.id}" onclick="event.stopPropagation();showDeleteConfirm('${t.id}')" title="Delete task" aria-label="Delete task">🗑</button>
        <div id="deleteConfirm-${t.id}" class="task-delete-confirm hidden">
          <span>Delete?</span>
          <button type="button" class="btn-xs btn-danger" onclick="event.stopPropagation();confirmDeleteTask('${t.id}')">Yes</button>
          <button type="button" class="btn-xs btn-secondary" onclick="event.stopPropagation();hideDeleteConfirm('${t.id}')">No</button>
        </div>
      </div>
    </div>
  `
}
function showDeleteConfirm(id) {
  let row = document.getElementById('deleteConfirm-' + id)
  let btn = document.getElementById('taskDelTrigger-' + id)
  if (row) row.classList.remove('hidden')
  if (btn) btn.classList.add('hidden')
}

function hideDeleteConfirm(id) {
  let row = document.getElementById('deleteConfirm-' + id)
  let btn = document.getElementById('taskDelTrigger-' + id)
  if (row) row.classList.add('hidden')
  if (btn) btn.classList.remove('hidden')
}

function confirmDeleteTask(id) {
  let task = tasks.find(t => t.id === id)
  if (!task) return

  // Remove task and any linked time entries
  tasks = tasks.filter(t => t.id !== id)
  timeEntries = timeEntries.filter(e => e.taskId !== id)
  save('tasks', tasks)
  save('time', timeEntries)
  renderTasks()
  renderTimeTracking()
  renderDashboardCharts()
  updateStats()
  addAuditLog('delete', `Deleted task "${task.title}"`, 'delete', { projectId: task.projectId || null, taskId: id })
  showToast('Task deleted', 'success')
}
function deleteTask(id) {
  let task = tasks.find(t => t.id === id)
  if (!task) return
  openConfirmModal({
    type: 'delete_task',
    id,
    title: 'Delete task',
    message: `This will delete task "${task.title}" and its logged time.`,
    level: 'danger'
  })
}

function reallyDeleteTask(id) {
  let task = tasks.find(t => t.id === id)
  if (!task) return
  tasks = tasks.filter(t => t.id !== id)
  timeEntries = timeEntries.filter(e => e.taskId !== id)
  save('tasks', tasks)
  save('time', timeEntries)
  renderTasks()
  renderTimeTracking()
  renderDashboardCharts()
  updateStats()
  addAuditLog('delete', `Deleted task "${task.title}"`, 'delete', { projectId: task.projectId || null, taskId: id })
  showToast('Task deleted', 'success')
}
function renderTasks(taskList) {
  let source = taskList || tasks
  let columns = { 'todo':[], 'in-progress':[], 'review':[], 'done':[] }
  source.forEach(t => { if (columns[t.status] !== undefined) columns[t.status].push(t); else columns['todo'].push(t) })

  let colIds   = { 'todo':'todoTasks','in-progress':'progressTasks','review':'reviewTasks','done':'doneTasks' }
  let countIds = { 'todo':'countTodo','in-progress':'countProgress','review':'countReview','done':'countDone' }
  let emptyTitles = { 'todo':'No tasks yet','in-progress':'Nothing in progress','review':'Nothing to review','done':'Nothing done yet' }
  let emptyDescs  = { 'todo':'Add a task to get started','in-progress':'Move a task here when you start','review':'Tasks ready for review go here','done':'Completed tasks appear here' }

  Object.keys(columns).forEach(status => {
    let colEl   = document.getElementById(colIds[status])
    let countEl = document.getElementById(countIds[status])
    if (!colEl) return
    if (columns[status].length) {
      colEl.innerHTML = columns[status].map(buildTaskCard).join('')
    } else {
      colEl.innerHTML = `<div class="empty-state compact"><div class="empty-state-icon">📋</div><h3>${emptyTitles[status]}</h3><p>${emptyDescs[status]}</p><button class="btn-sm btn-secondary" onclick="openCreateTaskModalWithStatus('${status}')">+ Add task</button></div>`
    }
    if (countEl) countEl.textContent = columns[status].length
  })
}

function getTaskFilterState() {
  return {
    q: (document.getElementById('taskSearch')?.value || '').toLowerCase(),
    status: document.getElementById('taskFilter')?.value || '',
    priority: document.getElementById('taskPriorityFilter')?.value || '',
    myOnly: !!document.getElementById('taskMyOnly')?.checked,
    projectId: document.getElementById('taskProjectFilter')?.value || ''
  }
}

function getFilteredTasksByState(state) {
  const s = state || getTaskFilterState()
  return tasks.filter(t => {
    let ms = t.title.toLowerCase().includes(s.q) || (t.description || '').toLowerCase().includes(s.q)
    let mst = !s.status || t.status === s.status
    let mp = !s.priority || t.priority === s.priority
    let mo = !s.myOnly || t.assignee === currentUser.id
    let mproj = !s.projectId || t.projectId === s.projectId
    return ms && mst && mp && mo && mproj
  })
}

function renderTaskSavedViews() {
  const sel = document.getElementById('taskSavedViewSelect')
  if (!sel) return
  const views = Array.isArray(userSettings.taskSavedViews) ? userSettings.taskSavedViews : []
  sel.innerHTML = '<option value="">Saved view...</option>' + views.map(v => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('')
}

function applyTaskFilterState(state) {
  if (!state || typeof state !== 'object') return
  const searchEl = document.getElementById('taskSearch')
  const statusEl = document.getElementById('taskFilter')
  const priorityEl = document.getElementById('taskPriorityFilter')
  const myOnlyEl = document.getElementById('taskMyOnly')
  const projectEl = document.getElementById('taskProjectFilter')
  if (searchEl) searchEl.value = state.q || ''
  if (statusEl) statusEl.value = state.status || ''
  if (priorityEl) priorityEl.value = state.priority || ''
  if (myOnlyEl) myOnlyEl.checked = !!state.myOnly
  if (projectEl) projectEl.value = state.projectId || ''
  filterTasks()
}

function saveCurrentTaskViewPrompt() {
  const name = window.prompt('Name this task view:')
  if (!name || !name.trim()) return
  const cleanName = name.trim().slice(0, 60)
  if (!userSettings || typeof userSettings !== 'object') userSettings = {}
  if (!Array.isArray(userSettings.taskSavedViews)) userSettings.taskSavedViews = []
  const state = getTaskFilterState()
  const item = { id: genId(), name: cleanName, state }
  userSettings.taskSavedViews.push(item)
  save('usersettings', userSettings)
  renderTaskSavedViews()
  const sel = document.getElementById('taskSavedViewSelect')
  if (sel) sel.value = item.id
  showToast('Saved task view', 'success')
}

function applySelectedTaskSavedView() {
  const sel = document.getElementById('taskSavedViewSelect')
  if (!sel) return
  const id = sel.value
  if (!id) return
  const views = Array.isArray(userSettings.taskSavedViews) ? userSettings.taskSavedViews : []
  const row = views.find(v => v.id === id)
  if (!row) return
  applyTaskFilterState(row.state || {})
}

function deleteSelectedTaskSavedView() {
  const sel = document.getElementById('taskSavedViewSelect')
  if (!sel || !sel.value) return showToast('Select a saved view first', 'info')
  const id = sel.value
  const views = Array.isArray(userSettings.taskSavedViews) ? userSettings.taskSavedViews : []
  const row = views.find(v => v.id === id)
  if (!row) return
  if (!window.confirm(`Delete saved view "${row.name}"?`)) return
  userSettings.taskSavedViews = views.filter(v => v.id !== id)
  save('usersettings', userSettings)
  renderTaskSavedViews()
  showToast('Saved view deleted', 'success')
}


function filterTasks() {
  let filtered = getFilteredTasksByState(getTaskFilterState())
  renderTasks(filtered)
}

function openTaskDetail(id) {
  let task = tasks.find(t => t.id === id)
  if (!task) return
  closeProjectDetail()
  currentTaskDetailId = id
  let proj = task.projectId ? projects.find(p => p.id === task.projectId) : null

  // Header
  document.getElementById('taskDetailTitle').textContent = task.title
  document.getElementById('taskDetailProjectLabel').textContent = proj ? `📁 ${proj.name}` : 'No project'

  // Fields
  document.getElementById('taskDetailTitleInput').value = task.title
  document.getElementById('taskDetailDescInput').value  = task.description || ''
  document.getElementById('taskDetailStatus').value     = task.status || 'todo'
  document.getElementById('taskDetailPriority').value   = task.priority || 'medium'

  // Assignee select
  let assigneeSel = document.getElementById('taskDetailAssignee')
  if (assigneeSel) {
    fillAssigneeSelect(assigneeSel, task.assignee || currentUser.id)
  }

  // Due
  let due = task.dueDate || ''
  if (due && typeof due === 'string' && !due.includes('T')) due = due + 'T09:00'
  document.getElementById('taskDetailDue').value = due

  // Recurrence + Goal linking
  const recSel = document.getElementById('taskDetailRecurrence')
  const recChk = document.getElementById('taskDetailRepeatOnDone')
  const freq = task.recurrence && task.recurrence.freq ? task.recurrence.freq : ''
  if (recSel) recSel.value = freq
  if (recChk) recChk.checked = task.recurrence ? task.recurrence.createNextOnDone !== false : true
  populateGoalSelect('taskDetailGoal', task.goalId || '')
  populateGoalKrSelect(task.goalId || '', 'taskDetailGoalKR', task.goalKrId || '')

  // Time summary for this task
  let trackedSecs = timeEntries.filter(e => e.taskId === id).reduce((s, e) => s + (e.duration||0), 0)
  document.getElementById('taskDetailTimeSummary').textContent =
    trackedSecs > 0 ? `${formatHours(trackedSecs)} logged on this task` : 'No time logged yet'

  const propsEl = document.getElementById('taskDetailProperties')
  if (propsEl) {
    const projLine = proj
      ? `${escapeHtml(proj.name)} <span style="color:#6B7280;font-size:11px;">(${escapeHtml(proj.id)})</span>`
      : '—'
    propsEl.innerHTML = [
      renderDetailKvRow('Task ID', `<code style="font-size:11px;">${escapeHtml(task.id)}</code>`),
      renderDetailKvRow('Created', escapeHtml(formatDetailTimestamp(task.created))),
      renderDetailKvRow('Updated', task.updated ? escapeHtml(formatDetailTimestamp(task.updated)) : '—'),
      renderDetailKvRow('Project', projLine),
      renderDetailKvRow('Estimated hours', (task.estimatedHours != null && task.estimatedHours > 0) ? escapeHtml(String(task.estimatedHours)) : '—')
    ].join('')
  }

  const teEl = document.getElementById('taskDetailTimeEntries')
  if (teEl) {
    const ents = timeEntries.filter(e => e.taskId === id).slice().sort((a, b) => {
      const ta = new Date(a.created || a.date || 0).getTime()
      const tb = new Date(b.created || b.date || 0).getTime()
      return tb - ta
    }).slice(0, 20)
    if (!ents.length) {
      teEl.innerHTML = '<span style="color:#6B7280;font-size:12px;">No time entries on this task.</span>'
    } else {
      teEl.innerHTML = '<div style="display:flex;flex-direction:column;gap:2px;">' + ents.map(e => {
        const d = e.date || (e.created ? e.created.split('T')[0] : '')
        const who = escapeHtml(e.userName || '—')
        return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px solid #1F2937;color:#E5E7EB;">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.description || '—')}</span>
          <span style="flex-shrink:0;color:#9CA3AF;">${escapeHtml(d)} · ${who} · ${escapeHtml(formatHours(e.duration || 0))}</span>
        </div>`
      }).join('') + '</div>'
    }
  }

  const auEl = document.getElementById('taskDetailAudit')
  if (auEl) {
    auEl.innerHTML = renderDetailAuditHtml(collectAuditLogsForTask(task), 50)
  }

  // Updates/comments
  let updatesEl = document.getElementById('taskDetailUpdates')
  let inputEl   = document.getElementById('taskDetailUpdateInput')
  if (inputEl) inputEl.value = ''
  if (updatesEl) {
    const updates = Array.isArray(task.updates)
      ? task.updates.slice().sort((a,b) => new Date(b.createdAt||b.created) - new Date(a.createdAt||a.created))
      : []
    if (!updates.length) {
      updatesEl.innerHTML = '<span style="font-size:12px;color:#6B7280;">No comments yet. Add one below to capture context for the team.</span>'
    } else {
      updatesEl.innerHTML = `
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px;">
          ${updates.slice(0,8).map(u => {
            const d = u.createdAt || u.created
            const when = d ? new Date(d).toLocaleDateString(undefined,{ month:'short', day:'numeric' }) : ''
            const who  = u.authorName || ''
            const cid = u.id || u.createdAt || u.created || ''
            const canEdit = canEditComment(u.authorId)
            return `<li style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start;">
              <div style="min-width:0;">
                <span style="color:#6B7280;font-size:11px;display:block;margin-bottom:1px;">${when}${who ? ' • '+escapeHtml(who) : ''}</span>
                <span>${escapeHtml(u.text || '')}</span>
              </div>
              ${canEdit ? `<div style="display:flex;gap:4px;flex-shrink:0;">
                <button type="button" class="btn-xs btn-secondary" style="font-size:10px;padding:2px 6px;" onclick="event.stopPropagation();editTaskComment(${JSON.stringify(task.id)}, ${JSON.stringify(cid)})">Edit</button>
                <button type="button" class="btn-xs btn-danger" style="font-size:10px;padding:2px 6px;" onclick="event.stopPropagation();deleteTaskComment(${JSON.stringify(task.id)}, ${JSON.stringify(cid)})">✕</button>
              </div>` : ''}
            </li>`
          }).join('')}
        </ul>
      `
    }
  }

  let panel = document.getElementById('taskDetailPanel')
  panel.classList.add('active')
  panel.classList.remove('hidden')
}

function closeTaskDetail() {
  currentTaskDetailId = null
  let panel = document.getElementById('taskDetailPanel')
  panel.classList.remove('active')
  // keep panel in DOM but slide it out
}

function saveTaskDetail() {
  if (!currentTaskDetailId) return
  let task = tasks.find(t => t.id === currentTaskDetailId)
  if (!task) return

  let oldAssignee = task.assignee || ''
  let oldStatus = task.status || ''

  let title = document.getElementById('taskDetailTitleInput').value.trim()
  if (!title) return showToast('Task title is required', 'error')

  task.title       = title
  task.description = document.getElementById('taskDetailDescInput').value.trim()
  task.status      = document.getElementById('taskDetailStatus').value
  task.priority    = document.getElementById('taskDetailPriority').value
  task.assignee    = document.getElementById('taskDetailAssignee').value
  task.dueDate     = document.getElementById('taskDetailDue').value || null
  const recFreq = document.getElementById('taskDetailRecurrence')?.value || ''
  const recOnDone = !!document.getElementById('taskDetailRepeatOnDone')?.checked
  task.recurrence = recFreq ? { freq: recFreq, createNextOnDone: recOnDone } : null
  task.goalId = document.getElementById('taskDetailGoal')?.value || null
  task.goalKrId = document.getElementById('taskDetailGoalKR')?.value || null
  task.updated     = new Date().toISOString()

  // Optional new update/comment
  let updateText = document.getElementById('taskDetailUpdateInput').value.trim()
  if (updateText) {
    if (!Array.isArray(task.updates)) task.updates = []
    task.updates.unshift({
      id: genId(),
      text: updateText,
      createdAt: new Date().toISOString(),
      authorId: currentUser.id,
      authorName: currentUser.fullName || currentUser.username
    })
    fireMentionNotifications(`task "${task.title}"`, updateText, { type: 'task', id: task.id })
  }

  save('tasks', tasks)
  renderTasks()
  renderDashboardCharts()
  updateStats()
  addAuditLog('update', `Updated task "${task.title}" from side panel`, 'update', { projectId: task.projectId || null, taskId: task.id })
  if (oldStatus !== task.status) runTaskStatusAutomations(task, oldStatus, task.status, 'detail')

  // Email notification: task assigned to someone (respect notification prefs and backend availability)
  try {
    if (ALTER_API_BASE && getAuthToken() && oldAssignee !== task.assignee) {
      // Check notification preferences (default to on if not configured)
      const wantsEmail =
        (userSettings && userSettings.notifEmailEnabled !== false) &&
        (userSettings && userSettings.notifTaskEnabled !== false)

      if (wantsEmail) {
        const member = team.find(m => m.id === task.assignee)
        const to = member && member.email
        if (to) {
          const proj = task.projectId ? projects.find(p => p.id === task.projectId) : null
          const projectName = proj ? proj.name : ''
          const dueDate = task.dueDate || ''

          fetch(ALTER_API_BASE + '/api/integrations/email/task-assigned', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + getAuthToken()
            },
            body: JSON.stringify({ to, taskTitle: task.title, projectName, dueDate })
          }).catch(() => {})
        }
      }
    }
  } catch (e) {}

  showToast('Task updated', 'success')
  closeTaskDetail()
}

function convertTaskToCalendarEvent(taskId) {
  const task = tasks.find(t => t.id === taskId)
  if (!task) return

  let start = task.dueDate || (selectedCalendarDate ? (selectedCalendarDate + 'T09:00') : toLocalDateTimeInputValue(new Date()))
  if (typeof start === 'string' && !start.includes('T')) start = start + 'T09:00'
  const startDate = new Date(start)
  if (isNaN(startDate.getTime())) return showToast('Task date is invalid for calendar conversion', 'error')
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000)
  const eventTitle = `Task: ${task.title}`
  const eventDesc = (task.description || '').trim()
  const eventColor = task.priority === 'high' ? 'event-red' : task.priority === 'low' ? 'event-green' : 'event-orange'
  const conflicts = findEventConflicts(toLocalDateTimeInputValue(startDate), toLocalDateTimeInputValue(endDate))

  events.push({
    id: genId(),
    title: eventTitle,
    description: eventDesc,
    start: toLocalDateTimeInputValue(startDate),
    end: toLocalDateTimeInputValue(endDate),
    color: eventColor,
    linkedTaskId: task.id,
    author: currentUser.id,
    created: new Date().toISOString()
  })
  save('events', events)
  renderCalendar()
  addActivity(`Added task to calendar: ${task.title}`)
  addAuditLog('create', `Converted task "${task.title}" to calendar event`, 'create', { projectId: task.projectId || null, taskId: task.id })
  if (conflicts.length) showToast(`Added to calendar with ${conflicts.length} conflict(s)`, 'warning')
  else showToast('Task added to calendar', 'success')
}

function deleteTaskComment(taskId, commentId) {
  const task = tasks.find(t => t.id === taskId)
  if (!task || !Array.isArray(task.updates)) return
  if (!commentId) return
  const u = task.updates.find(x => (x.id || x.createdAt || x.created) === commentId)
  if (!u || !canEditComment(u.authorId)) return showToast('You cannot delete this comment', 'error')
  task.updates = task.updates.filter(x => (x.id || x.createdAt || x.created) !== commentId)
  save('tasks', tasks)
  if (currentTaskDetailId === taskId) openTaskDetail(taskId)
  addAuditLog('update', `Deleted comment on task \"${task.title}\"`, 'update', { projectId: task.projectId || null, taskId: task.id })
  showToast('Comment deleted', 'success')
}

function editTaskComment(taskId, commentId) {
  const task = tasks.find(t => t.id === taskId)
  if (!task || !Array.isArray(task.updates)) return
  const u = task.updates.find(x => (x.id || x.createdAt || x.created) === commentId)
  if (!u || !canEditComment(u.authorId)) return showToast('You cannot edit this comment', 'error')
  const nt = window.prompt('Edit comment', u.text || '')
  if (nt == null) return
  const t = String(nt).trim()
  if (!t) return
  u.text = t
  u.editedAt = new Date().toISOString()
  save('tasks', tasks)
  openTaskDetail(taskId)
  showToast('Comment updated', 'success')
}

/* ===================================================
   DRAG & DROP
=================================================== */
function dragStart(e) {
  let card = e.target.closest('.task-card')
  if (!card) return
  draggedTaskId = card.dataset.taskId
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', draggedTaskId)
  setTimeout(() => card.classList.add('dragging'), 0)
}

function dragEnd(e) {
  let card = e.target.closest('.task-card')
  if (card) card.classList.remove('dragging')
  draggedTaskId = null
  document.querySelectorAll('.tasks-list').forEach(l => l.classList.remove('drag-over'))
}

function allowDrop(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  e.currentTarget.classList.add('drag-over')
}

function dragLeave(e) { e.currentTarget.classList.remove('drag-over') }

function drop(e) {
  e.preventDefault()
  e.currentTarget.classList.remove('drag-over')
  let id = e.dataTransfer.getData('text/plain') || draggedTaskId
  if (!id) return
  let task = tasks.find(t => t.id === id)
  if (!task) return
  let statusMap = { todoTasks:'todo', progressTasks:'in-progress', reviewTasks:'review', doneTasks:'done' }
  let newStatus = statusMap[e.currentTarget.id]
  if (!newStatus || task.status === newStatus) return
  let oldStatus = task.status
  task.status = newStatus
  task.updated = new Date().toISOString()
  save('tasks', tasks)
  renderTasks()
  updateStats()
  renderDashboardCharts()
  addActivity(`Moved "${task.title}" → ${newStatus.replace('-',' ')}`)
  addAuditLog('update', `Moved task "${task.title}" from ${oldStatus} to ${newStatus}`, 'update', { projectId: task.projectId || null, taskId: task.id })
  showToast(`Moved to ${newStatus.replace('-',' ')}`, 'info')
  runTaskStatusAutomations(task, oldStatus, newStatus, 'drag')
}

// Basic touch support for moving tasks on mobile
let touchDragging = false

function handleTaskTouchStart(e) {
  let card = e.target.closest('.task-card')
  if (!card) return
  if (!e.touches || !e.touches[0]) return
  draggedTaskId = card.dataset.taskId
  touchDragging = true
  card.classList.add('dragging')
}

function handleTaskTouchEnd(e) {
  if (!touchDragging) return
  touchDragging = false
  let card = document.querySelector('.task-card.dragging')
  if (card) card.classList.remove('dragging')
  let touch = e.changedTouches && e.changedTouches[0]
  if (!touch) { draggedTaskId = null; return }
  let target = document.elementFromPoint(touch.clientX, touch.clientY)
  if (!target) { draggedTaskId = null; return }
  let list = target.closest('.tasks-list')
  if (!list) { draggedTaskId = null; return }

  let id = draggedTaskId
  if (!id) return
  let task = tasks.find(t => t.id === id)
  if (!task) return
  let statusMap = { todoTasks:'todo', progressTasks:'in-progress', reviewTasks:'review', doneTasks:'done' }
  let newStatus = statusMap[list.id]
  if (!newStatus || task.status === newStatus) { draggedTaskId = null; return }

  let oldStatus = task.status
  task.status = newStatus
  task.updated = new Date().toISOString()
  save('tasks', tasks)
  renderTasks()
  updateStats()
  renderDashboardCharts()
  addActivity(`Moved "${task.title}" → ${newStatus.replace('-',' ')}`)
  addAuditLog('update', `Moved task "${task.title}" from ${oldStatus} to ${newStatus}`, 'update', { projectId: task.projectId || null, taskId: task.id })
  showToast(`Moved to ${newStatus.replace('-',' ')}`, 'info')
  runTaskStatusAutomations(task, oldStatus, newStatus, 'touch')
  draggedTaskId = null
}

/* ===================================================
   TIME TRACKING
=================================================== */
function populateTimerProjectSelect() {
  populateProjectSelect('timerProject')
  populateProjectSelect('manualTimeProject')
}

function updateTimerControlsUI() {
  const startBtn = document.getElementById('timerBtn')
  const pauseBtn = document.getElementById('timerPauseBtn')
  const stopBtn = document.getElementById('timerStopBtn')
  if (!startBtn || !pauseBtn || !stopBtn) return

  if (!timerSessionActive) {
    startBtn.classList.remove('hidden')
    startBtn.textContent = '▶ Start'
    startBtn.className = 'btn-success'
    pauseBtn.classList.add('hidden')
    stopBtn.classList.add('hidden')
  } else if (timerRunning) {
    startBtn.classList.add('hidden')
    pauseBtn.classList.remove('hidden')
    stopBtn.classList.remove('hidden')
  } else {
    startBtn.classList.remove('hidden')
    startBtn.textContent = '▶ Resume'
    startBtn.className = 'btn-success'
    pauseBtn.classList.add('hidden')
    stopBtn.classList.remove('hidden')
  }
}

function timerStartOrResume() {
  if (!timerSessionActive) startTimer()
  else if (!timerRunning) resumeTimer()
}

function startTimer() {
  let desc = document.getElementById('timerDesc').value.trim()
  if (!desc) return showToast('Please describe what you are working on', 'warning')
  timerSessionActive = true
  timerRunning = true
  timerSeconds = 0
  timerStartTime = Date.now()
  timerInterval = setInterval(updateTimerDisplay, 1000)
  const disp = document.getElementById('timerDisplay')
  disp.classList.remove('paused')
  disp.classList.add('running')
  updateTimerControlsUI()
}

function resumeTimer() {
  if (!timerSessionActive || timerRunning) return
  timerRunning = true
  timerStartTime = Date.now() - timerSeconds * 1000
  timerInterval = setInterval(updateTimerDisplay, 1000)
  const disp = document.getElementById('timerDisplay')
  disp.classList.remove('paused')
  disp.classList.add('running')
  updateTimerControlsUI()
}

function pauseTimer() {
  if (!timerRunning) return
  clearInterval(timerInterval)
  timerRunning = false
  timerSeconds = Math.floor((Date.now() - timerStartTime) / 1000)
  document.getElementById('timerDisplay').textContent = formatDuration(timerSeconds)
  document.getElementById('timerDisplay').classList.remove('running')
  document.getElementById('timerDisplay').classList.add('paused')
  updateTimerControlsUI()
}

function stopTimer() {
  if (!timerSessionActive) return

  if (timerRunning) {
    clearInterval(timerInterval)
    timerRunning = false
    timerSeconds = Math.floor((Date.now() - timerStartTime) / 1000)
  }

  const elapsed = timerSeconds
  timerSessionActive = false
  timerSeconds = 0
  timerStartTime = null

  const disp = document.getElementById('timerDisplay')
  disp.textContent = '00:00:00'
  disp.classList.remove('running', 'paused')
  updateTimerControlsUI()

  if (elapsed < 10) return

  let desc = document.getElementById('timerDesc').value.trim()
  let projId = document.getElementById('timerProject').value

  saveTimeEntry(desc, projId, '', elapsed, new Date().toISOString().split('T')[0])
  document.getElementById('timerDesc').value = ''
}

function updateTimerDisplay() {
  timerSeconds = Math.floor((Date.now() - timerStartTime) / 1000)
  document.getElementById('timerDisplay').textContent = formatDuration(timerSeconds)
}

/** Clear timer without saving (e.g. workspace reset). */
function forceResetTimerSession() {
  if (timerInterval) clearInterval(timerInterval)
  timerInterval = null
  timerRunning = false
  timerSessionActive = false
  timerStartTime = null
  timerSeconds = 0
  const disp = document.getElementById('timerDisplay')
  if (disp) {
    disp.textContent = '00:00:00'
    disp.classList.remove('running', 'paused')
  }
  updateTimerControlsUI()
}

function saveTimeEntry(desc, projId, taskId, durationSecs, date) {
  let entry = {
    id: genId(), description: desc, projectId: projId, taskId,
    duration: durationSecs, date,
    userId: currentUser.id,
    userName: currentUser.fullName || currentUser.username,
    created: new Date().toISOString()
  }
  timeEntries.unshift(entry)
  if (timeEntries.length > 500) timeEntries.pop()
  save('time', timeEntries)
  renderTimeTracking()
  updateStats()
  addAuditLog('create', `Logged ${formatHours(durationSecs)} on "${desc}"`, 'create', { projectId: projId || null, taskId: taskId || null })
  showToast(`Logged ${formatHours(durationSecs)}`, 'success')
}

function openManualTimeModal() {
  populateProjectSelect('manualTimeProject')
  document.getElementById('manualTimeDate').value = new Date().toISOString().split('T')[0]
  document.getElementById('manualTimeModal').classList.add('active')
}

function saveManualTime() {
  let desc    = document.getElementById('manualTimeDesc').value.trim()
  let projId  = document.getElementById('manualTimeProject').value
  let hours   = parseFloat(document.getElementById('manualTimeDuration').value)
  let date    = document.getElementById('manualTimeDate').value

  if (!desc)           return showToast('Please add a description', 'error')
  if (!hours || hours <= 0) return showToast('Please enter a valid duration', 'error')

  saveTimeEntry(desc, projId, '', Math.round(hours * 3600), date || new Date().toISOString().split('T')[0])
  document.getElementById('manualTimeModal').classList.remove('active')
  ;['manualTimeDesc','manualTimeDuration'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
}

function renderTimeTracking() {
  const myOnly = document.getElementById('timeMyOnly')?.checked

  const entries = timeEntries.filter(e => !myOnly || e.userId === currentUser.id)

  let totalSecs = entries.reduce((s, e) => s + (e.duration || 0), 0)
  let today = new Date().toISOString().split('T')[0]
  let todaySecs = entries.filter(e => e.date === today).reduce((s, e) => s + (e.duration||0), 0)
  let weekSecs  = entries.filter(e => {
    let d = new Date(e.date)
    return d >= new Date(Date.now() - 7*86400000)
  }).reduce((s, e) => s + (e.duration||0), 0)
  let monthSecs = entries.filter(e => {
    let d = new Date(e.date)
    let now = new Date()
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  }).reduce((s, e) => s + (e.duration||0), 0)

  document.getElementById('timeSummary').innerHTML = `
    <div class="time-summary-card"><div class="ts-value">${formatHours(todaySecs)}</div><div class="ts-label">Today</div></div>
    <div class="time-summary-card"><div class="ts-value">${formatHours(weekSecs)}</div><div class="ts-label">This Week</div></div>
    <div class="time-summary-card"><div class="ts-value">${formatHours(monthSecs)}</div><div class="ts-label">This Month</div></div>
    <div class="time-summary-card"><div class="ts-value">${formatHours(totalSecs)}</div><div class="ts-label">All Time</div></div>
  `

  let list = document.getElementById('timeEntriesList')
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⏱</div><h3>No time entries yet</h3><p>Start the timer above or log time manually to see entries here</p></div>`
    return
  }

  list.innerHTML = entries.slice(0, 30).map(e => {
    let proj = e.projectId ? projects.find(p => p.id === e.projectId) : null
    const who = e.userName || (e.userId === currentUser.id ? (currentUser.fullName || currentUser.username || 'Me') : '')
    const dateLabel = e.date || (e.created ? e.created.split('T')[0] : '')
    return `
      <div class="time-entry">
        <div style="font-size:20px;">⏱</div>
        <div class="time-entry-desc">
          <div>${escapeHtml(e.description)}</div>
          ${proj ? `<div class="time-entry-project">📁 ${escapeHtml(proj.name)}</div>` : ''}
          ${who ? `<div class="time-entry-user">By ${escapeHtml(who)}</div>` : ''}
        </div>
        <div class="time-entry-date">${escapeHtml(dateLabel)}</div>
        <div class="time-entry-duration">${formatHours(e.duration)}</div>
        <button class="btn-sm btn-danger btn-icon" onclick="deleteTimeEntry('${e.id}')" style="padding:5px;width:28px;height:28px;">✕</button>
      </div>
    `
  }).join('')
}

function deleteTimeEntry(id) {
  let entry = timeEntries.find(e => e.id === id)
  timeEntries = timeEntries.filter(e => e.id !== id)
  save('time', timeEntries)
  renderTimeTracking()
  updateStats()
  addAuditLog('delete', `Deleted time entry "${entry?.description || id}"`, 'delete', { projectId: entry?.projectId || null, taskId: entry?.taskId || null })
  showToast('Entry deleted', 'success')
}

/* ===================================================
   IDEAS
=================================================== */
function openCreateIdeaModal() { document.getElementById('createIdeaModal').classList.add('active') }

function closeCreateIdeaModal() {
  document.getElementById('createIdeaModal').classList.remove('active')
  ;['modalIdeaTitle','modalIdeaDesc'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  document.getElementById('modalIdeaCategory').value = 'feature'
  document.getElementById('modalIdeaImpact').value   = '3'
}

function saveIdea() {
  let title    = document.getElementById('modalIdeaTitle').value.trim()
  let desc     = document.getElementById('modalIdeaDesc').value.trim()
  let category = document.getElementById('modalIdeaCategory').value
  let impact   = parseInt(document.getElementById('modalIdeaImpact').value) || 3

  if (!title) return showToast('Please enter an idea title', 'error')

  ideas.push({
    id: genId(), title, description: desc, category, impact, votes: 0,
    voters: [], author: currentUser.id, status: 'new',
    created: new Date().toISOString()
  })
  save('ideas', ideas)
  closeCreateIdeaModal()
  renderIdeas()
  addActivity(`Submitted idea: ${title}`)
  addNotification(`New idea: "${title}"`, 'idea')
  addAuditLog('create', `Submitted idea "${title}"`, 'create')
  showToast('Idea submitted!', 'success')
  updateStats()
}

/* ===================================================
   OVERVIEW
=================================================== */
function overviewEmptyHtml(opts) {
  const icon = opts.icon || '📋'
  const title = escapeHtml(opts.title || '')
  const desc = escapeHtml(opts.desc || '')
  const btn = opts.action && opts.label
    ? `<button type="button" onclick="${opts.action}" style="margin-top:6px;">${escapeHtml(opts.label)}</button>`
    : ''
  return `<div class="empty-state compact">
    <div class="empty-state-icon">${icon}</div>
    <h3>${title}</h3>
    <p>${desc}</p>
    ${btn}
  </div>`
}

function renderOverview() {
  const hint = document.getElementById('overviewDateHint')
  if (hint) {
    const end = new Date(Date.now() + 7 * 86400000)
    hint.textContent = `Rolling window: next 7 days through ${end.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}.`
  }
  renderOverviewSummary()
  renderOverviewProjects()
  renderOverviewGoals()
  renderOverviewTimeline()
}

function renderOverviewSummary() {
  const el = document.getElementById('overviewSummary')
  if (!el) return

  const activeProjects   = projects.filter(p => p.status === 'active').length
  const completedProjects= projects.filter(p => p.status === 'completed').length

  const onTrackGoals = goals.filter(g => g.status === 'on_track').length
  const atRiskGoals  = goals.filter(g => g.status === 'at_risk').length
  const offTrackGoals= goals.filter(g => g.status === 'off_track').length

  const now = new Date()
  const in7d = new Date(now.getTime() + 7*86400000)
  const upcoming7 = getAllCalendarEvents()
    .filter(e => {
      const d = new Date(e.start)
      return d >= now && d <= in7d
    }).length

  const myTasksThisWeek = currentUser ? tasks.filter(t => {
    if (t.assignee !== currentUser.id || !t.dueDate) return false
    const d = new Date(t.dueDate.includes('T') ? t.dueDate : t.dueDate + 'T09:00')
    return d >= now && d <= in7d
  }).length : 0

  el.innerHTML = `
    <div class="stat-card">
      <h3>Projects</h3>
      <div class="value">${activeProjects}</div>
      <div class="trend"><span class="trend-up">↑</span> ${completedProjects} completed • ${projects.length} total</div>
    </div>
    <div class="stat-card">
      <h3>Goals</h3>
      <div class="value">${onTrackGoals}</div>
      <div class="trend">${atRiskGoals} at risk • ${offTrackGoals} off track • ${goals.length} total</div>
    </div>
    <div class="stat-card">
      <h3>Next 7 days</h3>
      <div class="value">${upcoming7}</div>
      <div class="trend">Deadlines & calendar in the upcoming week</div>
    </div>
    <div class="stat-card">
      <h3>Your week</h3>
      <div class="value">${myTasksThisWeek}</div>
      <div class="trend">Tasks assigned to you with due dates this week</div>
    </div>
  `
}

function renderOverviewProjects() {
  const el = document.getElementById('overviewProjects')
  if (!el) return
  if (!projects.length) {
    el.innerHTML = overviewEmptyHtml({
      icon: '📁',
      title: 'No projects yet',
      desc: 'Projects group tasks, time, and deadlines so stakeholders see progress in one place — start with your first initiative.',
      action: 'openCreateProjectModal()',
      label: '+ Create project'
    })
    return
  }
  const filter = document.getElementById('overviewProjectFilter')?.value || ''
  const filtered = projects.slice().filter(p => {
    if (filter === 'active' && p.status !== 'active') return false
    if (filter === 'client') {
      const tags = (p.tags || []).map(t => (t || '').toLowerCase())
      const hasClient = tags.some(t => t === 'client' || t.startsWith('client:'))
      if (!hasClient) return false
    }
    return true
  })
  if (!filtered.length) {
    el.innerHTML = overviewEmptyHtml({
      icon: '🔍',
      title: 'No projects match this filter',
      desc: 'Try “All projects”, filter to active work only, or tag a project with client or client:name for client-specific rollups.',
      action: "var f=document.getElementById('overviewProjectFilter');if(f){f.value='';renderOverview();}",
      label: 'Reset to all projects'
    })
    return
  }
  const cards = filtered.slice().sort((a,b) => (a.status === 'active' ? -1 : 1)).map(p => {
    const taskCount = tasks.filter(t => t.projectId === p.id).length
    const doneCount = tasks.filter(t => t.projectId === p.id && t.status === 'done').length
    const progress  = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0
    const owner     = p.owner && team.find(m => m.id === p.owner)?.email || (currentUser && currentUser.id === p.owner ? (currentUser.fullName || currentUser.username) : '')
    let daysLeft  = null
    if (p.deadline) {
      const d = new Date(p.deadline)
      if (!isNaN(d.getTime())) {
        daysLeft = Math.ceil((d - new Date()) / 86400000)
      }
    }
    let deadlineHtml = ''
    if (daysLeft !== null) {
      deadlineHtml = daysLeft < 0
        ? `<span style="color:#ef4444;">Overdue by ${Math.abs(daysLeft)}d</span>`
        : daysLeft === 0 ? `<span style="color:#f59e0b;">Due today</span>`
        : `<span>${daysLeft}d left</span>`
    }
    // Simple health signal
    let healthLabel = 'On track'
    let healthColor = '#22c55e'
    if (daysLeft !== null) {
      if (daysLeft < 0 && progress < 80) { healthLabel = 'Off track'; healthColor = '#ef4444' }
      else if (daysLeft <= 2 && progress < 50) { healthLabel = 'At risk'; healthColor = '#f97316' }
    }
    return `
      <div style="padding:10px 0;border-bottom:1px solid #1F2937;cursor:pointer;" onclick="switchPage('projects', null)">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
          <div style="min-width:0;">
            <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.name)}</div>
            <div style="font-size:11px;color:#6B7280;margin-top:2px;">
              ${owner ? `Owner: ${escapeHtml(owner)} • ` : ''}${escapeHtml(p.status)}
            </div>
          </div>
          <div style="font-size:11px;color:#9CA3AF;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:3px;">
            <span style="padding:2px 8px;border-radius:999px;background:${healthColor};color:white;font-weight:600;">${healthLabel}</span>
            ${deadlineHtml || ''}
          </div>
        </div>
        <div style="font-size:11px;color:#6B7280;margin-top:4px;">${doneCount}/${taskCount} tasks • ${progress}%</div>
        <div class="progress-bar" style="margin-top:4px;"><div class="progress-fill" style="width:${progress}%;"></div></div>
      </div>
    `
  }).join('')
  el.innerHTML = cards
}

function renderOverviewGoals() {
  const el = document.getElementById('overviewGoals')
  if (!el) return
  if (!goals.length) {
    el.innerHTML = overviewEmptyHtml({
      icon: '🎯',
      title: 'No goals or OKRs yet',
      desc: 'Define outcomes with owners and dates so this view shows whether the org is on track — not just busy.',
      action: "switchPage('goals', null)",
      label: 'Open Goals'
    })
    return
  }
  const cards = goals.slice().sort((a,b) => (a.status === 'completed' ? 1 : -1)).map(g => {
    const owner = g.ownerId === currentUser.id
      ? (currentUser.fullName || currentUser.username || 'Me')
      : (team.find(m => m.id === g.ownerId)?.email || 'Unassigned')
    const project = g.projectId ? projects.find(p => p.id === g.projectId) : null
    const dueLabel = g.dueDate
      ? new Date(g.dueDate.includes('T') ? g.dueDate : g.dueDate + 'T09:00').toLocaleDateString(undefined,{ month:'short', day:'numeric', year:'numeric' })
      : 'No target date'
    const status = g.status || 'on_track'
    let healthColor = '#22c55e'
    if (status === 'at_risk') healthColor = '#f97316'
    else if (status === 'off_track') healthColor = '#ef4444'
    return `
      <div style="padding:10px 0;border-bottom:1px solid #1F2937;cursor:pointer;" onclick="switchPage('goals', null)">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
          <div style="min-width:0;">
            <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(g.title)}</div>
            <div style="font-size:11px;color:#6B7280;margin-top:2px;">Owner: ${escapeHtml(owner)}</div>
            ${project ? `<div style="font-size:11px;color:#6B7280;">Project: ${escapeHtml(project.name)}</div>` : ''}
          </div>
          <div style="text-align:right;font-size:11px;color:#9CA3AF;">
            <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${healthColor};color:white;font-weight:600;margin-bottom:3px;">
              ${escapeHtml(status)}
            </span>
            <div>${escapeHtml(dueLabel)}</div>
          </div>
        </div>
        ${g.description ? `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(g.description)}</div>` : ''}
      </div>
    `
  }).join('')
  el.innerHTML = cards
}

function renderOverviewTimeline() {
  const el = document.getElementById('overviewTimeline')
  if (!el) return
  const eventsAll = getAllCalendarEvents()
  const upcoming = eventsAll
    .filter(e => new Date(e.start) >= new Date())
    .sort((a,b) => new Date(a.start) - new Date(b.start))
    .slice(0, 10)
  if (!upcoming.length) {
    el.innerHTML = overviewEmptyHtml({
      icon: '📅',
      title: 'No upcoming milestones',
      desc: 'Project deadlines, goal targets, and calendar events surface here — add work with dates or sync your calendar to populate this lane.',
      action: "switchPage('calendar', null)",
      label: 'Open Calendar'
    })
    return
  }
  el.innerHTML = upcoming.map(e => {
    const d = new Date(e.start)
    const dateLabel = d.toLocaleDateString(undefined,{ month:'short', day:'numeric' })
    let kind = 'Event'
    if (e.source === 'project_deadline') kind = 'Project'
    else if (e.source === 'goal_deadline') kind = 'Goal'
    else if (e.source === 'google') kind = 'Google'
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1F2937;">
        <div style="background:#111827;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;color:#E5E7EB;min-width:54px;text-align:center;">
          ${dateLabel}
        </div>
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.title || '')}</div>
          <div style="font-size:11px;color:#6B7280;">${kind}</div>
        </div>
      </div>
    `
  }).join('')
}

function ideaVoteCount(idea) {
  if (!idea) return 0
  if (typeof idea.votes === 'number' && !isNaN(idea.votes)) return idea.votes
  if (Array.isArray(idea.voters)) return idea.voters.length
  return 0
}

function buildIdeaCard(idea) {
  let impactStars = '⭐'.repeat(idea.impact || 1)
  let hasVoted    = (idea.voters || []).includes(currentUser.id)
  let votes       = ideaVoteCount(idea)
  return `
    <div class="idea-card">
      <div class="idea-content">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <h3>${escapeHtml(idea.title)}</h3>
          <span class="idea-status-badge ${escapeHtml(idea.status)}">${escapeHtml(idea.status)}</span>
        </div>
        <p>${escapeHtml(idea.description)}</p>
      </div>
      <div class="idea-meta">
        <span>${impactStars} Impact ${idea.impact}/5</span>
        <span style="font-size:11px;padding:2px 8px;background:#1F2937;border-radius:12px;border:1px solid #374151;">${escapeHtml(idea.category)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span class="idea-votes" style="font-size:18px;font-weight:700;">${votes} 👍</span>
        <span style="font-size:11px;color:#4B5563;">${timeAgo(idea.created)}</span>
      </div>
      <div class="idea-actions">
        <button class="btn-sm ${hasVoted ? 'btn-secondary' : ''}" onclick="voteIdea('${idea.id}')">${hasVoted ? '✓ Voted' : '👍 Vote'}</button>
        <button class="btn-sm btn-success" onclick="convertIdeaToTask('${idea.id}')">→ Task</button>
        <button class="btn-sm btn-secondary" onclick="cycleIdeaStatus('${idea.id}')">Status</button>
        <button class="btn-sm btn-danger" onclick="deleteIdea('${idea.id}')">✕</button>
      </div>
    </div>
  `
}

function renderIdeas() {
  let sorted = [...ideas].sort((a, b) => ideaVoteCount(b) - ideaVoteCount(a))
  let html = sorted.map(buildIdeaCard).join('')
  document.getElementById('ideasList').innerHTML = html ||
    `<div class="empty-state"><div class="empty-state-icon">💡</div><h3>No ideas yet</h3><p>Be the first to submit an idea!</p><button class="btn-primary btn-sm" onclick="openCreateIdeaModal()">+ New Idea</button></div>`
}

function clearIdeaFilters() {
  let searchEl = document.getElementById('ideaSearch')
  let catEl = document.getElementById('ideaCategoryFilter')
  if (searchEl) searchEl.value = ''
  if (catEl) catEl.value = ''
  renderIdeas()
}

function filterIdeas() {
  let search   = document.getElementById('ideaSearch').value.toLowerCase()
  let category = document.getElementById('ideaCategoryFilter').value
  let filtered = ideas.filter(i => {
    let ms = i.title.toLowerCase().includes(search) || (i.description||'').toLowerCase().includes(search)
    let mc = !category || i.category === category
    return ms && mc
  })
  let sorted = [...filtered].sort((a, b) => ideaVoteCount(b) - ideaVoteCount(a))
  let html = sorted.map(buildIdeaCard).join('')
  if (html) {
    document.getElementById('ideasList').innerHTML = html
    return
  }
  if (ideas.length === 0) {
    document.getElementById('ideasList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">💡</div><h3>No ideas yet</h3><p>Be the first to submit an idea!</p><button class="btn-primary btn-sm" onclick="openCreateIdeaModal()">+ New Idea</button></div>`
  } else {
    document.getElementById('ideasList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No matching ideas</h3><p>Try different filters or add a new idea</p><button class="btn-secondary btn-sm" onclick="clearIdeaFilters()">Clear filters</button></div>`
  }
}

function voteIdea(id) {
  let idea = ideas.find(i => i.id === id)
  if (!idea) return
  if (!idea.voters) idea.voters = []
  if (idea.voters.includes(currentUser.id)) {
    idea.voters = idea.voters.filter(v => v !== currentUser.id)
    showToast('Vote removed', 'info')
  } else {
    idea.voters.push(currentUser.id)
    showToast('Voted!', 'success')
  }
  idea.votes = idea.voters.length
  save('ideas', ideas)
  renderIdeas()
}

function cycleIdeaStatus(id) {
  let idea     = ideas.find(i => i.id === id)
  if (!idea) return
  let statuses = ['new','reviewing','accepted','rejected']
  let idx      = statuses.indexOf(idea.status)
  idea.status  = statuses[(idx + 1) % statuses.length]
  save('ideas', ideas)
  renderIdeas()
  showToast(`Status → ${idea.status}`, 'info')
}

function convertIdeaToTask(id) {
  let idea = ideas.find(i => i.id === id)
  if (!idea) return
  const newTaskId = genId()
  tasks.push({
    id: newTaskId, title: idea.title, description: idea.description,
    projectId: '', priority: 'medium', status: 'todo',
    assignee: currentUser.id, created: new Date().toISOString()
  })
  ideas = ideas.filter(i => i.id !== id)
  save('tasks', tasks)
  save('ideas', ideas)
  renderTasks()
  renderIdeas()
  addActivity(`Converted idea → task: ${idea.title}`)
  addAuditLog('create', `Converted idea "${idea.title}" to task`, 'create', { taskId: newTaskId })
  showToast('Idea converted to task!', 'success')
  updateStats()
}

function deleteIdea(id) {
  let idea = ideas.find(i => i.id === id)
  if (!idea) return
  openConfirmModal({
    type: 'delete_idea',
    id,
    title: 'Delete idea',
    message: `This will delete idea "${idea.title}".`,
    level: 'danger'
  })
}

function reallyDeleteIdea(id) {
  let idea = ideas.find(i => i.id === id)
  if (!idea) return
  ideas = ideas.filter(i => i.id !== id)
  save('ideas', ideas)
  renderIdeas()
  addAuditLog('delete', `Deleted idea "${idea.title}"`, 'delete')
  showToast('Idea deleted', 'success')
  updateStats()
}
  /* ===================================================
   CALENDAR HELPERS
=================================================== */
function setCalendarToday() {
  const now = new Date()
  currentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  selectedCalendarDate = toLocalDateOnlyValue(currentDate)
  // Ensure calendar page is visible when jumping to today
  if (document.getElementById('calendar')?.classList.contains('hidden')) {
    switchPage('calendar', null)
  } else {
    renderCalendar()
  }
}

// Combine internal events with (optional) Google Calendar + derived deadlines
function getAllCalendarEvents() {
  const showGoogle = document.getElementById('calendarShowGoogle')?.checked
  let all = expandRecurringEvents(events.slice())

  function toDateTimeLocal(dateOrDateTime, fallbackTime) {
    if (!dateOrDateTime) return ''
    if (typeof dateOrDateTime !== 'string') return ''
    return dateOrDateTime.includes('T') ? dateOrDateTime : (dateOrDateTime + fallbackTime)
  }

  function plusHours(dateTimeLocal, hours) {
    try {
      const d = new Date(dateTimeLocal)
      if (isNaN(d.getTime())) return dateTimeLocal
      return toLocalDateTimeInputValue(new Date(d.getTime() + hours * 60 * 60 * 1000))
    } catch (e) {
      return dateTimeLocal
    }
  }

  // Add synthetic events for project deadlines
  projects.forEach(p => {
    if (!p.deadline) return
    const start = toDateTimeLocal(p.deadline, 'T09:00')
    all.push({
      id: `project-deadline-${p.id}`,
      title: `Project due: ${p.name}`,
      description: p.description || '',
      start: start,
      end:   plusHours(start, 1),
      color: 'event-orange',
      source: 'project_deadline'
    })
  })

  // Add synthetic events for goal due dates
  goals.forEach(g => {
    if (!g.dueDate) return
    const start = toDateTimeLocal(g.dueDate, 'T09:00')
    all.push({
      id: `goal-deadline-${g.id}`,
      title: `Goal due: ${g.title}`,
      description: g.description || '',
      start: start,
      end:   plusHours(start, 1),
      color: 'event-green',
      source: 'goal_deadline'
    })
  })

  if (googleCalendarConnected && showGoogle && Array.isArray(googleCalendarEvents)) {
    all = all.concat(googleCalendarEvents)
  }
  return all
}

function expandRecurringEvents(inputEvents) {
  const expanded = []
  const now = new Date()
  const horizonStart = new Date(now.getTime() - 30 * 86400000)
  const horizonEnd = new Date(now.getTime() + 365 * 86400000)

  inputEvents.forEach(ev => {
    const recurrence = ev && ev.recurrence
    if (!recurrence || !recurrence.freq) {
      expanded.push(ev)
      return
    }

    const baseStart = new Date(ev.start)
    const baseEnd = new Date(ev.end)
    if (isNaN(baseStart.getTime()) || isNaN(baseEnd.getTime())) {
      expanded.push(ev)
      return
    }
    const durationMs = Math.max(15 * 60000, baseEnd.getTime() - baseStart.getTime())
    const interval = Math.max(1, Number(recurrence.interval || 1))
    const until = recurrence.until ? new Date(recurrence.until + 'T23:59:59') : horizonEnd
    const capEnd = until < horizonEnd ? until : horizonEnd

    let cursor = new Date(baseStart)
    let guard = 0
    const exclusions = Array.isArray(recurrence.exdates) ? recurrence.exdates : []
    while (cursor <= capEnd && guard < 500) {
      const occStart = new Date(cursor)
      const occEnd = new Date(occStart.getTime() + durationMs)
      const occDay = toLocalDateOnlyValue(occStart)
      const isExcluded = exclusions.includes(occDay)
      if (occEnd >= horizonStart && !isExcluded) {
        expanded.push({
          ...ev,
          id: `${ev.id}__${occDay}`,
          masterEventId: ev.id,
          start: toLocalDateTimeInputValue(occStart),
          end: toLocalDateTimeInputValue(occEnd),
          source: 'local'
        })
      }
      guard++
      if (recurrence.freq === 'daily') {
        cursor.setDate(cursor.getDate() + interval)
      } else if (recurrence.freq === 'weekly') {
        cursor.setDate(cursor.getDate() + (7 * interval))
      } else if (recurrence.freq === 'monthly') {
        cursor.setMonth(cursor.getMonth() + interval)
      } else {
        break
      }
    }
  })

  return expanded
}

function findEventConflicts(startIso, endIso, ignoreEventId) {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return []
  const localEvents = expandRecurringEvents(events.slice())

  return localEvents.filter(ev => {
    const refId = ev.masterEventId || ev.id
    if (ignoreEventId && refId === ignoreEventId) return false
    const s = new Date(ev.start)
    const e = new Date(ev.end)
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return false
    return start < e && end > s
  })
}

function renderCalendarSmartAlerts() {
  const alertsEl = document.getElementById('calendarSmartAlerts')
  if (!alertsEl) return
  const allLocal = expandRecurringEvents(events.slice()).sort((a, b) => new Date(a.start) - new Date(b.start))
  const collisions = []
  calendarConflictSuggestions = []
  for (let i = 0; i < allLocal.length; i++) {
    for (let j = i + 1; j < allLocal.length; j++) {
      const aStart = new Date(allLocal[i].start)
      const aEnd = new Date(allLocal[i].end)
      const bStart = new Date(allLocal[j].start)
      if (bStart >= aEnd) break
      const bEnd = new Date(allLocal[j].end)
      if (aStart < bEnd && aEnd > bStart) {
        const day = toLocalDateOnlyValue(aStart)
        const item = {
          day,
          a: allLocal[i].title,
          b: allLocal[j].title,
          aId: allLocal[i].masterEventId || allLocal[i].id,
          bId: allLocal[j].masterEventId || allLocal[j].id
        }
        collisions.push(item)
        calendarConflictSuggestions.push(item)
      }
      if (collisions.length >= 3) break
    }
    if (collisions.length >= 3) break
  }

  if (!collisions.length) {
    alertsEl.innerHTML = '<div class="calendar-alert ok">No time conflicts detected in upcoming events.</div>'
    return
  }

  alertsEl.innerHTML = collisions.map(c => (
    `<div class="calendar-alert">Conflict on ${escapeHtml(c.day)}: <strong>${escapeHtml(c.a)}</strong> overlaps with <strong>${escapeHtml(c.b)}</strong>.
      <div class="calendar-alert-actions">
        <button class="btn-secondary btn-sm" onclick="viewCalendarConflictDay('${escapeHtml(c.day)}')">View</button>
        <button class="btn-secondary btn-sm" onclick="autoShiftCalendarConflict('${escapeHtml(c.aId)}', '${escapeHtml(c.bId)}')">Auto-shift 30m</button>
      </div>
    </div>`
  )).join('')
}

function viewCalendarConflictDay(dayIso) {
  if (!dayIso) return
  const d = new Date(dayIso + 'T00:00:00')
  if (isNaN(d.getTime())) return
  currentDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  selectedCalendarDate = dayIso
  renderCalendar()
  showToast('Opened conflict day in calendar', 'info')
}

function autoShiftCalendarConflict(firstEventId, secondEventId) {
  const targetId = secondEventId || firstEventId
  const idx = events.findIndex(e => e.id === targetId)
  if (idx < 0) {
    showToast('Auto-shift works for directly editable local events.', 'info')
    return
  }
  const before = events.slice()
  const ev = events[idx]
  const s = new Date(ev.start)
  const e = new Date(ev.end)
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return
  const shiftedStart = new Date(s.getTime() + 30 * 60000)
  const shiftedEnd = new Date(e.getTime() + 30 * 60000)
  events[idx] = {
    ...ev,
    start: toLocalDateTimeInputValue(shiftedStart),
    end: toLocalDateTimeInputValue(shiftedEnd),
    updated: new Date().toISOString()
  }
  save('events', events)
  renderCalendar()
  setCalendarUndoAction('shift', function () {
    events = before
    save('events', events)
    renderCalendar()
    showToast('Undo complete', 'success')
  })
  showToast('Shifted event by 30 minutes', 'success')
}

function quickAddCalendarEvent() {
  const input = document.getElementById('calendarQuickAddInput')
  const raw = (input && input.value || '').trim()
  if (!raw) return showToast('Type a quick event like "Team sync tomorrow 10am for 45m"', 'info')

  const parsed = parseNaturalQuickEvent(raw)
  if (!parsed) return showToast('Could not parse quick add. Try "Standup tomorrow 9am for 15m"', 'error')

  const conflicts = findEventConflicts(parsed.start, parsed.end)
  events.push({
    id: genId(),
    title: parsed.title,
    description: parsed.description || '',
    start: parsed.start,
    end: parsed.end,
    color: '',
    author: currentUser.id,
    created: new Date().toISOString()
  })
  save('events', events)
  if (input) input.value = ''
  renderCalendar()
  addActivity(`Quick added event: ${parsed.title}`)
  addAuditLog('create', `Quick added event "${parsed.title}"`, 'create')
  if (conflicts.length) {
    showToast(`Event added with ${conflicts.length} conflict(s).`, 'warning')
  } else {
    showToast('Event added from quick add', 'success')
  }
}

function parseNaturalQuickEvent(text) {
  let title = text
  const now = new Date()
  let date = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let hour = 9
  let minute = 0
  let durationMin = 60

  const lower = text.toLowerCase()
  if (lower.includes('tomorrow')) {
    date.setDate(date.getDate() + 1)
    title = title.replace(/tomorrow/ig, '')
  } else if (lower.includes('today')) {
    title = title.replace(/today/ig, '')
  }

  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (isoDate) {
    const parsedDate = new Date(isoDate[1] + 'T00:00:00')
    if (!isNaN(parsedDate.getTime())) date = parsedDate
    title = title.replace(isoDate[0], '')
  }

  const time12 = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  const time24 = text.match(/\b(\d{1,2}):(\d{2})\b/)
  if (time12) {
    hour = Number(time12[1])
    minute = Number(time12[2] || '0')
    const ap = time12[3].toLowerCase()
    if (ap === 'pm' && hour < 12) hour += 12
    if (ap === 'am' && hour === 12) hour = 0
    title = title.replace(time12[0], '')
  } else if (time24) {
    hour = Number(time24[1])
    minute = Number(time24[2] || '0')
    title = title.replace(time24[0], '')
  }

  const dur = text.match(/\bfor\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i) || text.match(/\b(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i)
  if (dur) {
    let qty = Number(dur[1] || '60')
    const unit = String(dur[2] || 'm').toLowerCase()
    durationMin = unit.startsWith('h') ? qty * 60 : qty
    title = title.replace(dur[0], '')
  }

  title = title.replace(/\bat\b/ig, '').replace(/\bfor\b/ig, '').replace(/\s+/g, ' ').trim()
  if (!title) return null

  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute)
  const end = new Date(start.getTime() + durationMin * 60000)
  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    start: toLocalDateTimeInputValue(start),
    end: toLocalDateTimeInputValue(end),
    description: ''
  }
}

function setCalendarView(view) {
  calendarView = view
  const monthBtn = document.getElementById('calendarViewMonthBtn')
  const weekBtn  = document.getElementById('calendarViewWeekBtn')
  if (monthBtn && weekBtn) {
    monthBtn.classList.toggle('btn-outline', view !== 'month')
    weekBtn.classList.toggle('btn-outline', view !== 'week')
  }
  renderCalendar()
}

function eventMatchesFilter(e, filter, year, month) {
  const start = new Date(e.start)
  const now   = new Date()
  if (filter === 'future') {
    return start >= now
  }
  if (filter === 'month') {
    return start.getMonth() === month && start.getFullYear() === year
  }
  return true
}

function renderCalendarDayDetail(dateStr) {
  const detailDateEl = document.getElementById('calendarDayDetailDate')
  const listEl       = document.getElementById('calendarDayDetailList')
  if (!detailDateEl || !listEl) return

  if (!dateStr) {
    const todayIso = toLocalDateOnlyValue(new Date())
    detailDateEl.textContent = 'Today agenda'
    const todayEvents = getAllCalendarEvents()
      .filter(e => String(e.start || '').slice(0, 10) === todayIso)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 8)
    if (!todayEvents.length) {
      listEl.innerHTML = '<div class="empty-state compact"><div class="empty-state-icon">🗓</div><h3>No events today</h3><p>Use Quick Add to schedule faster.</p></div>'
    } else {
      listEl.innerHTML = todayEvents.map(ev => {
        const t = new Date(ev.start)
        return `<div class="calendar-day-event"><div class="calendar-day-event-time">${t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div><div class="calendar-day-event-body"><div class="calendar-day-event-title">${escapeHtml(ev.title)}</div>${ev.description ? `<div class="calendar-day-event-desc">${escapeHtml(ev.description)}</div>` : ''}</div></div>`
      }).join('')
    }
    return
  }

  const d = new Date(dateStr + 'T00:00:00')
  detailDateEl.textContent = d.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })

  const allEvents = getAllCalendarEvents()

  const dayEvents = allEvents.filter(e => {
    const ev = new Date(e.start)
    return ev.getFullYear() === d.getFullYear() &&
           ev.getMonth() === d.getMonth() &&
           ev.getDate() === d.getDate()
  }).sort((a, b) => new Date(a.start) - new Date(b.start))

  if (!dayEvents.length) {
    listEl.innerHTML = `<div class="empty-state compact"><div class="empty-state-icon">📅</div><h3>No events this day</h3><p>Add an event for ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p><button class="btn-sm btn-primary" onclick="openCreateEventModal(); if(selectedCalendarDate){ document.getElementById('modalEventStart').value=selectedCalendarDate+'T09:00'; document.getElementById('modalEventEnd').value=selectedCalendarDate+'T10:00'; }">+ Add event</button></div>`
    return
  }

  listEl.innerHTML = dayEvents.map(ev => {
    const t = new Date(ev.start)
    const isReadOnly = !!ev.source && ev.source !== 'local'
    const deleteId = ev.masterEventId || ev.id
    const editId = ev.masterEventId || ev.id
    const commentId = ev.masterEventId || ev.id
    const occurrenceId = ev.id
    const commentCount = (events.find(x => x.id === commentId)?.comments || []).length
    return `
      <div class="calendar-day-event">
        <div class="calendar-day-event-time">${t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
        <div class="calendar-day-event-body">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="calendar-day-event-title">${escapeHtml(ev.title)}</div>
            ${!isReadOnly ? `<button class="btn-xs btn-secondary" style="margin-left:auto;padding:2px 6px;font-size:10px;" onclick="addEventCommentPrompt('${commentId}')">💬 ${commentCount}</button><button class="btn-xs btn-secondary" style="padding:2px 6px;font-size:10px;" onclick="openEditEventModal('${editId}', '${occurrenceId}')">Edit</button><button class="btn-xs btn-danger" style="padding:2px 6px;font-size:10px;" onclick="deleteEvent('${deleteId}', '${occurrenceId}')">✕</button>` : ''}
          </div>
          ${ev.description ? `<div class="calendar-day-event-desc">${escapeHtml(ev.description)}</div>` : ''}
          ${renderEventCommentPreview(commentId)}
          ${renderEventCommentsInline(commentId)}
        </div>
      </div>
    `
  }).join('')
}


/* ===================================================
   CALENDAR
=================================================== */
function openCreateEventModal()  {
  const modal = document.getElementById('createEventModal')
  const titleEl = document.getElementById('eventModalTitle')
  const primaryBtn = document.getElementById('eventModalPrimaryBtn')
  const idEl = document.getElementById('modalEventId')
  if (titleEl) titleEl.textContent = '📅 Create New Event'
  if (primaryBtn) primaryBtn.textContent = 'Create Event'
  if (idEl) idEl.value = ''
  if (modal) modal.classList.add('active')
}

function openEditEventModal(eventId, occurrenceId) {
  const ev = events.find(e => e.id === eventId)
  if (!ev) return showToast('Event not found', 'error')
  if (ev.recurrence && ev.recurrence.freq && occurrenceId && occurrenceId !== eventId) {
    const editSeries = window.confirm('Edit entire recurring series?\nPress OK for entire series, Cancel for this occurrence only.')
    if (!editSeries) {
      const occ = expandRecurringEvents([ev]).find(e => e.id === occurrenceId)
      if (occ) {
        const copy = { ...ev }
        delete copy.recurrence
        copy.id = genId()
        copy.start = occ.start
        copy.end = occ.end
        copy.created = new Date().toISOString()
        events.push(copy)
        save('events', events)
        return openEditEventModal(copy.id, copy.id)
      }
    }
  }
  const modal = document.getElementById('createEventModal')
  const titleEl = document.getElementById('eventModalTitle')
  const primaryBtn = document.getElementById('eventModalPrimaryBtn')
  const idEl = document.getElementById('modalEventId')
  if (idEl) idEl.value = ev.id
  if (titleEl) titleEl.textContent = '✏️ Edit Event'
  if (primaryBtn) primaryBtn.textContent = 'Save changes'
  const titleInput = document.getElementById('modalEventTitle')
  const startInput = document.getElementById('modalEventStart')
  const endInput = document.getElementById('modalEventEnd')
  const colorInput = document.getElementById('modalEventColor')
  const descInput = document.getElementById('modalEventDesc')
  const repeatInput = document.getElementById('modalEventRepeat')
  const repeatUntilInput = document.getElementById('modalEventRepeatUntil')
  if (titleInput) titleInput.value = ev.title || ''
  if (startInput) startInput.value = typeof ev.start === 'string' ? ev.start.slice(0, 16) : ''
  if (endInput) endInput.value = typeof ev.end === 'string' ? ev.end.slice(0, 16) : ''
  if (colorInput) colorInput.value = ev.color || ''
  if (descInput) descInput.value = ev.description || ''
  if (repeatInput) repeatInput.value = (ev.recurrence && ev.recurrence.freq) ? ev.recurrence.freq : 'none'
  if (repeatUntilInput) repeatUntilInput.value = (ev.recurrence && ev.recurrence.until) ? ev.recurrence.until : ''
  if (modal) modal.classList.add('active')
}

function closeCreateEventModal() {
  document.getElementById('createEventModal').classList.remove('active')
  ;['modalEventTitle','modalEventDesc'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  ;['modalEventStart','modalEventEnd'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  let eventIdEl = document.getElementById('modalEventId')
  if (eventIdEl) eventIdEl.value = ''
  let repeatEl = document.getElementById('modalEventRepeat')
  if (repeatEl) repeatEl.value = 'none'
  let untilEl = document.getElementById('modalEventRepeatUntil')
  if (untilEl) untilEl.value = ''
  let titleEl = document.getElementById('eventModalTitle')
  if (titleEl) titleEl.textContent = '📅 Create New Event'
  let primaryBtn = document.getElementById('eventModalPrimaryBtn')
  if (primaryBtn) primaryBtn.textContent = 'Create Event'
}

function saveEvent() {
  const before = events.slice()
  let eventId = document.getElementById('modalEventId')?.value || ''
  let title = document.getElementById('modalEventTitle').value.trim()
  let start = document.getElementById('modalEventStart').value
  let end   = document.getElementById('modalEventEnd').value
  let color = document.getElementById('modalEventColor').value
  let desc  = document.getElementById('modalEventDesc').value.trim()
  let repeat = document.getElementById('modalEventRepeat')?.value || 'none'
  let repeatUntil = document.getElementById('modalEventRepeatUntil')?.value || ''

  if (!title) return showToast('Please enter an event title', 'error')

  // Sensible defaults when times not provided
  if (!start) {
    if (selectedCalendarDate) start = selectedCalendarDate + 'T09:00'
    else start = toLocalDateTimeInputValue(new Date())
  }

  if (!end) {
    let startDate = new Date(start)
    end = toLocalDateTimeInputValue(new Date(startDate.getTime() + 60 * 60 * 1000))
  }

  if (new Date(end) <= new Date(start)) {
    return showToast('End time must be after start time', 'error')
  }

  const conflicts = findEventConflicts(start, end, eventId || undefined)
  const recurrence = repeat !== 'none'
    ? {
        freq: repeat,
        interval: 1,
        until: repeatUntil || new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10)
      }
    : null

  if (eventId) {
    const idx = events.findIndex(e => e.id === eventId)
    if (idx < 0) return showToast('Event not found', 'error')
    events[idx] = {
      ...events[idx],
      title,
      description: desc,
      start,
      end,
      color,
      recurrence,
      updated: new Date().toISOString()
    }
  } else {
    events.push({
      id: genId(), title, description: desc,
      start, end, color,
      recurrence,
      comments: [],
      author: currentUser.id, created: new Date().toISOString()
    })
  }
  save('events', events)
  closeCreateEventModal()
  renderCalendar()
  setCalendarUndoAction(eventId ? 'edit' : 'create', function () {
    events = before
    save('events', events)
    renderCalendar()
    showToast('Undo complete', 'success')
  })
  if (eventId) {
    addActivity(`Updated event: ${title}`)
    addAuditLog('update', `Updated event "${title}"`, 'update')
  } else {
    addActivity(`Created event: ${title}`)
    addAuditLog('create', `Created event "${title}"`, 'create')
  }
  if (conflicts.length) {
    showToast(`${eventId ? 'Event updated' : 'Event created'} with ${conflicts.length} conflict(s)`, 'warning')
  } else {
    showToast(eventId ? 'Event updated!' : 'Event created!', 'success')
  }
  updateStats()
}

function renderEventCommentPreview(eventId) {
  const ev = events.find(e => e.id === eventId)
  if (!ev || !Array.isArray(ev.comments) || !ev.comments.length) return ''
  const latest = ev.comments.slice().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
  if (!latest) return ''
  return `<div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Latest comment: ${escapeHtml(latest.authorName || 'Member')} - ${escapeHtml(String(latest.text || '').slice(0, 80))}</div>`
}

function addEventCommentPrompt(eventId) {
  const ev = events.find(e => e.id === eventId)
  if (!ev) return showToast('Event not found', 'error')
  const text = window.prompt('Add a comment (use @username to mention):')
  if (!text || !text.trim()) return
  if (!Array.isArray(ev.comments)) ev.comments = []
  ev.comments.unshift({
    id: genId(),
    text: text.trim(),
    authorId: currentUser?.id || '',
    authorName: currentUser?.fullName || currentUser?.username || 'Member',
    createdAt: new Date().toISOString()
  })
  save('events', events)
  renderCalendar()
  addActivity(`Commented on event: ${ev.title}`)
  fireMentionNotifications(`event "${ev.title}"`, text.trim(), { type: 'event', id: ev.id, start: ev.start })
  showToast('Event comment added', 'success')
}

function editEventCommentById(eventId, commentId) {
  const ev = events.find(e => e.id === eventId)
  if (!ev || !Array.isArray(ev.comments)) return
  const c = ev.comments.find(x => x.id === commentId)
  if (!c || !canEditComment(c.authorId)) return showToast('You cannot edit this comment', 'error')
  const nt = window.prompt('Edit comment', c.text || '')
  if (nt == null) return
  const t = String(nt).trim()
  if (!t) return
  c.text = t
  c.editedAt = new Date().toISOString()
  save('events', events)
  renderCalendar()
  showToast('Comment updated', 'success')
}

function deleteEventCommentById(eventId, commentId) {
  const ev = events.find(e => e.id === eventId)
  if (!ev || !Array.isArray(ev.comments)) return
  const c = ev.comments.find(x => x.id === commentId)
  if (!c || !canEditComment(c.authorId)) return showToast('You cannot delete this comment', 'error')
  ev.comments = ev.comments.filter(x => x.id !== commentId)
  save('events', events)
  renderCalendar()
  showToast('Comment deleted', 'success')
}

function renderEventCommentsInline(eventId) {
  const ev = events.find(e => e.id === eventId)
  if (!ev || !Array.isArray(ev.comments) || !ev.comments.length) return ''
  return ev.comments.slice(0, 4).map(function (c) {
    const can = canEditComment(c.authorId)
    return `<div style="font-size:11px;color:#9CA3AF;margin-top:4px;">${escapeHtml(c.authorName || 'Member')}: ${escapeHtml(c.text || '')}` +
      (can ? ` <button type="button" class="btn-xs btn-secondary" style="padding:1px 6px;font-size:10px;" onclick="event.stopPropagation();editEventCommentById(${JSON.stringify(eventId)}, ${JSON.stringify(c.id)})">Edit</button><button type="button" class="btn-xs btn-danger" style="padding:1px 6px;font-size:10px;" onclick="event.stopPropagation();deleteEventCommentById(${JSON.stringify(eventId)}, ${JSON.stringify(c.id)})">✕</button>` : '') +
      `</div>`
  }).join('')
}

function renderCalendar() {
  // Fallback in case currentDate was not initialized correctly
  if (!currentDate || typeof currentDate.getFullYear !== 'function') {
    currentDate = new Date()
  }
  if (!selectedCalendarDate) {
    selectedCalendarDate = toLocalDateOnlyValue(new Date())
  }

  let year     = currentDate.getFullYear()
  let month    = currentDate.getMonth()
  let first    = new Date(year, month, 1)
  let total    = new Date(year, month + 1, 0).getDate()
  let startDow = first.getDay()
  let today    = new Date()
  let html     = ''

  const filter    = document.getElementById('calendarFilterRange')?.value || 'all'
  const allEvents = getAllCalendarEvents()

  if (calendarView === 'week') {
    // Determine current week (Sunday–Saturday) based on selected date or today
    const base = selectedCalendarDate ? new Date(selectedCalendarDate + 'T00:00:00') : today
    const weekStart = new Date(base)
    weekStart.setDate(base.getDate() - weekStart.getDay())
    const weekDays = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart)
      d.setDate(weekStart.getDate() + i)
      weekDays.push(d)
    }

    weekDays.forEach(d => {
      const day   = d.getDate()
      const m     = d.getMonth()
      const y     = d.getFullYear()
      const cellIso = toLocalDateOnlyValue(d)

      let dayEvents = allEvents.filter(e => {
        const ev = new Date(e.start)
        return ev.getDate() === day && ev.getMonth() === m && ev.getFullYear() === y &&
               eventMatchesFilter(e, filter, y, m)
      })

      const isToday    = today.getDate() === day && today.getMonth() === m && today.getFullYear() === y
      const isSelected = selectedCalendarDate === cellIso

      html += `
        <div class="calendar-day ${isToday ? 'today' : ''} ${isSelected ? 'selected-day' : ''}" onclick="calendarDayClick(${y}, ${m}, ${day})" ondragover="calendarWeekCellDragOver(event)" ondragleave="calendarWeekCellDragLeave(event)" ondrop="calendarWeekCellDrop(event, '${cellIso}')">
          <div class="day-number">${d.toLocaleDateString(undefined,{ weekday:'short', day:'numeric' })}</div>
          <div class="day-events">
            ${dayEvents.slice(0, 4).map(e => {
              const moveId = e.masterEventId || e.id
              const canDrag = !(e.source && e.source !== 'local')
              return `<div class="day-event ${escapeHtml(e.color||'')} ${canDrag ? 'draggable-event' : ''}" ${canDrag ? `draggable="true" ondragstart="startCalendarEventDrag(event, '${escapeHtml(moveId)}', '${escapeHtml(e.id)}')"` : ''}>${escapeHtml(e.title)}</div>`
            }).join('')}
            ${dayEvents.length > 4 ? `<div style="font-size:9px;color:#4B5563;">+${dayEvents.length - 4} more</div>` : ''}
          </div>
        </div>
      `
    })

    document.getElementById('calendarGrid').innerHTML  = html
    const titleRange = `${weekDays[0].toLocaleDateString('en-US',{ month:'short', day:'numeric' })} – ${weekDays[6].toLocaleDateString('en-US',{ month:'short', day:'numeric', year:'numeric' })}`
    document.getElementById('calendarTitle').textContent = `Week of ${titleRange}`
  } else {
    for (let i = 0; i < startDow; i++) html += '<div class="calendar-day empty"></div>'

    for (let day = 1; day <= total; day++) {
      const cellDate = new Date(year, month, day)
      const cellIso  = toLocalDateOnlyValue(cellDate)

      let dayEvents = allEvents.filter(e => {
        const d = new Date(e.start)
        return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year &&
               eventMatchesFilter(e, filter, year, month)
      })

      let isToday    = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year
      let isSelected = selectedCalendarDate === cellIso

      html += `
        <div class="calendar-day ${isToday ? 'today' : ''} ${isSelected ? 'selected-day' : ''}" onclick="calendarDayClick(${year}, ${month}, ${day})">
          <div class="day-number">${day}</div>
          <div class="day-events">
            ${dayEvents.slice(0, 2).map(e => `<div class="day-event ${escapeHtml(e.color||'')} ">${escapeHtml(e.title)}</div>`).join('')}
            ${dayEvents.length > 2 ? `<div style="font-size:9px;color:#4B5563;">+${dayEvents.length - 2} more</div>` : ''}
          </div>
        </div>
      `
    }

    document.getElementById('calendarGrid').innerHTML  = html
    document.getElementById('calendarTitle').textContent = currentDate.toLocaleDateString('en-US', { month:'long', year:'numeric' })
  }

  renderCalendarDayDetail(selectedCalendarDate)
  renderCalendarSmartAlerts()

  let upcoming = allEvents
    .filter(e => new Date(e.start) >= new Date())
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 5)

  let upcomingEl = document.getElementById('upcomingEvents')
  if (upcomingEl) {
    if (upcoming.length) {
      upcomingEl.innerHTML = upcoming.map(e => {
        const d = new Date(e.start)
        const dateLabel = d.toLocaleDateString('en-US',{month:'short',day:'numeric'})
        const timeLabel = d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
        const readOnly = !!e.source && e.source !== 'local'
        const deleteId = e.masterEventId || e.id
        const editId = e.masterEventId || e.id
        const commentId = e.masterEventId || e.id
        const commentCount = (events.find(x => x.id === commentId)?.comments || []).length
        const occurrenceId = e.id
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #1F2937;">
            <div style="background:#4f46e5;color:white;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:700;min-width:50px;text-align:center;">
              ${dateLabel}
            </div>
            <div>
              <div style="font-size:14px;font-weight:500;">${escapeHtml(e.title)}</div>
              <div style="font-size:12px;color:#6B7280;">${timeLabel}</div>
              ${renderEventCommentPreview(commentId)}
            </div>
            ${!readOnly ? `<button class="btn-sm btn-secondary" style="margin-left:auto;" onclick="addEventCommentPrompt('${commentId}')">💬 ${commentCount}</button><button class="btn-sm btn-secondary" onclick="openEditEventModal('${editId}', '${occurrenceId}')">Edit</button><button class="btn-sm btn-danger" onclick="deleteEvent('${deleteId}', '${occurrenceId}')">✕</button>` : ''}
          </div>
        `
      }).join('')
    } else {
      upcomingEl.innerHTML = `<div class="empty-state compact"><div class="empty-state-icon">📅</div><h3>No upcoming events</h3><p>Schedule an event from the calendar</p><button class="btn-sm btn-primary" onclick="switchPage('calendar',null); openCreateEventModal();">+ New Event</button></div>`
    }
  }
}

function calendarDayClick(y, m, d) {
  let dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  selectedCalendarDate = dateStr
  // Re-render to update highlight and side panel, but do NOT auto-open modal
  renderCalendar()
}

function deleteEvent(id, occurrenceId) {
  let ev = events.find(e => e.id === id)
  if (!ev) return
  const before = events.slice()

  if (ev.recurrence && ev.recurrence.freq && occurrenceId && occurrenceId !== id) {
    const deleteSeries = window.confirm('Delete entire recurring series?\nPress OK for entire series, Cancel for only this occurrence.')
    if (!deleteSeries) {
      const occ = expandRecurringEvents([ev]).find(e => e.id === occurrenceId)
      if (!occ) return
      const occDate = toLocalDateOnlyValue(occ.start)
      if (!ev.recurrence.exdates || !Array.isArray(ev.recurrence.exdates)) ev.recurrence.exdates = []
      if (!ev.recurrence.exdates.includes(occDate)) ev.recurrence.exdates.push(occDate)
      save('events', events)
      renderCalendar()
      setCalendarUndoAction('delete', function () {
        events = before
        save('events', events)
        renderCalendar()
        showToast('Undo complete', 'success')
      })
      addAuditLog('delete', `Deleted recurring occurrence "${ev.title}" on ${occDate}`, 'delete')
      showToast('Occurrence deleted', 'success')
      updateStats()
      return
    }
  }

  events = events.filter(e => e.id !== id && e.masterEventId !== id)
  save('events', events)
  renderCalendar()
  setCalendarUndoAction('delete', function () {
    events = before
    save('events', events)
    renderCalendar()
    showToast('Undo complete', 'success')
  })
  addAuditLog('delete', `Deleted event "${ev?.title || id}"`, 'delete')
  showToast('Event deleted', 'success')
  updateStats()
}

function startCalendarEventDrag(ev, eventId, occurrenceId) {
  draggedCalendarEventId = eventId
  draggedCalendarOccurrenceId = occurrenceId || eventId
  try {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', eventId)
  } catch (e) {}
}

function calendarWeekCellDragOver(ev) {
  ev.preventDefault()
  if (ev.currentTarget && ev.currentTarget.classList) ev.currentTarget.classList.add('drop-target')
}

function calendarWeekCellDragLeave(ev) {
  if (ev.currentTarget && ev.currentTarget.classList) ev.currentTarget.classList.remove('drop-target')
}

function calendarWeekCellDrop(ev, targetDateIso) {
  ev.preventDefault()
  if (ev.currentTarget && ev.currentTarget.classList) ev.currentTarget.classList.remove('drop-target')
  const eventId = draggedCalendarEventId || (ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '')
  const occurrenceId = draggedCalendarOccurrenceId || eventId
  draggedCalendarEventId = null
  draggedCalendarOccurrenceId = null
  if (!eventId) return
  moveCalendarEventToDate(eventId, occurrenceId, targetDateIso)
}

function moveCalendarEventToDate(eventId, occurrenceId, targetDateIso) {
  const before = events.slice()
  let idx = events.findIndex(e => e.id === eventId)
  if (idx < 0) return
  let current = events[idx]

  if (current.recurrence && current.recurrence.freq) {
    const moveSeries = window.confirm('Move entire recurring series?\nPress OK for entire series, Cancel for this occurrence only.')
    if (!moveSeries) {
      const occ = expandRecurringEvents([current]).find(e => e.id === occurrenceId)
      if (occ) {
        const copy = { ...current }
        delete copy.recurrence
        copy.id = genId()
        copy.masterEventId = undefined
        copy.start = occ.start
        copy.end = occ.end
        copy.created = new Date().toISOString()
        events.push(copy)
        idx = events.length - 1
        current = events[idx]
      }
    }
  }

  const oldStart = new Date(current.start)
  const oldEnd = new Date(current.end)
  if (isNaN(oldStart.getTime()) || isNaN(oldEnd.getTime())) return
  const nextStart = new Date(targetDateIso + 'T00:00:00')
  nextStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0)
  const duration = oldEnd.getTime() - oldStart.getTime()
  const nextEnd = new Date(nextStart.getTime() + duration)
  const nextStartIso = toLocalDateTimeInputValue(nextStart)
  const nextEndIso = toLocalDateTimeInputValue(nextEnd)
  const conflicts = findEventConflicts(nextStartIso, nextEndIso, current.id)

  events[idx] = {
    ...current,
    start: nextStartIso,
    end: nextEndIso,
    updated: new Date().toISOString()
  }
  save('events', events)
  renderCalendar()
  setCalendarUndoAction('move', function () {
    events = before
    save('events', events)
    renderCalendar()
    showToast('Undo complete', 'success')
  })
  if (conflicts.length) showToast(`Moved with ${conflicts.length} conflict(s)`, 'warning')
  else showToast('Event rescheduled', 'success')
}

/** After OAuth redirect: strip query params and show result */
function handleGoogleCalendarOAuthReturn() {
  try {
    var u = new URL(window.location.href)
    var g = u.searchParams.get('google_calendar')
    if (!g) return
    var reason = u.searchParams.get('reason')
    u.searchParams.delete('google_calendar')
    u.searchParams.delete('reason')
    var rest = u.searchParams.toString()
    window.history.replaceState({}, '', u.pathname + (rest ? '?' + rest : '') + u.hash)
    if (g === 'connected') {
      // Optimistically reflect connected state immediately after OAuth redirect.
      googleCalendarConnected = true
      googleCalendarConfigured = true
      updateGoogleCalendarUi()
      setTimeout(function () { syncGoogleCalendarConnectionState() }, 250)
      showToast('Google Calendar connected', 'success')
    } else if (g === 'error') {
      var detail = reason === 'no_refresh_token'
        ? 'Try again and ensure Google shows the consent screen (revoke app access in Google Account if needed).'
        : 'Could not complete Google sign-in.'
      showToast(detail, 'error')
    }
  } catch (e) {}
}

async function syncGoogleCalendarConnectionState() {
  if (!ALTER_API_BASE || !getAuthToken()) {
    googleCalendarConnected = false
    googleCalendarConfigured = true
    updateGoogleCalendarUi()
    return
  }
  try {
    var r = await fetch(ALTER_API_BASE + '/api/integrations/google/calendar/status', {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    })
    if (!r.ok) {
      // Keep current UI state if the status endpoint is temporarily unavailable.
      updateGoogleCalendarUi()
      return
    }
    var d = await r.json()
    googleCalendarConfigured = d.configured !== false
    googleCalendarConnected = !!d.connected
    updateGoogleCalendarUi()
  } catch (e) {
    updateGoogleCalendarUi()
  }
}

// Start Google Calendar OAuth flow via backend (?token=JWT — required for linking the Google account to this user)
async function connectGoogleCalendar() {
  if (googleCalendarConnected) {
    showToast('Google Calendar is already connected. Manage disconnect in Settings > Integrations.', 'info')
    return
  }
  if (!ensureCurrentUser()) {
    showToast('Sign in to connect Google Calendar', 'error')
    return
  }
  if (!getAuthToken()) {
    showToast('Sign in to connect Google Calendar', 'error')
    return
  }
  var base = (typeof ALTER_API_BASE === 'string' && ALTER_API_BASE) ? ALTER_API_BASE : ''
  if (!base) {
    showToast('API base URL is not configured (alterApiBaseMeta).', 'error')
    return
  }
  try {
    const r = await fetch(base + '/api/integrations/google/calendar/start', {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.authUrl) {
      showToast((d && d.error) || 'Could not start Google Calendar connect flow.', 'error')
      return
    }
    window.location.href = d.authUrl
  } catch (e) {
    showToast('Could not start Google Calendar connect flow.', 'error')
  }
}

function manageGoogleCalendarIntegration() {
  if (googleCalendarConnected) {
    disconnectGoogleCalendar()
    return
  }
  connectGoogleCalendar()
}

async function disconnectGoogleCalendar() {
  if (!ALTER_API_BASE || !getAuthToken()) {
    showToast('Sign in to manage Google Calendar connection', 'error')
    return
  }
  try {
    var r = await fetch(ALTER_API_BASE + '/api/integrations/google/calendar/disconnect', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    })
    if (!r.ok) throw new Error('disconnect failed')
    googleCalendarConnected = false
    googleCalendarEvents = []
    updateGoogleCalendarUi()
    renderCalendar()
    showToast('Google Calendar disconnected', 'success')
  } catch (e) {
    showToast('Could not disconnect Google Calendar right now.', 'error')
  }
}

function updateGoogleCalendarUi() {
  var calendarStatusEl = document.getElementById('calendarGoogleStatus')
  var calendarBtn = document.getElementById('calendarConnectGoogleBtn')
  var settingsStatusEl = document.getElementById('settingsGoogleCalendarStatus')
  var settingsBtn = document.getElementById('settingsGoogleCalendarBtn')

  var statusText = ''
  if (!ALTER_API_BASE || !getAuthToken()) {
    statusText = ''
  } else if (!googleCalendarConfigured) {
    statusText = 'Google Calendar: add GOOGLE_CLIENT_* env on the server to enable sync'
  } else if (!googleCalendarConnected) {
    statusText = 'Not connected — click Connect Google Calendar'
  } else {
    statusText = 'Google Calendar connected'
  }

  if (calendarStatusEl) calendarStatusEl.textContent = statusText
  if (settingsStatusEl) {
    settingsStatusEl.textContent = statusText || 'Sign in to manage this connection'
    settingsStatusEl.style.color = googleCalendarConnected ? '#10B981' : '#6B7280'
  }

  if (calendarBtn) {
    calendarBtn.textContent = googleCalendarConnected ? 'Google Calendar Connected' : 'Connect Google Calendar'
  }
  if (settingsBtn) settingsBtn.textContent = googleCalendarConnected ? 'Disconnect' : 'Connect'
  renderDashboardActivationInsights()
}

// Fetch Google Calendar events for the visible month from backend
async function refreshGoogleCalendarEvents() {
  if (!googleCalendarConnected) return
  if (!ALTER_API_BASE || !getAuthToken()) return

  try {
    const year  = currentDate.getFullYear()
    const month = currentDate.getMonth()
    const start = new Date(year, month, 1).toISOString()
    const end   = new Date(year, month + 1, 0, 23, 59, 59).toISOString()

    const res = await fetch(
      `${ALTER_API_BASE}/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      {
        credentials: 'include',
        headers: { Authorization: 'Bearer ' + getAuthToken() }
      }
    )

    if (!res.ok) throw new Error('Failed to load Google events')

    const data = await res.json()
    googleCalendarEvents = Array.isArray(data) ? data : (data.events || [])
    if (data && data.connected === false) {
      googleCalendarConnected = false
      updateGoogleCalendarUi()
    }

    const statusEl = document.getElementById('calendarGoogleStatus')
    if (statusEl) {
      if (googleCalendarConnected) {
        statusEl.textContent = 'Google Calendar synced (' + googleCalendarEvents.length + ' events this view)'
      }
    }

    renderCalendar()
  } catch (err) {
    console.error(err)
    const statusEl = document.getElementById('calendarGoogleStatus')
    if (statusEl) statusEl.textContent = 'Error syncing Google Calendar'
    showToast('Could not load Google Calendar events right now.', 'error')
  }
}

function prevMonth() {
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1)
  if (googleCalendarConnected && ALTER_API_BASE && getAuthToken()) refreshGoogleCalendarEvents()
  else renderCalendar()
}
function nextMonth() {
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1)
  if (googleCalendarConnected && ALTER_API_BASE && getAuthToken()) refreshGoogleCalendarEvents()
  else renderCalendar()
}

/* ===================================================
   TEAM
=================================================== */
function openInviteTeamModal()  { document.getElementById('inviteTeamModal').classList.add('active') }
function closeInviteTeamModal() {
  document.getElementById('inviteTeamModal').classList.remove('active')
  ;['modalInviteEmail','modalInviteMessage','modalInviteDept'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  document.getElementById('modalInviteRole').value = 'member'
}

function refreshTeamInvitePanels() {
  const canManage = currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner')
  const invitePanel = document.getElementById('teamInviteCodePanel')
  const joinPanel = document.getElementById('teamJoinByCodePanel')
  const codeDisplay = document.getElementById('teamInviteCodeDisplay')
  if (invitePanel) invitePanel.style.display = canManage ? 'block' : 'none'
  if (joinPanel) joinPanel.style.display = (ALTER_API_BASE && getAuthToken()) ? 'block' : 'none'
  if (codeDisplay && canManage) {
    const code = (userSettings && userSettings.workspaceInviteCode) || ''
    codeDisplay.textContent = code || 'Not generated — click Generate new code'
  }
}

function generateWorkspaceInviteCode() {
  if (!ensureCurrentUser()) return
  if (!(currentUser.role === 'admin' || currentUser.role === 'owner')) {
    showToast('Only admins can generate invite codes', 'error')
    return
  }
  if (!userSettings || typeof userSettings !== 'object') userSettings = {}
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]
  userSettings.workspaceInviteCode = code
  save('usersettings', userSettings)
  scheduleSyncWorkspace()
  const el = document.getElementById('teamInviteCodeDisplay')
  if (el) el.textContent = code
  showToast('Invite code saved', 'success')
  addAuditLog('update', 'Generated workspace invite code', 'update')
}

function copyWorkspaceInviteCode() {
  const code = (userSettings && userSettings.workspaceInviteCode) || ''
  if (!code) return showToast('Generate a code first', 'warning')
  const done = () => showToast('Copied to clipboard', 'success')
  const fail = () => showToast('Could not copy — select the code and copy manually', 'error')
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(fail)
  } else {
    window.prompt('Copy this code:', code)
  }
}

function joinTeamWithInviteCode() {
  if (!ensureCurrentUser()) return
  if (!ALTER_API_BASE || !getAuthToken()) {
    showToast('Join by code requires signing in with the server', 'error')
    return
  }
  const raw = (document.getElementById('teamJoinCodeInput') && document.getElementById('teamJoinCodeInput').value.trim()) || ''
  if (!raw) return showToast('Enter an invite code', 'warning')
  fetch(ALTER_API_BASE + '/api/team/join-with-code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getAuthToken()
    },
    body: JSON.stringify({ code: raw })
  })
    .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body } }) })
    .then(function (res) {
      if (!res.ok) return showToast(res.body.error || 'Could not join', 'error')
      const u = res.body.workspaceOwnerUsername
      showToast(u ? `Added to ${u}'s team` : 'Joined workspace team', 'success')
      const inp = document.getElementById('teamJoinCodeInput')
      if (inp) inp.value = ''
      addAuditLog('update', 'Joined workspace via invite code', 'update')
      if (typeof loadWorkspaceFromBackend === 'function' && ALTER_API_BASE && getAuthToken()) {
        loadWorkspaceFromBackend()
          .then(function (data) {
            if (data) applyWorkspaceToState(data)
            if (typeof renderTeam === 'function') renderTeam()
            if (typeof renderProjects === 'function') renderProjects()
            if (typeof filterTasks === 'function') filterTasks()
            else if (typeof renderTasks === 'function') renderTasks()
            if (typeof renderGoals === 'function') renderGoals()
            if (typeof updateStats === 'function') updateStats()
            if (typeof renderDashboardCharts === 'function') renderDashboardCharts()
          })
          .catch(function () {})
      }
    })
    .catch(function () { showToast('Network error', 'error') })
}

function sendInvite() {
  let email = document.getElementById('modalInviteEmail').value.trim().toLowerCase()
  let role  = document.getElementById('modalInviteRole').value
  let dept  = document.getElementById('modalInviteDept').value.trim()
  if (!email) return showToast('Please enter an email address', 'error')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast('Please enter a valid email', 'error')
  if (team.find(m => (m.email || '').toLowerCase() === email)) return showToast('This email is already invited', 'warning')

  // If backend + auth are configured, send a real email invite through the API
  if (ALTER_API_BASE && getAuthToken()) {
    const token = getAuthToken()
    fetch(ALTER_API_BASE + '/api/integrations/email/send-invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        to: email,
        subject: 'You are invited to join ALTER.CO',
        message: `You've been invited to join the ALTER.CO workspace.\n\nRole: ${role}${dept ? `\nDepartment: ${dept}` : ''}\n\nSign in or create an account with this email to get started.`
      })
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body } }) })
      .then(function (res) {
        if (!res.ok) {
          showToast(res.body && res.body.error ? res.body.error : 'Failed to send invite email', 'error')
          return
        }
        // Only add to local team after email send succeeds
        team.push({ id: genId(), email, role, department: dept, status: 'pending', created: new Date().toISOString() })
        save('team', team)
        closeInviteTeamModal()
        renderTeam()
        addNotification(`Invitation sent to ${email}`, 'team')
        addAuditLog('create', `Invited ${email} as ${role}`, 'create')
        showToast('Invitation email sent!', 'success')
        updateStats()
      })
      .catch(function () {
        showToast('Network error while sending invite', 'error')
      })
    return
  }

  team.push({ id: genId(), email, role, department: dept, status: 'pending', created: new Date().toISOString() })
  save('team', team)
  closeInviteTeamModal()
  renderTeam()
  addNotification(`Invitation sent to ${email}`, 'team')
  addAuditLog('create', `Invited ${email} as ${role}`, 'create')
  showToast('Invitation sent!', 'success')
  updateStats()
}

/* ===================================================
   GOALS & OKRs
=================================================== */
function migrateGoalsIfNeeded() {
  if (window._goalsMigratedV2) return
  window._goalsMigratedV2 = true
  let changed = false
  goals.forEach(g => {
    const before = JSON.stringify({ k: g.keyResults, m: g.milestones })
    normalizeGoalInPlace(g)
    if (JSON.stringify({ k: g.keyResults, m: g.milestones }) !== before) changed = true
  })
  if (changed) save('goals', goals)
}

function normalizeGoalInPlace(g) {
  if (!g) return g
  if (!Array.isArray(g.keyResults)) g.keyResults = []
  g.keyResults = g.keyResults.map(kr => {
    if (typeof kr === 'string') {
      return { id: genId(), title: kr, target: '', current: '', progress: 0, done: false }
    }
    return {
      id: kr.id || genId(),
      title: kr.title || '',
      target: kr.target || '',
      current: kr.current || '',
      progress: Math.min(100, Math.max(0, Number(kr.progress) || 0)),
      done: !!kr.done
    }
  })
  if (!Array.isArray(g.milestones)) g.milestones = []
  g.milestones = g.milestones.map((m, i) => {
    if (typeof m === 'string') {
      return { id: genId(), title: m, dueDate: '', done: false, order: i }
    }
    let due = m.dueDate || ''
    if (due && typeof due === 'string' && !due.includes('T') && due.length <= 10) due = due + 'T09:00'
    return {
      id: m.id || genId(),
      title: m.title || '',
      dueDate: due,
      done: !!m.done,
      order: typeof m.order === 'number' ? m.order : i
    }
  })
  g.milestones.sort((a, b) => (a.order || 0) - (b.order || 0))
  return g
}

function computeGoalProgress(g) {
  normalizeGoalInPlace(g)
  const krs = g.keyResults || []
  const ms = g.milestones || []
  const parts = []
  if (krs.length) {
    const avg = krs.reduce((s, kr) => s + (kr.done ? 100 : (Number(kr.progress) || 0)), 0) / krs.length
    parts.push(avg)
  }
  if (ms.length) {
    parts.push(ms.filter(m => m.done).length / ms.length * 100)
  }
  if (!parts.length) return null
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length)
}

function goalKRRowHtml(kr) {
  const id = kr.id || ''
  return `
    <div class="goal-kr-row" data-kr-id="${escapeHtml(id)}">
      <div class="goal-kr-row-top">
        <input type="text" class="goal-kr-title" placeholder="e.g. Reach 500 weekly active users" value="${escapeHtml(kr.title)}">
        <div class="goal-kr-meta">
          <span>Progress %</span>
          <input type="number" class="goal-kr-progress" min="0" max="100" value="${Number(kr.progress) || 0}">
          <label><input type="checkbox" class="goal-kr-done" ${kr.done ? 'checked' : ''}> Done</label>
          <button type="button" class="btn-xs btn-danger" onclick="removeGoalKRRow(this)">Remove</button>
        </div>
      </div>
      <div class="goal-kr-meta" style="gap:10px;">
        <input type="text" class="goal-kr-target" placeholder="Target (e.g. 500 users, $50k)" value="${escapeHtml(kr.target)}" style="flex:1;min-width:120px;padding:6px 8px;background:#020617;border:1px solid #1F2937;border-radius:6px;color:#e2e8f0;font-size:12px;">
        <input type="text" class="goal-kr-current" placeholder="Current (optional)" value="${escapeHtml(kr.current)}" style="flex:1;min-width:120px;padding:6px 8px;background:#020617;border:1px solid #1F2937;border-radius:6px;color:#e2e8f0;font-size:12px;">
      </div>
    </div>`
}

function goalMilestoneRowHtml(m) {
  const id = m.id || ''
  let due = m.dueDate || ''
  if (due && typeof due === 'string' && !due.includes('T') && due.length <= 10) due = due + 'T09:00'
  return `
    <div class="goal-ms-row" data-ms-id="${escapeHtml(id)}">
      <input type="checkbox" class="goal-ms-done" ${m.done ? 'checked' : ''}>
      <input type="text" class="goal-ms-title" placeholder="Step title" value="${escapeHtml(m.title)}">
      <input type="datetime-local" class="goal-ms-due" value="${escapeHtml(due)}">
      <button type="button" class="btn-xs btn-danger" onclick="removeGoalMilestoneRow(this)">Remove</button>
    </div>`
}

function renderGoalKRRows(goal) {
  const el = document.getElementById('modalGoalKRsList')
  if (!el) return
  const rows = goal && Array.isArray(goal.keyResults) && goal.keyResults.length
    ? goal.keyResults.map(kr => goalKRRowHtml(kr))
    : [goalKRRowHtml({ id: genId(), title: '', target: '', current: '', progress: 0, done: false })]
  el.innerHTML = rows.join('')
}

function renderGoalMilestoneRows(goal) {
  const el = document.getElementById('modalGoalMilestonesList')
  if (!el) return
  const rows = goal && Array.isArray(goal.milestones) && goal.milestones.length
    ? goal.milestones.map(m => goalMilestoneRowHtml(m))
    : [goalMilestoneRowHtml({ id: genId(), title: '', dueDate: '', done: false, order: 0 })]
  el.innerHTML = rows.join('')
}

function addGoalKRRow() {
  const el = document.getElementById('modalGoalKRsList')
  if (!el) return
  const wrap = document.createElement('div')
  wrap.innerHTML = goalKRRowHtml({ id: genId(), title: '', target: '', current: '', progress: 0, done: false })
  el.appendChild(wrap.firstElementChild)
}

function addGoalMilestoneRow() {
  const el = document.getElementById('modalGoalMilestonesList')
  if (!el) return
  const wrap = document.createElement('div')
  wrap.innerHTML = goalMilestoneRowHtml({ id: genId(), title: '', dueDate: '', done: false, order: 0 })
  el.appendChild(wrap.firstElementChild)
}

function removeGoalKRRow(btn) {
  const row = btn && btn.closest('.goal-kr-row')
  if (!row || !row.parentNode) return
  const list = document.getElementById('modalGoalKRsList')
  if (list && list.querySelectorAll('.goal-kr-row').length <= 1) {
    row.querySelector('.goal-kr-title').value = ''
    row.querySelector('.goal-kr-progress').value = 0
    row.querySelector('.goal-kr-done').checked = false
    const t = row.querySelector('.goal-kr-target'); if (t) t.value = ''
    const c = row.querySelector('.goal-kr-current'); if (c) c.value = ''
    return
  }
  row.remove()
}

function removeGoalMilestoneRow(btn) {
  const row = btn && btn.closest('.goal-ms-row')
  if (!row || !row.parentNode) return
  const list = document.getElementById('modalGoalMilestonesList')
  if (list && list.querySelectorAll('.goal-ms-row').length <= 1) {
    row.querySelector('.goal-ms-title').value = ''
    row.querySelector('.goal-ms-due').value = ''
    row.querySelector('.goal-ms-done').checked = false
    return
  }
  row.remove()
}

function collectGoalKRsFromModal() {
  const el = document.getElementById('modalGoalKRsList')
  if (!el) return []
  return [...el.querySelectorAll('.goal-kr-row')].map(row => {
    const id = row.getAttribute('data-kr-id') || genId()
    const title = row.querySelector('.goal-kr-title')?.value?.trim() || ''
    if (!title) return null
    return {
      id,
      title,
      target: row.querySelector('.goal-kr-target')?.value?.trim() || '',
      current: row.querySelector('.goal-kr-current')?.value?.trim() || '',
      progress: Math.min(100, Math.max(0, parseInt(row.querySelector('.goal-kr-progress')?.value, 10) || 0)),
      done: !!row.querySelector('.goal-kr-done')?.checked
    }
  }).filter(Boolean)
}

function collectGoalMilestonesFromModal() {
  const el = document.getElementById('modalGoalMilestonesList')
  if (!el) return []
  return [...el.querySelectorAll('.goal-ms-row')].map((row, i) => {
    const id = row.getAttribute('data-ms-id') || genId()
    const title = row.querySelector('.goal-ms-title')?.value?.trim() || ''
    if (!title) return null
    return {
      id,
      title,
      dueDate: row.querySelector('.goal-ms-due')?.value || '',
      done: !!row.querySelector('.goal-ms-done')?.checked,
      order: i
    }
  }).filter(Boolean)
}

function toggleGoalMilestone(goalId, milestoneId) {
  const g = goals.find(x => x.id === goalId)
  if (!g) return
  normalizeGoalInPlace(g)
  const m = g.milestones.find(x => x.id === milestoneId)
  if (!m) return
  m.done = !m.done
  g.updated = new Date().toISOString()
  save('goals', goals)
  renderGoals()
}

function setGoalKRProgress(goalId, krId, raw) {
  const g = goals.find(x => x.id === goalId)
  if (!g) return
  normalizeGoalInPlace(g)
  const kr = g.keyResults.find(k => k.id === krId)
  if (!kr) return
  const v = Math.min(100, Math.max(0, parseInt(raw, 10) || 0))
  kr.progress = v
  kr.done = v >= 100
  g.updated = new Date().toISOString()
  save('goals', goals)
  renderGoals()
}

function toggleGoalKRDone(goalId, krId) {
  const g = goals.find(x => x.id === goalId)
  if (!g) return
  normalizeGoalInPlace(g)
  const kr = g.keyResults.find(k => k.id === krId)
  if (!kr) return
  kr.done = !kr.done
  if (kr.done) kr.progress = 100
  else if (kr.progress >= 100) kr.progress = 0
  g.updated = new Date().toISOString()
  save('goals', goals)
  renderGoals()
}

function openCreateGoalModal() {
  const ownerSelect  = document.getElementById('modalGoalOwner')
  const projectSelect= document.getElementById('modalGoalProject')
  if (ownerSelect) {
    fillAssigneeSelect(ownerSelect, currentUser.id)
  }
  if (projectSelect) {
    projectSelect.innerHTML = '<option value=\"\">None</option>'
    projects.forEach(p => {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.name
      projectSelect.appendChild(opt)
    })
  }
  document.getElementById('modalGoalId').value    = ''
  document.getElementById('modalGoalTitle').value = ''
  document.getElementById('modalGoalDesc').value  = ''
  document.getElementById('modalGoalStatus').value= 'on_track'
  document.getElementById('modalGoalDue').value   = ''
  renderGoalKRRows(null)
  renderGoalMilestoneRows(null)
  document.getElementById('createGoalModal').classList.add('active')
}

function openEditGoalModal(id) {
  const g = goals.find(x => x.id === id)
  if (!g) return
  normalizeGoalInPlace(g)
  const ownerSelect  = document.getElementById('modalGoalOwner')
  const projectSelect= document.getElementById('modalGoalProject')
  if (ownerSelect) {
    fillAssigneeSelect(ownerSelect, g.ownerId || currentUser.id)
  }
  if (projectSelect) {
    projectSelect.innerHTML = '<option value=\"\">None</option>'
    projects.forEach(p => {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.name
      projectSelect.appendChild(opt)
    })
    projectSelect.value = g.projectId || ''
  }
  document.getElementById('modalGoalId').value      = g.id
  document.getElementById('modalGoalTitle').value   = g.title
  document.getElementById('modalGoalDesc').value    = g.description || ''
  document.getElementById('modalGoalStatus').value  = g.status || 'on_track'
  // Backward compatibility for old date-only goal due dates
  let due = g.dueDate || ''
  if (due && typeof due === 'string' && !due.includes('T')) due = due + 'T09:00'
  document.getElementById('modalGoalDue').value     = due
  renderGoalKRRows(g)
  renderGoalMilestoneRows(g)
  document.getElementById('createGoalModal').classList.add('active')
}

function closeCreateGoalModal() {
  document.getElementById('createGoalModal').classList.remove('active')
}

function saveGoal() {
  const id    = document.getElementById('modalGoalId').value
  const title = document.getElementById('modalGoalTitle').value.trim()
  if (!title) return showToast('Please enter an objective', 'error')
  const desc   = document.getElementById('modalGoalDesc').value.trim()
  const owner  = document.getElementById('modalGoalOwner').value
  const status = document.getElementById('modalGoalStatus').value
  const due    = document.getElementById('modalGoalDue').value
  const projId = document.getElementById('modalGoalProject').value
  const krs = collectGoalKRsFromModal()
  const milestones = collectGoalMilestonesFromModal()

  if (id) {
    // Update existing goal
    const goal = goals.find(g => g.id === id)
    if (!goal) return
    goal.title       = title
    goal.description = desc
    goal.ownerId     = owner || currentUser.id
    goal.status      = status
    goal.dueDate     = due || null
    goal.projectId   = projId || null
    goal.keyResults  = krs
    goal.milestones  = milestones
    goal.updated     = new Date().toISOString()
    normalizeGoalInPlace(goal)
    save('goals', goals)
    closeCreateGoalModal()
    renderGoals()
    updateStats()
    addAuditLog('update', `Updated goal \"${title}\"`, 'update')
    showToast('Goal updated!', 'success')
  } else {
    // Create new goal
    const goal = {
      id: genId(),
      title,
      description: desc,
      ownerId: owner || currentUser.id,
      status,
      dueDate: due || null,
      projectId: projId || null,
      keyResults: krs,
      milestones,
      updates: [],
      created: new Date().toISOString()
    }
    normalizeGoalInPlace(goal)
    goals.push(goal)
    save('goals', goals)
    closeCreateGoalModal()
    renderGoals()
    updateStats()
    addActivity(`Created goal: ${title}`)
    addAuditLog('create', `Created goal \"${title}\"`, 'create')
    showToast('Goal created!', 'success')
  }
}

function renderGoals() {
  migrateGoalsIfNeeded()
  const search = (document.getElementById('goalSearch')?.value || '').toLowerCase()
  const statusFilter = document.getElementById('goalStatusFilter')?.value || ''
  const ownerFilter  = document.getElementById('goalOwnerFilter')?.value || ''
  const myOnly       = document.getElementById('goalMyOnly')?.checked

  // Populate owner filter once from goals + currentUser + team
  const ownerSelect = document.getElementById('goalOwnerFilter')
  if (ownerSelect && ownerSelect.options.length === 1 && goals.length) {
    const seen = new Set()
    goals.forEach(g => {
      const id = g.ownerId
      if (!id || seen.has(id)) return
      seen.add(id)
      const opt = document.createElement('option')
      opt.value = id
      const owner = (id === currentUser.id)
        ? (currentUser.fullName || currentUser.username || 'Me')
        : (team.find(m => m.id === id)?.email || id)
      opt.textContent = owner
      ownerSelect.appendChild(opt)
    })
  }

  let filtered = goals.slice().filter(g => {
    normalizeGoalInPlace(g)
    const krTitles = (g.keyResults || []).map(kr => (typeof kr === 'string' ? kr : (kr.title || ''))).join(' ')
    const msTitles = (g.milestones || []).map(m => (typeof m === 'string' ? m : (m.title || ''))).join(' ')
    const blob = [g.title, g.description || '', krTitles, msTitles].join(' ').toLowerCase()
    if (search && !blob.includes(search)) return false
    if (statusFilter && g.status !== statusFilter) return false
    if (ownerFilter && g.ownerId !== ownerFilter) return false
    if (myOnly && g.ownerId !== currentUser.id) return false
    return true
  })

  const listEl = document.getElementById('goalsList')
  if (!listEl) return

  if (!filtered.length) {
    listEl.innerHTML = `<div class=\"empty-state compact\"><div class=\"empty-state-icon\">🎯</div><h3>No goals yet</h3><p>Create your first objective to align the team.</p><button class=\"btn-primary btn-sm\" onclick=\"openCreateGoalModal()\">+ New Goal</button></div>`
  } else {
    listEl.innerHTML = filtered.map(buildGoalCard).join('')
  }

  const summaryEl = document.getElementById('goalsSummary')
  if (summaryEl) {
    const total = goals.length
    const completed = goals.filter(g => g.status === 'completed').length
    const onTrack   = goals.filter(g => g.status === 'on_track').length
    const atRisk    = goals.filter(g => g.status === 'at_risk').length
    const offTrack  = goals.filter(g => g.status === 'off_track').length
    const mine      = goals.filter(g => g.ownerId === currentUser.id).length
    summaryEl.innerHTML = `
      <p>Total goals: <strong>${total}</strong></p>
      <p>On track: <span style=\"color:#22c55e;\">${onTrack}</span></p>
      <p>At risk: <span style=\"color:#f97316;\">${atRisk}</span></p>
      <p>Off track: <span style=\"color:#ef4444;\">${offTrack}</span></p>
      <p>Completed: <span style=\"color:#38bdf8;\">${completed}</span></p>
      <p>You own: <span style=\"color:#4f46e5;\">${mine}</span> goal${mine === 1 ? '' : 's'}</p>
    `
  }
}

function buildGoalCard(g) {
  normalizeGoalInPlace(g)
  const ownerLabel = (g.ownerId === currentUser.id)
    ? (currentUser.fullName || currentUser.username || 'Me')
    : (team.find(m => m.id === g.ownerId)?.email || 'Unassigned')
  const project = g.projectId ? projects.find(p => p.id === g.projectId) : null
  const statusLabel = {
    on_track:'On track',
    at_risk:'At risk',
    off_track:'Off track',
    completed:'Completed'
  }[g.status] || g.status
  const statusColor = g.status === 'completed'
    ? '#1e3a5f'
    : g.status === 'on_track'
      ? '#1b4332'
      : g.status === 'at_risk'
        ? '#78350f'
        : '#7f1d1d'

  const statusTextColor = g.status === 'completed'
    ? '#93c5fd'
    : g.status === 'on_track'
      ? '#86efac'
      : g.status === 'at_risk'
        ? '#fcd34d'
        : '#fecaca'

  const dueHtml = g.dueDate
    ? `<span style=\"font-size:11px;color:#9CA3AF;\">Due ${new Date(g.dueDate).toLocaleDateString()}</span>`
    : '<span style=\"font-size:11px;color:#4B5563;\">No target date</span>'

  const updates = Array.isArray(g.updates) ? g.updates.slice().sort((a,b) => new Date(b.createdAt||b.created_at||b.created) - new Date(a.createdAt||a.created_at||a.created)) : []
  const recentUpdates = updates.slice(0, 3)

  const gp = computeGoalProgress(g)
  const goalProgressHtml = gp != null
    ? `<div style=\"margin-bottom:12px;\">
        <div style=\"display:flex;justify-content:space-between;font-size:11px;color:#9CA3AF;margin-bottom:4px;\">
          <span style=\"font-weight:600;color:#c4b5fd;\">Objective progress</span><span>${gp}%</span>
        </div>
        <div style=\"height:10px;border-radius:999px;background:#111827;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,0.4);\">
          <div style=\"width:${gp}%;height:100%;background:linear-gradient(90deg,#4f46e5,#a855f7,#ec4899);transition:width .35s ease;\"></div>
        </div>
      </div>`
    : ''

  let projectTasksHtml = ''
  if (project) {
    const projectTasks = tasks.filter(t => t.projectId === project.id)
    if (projectTasks.length) {
      const done = projectTasks.filter(t => t.status === 'done' || t.status === 'completed').length
      const pct  = Math.round((done / projectTasks.length) * 100)
      projectTasksHtml = `
        <div style=\"font-size:11px;color:#6B7280;margin-bottom:4px;\">Linked project · ${escapeHtml(project.name)}</div>
        <div style=\"font-size:11px;margin-bottom:4px;\">${done}/${projectTasks.length} tasks done (${pct}%)</div>
        <div style=\"width:100%;max-width:200px;height:6px;border-radius:999px;background:#111827;overflow:hidden;margin-left:auto;\">
          <div style=\"width:${pct}%;height:100%;background:#6366f1;\"></div>
        </div>
      `
    } else {
      projectTasksHtml = `<div style=\"font-size:11px;color:#4B5563;\">Linked project: ${escapeHtml(project.name)} · no tasks yet</div>`
    }
  }

  const milestoneBlock = (g.milestones && g.milestones.length)
    ? `<div class=\"goal-card-path\">
        ${g.milestones.length > 1 ? '<div class=\"goal-card-path-line\" aria-hidden=\"true\"></div>' : ''}
        <div style=\"font-size:11px;color:#94a3b8;margin-bottom:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;\">Your path</div>
        ${g.milestones.map(m => {
          const due = m.dueDate && !isNaN(new Date(m.dueDate).getTime())
            ? new Date(m.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : ''
          const btnClass = m.done ? 'goal-card-step-btn done' : 'goal-card-step-btn'
          const mark = m.done ? '✓' : ''
          return `<div class=\"goal-card-step\">
            <button type=\"button\" class=\"${btnClass}\" onclick=\"toggleGoalMilestone(${JSON.stringify(g.id)}, ${JSON.stringify(m.id)})\" title=\"${m.done ? 'Mark not done' : 'Mark step done'}\">${mark}</button>
            <div style=\"flex:1;min-width:0;\">
              <div style=\"font-size:13px;color:${m.done ? '#64748b' : '#E5E7EB'};text-decoration:${m.done ? 'line-through' : 'none'};\">${escapeHtml(m.title)}</div>
              ${due ? `<div style=\"font-size:10px;color:#475569;\">${escapeHtml(due)}</div>` : ''}
            </div>
          </div>`
        }).join('')}
      </div>`
    : ''

  const krBlock = (g.keyResults && g.keyResults.length)
    ? `<div style=\"margin-top:12px;\">
        <div style=\"font-size:11px;color:#94a3b8;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;\">Key results</div>
        ${g.keyResults.map(kr => {
          const pct = kr.done ? 100 : (Number(kr.progress) || 0)
          return `<div style=\"margin-bottom:12px;padding:10px;border-radius:10px;background:rgba(15,23,42,0.6);border:1px solid #1e293b;\">
            <div style=\"display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;\">
              <span style=\"font-size:12px;color:#E5E7EB;line-height:1.35;\">${escapeHtml(kr.title)}</span>
              <label style=\"font-size:11px;color:#9CA3AF;display:flex;align-items:center;gap:6px;white-space:nowrap;\">
                <input type=\"checkbox\" ${kr.done ? 'checked' : ''} onchange=\"toggleGoalKRDone(${JSON.stringify(g.id)}, ${JSON.stringify(kr.id)})\"> <span>${pct}%</span>
              </label>
            </div>
            <input type=\"range\" class=\"goal-kr-slider\" min=\"0\" max=\"100\" value=\"${pct}\" ${kr.done ? 'disabled' : ''} oninput=\"setGoalKRProgress(${JSON.stringify(g.id)}, ${JSON.stringify(kr.id)}, this.value)\">
            ${(kr.target || kr.current) ? `<div style=\"font-size:10px;color:#64748b;margin-top:6px;\">${kr.target ? `Target: ${escapeHtml(kr.target)}` : ''}${kr.target && kr.current ? ' · ' : ''}${kr.current ? `Now: ${escapeHtml(kr.current)}` : ''}</div>` : ''}
          </div>`
        }).join('')}
      </div>`
    : ''

  return `
    <div class=\"card\" style=\"margin-bottom:14px;border:1px solid #1e293b;background:linear-gradient(165deg, rgba(15,23,42,0.9) 0%, rgba(2,6,23,0.95) 100%);\">
      <div style=\"display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;\">
        <div style=\"flex:1;min-width:0;\">
          <h3 style=\"font-size:16px;margin-bottom:4px;background:linear-gradient(90deg,#e2e8f0,#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;\">${escapeHtml(g.title)}</h3>
          <div style=\"font-size:12px;color:#9CA3AF;margin-bottom:4px;\">Owner: ${escapeHtml(ownerLabel)}</div>
          ${g.description ? `<p style=\"font-size:13px;color:#9CA3AF;margin-bottom:4px;line-height:1.45;\">${escapeHtml(g.description)}</p>` : ''}
        </div>
        <div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:6px;\">
          <span style=\"font-size:11px;padding:3px 10px;border-radius:999px;background:${statusColor};color:${statusTextColor};white-space:nowrap;\">${escapeHtml(statusLabel)}</span>
          <div style=\"display:flex;gap:4px;\">
            <button class=\"btn-xs btn-secondary\" onclick=\"openEditGoalModal('${g.id}')\">Edit</button>
            <button class=\"btn-xs btn-danger\" onclick=\"deleteGoal('${g.id}')\">Delete</button>
          </div>
        </div>
      </div>
      ${goalProgressHtml}
      ${milestoneBlock}
      ${krBlock}
      ${(!g.keyResults || !g.keyResults.length) && (!g.milestones || !g.milestones.length) ? `<p style=\"font-size:12px;color:#64748b;margin:8px 0;\">Add <strong>key results</strong> and <strong>planning steps</strong> in Edit to unlock progress tracking and your path.</p>` : ''}
      <div style=\"display:flex;justify-content:space-between;align-items:flex-start;font-size:12px;color:#9CA3AF;gap:16px;margin-top:12px;padding-top:12px;border-top:1px solid #1e293b;\">
        <div style=\"flex:1;min-width:0;\">
          ${recentUpdates.length ? `
            <div style=\"font-size:11px;margin-bottom:6px;\">
              <div style=\"margin-bottom:4px;color:#6B7280;\">Recent updates</div>
              <ul style=\"padding-left:16px;margin:0;display:flex;flex-direction:column;gap:4px;\">
                ${recentUpdates.map(u => {
                  const d = u.createdAt || u.created_at || u.created
                  const label = d ? new Date(d).toLocaleDateString(undefined,{ month:'short', day:'numeric' }) : ''
                  return `<li>${label ? `<span style=\"color:#6B7280;\">${label} · </span>` : ''}${escapeHtml(u.text || '')}</li>`
                }).join('')}
              </ul>
            </div>
          ` : ''}
          <button class=\"btn-xs btn-secondary\" style=\"margin-top:4px;\" onclick=\"openGoalUpdateModal('${g.id}')\">+ Add update</button>
        </div>
        <div style=\"text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:120px;\">
          ${projectTasksHtml || (project ? '' : '<span style=\"font-size:11px;color:#4B5563;\">No project link</span>')}
          ${dueHtml}
        </div>
      </div>
    </div>
  `
}

function deleteGoal(id) {
  const g = goals.find(x => x.id === id)
  if (!g) return
  openConfirmModal({
    type: 'delete_goal',
    id,
    title: 'Delete goal',
    message: `This will delete goal "${g.title}".`,
    level: 'danger'
  })
}

function reallyDeleteGoal(id) {
  const g = goals.find(x => x.id === id)
  if (!g) return
  goals = goals.filter(x => x.id !== id)
  save('goals', goals)
  renderGoals()
  updateStats()
  addAuditLog('delete', `Deleted goal \"${g.title}\"`, 'delete')
  showToast('Goal deleted', 'success')
}

function renderTeam() {
  let activeHtml  = buildCurrentUserCard() + buildWorkspaceOwnerPeerCard()
  let pendingHtml = ''

  const roleFilter   = document.getElementById('teamRoleFilter')?.value || ''
  const statusFilter = document.getElementById('teamStatusFilter')?.value || ''
  const sortBy       = document.getElementById('teamSortBy')?.value || 'role'

  // Only admins/owners can invite or remove members or change roles
  const canManageTeam = currentUser && (currentUser.role === 'admin' || currentUser.role === 'owner')
  const inviteBtn = document.getElementById('teamInviteBtn')
  if (inviteBtn) inviteBtn.style.display = canManageTeam ? '' : 'none'

  const roleRank = { owner: 0, admin: 1, manager: 2, member: 3 }
  const sortedTeam = team.slice().sort((a, b) => {
    const aName = ((a.email || '').split('@')[0] || '').toLowerCase()
    const bName = ((b.email || '').split('@')[0] || '').toLowerCase()
    const aTasks = tasks.filter(t => t.assignee === a.id && t.status !== 'done' && t.status !== 'completed').length
    const bTasks = tasks.filter(t => t.assignee === b.id && t.status !== 'done' && t.status !== 'completed').length
    if (sortBy === 'name') return aName.localeCompare(bName)
    if (sortBy === 'workload') return bTasks - aTasks || aName.localeCompare(bName)
    return (roleRank[a.role] ?? 99) - (roleRank[b.role] ?? 99) || aName.localeCompare(bName)
  })

  const ownerPeerId =
    workspaceOwnerSummary && workspaceOwnerSummary.id && workspaceOwnerSummary.id !== currentUser?.id
      ? workspaceOwnerSummary.id
      : ''

  sortedTeam.forEach(m => {
    const isAccepted = m.status === 'accepted'
    const isPending  = m.status === 'pending'

    if (isAccepted && currentUser && m.id === currentUser.id) return
    if (isPending && isTeamPendingSuperseded(m)) return
    if (ownerPeerId && m.id === ownerPeerId) return

    if (statusFilter === 'accepted' && !isAccepted) return
    if (statusFilter === 'pending' && !isPending) return
    if (roleFilter && m.role !== roleFilter) return

    const emailSafe = (m.email || '').trim()
    const initial = emailSafe ? emailSafe.charAt(0).toUpperCase() : '?'
    const displayName = emailSafe ? emailSafe.split('@')[0] : 'Member'
    const online = isUserOnline(m.id)
    const presenceLabel = getLastSeenLabel(m.id)

    let taskCount = tasks.filter(t => t.assignee === m.id).length
    if (isAccepted) {
      activeHtml += `
        <div class="member-card">
          <div class="member-card-inner">
            <div class="member-avatar">
              <div class="member-online-dot" style="background:${online ? '#22c55e' : '#6B7280'};"></div>
              ${initial}
            </div>
            <div class="member-card-body">
              <h4>${escapeHtml(displayName)}</h4>
              ${emailSafe ? `<span class="member-email">${escapeHtml(emailSafe)}</span>` : ''}
              <div class="member-meta">
                ${m.department ? `<span class="member-dept">${escapeHtml(m.department)}</span>` : ''}
                <span class="role-badge ${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
              </div>
              <div class="member-stats">
                <div><span class="member-stat-val">${taskCount}</span>tasks assigned</div>
                <div style="font-size:11px;color:${online ? '#86efac' : '#9CA3AF'};align-self:flex-end;">${escapeHtml(presenceLabel)}</div>
              </div>
              ${canManageTeam ? `
                <div class="member-card-actions">
                  <select onchange="updateMemberRole('${m.id}', this.value)">
                    <option value="owner"   ${m.role==='owner'?'selected':''}>Owner</option>
                    <option value="admin"   ${m.role==='admin'?'selected':''}>Admin</option>
                    <option value="manager" ${m.role==='manager'?'selected':''}>Manager</option>
                    <option value="member"  ${m.role==='member'?'selected':''}>Member</option>
                  </select>
                  <div class="member-card-quick-actions">
                    <button type="button" class="btn-sm btn-secondary" onclick="assignTaskToMember('${m.id}')">Assign task</button>
                    <button type="button" class="btn-sm btn-danger" onclick="removeMember('${m.id}')">Remove</button>
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `
    } else {
      pendingHtml += `
        <div class="member-card member-card--pending">
          <div class="member-card-inner">
            <div class="member-avatar" style="background:#374151;">${initial}</div>
            <div class="member-card-body">
              <h4>${escapeHtml(emailSafe || 'Pending invite')}</h4>
              ${emailSafe ? `<span class="member-email">Waiting for them to sign in</span>` : ''}
              <div class="member-meta">
                <span class="role-badge ${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
              </div>
              <div style="font-size:11px;color:#f59e0b;margin-bottom:10px;">Invitation pending</div>
              ${canManageTeam ? `
                <div class="team-pending-actions">
                  <button type="button" class="btn-sm btn-success" onclick="acceptInvite('${m.id}')">Mark accepted</button>
                  <button type="button" class="btn-sm btn-danger" onclick="removeMember('${m.id}')">Revoke</button>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `
    }
  })

  if (team.length === 0 && !(workspaceOwnerSummary && currentUser && workspaceOwnerSummary.id !== currentUser.id)) {
    activeHtml += `<div class="team-empty-inline" style="grid-column:1/-1;"><div class="empty-state compact" style="padding:20px 12px;border:none;background:transparent;"><div class="empty-state-icon">👥</div><h3>No teammates yet</h3><p style="max-width:360px;margin-left:auto;margin-right:auto;">Invite by email or share an invite code so people appear here.</p><button type="button" class="btn-primary btn-sm" onclick="openInviteTeamModal()">Invite by email</button></div></div>`
  }
  document.getElementById('teamList').innerHTML    = activeHtml
  document.getElementById('inviteList').innerHTML  = pendingHtml || '<div class="team-empty-inline" style="border:none;">No pending invitations</div>'

  let pending = team.filter(m => m.status === 'pending' && !isTeamPendingSuperseded(m)).length
  const acceptedExclSelf = team.filter(m => m.status === 'accepted' && (!currentUser || m.id !== currentUser.id))
  let admins  = acceptedExclSelf.filter(m => m.role === 'admin').length + (currentUser.role === 'admin' ? 1 : 0)
  if (document.getElementById('teamStatTotal')) document.getElementById('teamStatTotal').textContent = String(workspacePeopleHeadcount())
  if (document.getElementById('teamStatPending')) document.getElementById('teamStatPending').textContent = pending
  if (document.getElementById('teamStatAdmins')) document.getElementById('teamStatAdmins').textContent = admins
  renderTeamWorkloadBoard()
  renderTeamActivityStream()
  refreshTeamInvitePanels()
}

function assignTaskToMember(memberId) {
  if (!ensureCurrentUser()) return
  preferredTaskAssigneeId = memberId || ''
  switchPage('tasks', null)
  setTimeout(function() {
    openCreateTaskModal()
    const titleEl = document.getElementById('modalTaskTitle')
    if (titleEl && !titleEl.value) titleEl.focus()
  }, 80)
}

function renderTeamWorkloadBoard() {
  const container = document.getElementById('teamWorkloadGrid')
  if (!container) return

  const oid = workspaceOwnerSummary && workspaceOwnerSummary.id
  const ownerPeer =
    oid && oid !== currentUser?.id && !team.some(m => m && m.id === oid)
      ? [{ id: oid, label: workspaceOwnerSummary.fullName || workspaceOwnerSummary.username || 'Owner', isYou: false, isOwner: true }]
      : []
  const members = [
    { id: currentUser?.id, label: currentUser?.fullName || currentUser?.username || 'You', isYou: true },
    ...ownerPeer,
    ...team
      .filter(m => m.status === 'accepted' && m.id !== currentUser?.id && (!oid || m.id !== oid))
      .map(m => ({ id: m.id, label: (m.email || 'Member').split('@')[0], isYou: false }))
  ]

  const maxOpen = Math.max(1, ...members.map(m => tasks.filter(t => t.assignee === m.id && t.status !== 'done' && t.status !== 'completed').length))
  if (!members.length) {
    container.innerHTML = '<div class="team-empty-inline" style="grid-column:1/-1;">No team members yet</div>'
    return
  }

  container.innerHTML = members.map(m => {
    const openCount = tasks.filter(t => t.assignee === m.id && t.status !== 'done' && t.status !== 'completed').length
    const doneCount = tasks.filter(t => t.assignee === m.id && (t.status === 'done' || t.status === 'completed')).length
    const widthPct = Math.round((openCount / maxOpen) * 100)
    return `
      <div class="team-workload-card">
        <div class="team-workload-name">${escapeHtml(m.label)} ${m.isYou ? '<span style="font-size:10px;color:#a78bfa;">(You)</span>' : ''}${m.isOwner ? '<span style="font-size:10px;color:#a78bfa;"> · Owner</span>' : ''}</div>
        <div class="team-workload-meta">${openCount} open task${openCount === 1 ? '' : 's'} · ${doneCount} completed</div>
        <div class="team-workload-bar"><div class="team-workload-fill" style="width:${widthPct}%;"></div></div>
        <div style="margin-top:9px;"><button type="button" class="btn-xs btn-secondary" onclick="assignTaskToMember('${m.id}')">+ Assign task</button></div>
      </div>
    `
  }).join('')
}

function renderTeamActivityStream() {
  const el = document.getElementById('teamActivityList')
  if (!el) return
  const interesting = (auditLogs || []).slice().filter(a => {
    const txt = String(a.text || '').toLowerCase()
    return txt.includes('task') || txt.includes('team') || txt.includes('invite') || txt.includes('goal') || txt.includes('project')
  }).sort((a,b) => new Date(b.time) - new Date(a.time)).slice(0, 10)

  if (!interesting.length) {
    el.innerHTML = '<div class="team-empty-inline" style="border:none;padding:8px 0;">No team activity yet</div>'
    return
  }

  el.innerHTML = interesting.map(item => `
    <div class="team-activity-item">
      ${escapeHtml(item.text || 'Workspace update')}
      <small>${new Date(item.time).toLocaleString()}</small>
    </div>
  `).join('')
}

function buildCurrentUserCard() {
  // Guard against cases where the team page renders before auth/session is ready
  if (!currentUser) {
    return ''
  }
  let taskCount = Array.isArray(tasks)
    ? tasks.filter(t => t.assignee === currentUser.id).length
    : 0
  const role = currentUser.role || 'owner'
  const display = currentUser.fullName || currentUser.username || 'You'
  const online = isUserOnline(currentUser.id)
  const presenceLabel = getLastSeenLabel(currentUser.id)
  return `
    <div class="member-card member-card--you">
      <div class="member-card-inner">
        <div class="member-avatar">
          <div class="member-online-dot" style="background:${online ? '#22c55e' : '#6B7280'};"></div>
          ${display.charAt(0).toUpperCase()}
        </div>
        <div class="member-card-body">
          <h4>${escapeHtml(display)} <span style="font-size:10px;font-weight:600;color:#a78bfa;text-transform:uppercase;">You</span></h4>
          ${currentUser.email ? `<span class="member-email">${escapeHtml(currentUser.email)}</span>` : ''}
          <div class="member-meta">
            <span class="role-badge ${escapeHtml(role)}">${escapeHtml(role)}</span>
          </div>
          <div class="member-stats"><div><span class="member-stat-val">${taskCount}</span>tasks assigned to you</div><div style="font-size:11px;color:${online ? '#86efac' : '#9CA3AF'};align-self:flex-end;">${escapeHtml(presenceLabel)}</div></div>
          <button type="button" class="btn-sm btn-secondary" onclick="switchPage('settings',null)">Edit profile</button>
        </div>
      </div>
    </div>
  `
}

/** Renders the workspace owner for teammates — owner is not stored in team[] (only invitees are). */
function buildWorkspaceOwnerPeerCard() {
  if (!workspaceOwnerSummary || !currentUser) return ''
  if (workspaceOwnerSummary.id === currentUser.id) return ''
  const o = workspaceOwnerSummary
  const emailSafe = (o.email || '').trim()
  const display = o.fullName || o.username || 'Workspace owner'
  const initial = (display || '?').charAt(0).toUpperCase()
  const online = isUserOnline(o.id)
  const presenceLabel = getLastSeenLabel(o.id)
  const taskCount = tasks.filter(t => t.assignee === o.id).length
  const role = o.role || 'owner'
  return `
    <div class="member-card member-card--owner-peer">
      <div class="member-card-inner">
        <div class="member-avatar">
          <div class="member-online-dot" style="background:${online ? '#22c55e' : '#6B7280'};"></div>
          ${initial}
        </div>
        <div class="member-card-body">
          <h4>${escapeHtml(display)} <span style="font-size:10px;font-weight:600;color:#a78bfa;text-transform:uppercase;">Workspace owner</span></h4>
          ${emailSafe ? `<span class="member-email">${escapeHtml(emailSafe)}</span>` : ''}
          <div class="member-meta">
            <span class="role-badge ${escapeHtml(role)}">${escapeHtml(role)}</span>
          </div>
          <div class="member-stats">
            <div><span class="member-stat-val">${taskCount}</span>tasks assigned</div>
            <div style="font-size:11px;color:${online ? '#86efac' : '#9CA3AF'};align-self:flex-end;">${escapeHtml(presenceLabel)}</div>
          </div>
          <button type="button" class="btn-sm btn-secondary" onclick="assignTaskToMember('${String(o.id).replace(/'/g, "\\'")}')">Assign task</button>
        </div>
      </div>
    </div>
  `
}

function updateMemberRole(id, newRole) {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'owner')) {
    showToast('You do not have permission to change roles.', 'error')
    renderTeam()
    return
  }
  let m = team.find(x => x.id === id)
  if (!m) return
  const oldRole = m.role
  if (oldRole === newRole) return
  m.role = newRole
  save('team', team)
  renderTeam()
  addAuditLog('update', `Changed role for ${m.email} from ${oldRole} to ${newRole}`, 'update')
  showToast('Role updated', 'success')
}

function acceptInvite(id) {
  let m = team.find(x => x.id === id)
  if (!m) return

  m.status = 'accepted'
  save('team', team)
  renderTeam()
  addNotification(`${m.email} joined the workspace`, 'team')
  addAuditLog('update', `Accepted invite for ${m.email}`, 'update')
  showToast('Member accepted!', 'success')
}

function removeMember(id) {
  let m = team.find(x => x.id === id)
  if (!m) return
  openConfirmModal({
    type: 'remove_member',
    id,
    title: 'Remove team member',
    message: `This will remove ${m.email || 'this member'} from the workspace.`,
    level: 'danger'
  })
}

function reallyRemoveMember(id) {
  let m = team.find(x => x.id === id)
  team = team.filter(x => x.id !== id)
  save('team', team)
  renderTeam()
  addAuditLog('delete', `Removed team member ${m?.email}`, 'delete')
  showToast('Member removed', 'success')
  updateStats()
}

function resendInvite(id) {
  let inv = team.find(i => i.id === id)
  if (inv) { addNotification(`Invitation resent to ${inv.email}`, 'team'); showToast('Invitation resent!', 'success') }
}

/* ===================================================
   NOTIFICATIONS
=================================================== */
function addNotification(text, type, meta) {
  const row = {
    id: genId(), text: text, type: type || 'info',
    time: new Date().toISOString(), read: false
  }
  if (meta && meta.linkType && meta.linkId) {
    row.linkType = meta.linkType
    row.linkId = meta.linkId
    if (meta.eventStart) row.eventStart = meta.eventStart
  }
  notifications.unshift(row)
  if (notifications.length > 100) notifications.pop()
  save('notifications', notifications)
  renderNotifications()
}

function openNotificationTarget(n) {
  if (!n) return
  n.read = true
  save('notifications', notifications)
  renderNotifications(currentNotificationFilter)
  const panel = document.getElementById('notificationsPanel')
  if (panel) panel.classList.remove('active')
  if (n.linkType === 'task' && n.linkId) {
    switchPage('tasks', null)
    setTimeout(function () { openTaskDetail(n.linkId) }, 100)
  } else if (n.linkType === 'event' && n.linkId) {
    switchPage('calendar', null)
    const ev = events.find(function (e) { return e.id === n.linkId })
    const day = (ev && ev.start) ? String(ev.start).slice(0, 10) : (n.eventStart || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    selectedCalendarDate = day
    setTimeout(function () { renderCalendar() }, 120)
  }
  logAnalyticsEvent('notification_navigate', { linkType: n.linkType || '' })
}

function handleNotifRowClick(id, evt) {
  const n = notifications.find(function (x) { return x.id === id })
  if (!n) return
  if (n.linkType && n.linkId) {
    if (evt) evt.stopPropagation()
    openNotificationTarget(n)
  } else {
    markNotifRead(id)
  }
}

function renderNotifications(filter) {
  if (typeof filter === 'string') currentNotificationFilter = filter
  let list = notifications
  if (currentNotificationFilter === 'unread') list = notifications.filter(n => !n.read)
  if (currentNotificationFilter === 'mentions') list = notifications.filter(n => n.type === 'mention')
  if (currentNotificationFilter === 'tasks') list = notifications.filter(n => n.linkType === 'task' || n.type === 'task')
  if (currentNotificationFilter === 'system') list = notifications.filter(n => !n.linkType && (n.type === 'info' || n.type === 'system'))

  const q = (document.getElementById('notificationsSearch')?.value || '').toLowerCase().trim()
  if (q) list = list.filter(n => String(n.text || '').toLowerCase().includes(q))
  let html = list.slice(0, 30).map(n => `
    <div class="notification-item ${n.read ? '' : 'unread'} ${n.linkType && n.linkId ? 'notification-item--link' : ''}" style="${n.linkType && n.linkId ? 'cursor:pointer;' : ''}" onclick="handleNotifRowClick('${n.id}', event)">
      <div class="notif-dot ${n.read ? 'read' : ''}"></div>
      <div class="notification-body">
        <div class="notification-title">${escapeHtml(n.text)}${n.linkType && n.linkId ? ' <span style="font-size:10px;color:#6B7280;">→ Open</span>' : ''}</div>
        <div class="notification-time">${timeAgo(n.time)}</div>
      </div>
      <button type="button" class="btn-xs btn-secondary" style="margin-left:auto;align-self:center;" onclick="event.stopPropagation();markNotifRead('${n.id}');">Read</button>
    </div>
  `).join('')

  let listEl = document.getElementById('notificationsList')
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty-state compact"><div class="empty-state-icon">🔔</div><h3>No notifications</h3><p>Notifications will show up here when you get updates</p></div>'
  } else {
    listEl.innerHTML = html
  }

  let unread = notifications.filter(n => !n.read).length
  let badge  = document.getElementById('topbarNotifBadge')
  if (unread > 0) { badge.textContent = unread > 99 ? '99+' : unread; badge.classList.add('visible') }
  else badge.classList.remove('visible')
}

function filterNotifs(type, el) {
  document.querySelectorAll('.notif-tab').forEach(t => t.classList.remove('active'))
  el.classList.add('active')
  currentNotificationFilter = type
  renderNotifications(type)
}

function toggleNotifications() {
  let panel = document.getElementById('notificationsPanel')
  if (!panel) return
  let willOpen = !panel.classList.contains('active')
  panel.classList.toggle('active')
  if (willOpen) {
    // Ensure list & badge are up to date when opening
    renderNotifications(currentNotificationFilter)
  }
}

function markNotifRead(id) {
  let n = notifications.find(x => x.id === id)
  if (n) { n.read = true; save('notifications', notifications); renderNotifications(currentNotificationFilter) }
}

function markAllAsRead() {
  notifications.forEach(n => n.read = true)
  save('notifications', notifications)
  renderNotifications(currentNotificationFilter)
  showToast('All marked as read', 'success')
}

/* ===================================================
   ACTIVITY
=================================================== */
function addActivity(text) {
  activity.unshift({ id: genId(), text, user: currentUser.username, timestamp: new Date().toISOString() })
  if (activity.length > 200) activity.pop()
  save('activity', activity)
  renderActivityFeed()
}

function renderActivityFeed() {
  let el = document.getElementById('activityFeed')
  if (!el) return
  if (!activity.length) {
    el.innerHTML = '<div class="empty-state compact"><div class="empty-state-icon">📋</div><h3>No activity yet</h3><p>Create projects, tasks, or log time to see activity here</p></div>'
    return
  }
  el.innerHTML = activity.slice(0, 20).map(a => `
    <div class="activity-item">
      <div class="activity-avatar">${a.user.charAt(0).toUpperCase()}</div>
      <div class="activity-content">
        <h4>${escapeHtml(a.user)}</h4>
        <p>${escapeHtml(a.text)}</p>
        <div class="activity-time">${timeAgo(a.timestamp)}</div>
      </div>
    </div>
  `).join('')
}

/* ===================================================
   AUDIT LOG
=================================================== */
function addAuditLog(type, text, iconType, meta) {
  const m = meta && typeof meta === 'object' ? meta : {}
  auditLogs.unshift({
    id: genId(), type, text, iconType: iconType || 'other',
    user: currentUser ? currentUser.username : 'system',
    timestamp: new Date().toISOString(),
    projectId: m.projectId || null,
    taskId: m.taskId || null
  })
  if (auditLogs.length > 500) auditLogs.pop()
  save('audit', auditLogs)
}

function renderAuditLog(list) {
  let source = list || auditLogs
  let el     = document.getElementById('auditLogList')
  if (!el) return

  if (!source.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><h3>No audit logs yet</h3><p>Actions will appear here</p></div>`
    return
  }

  let iconMap = { create:'➕', update:'✏️', delete:'🗑', login:'🔑', other:'⚡' }
  el.innerHTML = source.slice(0, 100).map(log => `
    <div class="audit-log-item">
      <div class="audit-icon ${log.iconType}">${iconMap[log.iconType] || '⚡'}</div>
      <div class="audit-body">
        <div class="audit-action">${escapeHtml(log.text)}</div>
        <div class="audit-detail">by <strong>${escapeHtml(log.user)}</strong></div>
      </div>
      <div class="audit-time">${timeAgo(log.timestamp)}</div>
    </div>
  `).join('')
}

function filterAuditLog() {
  let search = document.getElementById('auditSearch').value.toLowerCase()
  let type   = document.getElementById('auditTypeFilter').value
  let filtered = auditLogs.filter(l => {
    let ms = l.text.toLowerCase().includes(search) || l.user.toLowerCase().includes(search)
    let mt = !type || l.type === type
    return ms && mt
  })
  renderAuditLog(filtered)
}

function exportAuditLog() {
  let text = auditLogs.map(l => `[${new Date(l.timestamp).toISOString()}] [${l.type}] ${l.user}: ${l.text}`).join('\n')
  let blob = new Blob([text], { type: 'text/plain' })
  let a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `audit-log-${Date.now()}.txt` })
  a.click()
  showToast('Audit log exported!', 'success')
}

/* ===================================================
   PAGES (Notion-style blocks)
=================================================== */
function ensurePageInitialized() {
  if (!pages || !pages.length) {
    pages = [{
      id: genId(),
      title: 'Untitled',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      blocks: [
        { id: genId(), type: 'paragraph', text: '' }
      ]
    }]
    save('pages', pages)
  }
}

function createNewPage() {
  ensurePageInitialized()
  const newPage = {
    id: genId(),
    title: 'Untitled',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    blocks: [{ id: genId(), type: 'paragraph', text: '' }]
  }
  pages.unshift(newPage)
  save('pages', pages)
  currentPageId = newPage.id
  renderPagesEditor()
}

function stripHtmlForPreview(html) {
  if (!html) return ''
  const d = document.createElement('div')
  d.innerHTML = html
  return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim()
}

function getPageWordCount(page) {
  if (!page || !Array.isArray(page.blocks)) return 0
  let s = ''
  page.blocks.forEach(b => {
    if (b.text) s += stripHtmlForPreview(b.text) + ' '
  })
  const w = s.trim().split(/\s+/).filter(Boolean)
  return w.length
}

function updatePagesMetaAndBreadcrumb(page) {
  const t = document.getElementById('pagesBreadcrumbTitle')
  if (t) t.textContent = page.title || 'Untitled'
  const u = document.getElementById('pagesMetaUpdated')
  if (u) {
    const d = new Date(page.updated || page.created)
    u.textContent = 'Updated ' + (isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
  }
  const wc = getPageWordCount(page)
  const mw = document.getElementById('pagesMetaWords')
  if (mw) mw.textContent = wc + ' word' + (wc === 1 ? '' : 's')
  const mr = document.getElementById('pagesMetaRead')
  if (mr) mr.textContent = '~' + Math.max(1, Math.ceil(wc / 200)) + ' min read'
}

function updatePageTOC(page) {
  const body = document.getElementById('pageTOCBody')
  if (!body || !page || !Array.isArray(page.blocks)) return
  const items = []
  page.blocks.forEach((b, i) => {
    if (b.type === 'heading' || b.type === 'heading2' || b.type === 'heading3') {
      const label = stripHtmlForPreview(b.text) || '(empty heading)'
      const cls = b.type === 'heading' ? 'docs-toc-h1' : b.type === 'heading2' ? 'docs-toc-h2' : 'docs-toc-h3'
      items.push({ i, label, cls })
    }
  })
  if (!items.length) {
    body.className = 'docs-toc-empty'
    body.innerHTML = 'Add headings to see outline.'
    return
  }
  body.className = ''
  body.innerHTML = '<ul>' + items.map(it =>
    `<li><a class="${it.cls}" data-toc-index="${it.i}" onclick="focusBlockIndex(${it.i}); return false;">${escapeHtml(it.label)}</a></li>`
  ).join('') + '</ul>'
}

function extractWikiLinksFromHtml(html) {
  const out = []
  const s = String(html || '')
  // <a ... data-wiki-page-id="...">
  const re = /data-wiki-page-id\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(s))) {
    const id = String(m[1] || '').trim()
    if (id) out.push(id)
  }
  return out
}

function buildDocsLinkIndex() {
  ensurePageInitialized()
  const idx = {}
  pages.forEach(p => {
    const links = new Set()
    ;(p.blocks || []).forEach(b => {
      if (b && b.text) extractWikiLinksFromHtml(b.text).forEach(id => links.add(id))
    })
    idx[p.id] = Array.from(links)
  })
  try { localStorage.setItem('pageLinkIndex', JSON.stringify(idx)) } catch (e) {}
  return idx
}

function loadDocsLinkIndex() {
  try {
    const raw = localStorage.getItem('pageLinkIndex')
    if (!raw) return null
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : null
  } catch (e) {
    return null
  }
}

function renderPageBacklinks(page) {
  const el = document.getElementById('pageBacklinksBody')
  if (!el || !page) return
  const idx = loadDocsLinkIndex() || buildDocsLinkIndex()
  const inbound = []
  Object.keys(idx || {}).forEach(fromId => {
    const arr = idx[fromId] || []
    if (Array.isArray(arr) && arr.includes(page.id)) inbound.push(fromId)
  })
  if (!inbound.length) {
    el.className = 'docs-toc-empty'
    el.textContent = 'No backlinks yet.'
    return
  }
  el.className = ''
  const rows = inbound
    .map(pid => pages.find(p => p.id === pid))
    .filter(Boolean)
    .slice(0, 12)
  el.innerHTML = '<ul>' + rows.map(p =>
    `<li><a class="docs-toc-h2" onclick="openPage('${escapeHtml(p.id)}'); return false;">${escapeHtml(p.title || 'Untitled')}</a></li>`
  ).join('') + '</ul>'
}

function duplicateCurrentPage() {
  ensurePageInitialized()
  const p = pages.find(x => x.id === currentPageId)
  if (!p) return
  const copy = JSON.parse(JSON.stringify(p))
  copy.id = genId()
  copy.title = (p.title || 'Untitled') + ' (copy)'
  copy.created = copy.updated = new Date().toISOString()
  if (Array.isArray(copy.blocks)) {
    copy.blocks = copy.blocks.map(b => Object.assign({}, b, { id: genId() }))
  }
  pages.unshift(copy)
  save('pages', pages)
  currentPageId = copy.id
  renderPagesEditor()
  showToast('Duplicate created', 'success')
}

function exportCurrentPageAsText() {
  const p = pages.find(x => x.id === currentPageId)
  if (!p || !Array.isArray(p.blocks)) return
  const lines = []
  lines.push(p.title || 'Untitled')
  lines.push('')
  p.blocks.forEach(b => {
    const raw = stripHtmlForPreview(b.text || '')
    if (b.type === 'divider') lines.push('---')
    else if (b.type === 'checklist') lines.push((b.checked ? '[x] ' : '[ ] ') + raw)
    else if (b.type === 'heading') lines.push('# ' + raw)
    else if (b.type === 'heading2') lines.push('## ' + raw)
    else if (b.type === 'heading3') lines.push('### ' + raw)
    else if (b.type === 'quote') lines.push('> ' + raw)
    else if (b.type === 'callout') lines.push('Note: ' + raw)
    else if (b.type === 'code') lines.push('```\n' + raw + '\n```')
    else lines.push(raw)
    lines.push('')
  })
  const text = lines.join('\n').trim()
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('Copied to clipboard', 'success') }).catch(function () { window.prompt('Copy:', text) })
  } else {
    window.prompt('Copy this text:', text)
  }
}

function printCurrentDoc() {
  // Users can "Save as PDF" from the system print dialog.
  try {
    window.print()
  } catch (e) {
    showToast('Print is not available in this browser', 'error')
  }
}

function deletePageById(pageId, ev) {
  if (ev) ev.stopPropagation()
  ensurePageInitialized()
  if (pages.length <= 1) {
    showToast('Keep at least one page', 'warning')
    return
  }
  const p = pages.find(x => x.id === pageId)
  const title = (p && p.title && String(p.title).trim()) ? String(p.title).trim() : 'Untitled'
  openConfirmModal({
    type: 'delete_page',
    id: pageId,
    title: 'Delete page',
    message: `Delete “${title}”? This cannot be undone.`,
    level: 'danger'
  })
}

function deleteCurrentPage() {
  if (!currentPageId) return
  deletePageById(currentPageId, null)
}

function reallyDeletePage(pageId) {
  ensurePageInitialized()
  if (pages.length <= 1) return
  pages = pages.filter(p => p.id !== pageId)
  save('pages', pages)
  if (currentPageId === pageId) {
    currentPageId = pages[0] ? pages[0].id : null
  }
  renderPagesEditor()
  showToast('Page deleted', 'success')
}

function renderPagesList() {
  ensurePageInitialized()
  const search = (document.getElementById('pagesSearch')?.value || '').toLowerCase().trim()
  let list = pages
  if (search) list = pages.filter(p => (p.title || '').toLowerCase().includes(search))

  const el = document.getElementById('pagesList')
  if (!el) return

  if (!list.length) {
    el.innerHTML = '<div class="pages-list-empty">No pages match your search. Clear the search or create a new page.</div>'
    return
  }

  el.innerHTML = list.map(p => `
    <div class="pages-row ${p.id === currentPageId ? 'active' : ''}" onclick="openPage('${p.id}')">
      <span class="pages-row-icon" aria-hidden="true">📄</span>
      <div class="pages-row-body">
        <div class="pages-row-title">${escapeHtml(p.title || 'Untitled')}</div>
        <div class="pages-row-meta">${getPageWordCount(p)} words · ${new Date(p.updated || p.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      </div>
      <button type="button" class="pages-row-del-btn" onclick="deletePageById('${p.id}', event)" title="Delete this page" aria-label="Delete this page">
        <span class="pages-row-del-icon" aria-hidden="true">🗑</span>
        <span class="pages-row-del-label">Delete</span>
      </button>
    </div>
  `).join('')
}

function openPage(pageId) {
  currentPageId = pageId
  const p = pages.find(x => x.id === pageId)
  if (!p) return

  // Keep title input in sync
  const titleInput = document.getElementById('pageTitleInput')
  if (titleInput) titleInput.value = p.title || ''

  renderBlocksForCurrentPage()
  renderPagesList()
}

function newBlockOfType(type) {
  if (type === 'divider') return { id: genId(), type }
  if (type === 'checklist') return { id: genId(), type, checked: false, text: '' }
  if (type === 'heading') return { id: genId(), type, text: '' }
  if (type === 'heading2') return { id: genId(), type: 'heading2', text: '' }
  if (type === 'heading3') return { id: genId(), type: 'heading3', text: '' }
  if (type === 'quote') return { id: genId(), type, text: '' }
  if (type === 'code') return { id: genId(), type: 'code', text: '' }
  if (type === 'callout') return { id: genId(), type: 'callout', text: '' }
  if (type === 'bulleted_list') return { id: genId(), type: 'bulleted_list', text: '<li></li>' }
  if (type === 'numbered_list') return { id: genId(), type: 'numbered_list', text: '<li></li>' }
  return { id: genId(), type: 'paragraph', text: '' }
}

function syncPagesSidebarMeta() {
  const page = pages.find(x => x.id === currentPageId)
  if (!page) return
  updatePagesMetaAndBreadcrumb(page)
  updatePageTOC(page)
  renderPageBacklinks(page)
}

function focusBlockIndex(index) {
  const container = document.getElementById('blocksContainer')
  if (!container) return
  const el = container.querySelector(`[data-block-index="${index}"][data-block-field="text"]`) ||
             container.querySelector(`[data-block-index="${index}"][data-block-field="checkText"]`)
  if (el && el.focus) {
    el.focus()
    // Move caret to end for better UX
    try {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    } catch (e) {}
  }
}

function updateCurrentPageAndPersist(mutator) {
  ensurePageInitialized()
  const page = pages.find(x => x.id === currentPageId)
  if (!page) return

  const opts = arguments.length > 1 ? arguments[1] : null
  if (opts && opts.history) {
    try { snapshotDocsPageForUndo(String(opts.reason || 'edit')) } catch (e) {}
  }

  mutator(page)
  page.updated = new Date().toISOString()
  save('pages', pages)
}

function getDocsHistoryBucket(pageId) {
  const id = String(pageId || '')
  if (!id) return null
  if (!docsHistoryByPageId[id]) docsHistoryByPageId[id] = { undo: [], redo: [] }
  return docsHistoryByPageId[id]
}

function snapshotDocsPageForUndo(reason) {
  const page = pages.find(x => x.id === currentPageId)
  if (!page) return
  const bucket = getDocsHistoryBucket(page.id)
  if (!bucket) return
  // Snapshot includes blocks + title to keep undo coherent
  const snap = {
    t: Date.now(),
    reason: String(reason || ''),
    pageId: page.id,
    title: page.title || '',
    blocks: JSON.parse(JSON.stringify(page.blocks || []))
  }
  bucket.undo.push(snap)
  if (bucket.undo.length > DOCS_HISTORY_LIMIT) bucket.undo.shift()
  bucket.redo = []
}

function restoreDocsSnapshot(snap) {
  if (!snap || !snap.pageId) return
  const page = pages.find(x => x.id === snap.pageId)
  if (!page) return
  page.title = snap.title || ''
  page.blocks = JSON.parse(JSON.stringify(snap.blocks || []))
  page.updated = new Date().toISOString()
  save('pages', pages)
  // keep title input in sync
  const titleInput = document.getElementById('pageTitleInput')
  if (titleInput) titleInput.value = page.title || ''
  renderPagesEditor()
}

function docsUndo() {
  const page = pages.find(x => x.id === currentPageId)
  if (!page) return
  const bucket = getDocsHistoryBucket(page.id)
  if (!bucket || !bucket.undo.length) return
  // push current state to redo
  bucket.redo.push({
    t: Date.now(),
    reason: 'redo_point',
    pageId: page.id,
    title: page.title || '',
    blocks: JSON.parse(JSON.stringify(page.blocks || []))
  })
  const snap = bucket.undo.pop()
  restoreDocsSnapshot(snap)
}

function docsRedo() {
  const page = pages.find(x => x.id === currentPageId)
  if (!page) return
  const bucket = getDocsHistoryBucket(page.id)
  if (!bucket || !bucket.redo.length) return
  // push current state back to undo
  bucket.undo.push({
    t: Date.now(),
    reason: 'undo_point',
    pageId: page.id,
    title: page.title || '',
    blocks: JSON.parse(JSON.stringify(page.blocks || []))
  })
  const snap = bucket.redo.pop()
  restoreDocsSnapshot(snap)
}

function renderBlocksForCurrentPage() {
  ensurePageInitialized()
  if (!currentPageId) currentPageId = pages[0]?.id || null

  const page = pages.find(x => x.id === currentPageId)
  if (!page) return

  const container = document.getElementById('blocksContainer')
  if (!container) return

  if (!Array.isArray(page.blocks)) page.blocks = []
  if (!page.blocks.length) page.blocks.push({ id: genId(), type: 'paragraph', text: '' })

  container.innerHTML = page.blocks.map((b, i) => {
    const bid = b.id || ''
    const linkBtn = bid
      ? `<button type="button" class="doc-link-btn" onclick="event.stopPropagation();copyDocBlockLink(${JSON.stringify(bid)})" title="Copy link to this block" aria-label="Copy link to this block">Link</button>`
      : ''
    if (b.type === 'divider') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="divider" onclick="setTimeout(()=>{},0)" style="position:relative;">
          ${linkBtn}
          <div class="block-divider"></div>
        </div>
      `
    }

    if (b.type === 'checklist') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="checklist" style="position:relative;">
          ${linkBtn}
          <div class="block-checklist">
            <input type="checkbox" ${b.checked ? 'checked' : ''} class="check-input" aria-label="Checklist item checkbox" />
            <div class="check-text block-text"
                 contenteditable="true"
                 data-block-index="${i}"
                 data-block-field="checkText"
                 data-placeholder="Checklist item">
              ${b.text || ''}
            </div>
          </div>
        </div>
      `
    }

    if (b.type === 'heading') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="heading" style="position:relative;">
          ${linkBtn}
          <div class="block-text block-heading"
               contenteditable="true"
               data-block-index="${i}"
               data-block-field="text"
               data-placeholder="Heading 1">
            ${b.text || ''}
          </div>
        </div>
      `
    }

    if (b.type === 'heading2') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="heading2" style="position:relative;">
          ${linkBtn}
          <div class="block-text block-h2"
               contenteditable="true"
               data-block-index="${i}"
               data-block-field="text"
               data-placeholder="Heading 2">
            ${b.text || ''}
          </div>
        </div>
      `
    }

    if (b.type === 'heading3') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="heading3" style="position:relative;">
          ${linkBtn}
          <div class="block-text block-h3"
               contenteditable="true"
               data-block-index="${i}"
               data-block-field="text"
               data-placeholder="Heading 3">
            ${b.text || ''}
          </div>
        </div>
      `
    }

    if (b.type === 'quote') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="quote" style="position:relative;">
          ${linkBtn}
          <div class="block-text block-quote"
               contenteditable="true"
               data-block-index="${i}"
               data-block-field="text"
               data-placeholder="Quoted text">
            ${b.text || ''}
          </div>
        </div>
      `
    }

    if (b.type === 'code') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="code" style="position:relative;">
          ${linkBtn}
          <pre class="block-code-wrap"
               contenteditable="true"
               data-block-index="${i}"
               data-block-field="text"
               data-placeholder="// Code or config">${b.text || ''}</pre>
        </div>
      `
    }

    if (b.type === 'callout') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="callout" style="position:relative;">
          ${linkBtn}
          <div class="block-callout">
            <span class="block-callout-icon" aria-hidden="true">💡</span>
            <div class="block-text block-callout-body"
                 contenteditable="true"
                 data-block-index="${i}"
                 data-block-field="text"
                 data-placeholder="Tip, warning, or note for readers">
              ${b.text || ''}
            </div>
          </div>
        </div>
      `
    }

    if (b.type === 'bulleted_list') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="bulleted_list" style="position:relative;">
          ${linkBtn}
          <ul class="block-list-ul block-text"
              contenteditable="true"
              data-block-index="${i}"
              data-block-field="text"
              data-placeholder="List">
            ${b.text || '<li></li>'}
          </ul>
        </div>
      `
    }

    if (b.type === 'numbered_list') {
      return `
        <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="numbered_list" style="position:relative;">
          ${linkBtn}
          <ol class="block-list-ol block-text"
              contenteditable="true"
              data-block-index="${i}"
              data-block-field="text"
              data-placeholder="List">
            ${b.text || '<li></li>'}
          </ol>
        </div>
      `
    }

    // paragraph default
    return `
      <div class="block-row" data-block-id="${escapeHtml(bid)}" data-block-index="${i}" data-block-type="paragraph" style="position:relative;">
        ${linkBtn}
        <div class="block-text"
             contenteditable="true"
             data-block-index="${i}"
             data-block-field="text"
             data-placeholder="Type something...">
          ${b.text || ''}
        </div>
      </div>
    `
  }).join('')

  syncPagesSidebarMeta()
  bindBlocksEditorHandlersIfNeeded()
}

function addBlockAt(index, type) {
  updateCurrentPageAndPersist(page => {
    if (!Array.isArray(page.blocks)) page.blocks = []
    const newBlock = newBlockOfType(type)
    const insertAt = Math.max(0, Math.min(index, page.blocks.length))
    page.blocks.splice(insertAt, 0, newBlock)
  }, { history: true, reason: 'add_block' })
}

function removeBlockAt(index) {
  updateCurrentPageAndPersist(page => {
    if (!Array.isArray(page.blocks)) return
    if (page.blocks.length <= 1) return // keep at least one block
    page.blocks.splice(index, 1)
  }, { history: true, reason: 'remove_block' })
}

function showBlockInsertMenu(afterIndex) {
  const menu = document.getElementById('blockInsertMenu')
  if (!menu) return
  blockInsertIndex = afterIndex
  menu.innerHTML = `
    <div class="bim-h">Structure</div>
    <button type="button" onclick="insertBlockFromMenu('paragraph')">Paragraph<span>Body text</span></button>
    <button type="button" onclick="insertBlockFromMenu('heading')">Heading 1<span>Page title section</span></button>
    <button type="button" onclick="insertBlockFromMenu('heading2')">Heading 2<span>Major sections</span></button>
    <button type="button" onclick="insertBlockFromMenu('heading3')">Heading 3<span>Subsections</span></button>
    <button type="button" onclick="insertBlockFromMenu('bulleted_list')">Bulleted list<span>Bullet points</span></button>
    <button type="button" onclick="insertBlockFromMenu('numbered_list')">Numbered list<span>Steps and sequences</span></button>
    <div class="bim-h">Blocks</div>
    <button type="button" onclick="insertBlockFromMenu('quote')">Quote<span>Callout quote</span></button>
    <button type="button" onclick="insertBlockFromMenu('callout')">Callout<span>Note or alert</span></button>
    <button type="button" onclick="insertBlockFromMenu('code')">Code<span>Snippet or CLI</span></button>
    <button type="button" onclick="insertBlockFromMenu('checklist')">Checklist<span>Task list</span></button>
    <button type="button" onclick="insertBlockFromMenu('divider')">Divider<span>Visual break</span></button>
  `
  menu.classList.remove('hidden')
  blockInsertMenuVisible = true
}

function hideBlockInsertMenu() {
  const menu = document.getElementById('blockInsertMenu')
  if (!menu) return
  menu.classList.add('hidden')
  blockInsertMenuVisible = false
  blockInsertIndex = null
}

function insertBlockFromMenu(type) {
  if (blockInsertIndex == null) return
  addBlockAt(blockInsertIndex, type)
  hideBlockInsertMenu()
  renderBlocksForCurrentPage()
  focusBlockIndex(blockInsertIndex)
}

function bindBlocksEditorHandlersIfNeeded() {
  if (blocksEditorHandlersBound) return
  blocksEditorHandlersBound = true

  const container = document.getElementById('blocksContainer')
  if (!container) return

  // Track which block is active so toolbar actions know where to apply
  container.addEventListener('focusin', e => {
    const target = e.target
    if (!target || !target.getAttribute) return
    const idxAttr = target.getAttribute('data-block-index')
    if (idxAttr == null) return
    const idx = Number(idxAttr)
    if (!Number.isNaN(idx)) {
      currentBlockIndex = idx
      // Snapshot once per edit-session (so typing doesn't spam history)
      try {
        const field = String(target.getAttribute('data-block-field') || '')
        const key = String(currentPageId || '') + '|' + String(idx) + '|' + field
        if (docsEditSessionKey !== key) {
          snapshotDocsPageForUndo('typing')
          docsEditSessionKey = key
        }
      } catch (e2) {}
    }
  })

  // Input updates
  container.addEventListener('input', e => {
    const target = e.target
    if (!target) return
    const idx = Number(target.getAttribute('data-block-index'))
    const field = target.getAttribute('data-block-field')
    if (Number.isNaN(idx) || !field) return

    const text = target.innerHTML || ''
    updateCurrentPageAndPersist(page => {
      const b = page.blocks[idx]
      if (!b) return
      if (field === 'text') b.text = text
      if (field === 'checkText') b.text = text
    })
    syncPagesSidebarMeta()
  })

  // Paste cleanup (default to plain text)
  container.addEventListener('paste', handleDocsPaste)

  // Key shortcuts
  container.addEventListener('keydown', e => {
    const t = e.target
    if (!t || !t.getAttribute) return
    const idx = Number(t.getAttribute('data-block-index'))
    const field = t.getAttribute('data-block-field')
    if (Number.isNaN(idx)) return

    // Undo/redo (docs only)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = String(e.key || '').toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        docsUndo()
        return
      }
      if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        docsRedo()
        return
      }
    }

    // Close menu
    if (e.key === 'Escape' && blockInsertMenuVisible) {
      e.preventDefault()
      hideBlockInsertMenu()
      return
    }

    // '/' inserts block menu
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const text = (t.innerText || '').replace(/\u00A0/g, ' ').trim()
      // Only trigger when user isn't in the middle of text
      if (!text) {
        e.preventDefault()
        showBlockInsertMenu(idx + 1)
      }
      return
    }

    // Wiki link quick insert: Ctrl+Shift+K
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
      const k2 = String(e.key || '').toLowerCase()
      if (k2 === 'k') {
        e.preventDefault()
        promptWikiLinkInsert()
        return
      }
    }

    if (e.key === 'Enter') {
      const row = t.closest && t.closest('.block-row')
      const bt = row && row.getAttribute('data-block-type')
      if (bt === 'code') return
      if (isListBlockType(bt)) {
        // Within list blocks, Enter creates a new list item
        e.preventDefault()
        const ok = insertNewListItemAtCursor(t)
        if (ok) return
        // Fallback: if selection isn't in <li>, add a paragraph block after
      }
      e.preventDefault()
      addBlockAt(idx + 1, 'paragraph')
      renderBlocksForCurrentPage()
      focusBlockIndex(idx + 1)
      hideBlockInsertMenu()
      return
    }

    // Backspace on empty removes the block
    if (e.key === 'Backspace') {
      const text = (t.innerText || '').replace(/\u00A0/g, ' ').trim()
      if (!text) {
        // Empty list block: remove / convert cleanly
        try {
          const row = t.closest && t.closest('.block-row')
          const bt = row && row.getAttribute('data-block-type')
          if (isListBlockType(bt)) {
            const page = pages.find(x => x.id === currentPageId)
            const b = page && page.blocks ? page.blocks[idx] : null
            const empty = isEmptyListHtml(b && b.text)
            if (empty && idx > 0) {
              e.preventDefault()
              removeBlockAt(idx)
              renderBlocksForCurrentPage()
              focusBlockIndex(Math.max(0, idx - 1))
              return
            }
          }
        } catch (e2) {}
        if (idx > 0) {
          e.preventDefault()
          removeBlockAt(idx)
          renderBlocksForCurrentPage()
          focusBlockIndex(Math.max(0, idx - 1))
        }
      }
    }
  })

  // Checklist checkbox toggles
  container.addEventListener('change', e => {
    const target = e.target
    if (!target || target.type !== 'checkbox') return
    const blockRow = target.closest('.block-row')
    if (!blockRow) return
    const idx = Number(blockRow.getAttribute('data-block-index'))
    if (Number.isNaN(idx)) return
    const checked = !!target.checked

    updateCurrentPageAndPersist(page => {
      const b = page.blocks[idx]
      if (!b || b.type !== 'checklist') return
      b.checked = checked
    })
  })

  // Click outside closes menu
  document.addEventListener('click', e => {
    if (!blockInsertMenuVisible) return
    const menu = document.getElementById('blockInsertMenu')
    if (!menu) return
    if (menu.contains(e.target)) return
    hideBlockInsertMenu()
  })
}

function applyInlineFormat(command) {
  try {
    document.execCommand(command, false, null)
  } catch (e) {
    // execCommand is best-effort; ignore if not supported
  }
}

function docsPromptLink() {
  try {
    const url = String(window.prompt('Link URL (https://...)', 'https://') || '').trim()
    if (!url) return
    document.execCommand('createLink', false, url)
  } catch (e) {}
}

function getClosest(el, sel) {
  try { return el && el.closest ? el.closest(sel) : null } catch (e) { return null }
}

function isListBlockType(bt) {
  return bt === 'bulleted_list' || bt === 'numbered_list'
}

function insertNewListItemAtCursor(containerEl) {
  const sel = window.getSelection && window.getSelection()
  if (!sel || !sel.rangeCount) return false
  const anchor = sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null
  const li = getClosest(anchor, 'li')
  if (!li) return false
  const parent = li.parentElement
  if (!parent || (parent.tagName !== 'UL' && parent.tagName !== 'OL')) return false
  const newLi = document.createElement('li')
  newLi.innerHTML = '<br>'
  if (li.nextSibling) parent.insertBefore(newLi, li.nextSibling)
  else parent.appendChild(newLi)
  try {
    const r = document.createRange()
    r.selectNodeContents(newLi)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  } catch (e) {}
  return true
}

function isEmptyListHtml(html) {
  const s = String(html || '').replace(/\u00A0/g, ' ').trim()
  if (!s) return true
  // strip tags and whitespace
  const text = s.replace(/<[^>]+>/g, '').trim()
  return !text
}

function normalizePlainTextToHtml(text) {
  const t = String(text || '')
  const esc = escapeHtml(t)
  return esc.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '<br>')
}

function handleDocsPaste(e) {
  const t = e.target
  if (!t) return
  const row = getClosest(t, '.block-row')
  if (!row) return
  const bt = row.getAttribute('data-block-type') || ''
  // Only handle paste in docs blocks
  if (!bt) return

  try {
    const cd = e.clipboardData
    if (!cd) return
    const plain = cd.getData('text/plain') || ''
    if (plain == null) return
    e.preventDefault()
    if (bt === 'code') {
      // code blocks: pure text
      document.execCommand('insertText', false, plain)
      return
    }
    // default: insert sanitized plain text as HTML line breaks
    const html = normalizePlainTextToHtml(plain)
    document.execCommand('insertHTML', false, html)
  } catch (e2) {}
}

function promptWikiLinkInsert() {
  ensurePageInitialized()
  const query = String(window.prompt('Link to page (type a page title)', '') || '').trim()
  if (!query) return
  const existing = pages.find(p => String(p.title || '').toLowerCase() === query.toLowerCase())
  const targetPage = existing || null
  let pid = targetPage ? targetPage.id : null
  let title = targetPage ? (targetPage.title || query) : query
  if (!pid) {
    // create the page
    const nowIso = new Date().toISOString()
    const newPage = { id: genId(), title: title, created: nowIso, updated: nowIso, blocks: [{ id: genId(), type: 'paragraph', text: '' }] }
    pages.unshift(newPage)
    save('pages', pages)
    pid = newPage.id
  }
  try {
    const html = `<a href=\"#\" class=\"wiki-link\" data-wiki-page-id=\"${escapeHtml(pid)}\" onclick=\"openPage('${escapeHtml(pid)}');return false;\">${escapeHtml(title)}</a>`
    document.execCommand('insertHTML', false, html)
    buildDocsLinkIndex()
    syncPagesSidebarMeta()
  } catch (e) {}
}

function setBlockTypeFromToolbar(type) {
  if (currentBlockIndex == null) return
  updateCurrentPageAndPersist(page => {
    if (!Array.isArray(page.blocks)) return
    const b = page.blocks[currentBlockIndex]
    if (!b) return
    b.type = type
  }, { history: true, reason: 'change_block_type' })
  renderBlocksForCurrentPage()
  focusBlockIndex(currentBlockIndex)
}

function insertBlockFromToolbar(type) {
  const idx = currentBlockIndex == null ? 0 : currentBlockIndex + 1
  addBlockAt(idx, type)
  renderBlocksForCurrentPage()
  focusBlockIndex(idx)
}

function renderPagesEditor() {
  ensurePageInitialized()
  if (!currentPageId) currentPageId = pages[0]?.id || null

  renderPagesList()

  const page = pages.find(x => x.id === currentPageId)
  if (!page) return

  // Apply editor zoom (Word-like page scale)
  try {
    const shell = document.querySelector('.docs-shell')
    if (shell) shell.style.setProperty('--docs-zoom', String(docsZoom || 1))
  } catch (e) {}

  const titleInput = document.getElementById('pageTitleInput')
  if (titleInput) {
    titleInput.value = page.title || ''
    titleInput.oninput = () => {
      updateCurrentPageAndPersist(p => { p.title = titleInput.value })
      const bt = document.getElementById('pagesBreadcrumbTitle')
      if (bt) bt.textContent = titleInput.value || 'Untitled'
      renderPagesList()
    }
  }

  renderBlocksForCurrentPage()

  // If URL hash points to a block in this doc, scroll to it.
  try {
    const h = String(window.location.hash || '')
    if (h.startsWith('#doc=')) {
      const params = new URLSearchParams(h.slice(1))
      const docId = params.get('doc') || ''
      const blockId = params.get('block') || ''
      if (docId && docId === currentPageId && blockId) {
        setTimeout(function () {
          const row = document.querySelector(`.block-row[data-block-id="${CSS.escape(blockId)}"]`)
          if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 0)
      }
    }
  } catch (e) {}
}

function copyDocBlockLink(blockId) {
  if (!currentPageId || !blockId) return
  const qs = new URLSearchParams({ doc: currentPageId, block: blockId })
  const url = window.location.origin + window.location.pathname + '#' + qs.toString()
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { showToast('Link copied', 'success') }).catch(function () { window.prompt('Copy link:', url) })
    } else {
      window.prompt('Copy link:', url)
    }
  } catch (e) {
    window.prompt('Copy link:', url)
  }
}

function setDocsZoom(z) {
  const v = Number(z)
  if (!v || v < 0.75 || v > 1.6) return
  docsZoom = v
  try {
    const shell = document.querySelector('.docs-shell')
    if (shell) shell.style.setProperty('--docs-zoom', String(docsZoom))
  } catch (e) {}
}

function getDocTemplates() {
  return [
    {
      id: 'spec',
      title: 'Product spec',
      desc: 'Problem → goals → scope → milestones. Great for serious ops (monday-style).',
      blocks: [
        { type: 'heading', text: 'Product spec' },
        { type: 'paragraph', text: 'Owner: <strong>' + escapeHtml(currentUser?.fullName || currentUser?.username || '—') + '</strong><br>Last updated: ' + escapeHtml(new Date().toLocaleDateString()) },
        { type: 'heading2', text: 'Problem' },
        { type: 'paragraph', text: '' },
        { type: 'heading2', text: 'Goals / success metrics' },
        { type: 'checklist', checked: false, text: 'Define measurable outcomes' },
        { type: 'checklist', checked: false, text: 'Define launch criteria' },
        { type: 'heading2', text: 'Scope' },
        { type: 'paragraph', text: '<strong>In:</strong><br><br><strong>Out:</strong>' },
        { type: 'heading2', text: 'Milestones' },
        { type: 'checklist', checked: false, text: 'Milestone 1' },
        { type: 'checklist', checked: false, text: 'Milestone 2' },
        { type: 'heading2', text: 'Risks / notes' },
        { type: 'callout', text: '' }
      ]
    },
    {
      id: 'meeting',
      title: 'Meeting notes',
      desc: 'Agenda, notes, decisions, action items (Notion wiki vibe).',
      blocks: [
        { type: 'heading', text: 'Meeting notes' },
        { type: 'paragraph', text: 'Date: <strong>' + escapeHtml(new Date().toLocaleDateString()) + '</strong><br>Attendees:' },
        { type: 'heading2', text: 'Agenda' },
        { type: 'checklist', checked: false, text: '' },
        { type: 'heading2', text: 'Notes' },
        { type: 'paragraph', text: '' },
        { type: 'heading2', text: 'Decisions' },
        { type: 'quote', text: '' },
        { type: 'heading2', text: 'Action items' },
        { type: 'checklist', checked: false, text: '' }
      ]
    },
    {
      id: 'sop',
      title: 'SOP / Runbook',
      desc: 'Step-by-step process with checks (operations system).',
      blocks: [
        { type: 'heading', text: 'SOP / Runbook' },
        { type: 'paragraph', text: 'Purpose:' },
        { type: 'heading2', text: 'When to use this' },
        { type: 'paragraph', text: '' },
        { type: 'heading2', text: 'Steps' },
        { type: 'checklist', checked: false, text: 'Step 1' },
        { type: 'checklist', checked: false, text: 'Step 2' },
        { type: 'checklist', checked: false, text: 'Step 3' },
        { type: 'heading2', text: 'Rollback / recovery' },
        { type: 'callout', text: '' },
        { type: 'heading2', text: 'Commands / snippets' },
        { type: 'code', text: '' }
      ]
    }
  ]
}

function openDocsTemplatesModal() {
  const modal = document.getElementById('docsTemplatesModal')
  const grid = document.getElementById('docsTemplatesGrid')
  if (!modal || !grid) return
  const templates = getDocTemplates()
  grid.innerHTML = templates.map(t => `
    <div class="template-card" role="button" tabindex="0"
         onclick="createNewPageFromTemplate('${escapeHtml(t.id)}')"
         onkeydown="if(event.key==='Enter'){createNewPageFromTemplate('${escapeHtml(t.id)}')}">
      <h4>${escapeHtml(t.title)}</h4>
      <p>${escapeHtml(t.desc)}</p>
    </div>
  `).join('')
  modal.classList.add('active')
  docsTemplatesBuilt = true
}

function closeDocsTemplatesModal() {
  const modal = document.getElementById('docsTemplatesModal')
  if (modal) modal.classList.remove('active')
}

function createNewPageFromTemplate(templateId) {
  ensurePageInitialized()
  const t = getDocTemplates().find(x => x.id === templateId)
  if (!t) return
  const nowIso = new Date().toISOString()
  const newPage = {
    id: genId(),
    title: t.title,
    created: nowIso,
    updated: nowIso,
    blocks: (t.blocks || []).map(b => Object.assign({ id: genId() }, b))
  }
  pages.unshift(newPage)
  save('pages', pages)
  currentPageId = newPage.id
  closeDocsTemplatesModal()
  renderPagesEditor()
  showToast('Template created', 'success')
}

function openIntakeModal() {
  if (!ensureCurrentUser()) {
    showToast('Please sign in to create a task', 'error')
    return
  }
  populateProjectSelect('intakeProject')
  fillAssigneeSelect(document.getElementById('intakeAssignee'), currentUser.id)
  const t = document.getElementById('intakeTitle')
  const d = document.getElementById('intakeDesc')
  const due = document.getElementById('intakeDue')
  const est = document.getElementById('intakeEstimate')
  const pr = document.getElementById('intakePriority')
  const st = document.getElementById('intakeStatus')
  if (t) t.value = ''
  if (d) d.value = ''
  if (due) due.value = ''
  if (est) est.value = ''
  if (pr) pr.value = 'medium'
  if (st) st.value = 'todo'
  document.getElementById('intakeModal')?.classList.add('active')
}

function closeIntakeModal() {
  document.getElementById('intakeModal')?.classList.remove('active')
}

function saveIntakeTask() {
  if (!ensureCurrentUser()) return
  const title = document.getElementById('intakeTitle')?.value?.trim() || ''
  if (!title) return showToast('Title is required', 'error')
  const desc = document.getElementById('intakeDesc')?.value?.trim() || ''
  const projId = document.getElementById('intakeProject')?.value || ''
  const assignee = document.getElementById('intakeAssignee')?.value || currentUser.id
  const priority = document.getElementById('intakePriority')?.value || 'medium'
  const status = document.getElementById('intakeStatus')?.value || 'todo'
  const dueDate = document.getElementById('intakeDue')?.value || ''
  const estimate = parseFloat(document.getElementById('intakeEstimate')?.value) || 0

  const nowIso = new Date().toISOString()
  const task = {
    id: genId(),
    title,
    description: desc,
    projectId: projId,
    priority,
    status,
    dueDate: dueDate || null,
    assignee,
    estimatedHours: estimate,
    created: nowIso
  }
  tasks.push(task)
  save('tasks', tasks)
  renderTasks()
  renderDashboardCharts()
  updateStats()
  addActivity(`Intake created task: ${title}`)
  addNotification(`Task "${title}" created from intake`, 'task')
  addAuditLog('create', `Created task "${title}" from intake`, 'create', { projectId: projId || null, taskId: task.id })
  closeIntakeModal()
  showToast('Task created from intake', 'success')
}

/* ===================================================
   BILLING
=================================================== */
function renderBilling() {
  if (!currentUser) {
    try { showToast('Sign in to view billing details', 'info') } catch (e) {}
    return
  }
  let currentPlan = currentUser.plan ? currentUser.plan : 'free'
  let planInfo    = PLANS.find(p => p.id === currentPlan)

  // Top summary card values
  let billingPlanNameEl = document.getElementById('billingPlanName')
  if (billingPlanNameEl) billingPlanNameEl.textContent = planInfo?.name || 'Free'

  let billingAmountEl = document.getElementById('billingAmount')
  if (billingAmountEl) {
    if (!planInfo || planInfo.price === 0) {
      billingAmountEl.textContent = '$0 / month'
    } else {
      billingAmountEl.textContent = `$${planInfo.price} / month`
    }
  }

  let billingPaymentEl = document.getElementById('billingPayment')
  if (billingPaymentEl) billingPaymentEl.textContent = currentPlan === 'free' ? 'None required' : '**** **** **** 4242 (Visa)'

  let billingNextEl = document.getElementById('billingNextDate')
  if (billingNextEl) {
    if (currentPlan === 'free') {
      billingNextEl.textContent = '—'
    } else {
      let next = new Date()
      next.setMonth(next.getMonth() + 1)
      billingNextEl.textContent = next.toLocaleDateString()
    }
  }

  let plansEl = document.getElementById('billingPlans')
  if (plansEl) {
    const isYearly = billingPeriod === 'yearly'

    plansEl.innerHTML =
  `<div class="billing-plans-toggle-row" style="grid-column: 1 / -1;">
    <div class="billing-period-toggle">
          <button class="${!isYearly ? 'active' : ''}" onclick="setBillingPeriod('monthly')">
            Monthly
          </button>
          <button class="${isYearly ? 'active' : ''}" onclick="setBillingPeriod('yearly')">
            Yearly <span>save ~20%</span>
          </button>
        </div>
      </div>` +
      PLANS.map(plan => {
        const price      = isYearly && plan.priceYearly != null ? plan.priceYearly : plan.price
        const priceLabel = isYearly && plan.priceYearly != null ? (plan.priceLabelYearly || plan.priceLabel) : plan.priceLabel
        const isCurrent  = plan.id === currentPlan

        return `
          <div class="plan-card ${plan.popular ? 'popular' : ''}">
            ${plan.popular ? '<div class="plan-popular-badge">Popular</div>' : ''}
            ${isCurrent ? '<div class="plan-current-badge">✓ Current Plan</div>' : ''}
            <div class="plan-name">${plan.name}</div>
            <div class="plan-desc">${plan.desc}</div>
            <div class="plan-price">
              $${price}<span> /month</span>
            </div>
            <div class="plan-price-label">${priceLabel}</div>
            <ul class="plan-features">
              ${plan.features.map(f => `
                <li>
                  <span class="${f.ok ? 'check' : 'cross'}">${f.ok ? '✓' : '✗'}</span>${f.text}
                </li>
              `).join('')}
            </ul>
            ${!isCurrent
              ? `<button onclick="upgradePlan('${plan.id}')" class="${plan.popular ? '' : 'btn-secondary'}" style="width:100%">
                   ${plan.price > 0 ? `Upgrade to ${plan.name}` : 'Downgrade'}
                 </button>`
              : `<button disabled style="width:100%;opacity:0.5;">Current Plan</button>`}
          </div>
        `
      }).join('')
  }

  let invoiceEl = document.getElementById('invoiceList')
  if (invoiceEl) {
    if (!invoices.length) {
      invoiceEl.innerHTML = `<tr><td colspan="5"><div class="empty-state compact"><div class="empty-state-icon">📄</div><h3>No invoices yet</h3><p>Invoices will appear here after you upgrade to a paid plan</p></div></td></tr>`
    } else {
      invoiceEl.innerHTML = invoices.map(inv => `
        <tr>
          <td>${inv.id}</td>
          <td>${inv.date}</td>
          <td>${inv.amount}</td>
          <td><span class="invoice-status ${inv.status}">${inv.status}</span></td>
          <td><button class="btn-xs btn-secondary" onclick="showToast('PDF download coming soon','info')">⬇ PDF</button></td>
        </tr>
      `).join('')
    }
  }
}
function setBillingPeriod(period) {
  billingPeriod = period
  renderBilling()
}
function upgradePlan(planId) {
  let plan = PLANS.find(p => p.id === planId)
  if (!plan) return
  if (ALTER_API_BASE && getAuthToken()) {
    fetch(ALTER_API_BASE + '/api/me/plan', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAuthToken()
      },
      body: JSON.stringify({ plan: planId, billingPeriod })
    })
    .then(r => r.json().then(body => ({ ok: r.ok, body })))
    .then(res => {
      if (!res.ok) return showToast(res.body.error || 'Failed to update plan', 'error')
      currentUser.plan = planId
      save('session', currentUser)
      var badge = document.getElementById('sidebarPlanBadge')
      if (badge) badge.textContent = planId.toUpperCase()
      renderBilling()
      addAuditLog('update', `Upgraded plan to ${plan.name}`, 'update')
      showToast(`Plan updated to ${plan.name}!`, 'success')
    })
    .catch(() => showToast('Network error while updating plan', 'error'))
    return
  }

  if (plan.price > 0) {
    showToast('Redirecting to payment... (demo mode)', 'info')
    setTimeout(() => {
      currentUser.plan = planId
      let idx = users.findIndex(u => u.id === currentUser.id)
      if (idx >= 0) { users[idx] = currentUser; save('users', users); save('session', currentUser) }
      var badge2 = document.getElementById('sidebarPlanBadge')
      if (badge2) badge2.textContent = planId.toUpperCase()
      renderBilling()
      addAuditLog('update', `Upgraded plan to ${plan.name}`, 'update')
      showToast(`🎉 Upgraded to ${plan.name}!`, 'success')
    }, 1000)
  } else {
    currentUser.plan = planId
    let idx = users.findIndex(u => u.id === currentUser.id)
    if (idx >= 0) { users[idx] = currentUser; save('users', users); save('session', currentUser) }
    var badge3 = document.getElementById('sidebarPlanBadge')
    if (badge3) badge3.textContent = planId.toUpperCase()
    renderBilling()
    showToast(`Downgraded to ${plan.name}`, 'info')
  }
}

/* ===================================================
   CHARTS
=================================================== */
function destroyChart(id) {
  // Ensure charts store exists
  if (!charts || typeof charts !== 'object') {
    charts = {}
    return
  }
  if (charts[id]) {
    try { charts[id].destroy() } catch (e) {}
    delete charts[id]
  }
}

function makeChart(id, config) {
  // Gracefully skip if Chart.js failed to load
  if (typeof Chart === 'undefined') {
    return
  }

  let el = document.getElementById(id)
  if (!el) return

  destroyChart(id)

  config = config || {}
  config.type = config.type || 'bar'
  config.data = config.data || { labels: [], datasets: [] }

  config.options = config.options || {}
  config.options.maintainAspectRatio = false
  config.options.responsive          = true
  config.options.animation           = config.options.animation || { duration: 400 }

  if (!config.options.plugins) config.options.plugins = {}
  config.options.plugins.legend = config.options.plugins.legend || {
    labels: { color:'#9CA3AF', font:{ size:11 } }
  }

  if (!['doughnut','pie','radar','polarArea'].includes(config.type)) {
    config.options.scales = config.options.scales || {
      x: { ticks:{ color:'#6B7280', font:{ size:11 } }, grid:{ color:'#1F2937' } },
      y: { ticks:{ color:'#6B7280', font:{ size:11 } }, grid:{ color:'#1F2937' } }
    }
  }

  try {
    charts[id] = new Chart(el, config)
  } catch (e) {
    // Avoid breaking the rest of the app if a chart config is invalid
    logAppError({ type: 'chart', id, message: String(e && e.message || e), stack: e && e.stack })
  }
}

function cloneChartConfigForZoom(chartId) {
  if (typeof Chart === 'undefined') return null
  var el = document.getElementById(chartId)
  if (!el) return null
  var ch = Chart.getChart(el)
  if (!ch) return null
  try {
    return {
      type: ch.config.type,
      data: JSON.parse(JSON.stringify(ch.data)),
      options: JSON.parse(JSON.stringify(ch.options))
    }
  } catch (e) {
    return null
  }
}

function bumpChartConfigForZoomView(cfg) {
  if (!cfg || !cfg.options) return cfg
  var o = cfg.options
  o.plugins = o.plugins || {}
  o.plugins.legend = o.plugins.legend || {}
  o.plugins.legend.labels = o.plugins.legend.labels || {}
  o.plugins.legend.labels.font = o.plugins.legend.labels.font || {}
  var fs = o.plugins.legend.labels.font.size || 11
  o.plugins.legend.labels.font.size = Math.round(fs * 1.2)
  if (o.scales && typeof o.scales === 'object') {
    ;['x', 'y', 'y1', 'r'].forEach(function (k) {
      var sc = o.scales[k]
      if (!sc || !sc.ticks) return
      sc.ticks = sc.ticks || {}
      sc.ticks.font = sc.ticks.font || {}
      var ts = sc.ticks.font.size || 11
      sc.ticks.font.size = Math.round(ts * 1.15)
    })
  }
  return cfg
}

function openChartZoomModal(chartId, title) {
  if (typeof Chart === 'undefined') return
  var cfg = cloneChartConfigForZoom(chartId)
  if (!cfg) {
    showToast('Chart is not ready yet', 'warning')
    return
  }
  cfg = bumpChartConfigForZoomView(cfg)
  var modal = document.getElementById('chartZoomModal')
  var titleEl = document.getElementById('chartZoomTitle')
  if (titleEl) titleEl.textContent = title || 'Chart'
  destroyChart('chartZoomCanvas')
  if (modal) modal.classList.add('active')
  try {
    document.body.style.overflow = 'hidden'
  } catch (e) {}
  setTimeout(function () {
    makeChart('chartZoomCanvas', cfg)
  }, 10)
}

function closeChartZoomModal() {
  var modal = document.getElementById('chartZoomModal')
  if (modal) modal.classList.remove('active')
  destroyChart('chartZoomCanvas')
  try {
    document.body.style.overflow = ''
  } catch (e) {}
}

function setupChartZoom() {
  if (window.__alcoChartZoomBound) return
  window.__alcoChartZoomBound = true
  document.addEventListener('click', function (e) {
    var container = e.target.closest('.chart-container.chart-zoomable')
    if (!container) return
    var canvas = container.querySelector('canvas')
    if (!canvas || !canvas.id || canvas.id === 'chartZoomCanvas') return
    e.preventDefault()
    e.stopPropagation()
    var card = container.closest('.card')
    var h3 = card && card.querySelector('h3')
    var t = (h3 && h3.textContent) ? h3.textContent.trim() : 'Chart'
    openChartZoomModal(canvas.id, t)
  })
}

function renderDashboardCharts() {
  if (typeof Chart === 'undefined') {
    ['projectsChart','tasksChart','completionChart','activityChart'].forEach(function (id) {
      var el = document.getElementById(id)
      if (!el) return
      var parent = el.closest('.chart-container') || el.parentElement
      if (!parent) return
      parent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:#9CA3AF;text-align:center;padding:12px;">Charts are unavailable. Check your internet connection and reload.</div>'
    })
    return
  }

  makeChart('projectsChart', {
    type: 'bar',
    data: {
      labels: ['Critical','High','Medium','Low'],
      datasets: [{
        label: 'Projects',
        data: ['critical','high','medium','low'].map(p => projects.filter(x => x.priority === p).length),
        backgroundColor: ['rgba(239,68,68,0.8)','rgba(249,115,22,0.8)','rgba(245,158,11,0.8)','rgba(34,197,94,0.8)'],
        borderRadius: 6
      }]
    }
  })

  makeChart('tasksChart', {
    type: 'doughnut',
    data: {
      labels: ['To Do','In Progress','Review','Done'],
      datasets: [{
        data: ['todo','in-progress','review','done'].map(s => tasks.filter(t => t.status === s).length),
        backgroundColor: ['#6B7280','#f59e0b','#06b6d4','#22c55e'],
        borderWidth: 2,
        borderColor: '#111827'
      }]
    }
  })

  let donePct = tasks.length > 0 ? Math.round((tasks.filter(t=>t.status==='done').length / tasks.length) * 100) : 0
  makeChart('completionChart', {
    type: 'line',
    data: {
      labels: ['4 wks ago','3 wks ago','2 wks ago','Last week','This week'],
      datasets: [{
        label: 'Completion %',
        data: [10, 25, 45, Math.max(0, donePct - 15), donePct],
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.08)',
        tension: 0.4, fill: true, pointRadius: 4, pointBackgroundColor: '#22c55e'
      }]
    }
  })

  makeChart('activityChart', {
    type: 'bar',
    data: {
      labels: ['Projects','Tasks','Ideas','Events','Time Entries'],
      datasets: [{
        label: 'Count',
        data: [projects.length, tasks.length, ideas.length, events.length, timeEntries.length],
        backgroundColor: 'rgba(79,70,229,0.7)',
        borderRadius: 6
      }]
    }
  })
}

function populateGoalSelect(selectId, selectedId) {
  const sel = document.getElementById(selectId)
  if (!sel) return
  const want = selectedId || ''
  sel.innerHTML = '<option value="">None</option>' + goals.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.title || 'Goal')}</option>`).join('')
  sel.value = [...sel.options].some(o => o.value === want) ? want : ''
  sel.onchange = function () {
    populateGoalKrSelect(sel.value || '', selectId === 'modalTaskGoal' ? 'modalTaskGoalKR' : 'taskDetailGoalKR', '')
  }
}

function populateGoalKrSelect(goalId, selectId, selectedKrId) {
  const sel = document.getElementById(selectId)
  if (!sel) return
  const g = goals.find(x => x.id === goalId) || null
  const krs = g && Array.isArray(g.keyResults) ? g.keyResults : []
  sel.innerHTML = '<option value="">None</option>' + krs.map(kr => {
    const id = (typeof kr === 'string') ? '' : (kr.id || '')
    const title = (typeof kr === 'string') ? kr : (kr.title || '')
    return `<option value="${escapeHtml(id)}">${escapeHtml(title || 'Key result')}</option>`
  }).join('')
  const want = selectedKrId || ''
  sel.value = [...sel.options].some(o => o.value === want) ? want : ''
}

function nthWeekdayOfMonth(year, monthIndex, weekday0, nth) {
  // weekday0: 0=Sun..6=Sat, nth: 1..5 (5 means "last" if overflow handled by caller)
  const first = new Date(year, monthIndex, 1)
  const firstW = first.getDay()
  const delta = (weekday0 - firstW + 7) % 7
  const day = 1 + delta + (Math.max(1, nth) - 1) * 7
  return new Date(year, monthIndex, day)
}

function bumpIfWeekend(dateObj) {
  const d = new Date(dateObj.getTime())
  const wd = d.getDay()
  if (wd === 6) d.setDate(d.getDate() + 2) // Sat -> Mon
  if (wd === 0) d.setDate(d.getDate() + 1) // Sun -> Mon
  return d
}

function getNextRecurringDueDate(prevDue, freqOrRule) {
  const rule = (freqOrRule && typeof freqOrRule === 'object') ? freqOrRule : { freq: String(freqOrRule || '') }
  const freq = String(rule.freq || '')
  const interval = Math.max(1, Number(rule.interval || 1) || 1)
  const base = prevDue ? new Date(prevDue) : new Date()
  if (isNaN(base.getTime())) return null
  const d = new Date(base.getTime())
  if (freq === 'daily') d.setDate(d.getDate() + interval)
  else if (freq === 'weekly') d.setDate(d.getDate() + (7 * interval))
  else if (freq === 'monthly') {
    // Monthly special mode: Nth weekday
    if (rule.monthlyMode === 'nth_weekday' && rule.byweekday != null && rule.bysetpos != null) {
      const nextMonth = new Date(d.getTime())
      nextMonth.setMonth(nextMonth.getMonth() + interval)
      const y = nextMonth.getFullYear()
      const m = nextMonth.getMonth()
      const weekday0 = Math.max(0, Math.min(6, Number(rule.byweekday)))
      const nth = Math.max(1, Math.min(5, Number(rule.bysetpos)))
      const cand = nthWeekdayOfMonth(y, m, weekday0, nth)
      d.setTime(cand.getTime())
    } else {
      d.setMonth(d.getMonth() + interval)
    }
  }
  else return null
  const adjusted = rule.skipWeekends ? bumpIfWeekend(d) : d
  return toLocalDateTimeInputValue(adjusted)
}

function maybeCreateNextRecurringTask(task) {
  if (!task || !task.recurrence || !task.recurrence.freq) return null
  if (task.recurrence.createNextOnDone === false) return null
  // End rules: after N occurrences or until date
  const occ = Number(task.recurrence._occurrenceCount || 0) || 0
  const endType = String(task.recurrence.endType || '')
  const endCount = Math.max(0, Number(task.recurrence.endCount || 0) || 0)
  const until = task.recurrence.until ? new Date(String(task.recurrence.until)) : null
  if (endType === 'count' && endCount && occ >= endCount) return null
  if (endType === 'until' && until && !isNaN(until.getTime())) {
    const cur = task.dueDate ? new Date(task.dueDate) : new Date()
    if (cur > until) return null
  }

  const nextDue = getNextRecurringDueDate(task.dueDate, task.recurrence)
  const nowIso = new Date().toISOString()
  const next = {
    id: genId(),
    title: task.title,
    description: task.description || '',
    projectId: task.projectId || '',
    priority: task.priority || 'medium',
    status: 'todo',
    dueDate: nextDue || null,
    assignee: task.assignee || (currentUser ? currentUser.id : ''),
    estimatedHours: task.estimatedHours || 0,
    recurrence: { ...task.recurrence, _occurrenceCount: occ + 1 },
    goalId: task.goalId || null,
    goalKrId: task.goalKrId || null,
    created: nowIso
  }
  tasks.push(next)
  save('tasks', tasks)
  addAuditLog('create', `Created next recurring task "${next.title}"`, 'create', { projectId: next.projectId || null, taskId: next.id })
  addNotification(`Next recurring task created: "${next.title}"`, 'task')
  return next
}

function autoProgressGoalKRFromLinkedTasks(goalId, krId) {
  if (!goalId || !krId) return
  const g = goals.find(x => x.id === goalId)
  if (!g) return
  normalizeGoalInPlace(g)
  const kr = (g.keyResults || []).find(k => k && typeof k === 'object' && k.id === krId)
  if (!kr) return
  const linked = tasks.filter(t => t.goalId === goalId && t.goalKrId === krId)
  if (!linked.length) return
  const done = linked.filter(t => t.status === 'done').length
  const pct = Math.round((done / linked.length) * 100)
  kr.progress = pct
  kr.done = pct >= 100
  g.updated = new Date().toISOString()
  save('goals', goals)
}

function runTaskStatusAutomations(task, oldStatus, newStatus, source) {
  if (!task) return
  // Core rule: when moved to done
  if (newStatus === 'done' && oldStatus !== 'done') {
    // Notify project owner (if any)
    const proj = task.projectId ? projects.find(p => p.id === task.projectId) : null
    if (proj && proj.owner && currentUser && proj.owner !== currentUser.id) {
      addNotification(`Task done: "${task.title}"`, 'task', { linkType: 'task', linkId: task.id })
    }
    // Create next recurring task if configured
    maybeCreateNextRecurringTask(task)
    // Auto-progress linked OKR KR if configured
    if (!userSettings || userSettings.autoProgressKRs !== false) {
      autoProgressGoalKRFromLinkedTasks(task.goalId, task.goalKrId)
    }
  }

  // Custom automations (user-defined rules)
  try { runCustomAutomations({ type: 'task_status_changed', task, oldStatus, newStatus, source }) } catch (e) {}
}

function loadAutomations() {
  try {
    const raw = localStorage.getItem('automations')
    if (!raw) return []
    const j = JSON.parse(raw)
    return Array.isArray(j) ? j : []
  } catch (e) {
    return []
  }
}

function saveAutomations(list) {
  try { localStorage.setItem('automations', JSON.stringify(Array.isArray(list) ? list : [])) } catch (e) {}
}

function normalizeAutomationRule(r) {
  if (!r || typeof r !== 'object') return null
  return {
    id: r.id || genId(),
    trigger: String(r.trigger || 'task_status_changed'),
    projectId: r.projectId ? String(r.projectId) : '',
    fromStatus: r.fromStatus ? String(r.fromStatus) : '',
    toStatus: r.toStatus ? String(r.toStatus) : '',
    action: String(r.action || 'notify'),
    value: String(r.value || '')
  }
}

function matchesAutomation(rule, ctx) {
  if (!rule || !ctx) return false
  if (rule.trigger !== ctx.type) return false
  if (rule.projectId && String(ctx.task?.projectId || '') !== rule.projectId) return false
  if (rule.fromStatus && String(ctx.oldStatus || '') !== rule.fromStatus) return false
  if (rule.toStatus && String(ctx.newStatus || '') !== rule.toStatus) return false
  return true
}

function runCustomAutomations(ctx) {
  const list = loadAutomations().map(normalizeAutomationRule).filter(Boolean)
  if (!list.length) return
  list.forEach(rule => {
    if (!matchesAutomation(rule, ctx)) return
    const t = ctx.task
    if (!t) return
    if (rule.action === 'notify') {
      addNotification(rule.value || `Automation fired for "${t.title}"`, 'info', { linkType: 'task', linkId: t.id })
      addAuditLog('update', `Automation: notify for "${t.title}"`, 'update', { projectId: t.projectId || null, taskId: t.id })
      return
    }
    if (rule.action === 'assign') {
      const uid = String(rule.value || '').trim()
      if (!uid) return
      t.assignee = uid
      t.updated = new Date().toISOString()
      save('tasks', tasks)
      addNotification(`Automation assigned: "${t.title}"`, 'task', { linkType: 'task', linkId: t.id })
      addAuditLog('update', `Automation assigned task "${t.title}"`, 'update', { projectId: t.projectId || null, taskId: t.id })
      renderTasks()
      return
    }
    if (rule.action === 'set_priority') {
      const pr = String(rule.value || '').trim()
      if (!pr) return
      t.priority = pr
      t.updated = new Date().toISOString()
      save('tasks', tasks)
      addAuditLog('update', `Automation set priority "${pr}" for "${t.title}"`, 'update', { projectId: t.projectId || null, taskId: t.id })
      renderTasks()
      return
    }
    if (rule.action === 'create_task') {
      const title = String(rule.value || '').trim() || (`Follow-up: ${t.title}`)
      const nowIso = new Date().toISOString()
      const nt = {
        id: genId(),
        title,
        description: '',
        projectId: t.projectId || '',
        priority: t.priority || 'medium',
        status: 'todo',
        dueDate: null,
        assignee: t.assignee || (currentUser ? currentUser.id : ''),
        estimatedHours: 0,
        recurrence: null,
        goalId: t.goalId || null,
        goalKrId: t.goalKrId || null,
        created: nowIso
      }
      tasks.push(nt)
      save('tasks', tasks)
      addAuditLog('create', `Automation created follow-up task "${title}"`, 'create', { projectId: nt.projectId || null, taskId: nt.id })
      addNotification(`Automation created task: "${title}"`, 'task', { linkType: 'task', linkId: nt.id })
      renderTasks()
      updateStats()
      renderDashboardCharts()
      return
    }
  })
}

function openAutomationsModal() {
  const modal = document.getElementById('automationsModal')
  if (!modal) return
  // Populate projects
  const sel = document.getElementById('autoProject')
  if (sel) {
    sel.innerHTML = '<option value=\"\">Any project</option>' + projects.map(p => `<option value=\"${escapeHtml(p.id)}\">${escapeHtml(p.name)}</option>`).join('')
  }
  renderAutomationsList()
  modal.classList.add('active')
}

function closeAutomationsModal() {
  const modal = document.getElementById('automationsModal')
  if (modal) modal.classList.remove('active')
}

function renderAutomationsList() {
  const el = document.getElementById('automationsList')
  if (!el) return
  const list = loadAutomations().map(normalizeAutomationRule).filter(Boolean)
  if (!list.length) {
    el.innerHTML = '<div class=\"empty-state compact\"><div class=\"empty-state-icon\">⚡</div><h3>No automations</h3><p>Create a rule below to automate your workflow.</p></div>'
    return
  }
  el.innerHTML = list.map(r => {
    const proj = r.projectId ? (projects.find(p => p.id === r.projectId)?.name || 'Project') : 'Any project'
    const when = r.trigger === 'task_created' ? 'When task is created' : 'When task status changes'
    const cond = (r.fromStatus || r.toStatus) ? ` (${r.fromStatus || 'any'} → ${r.toStatus || 'any'})` : ''
    const act = r.action.replace('_', ' ')
    const val = r.value ? `: ${escapeHtml(r.value)}` : ''
    return `<div style=\"border:1px solid #1F2937;background:rgba(2,6,23,0.6);border-radius:12px;padding:12px;display:flex;gap:10px;align-items:flex-start;\">
      <div style=\"flex:1;min-width:0;\">
        <div style=\"font-weight:700;color:#E5E7EB;\">${escapeHtml(when)}${escapeHtml(cond)}</div>
        <div style=\"font-size:12px;color:#9CA3AF;margin-top:4px;\">Project: ${escapeHtml(proj)} · Action: <strong>${escapeHtml(act)}</strong>${val}</div>
      </div>
      <button type=\"button\" class=\"btn-xs btn-danger\" onclick=\"deleteAutomationRule('${escapeHtml(r.id)}')\">Delete</button>
    </div>`
  }).join('')
}

function addAutomationFromModal() {
  const trigger = document.getElementById('autoTrigger')?.value || 'task_status_changed'
  const projectId = document.getElementById('autoProject')?.value || ''
  const fromStatus = document.getElementById('autoFrom')?.value || ''
  const toStatus = document.getElementById('autoTo')?.value || ''
  const action = document.getElementById('autoAction')?.value || 'notify'
  const value = document.getElementById('autoActionValue')?.value || ''
  const list = loadAutomations().map(normalizeAutomationRule).filter(Boolean)
  list.unshift(normalizeAutomationRule({ id: genId(), trigger, projectId, fromStatus, toStatus, action, value }))
  saveAutomations(list)
  renderAutomationsList()
  showToast('Automation added', 'success')
}

function deleteAutomationRule(id) {
  const list = loadAutomations().map(normalizeAutomationRule).filter(Boolean).filter(r => r.id !== id)
  saveAutomations(list)
  renderAutomationsList()
  showToast('Automation removed', 'info')
}

function renderDashboardWorkload() {
  const el = document.getElementById('dashboardWorkload')
  if (!el) return
  const active = tasks.filter(t => t.status !== 'done')
  const now = new Date()
  const overdue = active.filter(t => t.dueDate && new Date(t.dueDate) < now)
  const overdueHigh = overdue.filter(t => (t.priority || 'medium') === 'high')

  // Capacity (simple weekly capacity per person; default 40h)
  const capacity = (userSettings && userSettings.capacityByUserId) ? userSettings.capacityByUserId : {}
  function getCapHours(uid) {
    const v = capacity && capacity[uid]
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 40
  }

  const byAssignee = {}
  active.forEach(t => {
    const id = t.assignee || 'unassigned'
    byAssignee[id] = (byAssignee[id] || 0) + 1
  })
  const assigneeRows = Object.keys(byAssignee).sort((a, b) => byAssignee[b] - byAssignee[a]).slice(0, 6).map(id => {
    const label =
      id === 'unassigned' ? 'Unassigned' :
      (currentUser && id === currentUser.id ? 'You' : ((team.find(m => m.id === id)?.email || id).split('@')[0]))
    // Utilization proxy: sum of estimates for active tasks
    const est = active.filter(t => (t.assignee || 'unassigned') === id).reduce((s, t) => s + (t.estimatedHours || 0), 0)
    const capH = (id === 'unassigned') ? null : getCapHours(id)
    const util = (capH && est) ? Math.round((est / capH) * 100) : null
    const utilColor = util != null && util > 110 ? '#ef4444' : util != null && util > 85 ? '#f59e0b' : '#22c55e'
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #1F2937;">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(label)}</span>
      <span style="flex-shrink:0;color:#9CA3AF;">${byAssignee[id]} task${byAssignee[id]===1?'':'s'}${util != null ? ` · <span style="color:${utilColor};font-weight:700;">${util}%</span>` : ''}</span>
    </div>`
  }).join('')

  // Burndown (simple): per-project done vs remaining counts
  const burndownRows = projects.slice(0, 6).map(p => {
    const projTasks = tasks.filter(t => t.projectId === p.id)
    const done = projTasks.filter(t => t.status === 'done').length
    const rem = projTasks.length - done
    const pct = projTasks.length ? Math.round((done / projTasks.length) * 100) : 0
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #1F2937;">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.name)}</span>
      <span style="flex-shrink:0;color:#9CA3AF;">${pct}% · ${done} done / ${rem} left</span>
    </div>`
  }).join('')

  const projRows = projects.slice(0, 8).map(p => {
    const projTasks = tasks.filter(t => t.projectId === p.id)
    const est = projTasks.reduce((s, t) => s + (t.estimatedHours || 0), 0)
    const secs = timeEntries.filter(e => e.projectId === p.id).reduce((s, e) => s + (e.duration || 0), 0)
    const hrs = secs / 3600
    const drift = est > 0 ? Math.round((hrs / est) * 100) : null
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1F2937;">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.name)}</span>
      <span style="flex-shrink:0;color:#9CA3AF;">${est > 0 ? `${hrs.toFixed(1)}h / ${est.toFixed(1)}h (${drift}%)` : `${hrs.toFixed(1)}h logged`}</span>
    </div>`
  }).join('')

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div>
        <div style="font-size:11px;color:#6B7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em;">Workload & capacity</div>
        ${assigneeRows || '<div style="color:#6B7280;">No active tasks.</div>'}
        <div style="margin-top:12px;font-size:11px;color:#6B7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em;">Burndown (projects)</div>
        ${burndownRows || '<div style="color:#6B7280;">No projects.</div>'}
      </div>
      <div>
        <div style="font-size:11px;color:#6B7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em;">Overdue</div>
        <div style="font-size:28px;font-weight:800;color:${overdue.length ? '#ef4444' : '#22c55e'};margin-bottom:6px;">${overdue.length}</div>
        <div style="font-size:11px;color:#6B7280;margin-bottom:10px;">Tasks past due date</div>
        <div style="font-size:11px;color:#6B7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em;">At risk</div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1F2937;">
          <span>Overdue high priority</span><strong style="color:${overdueHigh.length ? '#ef4444' : '#9CA3AF'};">${overdueHigh.length}</strong>
        </div>
        <div style="font-size:11px;color:#6B7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.08em;">Time vs estimate (projects)</div>
        ${projRows || '<div style="color:#6B7280;">No projects.</div>'}
      </div>
    </div>
  `
}

function renderAnalyticsCharts() {
  makeChart('timelineChart', {
    type: 'line',
    data: {
      labels: ['Week 1','Week 2','Week 3','Week 4'],
      datasets: [
        { label: 'Tasks Created', data: [Math.max(1, tasks.length - 6), Math.max(1, tasks.length - 4), Math.max(1, tasks.length - 2), tasks.length], borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,0.1)', tension: 0.4, fill: true },
        { label: 'Tasks Done', data: [Math.max(0, tasks.filter(t=>t.status==='done').length - 4), Math.max(0, tasks.filter(t=>t.status==='done').length - 3), Math.max(0, tasks.filter(t=>t.status==='done').length - 1), tasks.filter(t=>t.status==='done').length], borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', tension: 0.4, fill: true }
      ]
    }
  })

  makeChart('productivityChart', {
    type: 'radar',
    data: {
      labels: ['Tasks','Ideas','Projects','Events','Time Entries'],
      datasets: [{
        label: 'Activity Volume',
        data: [tasks.length, ideas.length * 2, projects.length * 3, events.length * 2, timeEntries.length],
        borderColor: '#4f46e5',
        backgroundColor: 'rgba(79,70,229,0.15)',
        pointBackgroundColor: '#4f46e5'
      }]
    }
  })

  makeChart('statusChart', {
    type: 'pie',
    data: {
      labels: ['Active','Completed','On Hold'],
      datasets: [{
        data: [
          projects.filter(p=>p.status==='active').length,
          projects.filter(p=>p.status==='completed').length,
          projects.filter(p=>p.status==='on-hold').length
        ],
        backgroundColor: ['#4f46e5','#22c55e','#f59e0b'],
        borderWidth: 2,
        borderColor: '#111827'
      }]
    }
  })

  // Time per project
  let projTimeData = projects.slice(0, 6).map(p => ({
    name: p.name,
    secs: timeEntries.filter(e => e.projectId === p.id).reduce((s, e) => s + (e.duration || 0), 0)
  })).filter(x => x.secs > 0)

  makeChart('timeChart', {
    type: 'bar',
    data: {
      labels: projTimeData.length ? projTimeData.map(x => x.name.substring(0, 20)) : ['No data'],
      datasets: [{
        label: 'Hours',
        data: projTimeData.length ? projTimeData.map(x => parseFloat((x.secs/3600).toFixed(1))) : [0],
        backgroundColor: 'rgba(79,70,229,0.7)',
        borderRadius: 6
      }]
    },
    options: { indexAxis: 'y' }
  })

  // Ideas votes
  let topIdeas = [...ideas].sort((a,b) => ideaVoteCount(b) - ideaVoteCount(a)).slice(0, 5)
  makeChart('ideasChart', {
    type: 'bar',
    data: {
      labels: topIdeas.length ? topIdeas.map(i => i.title.substring(0, 20)) : ['No ideas'],
      datasets: [{
        label: 'Votes',
        data: topIdeas.length ? topIdeas.map(i => ideaVoteCount(i)) : [0],
        backgroundColor: 'rgba(124,58,237,0.7)',
        borderRadius: 6
      }]
    }
  })

  // Weekly throughput
  makeChart('throughputChart', {
    type: 'line',
    data: {
      labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
      datasets: [{
        label: 'Tasks Moved',
        data: [2, 5, 3, 7, 4, 1, 2].map(v => Math.floor(v + Math.random() * 3)),
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6,182,212,0.1)',
        tension: 0.4, fill: true, pointRadius: 4
      }]
    }
  })

  // My Productivity (tasks done + hours logged per week)
  if (charts.myProductivityChart) {
    charts.myProductivityChart.destroy()
  }

  const now = new Date()
  const weeks = []
  for (let i = 5; i >= 0; i--) {
    const start = new Date(now)
    start.setHours(0,0,0,0)
    start.setDate(start.getDate() - (start.getDay() + 7 * i))
    const end = new Date(start)
    end.setDate(start.getDate() + 7)
    weeks.push({ start, end })
  }

  const weekLabels = weeks.map(w =>
    w.start.toLocaleDateString(undefined, { month:'short', day:'numeric' })
  )

  const myDoneByWeek = weeks.map(w => {
    return tasks.filter(t => {
      if (t.assignee !== currentUser.id || t.status !== 'done' || !t.updated) return false
      const d = new Date(t.updated)
      return d >= w.start && d < w.end
    }).length
  })

  const myHoursByWeek = weeks.map(w => {
    const secs = timeEntries
      .filter(e => {
        // optional per-user filtering if userId is present
        if (e.userId && e.userId !== currentUser.id) return false
        const d = new Date(e.date || e.created || e.start)
        return d >= w.start && d < w.end
      })
      .reduce((sum, e) => sum + (e.duration || 0), 0)
    return +(secs / 3600).toFixed(1)
  })

  const ctxMyProd = document.getElementById('myProductivityChart')
  if (ctxMyProd) {
    charts.myProductivityChart = new Chart(ctxMyProd, {
      type: 'bar',
      data: {
        labels: weekLabels,
        datasets: [
          {
            label: 'Tasks done',
            data: myDoneByWeek,
            backgroundColor: 'rgba(56,189,248,0.7)',
            borderRadius: 4,
            yAxisID: 'y'
          },
          {
            label: 'Hours logged',
            data: myHoursByWeek,
            type: 'line',
            borderColor: '#a855f7',
            backgroundColor: 'rgba(168,85,247,0.2)',
            borderWidth: 2,
            tension: 0.3,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            labels: { color: '#9CA3AF', font: { size: 11 } }
          }
        },
        scales: {
          x: {
            ticks: { color: '#6B7280', font: { size: 11 } },
            grid: { color: '#111827' }
          },
          y: {
            position: 'left',
            ticks: { color: '#6B7280', stepSize: 1 },
            grid: { color: '#1F2937' }
          },
          y1: {
            position: 'right',
            ticks: { color: '#a855f7' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    })
  }
}

/* ===================================================
   PROFILE & SETTINGS
=================================================== */
function renderProfile() {
  let el = document.getElementById('settingsUsername')
  if (el) el.value = currentUser.username
  let roleEl = document.getElementById('settingsRole')
  if (roleEl) roleEl.value = currentUser.role
  let emailEl = document.getElementById('settingsEmail')
  if (emailEl) emailEl.value = currentUser.email || ''
  let nameEl = document.getElementById('settingsFullName')
  if (nameEl) nameEl.value = currentUser.fullName || ''
  let bioEl = document.getElementById('settingsBio')
  if (bioEl) bioEl.value = currentUser.bio || ''
  let tzEl = document.getElementById('settingsTimezone')
  if (tzEl) tzEl.value = currentUser.timezone || 'UTC'
}

function switchSettingsTab(tabId, el) {
  let sections = ['profile','workspace','notifications-prefs','security','integrations','danger']
  sections.forEach(id => {
    let sec = document.getElementById('settings-' + id)
    if (sec) sec.classList.add('hidden')
  })
  let active = document.getElementById('settings-' + tabId)
  if (active) active.classList.remove('hidden')

  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'))
  if (el) el.classList.add('active')
  if (tabId === 'integrations') {
    syncGoogleCalendarConnectionState()
  }
  if (tabId === 'workspace') {
    renderSettingsAnalyticsSummary()
  }
}

function saveProfileSettings() {
  let payload = {
    email: document.getElementById('settingsEmail').value.trim(),
    fullName: document.getElementById('settingsFullName').value.trim(),
    bio: document.getElementById('settingsBio').value.trim(),
    timezone: document.getElementById('settingsTimezone').value
  }

  if (ALTER_API_BASE && getAuthToken()) {
    fetch(ALTER_API_BASE + '/api/me/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAuthToken()
      },
      body: JSON.stringify(payload)
    })
    .then(r => r.json().then(body => ({ ok: r.ok, body })))
    .then(res => {
      if (!res.ok) return showToast(res.body.error || 'Failed to save profile', 'error')
      currentUser = { ...currentUser, ...payload }
      save('session', currentUser)
      updateSidebarUser()
      addAuditLog('update', 'Updated profile settings', 'update')
      showToast('Profile saved!', 'success')
    })
    .catch(() => showToast('Network error while saving profile', 'error'))
    return
  }

  currentUser.email    = payload.email
  currentUser.fullName = payload.fullName
  currentUser.bio      = payload.bio
  currentUser.timezone = payload.timezone

  let idx = users.findIndex(u => u.id === currentUser.id)
  if (idx >= 0) { users[idx] = currentUser; save('users', users); save('session', currentUser) }
  updateSidebarUser()
  addAuditLog('update', 'Updated profile settings', 'update')
  showToast('Profile saved!', 'success')
}

function saveWorkspaceSettings() {
  let name = document.getElementById('workspaceName').value.trim()
  let slug = document.getElementById('workspaceSlug').value.trim()
  if (name) localStorage.setItem('alco_workspace_name', name)
  if (slug) localStorage.setItem('alco_workspace_slug', slug)
  addAuditLog('update', 'Updated workspace settings', 'update')
  showToast('Workspace settings saved!', 'success')
}

function saveNotifPrefs() {
  // Persist notification preferences into userSettings (synced to backend on next save)
  try {
    const map = {
      notifEmailToggle: 'notifEmailEnabled',
      notifTaskToggle: 'notifTaskEnabled',
      notifMentionToggle: 'notifMentionEnabled',
      notifProjectToggle: 'notifProjectEnabled',
      notifDeadlineToggle: 'notifDeadlineEnabled',
      notifWeeklyToggle: 'notifWeeklyEnabled'
    }
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id)
      if (!el) return
      const key = map[id]
      const active = el.classList.contains('active')
      if (!userSettings || typeof userSettings !== 'object') userSettings = {}
      userSettings[key] = active
    })
    save('usersettings', userSettings)
  } catch (e) {}
  showToast('Notification preferences saved!', 'success')
  addAuditLog('update', 'Updated notification preferences', 'update')
}

function toggleSetting(el) { el.classList.toggle('active') }

function changePassword() {
  let current = document.getElementById('currentPassword').value
  let np      = document.getElementById('newPassword').value
  let confirm = document.getElementById('confirmPassword').value

  if (!current) return showToast('Enter your current password', 'error')
  if (np.length < 6) return showToast('New password must be at least 6 characters', 'error')
  if (np !== confirm) return showToast('Passwords do not match', 'error')

  if (ALTER_API_BASE && getAuthToken()) {
    fetch(ALTER_API_BASE + '/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAuthToken()
      },
      body: JSON.stringify({ currentPassword: current, newPassword: np })
    })
    .then(r => r.json().then(body => ({ ok: r.ok, body })))
    .then(res => {
      if (!res.ok) return showToast(res.body.error || 'Failed to change password', 'error')
      ;['currentPassword','newPassword','confirmPassword'].forEach(id => {
        let el = document.getElementById(id)
        if (el) el.value = ''
      })
      addAuditLog('update', 'Changed account password', 'update')
      showToast('Password changed!', 'success')
    })
    .catch(() => showToast('Network error while changing password', 'error'))
    return
  }

  if (current !== currentUser.password) return showToast('Current password is incorrect', 'error')

  currentUser.password = np
  let idx = users.findIndex(u => u.id === currentUser.id)
  if (idx >= 0) { users[idx].password = np; save('users', users) }
  save('session', currentUser)
  ;['currentPassword','newPassword','confirmPassword'].forEach(id => { let el = document.getElementById(id); if(el) el.value = '' })
  addAuditLog('update', 'Changed account password', 'update')
  showToast('Password changed!', 'success')
}

function enableTwoFactor() { showToast('Two-factor authentication setup coming soon!', 'info') }

function openGoalUpdateModal(id) {
  const g = goals.find(x => x.id === id)
  if (!g) return
  document.getElementById('modalGoalUpdateId').value = id
  document.getElementById('modalGoalUpdateText').value = ''
  document.getElementById('goalUpdateModal').classList.add('active')
}

function closeGoalUpdateModal() {
  document.getElementById('goalUpdateModal').classList.remove('active')
}

function saveGoalUpdate() {
  const id   = document.getElementById('modalGoalUpdateId').value
  const text = document.getElementById('modalGoalUpdateText').value.trim()
  if (!id || !text) { showToast('Please enter an update first.', 'error'); return }
  const g = goals.find(x => x.id === id)
  if (!g) return
  if (!Array.isArray(g.updates)) g.updates = []
  g.updates.unshift({ text, createdAt: new Date().toISOString() })
  save('goals', goals)
  closeGoalUpdateModal()
  renderGoals()
  addActivity(`Goal update: ${g.title} – ${text}`)
  addAuditLog('update', `Updated goal \"${g.title}\"`, 'update')
  showToast('Goal update added.', 'success')
}

function openConfirmModal(opts) {
  pendingConfirm = opts || null
  const titleEl = document.getElementById('confirmTitle')
  const msgEl   = document.getElementById('confirmMessage')
  const btnEl   = document.getElementById('confirmPrimaryBtn')
  if (titleEl) titleEl.textContent = opts.title || 'Are you sure?'
  if (msgEl) msgEl.textContent     = opts.message || ''
  if (btnEl) {
    btnEl.textContent = opts.level === 'danger' ? 'Delete' : 'Confirm'
    btnEl.className = opts.level === 'danger' ? 'btn-danger' : 'btn-primary'
  }
  document.getElementById('confirmModal').classList.add('active')
}

function closeConfirmModal() {
  pendingConfirm = null
  document.getElementById('confirmModal').classList.remove('active')
}

function confirmAction() {
  if (!pendingConfirm) {
    closeConfirmModal()
    return
  }
  const cfg = pendingConfirm
  pendingConfirm = null
  closeConfirmModal()
  switch (cfg.type) {
    case 'logout':
      // Clear both legacy localStorage token and cookie session (if backend enabled)
      try {
        if (ALTER_API_BASE) {
          fetch(ALTER_API_BASE + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(function () {})
        }
      } catch (e) {}
      clearAuthToken()
      localStorage.removeItem('alco_session')
      Object.keys(charts).forEach(function (k) { try { if (charts[k]) charts[k].destroy() } catch(e){} })
      charts = {}
      stopTimer()
      currentUser = null
      document.getElementById('usernameInput').value = ''
      document.getElementById('passwordInput').value = ''
      showLandingScreen()
      break
    case 'delete_project':
      reallyDeleteProject(cfg.id)
      break
    case 'delete_task':
      reallyDeleteTask(cfg.id)
      break
    case 'delete_idea':
      reallyDeleteIdea(cfg.id)
      break
    case 'delete_goal':
      reallyDeleteGoal(cfg.id)
      break
    case 'delete_page':
      reallyDeletePage(cfg.id)
      break
    case 'remove_member':
      reallyRemoveMember(cfg.id)
      break
    case 'delete_account':
      reallyDeleteAccount()
      break
    case 'reset_workspace':
      reallyResetWorkspace()
      break
    default:
      break
  }
}

function deleteAccount() {
  if (ALTER_API_BASE && getAuthToken()) {
    fetch(ALTER_API_BASE + '/api/me', {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer ' + getAuthToken()
      }
    })
    .then(r => {
      if (!r.ok) throw new Error('Delete failed')
      clearAuthToken()
      localStorage.removeItem('alco_session')

      Object.keys(charts).forEach(function (k) {
        try { if (charts[k]) charts[k].destroy() } catch (e) {}
      })
      charts = {}

      stopTimer()
      currentUser = null

      document.getElementById('usernameInput').value = ''
      document.getElementById('passwordInput').value = ''
      showLandingScreen()
      showToast('Account deleted', 'success')
    })
    .catch(() => showToast('Failed to delete account on server', 'error'))
    return
  }

  users = users.filter(u => u.id !== currentUser.id)
  save('users', users)
  ;['projects','tasks','ideas','events','goals','pages','team','notifications','activity','time','audit','apikeys','usersettings'].forEach(k => {
    localStorage.removeItem('alco_' + k)
  })

  Object.keys(charts).forEach(function (k) {
    try { if (charts[k]) charts[k].destroy() } catch (e) {}
  })
  charts = {}

  stopTimer()
  currentUser = null
  localStorage.removeItem('alco_session')

  document.getElementById('usernameInput').value = ''
  document.getElementById('passwordInput').value = ''
  showLandingScreen()
  showToast('Account deleted', 'success')
}

function resetWorkspace() {
  openConfirmModal({
    type: 'reset_workspace',
    title: 'Reset workspace',
    message: 'This will delete ALL projects, tasks, ideas, events, and activity in this workspace.',
    level: 'danger'
  })
}

function reallyResetWorkspace() {
  forceResetTimerSession()
  projects = []; tasks = []; ideas = []; events = []; goals = []; timeEntries = []; activity = []
  pages = []
  ;['projects','tasks','ideas','events','goals','time','activity','pages'].forEach(k => save(k, []))
  renderAllPages()
  addAuditLog('delete', 'Reset entire workspace', 'delete')
  showToast('Workspace reset!', 'warning')
}

/* ===================================================
   API KEYS
=================================================== */
function showApiKeyModal() {
  renderApiKeys()
  document.getElementById('apiKeyModal').classList.add('active')
}

function generateApiKey() {
  let key = 'alco_' + Array.from({length: 32}, () => Math.random().toString(36)[2]).join('')
  apiKeys.push({ id: genId(), key, created: new Date().toISOString(), label: 'API Key ' + (apiKeys.length + 1) })
  save('apikeys', apiKeys)
  renderApiKeys()
  addAuditLog('create', 'Generated new API key', 'create')
  showToast('API key generated!', 'success')
}

function renderApiKeys() {
  let el = document.getElementById('apiKeysList')
  if (!el) return
  el.innerHTML = apiKeys.map(k => `
    <div style="background:#0d1117;border:1px solid #1F2937;border-radius:8px;padding:14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:600;">${escapeHtml(k.label)}</span>
        <button class="btn-sm btn-danger" onclick="deleteApiKey('${k.id}')">Revoke</button>
      </div>
      <div style="font-family:monospace;font-size:12px;color:#4f46e5;word-break:break-all;background:#020617;padding:8px;border-radius:6px;">
        ${k.key.substring(0, 20)}••••••••••••••••
      </div>
      <div style="font-size:11px;color:#4B5563;margin-top:6px;">Created ${timeAgo(k.created)}</div>
    </div>
  `).join('') || '<p style="color:#4B5563;font-size:13px;text-align:center;padding:20px;">No API keys. Generate one to get started.</p>'
}

function deleteApiKey(id) {
  apiKeys = apiKeys.filter(k => k.id !== id)
  save('apikeys', apiKeys)
  renderApiKeys()
  addAuditLog('delete', 'Revoked API key', 'delete')
  showToast('API key revoked', 'success')
}

/* ===================================================
   SEARCH
=================================================== */
function searchAll() {
  let input = document.getElementById('globalSearch')
  if (!input) return

  let q = input.value.toLowerCase().trim()
  if (!q) {
    renderProjects()
    renderTasks()
    renderIdeas()
    return
  }

  let fp = projects.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))
  let ft = tasks.filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
  let fi = ideas.filter(i => i.title.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))

  document.getElementById('projectsList').innerHTML = fp.map(buildProjectCard).join('') ||
    `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No projects matching "${escapeHtml(q)}"</h3></div>`

  renderTasks(ft)

  document.getElementById('ideasList').innerHTML = fi.map(buildIdeaCard).join('') ||
    `<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No ideas matching "${escapeHtml(q)}"</h3></div>`
}

/* ===================================================
   UTILITIES
=================================================== */
function showToast(message, type) {
  type = type || 'info'
  let icons = { success:'✓', error:'✕', info:'ℹ', warning:'⚠' }
  let container = document.getElementById('toastContainer')
  let toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span style="flex:1;">${escapeHtml(message)}</span><button class="toast-close" onclick="this.parentElement.remove()">✕</button>`
  container.appendChild(toast)
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.opacity = '0'
      toast.style.transform = 'translateY(10px)'
      toast.style.transition = 'all 0.3s'
      setTimeout(() => toast.remove(), 300)
    }
  }, 4000)
}

function refreshDashboard() {
  renderDashboardCharts()
  renderActivityFeed()
  updateStats()
  showToast('Dashboard refreshed!', 'success')
}

function exportData() {
  if (!currentUser) {
    showToast('Please sign in to export data', 'error')
    return
  }
  try {
    let workspaceName = localStorage.getItem('alco_workspace_name') || 'My Workspace'
    let safeName = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'

    let data = {
      exportedBy: currentUser.username,
      exportDate: new Date().toISOString(),
      workspaceName,
      projects: projects.map(p => ({ ...p })),
      tasks: tasks.map(t => ({ ...t })),
      ideas: ideas.map(i => ({ ...i })),
      goals: goals.map(g => ({ ...g })),
      events: events.map(e => ({ ...e })),
      timeEntries: timeEntries.map(e => ({ ...e })),
      team: team.map(m => ({ ...m })),
      notifications: notifications.map(n => ({ ...n })),
      activity: activity.map(a => ({ ...a })),
      auditLogs: auditLogs.map(l => ({ ...l })),
      invoices: invoices.map(inv => ({ ...inv })),
      apiKeys: apiKeys.map(k => ({ ...k })),
      userSettings: { ...userSettings },
      calendarState: {
        calendarView,
        selectedCalendarDate
      },
      billingState: {
        billingPeriod
      }
    }

    let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    let a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `alter-co-export-${safeName}-${Date.now()}.json`
    })
    a.click()
    URL.revokeObjectURL(a.href)
    addAuditLog('other', 'Exported workspace data', 'other')
    showToast('Data exported!', 'success')
  } catch (err) {
    console.error('Export failed', err)
    showAppErrorBanner('Export failed. Please try again.')
    logAppError({
      type: 'export-failed',
      message: err?.message || String(err),
      time: new Date().toISOString()
    })
  }
}

function generateReport() {
  if (!currentUser) {
    showToast('Please sign in to generate a report', 'error')
    return
  }
  let done = tasks.filter(t => t.status === 'done').length
  let rate = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0
  let totalHours = (timeEntries.reduce((s, e) => s + (e.duration||0), 0) / 3600).toFixed(1)

  let report = `ALTER.CO WORKSPACE REPORT
Generated: ${new Date().toLocaleDateString()}
Workspace: ${localStorage.getItem('alco_workspace_name') || 'My Workspace'}
User: ${currentUser.fullName || currentUser.username}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Projects:        ${projects.length}
  Active:        ${projects.filter(p=>p.status==='active').length}
  Completed:     ${projects.filter(p=>p.status==='completed').length}
  On Hold:       ${projects.filter(p=>p.status==='on-hold').length}

Tasks:           ${tasks.length}
  Completed:     ${done} (${rate}%)
  In Progress:   ${tasks.filter(t=>t.status==='in-progress').length}
  To Do:         ${tasks.filter(t=>t.status==='todo').length}
  In Review:     ${tasks.filter(t=>t.status==='review').length}

Ideas Submitted: ${ideas.length}
Events:          ${events.length}
Team Members:    ${workspacePeopleHeadcount()}
Hours Tracked:   ${totalHours}h
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(report)
      showToast('Workspace report copied to clipboard.', 'success')
    } else {
      console.log('Workspace report:\\n' + report)
      showToast('Workspace report logged to console.', 'success')
    }
  } catch (e) {
    console.log('Workspace report:\\n' + report)
    showToast('Could not copy report, logged in console.', 'error')
  }
  addAuditLog('other', 'Generated workspace report', 'other')
}

function handleModalBackdrop(e) {
  if (e.target.classList.contains('modal')) e.target.classList.remove('active')
}

// Close notifications panel on outside click
document.addEventListener('click', e => {
  let panel = document.getElementById('notificationsPanel')
  if (panel && panel.classList.contains('active') && !panel.contains(e.target)) {
    let topbarBtn = e.target.closest('.topbar-btn')
    if (!topbarBtn) panel.classList.remove('active')
  }
  let cmd = document.getElementById('commandPalette')
  if (cmd && cmd.classList.contains('active') && e.target === cmd) closeCommandPalette(e)
})

// Enable basic touch move for tasks on mobile
document.addEventListener('touchstart', handleTaskTouchStart, { passive: true })
document.addEventListener('touchend', handleTaskTouchEnd)