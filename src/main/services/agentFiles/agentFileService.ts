import { basename } from 'node:path'
import { createLogger } from '../../logger/logger'
import {
  IMAGE_TOO_LARGE_ERROR,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_PREVIEW_BYTES,
  decodePreviewText,
  previewKindFor,
  sniffPreviewImageMime
} from '../../../shared/filePreview'
import {
  MAX_AGENT_FILE_COPY_BYTES,
  MAX_AGENT_FILE_TEXT_BYTES,
  MAX_FILE_REF_CANDIDATES,
  agentFileContentKind,
  agentFilePreviewKindFor,
  type AgentFileActionResult,
  type AgentFileActions,
  type AgentFileFailure,
  type AuthorizeAgentFileResult,
  type DownloadAgentFileResult,
  type FileRefEntry,
  type ReadAgentFileImageResult,
  type ReadAgentFilePreviewResult,
  type ReadAgentFileTextResult,
  type ResolveAgentFileRefsInput,
  type ResolveAgentFileRefsResult
} from '../../../shared/agentFiles'
import type { ConsentPrompt } from './consent'
import {
  createFileSourceFor,
  fail,
  isFailure,
  refusingVaultSource,
  type AgentFileSource,
  type AgentFileTarget
} from './fileSource'
import { createHostFolderSource, type AgentFileBytesResult, type HostFolderSourceDeps } from './hostFolderSource'

export { isSafeAssetSegment, type AgentFileBytesResult } from './hostFolderSource'

const logger = createLogger('agent-files')

/** A longer candidate list from the renderer is cut here before it is walked. */
const MAX_RAW_CANDIDATES = MAX_FILE_REF_CANDIDATES * 4

/** A whole-file read refused over its cap, the shipped figure for that use named. */
function tooLarge(copy: boolean): AgentFileFailure {
  const cap = copy ? MAX_AGENT_FILE_COPY_BYTES : MAX_AGENT_FILE_TEXT_BYTES
  return fail('too_large', `This file is over ${cap / (1024 * 1024)} MB.`)
}

export interface AgentFileServiceDeps extends HostFolderSourceDeps {
  maxPreviewBytes?: number
  /** The **Save to Notes** cap. Defaults to {@link MAX_AGENT_FILE_TEXT_BYTES}. */
  maxTextBytes?: number
  /** The **Copy contents** cap. Defaults to {@link MAX_AGENT_FILE_COPY_BYTES}. */
  maxCopyBytes?: number
  /**
   * A vault agent's files (`vaultFileSource.ts`). Absent: a vault agent's
   * files are refused, as when nothing can reach inside a vault.
   */
  vaultSource?: AgentFileSource
}

/**
 * File references in an agent's chat: resolve, ask, preview, read, open,
 * reveal, download, and the HTML preview frame.
 *
 * Every call picks the agent's {@link AgentFileSource} — a folder on this
 * computer or an Agent Vault — and applies the rules every reference shares
 * on top of it: files only, never a credential file, the preview kinds and
 * the caps. An action the source does not offer is `unsupported`, whatever
 * the renderer asked.
 *
 * Failures are returned as data (`{ success: false, code }`); a thrown code
 * would not survive IPC.
 */
export function createAgentFileService(deps: AgentFileServiceDeps) {
  const maxPreviewBytes = deps.maxPreviewBytes ?? MAX_PREVIEW_BYTES
  const maxTextBytes = deps.maxTextBytes ?? MAX_AGENT_FILE_TEXT_BYTES
  const maxCopyBytes = deps.maxCopyBytes ?? MAX_AGENT_FILE_COPY_BYTES
  const host = createHostFolderSource(deps)
  const fileSourceFor = createFileSourceFor({ host, vault: deps.vaultSource ?? refusingVaultSource() })

  /** The source for the agent the untrusted input names, or `invalid_input`. */
  function sourceOf(input: unknown): AgentFileSource | AgentFileFailure {
    if (!input || typeof input !== 'object') return fail('invalid_input')
    const { agentId } = input as { agentId?: unknown }
    if (typeof agentId !== 'string' || agentId === '') return fail('invalid_input')
    return fileSourceFor(agentId)
  }

  /** The source and its checked target, when the source offers `action`. */
  async function checked(
    input: unknown,
    action: keyof AgentFileActions
  ): Promise<{ source: AgentFileSource; found: AgentFileTarget } | AgentFileFailure> {
    const source = sourceOf(input)
    if (isFailure(source)) return source
    if (!source.actions[action]) return fail('unsupported')
    const found = await source.stat(input)
    if (isFailure(found)) return found
    return { source, found }
  }

  return {
    async resolve(input: unknown): Promise<ResolveAgentFileRefsResult> {
      if (!input || typeof input !== 'object') return fail('invalid_input')
      const { agentId, entries } = input as Partial<ResolveAgentFileRefsInput>
      // From an untrusted renderer: anything but an array is no entries, and
      // an entry that is not `{ text: string, source: 'span' | 'link' }` is dropped.
      const list = (Array.isArray(entries) ? entries : [])
        .slice(0, MAX_RAW_CANDIDATES)
        .filter(
          (entry: unknown): entry is FileRefEntry =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as FileRefEntry).text === 'string' &&
            ((entry as FileRefEntry).source === 'span' || (entry as FileRefEntry).source === 'link')
        )
        .map(({ text, source }) => ({ text, source }))
      const source = sourceOf(input)
      if (isFailure(source)) return source
      return source.resolve(agentId as string, list)
    },

    /**
     * Whether the renderer may act on a path, asking the user when it is
     * outside the agent folder and not approved yet (a folder on this
     * computer). A source with nothing to ask approves what it can stat.
     */
    async authorize(input: unknown, prompt: ConsentPrompt): Promise<AuthorizeAgentFileResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      if (source.authorize) return source.authorize(input, prompt)
      const found = await source.stat(input)
      return isFailure(found) ? found : { success: true, approved: true }
    },

    async readPreview(input: unknown): Promise<ReadAgentFilePreviewResult> {
      const target = await checked(input, 'preview')
      if (isFailure(target)) return target
      const { source, found } = target
      if (found.kind !== 'file') return fail('not_a_file')
      if (found.credential) return fail('credential_file')
      if (!agentFilePreviewKindFor(basename(found.real))) return fail('not_previewable')
      const read = await source.read(found, { maxBytes: maxPreviewBytes, whole: false })
      if (!read.success) return read
      const truncated = read.size > maxPreviewBytes || read.bytes.length < read.size
      return {
        success: true,
        text: decodePreviewText(read.bytes, truncated),
        truncated,
        ...(truncated ? { shownBytes: read.bytes.length } : {})
      }
    },

    /**
     * An image, whole, as a `data:` URL typed by the bytes, for a source that
     * previews images (`previewImages`). Over the preview cap it is refused,
     * never cut. Kept in memory: nothing is written anywhere.
     */
    async readImage(input: unknown): Promise<ReadAgentFileImageResult> {
      const target = await checked(input, 'previewImages')
      if (isFailure(target)) return target
      const { source, found } = target
      if (found.kind !== 'file') return fail('not_a_file')
      if (found.credential) return fail('credential_file')
      if (previewKindFor(basename(found.real)) !== 'image') return fail('not_previewable')
      const read = await source.read(found, { maxBytes: MAX_IMAGE_PREVIEW_BYTES, whole: true })
      if (!read.success) return read.code === 'too_large' ? fail('too_large', IMAGE_TOO_LARGE_ERROR) : read
      const bytes = read.bytes.subarray(0, Math.min(read.bytes.length, read.size))
      const mimeType = sniffPreviewImageMime(bytes)
      if (!mimeType) return fail('not_previewable', 'This file is not an image the preview can show.')
      return { success: true, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType }
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
      const target = await checked(input, 'readText')
      if (isFailure(target)) return target
      const { source, found } = target
      if (found.kind !== 'file') return fail('not_a_file')
      if (found.credential) return fail('credential_file', 'Cinna does not read credential files.')
      if (agentFileContentKind(basename(found.real)) === 'binary') return fail('not_text')
      const read = await source.read(found, { maxBytes: cap, whole: true })
      if (!read.success) return read.code === 'too_large' ? tooLarge(copy) : read
      // Grew while being read, still under the cap: what was read is not the whole file.
      if (read.bytes.length > read.size) return fail('read_failed')
      const bytes = read.bytes
      if (bytes.includes(0)) return fail('not_text')
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return fail('not_text')
      }
      logger.info('read an agent file as text', { bytes: bytes.length, inside: found.inside })
      return { success: true, text }
    },

    /**
     * A reserved file at a fixed agent-relative path (`docs/AGENT_DETAILS.md`),
     * whole and as bytes, for a source that previews (a folder here or a
     * vault). Stricter than a reference: inside the agent folder only — an
     * approval for a path outside it does not count, and nothing asks — a
     * file, never a credential file. Over `maxBytes` it is `too_large`; the
     * caller decodes.
     */
    async readReservedFile(agentId: unknown, rel: string, maxBytes: number): Promise<AgentFileBytesResult> {
      if (typeof agentId !== 'string' || agentId === '') return fail('invalid_input')
      const source = sourceOf({ agentId })
      if (isFailure(source)) return source
      if (!source.actions.preview || !source.pathIn) return fail('unsupported')
      const path = source.pathIn(agentId, rel)
      if (typeof path !== 'string') return path
      const found = await source.stat({ agentId, path })
      if (isFailure(found)) return found
      if (!found.inside) return fail('not_found')
      if (found.kind !== 'file') return fail('not_a_file')
      if (found.credential) return fail('credential_file')
      const read = await source.read(found, { maxBytes, whole: true })
      if (!read.success) return read
      // Grew while being read, still under the cap: what was read is not the whole file.
      if (read.bytes.length > read.size) return fail('read_failed')
      return { success: true, bytes: read.bytes }
    },

    /** Open with the strategy the source picks. Never executes the file. */
    async open(input: unknown): Promise<AgentFileActionResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      if (!source.actions.open || !source.open) return fail('unsupported')
      return source.open(input)
    },

    /** An HTML file in the user's default web browser. */
    async openInBrowser(input: unknown): Promise<AgentFileActionResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      if (!source.actions.openInBrowser || !source.openInBrowser) return fail('unsupported')
      return source.openInBrowser(input)
    },

    /** Select the file (or folder) in Finder / Explorer. */
    async reveal(input: unknown): Promise<AgentFileActionResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      if (!source.actions.reveal || !source.reveal) return fail('unsupported')
      return source.reveal(input)
    },

    /**
     * **Download**: a copy of a file or folder saved where the user says,
     * behind the source's own gate (a vault asks for presence first). A
     * credential *file* is refused; a folder exports whole after approval,
     * credential files inside it included — the prompt names the folder.
     * The agent folder itself is the source's to refuse (a vault points to
     * Export… on its Security tab). `savedTo: null` when the save dialog was
     * cancelled.
     */
    async download(input: unknown): Promise<DownloadAgentFileResult> {
      const target = await checked(input, 'download')
      if (isFailure(target)) return target
      const { source, found } = target
      if (!source.exportFile) return fail('unsupported')
      if (found.credential) return fail('credential_file', 'Cinna does not copy credential files.')
      return source.exportFile(found)
    },

    /**
     * Whether an HTML file may be rendered in the preview frame: the same
     * gate as {@link readPreview} (containment or approval, never a
     * credential file), of the html kind. Never asks. A folder on this
     * computer only.
     */
    async htmlDocumentAccess(input: unknown): Promise<AgentFileActionResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      return source === host ? host.htmlDocumentAccess(input) : fail('unsupported')
    },

    /** The HTML document itself, whole, for the preview frame; over `maxBytes` it is refused. */
    async readHtmlDocument(input: unknown, maxBytes: number): Promise<AgentFileBytesResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      return source === host ? host.readHtmlDocument(input, maxBytes) : fail('unsupported')
    },

    /** A file the HTML document refers to relatively, for the preview frame (see the host source). */
    async readHtmlAsset(input: unknown, segments: unknown, maxBytes: number): Promise<AgentFileBytesResult> {
      const source = sourceOf(input)
      if (isFailure(source)) return source
      return source === host ? host.readHtmlAsset(input, segments, maxBytes) : fail('unsupported')
    }
  }
}

export type AgentFileService = ReturnType<typeof createAgentFileService>
