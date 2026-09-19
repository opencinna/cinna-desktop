import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/** Device-local bus journal. A deleted task cannot make a requester key new. */
export function migrateDelegations(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS delegations (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_key TEXT NOT NULL, origin_key TEXT NOT NULL, origin_kind TEXT NOT NULL,
    origin_agent_id TEXT, origin_chat_id TEXT, origin_task_id TEXT, origin_remote_ref TEXT,
    target_kind TEXT NOT NULL, target_agent_id TEXT NOT NULL, channel TEXT NOT NULL,
    root_delegation_id TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 1,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    handover_id TEXT UNIQUE REFERENCES handovers(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '', brief TEXT NOT NULL DEFAULT '',
    execution TEXT NOT NULL DEFAULT 'ask', state TEXT NOT NULL DEFAULT 'seen',
    refusal_reason TEXT, warning TEXT, result_status TEXT, summary TEXT, question TEXT,
    pending_replies TEXT NOT NULL DEFAULT '[]', result_digest TEXT, artifacts TEXT NOT NULL DEFAULT '[]', result_body TEXT, question_audience TEXT,
    group_id TEXT, woke_at INTEGER, wake_run_id TEXT, wake_digest TEXT, run_id TEXT,
    gate_request_id TEXT, gate_chat_id TEXT,
    remote_connection_id TEXT, remote_task_id TEXT, remote_task_key TEXT, remote_url TEXT,
    dispatch_state TEXT, dispatch_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_requester ON delegations(user_id, origin_key, target_kind, target_agent_id, COALESCE(remote_connection_id, ''), requester_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_task ON delegations(task_id) WHERE task_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_delegations_origin ON delegations(user_id, origin_chat_id, origin_task_id);
  CREATE INDEX IF NOT EXISTS idx_delegations_group ON delegations(user_id, origin_chat_id, group_id);
  `)
  if (!hasColumn(sqlite, 'delegations', 'pending_replies')) sqlite.exec("ALTER TABLE delegations ADD COLUMN pending_replies TEXT NOT NULL DEFAULT '[]'")
  const missing = sqlite.prepare('SELECT h.id FROM handovers h LEFT JOIN delegations d ON d.handover_id = h.id WHERE d.id IS NULL').all() as { id: string }[]
  sqlite.exec(`INSERT OR IGNORE INTO delegations (
    id, user_id, requester_key, origin_key, origin_kind, origin_agent_id, origin_chat_id,
    origin_task_id, target_kind, target_agent_id, channel, root_delegation_id, depth,
    task_id, handover_id, title, brief, execution, state, refusal_reason, warning,
    result_status, summary, result_digest, group_id, woke_at, wake_run_id, wake_digest,
    run_id, gate_request_id, gate_chat_id, created_at, updated_at
  ) SELECT h.id, h.user_id, h.handover_id,
    json_array(CASE WHEN h.origin_task_id IS NOT NULL THEN 'local_task' WHEN h.origin_chat_id IS NOT NULL THEN 'local_chat' ELSE 'external' END,
      h.origin_chat_id, h.origin_task_id, NULL, h.origin_agent_id),
    CASE WHEN h.origin_task_id IS NOT NULL THEN 'local_task' WHEN h.origin_chat_id IS NOT NULL THEN 'local_chat' ELSE 'external' END,
    h.origin_agent_id, h.origin_chat_id, h.origin_task_id, 'bare', h.agent_id, 'file', h.id,
    h.depth, h.task_id, h.id, COALESCE(t.title, h.handover_id), COALESCE(t.goal, ''),
    h.execution, h.state, h.refusal_reason, h.warning, h.report_status, h.summary,
    h.report_digest, h.group_id,
    -- A handover that settled before this table existed is not news: left unwoken, the bus
    -- sweep would open a turn in its origin chat on the first tick after the upgrade.
    COALESCE(h.woke_at, CASE WHEN h.state IN ('done', 'failed', 'skipped', 'refused') THEN h.updated_at END), h.wake_run_id,
    CASE WHEN h.woke_at IS NOT NULL OR h.state IN ('done', 'failed', 'skipped', 'refused') THEN h.report_digest ELSE NULL END,
    h.run_id, h.gate_request_id, h.gate_chat_id, h.created_at, h.updated_at
  FROM handovers h LEFT JOIN tasks t ON t.id = h.task_id;
  `)
  // Resolve roots from the delegation chain without using the user's task tree.
  const backfillRoot = sqlite.prepare(`WITH RECURSIVE roots(id, root_id, hops) AS (
    SELECT id, id, 0 FROM delegations WHERE id = ?
    UNION ALL
    SELECT roots.id, parent.id, roots.hops + 1 FROM roots
    JOIN delegations child ON child.id = roots.root_id
    JOIN delegations parent ON parent.task_id = child.origin_task_id AND parent.user_id = child.user_id
    WHERE roots.hops < 32
  ) UPDATE delegations SET root_delegation_id = (
    SELECT root_id FROM roots WHERE roots.id = delegations.id ORDER BY hops DESC LIMIT 1
  ) WHERE id = ?;`)
  for (const row of missing) backfillRoot.run(row.id, row.id)
}

