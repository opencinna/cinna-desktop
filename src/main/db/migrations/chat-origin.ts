import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/**
 * `chats.origin` — who opened the chat (`shared/chatOrigin.ts`), written once
 * at creation. Added with a one-time backfill that runs only in the pass that
 * adds the column, so a replay never rewrites a value a later build recorded.
 *
 * The backfill reads `tasks`, `delegations` and `handovers`, so this module
 * runs after every one of them exists. Most specific first, each step only
 * over rows still at the `user` default:
 *
 * 1. A handover's or delegation's gate chat → `handover` / `delegation`.
 * 2. A job's chat (hidden from the list, or carrying its run) → `job`.
 * 3. Any chat a task is bound to (`tasks.chat_id`) → `task`, unless the chat
 *    has a message older than the task: that is a hand-opened chat the Inbox
 *    attached a task to on its first ask (`taskForChat`), which stays `user`.
 *    Provenance columns cannot tell this apart: the queue clears
 *    `dispatch_agent_id` once it settles a run, so a released queue task
 *    looks hand-made.
 * 4. Everything else stays `user`.
 *
 * A task chat backfilled as `task` notifies only once the user starts that
 * task again (`started_by_user` is false on every existing row).
 */
export function migrateChatOrigin(sqlite: Database.Database): void {
  if (hasColumn(sqlite, 'chats', 'origin')) return
  sqlite.transaction(() => {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`)
    if (hasTable(sqlite, 'handovers')) {
      sqlite.exec(`UPDATE chats SET origin = 'handover' WHERE origin = 'user'
        AND id IN (SELECT gate_chat_id FROM handovers WHERE gate_chat_id IS NOT NULL)`)
    }
    if (hasTable(sqlite, 'delegations')) {
      sqlite.exec(`UPDATE chats SET origin = 'delegation' WHERE origin = 'user'
        AND id IN (SELECT gate_chat_id FROM delegations WHERE gate_chat_id IS NOT NULL)`)
    }
    sqlite.exec(`UPDATE chats SET origin = 'job' WHERE origin = 'user'
      AND (hidden_from_list = 1 OR originating_job_run_id IS NOT NULL)`)
    if (hasTable(sqlite, 'tasks') && hasTable(sqlite, 'messages')) {
      // Both `created_at` columns are Unix seconds. Strictly older: a task's
      // own first message lands in the same second it was created.
      sqlite.exec(`UPDATE chats SET origin = 'task' WHERE origin = 'user' AND id IN (
        SELECT t.chat_id FROM tasks t WHERE t.chat_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.chat_id = t.chat_id AND m.created_at < t.created_at))`)
    }
  })()
}
