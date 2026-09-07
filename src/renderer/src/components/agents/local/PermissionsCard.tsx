import { useState } from 'react'
import { Loader2, ShieldCheck, X } from 'lucide-react'
import { useForgetAgentGrants, useLocalAgentGrants } from '../../../hooks/useLocalAgents'
import { formatRelativeFromDate } from '../../../utils/cinnaTime'
import { unwrapIpcError } from '../../../utils/ipcError'
import { DESKTOP_STATE_FILE } from '../../../../../shared/kit/manifest'
import { describePermissionAction } from '../../../../../shared/localAgentRequests'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'

/** The key `revoking` holds while "Forget all" is the button in flight. */
const ALL = '\u0000all'

/**
 * When a rule was granted, in the form that reads at that distance.
 *
 * A standing permission is meant to outlive the conversation that made it, so
 * this row eventually says "368d ago" — a number nobody converts. Past a month
 * a date is the readable answer, and the recent case keeps the relative form
 * the rest of the app uses.
 */
function whenGranted(decidedAt: number, now: Date): string {
  const date = new Date(decidedAt)
  if (now.getTime() - decidedAt > THIRTY_DAYS_MS) return `on ${date.toLocaleDateString()}`
  return formatRelativeFromDate(date, now)
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/** First letter down, so a sentence can carry a message that begins as one. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** First letter up. The phrases are written mid-sentence; a row starts one. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * What this agent may do without asking, and what the user has told it it may
 * do without asking *again*.
 *
 * Two halves, and the first is why the card exists at all rather than only the
 * list. The default profile changed — an agent now reads, writes and runs
 * commands inside its own folder outright — and a user who notices that it
 * stopped asking deserves to find the reason on the agent's own page rather
 * than infer it. The sentence is fixed text because the profile is: it is
 * generated in `configGenerator.ts` and is the same for every folder agent
 * unless its manifest overrides it.
 *
 * The second half is the store behind *Always allow*. It lives in the folder's
 * `app-data/desktop.json` — never in OpenCode's own saved grants, which name no
 * agent and would authorise every other one — so the card names that file like
 * every other card on this page names the file it renders.
 *
 * Revoking is the only action here, and it is not destructive in the sense
 * `ux_rules.md` §5 guards: nothing is lost that the agent cannot ask for again,
 * which is exactly what the empty state promises. So no confirm dialog, and the
 * failure — a folder that has gone away, a read-only disk — is reported in a
 * line under the list, beside the action that failed.
 */
export function PermissionsCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const { data: grants } = useLocalAgentGrants(agent.id)
  // Owned by the card rather than by a row: a row unmounts the moment the
  // grant it renders is forgotten, and a mutation owned there would drop its
  // own error handler with it (`ux_rules.md` §5, and the same lesson as the
  // delete dialog).
  const forget = useForgetAgentGrants()
  const [error, setError] = useState<string | null>(null)
  // Which row's × was pressed, so the spinner replaces *that* icon rather than
  // every button dimming together — a revoke that says nothing about which row
  // it is undoing is the security-decision version of an unlabelled spinner
  // (ux_rules §1: async state is inline).
  const [revoking, setRevoking] = useState<string | null>(null)
  const now = new Date()
  // **`undefined` is not `[]`.** Collapsing them rendered "Nothing yet" — a
  // positive claim that this agent has no standing permissions — for the round
  // trip it takes to find out, for an agent that has four (ux_rules §1: reserve
  // the space or don't show it).
  const loading = grants === undefined
  const rows = grants ?? []
  // Named, not merely announced: "some of these rules may be wrong" tells the
  // user the paragraph above is unreliable and nothing else. The manifest is
  // already on the page, so the keys cost nothing to read (ux_rules §7 — a hint
  // names the consequence).
  const overriddenNames = Object.keys(agent.runtime?.permissions ?? {}).sort()

  const revoke = (key?: string): void => {
    setError(null)
    setRevoking(key ?? ALL)
    forget.mutate(
      { agentId: agent.id, key },
      {
        // The outcome first, then the reason. `Could not save this agent's
        // local state.` describes a file; what the user needs to know is that
        // nothing was forgotten and this agent will still not ask (ux_rules §6,
        // and §5's "nothing was removed").
        onError: (err) => setError(`Nothing was forgotten — ${lowerFirst(unwrapIpcError(err))}`),
        onSettled: () => setRevoking(null)
      }
    )
  }

  return (
    <AgentCard
      title="Permissions"
      file={DESKTOP_STATE_FILE}
      actions={
        rows.length > 0 && !forget.isPending ? (
          <button
            type="button"
            disabled={forget.isPending}
            onClick={() => revoke()}
            className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
              disabled:opacity-50 transition-colors"
          >
            Forget all
          </button>
        ) : forget.isPending && revoking === ALL ? (
          <span className="text-[10px] text-[var(--color-text-muted)]">Forgetting…</span>
        ) : undefined
      }
    >
      <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        This agent reads, writes and runs commands inside its own folder without asking. It asks
        first before opening a file outside the folder, fetching a URL, editing its own prompt or
        manifest, running a command that names a key file, or running{' '}
        <span className="font-mono">sudo</span> or <span className="font-mono">rm -r</span>. Its
        file tools can never read or write <span className="font-mono">credentials/.env</span> or
        any other key file.
      </p>
      {/*
        **The sentence the review made unavoidable.** The default profile allows
        the shell tool outright, and the engine gates a command by its *text*,
        not by what it touches: a command can read a key file, write one, or
        reach the network without any of the rules above applying. The paragraph
        above would be a false sense of a boundary without this, and this card
        is the one place a user goes to find out what their agent may do.
      */}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        A command is not fenced in the way those tools are. The check on key files reads the
        command, so it catches the obvious spelling and not a path built inside a script: like a
        terminal left open in this folder, a command can reach anything you can. Give an agent work
        you would be willing to run yourself.
      </p>

      {/*
        The sentence above describes the profile the desktop generates, and a
        manifest can replace whole entries of it (`runtime.permissions`, merged
        one permission name at a time in `configGenerator.ts`). Where it does,
        the sentence is no longer the whole truth and the card says so rather
        than quietly describing rules that are not in force. Rendered from the
        manifest the page already holds, so it costs no query and cannot arrive
        late and move the list.
      */}
      {overriddenNames.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
          This folder’s <span className="font-mono">cinna-agent.json</span> replaces the rules for{' '}
          <span className="font-mono">{overriddenNames.join(', ')}</span> in its{' '}
          <span className="font-mono">runtime.permissions</span> block.
        </p>
      )}

      <div className="mt-3 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        Always allowed
      </div>
      {loading ? (
        <div className="mt-1 text-[10px] italic text-[var(--color-text-muted)]">Reading…</div>
      ) : rows.length === 0 ? (
        <div className="mt-1 text-[10px] italic text-[var(--color-text-muted)]">
          Nothing yet. Choosing “Always allow” on a permission request in a chat remembers it here,
          for this agent only.
        </div>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((grant) => (
            <li key={grant.key} className="flex items-start gap-2">
              <ShieldCheck size={12} className="mt-0.5 shrink-0 text-[var(--color-success)]" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[var(--color-text)]">
                  {/*
                    The phrase, not `grant.action`: `external_directory` and
                    `webfetch` are the engine's vocabulary, and this card is
                    read by whoever owns the agent, not by whoever wrote the
                    binary.
                  */}
                  {sentenceCase(describePermissionAction(grant.action))}{' '}
                  {/*
                    A `*` grant covers the whole action — it comes from an ask
                    that named no resource at all — and a bare asterisk in the
                    pattern column reads as a filename. It is the broadest row
                    on the card, so it says so in words instead.
                  */}
                  {grant.pattern === '*' ? (
                    <span className="ml-1.5 text-[11px] text-[var(--color-text-secondary)]">
                      anywhere, every time
                    </span>
                  ) : (
                    <span className="ml-1.5 font-mono text-[11px] text-[var(--color-text-secondary)] break-all">
                      {grant.pattern}
                    </span>
                  )}
                </div>
                {grant.decidedAt > 0 && (
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    Allowed {whenGranted(grant.decidedAt, now)}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={forget.isPending}
                onClick={() => revoke(grant.key)}
                aria-label={`Forget permission to ${describePermissionAction(grant.action)}: ${
                  grant.pattern === '*' ? 'anywhere' : grant.pattern
                }`}
                title="Ask again next time"
                className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]
                  hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
              >
                {revoking === grant.key ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <X size={12} />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Below the list, so a failure never moves the row whose button raised it. */}
      {error && <div className="mt-2 text-[11px] text-[var(--color-danger)]">{error}</div>}
    </AgentCard>
  )
}
