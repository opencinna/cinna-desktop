import { chatModeRepo, ChatModeRow, ChatModeUpsertInput } from '../db/chatModes'
import { managedOverrideRepo } from '../db/managedOverrides'
import { appSettingsRepo } from '../db/appSettings'
import { getDb } from '../db/client'
import { getManagedResourceScopes, getProfileScopeUserId } from '../auth/scope'
import { isManagedModeId } from '../llm/accountConfigTypes'
import { resolveDefaultModeId } from '../../shared/chatModeDefaults'
import { ChatModeError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('chatmode')

/** A chat mode plus its effective local enable state (managed rows only). */
export interface ChatModeListItem extends ChatModeRow {
  /** False only when the user locally disabled an account-managed mode. */
  enabled: boolean
}

export const chatModeService = {
  list(userId: string): ChatModeRow[] {
    return chatModeRepo.list(userId)
  },

  /**
   * Modes visible to the active session: user-created (Default scope) plus
   * account-provisioned managed rows (active Profile scope). Overlays the
   * effective `enabled` from `managed_overrides` (managed rows only) WITHOUT
   * touching `isDefault` — the local and account defaults are independent flags;
   * precedence between them is resolved separately in
   * {@link resolveEffectiveDefault}. Backs the `chatmode:list` IPC.
   */
  listMerged(): ChatModeListItem[] {
    const profileUserId = getProfileScopeUserId()
    const overrides = managedOverrideRepo.map(profileUserId)
    return chatModeRepo.listByUserIds(getManagedResourceScopes()).map((r) => ({
      ...r,
      enabled: r.managed ? overrides.get(`mode:${r.id}`) ?? true : true
    }))
  },

  /** Lookup a mode by id across Default + active Profile scope (managed-aware). */
  findMerged(id: string): ChatModeRow | null {
    for (const scope of getManagedResourceScopes()) {
      const row = chatModeRepo.getOwned(scope, id)
      if (row) return row
    }
    return null
  },

  /**
   * The one effective default mode, honoring the local/account precedence toggle
   * (`prioritizeAccountDefaults`). Null when neither side has a default set.
   */
  resolveEffectiveDefault(): ChatModeRow | null {
    const items = this.listMerged()
    const prioritize = appSettingsRepo.get('prioritizeAccountDefaults')
    const id = resolveDefaultModeId(items, prioritize)
    return id ? items.find((i) => i.id === id) ?? null : null
  },

  get(userId: string, id: string): ChatModeRow | null {
    return chatModeRepo.getOwned(userId, id) ?? null
  },

  /**
   * Toggle a managed chat mode on/off locally (per-profile override; survives
   * re-sync). A disabled managed mode drops out of the picker and yields the
   * effective default back to the local default.
   */
  setManagedEnabled(id: string, enabled: boolean): void {
    const profileUserId = getProfileScopeUserId()
    const row = chatModeRepo.getOwned(profileUserId, id)
    if (!row || !row.managed) throw new ChatModeError('not_found', 'Managed chat mode not found')
    managedOverrideRepo.set(profileUserId, 'mode', id, enabled)
    logger.info('managed chat mode toggled', { modeId: id, enabled })
  },

  /**
   * Create or update a chat mode. Enforces the single-default-per-user
   * invariant in one transaction: marking a mode as default clears the flag
   * on every other mode owned by the same user first.
   */
  upsert(userId: string, input: ChatModeUpsertInput): { id: string } {
    if (input.id && isManagedModeId(input.id)) {
      throw new ChatModeError(
        'read_only',
        'This chat mode is managed by your account and cannot be modified.'
      )
    }
    return getDb().transaction((tx) => {
      if (input.isDefault) {
        chatModeRepo.clearDefaults(userId, tx)
      }

      if (input.id) {
        const updated = chatModeRepo.update(userId, input.id, input, tx)
        if (!updated) throw new ChatModeError('not_found', 'Chat mode not found')
        logger.info('chat mode updated', { modeId: input.id })
        return { id: input.id }
      }

      const { id } = chatModeRepo.insert(userId, input, tx)
      logger.info('chat mode created', { modeId: id })
      return { id }
    })
  },

  delete(userId: string, id: string): void {
    if (isManagedModeId(id)) {
      throw new ChatModeError(
        'read_only',
        'This chat mode is managed by your account and cannot be deleted.'
      )
    }
    const removed = chatModeRepo.delete(userId, id)
    if (removed) logger.info('chat mode deleted', { modeId: id })
  }
}
