import { posix } from 'node:path'
import { createLogger } from '../../logger/logger'
import {
  MAX_FILE_REF_BASES,
  MAX_FILE_REF_CANDIDATES,
  fileLinkCandidatePath,
  fileRefCandidatePath,
  isCredentialFilePath,
  type AgentFileActions,
  type AgentFileFailure,
  type AgentFileRef,
  type AgentFileErrorCode,
  type FileRefEntry
} from '../../../shared/agentFiles'
import type { VaultFileAccess, VaultFileStatEntry } from '../../vault/fileAccess'
import { fail, isFailure, type AgentFileSource, type AgentFileTarget } from './fileSource'

const logger = createLogger('agent-files')

/** A vault's files are previewed and downloaded; nothing else here reaches inside it. */
export const VAULT_FILE_ACTIONS: AgentFileActions = Object.freeze({
  preview: true,
  previewImages: true,
  open: false,
  reveal: false,
  openInBrowser: false,
  readText: false,
  pin: false,
  publish: false,
  run: false,
  reference: false,
  download: true,
  copyPath: false
})

/** A credential file in a vault: not even Download is offered (main refuses it regardless). */
export const VAULT_CREDENTIAL_FILE_ACTIONS: AgentFileActions = Object.freeze({ ...VAULT_FILE_ACTIONS, download: false })

/** Distinct paths the second (base) pass stats at most per resolve. */
const MAX_BASE_PROBES = 1000

export interface VaultFileSourceDeps {
  /**
   * The vault a vault agent lives in, and its agent folder as processes inside
   * the vault see it (`/vault/agent`). Throws when the agent is not one.
   */
  locateVault: (agentId: string) => { vaultId: string; agentDir: string }
  files: () => VaultFileAccess
}

interface VaultTarget extends AgentFileTarget {
  vaultId: string
  agentDir: string
  /** Agent-relative realpath, `''` for the folder itself. */
  rel: string
}

/** A vault failure (`VaultError`, `VaultdError`, `VaultBackendError`: all carry `code`) as an agent-file one. */
function vaultFailure(err: unknown, fallback: AgentFileErrorCode, fallbackMessage?: string): AgentFileFailure {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'locked') return fail('locked')
  if (code === 'denied' || code === 'bad_token') return fail('denied', 'Cancelled at the prompt — nothing left the vault.')
  if (code === 'not_found') return fail('not_found')
  if (code === 'not_vault_agent') return fail('agent_not_found')
  return fail(fallback, fallbackMessage)
}

function joinIn(agentDir: string, rel: string): string {
  return rel === '' ? agentDir : posix.join(agentDir, rel)
}

/**
 * A vault agent's files, inside its vault: they are reached only through
 * {@link VaultFileAccess} (vaultd checks containment as the agent user),
 * never through this computer's filesystem.
 *
 * References resolve inside the agent folder only: an absolute path elsewhere
 * or a `~/` path names nothing here. A ref's `path` is where the file is for
 * the processes inside the vault (`/vault/agent/…`), and every one is `inside`.
 * A locked vault answers `locked`: resolve links nothing new (the renderer
 * keeps the links it already has), a preview asks to unlock.
 */
export function createVaultFileSource(deps: VaultFileSourceDeps): AgentFileSource {
  function locate(agentId: unknown): { vaultId: string; agentDir: string } | AgentFileFailure {
    if (typeof agentId !== 'string' || agentId === '') return fail('invalid_input')
    try {
      const located = deps.locateVault(agentId)
      return { vaultId: located.vaultId, agentDir: located.agentDir.replace(/\/+$/, '') || '/' }
    } catch (err) {
      return vaultFailure(err, 'agent_not_found')
    }
  }

  /** A path inside the agent folder as the vault spells it, lexically, else null. */
  function underAgent(agentDir: string, path: string): string | null {
    const normalized = posix.normalize(path)
    if (normalized === agentDir || normalized.startsWith(agentDir + '/')) return normalized.replace(/\/+$/, '')
    return null
  }

  async function statPaths(vaultId: string, paths: string[]): Promise<VaultFileStatEntry[] | AgentFileFailure> {
    try {
      return await deps.files().resolve(vaultId, paths)
    } catch (err) {
      logger.warn('checking vault file references failed', { code: String((err as { code?: unknown })?.code ?? 'unknown') })
      return vaultFailure(err, 'read_failed')
    }
  }

  return {
    actions: VAULT_FILE_ACTIONS,

    async resolve(agentId, entries) {
      const located = locate(agentId)
      if (isFailure(located)) return located
      const { vaultId, agentDir } = located

      // 1. Direct: relative to the agent folder, or absolute inside it.
      const candidates: { entry: FileRefEntry; probe: string; relative: string | null }[] = []
      const seen = { span: new Set<string>(), link: new Set<string>() }
      for (const entry of entries) {
        if (candidates.length >= MAX_FILE_REF_CANDIDATES) break
        if (seen[entry.source].has(entry.text)) continue
        const candidate = entry.source === 'span' ? fileRefCandidatePath(entry.text) : fileLinkCandidatePath(entry.text)
        if (candidate === null) continue
        seen[entry.source].add(entry.text)
        if (candidate === '~' || candidate.startsWith('~/')) continue
        if (candidate.startsWith('/')) {
          const inside = underAgent(agentDir, candidate)
          if (inside !== null) candidates.push({ entry, probe: inside, relative: null })
          continue
        }
        const relative = posix.normalize(candidate)
        if (relative === '..' || relative.startsWith('../')) continue
        candidates.push({ entry, probe: relative, relative: candidate.split('/').includes('..') ? null : relative })
      }
      if (candidates.length === 0) return { success: true, refs: [] }
      const direct = await statPaths(vaultId, candidates.map((c) => c.probe))
      if (isFailure(direct)) return direct

      // 2. Bases: a relative name that missed is tried against the folders of
      // earlier direct hits; it links only when exactly one file matches.
      const hits: (VaultFileStatEntry | null)[] = direct.map((e) => (e.type && e.rel !== null ? e : null))
      const basesBefore: string[][] = []
      const bases: string[] = []
      const baseSet = new Set<string>()
      for (let i = 0; i < candidates.length; i++) {
        basesBefore.push([...bases])
        const hit = hits[i]
        if (!hit || hit.rel === null) continue
        for (let dir = hit.type === 'dir' ? hit.rel : posix.dirname(hit.rel); dir !== '' && dir !== '.'; dir = posix.dirname(dir)) {
          if (bases.length >= MAX_FILE_REF_BASES) break
          if (!baseSet.has(dir)) {
            baseSet.add(dir)
            bases.push(dir)
          }
          if (posix.dirname(dir) === dir) break
        }
      }
      const second = new Set<string>()
      for (let i = 0; i < candidates.length; i++) {
        const relative = candidates[i].relative
        if (hits[i] || relative === null) continue
        for (const base of basesBefore[i]) {
          if (second.size >= MAX_BASE_PROBES) break
          second.add(posix.join(base, relative))
        }
      }
      const byPath = new Map<string, VaultFileStatEntry>()
      if (second.size > 0) {
        const answered = await statPaths(vaultId, [...second])
        if (isFailure(answered)) return answered
        for (const e of answered) if (e.type && e.rel !== null) byPath.set(e.path, e)
      }

      const refs: AgentFileRef[] = []
      for (let i = 0; i < candidates.length; i++) {
        let hit = hits[i]
        const relative = candidates[i].relative
        if (!hit && relative !== null) {
          const distinct = new Map<string, VaultFileStatEntry>()
          for (const base of basesBefore[i]) {
            const found = byPath.get(posix.join(base, relative))
            if (found?.rel != null) distinct.set(found.rel, found)
          }
          if (distinct.size === 1) hit = [...distinct.values()][0]
        }
        if (!hit || hit.rel === null || !hit.type) continue
        const { entry } = candidates[i]
        const path = joinIn(agentDir, hit.rel)
        refs.push({
          text: entry.text,
          source: entry.source,
          path,
          displayPath: hit.rel || '.',
          kind: hit.type,
          inside: true,
          // A folder downloads whole (credential files in it included, after
          // approval); a credential file on its own is never offered.
          actions: hit.type === 'file' && isCredentialFilePath(path, agentDir) ? VAULT_CREDENTIAL_FILE_ACTIONS : VAULT_FILE_ACTIONS
        })
      }
      logger.debug('resolved vault file refs', { entries: entries.length, refs: refs.length })
      return { success: true, refs }
    },

    async stat(input) {
      if (!input || typeof input !== 'object') return fail('invalid_input')
      const { agentId, path } = input as { agentId?: unknown; path?: unknown }
      if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0')) return fail('invalid_input')
      const located = locate(agentId)
      if (isFailure(located)) return located
      const requested = underAgent(located.agentDir, path)
      if (requested === null) return fail('not_found')
      const answered = await statPaths(located.vaultId, [requested])
      if (isFailure(answered)) return answered
      const entry = answered[0]
      if (!entry?.type || entry.rel === null) return fail('not_found')
      const real = joinIn(located.agentDir, entry.rel)
      const target: VaultTarget = {
        agentId: agentId as string,
        requested: path,
        real,
        kind: entry.type,
        inside: true,
        // The host's rule, on the realpath and on the name the renderer used.
        credential: isCredentialFilePath(real, located.agentDir) || isCredentialFilePath(requested, located.agentDir),
        vaultId: located.vaultId,
        agentDir: located.agentDir,
        rel: entry.rel
      }
      return target
    },

    async read(checked, { maxBytes, whole }) {
      const found = checked as VaultTarget
      try {
        // Whole: one byte past the cap, so a file over it shows as cut.
        const read = await deps.files().read(found.vaultId, found.real, { maxBytes: whole ? maxBytes + 1 : maxBytes })
        // The bytes are of what the vault opened: it must be the file stat
        // checked, and the credential rule holds on that path too.
        if (typeof read.rel !== 'string' || read.rel !== found.rel) {
          logger.warn('a vault file read answered for another path')
          return fail('not_found')
        }
        if (isCredentialFilePath(joinIn(found.agentDir, read.rel), found.agentDir)) return fail('credential_file')
        if (whole && (read.size > maxBytes || read.truncated)) return fail('too_large')
        return { success: true, bytes: read.bytes, size: read.size }
      } catch (err) {
        logger.warn('reading a vault file failed', { code: String((err as { code?: unknown })?.code ?? 'unknown') })
        return vaultFailure(err, 'read_failed')
      }
    },

    async exportFile(checked) {
      const found = checked as VaultTarget
      if (found.rel === '') return fail('unsupported', 'Use Export… on the agent’s Security tab to save the whole folder.')
      try {
        const saved = await deps.files().exportFile(found.vaultId, found.rel)
        logger.info('downloaded a vault file', { saved: saved !== null, kind: found.kind })
        return { success: true, savedTo: saved?.savedTo ?? null }
      } catch (err) {
        logger.warn('downloading a vault file failed', { code: String((err as { code?: unknown })?.code ?? 'unknown') })
        return vaultFailure(err, 'read_failed', 'Could not save a copy of the file.')
      }
    }
  }
}
