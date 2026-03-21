#!/usr/bin/env node
'use strict'

/**
 * Create an admin user in backend/data/users.json (+ empty workspace).
 * Run from repo root: node backend/scripts/create-admin.js <username> <email> <password>
 * Or from backend/: node scripts/create-admin.js <username> <email> <password>
 */

const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

const DATA_DIR = path.join(__dirname, '..', 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace')

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

function emptyWorkspace() {
  const keys = [
    'projects', 'tasks', 'ideas', 'events', 'goals', 'timeEntries', 'team',
    'notifications', 'activity', 'auditLogs', 'invoices', 'apiKeys', 'userSettings', 'pages'
  ]
  const out = {}
  for (const k of keys) out[k] = k === 'userSettings' ? {} : []
  return out
}

const [, , username, email, password] = process.argv

if (!username || !email || !password) {
  console.error('Usage: node scripts/create-admin.js <username> <email> <password>')
  console.error('Example: node scripts/create-admin.js alteradmin you@example.com "YourSecurePass123"')
  process.exit(1)
}
if (username.length < 4) {
  console.error('Username must be at least 4 characters.')
  process.exit(1)
}
if (password.length < 6) {
  console.error('Password must be at least 6 characters.')
  process.exit(1)
}

if (!fs.existsSync(USERS_FILE)) {
  console.error('Missing', USERS_FILE)
  process.exit(1)
}

let users
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
} catch (e) {
  console.error('Could not read users.json', e.message)
  process.exit(1)
}
if (!Array.isArray(users)) {
  console.error('users.json must contain a JSON array')
  process.exit(1)
}

const emailLower = String(email).trim().toLowerCase()
if (users.find(u => u.username === username)) {
  console.error('Username already exists:', username)
  process.exit(1)
}
if (users.find(u => (u.email || '').toLowerCase() === emailLower)) {
  console.error('Email already exists:', emailLower)
  process.exit(1)
}

const id = genId()
const row = {
  id,
  username,
  email: emailLower,
  password_hash: bcrypt.hashSync(password, 10),
  full_name: 'Administrator',
  bio: '',
  timezone: 'UTC',
  role: 'admin',
  plan: 'free',
  created_at: new Date().toISOString()
}

users.push(row)
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8')

if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
const wsFile = path.join(WORKSPACE_DIR, id + '.json')
if (!fs.existsSync(wsFile)) {
  fs.writeFileSync(wsFile, JSON.stringify(emptyWorkspace(), null, 2), 'utf8')
}

console.log('Admin user created.')
console.log('  username:', username)
console.log('  email:   ', row.email)
console.log('  id:      ', id)
console.log('Sign in with the password you provided, then change it in Settings if needed.')
