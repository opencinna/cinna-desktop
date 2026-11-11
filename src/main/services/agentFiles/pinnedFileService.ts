import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { DomainError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { isPlausiblePath, isWithin } from '../localAgents/pathRules'
import type {
  AgentFileActionResult,
  AgentFileErrorCode,
  AgentFileFailure,
  AgentFilePathInput,
  ListPinnedAgentFilesResult,
  MovePinnedAgentFileInput,
  PinnedAgentFile,
  SetPinnedAgentFileResult
} from '../../../shared/agentFiles'
import { createPathCanonicalizer, type PathCanonicalizer } from './canonicalPath'
import { displayPathFor, guardedProbeRule } from './resolver'

const logger = createLogger('agent-files')

const MESSAGES: Partial<Record<AgentFileErrorCode, string>> = {
  invalid_input: 'Nothing to pin.',
  agent_not_found: 'That agent is no longer in your agents folder.',
  not_found: 'That file is no longer there.',
  not_a_file: 'Only files can be pinned, not folders.'
}

function fail(code: AgentFileErrorCode, error: string = MESSAGES[code] ?? 'Could not pin the file.'): AgentFileFailure {
  return { success: false, code, error }
}

/** The stored row the service reads and writes; `path` is in its stored form. */
export interface PinnedFileStore {
  list(userId: string, agentId: string): ReadonlyArray<{ path: string; inside: boolean; rank: number }>
  /** Insert-if-absent; true when a row was added. */
  add(userId: string, agentId: string, path: string, inside: boolean): boolean
  /** True when a row was deleted. */
  remove(userId: string, agentId: string, path: string): boolean
  move(userId: string, agentId: string, path: string, rank: number): boolean
}

export interface PinnedFileServiceDeps {
  /** The folder behind a folder agent id. Throws when there is none (not a folder agent, or gone). */
  locateAgent: (agentId: string) => string
  /** The profile the pins belong to. */
  getUserId: () => string
  store: PinnedFileStore
  /** `isGuardedLocation`: a path behind a macOS privacy prompt, never probed while listing. */
  isGuardedLocation: (path: string) => boolean
  platform: NodeJS.Platform
  paths?: PathCanonicalizer
  home?: string
}

interface Located {
  agentId: string
  agentDir: string
  realAgentDir: string
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Per-(profile, agent) pinned files.
 *
 * The agent folder comes from the index row (`locateAgent`), never from the
 * renderer. A pin inside the folder is stored relative to it, so moving the
 * folder keeps it; one outside is stored absolute. Listing only stats — it
 * reads nothing, and a path behind a macOS privacy prompt is not touched at
 * all (the chat it shows in was opened by nobody's click on it). Opening a
 * pin goes through the ordinary `authorize` / read path, unchanged.
 *
 * Failures are returned as data; a thrown code would not survive IPC.
 */
export function createPinnedFileService(deps: PinnedFileServiceDeps) {
  const paths = deps.paths ?? createPathCanonicalizer({ platform: deps.platform })
  const home = (): string => deps.home ?? homedir()

  async function locate(agentId: unknown): Promise<Located | AgentFileFailure> {
    if (typeof agentId !== 'string' || agentId === '') return fail('invalid_input')
    let agentDir: string
    try {
      agentDir = deps.locateAgent(agentId)
    } catch (err) {
      return fail('agent_not_found', err instanceof DomainError ? err.message : undefined)
    }
    try {
      return { agentId, agentDir, realAgentDir: await paths.realpath(agentDir) }
    } catch {
      return fail('agent_not_found')
    }
  }

  /** The stored form of an absolute path: relative (POSIX separators) inside the folder, absolute outside. */
  function storedForm(located: Located, absolute: string): { path: string; inside: boolean } {
    if (isWithin(located.realAgentDir, absolute) && absolute !== located.realAgentDir) {
      return { path: toPosix(relative(located.realAgentDir, absolute)), inside: true }
    }
    return { path: absolute, inside: false }
  }

  /** A path the renderer named, as long as it is shaped like one. */
  function requestedPath(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null
    const { path } = input as Partial<AgentFilePathInput>
    return isPlausiblePath(path) ? normalize(path) : null
  }

  return {
    /** The agent's pins in rank order, each resolved against the agent's current folder. */
    async list(input: unknown): Promise<ListPinnedAgentFilesResult> {
      if (!input || typeof input !== 'object') return fail('invalid_input')
      const located = await locate((input as { agentId?: unknown }).agentId)
      if ('success' in located) return located
      const realHome = await paths.realpath(home()).catch(() => resolve(home()))
      const offLimits = guardedProbeRule(located.agentDir, located.realAgentDir, deps.isGuardedLocation, paths)
      const rows = deps.store.list(deps.getUserId(), located.agentId)
      const pins = await Promise.all(
        rows.map(async (row): Promise<PinnedAgentFile> => {
          const path = row.inside ? join(located.realAgentDir, row.path) : row.path
          let exists = true
          if (!isAbsolute(path)) {
            exists = false
          } else if (!offLimits(path)) {
            exists = await stat(path).then((info) => info.isFile(), () => false)
          }
          return {
            path,
            displayPath: displayPathFor(path, located.realAgentDir, realHome),
            inside: row.inside,
            rank: row.rank,
            exists
          }
        })
      )
      return { success: true, pins }
    },

    /**
     * Pin or unpin a file, as the user asked (`pinned`), never by what is
     * stored: the same file may be named in another spelling (a symlinked
     * agent folder), and a toggle would then undo the pin it meant to make.
     * Idempotent both ways.
     *
     * Unpinning removes the path as named, else its realpath, without needing
     * the file: a pin whose file is gone can still be removed. Pinning stores
     * the realpath once; a folder is refused.
     */
    async set(input: unknown): Promise<SetPinnedAgentFileResult> {
      const path = requestedPath(input)
      const want = (input as { pinned?: unknown } | null)?.pinned
      if (path === null || typeof want !== 'boolean') return fail('invalid_input')
      const located = await locate((input as { agentId?: unknown }).agentId)
      if ('success' in located) return located
      const userId = deps.getUserId()
      if (!want) {
        const named = storedForm(located, path)
        if (!deps.store.remove(userId, located.agentId, named.path)) {
          const real = await paths.realpath(path).catch(() => null)
          if (real !== null) {
            const form = storedForm(located, real)
            if (form.path !== named.path) deps.store.remove(userId, located.agentId, form.path)
          }
        }
        logger.info('unpinned an agent file', { inside: named.inside })
        return { success: true, pinned: false }
      }
      let real: string
      try {
        real = await paths.realpath(path)
        const info = await stat(real)
        if (info.isDirectory()) return fail('not_a_file')
        if (!info.isFile()) return fail('not_found')
      } catch {
        return fail('not_found')
      }
      const form = storedForm(located, real)
      if (deps.store.add(userId, located.agentId, form.path, form.inside)) {
        logger.info('pinned an agent file', { inside: form.inside })
      }
      return { success: true, pinned: true }
    },

    /** Drag reorder: give a pinned path a new rank. */
    async move(input: unknown): Promise<AgentFileActionResult> {
      const path = requestedPath(input)
      const rank = (input as Partial<MovePinnedAgentFileInput> | null)?.rank
      if (path === null || typeof rank !== 'number' || !Number.isFinite(rank)) return fail('invalid_input')
      const located = await locate((input as { agentId?: unknown }).agentId)
      if ('success' in located) return located
      const named = storedForm(located, path)
      if (!deps.store.move(deps.getUserId(), located.agentId, named.path, rank)) {
        return fail('not_found', 'That file is not pinned.')
      }
      return { success: true }
    }
  }
}

export type PinnedFileService = ReturnType<typeof createPinnedFileService>
