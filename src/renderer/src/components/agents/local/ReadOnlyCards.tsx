import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Circle, Minus } from 'lucide-react'
import { markdownComponents } from '../../../utils/markdownComponents'
import { useOpenAgentCredentials, useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { useNewChatFlow } from '../../../hooks/useNewChatFlow'
import { useUIStore } from '../../../stores/ui.store'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { unwrapIpcError } from '../../../utils/ipcError'
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
 * Open `credentials/.env` in an editor from the Folder tab, and say what the
 * click did where the user cannot see it.
 *
 * Two outcomes need a line. A refusal — a read-only `credentials/`, a `.env`
 * symlinked out of the folder — otherwise leaves the click inert, and a fallback
 * to the file manager means the editor step did not happen, which is the
 * *normal* outcome wherever nothing is registered for `.env` (ux_rules rule 6).
 * `created` needs nothing: the file opens in front of the user. The line is
 * rendered only once there is something to say, below everything the card
 * shows, so it pushes nothing the user is about to click. It is replaced when
 * the *next result* lands, never on the click: a line under the Credentials
 * card vanishing as the Files row is pressed moved that row up under the
 * pointer, and the second click a 15 s wait invites then landed on the row
 * below it (ux_rules rule 1).
 *
 * **One instance per tab**, owned by `FolderTab` and handed to the two cards
 * that name the file: the Credentials header and the Files row are the same
 * action, so one note stands at a time — under the card that was clicked, which
 * is why `open` takes the card's name and `outcome` asks for it back — and a
 * click in flight (the macOS `open -t` fallback can take 15 s) disables both
 * links, not only the one clicked. The page re-renders rather than remounts on
 * an agent switch, so a result that lands after the switch is dropped rather
 * than shown under the wrong agent.
 */
export type CredentialsOpener = 'credentials' | 'files'

export interface OpenCredentialsFile {
  open: (from: CredentialsOpener) => void
  pending: boolean
  /** The line for one card: its own last click's outcome, or nothing. */
  outcome: (from: CredentialsOpener) => React.ReactNode
}

export function useOpenCredentialsFile(agentId: string): OpenCredentialsFile {
  const openCredentials = useOpenAgentCredentials()
  const [message, setMessage] = useState<{
    from: CredentialsOpener
    text: string
    danger: boolean
  } | null>(null)
  const shownAgentId = useRef(agentId)
  // A note about one agent's file must not survive a switch to another agent.
  useEffect(() => {
    shownAgentId.current = agentId
    setMessage(null)
  }, [agentId])
  const open = (from: CredentialsOpener): void => {
    openCredentials.mutate(agentId, {
      onSuccess: (result) => {
        if (shownAgentId.current !== agentId) return
        setMessage(
          result.revealed
            ? {
                from,
                text: 'Nothing here opens .env, so credentials/.env was shown in the file manager.',
                danger: false
              }
            : null
        )
      },
      onError: (err) => {
        if (shownAgentId.current !== agentId) return
        setMessage({
          from,
          text: unwrapIpcError(err, 'credentials/.env could not be opened.'),
          danger: true
        })
      }
    })
  }
  const outcome = (from: CredentialsOpener): React.ReactNode =>
    message && message.from === from ? (
      <div
        role={message.danger ? 'alert' : 'status'}
        // Secondary, not muted: the Credentials card's standing paragraph is
        // muted, and a note set the same way read as its third sentence rather
        // than as what the click did.
        className={`mt-2 text-[10px] ${
          message.danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
        }`}
      >
        {message.text}
      </div>
    ) : null
  return { open, pending: openCredentials.isPending, outcome }
}

export function CredentialsCard({
  agent,
  env
}: {
  agent: LocalAgentDto
  /** The tab's one `credentials/.env` opener — see {@link useOpenCredentialsFile}. */
  env: OpenCredentialsFile
}): React.JSX.Element {
  return (
    <AgentCard
      title="Credentials"
      file="credentials/.env"
      // The file itself, not its folder. Finder hides dotfiles by default, so a
      // reveal of `credentials/` showed a folder that looked empty and left the
      // user to find (or create) the file. Main creates it when it is missing,
      // and the one outcome a click cannot show for itself — a fallback to the
      // file manager, or a refusal — is said in the line below the card's text.
      revealTitle="Open credentials/.env in your text editor, creating it if it isn't there yet"
      onReveal={() => env.open('credentials')}
      revealDisabled={env.pending}
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
      {env.outcome('credentials')}
    </AgentCard>
  )
}

/**
 * `docs/CLI_COMMANDS.yaml`. Run opens (or reuses the pattern the sidebar's
 * "Start chat" affordance already uses for a remote agent) a new chat bound
 * directly to this agent and sends `/run:<name>` — the same message the
 * composer's `/` popup would insert, so the two entry points converge on one
 * execution path (`agent_a2a.ipc.ts`'s `/run:` interception) rather than
 * this card doing its own thing. It lands the sidebar on Chats as the two
 * "Start chat" buttons do: this leaves the user in a conversation too.
 */
export function CommandsCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const { startNewChat } = useNewChatFlow()
  const [runningName, setRunningName] = useState<string | null>(null)

  const run = async (name: string): Promise<void> => {
    if (runningName) return
    setRunningName(name)
    try {
      // Switch to the chat view first — `startNewChat` sets `activeChatId`
      // but does not itself decide which screen is on top, and the whole
      // point of "Run" is to watch the command stream in. The sidebar moves
      // with it for the reason both chat buttons move it: once the centre is
      // a conversation, an agents list beside it relates to nothing on screen.
      setActiveView('chat')
      setSidebarTab('chats')
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
  // A **bare** agent's state deliberately does not live in its folder — that is
  // the whole point of adopting one — so naming `app-data/desktop.json` here
  // would point at a file that is not there and offer to reveal it. The card
  // says where it is instead, in a sentence rather than a path, because the
  // location under `userData` is not somewhere the user has business going.
  const bare = agent.kind === 'bare'
  return (
    <AgentCard
      title="Runs"
      file={bare ? undefined : 'app-data/desktop.json'}
      onReveal={bare ? undefined : () => openPath.mutate({ agentId: agent.id, relPath: 'app-data' })}
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
      {bare && (
        <div className={`mt-2 ${EMPTY}`}>
          Kept on this machine, outside the folder — nothing about a run is written into your
          repository.
        </div>
      )}
    </AgentCard>
  )
}
