import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/**
 * `chats.vault_id`: the Agent Vault a chat's transcript lives in, or null for
 * every ordinary chat. Set once, when main binds the chat to a vault agent
 * (`vaultService.bindChat`), never changed. A chat with a vault id keeps only
 * a stub row here; its messages and in-flight turns are routed to the vault
 * (`vault/transcriptStore.ts`) and never written to SQLite. A nullable column,
 * no DML.
 */
export function migrateChatVault(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'chats') || hasColumn(sqlite, 'chats', 'vault_id')) return
  sqlite.exec('ALTER TABLE chats ADD COLUMN vault_id TEXT')
}
