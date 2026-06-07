import { net } from 'electron'
import { basename, extname } from 'path'
import { readFile, stat } from 'fs/promises'
import { createWriteStream } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'
import { DomainError } from '../errors'
import type { MessageAttachment } from '../../shared/attachments'

const logger = createLogger('cinna-files')

/**
 * Common extensions the Cinna backend's MIME whitelist accepts. We send a
 * best-effort Content-Type so the backend's validator doesn't reject the
 * upload — anything unknown falls back to `application/octet-stream` and the
 * backend can still detect from magic bytes / filename if needed.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
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
  sh: 'application/x-sh',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export type CinnaFileErrorCode =
  | 'not_cinna_user'
  | 'missing_server_url'
  | 'reauth_required'
  | 'upload_failed'
  | 'delete_failed'
  | 'download_failed'
  | 'file_not_writable'
  | 'file_not_readable'

export class CinnaFileError extends DomainError<CinnaFileErrorCode> {}

/**
 * Shape returned by Cinna backend `POST /api/v1/files/upload` (subset).
 * The backend returns a FileUploadPublic — we only care about the four
 * fields that drive UI badges + the A2A metadata.
 */
interface CinnaFilePublic {
  id: string
  filename: string
  file_size: number
  mime_type: string
  status?: string
  uploaded_at?: string
}

function resolveBaseUrl(userId: string): string {
  const user = userRepo.get(userId)
  if (!user) throw new CinnaFileError('not_cinna_user', 'User not found')
  if (user.type !== 'cinna_user') {
    throw new CinnaFileError(
      'not_cinna_user',
      'File attachments are only supported for Cinna accounts'
    )
  }
  if (!user.cinnaServerUrl) {
    throw new CinnaFileError('missing_server_url', 'Cinna server URL is not configured')
  }
  return user.cinnaServerUrl.replace(/\/$/, '')
}

async function resolveAuthHeader(userId: string): Promise<string> {
  try {
    const token = await getCinnaAccessToken(userId)
    return `Bearer ${token}`
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      throw new CinnaFileError('reauth_required', err.message)
    }
    throw err
  }
}

/**
 * Backend upload + delete helpers for Cinna's file infrastructure. Files
 * uploaded here are "temporary" until referenced by a sent message — the
 * cinna-backend GCs orphaned temporaries after 24h.
 *
 * The renderer never sees the user's access token; this service runs only in
 * the main process and pulls tokens from the encrypted keystore on demand.
 */
export const cinnaFileService = {
  /**
   * Upload a file from local disk to the Cinna backend. Returns the condensed
   * {@link MessageAttachment} shape used by the renderer + persisted on the
   * user message so the badge can be re-rendered from history.
   */
  async uploadFromPath(userId: string, filePath: string): Promise<MessageAttachment> {
    const baseUrl = resolveBaseUrl(userId)
    const authHeader = await resolveAuthHeader(userId)

    let bytes: Buffer
    let size: number
    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        throw new CinnaFileError('file_not_readable', 'Not a regular file')
      }
      size = fileStat.size
      bytes = await readFile(filePath)
    } catch (err) {
      if (err instanceof CinnaFileError) throw err
      throw new CinnaFileError(
        'file_not_readable',
        `Could not read file: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const filename = basename(filePath)
    const mimeType = guessMimeType(filename)

    const form = new FormData()
    // `Blob` is a global in modern Node; fetch/undici handles multipart wiring.
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)

    const url = `${baseUrl}/api/v1/files/upload`
    logger.debug(`upload → ${url}`, { filename, size, mimeType })

    const started = Date.now()
    let response: Response
    try {
      response = await net.fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, Accept: 'application/json' },
        body: form
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`upload network error`, {
        url,
        error: msg,
        durationMs: Date.now() - started
      })
      throw new CinnaFileError('upload_failed', msg)
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      logger.error(`upload failed`, {
        url,
        status: response.status,
        body: bodyText.slice(0, 500),
        durationMs: Date.now() - started
      })
      throw new CinnaFileError(
        'upload_failed',
        `Upload failed (${response.status}): ${bodyText.slice(0, 200) || response.statusText}`
      )
    }

    const data = (await response.json()) as CinnaFilePublic
    logger.info('uploaded', {
      fileId: data.id,
      filename: data.filename,
      size: data.file_size,
      durationMs: Date.now() - started
    })
    return {
      id: data.id,
      filename: data.filename,
      size: data.file_size,
      mimeType: data.mime_type
    }
  },

  /**
   * Upload several files sequentially. Returns the list of successfully
   * uploaded attachments. The first failure aborts the loop and rethrows —
   * already-uploaded items in the partial result are returned via the
   * thrown {@link CinnaFileError}'s `detail` field as a JSON-encoded list
   * of ids so callers can decide whether to clean them up. Today callers
   * leave them for the backend's 24h GC.
   */
  async uploadMany(userId: string, filePaths: string[]): Promise<MessageAttachment[]> {
    const uploaded: MessageAttachment[] = []
    for (const filePath of filePaths) {
      try {
        const attachment = await this.uploadFromPath(userId, filePath)
        uploaded.push(attachment)
      } catch (err) {
        if (uploaded.length > 0 && err instanceof CinnaFileError) {
          logger.warn('uploadMany: partial failure', {
            uploadedCount: uploaded.length,
            remaining: filePaths.length - uploaded.length,
            error: err.message
          })
          throw new CinnaFileError(
            err.code,
            err.message,
            JSON.stringify(uploaded.map((a) => a.id))
          )
        }
        throw err
      }
    }
    return uploaded
  },

  /**
   * Download a previously-uploaded file from the Cinna backend and write it
   * to `destPath` on the local disk. The backend enforces access control via
   * the user's bearer token (owner OR session participant). Returns the
   * resolved size for log/telemetry; callers typically discard it.
   */
  async downloadToPath(
    userId: string,
    fileId: string,
    destPath: string
  ): Promise<{ bytes: number }> {
    const baseUrl = resolveBaseUrl(userId)
    const authHeader = await resolveAuthHeader(userId)
    const url = `${baseUrl}/api/v1/files/${fileId}/download`
    logger.debug(`download → ${url}`, { destPath })

    const started = Date.now()
    let response: Response
    try {
      response = await net.fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`download network error`, {
        url,
        error: msg,
        durationMs: Date.now() - started
      })
      throw new CinnaFileError('download_failed', msg)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.error(`download failed`, {
        url,
        status: response.status,
        body: body.slice(0, 200),
        durationMs: Date.now() - started
      })
      throw new CinnaFileError(
        'download_failed',
        `Download failed (${response.status}): ${body.slice(0, 200) || response.statusText}`
      )
    }

    if (!response.body) {
      logger.error(`download missing body`, { url, status: response.status })
      throw new CinnaFileError('download_failed', 'Empty response body')
    }

    // Stream the response straight to disk so we never hold the whole file in
    // memory — keeps the main process light even when the backend file size
    // cap rises. `pipeline` propagates errors from either end of the pipe.
    const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    const writeStream = createWriteStream(destPath)
    try {
      await pipeline(readable, writeStream)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`download stream error`, {
        url,
        destPath,
        error: msg,
        durationMs: Date.now() - started
      })
      // Network-side failures look like read errors here; disk-side failures
      // look like write errors. The Node stream API doesn't distinguish, so
      // we tag by destination existence rather than the message.
      throw new CinnaFileError(
        writeStream.bytesWritten === 0 ? 'download_failed' : 'file_not_writable',
        `Failed to save file: ${msg}`
      )
    }

    const bytes = writeStream.bytesWritten
    logger.info('downloaded', {
      fileId,
      destPath,
      bytes,
      durationMs: Date.now() - started
    })
    return { bytes }
  },

  /**
   * Fetch a previously-uploaded file's bytes into memory (capped at
   * `maxBytes`) for in-app preview. Unlike {@link downloadToPath} this never
   * touches disk — the small text formats the preview supports fit easily in
   * memory, and the cap keeps a mistakenly-previewed large file from blowing
   * up the main process. Access control is the same backend bearer check.
   */
  async readBytes(
    userId: string,
    fileId: string,
    maxBytes: number
  ): Promise<{ bytes: Buffer; truncated: boolean }> {
    const baseUrl = resolveBaseUrl(userId)
    const authHeader = await resolveAuthHeader(userId)
    const url = `${baseUrl}/api/v1/files/${fileId}/download`
    logger.debug(`read → ${url}`, { maxBytes })

    const started = Date.now()
    let response: Response
    try {
      response = await net.fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`read network error`, {
        url,
        error: msg,
        durationMs: Date.now() - started
      })
      throw new CinnaFileError('download_failed', msg)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.error(`read failed`, {
        url,
        status: response.status,
        body: body.slice(0, 200),
        durationMs: Date.now() - started
      })
      throw new CinnaFileError(
        'download_failed',
        `Download failed (${response.status}): ${body.slice(0, 200) || response.statusText}`
      )
    }

    const full = Buffer.from(await response.arrayBuffer())
    const truncated = full.length > maxBytes
    logger.info('read', {
      fileId,
      bytes: Math.min(full.length, maxBytes),
      truncated,
      durationMs: Date.now() - started
    })
    return { bytes: truncated ? full.subarray(0, maxBytes) : full, truncated }
  },

  /**
   * Download a task attachment (a `TaskAttachment` — distinct from the
   * `FileUpload` entity used by `downloadToPath`). Cinna's task attachments
   * live under a task-scoped endpoint with its own access-control path:
   *
   *   GET /api/v1/tasks/{taskId}/attachments/{attachmentId}/download
   *
   * The streaming + write logic mirrors `downloadToPath` — the only thing
   * that changes is the URL and the log scope.
   */
  async downloadTaskAttachmentToPath(
    userId: string,
    taskId: string,
    attachmentId: string,
    destPath: string
  ): Promise<{ bytes: number }> {
    const baseUrl = resolveBaseUrl(userId)
    const authHeader = await resolveAuthHeader(userId)
    const url = `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download`
    logger.debug(`task-attachment download → ${url}`, { destPath })

    const started = Date.now()
    let response: Response
    try {
      response = await net.fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`task-attachment download network error`, {
        url,
        error: msg,
        durationMs: Date.now() - started
      })
      throw new CinnaFileError('download_failed', msg)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.error(`task-attachment download failed`, {
        url,
        status: response.status,
        body: body.slice(0, 200),
        durationMs: Date.now() - started
      })
      throw new CinnaFileError(
        'download_failed',
        `Download failed (${response.status}): ${body.slice(0, 200) || response.statusText}`
      )
    }

    if (!response.body) {
      throw new CinnaFileError('download_failed', 'Empty response body')
    }

    const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    const writeStream = createWriteStream(destPath)
    try {
      await pipeline(readable, writeStream)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new CinnaFileError(
        writeStream.bytesWritten === 0 ? 'download_failed' : 'file_not_writable',
        `Failed to save file: ${msg}`
      )
    }

    const bytes = writeStream.bytesWritten
    logger.info('task attachment downloaded', {
      taskId,
      attachmentId,
      destPath,
      bytes,
      durationMs: Date.now() - started
    })
    return { bytes }
  },

  /**
   * Soft-delete a still-temporary file. Used when the user removes the badge
   * before sending — keeps the backend's storage quota honest.
   */
  async deleteFile(userId: string, fileId: string): Promise<void> {
    const baseUrl = resolveBaseUrl(userId)
    const authHeader = await resolveAuthHeader(userId)
    const url = `${baseUrl}/api/v1/files/${fileId}`
    logger.debug(`delete → ${url}`)
    const started = Date.now()
    let response: Response
    try {
      response = await net.fetch(url, {
        method: 'DELETE',
        headers: { Authorization: authHeader, Accept: 'application/json' }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`delete network error`, {
        url,
        error: msg,
        durationMs: Date.now() - started
      })
      throw new CinnaFileError('delete_failed', msg)
    }
    if (!response.ok && response.status !== 404) {
      const body = await response.text().catch(() => '')
      logger.warn(`delete failed`, {
        url,
        status: response.status,
        body: body.slice(0, 200),
        durationMs: Date.now() - started
      })
      throw new CinnaFileError(
        'delete_failed',
        `Delete failed (${response.status}): ${body.slice(0, 200) || response.statusText}`
      )
    }
    logger.info('deleted', { fileId, durationMs: Date.now() - started })
  }
}
