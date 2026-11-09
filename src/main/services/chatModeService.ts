import { chatModeRepo, ChatModeRow, ChatModeUpsertInput } from '../db/chatModes'
import { managedOverrideRepo } from '../db/managedOverrides'
import { appSettingsRepo } from '../db/appSettings'
import { getDb } from '../db/client'
import { getManagedResourceScopes, getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { isManagedModeId } from '../llm/accountConfigTypes'
import { resolveDefaultModeId } from '../../shared/chatModeDefaults'
import { ChatModeError } from '../errors'
import {
  RUNTIME_MODE_ENGINES,
  RUNTIME_MODE_NAMES,
  RUNTIME_MODE_TAKES_CREDENTIAL,
  THEME_COLOR_PRESET_ID,
  runtimeModeDefaults,
  runtimeModeResetFields,
  supportsWorkspacePolicy
} from '../../shared/chatModeRuntime'
import { isWorkComplexity } from '../../shared/modelFamilies'
import type { AgentEngine } from '../../shared/engine'
import { createLogger } from '../logger/logger'

const logger = createLogger('chatmode')

/** A chat mode plus its effective local enable state (managed rows only). */
export interface ChatModeListItem extends ChatModeRow {
  /** False only when the user locally disabled an account-managed mode. */
  enabled: boolean
}

export interface ChatModeScope { profileUserId: string; settingsUserId: string }

/**
 * Marks that a shared (default scope) row has taken the colour. Not a profile id:
 * those are 21 characters. See {@link chatModeService.applyThemeDefaultOnce}.
 */
const SHARED_MODE_ADOPTED_KEY = 'shared'

/** Profiles already past the one-time adoption. Anything unreadable reads as none. */
function readBrandedDefaultModeProfiles(): Record<string, true> {
  const raw = appSettingsRepo.get('brandedDefaultModeProfiles')
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, true> = {}
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[userId] = true
    }
    return out
  } catch {
    return {}
  }
}

export const chatModeService = {
  list(userId: string): ChatModeRow[] {
    return chatModeRepo.list(userId)
  },

  /**
   * Modes visible to the active session: user-created (Default scope) plus
   * account-provisioned managed rows (active Profile scope). For managed rows
   * overlays the effective `enabled` AND the per-mode `modelId` from
   * `managed_overrides` (the user's local model choice wins over the synced
   * default), WITHOUT touching `isDefault` — the local and account defaults are
   * independent flags; precedence between them is resolved separately in
   * {@link resolveEffectiveDefault}. Backs the `chatmode:list` IPC.
   */
  listMerged(scope?: ChatModeScope): ChatModeListItem[] {
    const profileUserId = scope?.profileUserId ?? getProfileScopeUserId()
    const overrides = managedOverrideRepo.map(profileUserId)
    const userIds = scope ? [...new Set([scope.settingsUserId, scope.profileUserId])] : getManagedResourceScopes()
    return chatModeRepo.listByUserIds(userIds).map((r) => {
      if (!r.managed) return { ...r, enabled: true }
      const ov = overrides.get(`mode:${r.id}`)
      return { ...r, enabled: ov?.enabled ?? true, modelId: ov?.modelId ?? r.modelId }
    })
  },

  /**
   * Lookup a mode by id across Default + active Profile scope (managed-aware).
   * Applies the local model override for managed modes so chat start
   * (`chatmode:get`) uses the user's chosen model, not just the synced default.
   */
  findMerged(id: string): ChatModeRow | null {
    for (const scope of getManagedResourceScopes()) {
      const row = chatModeRepo.getOwned(scope, id)
      if (!row) continue
      if (!row.managed) return row
      const modelOverride = managedOverrideRepo.getModel(getProfileScopeUserId(), 'mode', row.id)
      return modelOverride ? { ...row, modelId: modelOverride } : row
    }
    return null
  },

  /**
   * The one effective default mode, honoring the local/account precedence toggle
   * (`prioritizeAccountDefaults`). Null when neither side has a default set.
   */
  resolveEffectiveDefault(scope?: ChatModeScope): ChatModeRow | null {
    const items = this.listMerged(scope)
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
   * Set the local model for a managed chat mode (per-profile override; survives
   * re-sync). `null` clears the override and reverts to the synced default. The
   * choice overlays the mode's `modelId` in {@link listMerged}/{@link findMerged}.
   */
  setManagedModel(id: string, modelId: string | null): void {
    const profileUserId = getProfileScopeUserId()
    const row = chatModeRepo.getOwned(profileUserId, id)
    if (!row || !row.managed) throw new ChatModeError('not_found', 'Managed chat mode not found')
    managedOverrideRepo.setModel(profileUserId, 'mode', id, modelId)
    logger.info('managed chat mode model set', { modeId: id, modelId })
  },

  /**
   * Create or update a chat mode. Enforces the single-default-per-user
   * invariant in one transaction: marking a mode as default clears the flag
   * on every other mode owned by the same user first.
   */
  upsert(userId: string, input: ChatModeUpsertInput): { id: string } {
    if (input.engine != null && !['claude', 'codex', 'opencode', 'antigravity'].includes(input.engine)) {
      throw new ChatModeError('invalid_value', 'Choose Default runtime, Claude, Codex, Antigravity, or OpenCode.')
    }
    if (input.toolPolicy !== undefined && input.toolPolicy !== 'none' && input.toolPolicy !== 'connectors' && input.toolPolicy !== 'workspace') {
      throw new ChatModeError('invalid_value', 'Choose Workspace, Connected tools or No tools.')
    }
    if (input.complexity != null && !isWorkComplexity(input.complexity)) {
      throw new ChatModeError('invalid_value', 'Choose Low, Medium or High effort.')
    }
    if (input.systemPrompt !== undefined && (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 100_000)) {
      throw new ChatModeError('invalid_value', 'Instructions must be text shorter than 100,000 characters.')
    }

    if (input.id && isManagedModeId(input.id)) {
      throw new ChatModeError(
        'read_only',
        'This chat mode is managed by your account and cannot be modified.'
      )
    }
    // Runtime modes are made by `ensureRuntimeModes` only; an upsert never creates one.
    const { builtinEngine: _ignored, ...fields } = input
    return getDb().transaction((tx) => {
      const existing = fields.id ? chatModeRepo.getOwned(userId, fields.id, tx) : undefined
      if (fields.id && !existing) throw new ChatModeError('not_found', 'Chat mode not found')
      if (existing?.builtinEngine) guardRuntimeModeEdit(existing, fields)
      const engine = fields.engine !== undefined ? fields.engine : existing?.engine ?? null
      if ((fields.toolPolicy ?? existing?.toolPolicy) === 'workspace' && !supportsWorkspacePolicy(engine)) {
        throw new ChatModeError('invalid_value', `Workspace is not available for ${engine ? RUNTIME_MODE_NAMES[engine] : 'the Default runtime'} yet.`)
      }

      if (fields.isDefault) {
        chatModeRepo.clearDefaults(userId, tx)
      }

      if (fields.id) {
        const updated = chatModeRepo.update(userId, fields.id, fields, tx)
        if (!updated) throw new ChatModeError('not_found', 'Chat mode not found')
        logger.info('chat mode updated', { modeId: fields.id })
        return { id: fields.id }
      }

      const { id } = chatModeRepo.insert(userId, fields, tx)
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
    if (chatModeRepo.getOwned(userId, id)?.builtinEngine) {
      throw new ChatModeError('read_only', 'A runtime mode cannot be deleted. Reset it to its defaults instead.')
    }
    const removed = chatModeRepo.delete(userId, id)
    if (removed) logger.info('chat mode deleted', { modeId: id })
  },

  /**
   * Create the user's four runtime modes — Claude Agent, Codex, Antigravity,
   * OpenCode — where missing. Every engine gets one whether or not it is set up
   * on this computer, so a chat's `modeId` stays valid while a runtime comes and
   * goes. Never starred. An existing row takes its engine's current name.
   * Idempotent, and safe when two calls race: the partial
   * unique index lets one insert per engine through and ignores the other.
   */
  ensureRuntimeModes(userId: string): void {
    for (const engine of RUNTIME_MODE_ENGINES) {
      const existing = chatModeRepo.getRuntimeMode(userId, engine)
      if (existing) {
        // The user cannot rename a runtime mode, so a renamed runtime must not
        // leave a row behind the name guard: it follows the current name.
        if (existing.name !== RUNTIME_MODE_NAMES[engine]) {
          chatModeRepo.setName(userId, existing.id, RUNTIME_MODE_NAMES[engine])
          logger.info('runtime mode renamed', { engine })
        }
        continue
      }
      const defaults = runtimeModeDefaults(engine)
      if (chatModeRepo.insertRuntimeModeIfMissing(userId, { ...defaults, builtinEngine: engine })) {
        logger.info('runtime mode created', { engine })
      }
    }
  },

  /**
   * Once per profile, when it first has a server brand: its effective default
   * mode takes the Theme Default colour, so the composer stops wearing an
   * engine's colour under the brand. The flag is what makes a colour the user
   * picks afterwards stick, through later syncs and a brand being unpublished
   * and republished. With no default yet the flag is still set: a mode starred
   * later carries a colour the user chose, and a default that core provisions
   * later is given the theme's at insert. A shared row is one row across
   * profiles, so it takes the colour once per installation, or the next branded
   * profile would undo what the user picked since. Writes through the repo because
   * `upsert` refuses managed ids, and on the row's own owner: a managed default is
   * the profile's, a shared one the default scope's. True only if a row changed,
   * which is when the renderer has something to refetch.
   */
  applyThemeDefaultOnce(userId: string): boolean {
    const adopted = readBrandedDefaultModeProfiles()
    if (adopted[userId]) return false
    const row = this.resolveEffectiveDefault({ profileUserId: userId, settingsUserId: getSettingsScopeUserId() })
    if (!row) {
      appSettingsRepo.set('brandedDefaultModeProfiles', JSON.stringify({ ...adopted, [userId]: true }))
      return false
    }
    const shared = row.userId !== userId
    const changed = row.colorPreset !== THEME_COLOR_PRESET_ID && !(shared && adopted[SHARED_MODE_ADOPTED_KEY])
    const next = { ...adopted, [userId]: true, ...(shared ? { [SHARED_MODE_ADOPTED_KEY]: true } : {}) }
    getDb().transaction((tx) => {
      if (changed) chatModeRepo.setColorPreset(row.userId, row.id, THEME_COLOR_PRESET_ID, tx)
      appSettingsRepo.set('brandedDefaultModeProfiles', JSON.stringify(next))
    })
    logger.info('default chat mode adopted the theme colour', { userId, modeId: row.id, changed })
    return changed
  },

  /**
   * Put a runtime mode back the way {@link ensureRuntimeModes} made it: name,
   * effort, tools, instructions and color from the defaults; no model, no
   * credential, no MCP servers. Whether it is the default is kept; for the colour
   * see {@link runtimeModeResetFields}.
   */
  reset(userId: string, id: string): void {
    const row = chatModeRepo.getOwned(userId, id)
    if (!row) throw new ChatModeError('not_found', 'Chat mode not found')
    if (!row.builtinEngine) throw new ChatModeError('read_only', 'Only a runtime mode can be reset to its defaults.')
    chatModeRepo.update(userId, id, { ...runtimeModeResetFields(row.builtinEngine, row), isDefault: row.isDefault })
    logger.info('runtime mode reset', { modeId: id, engine: row.builtinEngine })
  }
}

/**
 * What may not change on a runtime mode. The renderer saves whole rows, so the
 * incoming name and engine are compared with the stored ones rather than
 * refused for being present. OpenCode runs on an AI credential, so its runtime
 * mode may bind one; the other engines have none to bind.
 */
function guardRuntimeModeEdit(existing: ChatModeRow, input: ChatModeUpsertInput): void {
  const engine = existing.builtinEngine as AgentEngine
  if (input.name !== existing.name) throw new ChatModeError('read_only', 'A runtime mode keeps its name.')
  if (input.engine !== undefined && input.engine !== engine) {
    throw new ChatModeError('read_only', `This runtime mode always runs ${RUNTIME_MODE_NAMES[engine]}.`)
  }
  if (!RUNTIME_MODE_TAKES_CREDENTIAL[engine] && (input.providerId ?? null) !== null) {
    throw new ChatModeError('read_only', `${RUNTIME_MODE_NAMES[engine]} does not use an AI credential.`)
  }
}
