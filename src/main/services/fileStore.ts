import { app } from 'electron'
import { join, basename, extname } from 'path'
import { mkdir, readFile, stat, writeFile, unlink } from 'fs/promises'
import { nanoid } from 'nanoid'
import { chatFileRepo } from '../db/chatFiles'
import { createLogger } from '../logger/logger'
import { DomainError } from '../errors'
import { extractText, isTextExtractableMime } from './textExtractor'
import type { MessageAttachment } from '../../shared/attachments'
import type { MediaPart } from '../llm/types'

const logger = createLogger('file-store')

export type FileStoreErrorCode =
  | 'not_found'
  | 'read_failed'
  | 'write_failed'
  | 'unsupported_source'

export class FileStoreError extends DomainError<FileStoreErrorCode> {}

/**
 * Minimal MIME guesser shared by the local store. Mirrors the table in
 * `cinnaFileService` for the formats we care about today; falls back to
 * `application/octet-stream` for anything unknown. Kept local instead of
 * imported to keep the two services independently evolvable — the Cinna
 * backend enforces its own whitelist, while the local store is permissive.
 */
const MIME_BY_EXT: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  // PDFs + Office binary formats
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  // Plain-text & structured-text
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  ts: 'application/typescript',
  py: 'text/x-python',
  sh: 'application/x-sh'
}

function guessMime(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Public alias — `fileService` uses this to label pending attachments
 *  with a best-effort MIME before ingestion happens. */
export const guessLocalMime = guessMime

function mimeToKind(mime: string): MediaPart['kind'] {
  if (mime.startsWith('image/')) return 'image'
  return 'document'
}

/**
 * Backing-store interface. Each implementation knows how to ingest a local
 * file path into an opaque `MessageAttachment` and how to read the bytes
 * back later (when an adapter needs them). Adapters are kept ignorant of
 * which store is behind a given attachment — they receive resolved
 * {@link MediaPart}s only.
 */
export interface FileStore {
  /**
   * Persist a local file into the store and return the attachment DTO that
   * the renderer keeps in the composer / persists on the message row.
   */
  ingest(opts: { userId: string; chatId: string; filePath: string }): Promise<MessageAttachment>
  /**
   * Resolve an attachment back to bytes + filename + mime. Throws when the
   * attachment is unknown or unreadable so the caller can degrade gracefully
   * (drop the part, log, keep streaming).
   */
  read(opts: { userId: string; attachment: MessageAttachment }): Promise<{
    bytes: Buffer
    mimeType: string
    filename: string
  }>
  /**
   * Remove a previously-ingested file from the store. No-op if it's already
   * gone — callers rely on idempotent deletes.
   */
  remove(opts: { userId: string; attachment: MessageAttachment }): Promise<void>
}

/**
 * Local on-disk store under `userData/files/<userId>/<chatId>/<id><ext>`.
 * Bytes never leave the machine; ideal for raw-LLM chats where the model
 * receives the file inline (base64) on every turn.
 */
class LocalFileStore implements FileStore {
  private rootDir(): string {
    return join(app.getPath('userData'), 'files')
  }

  private resolveChatDir(userId: string, chatId: string): string {
    return join(this.rootDir(), userId, chatId)
  }

  async ingest({
    userId,
    chatId,
    filePath
  }: {
    userId: string
    chatId: string
    filePath: string
  }): Promise<MessageAttachment> {
    let bytes: Buffer
    let size: number
    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        throw new FileStoreError('read_failed', 'Not a regular file')
      }
      size = fileStat.size
      bytes = await readFile(filePath)
    } catch (err) {
      if (err instanceof FileStoreError) throw err
      throw new FileStoreError(
        'read_failed',
        `Could not read file: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const filename = basename(filePath)
    const mimeType = guessMime(filename)
    const id = nanoid()
    const dir = this.resolveChatDir(userId, chatId)
    const storagePath = join(dir, `${id}${extname(filename)}`)

    try {
      await mkdir(dir, { recursive: true })
      await writeFile(storagePath, bytes)
    } catch (err) {
      throw new FileStoreError(
        'write_failed',
        `Could not write file to store: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    chatFileRepo.insert({
      id,
      userId,
      chatId,
      storagePath,
      mimeType,
      size,
      filename
    })

    logger.info('local file ingested', { id, chatId, size, mimeType })
    return { id, filename, size, mimeType, source: 'local' }
  }

  async read({
    userId,
    attachment
  }: {
    userId: string
    attachment: MessageAttachment
  }): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
    const row = chatFileRepo.getOwned(userId, attachment.id)
    if (!row) throw new FileStoreError('not_found', `Local file ${attachment.id} not found`)
    let bytes: Buffer
    try {
      bytes = await readFile(row.storagePath)
    } catch (err) {
      throw new FileStoreError(
        'read_failed',
        `Could not read stored file: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return { bytes, mimeType: row.mimeType, filename: row.filename }
  }

  async remove({
    userId,
    attachment
  }: {
    userId: string
    attachment: MessageAttachment
  }): Promise<void> {
    const row = chatFileRepo.getOwned(userId, attachment.id)
    if (!row) return
    try {
      await unlink(row.storagePath)
    } catch {
      // The on-disk blob may already be gone (manual cleanup, prior crash).
      // The row still needs to disappear so the metadata stays consistent.
    }
    chatFileRepo.delete(userId, attachment.id)
  }
}

/**
 * Cinna-backed store. Today only used for the remote-agent A2A flow — the
 * actual upload/download lives in `cinnaFileService`. This wrapper exposes
 * the same `FileStore` shape so future code can swap on `source` without
 * reaching into the legacy service.
 */
class CinnaFileStoreImpl implements FileStore {
  async ingest(): Promise<MessageAttachment> {
    // The Cinna ingest path is owned by `cinnaFileService.uploadFromPath`
    // because the upload is multipart, async, and produces server-side ids
    // we don't want to duplicate here. The FileStore router (below) sends
    // `'cinna'`-scoped ingests directly to that service.
    throw new FileStoreError(
      'unsupported_source',
      'CinnaFileStore.ingest is delegated to cinnaFileService'
    )
  }

  async read(): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
    // Reading Cinna bytes for inline LLM use would require streaming from
    // the backend — out of scope for the local-LLM file feature. When we
    // add provider Files API offload, this is where it goes.
    throw new FileStoreError(
      'unsupported_source',
      'Reading Cinna-sourced files into media parts is not supported yet'
    )
  }

  async remove(): Promise<void> {
    throw new FileStoreError(
      'unsupported_source',
      'CinnaFileStore.remove is delegated to cinnaFileService'
    )
  }
}

export const localFileStore: FileStore = new LocalFileStore()
export const cinnaFileStore: FileStore = new CinnaFileStoreImpl()

/**
 * Resolve the store that owns a given attachment. Falls back to Cinna for
 * legacy rows that pre-date the `source` discriminator.
 */
export function resolveFileStore(attachment: MessageAttachment): FileStore {
  return attachment.source === 'local' ? localFileStore : cinnaFileStore
}

/**
 * Convert an attachment to an adapter-ready {@link MediaPart}. The MIME's
 * route is decided here so adapters never inspect raw bytes:
 *
 *  - Image MIME → `image` part (bytes pass through).
 *  - Native non-image MIME (PDF on Anthropic/Gemini) → `document` part.
 *  - Otherwise text-extractable (text/*, code, CSV, office binaries, PDF
 *    on text-only providers) → run extractor, return `text` part.
 *  - Anything else → drop with a warning.
 *
 * Adapters declare what they natively accept; the resolver picks the route
 * accordingly. Failure modes (oversize, read failure, extractor error)
 * become a returned `null` — the streaming loop drops the part and the
 * turn continues with the user's text alone.
 */
export async function attachmentToMediaPart(
  attachment: MessageAttachment,
  opts: {
    userId: string
    acceptedMimeTypes: string[]
    nativeMimeTypes: string[]
    maxFileSizeBytes: number
  }
): Promise<MediaPart | null> {
  if (!opts.acceptedMimeTypes.includes(attachment.mimeType)) {
    logger.debug('drop attachment: mime not accepted', {
      id: attachment.id,
      mime: attachment.mimeType
    })
    return null
  }
  if (attachment.size > opts.maxFileSizeBytes) {
    logger.warn('drop attachment: size exceeds limit', {
      id: attachment.id,
      size: attachment.size,
      limit: opts.maxFileSizeBytes
    })
    return null
  }

  const store = resolveFileStore(attachment)
  let bytes: Buffer
  let mimeType: string
  let filename: string
  try {
    const read = await store.read({ userId: opts.userId, attachment })
    bytes = read.bytes
    mimeType = read.mimeType
    filename = read.filename
  } catch (err) {
    logger.warn('drop attachment: read failed', {
      id: attachment.id,
      source: attachment.source ?? 'cinna',
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }

  // Native bytes-through path. Images always take this branch; non-image
  // native MIMEs (PDF on Anthropic/Gemini today) become a `document` part.
  if (opts.nativeMimeTypes.includes(mimeType)) {
    const kind = mimeToKind(mimeType)
    if (kind === 'image') {
      return { kind: 'image', mimeType, bytes, filename }
    }
    return { kind: 'document', mimeType, bytes, filename }
  }

  // Text-extracted fallback. Adapter accepted this MIME but doesn't take
  // raw bytes for it, so we run the extractor and emit a `text` part the
  // adapter can inline into the user message.
  if (isTextExtractableMime(mimeType)) {
    const text = await extractText(bytes, mimeType, filename)
    if (text === null) return null
    return { kind: 'text', mimeType, text, filename }
  }

  logger.warn('drop attachment: accepted but no extraction path', {
    id: attachment.id,
    mime: mimeType
  })
  return null
}
