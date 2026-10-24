import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { migrateChatModes, migrateChatModeRuntimeIndex } from './chat-modes'

describe('chat-mode runtime migration', () => {
  it('preserves old credential modes as OpenCode and leaves unbound modes on the default runtime', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec(`CREATE TABLE chat_modes (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT, model_id TEXT, created_at INTEGER);
      INSERT INTO chat_modes VALUES ('credential', 'Work', 'p', 'm', 1), ('plain', 'Plain', NULL, NULL, 1);`)
    migrateChatModes(adaptDatabase(raw))
    expect(raw.prepare('SELECT id, engine, system_prompt, tool_policy FROM chat_modes ORDER BY id').all()).toEqual([
      { id: 'credential', engine: 'opencode', system_prompt: '', tool_policy: 'connectors' },
      { id: 'plain', engine: null, system_prompt: '', tool_policy: 'connectors' }
    ])
    raw.exec("UPDATE chat_modes SET engine = 'claude', system_prompt = 'Be concise', tool_policy = 'none' WHERE id = 'credential'")
    migrateChatModes(adaptDatabase(raw))
    expect(raw.prepare("SELECT engine, system_prompt, tool_policy FROM chat_modes WHERE id = 'credential'").get()).toEqual({ engine: 'claude', system_prompt: 'Be concise', tool_policy: 'none' })
    raw.close()
  })

  it('adds effort and runtime-mode columns, and one runtime mode per user and engine once user_id exists', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec("CREATE TABLE chat_modes (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT, model_id TEXT, created_at INTEGER); INSERT INTO chat_modes VALUES ('old', 'Old', NULL, NULL, 1);")
    migrateChatModes(adaptDatabase(raw))
    expect(raw.prepare("SELECT complexity, builtin_engine FROM chat_modes WHERE id = 'old'").get()).toEqual({ complexity: null, builtin_engine: null })
    // A legacy table has no user_id yet: no index until the backfill adds it.
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_modes_builtin_engine'").get()).toBeUndefined()
    raw.exec("ALTER TABLE chat_modes ADD COLUMN user_id TEXT NOT NULL DEFAULT '__default__'")
    migrateChatModeRuntimeIndex(adaptDatabase(raw))
    migrateChatModeRuntimeIndex(adaptDatabase(raw))
    raw.exec("INSERT INTO chat_modes (id, name, created_at, builtin_engine, user_id) VALUES ('a', 'A', 1, 'claude', 'u1'), ('b', 'B', 1, 'claude', 'u2'), ('c', 'C', 1, NULL, 'u1'), ('d', 'D', 1, NULL, 'u1')")
    expect(() => raw.exec("INSERT INTO chat_modes (id, name, created_at, builtin_engine, user_id) VALUES ('e', 'E', 1, 'claude', 'u1')")).toThrow(/UNIQUE/)
    raw.close()
  })
})
