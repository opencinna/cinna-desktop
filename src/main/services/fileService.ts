import { cinnaFileService } from './cinnaFileService'
import { localFileStore, FileStoreError, guessLocalMime } from './fileStore'
import { visibleChat, visibleChatFile } from '../auth/chatScope'
import { FileError } from '../errors'
import { createLogger } from '../logger/logger'
import { createReadStream, createWriteStream } from 'fs'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, isAbsolute, join } from 'path'
import { pipeline } from 'stream/promises'
import type { MessageAttachment, PendingAttachment } from '../../shared/attachments'
import {
  IMAGE_TOO_LARGE_ERROR,
  MAX_IMAGE_PREVIEW_BYTES,
  THUMBNAIL_MAX_SIDE,
  THUMBNAIL_ORIGINAL_MAX_BYTES,
  decodePreviewText
} from '../../shared/filePreview'
import { pathGuard } from './pathGuard'
import { runtimeHost } from '../host/runtimeHost'

const logger = createLogger('file-service')

export type FileScope = 'cinna' | 'local'

/** Renderer-supplied strings narrowed before the IPC layer routes anything. */
export function assertFileScope(value: unknown): asserts value is FileScope {
  if (value !== 'cinna' && value !== 'local') {
    throw new FileError(
      'invalid_scope',
      `Unknown file scope: ${String(value)}. Expected 'cinna' or 'local'.`
    )
  }
}

export interface IngestInput {
  userId: string
  scope: FileScope
  /** Required for `local` scope (the store needs a chat to attach to). */
  chatId: string | null
  filePaths: string[]
}

/**
 * Single chokepoint for the file pipeline. The IPC layer hands the service
 * a typed input, the service:
 *
 *  - Verifies chat ownership for local-scope ingest (the renderer can
 *    supply any chatId — we can't trust it).
 *  - Dispatches to the right backing store.
 *  - Returns a uniform {@link MessageAttachment}[] with `source` stamped.
 *
 * Adapters / streaming code never touch `cinnaFileService` or
 * `localFileStore` directly — everything goes through here so adding a
 * third store (provider Files API offload) is a one-place change.
 */
export const fileService = {
  /**
   * Inspect a list of OS paths and return badge-ready metadata without
   * uploading or copying anything. Used by the new-chat composer to hold
   * pending attachments until the chat row exists and a destination is
   * known. The returned attachments carry `source: 'pending'` and `id`
   * set to the absolute path — they're swapped for real attachments at
   * `fileService.ingest` time.
   */
  async resolvePaths(paths: string[]): Promise<PendingAttachment[]> {
    const out: PendingAttachment[] = []
    for (const path of paths) {
      try {
        const s = await stat(path)
        if (!s.isFile()) {
          logger.debug('skipping non-file path', { path })
          continue
        }
        const filename = basename(path)
        out.push({
          id: path,
          filename,
          size: s.size,
          mimeType: guessLocalMime(filename),
          source: 'pending'
        })
      } catch (err) {
        logger.warn('could not resolve path', {
          path,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    logger.info('resolved paths', { in: paths.length, out: out.length })
    return out
  },

  async ingest(input: IngestInput): Promise<MessageAttachment[]> {
    const { userId, scope, chatId, filePaths } = input
    if (scope === 'local') {
      if (!chatId) {
        throw new FileError(
          'missing_chat_id',
          'A chat must be created before attaching local files'
        )
      }
      // Ownership check: the renderer supplies chatId; we never trust it
      // for a write that creates rows + on-disk blobs under that chat's
      // directory. Without this check a compromised renderer could
      // pollute arbitrary chat directories.
      // Stored under the chat's owner, which for a chat shared across
      // profiles is the default profile, not the one attaching.
      const chat = visibleChat(userId, chatId)
      if (!chat) {
        throw new FileError('chat_not_found', 'Chat not found')
      }
      const out: MessageAttachment[] = []
      for (const path of filePaths) {
        const att = await localFileStore.ingest({ userId: chat.userId, chatId, filePath: path })
        out.push(att)
      }
      logger.info('local files ingested', { chatId, count: out.length })
      return out
    }

    // Cinna scope: delegate to the existing service. `uploadMany` already
    // handles partial-failure with embedded ids; we only need to stamp
    // the source discriminator so downstream consumers don't have to
    // infer from absence.
    const files = await cinnaFileService.uploadMany(userId, filePaths)
    logger.info('cinna files ingested', { count: files.length })
    return files.map((f) => ({ ...f, source: 'cinna' as const }))
  },

  /**
   * Materialize in-memory content as real attachments by routing it through
   * the same {@link ingest} pipeline used for picked / dropped files. Writes
   * each item to a fresh temp dir, calls `ingest`, then cleans up — so the
   * synthetic blobs are never visible outside this method.
   *
   * Used by features that produce attachment-shaped content from non-file
   * sources (today: notes attached via the `?` mention popup). The
   * filename passed in is treated as a basename — any path separators are
   * stripped — and is what the downstream store / Cinna backend records.
   */
  async ingestSyntheticContent(opts: {
    userId: string
    scope: FileScope
    chatId: string | null
    items: { filename: string; content: string | Buffer }[]
  }): Promise<MessageAttachment[]> {
    if (opts.items.length === 0) return []
    // Mirror `ingest`'s pre-check so we don't pay the mkdtemp cost just to
    // throw on a scope/chat mismatch.
    if (opts.scope === 'local' && !opts.chatId) {
      throw new FileError(
        'missing_chat_id',
        'A chat must be created before attaching local files'
      )
    }
    const started = Date.now()
    const dir = await mkdtemp(join(tmpdir(), 'cinna-synth-'))
    try {
      const paths: string[] = []
      for (const item of opts.items) {
        const safeName = basename(item.filename) || 'attachment'
        const target = join(dir, safeName)
        await writeFile(target, item.content)
        paths.push(target)
      }
      const files = await this.ingest({
        userId: opts.userId,
        scope: opts.scope,
        chatId: opts.chatId,
        filePaths: paths
      })
      logger.info('synthetic content ingested', {
        scope: opts.scope,
        chatId: opts.chatId,
        count: files.length,
        durationMs: Date.now() - started
      })
      return files
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  },

  /**
   * Remove a single attachment from its backing store. Idempotent —
   * already-removed attachments resolve successfully so callers don't
   * have to special-case races (renderer X click during chat switch).
   */
  async remove(opts: {
    userId: string
    attachmentId: string
    source: FileScope
  }): Promise<void> {
    if (opts.source === 'local') {
      await localFileStore.remove({
        userId: opts.userId,
        attachment: {
          id: opts.attachmentId,
          filename: '',
          size: 0,
          mimeType: '',
          source: 'local'
        }
      })
      return
    }
    await cinnaFileService.deleteFile(opts.userId, opts.attachmentId)
  },

  /**
   * Stream an attachment's bytes to `destPath`. Encapsulates the
   * local-vs-Cinna routing and the disk-to-disk copy for the local case
   * so the IPC handler stays a thin save-dialog → service-call → reveal
   * sequence.
   */
  async downloadToPath(opts: {
    userId: string
    attachmentId: string
    source: FileScope
    destPath: string
  }): Promise<void> {
    if (opts.source === 'local') {
      const row = visibleChatFile(opts.userId, opts.attachmentId)
      if (!row) throw new FileError('not_found', 'Local attachment not found')
      try {
        await pipeline(
          createReadStream(row.storagePath),
          createWriteStream(opts.destPath)
        )
      } catch (err) {
        throw new FileError(
          'read_failed',
          `Could not copy local file: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      return
    }
    await cinnaFileService.downloadToPath(opts.userId, opts.attachmentId, opts.destPath)
  },

  /**
   * Read an attachment's bytes (capped at `maxBytes`) and decode as UTF-8 for
   * in-app preview. Routes by source like {@link downloadToPath} but keeps
   * everything in memory — the preview supports only small text formats, and
   * the cap protects against a mistakenly-previewed large file. Decoding is
   * lossy-tolerant: invalid byte sequences become the replacement character
   * rather than throwing, so a previewed non-UTF-8 file still renders
   * something instead of erroring.
   */
  async readTextPreview(opts: {
    userId: string
    attachmentId: string
    source: FileScope
    maxBytes: number
  }): Promise<{ text: string; truncated: boolean }> {
    const { bytes, truncated } = await fileService.readBytes(opts)
    return { text: decodePreviewText(bytes, truncated), truncated }
  },

  /**
   * An attachment's bytes, capped at `maxBytes`, in memory: the local store
   * behind the ownership-scoped row, or the Cinna backend with the user's
   * bearer. The read behind {@link readTextPreview} and the HTML preview frame.
   */
  async readBytes(opts: {
    userId: string
    attachmentId: string
    source: FileScope
    maxBytes: number
  }): Promise<{ bytes: Buffer; truncated: boolean }> {
    let bytes: Buffer
    let truncated = false
    if (opts.source === 'local') {
      const row = visibleChatFile(opts.userId, opts.attachmentId)
      if (!row) throw new FileError('not_found', 'Local attachment not found')
      try {
        const full = await readFile(row.storagePath)
        truncated = full.length > opts.maxBytes
        bytes = truncated ? full.subarray(0, opts.maxBytes) : full
      } catch (err) {
        throw new FileError(
          'read_failed',
          `Could not read local file: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    } else {
      const read = await cinnaFileService.readBytes(
        opts.userId,
        opts.attachmentId,
        opts.maxBytes
      )
      bytes = read.bytes
      truncated = read.truncated
    }
    return { bytes, truncated }
  }
}

/**
 * The MIME type of an image the preview can show, from its first bytes (PNG,
 * JPEG, GIF, WebP, BMP, and SVG by its root element); null for anything else.
 * Sniffed rather than taken from the name or the renderer, so the `data:` URL
 * main hands back always says what the bytes are.
 */
export function sniffPreviewImageMime(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number): string =>
    bytes.length >= to ? String.fromCharCode(...bytes.subarray(from, to)) : ''
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096))
  if (/<svg[\s>]/i.test(head) && !/<html[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

function imageDataUrl(bytes: Buffer): { dataUrl: string; mimeType: string } {
  const mimeType = sniffPreviewImageMime(bytes)
  if (!mimeType) throw new FileError('not_previewable', 'This file is not an image the preview can show.')
  return { dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType }
}

/**
 * A renderer-supplied path is read only when the user surfaced it this session
 * — a file dialog, a drop or a paste recorded it in {@link pathGuard}. The
 * composer's files not yet sent are the only reason to read by path.
 */
function assertSurfacedPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || !pathGuard.isAllowed(path)) {
    throw new FileError('not_allowed', 'This file is no longer available to preview. Attach it again.')
  }
}

async function statFile(path: string): Promise<number> {
  return (await statFileFull(path)).size
}

async function statFileFull(path: string): Promise<{ size: number; mtimeMs: number }> {
  try {
    const s = await stat(path)
    if (!s.isFile()) throw new FileError('not_a_file', 'Only files can be previewed.')
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch (err) {
    if (err instanceof FileError) throw err
    throw new FileError('not_found', 'The file is no longer there.')
  }
}

async function readSurfacedImageBytes(path: string, size: number): Promise<Buffer> {
  if (size > MAX_IMAGE_PREVIEW_BYTES) throw new FileError('too_large', IMAGE_TOO_LARGE_ERROR)
  try {
    return await readFile(path)
  } catch (err) {
    throw new FileError('read_failed', `Could not read the file: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Previews read before a file is sent: the composer holds a new chat's files
 * as paths until the chat exists. Same caps and decoder as an attachment's.
 */
export const pathPreview = {
  async readText(path: unknown, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    assertSurfacedPath(path)
    const size = await statFile(path)
    const length = Math.min(size, maxBytes)
    const handle = await open(path, 'r')
    try {
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, 0)
      const truncated = size > maxBytes
      return { text: decodePreviewText(bytes.subarray(0, bytesRead), truncated), truncated }
    } catch (err) {
      throw new FileError('read_failed', `Could not read the file: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await handle.close()
    }
  },

  async readImage(path: unknown): Promise<{ dataUrl: string; mimeType: string }> {
    assertSurfacedPath(path)
    const size = await statFile(path)
    return imageDataUrl(await readSurfacedImageBytes(path, size))
  }
}

async function readImageAttachmentBytes(opts: {
  userId: string
  attachmentId: string
  source: FileScope
}): Promise<Buffer> {
  if (opts.source === 'local') {
    // Refuse a large local file before reading it all into memory.
    const row = visibleChatFile(opts.userId, opts.attachmentId)
    if (!row) throw new FileError('not_found', 'Local attachment not found')
    const size = await stat(row.storagePath).then((s) => s.size, () => 0)
    if (size > MAX_IMAGE_PREVIEW_BYTES) throw new FileError('too_large', IMAGE_TOO_LARGE_ERROR)
  }
  const { bytes, truncated } = await fileService.readBytes({ ...opts, maxBytes: MAX_IMAGE_PREVIEW_BYTES })
  if (truncated) throw new FileError('too_large', IMAGE_TOO_LARGE_ERROR)
  return bytes
}

/** Thumbnails already made, by what they were made from; oldest dropped first. */
const THUMBNAIL_CACHE_ENTRIES = 200
const thumbnailCache = new Map<string, { dataUrl: string; mimeType: string }>()

/** Test-only. */
export function _resetThumbnailCache(): void {
  thumbnailCache.clear()
}

function thumbnailOf(bytes: Buffer): { dataUrl: string; mimeType: string } {
  const mimeType = sniffPreviewImageMime(bytes)
  if (!mimeType) throw new FileError('not_previewable', 'This file is not an image the preview can show.')
  let small: { bytes: Buffer; mimeType: string } | null = null
  if (mimeType !== 'image/svg+xml') {
    try {
      small = runtimeHost.images?.thumbnail(bytes, THUMBNAIL_MAX_SIDE) ?? null
    } catch {
      small = null
    }
  }
  if (small) return { dataUrl: `data:${small.mimeType};base64,${small.bytes.toString('base64')}`, mimeType: small.mimeType }
  if (bytes.length <= THUMBNAIL_ORIGINAL_MAX_BYTES) return imageDataUrl(bytes)
  throw new FileError('not_previewable', 'No thumbnail for this image.')
}

/**
 * A small image for the inline thumbnails: the same reads and gates as
 * {@link readImageAttachment} and {@link pathPreview.readImage}, scaled by the
 * host to fit {@link THUMBNAIL_MAX_SIDE}. An image the host cannot scale is
 * sent as it is up to {@link THUMBNAIL_ORIGINAL_MAX_BYTES}, else refused.
 * Kept in memory by attachment, or by path, size and modification time.
 */
export async function readThumbnail(
  input: { userId: string; attachmentId: string; source: FileScope } | { path: unknown }
): Promise<{ dataUrl: string; mimeType: string }> {
  let key: string
  let read: () => Promise<Buffer>
  if ('path' in input) {
    const path = input.path
    assertSurfacedPath(path)
    const { size, mtimeMs } = await statFileFull(path)
    key = `path\0${path}\0${size}\0${mtimeMs}`
    read = () => readSurfacedImageBytes(path, size)
  } else {
    key = `${input.userId}\0${input.source}\0${input.attachmentId}`
    read = () => readImageAttachmentBytes(input)
  }
  const hit = thumbnailCache.get(key)
  if (hit) {
    thumbnailCache.delete(key)
    thumbnailCache.set(key, hit)
    return hit
  }
  const thumbnail = thumbnailOf(await read())
  thumbnailCache.set(key, thumbnail)
  while (thumbnailCache.size > THUMBNAIL_CACHE_ENTRIES) thumbnailCache.delete(thumbnailCache.keys().next().value as string)
  return thumbnail
}

/**
 * An image attachment as a `data:` URL, for the preview: the same
 * ownership-scoped read as {@link fileService.readBytes}, refused rather than
 * cut above {@link MAX_IMAGE_PREVIEW_BYTES}.
 */
export async function readImageAttachment(opts: {
  userId: string
  attachmentId: string
  source: FileScope
}): Promise<{ dataUrl: string; mimeType: string }> {
  return imageDataUrl(await readImageAttachmentBytes(opts))
}

// Re-export so importers don't have to know about the lower-level error class.
export { FileStoreError }
