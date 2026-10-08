import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'
import { DEFAULT_USER_ID } from '../../../shared/userIds'

/**
 * Marker row for {@link shareLocalAgentChats}. Not an `AppSettingsSchema` key,
 * so `appSettingsRepo.getAll` never surfaces it.
 */
export const SHARE_LOCAL_AGENT_CHATS_MARKER = '__migration.shareLocalAgentChats'

/**
 * One-time repair: hand chats that talk only to machine-local agents back to
 * the default profile, so they are listed in every profile.
 *
 * Until this fix the new-chat flow stamped the user's default chat mode on
 * every chat, including the ones that never use it — a `direct` chat rooted on
 * an agent and every `human` chat talk straight to their agents. When that
 * default was an account-managed mode, `ownerForBinding` (chatService) saw a
 * profile-managed mode and kept the chat in the signed-in profile.
 *
 * A chat moves when all of these hold, mirroring `ownerForBinding` with the
 * mode and credential taken away:
 *
 * - it is owned by a profile, not the default, and the user opened it
 *   (`origin = 'user'`); trashed chats included;
 * - `showLocalDataInAllProfiles` is not stored as `false` — with the setting
 *   off, chats stay where they were started;
 * - it is not conducted: `router = 'human'`, or `direct` with a root agent;
 * - it has at least one agent, and every one of them (the root plus every
 *   on-demand agent) is a machine-local agent: owned by the default profile,
 *   not `remote:`, and neither a development agent nor a chat conductor.
 *
 * A moved chat loses `mode_id`, `provider_id` and `model_id` (none of them
 * ever applied to it), and its conductor runtime rows and local attachment
 * rows follow it to the new owner, as `chatRepo.reassignOwner` does. The
 * attachment bytes stay where they are: every reader goes through
 * `chat_files.storage_path`, which is absolute.
 *
 * Tasks, handovers, delegations and job rows are the profile's by design
 * (`auth/chatScope.ts`) and are not touched.
 *
 * Runs exactly once per database: the marker row is written on every path,
 * fresh installs and the setting-off case included.
 */
export function shareLocalAgentChats(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'app_settings')) return
  const done = sqlite.prepare('SELECT 1 AS done FROM app_settings WHERE key = ?').get(SHARE_LOCAL_AGENT_CHATS_MARKER)
  if (done) return

  sqlite.transaction(() => {
    if (localDataInAllProfiles(sqlite) && schemaReady(sqlite)) {
      for (const chat of candidateChats(sqlite)) {
        if (!onlyLocalAgents(sqlite, chat)) continue
        moveToDefault(sqlite, chat)
      }
    }
    sqlite
      .prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(SHARE_LOCAL_AGENT_CHATS_MARKER, JSON.stringify('done'), Math.floor(Date.now() / 1000))
  })()
}

interface CandidateChat {
  id: string
  userId: string
  agentId: string | null
}

/** The setting as `appSettingsRepo.get` reads it: only a stored `false` is off. */
function localDataInAllProfiles(sqlite: Database.Database): boolean {
  const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('showLocalDataInAllProfiles') as
    | { value: string }
    | undefined
  if (!row) return true
  try {
    return JSON.parse(row.value) !== false
  } catch {
    return true
  }
}

function schemaReady(sqlite: Database.Database): boolean {
  return (
    hasTable(sqlite, 'chats') &&
    hasTable(sqlite, 'agents') &&
    hasTable(sqlite, 'chat_on_demand_agents') &&
    hasColumn(sqlite, 'chats', 'user_id') &&
    hasColumn(sqlite, 'chats', 'origin') &&
    hasColumn(sqlite, 'chats', 'router') &&
    hasColumn(sqlite, 'agents', 'user_id') &&
    hasColumn(sqlite, 'agents', 'driver_config')
  )
}

/** Profile-owned, user-opened chats that never run a conductor. */
function candidateChats(sqlite: Database.Database): CandidateChat[] {
  return sqlite
    .prepare(
      `SELECT id, user_id AS userId, agent_id AS agentId FROM chats
       WHERE user_id != ? AND origin = 'user'
         AND (router = 'human' OR (router = 'direct' AND agent_id IS NOT NULL))`
    )
    .all(DEFAULT_USER_ID) as CandidateChat[]
}

function onlyLocalAgents(sqlite: Database.Database, chat: CandidateChat): boolean {
  const onDemand = sqlite
    .prepare('SELECT agent_id AS agentId FROM chat_on_demand_agents WHERE chat_id = ?')
    .all(chat.id) as Array<{ agentId: string }>
  const ids = [chat.agentId, ...onDemand.map((row) => row.agentId)].filter((id): id is string => !!id)
  if (ids.length === 0) return false
  const lookup = sqlite.prepare('SELECT user_id AS userId, driver_config AS driverConfig FROM agents WHERE id = ?')
  return ids.every((id) => {
    if (id.startsWith('remote:')) return false
    const agent = lookup.get(id) as { userId: string; driverConfig: string | null } | undefined
    if (!agent || agent.userId !== DEFAULT_USER_ID) return false
    const config = parseConfig(agent.driverConfig)
    if (config === null) return false
    // The same tests `ownerForBinding` and `isChatConductor` make.
    return !config.developmentProfileId && typeof config.conductorChatId !== 'string'
  })
}

/** The agent's `driver_config`; `null` when it does not parse (not moved). */
function parseConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function moveToDefault(sqlite: Database.Database, chat: CandidateChat): void {
  const nulls = ['mode_id', 'provider_id', 'model_id'].filter((column) => hasColumn(sqlite, 'chats', column))
  sqlite
    .prepare(`UPDATE chats SET ${['user_id = ?', ...nulls.map((c) => `${c} = NULL`)].join(', ')} WHERE id = ? AND user_id = ?`)
    .run(DEFAULT_USER_ID, chat.id, chat.userId)
  sqlite
    .prepare(`UPDATE agents SET user_id = ? WHERE user_id = ?
      AND CASE WHEN json_valid(driver_config) THEN json_extract(driver_config, '$.conductorChatId') END = ?`)
    .run(DEFAULT_USER_ID, chat.userId, chat.id)
  if (hasTable(sqlite, 'chat_files')) {
    sqlite
      .prepare('UPDATE chat_files SET user_id = ? WHERE chat_id = ? AND user_id = ?')
      .run(DEFAULT_USER_ID, chat.id, chat.userId)
  }
}
