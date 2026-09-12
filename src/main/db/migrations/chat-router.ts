import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/**
 * `chats.router` — who answers a message in this chat — and
 * `chat_agent_cursors`, the per-agent catch-up cursor that makes several
 * agents in one chat possible without a model between them.
 *
 * Phase 4 of the agent runtime plan. `orchestrated` said one thing with two
 * values: on meant "the local model conducts", off meant "the bound agent
 * answers, or the model does when there is none". There was no way to say
 * "several agents, and the **user** routes" — which is the shape every product
 * that ships multi-agent threads actually shipped — so a second agent in a chat
 * forced a model into the middle of it.
 *
 * The backfill is the old two values verbatim: `orchestrated = 1` becomes
 * `coordinator`, everything else stays on the column default `direct`. No row
 * becomes `human`; that value is only ever reached by a gesture the user makes
 * after this migration, so nothing here has to guess which of a chat's agents
 * was being addressed.
 *
 * The following retire-chat-mirror migration drops the legacy column after
 * this guarded backfill has preserved its routing meaning.
 *
 * `chat_agent_cursors` is the table the orphaned comment in `schema.ts` has
 * described since the multi-agent switchboard was removed — its predecessor
 * `chat_agent_sessions` is dropped by `migrateChats` a few lines earlier. It is
 * created here rather than there because it references `agents`, and this
 * migration runs after that table exists.
 */
export function migrateChatRouter(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'chats')) return

  if (!hasColumn(sqlite, 'chats', 'router')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN router TEXT NOT NULL DEFAULT 'direct'`)
    // Guarded by the `ADD COLUMN` above, not by a predicate on the data: on a
    // second run the column already exists and this never runs again, so a
    // chat the user has since moved off `coordinator` is not dragged back.
    if (hasColumn(sqlite, 'chats', 'orchestrated')) {
      sqlite.exec(`UPDATE chats SET router = 'coordinator' WHERE orchestrated = 1`)
    }
  }

  if (hasTable(sqlite, 'agents')) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS chat_agent_cursors (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        last_message_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, agent_id)
      );
    `)
  }
}
