import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { runAllMigrations } from './index'
import { SHARE_LOCAL_AGENT_CHATS_MARKER } from './share-local-agent-chats'

/**
 * The one-time move of local-agent chats that an account-managed default mode,
 * stamped on a chat that never used it, kept in a signed-in profile.
 */

const PROFILE = 'profile-1'
const DEFAULT = '__default__'

function migrate(raw: DatabaseSync): void {
  raw.exec('PRAGMA foreign_keys = OFF')
  runAllMigrations(adaptDatabase(raw))
  raw.exec('PRAGMA foreign_keys = ON')
}

/** A migrated install from before the fix: schema, rows, no marker yet. */
function upgradedInstall(setup: string): DatabaseSync {
  const raw = new DatabaseSync(':memory:')
  migrate(raw)
  raw.prepare('DELETE FROM app_settings WHERE key = ?').run(SHARE_LOCAL_AGENT_CHATS_MARKER)
  raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('${PROFILE}', 'cinna_user', 'p', 'P', 1);`)
  raw.exec(setup)
  return raw
}

function agent(id: string, owner: string, config: Record<string, unknown> = {}): string {
  return `INSERT INTO agents (id, user_id, name, protocol, created_at, driver_config)
    VALUES ('${id}', '${owner}', '${id}', 'a2a', 1, '${JSON.stringify(config)}');`
}

function chat(id: string, over: { owner?: string; router?: string; agentId?: string | null; origin?: string; deleted?: boolean } = {}): string {
  const agentId = over.agentId === undefined ? 'local-1' : over.agentId
  return `INSERT INTO chats (id, user_id, title, router, agent_id, origin, mode_id, provider_id, model_id, created_at, updated_at, deleted_at)
    VALUES ('${id}', '${over.owner ?? PROFILE}', 't', '${over.router ?? 'direct'}', ${agentId ? `'${agentId}'` : 'NULL'},
      '${over.origin ?? 'user'}', 'managed-mode:m', 'managed:p', 'model-x', 1, 1, ${over.deleted ? Math.floor(Date.now() / 1000) : 'NULL'});`
}

function onDemand(chatId: string, agentId: string): string {
  return `INSERT INTO chat_on_demand_agents (chat_id, agent_id, pending_announce, created_at) VALUES ('${chatId}', '${agentId}', 0, 1);`
}

const AGENTS = agent('local-1', DEFAULT) + agent('local-2', DEFAULT)

function owner(raw: DatabaseSync, chatId: string): string {
  return (raw.prepare('SELECT user_id AS userId FROM chats WHERE id = ?').get(chatId) as { userId: string }).userId
}

describe('share local-agent chats migration', () => {
  it('moves a direct local-agent chat on a managed mode to the default profile, with its conductor and files', () => {
    const raw = upgradedInstall(AGENTS + chat('c1') + chat('c-trash', { deleted: true }) +
      agent('conductor-c1', PROFILE, { conductorChatId: 'c1' }) +
      agent('conductor-other', PROFILE, { conductorChatId: 'c-other' }) +
      `INSERT INTO chat_files (id, user_id, chat_id, storage_path, mime_type, size, filename, created_at)
        VALUES ('f1', '${PROFILE}', 'c1', '/abs/files/${PROFILE}/c1/f1.pdf', 'application/pdf', 1, 'a.pdf', 1);`)
    migrate(raw)
    expect(raw.prepare('SELECT user_id AS userId, mode_id AS modeId, provider_id AS providerId, model_id AS modelId FROM chats WHERE id = ?').get('c1'))
      .toEqual({ userId: DEFAULT, modeId: null, providerId: null, modelId: null })
    expect(owner(raw, 'c-trash')).toBe(DEFAULT)
    expect(raw.prepare('SELECT user_id AS userId FROM agents WHERE id = ?').get('conductor-c1')).toEqual({ userId: DEFAULT })
    expect(raw.prepare('SELECT user_id AS userId FROM agents WHERE id = ?').get('conductor-other')).toEqual({ userId: PROFILE })
    // The bytes stay put: readers use the absolute storage path.
    expect(raw.prepare('SELECT user_id AS userId, storage_path AS path FROM chat_files WHERE id = ?').get('f1'))
      .toEqual({ userId: DEFAULT, path: `/abs/files/${PROFILE}/c1/f1.pdf` })
    raw.close()
  })

  it('moves a human chat whose attached agents are all local', () => {
    const raw = upgradedInstall(AGENTS + chat('h1', { router: 'human', agentId: null }) + onDemand('h1', 'local-1') + onDemand('h1', 'local-2'))
    migrate(raw)
    expect(owner(raw, 'h1')).toBe(DEFAULT)
    raw.close()
  })

  it('leaves every chat that is not a local-agent chat the user opened where it is', () => {
    const raw = upgradedInstall(AGENTS +
      agent('remote:r1', PROFILE) + agent('dev-1', DEFAULT, { developmentProfileId: 'dp' }) +
      agent('profile-agent', PROFILE) + agent('conductor-x', DEFAULT, { conductorChatId: 'x' }) +
      chat('remote', { agentId: 'remote:r1' }) +
      chat('dev', { agentId: 'dev-1' }) +
      chat('mixed', { router: 'human', agentId: null }) + onDemand('mixed', 'local-1') + onDemand('mixed', 'profile-agent') +
      chat('conductor-root', { agentId: 'conductor-x' }) +
      chat('missing-agent', { agentId: 'gone' }) +
      chat('coordinated', { router: 'coordinator' }) +
      chat('model', { agentId: null }) +
      chat('human-empty', { router: 'human', agentId: null }) +
      chat('job', { origin: 'job' }) +
      chat('task', { origin: 'task' }))
    migrate(raw)
    for (const id of ['remote', 'dev', 'mixed', 'conductor-root', 'missing-agent', 'coordinated', 'model', 'human-empty', 'job', 'task']) {
      expect([id, owner(raw, id)]).toEqual([id, PROFILE])
    }
    expect(raw.prepare('SELECT mode_id AS modeId FROM chats WHERE id = ?').get('remote')).toEqual({ modeId: 'managed-mode:m' })
    raw.close()
  })

  it('leaves an already shared chat alone, mode included', () => {
    const raw = upgradedInstall(AGENTS + chat('shared', { owner: DEFAULT }))
    migrate(raw)
    expect(raw.prepare('SELECT user_id AS userId, mode_id AS modeId FROM chats WHERE id = ?').get('shared'))
      .toEqual({ userId: DEFAULT, modeId: 'managed-mode:m' })
    raw.close()
  })

  it('moves nothing with showLocalDataInAllProfiles off, and still marks itself done', () => {
    const raw = upgradedInstall(AGENTS + chat('c1') +
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('showLocalDataInAllProfiles', 'false', 1);`)
    migrate(raw)
    expect(owner(raw, 'c1')).toBe(PROFILE)
    raw.prepare(`DELETE FROM app_settings WHERE key = 'showLocalDataInAllProfiles'`).run()
    migrate(raw)
    expect(owner(raw, 'c1')).toBe(PROFILE)
    raw.close()
  })

  it('runs once', () => {
    const raw = upgradedInstall(AGENTS + chat('c1'))
    migrate(raw)
    expect(owner(raw, 'c1')).toBe(DEFAULT)
    raw.exec(chat('c2'))
    migrate(raw)
    expect(owner(raw, 'c2')).toBe(PROFILE)
    expect(raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(SHARE_LOCAL_AGENT_CHATS_MARKER)).toEqual({ value: '"done"' })
    raw.close()
  })
})
