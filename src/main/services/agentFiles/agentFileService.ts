import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DomainError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { isPlausiblePath, isWithin } from '../localAgents/pathRules'
import { MAX_PREVIEW_BYTES, decodePreviewText } from '../../../shared/filePreview'
import {
  MAX_AGENT_FILE_COPY_BYTES,
  MAX_AGENT_FILE_TEXT_BYTES,
  MAX_FILE_REF_CANDIDATES,
  agentFileContentKind,
  agentFilePreviewKindFor,
  isCredentialFilePath,
  type AgentFileActionResult,
  type AgentFileConsentPurpose,
  type AgentFileErrorCode,
  type AgentFileFailure,
  type AgentFilePathInput,
  type AgentFileRefKind,
  type AuthorizeAgentFileResult,
  type ReadAgentFilePreviewResult,
  type ReadAgentFileTextResult,
  type ResolveAgentFileRefsInput,
  type ResolveAgentFileRefsResult
} from '../../../shared/agentFiles'
import type { DetectedTool } from '../../../shared/localTools'
import { createPathCanonicalizer, type PathCanonicalizer } from './canonicalPath'
import type { ConsentPrompt, ConsentRegistry } from './consent'
import { chooseOpenStrategy } from './openStrategy'
import { homeDisplayPath, resolveFileRefs } from './resolver'

const logger = createLogger('agent-files')

/** A longer candidate list from the renderer is cut here before it is walked. */
const MAX_RAW_CANDIDATES = MAX_FILE_REF_CANDIDATES * 4

const MESSAGES: Record<AgentFileErrorCode, string> = {
  invalid_input: 'Nothing to open.',
  agent_not_found: 'That agent is no longer in your agents folder.',
  not_found: 'That file is no longer there.',
  needs_consent: 'Cinna needs your approval to use a file outside the agent folder.',
  credential_file: 'Preview is off for credential files.',
  not_previewable: 'No preview for this file type.',
  not_a_file: 'That is a folder, not a file.',
  read_failed: 'Could not read the file.',
  launch_failed: 'Could not open the file.',
  too_large: 'This file is too large.',
  not_text: "This isn't a text file."
}

/** A whole-file read refused over its cap, the shipped figure for that use named. */
function tooLarge(copy: boolean): AgentFileFailure {
  const cap = copy ? MAX_AGENT_FILE_COPY_BYTES : MAX_AGENT_FILE_TEXT_BYTES
  return fail('too_large', `This file is over ${cap / (1024 * 1024)} MB.`)
}

function fail(code: AgentFileErrorCode, error: string = MESSAGES[code]): AgentFileFailure {
  return { success: false, code, error }
}

function isFailure(value: object): value is AgentFileFailure {
  return 'success' in value && (value as { success: unknown }).success === false
}

export interface AgentFileServiceDeps {
  /** The folder behind a folder agent id. Throws when there is none. */
  locateAgent: (agentId: string) => string
  /** The agent's display name for the consent dialog. */
  agentName: (agentId: string) => string
  /** The profile-scope user approvals are keyed by. */
  getConsentUserId: () => string
  consent: ConsentRegistry
  platform: NodeJS.Platform
  /** `isGuardedLocation`: a path behind a macOS privacy prompt, never probed while resolving. */
  isGuardedLocation: (path: string) => boolean
  /** Defaults to the real data-volume rule for {@link platform}. */
  paths?: PathCanonicalizer
  home?: string
  maxPreviewBytes?: number
  /** The **Save to Notes** cap. Defaults to {@link MAX_AGENT_FILE_TEXT_BYTES}. */
  maxTextBytes?: number
  /** The **Copy contents** cap. Defaults to {@link MAX_AGENT_FILE_COPY_BYTES}. */
  maxCopyBytes?: number
  getDefaultEditor: () => Promise<(DetectedTool & { path: string }) | null>
  launchEditor: (tool: DetectedTool & { path: string }, target: string, cwd: string) => Promise<void>
  /** `shell.openPath`: resolves to an error string, empty on success. */
  openPath: (path: string) => Promise<string>
  openInTextEditor: (path: string) => Promise<void>
  showItemInFolder: (path: string) => void
  /** The user's default web browser on this file (see `openInBrowser.ts`), not the `.html` default app. */
  openInBrowser: (path: string) => Promise<void>
}

/**
 * An agent file's bytes for the HTML preview frame. Served by main over the
 * `cinna-preview:` scheme; never sent over IPC.
 */
export type AgentFileBytesResult = { success: true; bytes: Buffer } | AgentFileFailure

/**
 * One segment of a path the preview frame asked for, already URL-decoded.
 * Refuses anything that could climb out of or restart the path — separators,
 * a drive or stream colon, NUL — and any segment starting with a dot: `.` and
 * `..`, and every dotfile or dot-folder (`.env*`, `.git`, `.ssh`, `.claude`),
 * which a page has no business loading.
 */
export function isSafeAssetSegment(segment: string): boolean {
  return segment !== '' && !segment.startsWith('.') && !/[/\\:\0]/.test(segment)
}

interface Target {
  agentId: string
  /** The path as the renderer named it. */
  requested: string
  realAgentDir: string
  /** Canonical realpath. */
  real: string
  kind: AgentFileRefKind
  /** The stat that passed the checks, to catch a swap before the file is used. */
  identity: { dev: number; ino: number }
  inside: boolean
  userId: string
}

/**
 * Inline file references in a folder agent's chat: resolve, ask, preview,
 * open, reveal.
 *
 * **The renderer names paths; main decides.** The agent folder comes from the
 * index row, never from the renderer, and every read, open and reveal re-checks
 * that the realpath is inside that folder or that the user approved it in a
 * native dialog main showed — a renderer cannot assert consent. Approvals are
 * in memory only. Outside paths are never logged, only their length.
 *
 * Every realpath is canonical ({@link createPathCanonicalizer}), so a macOS
 * data-volume spelling cannot step around a containment, credential or home
 * rule.
 *
 * Failures are returned as data (`{ success: false, code }`); a thrown code
 * would not survive IPC.
 */
export function createAgentFileService(deps: AgentFileServiceDeps) {
  const maxPreviewBytes = deps.maxPreviewBytes ?? MAX_PREVIEW_BYTES
  const maxTextBytes = deps.maxTextBytes ?? MAX_AGENT_FILE_TEXT_BYTES
  const maxCopyBytes = deps.maxCopyBytes ?? MAX_AGENT_FILE_COPY_BYTES
  const paths = deps.paths ?? createPathCanonicalizer({ platform: deps.platform })
  const home = (): string => deps.home ?? homedir()
  /** One dialog per (user, path) at a time: a second click waits for the first answer. */
  const asking = new Map<string, Promise<AuthorizeAgentFileResult>>()

  function locate(agentId: unknown): string | AgentFileFailure {
    if (typeof agentId !== 'string' || agentId === '') return fail('invalid_input')
    try {
      return deps.locateAgent(agentId)
    } catch (err) {
      return fail('agent_not_found', err instanceof DomainError ? err.message : undefined)
    }
  }

  async function target(input: unknown): Promise<Target | AgentFileFailure> {
    if (!input || typeof input !== 'object') return fail('invalid_input')
    const { agentId, path } = input as Partial<AgentFilePathInput>
    if (!isPlausiblePath(path)) return fail('invalid_input')
    const agentDir = locate(agentId)
    if (typeof agentDir !== 'string') return agentDir
    let realAgentDir: string
    try {
      realAgentDir = await paths.realpath(agentDir)
    } catch {
      return fail('agent_not_found')
    }
    try {
      const real = await paths.realpath(path)
      const info = await stat(real)
      const kind: AgentFileRefKind | null = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
      if (!kind) return fail('not_found')
      return {
        agentId: agentId as string,
        requested: path,
        realAgentDir,
        real,
        kind,
        identity: { dev: info.dev, ino: info.ino },
        inside: isWithin(realAgentDir, real),
        userId: deps.getConsentUserId()
      }
    } catch {
      return fail('not_found')
    }
  }

  /** Inside the folder, or approved by this profile; otherwise `needs_consent`. */
  async function permitted(input: unknown): Promise<Target | AgentFileFailure> {
    const found = await target(input)
    if (isFailure(found)) return found
    if (found.inside || deps.consent.isApproved(found.userId, found.real)) return found
    logger.warn('refused an outside path without approval', { pathLength: found.real.length })
    return fail('needs_consent')
  }

  /** Checked on the realpath and on the name the renderer used, either spelling. */
  function isCredential(found: Target): boolean {
    return (
      isCredentialFilePath(found.real, found.realAgentDir) ||
      isCredentialFilePath(paths.lexical(found.requested), found.realAgentDir)
    )
  }

  /**
   * Reads what was checked, at most `maxBytes`: the identity is compared once
   * the file is open (a swap since the check is `not_found`), and a file over
   * the cap is refused as `too_large` rather than cut.
   */
  async function readChecked(found: Target, maxBytes: number): Promise<AgentFileBytesResult> {
    try {
      const handle = await open(found.real, 'r')
      try {
        const opened = await handle.stat()
        if (opened.dev !== found.identity.dev || opened.ino !== found.identity.ino) {
          logger.warn('an agent file changed between its check and its read', { pathLength: found.real.length })
          return fail('not_found')
        }
        if (opened.size > maxBytes) return fail('too_large', 'This file is too large to show.')
        // One byte past the size: a file that grew past the cap since the stat is refused too.
        const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        if (offset > maxBytes) return fail('too_large', 'This file is too large to show.')
        return { success: true, bytes: buffer.subarray(0, offset) }
      } finally {
        await handle.close()
      }
    } catch (err) {
      logger.warn('reading an agent file failed', { error: err instanceof Error ? err.name : 'unknown' })
      return fail('read_failed')
    }
  }

  /** An HTML file the preview frame may render: permitted, a file, not a credential, of the html kind. */
  async function htmlDocument(input: unknown): Promise<Target | AgentFileFailure> {
    const found = await permitted(input)
    if (isFailure(found)) return found
    if (found.kind !== 'file') return fail('not_a_file')
    if (isCredential(found)) return fail('credential_file')
    if (agentFilePreviewKindFor(basename(found.requested)) !== 'html') return fail('not_previewable')
    return found
  }

  async function ask(found: Target, prompt: ConsentPrompt, purpose: AgentFileConsentPurpose): Promise<AuthorizeAgentFileResult> {
    const dir = found.kind === 'dir' ? found.real : dirname(found.real)
    const offerDir = deps.consent.canApproveDirectory(dir)
    const realHome = await paths.realpath(home()).catch(() => resolve(home()))
    const answer = await prompt({
      agentName: deps.agentName(found.agentId),
      kind: found.kind,
      path: found.real,
      dir,
      displayPath: homeDisplayPath(found.real, realHome),
      displayDir: homeDisplayPath(dir, realHome),
      offerDir,
      purpose,
      previewable:
        found.kind === 'file' && agentFilePreviewKindFor(basename(found.real)) !== null && !isCredential(found)
    })
    if (answer.approved) {
      deps.consent.approvePath(found.userId, found.real)
      if (answer.rememberDir && offerDir) deps.consent.approveDirectory(found.userId, dir)
    }
    logger.info('asked about a path outside an agent folder', {
      pathLength: found.real.length,
      approved: answer.approved,
      rememberDir: answer.approved && answer.rememberDir && offerDir
    })
    return { success: true, approved: answer.approved }
  }

  return {
    async resolve(input: unknown): Promise<ResolveAgentFileRefsResult> {
      if (!input || typeof input !== 'object') return fail('invalid_input')
      const { agentId, candidates } = input as Partial<ResolveAgentFileRefsInput>
      if (!Array.isArray(candidates)) return fail('invalid_input')
      const agentDir = locate(agentId)
      if (typeof agentDir !== 'string') return agentDir
      const refs = await resolveFileRefs(agentDir, candidates.slice(0, MAX_RAW_CANDIDATES), {
        home: home(),
        isGuarded: deps.isGuardedLocation,
        paths
      })
      logger.debug('resolved file refs', { candidates: candidates.length, refs: refs.length })
      return { success: true, refs }
    },

    /**
     * Whether the renderer may act on a path, asking the user when it is
     * outside the agent folder and not approved yet. Inside paths and earlier
     * approvals answer without a dialog; a second call for a path already being
     * asked about waits for that dialog instead of opening another.
     */
    async authorize(input: unknown, prompt: ConsentPrompt): Promise<AuthorizeAgentFileResult> {
      const found = await target(input)
      if (isFailure(found)) return found
      if (found.inside || deps.consent.isApproved(found.userId, found.real)) {
        return { success: true, approved: true }
      }
      const key = `${found.userId}\0${found.real}`
      let pending = asking.get(key)
      if (!pending) {
        // Approvals are shared across purposes: a dialog already open for the
        // same path answers this call too, in whichever words it was asked.
        const purpose: AgentFileConsentPurpose =
          (input as { purpose?: unknown }).purpose === 'read' ? 'read' : 'show'
        pending = ask(found, prompt, purpose).finally(() => asking.delete(key))
        asking.set(key, pending)
      }
      return pending
    },

    async readPreview(input: unknown): Promise<ReadAgentFilePreviewResult> {
      const found = await permitted(input)
      if (isFailure(found)) return found
      if (found.kind !== 'file') return fail('not_a_file')
      if (isCredential(found)) return fail('credential_file')
      if (!agentFilePreviewKindFor(basename(found.real))) return fail('not_previewable')
      try {
        const handle = await open(found.real, 'r')
        try {
          const opened = await handle.stat()
          // Swapped between the check and the open (a rename, a new symlink):
          // what is open now is not what was checked.
          if (opened.dev !== found.identity.dev || opened.ino !== found.identity.ino) {
            logger.warn('an agent file changed between its check and its read', {
              pathLength: found.real.length
            })
            return fail('not_found')
          }
          const { size } = opened
          const length = Math.min(size, maxPreviewBytes)
          const buffer = Buffer.alloc(length)
          let offset = 0
          while (offset < length) {
            const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
            if (bytesRead === 0) break
            offset += bytesRead
          }
          const truncated = size > maxPreviewBytes
          return {
            success: true,
            text: decodePreviewText(buffer.subarray(0, offset), truncated),
            truncated
          }
        } finally {
          await handle.close()
        }
      } catch (err) {
        logger.warn('reading an agent file failed', { error: err instanceof Error ? err.name : 'unknown' })
        return fail('read_failed')
      }
    },

    /**
     * The whole file as text, for **Copy contents** and **Save to Notes**. The
     * same gate as {@link readPreview} — containment or approval, files only,
     * never a credential file, the identity checked again once open — but
     * never truncated: a file over the cap — larger for `use: 'copy'` than
     * for a note — is refused as `too_large`, and a binary type, invalid UTF-8
     * or a NUL byte as `not_text`.
     */
    async readText(input: unknown): Promise<ReadAgentFileTextResult> {
      const copy = (input as { use?: unknown } | null)?.use === 'copy'
      const cap = copy ? maxCopyBytes : maxTextBytes
      const found = await permitted(input)
      if (isFailure(found)) return found
      if (found.kind !== 'file') return fail('not_a_file')
      if (isCredential(found)) return fail('credential_file', 'Cinna does not read credential files.')
      if (agentFileContentKind(basename(found.real)) === 'binary') return fail('not_text')
      try {
        const handle = await open(found.real, 'r')
        try {
          const opened = await handle.stat()
          if (opened.dev !== found.identity.dev || opened.ino !== found.identity.ino) {
            logger.warn('an agent file changed between its check and its read', {
              pathLength: found.real.length
            })
            return fail('not_found')
          }
          if (opened.size > cap) return tooLarge(copy)
          // One byte past the opened size, so a small file does not hold the
          // whole cap: a file that grew since the stat fills that byte and is
          // refused below rather than cut short.
          const buffer = Buffer.allocUnsafe(Math.min(opened.size, cap) + 1)
          let offset = 0
          while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
            if (bytesRead === 0) break
            offset += bytesRead
          }
          if (offset > cap) return tooLarge(copy)
          // Grew while being read, still under the cap: what was read is not the whole file.
          if (offset > opened.size) return fail('read_failed')
          const bytes = buffer.subarray(0, offset)
          if (bytes.includes(0)) return fail('not_text')
          let text: string
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          } catch {
            return fail('not_text')
          }
          logger.info('read an agent file as text', { bytes: offset, inside: found.inside })
          return { success: true, text }
        } finally {
          await handle.close()
        }
      } catch (err) {
        logger.warn('reading an agent file failed', { error: err instanceof Error ? err.name : 'unknown' })
        return fail('read_failed')
      }
    },

    /** Open with the strategy {@link chooseOpenStrategy} picks. Never executes the file. */
    async open(input: unknown): Promise<AgentFileActionResult> {
      const found = await permitted(input)
      if (isFailure(found)) return found
      const editor = found.kind === 'file' ? await deps.getDefaultEditor().catch(() => null) : null
      const strategy = chooseOpenStrategy({
        kind: found.kind,
        filename: basename(found.real),
        platform: deps.platform,
        hasDefaultEditor: editor !== null
      })
      // Re-taken right before the launch: the path must still lead where it
      // led when it was checked.
      const now = await paths.realpath(found.requested).catch(() => null)
      if (now !== found.real) {
        logger.warn('an agent file changed between its check and its launch', { strategy })
        return fail('launch_failed')
      }
      try {
        if (strategy === 'editor' && editor) {
          await deps.launchEditor(editor, found.real, dirname(found.real))
        } else if (strategy === 'default-app') {
          const refusal = await deps.openPath(found.real)
          if (refusal) {
            logger.warn('the default app refused an agent file', { reasonLength: refusal.length })
            return fail('launch_failed', 'No app could open this file.')
          }
        } else if (strategy === 'text-editor') {
          await deps.openInTextEditor(found.real)
        } else {
          deps.showItemInFolder(found.real)
        }
      } catch (err) {
        // The error message can carry the path (execFile quotes its argv).
        logger.warn('opening an agent file failed', {
          strategy,
          error: err instanceof Error ? err.name : 'unknown'
        })
        return fail('launch_failed')
      }
      logger.info('opened an agent file', { strategy, inside: found.inside })
      return { success: true }
    },

    /**
     * Whether an HTML file may be rendered in the preview frame: the same
     * gate as {@link readPreview} (containment or approval, never a
     * credential file), of the html kind. Never asks.
     */
    async htmlDocumentAccess(input: unknown): Promise<AgentFileActionResult> {
      const found = await htmlDocument(input)
      return isFailure(found) ? found : { success: true }
    },

    /** The HTML document itself, whole, for the preview frame; over `maxBytes` it is refused. */
    async readHtmlDocument(input: unknown, maxBytes: number): Promise<AgentFileBytesResult> {
      const found = await htmlDocument(input)
      if (isFailure(found)) return found
      return readChecked(found, maxBytes)
    },

    /**
     * A file the HTML document refers to relatively (`style.css`,
     * `img/x.png`, `data.json`), for the preview frame. `segments` are the
     * URL path's decoded segments, resolved against the document's real
     * folder. Refused unless it stays inside that folder after its realpath
     * (a `..` or a symlink out is refused), passes the same containment or
     * approval check as any agent file — never asking — is a file, and is not
     * a credential file.
     */
    async readHtmlAsset(input: unknown, segments: unknown, maxBytes: number): Promise<AgentFileBytesResult> {
      const document = await htmlDocument(input)
      if (isFailure(document)) return document
      if (
        !Array.isArray(segments) ||
        segments.length === 0 ||
        !segments.every((segment) => typeof segment === 'string' && isSafeAssetSegment(segment))
      ) {
        return fail('invalid_input')
      }
      const root = dirname(document.real)
      const candidate = join(root, ...(segments as string[]))
      if (!isWithin(root, candidate)) return fail('invalid_input')
      const asset = await permitted({ agentId: document.agentId, path: candidate })
      if (isFailure(asset)) return asset
      if (!isWithin(root, asset.real)) {
        logger.warn('refused a preview asset outside its document folder', { pathLength: asset.real.length })
        return fail('not_found')
      }
      if (asset.kind !== 'file') return fail('not_a_file')
      if (isCredential(asset)) return fail('credential_file')
      return readChecked(asset, maxBytes)
    },

    /**
     * An HTML file in the user's default web browser. The same gate as the
     * preview frame, with the realpath re-taken right before the launch, as
     * {@link open} does.
     */
    async openInBrowser(input: unknown): Promise<AgentFileActionResult> {
      const found = await htmlDocument(input)
      if (isFailure(found)) return found
      const now = await paths.realpath(found.requested).catch(() => null)
      if (now !== found.real) {
        logger.warn('an agent file changed between its check and its launch', { strategy: 'browser' })
        return fail('launch_failed')
      }
      try {
        await deps.openInBrowser(found.real)
      } catch (err) {
        // The error message can carry the path (execFile quotes its argv).
        logger.warn('opening an agent file in the browser failed', {
          error: err instanceof Error ? err.name : 'unknown'
        })
        return fail('launch_failed', 'No browser could open this file.')
      }
      logger.info('opened an agent file', { strategy: 'browser', inside: found.inside })
      return { success: true }
    },

    /** Select the file (or folder) in Finder / Explorer. */
    async reveal(input: unknown): Promise<AgentFileActionResult> {
      const found = await permitted(input)
      if (isFailure(found)) return found
      try {
        deps.showItemInFolder(found.real)
      } catch (err) {
        logger.warn('revealing an agent file failed', { error: err instanceof Error ? err.name : 'unknown' })
        return fail('launch_failed', 'Could not show the file in its folder.')
      }
      logger.info('revealed an agent file', { inside: found.inside })
      return { success: true }
    }
  }
}

export type AgentFileService = ReturnType<typeof createAgentFileService>
