/**
 * `app-data/desktop.json` — the **one** file in an agent folder Cinna Desktop
 * owns (Invariant 2, and `desktop_owned` in the contract's `layout.json`).
 *
 * Everything else in the folder belongs to the kit, to the assistant working in
 * it, or to the agent itself. This file holds the per-machine runtime state the
 * desktop needs and nobody else does: where the agent's local API answered,
 * the token it was linked with, engine session ids per chat, permission
 * decisions the user made, and the last status snapshot.
 *
 * It is created lazily — a freshly scaffolded folder does not have one, and a
 * folder that never ran should not gain one — and written atomically, because a
 * scan may read it at the same moment a turn writes it.
 *
 * `agentToken` is a secret. It stays in the main process: {@link summarize} is
 * what the renderer sees, and it reports presence only.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DESKTOP_STATE_FILE } from '../../../shared/kit/manifest'
import type { LocalAgentDesktopSummary } from '../../../shared/localAgents'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'

const logger = createLogger('local-agent-state')

/** One engine session, keyed by chat id. Mirrors `a2a_sessions` for folders. */
export interface DesktopSessionState {
  /** Engine session id — carried as `context_id` by `a2aSessionRepo`. */
  sessionId: string
  updatedAt: number
}

/** A permission the user granted this agent, keyed by permission id. */
export interface DesktopPermissionGrant {
  granted: boolean
  /** `'once'` grants are not persisted; only `'always'` reaches this file. */
  scope: 'always'
  decidedAt: number
}

export interface DesktopState {
  /** Loopback base URL the engine last served this agent's API on. */
  localApiBaseUrl: string | null
  /** Token the agent authenticates its own callbacks with. Never leaves main. */
  agentToken: string | null
  sessions: Record<string, DesktopSessionState>
  permissionGrants: Record<string, DesktopPermissionGrant>
  lastStatus: { at: number; summary: string | null; state: string | null } | null
}

const EMPTY_STATE: DesktopState = {
  localApiBaseUrl: null,
  agentToken: null,
  sessions: {},
  permissionGrants: {},
  lastStatus: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Coerce whatever is on disk into {@link DesktopState}. Deliberately total: a
 * file another build (or a bad merge) wrote must degrade to defaults, never
 * throw — the scanner reads this for every agent on every pass.
 */
function coerce(raw: unknown): DesktopState {
  if (!isRecord(raw)) return { ...EMPTY_STATE }

  const sessions: Record<string, DesktopSessionState> = {}
  if (isRecord(raw.sessions)) {
    for (const [chatId, value] of Object.entries(raw.sessions)) {
      if (!isRecord(value)) continue
      const sessionId = asString(value.sessionId)
      if (!sessionId) continue
      sessions[chatId] = {
        sessionId,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
      }
    }
  }

  const permissionGrants: Record<string, DesktopPermissionGrant> = {}
  if (isRecord(raw.permissionGrants)) {
    for (const [key, value] of Object.entries(raw.permissionGrants)) {
      if (!isRecord(value) || typeof value.granted !== 'boolean') continue
      permissionGrants[key] = {
        granted: value.granted,
        scope: 'always',
        decidedAt: typeof value.decidedAt === 'number' ? value.decidedAt : 0
      }
    }
  }

  let lastStatus: DesktopState['lastStatus'] = null
  if (isRecord(raw.lastStatus) && typeof raw.lastStatus.at === 'number') {
    lastStatus = {
      at: raw.lastStatus.at,
      summary: asString(raw.lastStatus.summary),
      state: asString(raw.lastStatus.state)
    }
  }

  return {
    localApiBaseUrl: asString(raw.localApiBaseUrl),
    agentToken: asString(raw.agentToken),
    sessions,
    permissionGrants,
    lastStatus
  }
}

/** Absolute path of the desktop state file inside an agent folder. */
export function desktopStatePath(agentDir: string): string {
  return join(agentDir, DESKTOP_STATE_FILE)
}

function writeAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(temp, 'w')
    writeSync(fd, contents)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* the write already failed; the close error adds nothing */
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file may never have been created */
    }
    logger.error('failed to write desktop state', { agentDir: dirname(dirname(path)), error: err })
    throw new LocalAgentError(
      'write_failed',
      'Could not save this agent’s local state.',
      err instanceof Error ? err.message : String(err)
    )
  }
}

export const desktopStateService = {
  /** Read the state, or the empty state when the file is absent or unusable. */
  read(agentDir: string): DesktopState {
    const path = desktopStatePath(agentDir)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        logger.warn('desktop state unreadable; using defaults', { path, code })
      }
      return { ...EMPTY_STATE }
    }
    try {
      return coerce(JSON.parse(text))
    } catch {
      logger.warn('desktop state is not valid JSON; using defaults', { path })
      return { ...EMPTY_STATE }
    }
  },

  /** Replace the state wholesale. Creates `app-data/` if it does not exist. */
  write(agentDir: string, state: DesktopState): void {
    writeAtomically(desktopStatePath(agentDir), `${JSON.stringify(state, null, 2)}\n`)
    logger.debug('desktop state written', {
      sessions: Object.keys(state.sessions).length,
      hasToken: state.agentToken !== null
    })
  },

  /** Read-modify-write one or more fields. Returns the state as written. */
  patch(agentDir: string, patch: Partial<DesktopState>): DesktopState {
    const next: DesktopState = { ...this.read(agentDir), ...patch }
    this.write(agentDir, next)
    return next
  },

  /** What the renderer is allowed to know. The token is reported, never sent. */
  summarize(state: DesktopState): LocalAgentDesktopSummary {
    return {
      localApiBaseUrl: state.localApiBaseUrl,
      hasAgentToken: state.agentToken !== null,
      sessionCount: Object.keys(state.sessions).length,
      lastStatusAt: state.lastStatus?.at ?? null
    }
  }
}
