import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * `chats.guided_build` — the chat is a blank kit agent's guided first build
 * (`services/localAgents/guidedBuild.ts`). Set once, when the new chat is
 * bound to its agent, and never changed; every existing chat is not guided.
 */
export function migrateChatGuidedBuild(sqlite: Database.Database): void {
  if (hasColumn(sqlite, 'chats', 'guided_build')) return
  sqlite.exec('ALTER TABLE chats ADD COLUMN guided_build INTEGER NOT NULL DEFAULT 0')
}
