import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { migrateChatModes } from './chat-modes'

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
})
