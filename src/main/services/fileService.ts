import { chatRepo } from '../db/chats'
import { cinnaFileService } from './cinnaFileService'
import { localFileStore, FileStoreError, guessLocalMime } from './fileStore'
import { chatFileRepo } from '../db/chatFiles'
import { FileError } from '../errors'
import { createLogger } from '../logger/logger'
import { createReadStream, createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import { basename } from 'path'
import { pipeline } from 'stream/promises'
import type { MessageAttachment, PendingAttachment } from '../../shared/attachments'

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
      if (!chatRepo.getOwned(userId, chatId)) {
        throw new FileError('chat_not_found', 'Chat not found')
      }
      const out: MessageAttachment[] = []
      for (const path of filePaths) {
        const att = await localFileStore.ingest({ userId, chatId, filePath: path })
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
      const row = chatFileRepo.getOwned(opts.userId, opts.attachmentId)
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
  }
}

// Re-export so importers don't have to know about the lower-level error class.
export { FileStoreError }
