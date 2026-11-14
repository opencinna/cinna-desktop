/**
 * Attachments in a vault chat (D23: nothing of a vault chat stays on this
 * computer). A vault agent gets its attachments inline in the prompt
 * (`attachmentUploadsDir` returns null for it): text files, PDFs and Office
 * files as their text, and images as ACP image blocks. Both are then part of the engine's session
 * inside the vault and of the message row in the vault transcript.
 *
 * The composer still stores a picked, dropped or pasted file in `userData`
 * before the send (`fileService.ingest`), because that is where the prompt
 * builder reads it from. So for a vault chat:
 * - anything that could not go inline (an archive, a video, a binary) is refused
 *   at ingest, before a byte is written ({@link vaultChatAccepts});
 * - a pasted image's own copy under `userData/tmp/pasted/` is deleted as soon
 *   as it is ingested;
 * - the stored copies are kept apart, under `userData/vault/chat-files/`
 *   ({@link vaultChatFilesDir}), not with ordinary chats' files;
 * - they are deleted when the turn that sent them ends, whatever its outcome
 *   or however early it stops ({@link discardVaultChatFiles}, from the
 *   `finally` around the whole agent turn). The message row keeps the name
 *   and size; the bytes live on only inside the vault;
 * - copies no turn took (a draft never sent, a turn cut by a quit or a crash)
 *   go when their vault locks ({@link sweepVaultChatFiles} with its id) and
 *   at every start (the whole directory, and every vault chat's file rows);
 * - an ingest of several files that fails part way removes what it copied.
 */
import { rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { MessageAttachment } from '../../shared/attachments'
import { chatFileRepo } from '../db/chatFiles'
import { chatVaultId } from '../db/chats'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { isTextExtractableMime } from '../services/textExtractor'

const logger = createLogger('vault-files')

/** What the user reads when a file cannot go into a vault chat. */
export const VAULT_FILE_REFUSED = "This kind of file can't be sent into a vault yet; paste the text instead."

/** Images the Claude adapter takes as native image blocks. */
const VAULT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Whether a file of `mimeType` can be sent into a vault chat: inline text, or an inline image. */
export function vaultChatAccepts(mimeType: string): boolean {
  return VAULT_IMAGE_MIMES.has(mimeType) || isTextExtractableMime(mimeType)
}

/**
 * Delete the `userData` copies of a vault chat's attachments once the turn
 * that sent them is over. A no-op for any other chat. Never throws.
 */
export async function discardVaultChatFiles(profileUserId: string, chatId: string, attachments: readonly MessageAttachment[] | undefined): Promise<void> {
  if (!attachments?.length) return
  let vaultChat = false
  try {
    vaultChat = chatVaultId(chatId) !== null
  } catch {
    return
  }
  if (!vaultChat) return
  const { fileService } = await import('../services/fileService')
  // Every vault chat attachment is a local-store one (ingest refuses nothing else for a
  // local agent's chat); a remove of an id the store does not hold is a no-op.
  for (const attachment of attachments) {
    await fileService.remove({ userId: profileUserId, attachmentId: attachment.id, source: 'local' }).catch((error: unknown) =>
      logger.warn('could not delete a vault chat attachment copy', { error: error instanceof Error ? error.message : String(error) }))
  }
}

/** Where every vault chat's attachment copies are kept until their turn ends: swept wholesale at start. */
export function vaultChatFilesRoot(): string {
  return join(runtimeHost.getPath('userData'), 'vault', 'chat-files')
}

/** One vault chat's attachment copies. */
export function vaultChatFilesDir(userId: string, chatId: string): string {
  return join(vaultChatFilesRoot(), userId, chatId)
}

/**
 * Delete the attachment copies of vault chats that no turn took: of one
 * vault when it locks, or (no `vaultId`, at start, before any turn) of
 * every vault chat plus the whole {@link vaultChatFilesRoot}. A draft
 * attached while its vault was open loses its copy at the lock; the vault is
 * locked then, and nothing can be sent into it until it is opened again.
 * Never throws; resolves with the number of rows removed.
 */
export async function sweepVaultChatFiles(vaultId?: string): Promise<number> {
  let removed = 0
  try {
    const rows = chatFileRepo.listOfVaultChats(vaultId)
    for (const row of rows) {
      await unlink(row.storagePath).catch(() => {})
      if (chatFileRepo.delete(row.userId, row.id)) removed++
    }
    // One vault: each of its chats' directories; at start, everything.
    const dirs = vaultId === undefined ? [vaultChatFilesRoot()] : [...new Set(rows.map((row) => vaultChatFilesDir(row.userId, row.chatId)))]
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
    if (removed > 0) logger.info('removed vault chat attachment copies', { vaultId: vaultId ?? 'all', count: removed })
  } catch (error) {
    logger.warn('could not sweep vault chat attachment copies', { error: error instanceof Error ? error.message : String(error) })
  }
  return removed
}
