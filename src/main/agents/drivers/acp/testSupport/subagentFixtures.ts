/**
 * The session-activity fixtures, and the parent stream a Claude subagent turn
 * produced before `nativeSubagentSessions` — the "unchanged" the transcript
 * tests compare against.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionNotification } from '@agentclientprotocol/sdk'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__')

export interface ActivityFixture {
  notifications: SessionNotification[]
  /** Notifications at or after this index arrived after `session/prompt` answered. */
  promptReturnedAtIndex?: number
}

export function loadActivityFixture(engine: 'claude' | 'codex', name: string): ActivityFixture {
  return JSON.parse(readFileSync(join(FIXTURES, engine, `${name}.json`), 'utf8')) as ActivityFixture
}

/**
 * The parent stream a Claude turn produced before `nativeSubagentSessions`,
 * derived from `claude-agent-acp` 0.76.0: the Agent `tool_call` from
 * `toolInfoFromToolUse` (title = description, kind think, content = prompt),
 * the child's frames on the parent session, then the PostToolUse update and
 * the completed update from `toolUpdateFromToolResult` with the report.
 */
export function beforeCapability(fixture: ActivityFixture, parent: string, report: string | null): SessionNotification[] {
  const spawn = fixture.notifications.find((n) => (n.update as { sessionUpdate: string }).sessionUpdate === 'subagent_spawned')!
  const { subagentSessionId: child, name, task } = spawn.update as unknown as { subagentSessionId: string; name: string; task: string }
  const hook = fixture.notifications.find((n) =>
    (n.update as { _meta?: { claudeCode?: { toolName?: string } } })._meta?.claudeCode?.toolName === 'Agent')!
  const call = (hook.update as unknown as { toolCallId: string }).toolCallId
  const start = {
    sessionId: parent,
    update: {
      sessionUpdate: 'tool_call', toolCallId: call, title: name, kind: 'think', status: 'pending',
      rawInput: { description: name, prompt: task },
      content: [{ type: 'content', content: { type: 'text', text: task } }],
      _meta: { claudeCode: { toolName: 'Agent' } }
    }
  } as unknown as SessionNotification
  const done = {
    sessionId: parent,
    update: {
      sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed',
      ...(report ? { content: [{ type: 'content', content: { type: 'text', text: report } }] } : {}),
      _meta: { claudeCode: { toolName: 'Agent' } }
    }
  } as unknown as SessionNotification
  const out: SessionNotification[] = []
  let started = false
  for (const n of fixture.notifications) {
    const kind = (n.update as { sessionUpdate: string }).sessionUpdate
    if (kind === 'subagent_spawned' || kind === 'subagent_state_update') continue
    if (!started && (n.sessionId === child || n === hook)) {
      out.push(start)
      started = true
    }
    out.push(n.sessionId === child ? { ...n, sessionId: parent } : n)
    if (n === hook) out.push(done)
  }
  return out
}

