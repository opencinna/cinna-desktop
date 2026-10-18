import { useId, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAgentActiveSessions } from '../../hooks/useAgentSessions'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import type { AgentActiveSession } from '../../../../shared/agentSessions'

/**
 * The type scale of the surface the notice renders into (`ui_guidelines_llm.md`
 * — Typography): `chrome` for the task page, `settings` for
 * a settings-built tab (the agent's Tasks tab). `line` is one line of `text`'s
 * leading, so the icon centres on the first line however many the sentence
 * wraps to.
 */
type NoticeScale = 'chrome' | 'settings'

const SCALE: Record<NoticeScale, { text: string; line: string; icon: number }> = {
  chrome: { text: 'text-[11px] leading-4', line: 'h-4', icon: 11 },
  settings: { text: 'text-[13px] leading-5', line: 'h-5', icon: 13 }
}

/**
 * What the sentence advises. `conflict` on a surface about to start a new
 * session (a chat, a task's Start); `run-next` on the agent's Tasks tab, whose
 * status line already names the queue's own runs: there the notice speaks
 * only of the others, and of what Run next does about them.
 */
type NoticeAdvice = 'conflict' | 'run-next'

function where(sessions: readonly AgentActiveSession[]): string {
  if (sessions.length > 1) return `${sessions.length} sessions`
  const title = sessions[0]?.title
  return title ? `“${title}”` : 'a chat'
}

/** What the warning says about one agent's sessions; exported for tests. */
export function activeSessionSentence(
  name: string, sessions: readonly AgentActiveSession[], advice: NoticeAdvice = 'conflict'
): string {
  const several = sessions.length > 1
  if (advice === 'run-next') {
    return `${name} is also running in ${where(sessions)}. Run next starts beside ${several ? 'them' : 'it'}.`
  }
  return `${name} is already running in ${where(sessions)}. Make sure this request won’t conflict with ${several ? 'them' : 'it'}.`
}

/**
 * Each agent with its running sessions, newest first (main's order), leaving
 * out `excludeChatIds`; agents with none are dropped. Shared with the
 * composer's notice row on the new-chat screen.
 */
export function runningSessionsOf(
  agents: readonly { id: string; name: string }[],
  sessions: readonly AgentActiveSession[] | undefined,
  excludeChatIds: readonly string[] = []
): { agent: { id: string; name: string }; sessions: AgentActiveSession[] }[] {
  if (!sessions || sessions.length === 0) return []
  const excluded = new Set(excludeChatIds)
  return agents
    .map((agent) => ({
      agent,
      sessions: sessions.filter((session) => session.agentId === agent.id && !excluded.has(session.chatId))
    }))
    .filter((entry) => entry.sessions.length > 0)
}

/** Open's tooltip: the chat it goes to. */
export function openSessionTitle(session: AgentActiveSession): string {
  return session.title ? `Open “${session.title}”` : 'Open the running chat'
}

/** Open: the chat, in the chat view. */
export function useOpenSession(): (session: AgentActiveSession) => void {
  const setActiveChatId = useChatStore((state) => state.setActiveChatId)
  const setActiveView = useUIStore((state) => state.setActiveView)
  return (session) => {
    setActiveChatId(session.chatId)
    setActiveView('chat')
  }
}

/**
 * The sessions the notice shows. Live, the query's latest read. Frozen
 * (`live={false}`), the read as it stood when `snapshotKey` last changed —
 * the user's own gesture (opening the page, choosing an agent) — and nothing
 * after: a run starting or ending elsewhere neither pops the notice in nor
 * takes it away under the cursor. Opening the page counts until the first
 * read this mount made lands, since the cache may be empty or old until then.
 */
function useShownSessions(
  data: AgentActiveSession[] | undefined, fetchedAfterMount: boolean, live: boolean, snapshotKey: string
): AgentActiveSession[] | undefined {
  const [snapshot, setSnapshot] = useState({ key: snapshotKey, sessions: data, settled: fetchedAfterMount })
  if (live) return data
  if (snapshot.key !== snapshotKey || (!snapshot.settled && fetchedAfterMount)) {
    // React's derived-state pattern: re-render at once with the new snapshot.
    setSnapshot({ key: snapshotKey, sessions: data, settled: fetchedAfterMount })
    return data
  }
  return snapshot.sessions
}

/**
 * "⚠ <Agent> is already running in “<chat>”. Make sure this request won’t
 * conflict with it. Open" — on a surface about to start one more session on
 * an agent that already has one. Sessions side by side are the user's call:
 * this warns and blocks nothing. Open goes to the most recent session.
 *
 * Renders nothing while none of the agents runs. It exists only sometimes, so
 * a surface places it last, below its controls (`ux_rules.md` §1). Live, it
 * may appear or go away while the user types (a run ending elsewhere) and
 * must move nothing above it; a surface with content below it freezes it
 * instead (`live={false}`, {@link useShownSessions}). One entry per running
 * agent; the sentence wraps rather than losing its advice, with Open inline
 * at its end, described by its own sentence when several agents are listed
 * (§10).
 */
export function AgentActiveSessionNotice({
  agents,
  scale = 'chrome',
  advice = 'conflict',
  excludeChatIds,
  live = true,
  snapshotKey,
  className = ''
}: {
  /** The agents the surface would start a session on, with the names to show. */
  agents: readonly { id: string; name: string }[]
  scale?: NoticeScale
  advice?: NoticeAdvice
  /** Sessions the surface already names elsewhere (the Tasks tab's running tasks); never counted here. */
  excludeChatIds?: readonly string[]
  /** False: a snapshot taken at the user's gesture, see {@link useShownSessions}. */
  live?: boolean
  /** With `live={false}`: what the snapshot is of (the task, say); a new key takes a new one. The agents are always part of it. */
  snapshotKey?: string
  className?: string
}): React.JSX.Element | null {
  const { data, isFetchedAfterMount } = useAgentActiveSessions()
  const key = `${snapshotKey ?? ''}|${agents.map((agent) => agent.id).join(',')}`
  const sessions = useShownSessions(data, isFetchedAfterMount, live, key)
  const openSession = useOpenSession()
  const baseId = useId()
  const running = runningSessionsOf(agents, sessions, excludeChatIds)
  if (running.length === 0) return null
  const { text, line, icon } = SCALE[scale]
  return (
    <div data-agent-active-session className={className}>
      {running.map(({ agent, sessions: own }, index) => {
        const sentence = activeSessionSentence(agent.name, own, advice)
        const sentenceId = `${baseId}-${index}`
        // Main lists sessions newest first.
        const latest = own[0]
        return (
          <div key={agent.id} role="status" className={`flex min-w-0 items-start gap-1.5 ${text}`}>
            <span className={`flex shrink-0 items-center ${line}`}>
              <AlertTriangle size={icon} className="text-[var(--color-warning)]" aria-hidden="true" />
            </span>
            <p className="min-w-0 break-words">
              <span id={sentenceId} className="text-[var(--color-text-secondary)]">{sentence}</span>{' '}
              <button
                type="button"
                aria-describedby={sentenceId}
                title={openSessionTitle(latest)}
                onClick={() => openSession(latest)}
                className="whitespace-nowrap font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
              >
                Open
              </button>
            </p>
          </div>
        )
      })}
    </div>
  )
}
