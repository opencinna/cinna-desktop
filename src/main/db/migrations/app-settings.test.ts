import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { runAllMigrations } from './index'
import { AI_FUNCTIONS_BACKFILL_MARKER } from './app-settings'

function migrate(raw: DatabaseSync): void {
  raw.exec('PRAGMA foreign_keys = OFF')
  runAllMigrations(adaptDatabase(raw))
  raw.exec('PRAGMA foreign_keys = ON')
}

/** A database as a pre-runtime-conductor install left it: schema, but no backfill marker. */
function upgradedInstall(): DatabaseSync {
  const raw = new DatabaseSync(':memory:')
  migrate(raw)
  raw.prepare('DELETE FROM app_settings').run()
  raw.exec(`INSERT INTO llm_providers (id, type, name, enabled, created_at, default_model_id, available_models)
      VALUES ('p-anthropic', 'anthropic', 'Work key', 1, 1, 'claude-a', '["claude-a","claude-b"]');
    INSERT INTO chat_modes (id, user_id, name, provider_id, model_id, is_default, created_at)
      VALUES ('m-default', '__default__', 'Work', 'p-anthropic', 'claude-b', 1, 1),
             ('m-other', '__default__', 'Other', 'p-anthropic', 'claude-a', 0, 1);`)
  return raw
}

function setting(raw: DatabaseSync, key: string): unknown {
  const row = raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? JSON.parse(row.value) : undefined
}

describe('AI Functions credential backfill', () => {
  it('copies the default chat mode credential and its model on an upgraded install', () => {
    const raw = upgradedInstall()
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBe('p-anthropic')
    expect(setting(raw, 'aiFunctionsModelId')).toBe('claude-b')
    raw.close()
  })

  it('runs once: clearing it back to the default runtime is not backfilled again', () => {
    const raw = upgradedInstall()
    migrate(raw)
    raw.prepare("DELETE FROM app_settings WHERE key IN ('aiFunctionsCredentialId', 'aiFunctionsModelId')").run()
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBeUndefined()
    raw.prepare(`UPDATE app_settings SET value = '""' WHERE key = 'aiFunctionsCredentialId'`).run()
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBeUndefined()
    raw.close()
  })

  it('keeps an explicit Default-runtime choice made before the backfill ran', () => {
    const raw = upgradedInstall()
    raw.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('aiFunctionsCredentialId', '""', 1)`).run()
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBe('')
    expect(setting(raw, 'aiFunctionsModelId')).toBeUndefined()
    raw.close()
  })

  it('copies the credential but not a model the credential does not offer', () => {
    const raw = upgradedInstall()
    raw.prepare("UPDATE chat_modes SET model_id = 'gpt-x' WHERE id = 'm-default'").run()
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBe('p-anthropic')
    expect(setting(raw, 'aiFunctionsModelId')).toBeUndefined()
    raw.close()
  })

  it('leaves a default mode on a runtime, or on a disabled credential, on the default runtime', () => {
    for (const change of [
      "UPDATE chat_modes SET provider_id = NULL, model_id = NULL, engine = 'claude' WHERE id = 'm-default'",
      "UPDATE llm_providers SET enabled = 0",
      "DELETE FROM llm_providers"
    ]) {
      const raw = upgradedInstall()
      raw.prepare(change).run()
      migrate(raw)
      expect(setting(raw, 'aiFunctionsCredentialId')).toBeUndefined()
      expect(setting(raw, AI_FUNCTIONS_BACKFILL_MARKER)).toBe('done')
      raw.close()
    }
  })

  it('is a no-op on a fresh install that later gains an API default mode', () => {
    const raw = new DatabaseSync(':memory:')
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBeUndefined()
    expect(setting(raw, AI_FUNCTIONS_BACKFILL_MARKER)).toBe('done')
    raw.exec(`INSERT INTO llm_providers (id, type, name, enabled, created_at) VALUES ('p', 'openai', 'Key', 1, 1);
      INSERT INTO chat_modes (id, user_id, name, provider_id, model_id, is_default, created_at)
        VALUES ('m', '__default__', 'Mode', 'p', 'gpt', 1, 1);`)
    migrate(raw)
    expect(setting(raw, 'aiFunctionsCredentialId')).toBeUndefined()
    raw.close()
  })
})

describe('agents home pin (default moved out of ~/Documents)', () => {
  const legacy = join(homedir(), 'Documents', 'CinnaAgents')

  function withDefaultRoot(path: string): DatabaseSync {
    const raw = new DatabaseSync(':memory:')
    migrate(raw)
    raw
      .prepare(`INSERT INTO agent_roots (id, user_id, path, label, is_default, created_at) VALUES ('r1', '__default__', ?, 'Agents', 1, 1)`)
      .run(path)
    return raw
  }

  it('pins the old default for an install whose home root is there', () => {
    const raw = withDefaultRoot(legacy)
    migrate(raw)
    expect(setting(raw, 'localAgentsHome')).toBe(legacy)
    raw.close()
  })

  it('pins over a stored empty value, which also meant "the default"', () => {
    const raw = withDefaultRoot(legacy)
    raw.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('localAgentsHome', '""', 1)`).run()
    migrate(raw)
    expect(setting(raw, 'localAgentsHome')).toBe(legacy)
    raw.close()
  })

  it('leaves a fresh install on the new default', () => {
    const raw = new DatabaseSync(':memory:')
    migrate(raw)
    expect(setting(raw, 'localAgentsHome')).toBeUndefined()
    raw.close()
  })

  it('leaves a configured home, a non-default root and a home elsewhere alone', () => {
    const configured = withDefaultRoot(legacy)
    configured.prepare(`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('localAgentsHome', ?, 1)`).run(JSON.stringify('/Volumes/x/Agents'))
    migrate(configured)
    expect(setting(configured, 'localAgentsHome')).toBe('/Volumes/x/Agents')
    configured.close()

    const adopted = withDefaultRoot(legacy)
    adopted.prepare('UPDATE agent_roots SET is_default = 0').run()
    migrate(adopted)
    expect(setting(adopted, 'localAgentsHome')).toBeUndefined()
    adopted.close()

    const elsewhere = withDefaultRoot(join(homedir(), 'CinnaAgents'))
    migrate(elsewhere)
    expect(setting(elsewhere, 'localAgentsHome')).toBeUndefined()
    elsewhere.close()
  })
})
