import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Circle, Minus } from 'lucide-react'
import { markdownComponents } from '../../../utils/markdownComponents'
import { useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { useNewChatFlow } from '../../../hooks/useNewChatFlow'
import { useUIStore } from '../../../stores/ui.store'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'

/**
 * The cards the desktop only reads.
 *
 * Each renders the real contents of a real file wherever there is one, and says
 * plainly what is missing where there is not. The parts that need a later phase
 * — running a command, showing a run — render their state and disable the
 * control rather than hiding it, so the shape of the finished page is visible
 * from the first release.
 *
 * Runtime used to live here and no longer does: it writes to the manifest now,
 * so it is in `RuntimeCard.tsx` with the rest of the editing cards.
 */

const EMPTY = 'text-[10px] italic text-[var(--color-text-muted)]'

/**
 * Credential slots and whether `credentials/.env` defines their variables.
 *
 * Names only. No value in that file is ever read by the desktop, let alone sent
 * to the renderer, so this card can say a key is present and nothing more.
 */
export function CredentialsCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  return (
    <AgentCard
      title="Credentials"
      file="credentials/.env"
      // The folder, not the file: a `.env` that does not exist yet cannot be
      // revealed (`showItemInFolder` on a missing path is a silent no-op), and
      // this tab's cards have nowhere to report a failure. Creating and opening
      // the file is the *runtime panel's* affordance — "Add them in
      // credentials/.env" — which has the reserved line to say what it did. So
      // the title promises the folder rather than naming a file it never opens.
      revealTitle="Reveal the credentials folder"
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: 'credentials' })}
    >
      {agent.credentials.length === 0 ? (
        <div className={EMPTY}>This agent declares no credentials.</div>
      ) : (
        <ul className="space-y-2">
          {agent.credentials.map((slot) => (
            <li key={slot.name} className="flex items-start gap-2">
              {slot.satisfied ? (
                <Check size={12} className="mt-0.5 shrink-0 text-[var(--color-success)]" />
              ) : (
                <Minus
                  size={12}
                  className={`mt-0.5 shrink-0 ${
                    slot.optional ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-warning)]'
                  }`}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[var(--color-text)]">
                  {slot.name}
                  {slot.optional && (
                    <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">
                      optional
                    </span>
                  )}
                </div>
                <div className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  {slot.expectedKeys.length === 0
                    ? 'No variable names declared'
                    : slot.expectedKeys
                        .map((key) => `${key}${slot.presentKeys.includes(key) ? ' ✓' : ''}`)
                        .join('  ')}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 text-[10px] text-[var(--color-text-muted)]">
        Values live in <code>credentials/.env</code>, which stays on this machine. Cinna reads only
        which variable names are set.
      </div>
    </AgentCard>
  )
}

/**
 * `docs/CLI_COMMANDS.yaml`. Run opens (or reuses the pattern the sidebar's
 * "Start chat" affordance already uses for a remote agent) a new chat bound
 * directly to this agent and sends `/run:<name>` — the same message the
 * composer's `/` popup would insert, so the two entry points converge on one
 * execution path (`agent_a2a.ipc.ts`'s `/run:` interception) rather than
 * this card doing its own thing.
 */
export function CommandsCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { startNewChat } = useNewChatFlow()
  const [runningName, setRunningName] = useState<string | null>(null)

  const run = async (name: string): Promise<void> => {
    if (runningName) return
    setRunningName(name)
    try {
      // Switch to the chat view first — `startNewChat` sets `activeChatId`
      // but does not itself decide which screen is on top, and the whole
      // point of "Run" is to watch the command stream in.
      setActiveView('chat')
      await startNewChat({
        message: `/run:${name}`,
        agentIds: [agent.id],
        mode: null,
        providerId: null,
        // Never read on this path: exactly one agent id and no on-demand
        // MCPs always takes `useNewChatFlow`'s direct-A2A branch, which binds
        // the chat to the agent and sends — it never reaches `resolveModel`.
        providers: undefined,
        allModels: undefined,
        mcpIds: []
      })
    } finally {
      setRunningName(null)
    }
  }

  return (
    <AgentCard
      title="Commands"
      file="docs/CLI_COMMANDS.yaml"
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: 'docs/CLI_COMMANDS.yaml' })}
    >
      {agent.commands.length === 0 ? (
        <div className={EMPTY}>
          No commands yet. Add them to <code>docs/CLI_COMMANDS.yaml</code> and they appear here.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {agent.commands.map((command) => (
            <li key={command.name} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[var(--color-text)]">/run:{command.name}</div>
                {command.description && (
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    {command.description}
                  </div>
                )}
                <code className="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-text-secondary)]">
                  {command.localCommand}
                </code>
              </div>
              <button
                type="button"
                onClick={() => run(command.name)}
                disabled={runningName !== null}
                title={`Run in a new chat with ${agent.name}`}
                className="shrink-0 rounded-md px-2 py-1 text-[10px] font-medium
                  text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
                  hover:text-[var(--color-text)] transition-colors
                  disabled:cursor-not-allowed disabled:opacity-40"
              >
                {runningName === command.name ? 'Starting…' : 'Run'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </AgentCard>
  )
}

/** `app-data/storage/STATUS.md` — what the agent last said about itself. */
export function StatusCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const status = agent.status
  return (
    <AgentCard
      title="Status"
      file="app-data/storage/STATUS.md"
      onReveal={() =>
        openPath.mutate({ agentId: agent.id, relPath: 'app-data/storage/STATUS.md' })
      }
    >
      {!status ? (
        <div className={EMPTY}>
          This agent has not written a status yet. It appears once a run updates{' '}
          <code>STATUS.md</code>.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            {status.state && (
              <span className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                <Circle size={6} className="fill-current text-[var(--color-text-muted)]" />
                {status.state}
              </span>
            )}
            {status.updatedAt && (
              <span className="text-[10px] text-[var(--color-text-muted)]">
                updated {status.updatedAt}
              </span>
            )}
          </div>
          {status.summary && (
            <div className="text-xs text-[var(--color-text)]">{status.summary}</div>
          )}
          {status.body.trim() && (
            <div className="markdown-body text-xs leading-relaxed text-[var(--color-text-secondary)]">
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {status.body}
              </Markdown>
            </div>
          )}
        </div>
      )}
    </AgentCard>
  )
}

/** `publications[]` — the Cinna instances this folder was pushed to. */
export function PublishedCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  return (
    <AgentCard
      title="Published to"
      file={MANIFEST_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })}
    >
      {agent.publications.length === 0 ? (
        <div className={EMPTY}>Not published anywhere yet.</div>
      ) : (
        <ul className="space-y-1.5">
          {agent.publications.map((publication) => (
            <li key={`${publication.platform_url}:${publication.agent_id}`} className="text-xs">
              <div className="truncate text-[var(--color-text)]">{publication.platform_url}</div>
              <div className="font-mono text-[10px] text-[var(--color-text-muted)]">
                {publication.agent_id}
                {publication.updated_at ? ` · ${publication.updated_at}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </AgentCard>
  )
}

/** Turns this agent has taken. Populated when the engine can run one. */
export function RunsCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  return (
    <AgentCard
      title="Runs"
      file="app-data/desktop.json"
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: 'app-data' })}
    >
      {agent.desktop.sessionCount === 0 ? (
        <div className={EMPTY}>
          No runs yet. Chatting with a folder agent arrives with the local engine.
        </div>
      ) : (
        <div className="text-xs text-[var(--color-text-secondary)]">
          {agent.desktop.sessionCount} saved session
          {agent.desktop.sessionCount === 1 ? '' : 's'}
        </div>
      )}
    </AgentCard>
  )
}
