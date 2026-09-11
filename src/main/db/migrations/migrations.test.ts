import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { runAllMigrations } from './index'

/**
 * The fresh-install replay, as section 10 of the review command specifies it:
 * start from an empty database, run the whole chain in `runMigrations()` order,
 * and watch for the failure mode this project actually shipped once — DML whose
 * `ON DELETE CASCADE` chain compiles against a table a later migration creates,
 * which throws `no such table` even with zero rows.
 *
 * These run against `node:sqlite` rather than `better-sqlite3`, whose binding is
 * built for Electron; it is the same SQLite engine and the same statement
 * compiler, which is what the ordering trap is about. See `testSupport/nodeSqlite.ts`.
 */

function freshDatabase(): DatabaseSync {
  const raw = new DatabaseSync(':memory:')
  // Exactly what `initDatabase` does around the pass.
  raw.exec('PRAGMA foreign_keys = OFF')
  runAllMigrations(adaptDatabase(raw))
  raw.exec('PRAGMA foreign_keys = ON')
  return raw
}

function tableNames(raw: DatabaseSync): Set<string> {
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string
  }>
  return new Set(rows.map((r) => r.name))
}

function columnNames(raw: DatabaseSync, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

describe('the migration chain on a fresh install', () => {
  it('replays from an empty database without throwing', () => {
    expect(() => freshDatabase()).not.toThrow()
  })

  it('creates agent_roots and the folder-agent columns', () => {
    const raw = freshDatabase()
    expect(tableNames(raw)).toContain('agent_roots')

    const rootCols = columnNames(raw, 'agent_roots')
    for (const col of ['id', 'user_id', 'path', 'label', 'is_default', 'created_at']) {
      expect(rootCols).toContain(col)
    }

    const agentCols = columnNames(raw, 'agents')
    expect(agentCols).toContain('local_path')
    expect(agentCols).toContain('local_root_id')
    // Added by the last migration in the chain, over a table created early.
    expect(agentCols).toContain('user_id')
    raw.close()
  })

  it('leaves referential integrity intact', () => {
    const raw = freshDatabase()
    const violations = raw.prepare('PRAGMA foreign_key_check').all()
    expect(violations).toEqual([])
    raw.close()
  })

  it('is a no-op the second time — and the third', () => {
    const raw = freshDatabase()
    const before = tableNames(raw)
    const sqlite = adaptDatabase(raw)
    expect(() => runAllMigrations(sqlite)).not.toThrow()
    expect(() => runAllMigrations(sqlite)).not.toThrow()
    expect(tableNames(raw)).toEqual(before)
    expect(columnNames(raw, 'agents')).toContain('local_path')
    raw.close()
  })

  it('re-runs cleanly over a database that already holds rows', () => {
    // The upgrade path: an existing install, not an empty file. A migration
    // that only works against zero rows fails here.
    const raw = freshDatabase()
    raw
      .prepare(
        `INSERT INTO agent_roots (id, user_id, path, label, is_default, created_at)
         VALUES ('r1', '__default__', '/tmp/workshop', 'Agents', 1, ?)`
      )
      .run(Date.now())
    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, local_path, local_root_id, created_at)
         VALUES ('folder:abc', '__default__', 'A', 'local-folder', 1, 'folder', '/tmp/workshop/Local/a', 'r1', ?)`
      )
      .run(Date.now())

    expect(() => runAllMigrations(adaptDatabase(raw))).not.toThrow()

    const rows = raw.prepare('SELECT id, local_root_id FROM agents').all()
    expect(rows).toEqual([{ id: 'folder:abc', local_root_id: 'r1' }])
    raw.close()
  })

  it('adds the driver columns', () => {
    const cols = columnNames(freshDatabase(), 'agents')
    expect(cols).toContain('driver')
    expect(cols).toContain('driver_config')
  })

  it('starts a fresh install with only the default user and no agent rows', () => {
    const raw = freshDatabase()
    const users = raw.prepare('SELECT id FROM users').all() as Array<{ id: string }>
    expect(users.map((u) => u.id)).toEqual(['__default__'])
    expect(raw.prepare('SELECT COUNT(*) AS c FROM agent_roots').get()).toEqual({ c: 0 })
    raw.close()
  })
})

describe('agents.driver on an install that predates it', () => {
  /**
   * The upgrade path, not the fresh one: an existing `agents` table with rows of
   * all three sources and no `driver` column. Dropping the columns from a fresh
   * database is the closest node:sqlite gets to a pre-phase-2 file.
   */
  function preDriverDatabase(): DatabaseSync {
    const raw = freshDatabase()
    raw.exec('ALTER TABLE agents DROP COLUMN driver')
    raw.exec('ALTER TABLE agents DROP COLUMN driver_config')
    const insert = raw.prepare(
      `INSERT INTO agents (id, user_id, name, protocol, enabled, source, created_at)
       VALUES (?, '__default__', ?, ?, 1, ?, ?)`
    )
    insert.run('hand-added', 'Hand added', 'a2a', 'local', Date.now())
    insert.run('remote:agent:u1', 'Synced', 'a2a', 'remote', Date.now())
    insert.run('folder:abc', 'Folder', 'local-folder', 'folder', Date.now())
    return raw
  }

  function drivers(raw: DatabaseSync): Record<string, string | null> {
    const rows = raw.prepare('SELECT id, driver FROM agents').all() as Array<{
      id: string
      driver: string | null
    }>
    return Object.fromEntries(rows.map((r) => [r.id, r.driver]))
  }

  function launchers(raw: DatabaseSync): Record<string, string | null> {
    const rows = raw.prepare('SELECT id, driver_config FROM agents').all() as Array<{
      id: string
      driver_config: string | null
    }>
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        r.driver_config ? ((JSON.parse(r.driver_config).launcher as string) ?? null) : null
      ])
    )
  }

  it('maps every row to the driver its source runs on, and every folder to a launcher', () => {
    const raw = preDriverDatabase()
    runAllMigrations(adaptDatabase(raw))
    expect(drivers(raw)).toEqual({
      'hand-added': 'a2a',
      'remote:agent:u1': 'a2a',
      // One driver for every folder agent since phase 3; which engine it runs
      // is a setting of that driver, not an identity.
      'folder:abc': 'acp'
    })
    expect(launchers(raw)).toEqual({
      'hand-added': null,
      'remote:agent:u1': null,
      // The default engine; the scanner writes the engine the folder names.
      'folder:abc': 'opencode'
    })
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })

  it('is a no-op on replay', () => {
    const raw = preDriverDatabase()
    const sqlite = adaptDatabase(raw)
    runAllMigrations(sqlite)
    const once = drivers(raw)
    const onceLaunchers = launchers(raw)
    expect(() => runAllMigrations(sqlite)).not.toThrow()
    expect(drivers(raw)).toEqual(once)
    expect(launchers(raw)).toEqual(onceLaunchers)
    raw.close()
  })

  it('carries a Claude row’s engine into its launcher rather than losing it', () => {
    // The phase-3 collapse: `driver` stops naming the engine, so the engine has
    // to be somewhere before it is overwritten. A Claude folder that came back
    // as the default engine would run on the wrong one until its next rescan.
    const raw = freshDatabase()
    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, created_at)
         VALUES ('folder:claude', '__default__', 'C', 'local-folder', 1, 'folder', 'claude', ?)`
      )
      .run(Date.now())
    runAllMigrations(adaptDatabase(raw))
    expect(drivers(raw)).toEqual({ 'folder:claude': 'acp' })
    expect(launchers(raw)).toEqual({ 'folder:claude': 'claude' })
    raw.close()
  })

  it('leaves a driver_config another build wrote alone', () => {
    // Nothing wrote one before phase 3, so a value here is from a newer build
    // or a repair — both of which know more than a backfill does.
    const raw = freshDatabase()
    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, driver_config, created_at)
         VALUES ('folder:x', '__default__', 'X', 'local-folder', 1, 'folder', 'opencode', '{"launcher":"gemini"}', ?)`
      )
      .run(Date.now())
    runAllMigrations(adaptDatabase(raw))
    expect(drivers(raw)).toEqual({ 'folder:x': 'acp' })
    expect(launchers(raw)).toEqual({ 'folder:x': 'gemini' })
    raw.close()
  })

  it('leaves a row already on acp exactly as it is', () => {
    const raw = freshDatabase()
    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, driver_config, created_at)
         VALUES ('folder:acp', '__default__', 'A', 'local-folder', 1, 'folder', 'acp', '{"launcher":"claude"}', ?)`
      )
      .run(Date.now())
    runAllMigrations(adaptDatabase(raw))
    expect(drivers(raw)).toEqual({ 'folder:acp': 'acp' })
    expect(launchers(raw)).toEqual({ 'folder:acp': 'claude' })
    raw.close()
  })
})

describe('chats.router on an install that predates it', () => {
  /**
   * The upgrade path for phase 4: an existing `chats` table whose only record of
   * how a chat routes is the `orchestrated` boolean.
   *
   * The migration runs after `migrateChats`, which is what creates the column it
   * backfills from, so the fixture has to reach back past both: create the chain
   * once, then drop `router` and reinstate whatever `orchestrated` said.
   */
  function chatsWithoutRouter(): DatabaseSync {
    const raw = freshDatabase()
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec('ALTER TABLE chats DROP COLUMN router')
    const now = Date.now()
    for (const [id, orchestrated, agentId] of [
      ['c-plain', 0, null],
      ['c-agent', 0, 'a-1'],
      ['c-orch', 1, null]
    ] as Array<[string, number, string | null]>) {
      raw
        .prepare(
          `INSERT INTO chats (id, user_id, title, agent_id, orchestrated, hidden_from_list, created_at, updated_at)
           VALUES (?, '__default__', 'A chat', ?, ?, 0, ?, ?)`
        )
        .run(id, agentId, orchestrated, now, now)
    }
    return raw
  }

  function routers(raw: DatabaseSync): Record<string, string> {
    const rows = raw.prepare('SELECT id, router FROM chats ORDER BY id').all() as Array<{
      id: string
      router: string
    }>
    return Object.fromEntries(rows.map((r) => [r.id, r.router]))
  }

  it('backfills the two values the old flag could say, and invents no third', () => {
    const raw = chatsWithoutRouter()
    runAllMigrations(adaptDatabase(raw))
    expect(routers(raw)).toEqual({
      // A chat with no agent and no flag is "direct to the local model".
      'c-plain': 'direct',
      // A bound agent, answering directly — unchanged.
      'c-agent': 'direct',
      'c-orch': 'coordinator'
    })
    // `human` is reachable only by a gesture the user makes after the upgrade:
    // nothing in an old row says which of several agents was being addressed.
    expect(Object.values(routers(raw))).not.toContain('human')
    raw.close()
  })

  it('does not drag a chat back to coordinator on a later boot', () => {
    // The backfill is guarded by the `ADD COLUMN`, not by a predicate on the
    // data, so a chat the user has since moved off `coordinator` stays moved —
    // while `orchestrated` still says what it said before the router existed.
    const raw = chatsWithoutRouter()
    runAllMigrations(adaptDatabase(raw))
    raw.prepare("UPDATE chats SET router = 'human' WHERE id = 'c-orch'").run()
    runAllMigrations(adaptDatabase(raw))
    expect(routers(raw)['c-orch']).toBe('human')
    raw.close()
  })

  it('creates the per-agent catch-up cursor table', () => {
    const raw = freshDatabase()
    expect(tableNames(raw)).toContain('chat_agent_cursors')
    expect(columnNames(raw, 'chat_agent_cursors')).toEqual(
      new Set(['chat_id', 'agent_id', 'last_message_id', 'updated_at'])
    )
    raw.close()
  })

  it('cascades a cursor away with the chat — and with the agent — it belongs to', () => {
    const raw = freshDatabase()
    const now = Date.now()
    raw
      .prepare(
        `INSERT INTO chats (id, user_id, title, router, orchestrated, hidden_from_list, created_at, updated_at)
         VALUES ('c-1', '__default__', 'A chat', 'human', 0, 0, ?, ?)`
      )
      .run(now, now)
    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, created_at)
         VALUES ('a-1', '__default__', 'A', 'a2a', 1, 'local', ?)`
      )
      .run(now)
    raw
      .prepare(
        `INSERT INTO chat_agent_cursors (chat_id, agent_id, last_message_id, updated_at)
         VALUES ('c-1', 'a-1', 'm-9', ?)`
      )
      .run(now)

    // Removing the agent takes its cursor with it. Without that reference a
    // deleted-then-recreated agent id would inherit a cursor pointing into a
    // conversation it never had, and be told it had already seen it.
    raw.prepare("DELETE FROM agents WHERE id = 'a-1'").run()
    expect(raw.prepare('SELECT COUNT(*) AS c FROM chat_agent_cursors').get()).toEqual({ c: 0 })

    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, created_at)
         VALUES ('a-1', '__default__', 'A', 'a2a', 1, 'local', ?)`
      )
      .run(now)
    raw
      .prepare(
        `INSERT INTO chat_agent_cursors (chat_id, agent_id, last_message_id, updated_at)
         VALUES ('c-1', 'a-1', 'm-9', ?)`
      )
      .run(now)
    raw.prepare("DELETE FROM chats WHERE id = 'c-1'").run()
    expect(raw.prepare('SELECT COUNT(*) AS c FROM chat_agent_cursors').get()).toEqual({ c: 0 })
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})

describe('tasks on an install that predates them', () => {
  it('creates both tables with the columns the phase specifies', () => {
    const raw = freshDatabase()
    expect(tableNames(raw)).toContain('tasks')
    expect(tableNames(raw)).toContain('task_input_requests')

    const taskCols = columnNames(raw, 'tasks')
    for (const col of [
      'id',
      'user_id',
      'title',
      'goal',
      'description',
      'status',
      'priority',
      'router',
      // Provenance and who-runs-it-now are two columns on purpose.
      'origin',
      'executor',
      'executor_device',
      'chat_id',
      'assignee_agent_id',
      'assignee_name',
      'assignee_kind',
      'assignee_ref',
      'parent_task_id',
      'job_id',
      'job_run_id',
      'remote_adapter',
      'remote_id',
      'remote_key',
      'remote_url',
      'remote_state',
      'remote_synced_at',
      'remote_dirty',
      'handoff_note',
      'artifacts',
      'budget',
      'error_message',
      'created_at',
      'updated_at',
      'started_at',
      'finished_at',
      'deleted_at'
    ]) {
      expect(taskCols).toContain(col)
    }

    // No column names a particular remote system: the binding is an adapter id
    // plus opaque state, so the next integration adds a file, not a column.
    expect([...taskCols].filter((c) => c.includes('cinna'))).toEqual([])

    expect(columnNames(raw, 'task_input_requests')).toEqual(
      new Set([
        'id',
        'task_id',
        'chat_id',
        'agent_id',
        'root_run_id',
        'invocation_id',
        'request',
        'resume',
        'status',
        'resolution',
        'created_at',
        'resolved_at'
      ])
    )
    raw.close()
  })

  it('adds task_id to job_runs without touching the cinna mirrors', () => {
    const raw = freshDatabase()
    const runCols = columnNames(raw, 'job_runs')
    expect(runCols).toContain('task_id')
    // Kept for one phase as mirrors of the task's remote binding, so a
    // downgrade to the previous build still finds the remote task.
    expect(runCols).toContain('cinna_task_id')
    expect(runCols).toContain('cinna_short_code')
    raw.close()
  })

  it('replays over a database that already holds a task', () => {
    const raw = freshDatabase()
    const now = Date.now()
    raw
      .prepare(
        `INSERT INTO tasks (id, user_id, title, goal, status, priority, router, origin, executor,
                            assignee_kind, created_at, updated_at)
         VALUES ('t-1', '__default__', 'Ship it', 'Ship the thing', 'in_progress', 'high',
                 'direct', 'local', 'desktop', 'agent', ?, ?)`
      )
      .run(now, now)
    raw
      .prepare(
        `INSERT INTO task_input_requests (id, task_id, chat_id, agent_id, request, resume, status, created_at)
         VALUES ('per_1', 't-1', 'c-1', 'a-1', '{"kind":"permission","action":"bash","resources":[]}',
                 'reply', 'open', ?)`
      )
      .run(now)

    expect(() => runAllMigrations(adaptDatabase(raw))).not.toThrow()
    expect(raw.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 })
    expect(raw.prepare('SELECT COUNT(*) AS c FROM task_input_requests').get()).toEqual({ c: 1 })
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })

  it('cascades an ask away with its task, and releases a task from its deleted chat', () => {
    const raw = freshDatabase()
    const now = Date.now()
    raw
      .prepare(
        `INSERT INTO chats (id, user_id, title, router, orchestrated, hidden_from_list, created_at, updated_at)
         VALUES ('c-1', '__default__', 'A chat', 'direct', 0, 1, ?, ?)`
      )
      .run(now, now)
    raw
      .prepare(
        `INSERT INTO tasks (id, user_id, title, goal, status, priority, router, origin, executor,
                            assignee_kind, chat_id, created_at, updated_at)
         VALUES ('t-1', '__default__', 'Ship it', 'Ship the thing', 'blocked', 'normal',
                 'direct', 'local', 'desktop', 'model', 'c-1', ?, ?)`
      )
      .run(now, now)
    raw
      .prepare(
        `INSERT INTO task_input_requests (id, task_id, chat_id, agent_id, request, resume, status, created_at)
         VALUES ('per_1', 't-1', 'c-1', 'a-1', '{"kind":"permission","action":"bash","resources":[]}',
                 'reply', 'open', ?)`
      )
      .run(now)

    // A task outlives its chat — that is the whole point of it — so the chat
    // reference is SET NULL, not CASCADE.
    raw.prepare("DELETE FROM chats WHERE id = 'c-1'").run()
    expect(raw.prepare("SELECT chat_id FROM tasks WHERE id = 't-1'").get()).toEqual({
      chat_id: null
    })
    expect(raw.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 })

    // An ask is meaningless without the task it is asking about.
    raw.prepare("DELETE FROM tasks WHERE id = 't-1'").run()
    expect(raw.prepare('SELECT COUNT(*) AS c FROM task_input_requests').get()).toEqual({ c: 0 })
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})

describe('input request ownership on an existing install', () => {
  it('preserves legacy requests without assigning them to a new run, and replays idempotently', () => {
    const raw = freshDatabase()
    raw.exec('DROP INDEX idx_task_input_requests_run')
    raw.exec('ALTER TABLE task_input_requests DROP COLUMN root_run_id')
    raw.exec('ALTER TABLE task_input_requests DROP COLUMN invocation_id')
    raw.exec(`INSERT INTO tasks (id, user_id, title, goal, created_at, updated_at)
      VALUES ('legacy-task', '__default__', 'Task', 'Goal', 1, 1)`)
    const request = JSON.stringify({ kind: 'permission', action: 'bash', resources: ['build'] })
    raw.prepare(`INSERT INTO task_input_requests (id, task_id, chat_id, agent_id, request, resume, status, created_at)
      VALUES ('legacy-ask', 'legacy-task', 'legacy-chat', 'legacy-agent', ?, 'reply', 'open', 42)`).run(request)
    runAllMigrations(adaptDatabase(raw))
    runAllMigrations(adaptDatabase(raw))
    expect(raw.prepare('SELECT * FROM task_input_requests').all()).toEqual([{
      id: 'legacy-ask', task_id: 'legacy-task', chat_id: 'legacy-chat', agent_id: 'legacy-agent',
      request, resume: 'reply', status: 'open', resolution: null, created_at: 42, resolved_at: null,
      root_run_id: null, invocation_id: null
    }])
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })
})
