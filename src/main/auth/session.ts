import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { pbkdf2Sync, randomBytes } from 'crypto'
import { userRepo } from '../db/users'

const ITERATIONS = 100_000
const KEY_LENGTH = 64
const DIGEST = 'sha512'

const GUEST_ALIASES = [
  'Chosen One',
  'John Doe',
  'Ghost in the Shell',
  'Neon Drifter',
  'Rogue Signal',
  'Zero Day',
  'Phantom Node',
  'Shadow Runner',
  'Unknown Entity',
  'Null Pointer',
  'Net Walker',
  'Glitch',
  'Cipher',
  'Echo',
  'Sleeper Agent',
  'Jane Doe',
  'Stray Voltage',
  'Lost Packet',
  'Anon',
  'Wanderer'
]

let currentUserId: string = '__default__'

/** Get the currently active user ID */
export function getCurrentUserId(): string {
  return currentUserId
}

/** Set the current user (in-memory session) and persist to disk */
export function setCurrentUser(userId: string): void {
  currentUserId = userId
  persistLastUser(userId)
}

/** Hash a password with a random salt */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(32).toString('hex')
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex')
  return { hash, salt }
}

/** Verify a password against stored hash and salt */
export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex')
  return hash === storedHash
}

/** Load the last active user ID from disk (called on startup) */
export function loadLastUser(): string {
  try {
    const filePath = getSessionFilePath()
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    return data.lastUserId || '__default__'
  } catch {
    return '__default__'
  }
}

/** Initialize session on app startup — stays as __default__ until validated */
export function initSession(): void {
  // Don't auto-set currentUserId here; the renderer will call auth:get-startup
  // which validates password requirements before activating the user session.
  currentUserId = '__default__'
  rotateGuestAlias()
}

/** Pick a random display name for the default/guest user on each launch */
function rotateGuestAlias(): void {
  try {
    const alias = GUEST_ALIASES[Math.floor(Math.random() * GUEST_ALIASES.length)]
    userRepo.rotateGuestAlias(alias)
  } catch {
    // Best-effort — DB might not be ready in edge cases
  }
}

/** Get the raw last-active user ID from disk (may need password before activating) */
export function getLastUserId(): string {
  return loadLastUser()
}

function persistLastUser(userId: string): void {
  try {
    const filePath = getSessionFilePath()
    writeFileSync(filePath, JSON.stringify({ lastUserId: userId }), 'utf-8')
  } catch {
    // Best-effort persist
  }
}

function getSessionFilePath(): string {
  return join(app.getPath('userData'), 'session.json')
}
