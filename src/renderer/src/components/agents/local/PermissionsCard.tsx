import { useState } from 'react'
import { Loader2, ShieldCheck, X } from 'lucide-react'
import {
  useForgetAgentGrants,
  useHandoversCheck,
  useLocalAgentGrants,
  useSetClaudeApproval,
  useSetCodexApproval,
  useSetHandovers
} from '../../../hooks/useLocalAgents'
import { formatRelativeFromDate } from '../../../utils/cinnaTime'
import { unwrapIpcError } from '../../../utils/ipcError'
import { DESKTOP_STATE_FILE } from '../../../../../shared/kit/manifest'
import { describePermissionAction } from '../../../../../shared/localAgentRequests'
import {
  bareInstructionsFileList,
  type BareInstructionsFile,
  type LocalAgentDto
} from '../../../../../shared/localAgents'
import {
  DEFAULT_AGENT_ENGINE,
  DEFAULT_CLAUDE_APPROVAL,
  effectiveEngine,
  isAgentEngine,
  isClaudeApproval,
  type ClaudeApproval
} from '../../../../../shared/engine'
import {
  allowsAuto,
  DEFAULT_HANDOVER_SETTING,
  HANDOVERS_DIR,
  type HandoverSetting
} from '../../../../../shared/handovers'
import { handoverAutoOverriddenText, handoverIgnoreText } from '../../../utils/handoverText'
import { useDefaultRuntime } from '../../../hooks/useEngine'
import { AgentCard } from './AgentCard'
import { FIELD, LABEL } from './fieldClasses'

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
  const bare = agent.kind === 'bare'
  /**
   * This agent runs on the user's own Claude Code install. Its permission
   * story is a different one — the CLI's own classifier sits in front of the
   * desktop's — so the card says that story rather than the OpenCode
   * profile's, which would describe rules that are not in force.
   *
   * **The effective engine, not the declared one.** An agent that names no
   * engine on a machine whose Default Runtime is Claude Agent runs on Claude
   * Code, with the CLI's reviewer in front of every ask — and a card reading
   * only the manifest would describe the OpenCode profile and hide the
   * Approvals control that is actually in force. `effectiveEngine` is the
   * shared rule the launcher applies, so this card and the turn cannot
   * disagree about whose permission system is running.
   */
  const { data: defaultRuntime } = useDefaultRuntime()
  const onCodex = effectiveEngine(agent.runtime, defaultRuntime?.engine ?? DEFAULT_AGENT_ENGINE) === 'codex'
  const onClaude =
    effectiveEngine(agent.runtime, defaultRuntime?.engine ?? DEFAULT_AGENT_ENGINE) === 'claude'
  /**
   * Nothing can answer "whose permission system" yet: the folder leaves the
   * engine to this machine, and this machine has not said.
   *
   * The claim waits rather than being guessed. Guessing OpenCode renders a
   * paragraph about a profile and then replaces it with a paragraph *and a
   * select*, pushing the grants list down a tenth of a second after the tab
   * opens (ux_rules rule 1) — and on a security surface the retracted sentence
   * is the one that describes who approves a command.
   *
   * Only for an agent whose folder settles nothing: one that names an engine, a
   * credential or a model is answered by `effectiveEngine` without the machine
   * default, so it never waits.
   */
  const engineUnknown =
    defaultRuntime === undefined &&
    !isAgentEngine(agent.runtime?.engine) &&
    (agent.runtime?.credential ?? '') === '' &&
    (agent.runtime?.model ?? '') === ''
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
      // A bare agent's grants are not in its folder — that is the point of
      // adopting one, and `desktopStatePath` moves them under `userData` so a
      // shared working tree stays clean. Naming `app-data/desktop.json` here
      // pointed at a file that is not there and offered to reveal it.
      file={bare ? undefined : DESKTOP_STATE_FILE}
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
      {engineUnknown ? (
        /*
          Neither claim, and no movement either: the two branches are different
          heights anyway, so what is reserved here is the smaller of them — the
          grants list below shifts once when the answer lands, which is a
          different thing from a sentence being *retracted*. One line, so the
          tab is never blank.
        */
        <div className="min-h-[3.25rem] text-[10px] italic text-[var(--color-text-muted)]">
          Reading which runtime this agent uses…
        </div>
      ) : onCodex ? (
        <CodexApprovals agent={agent} />
      ) : onClaude ? (
        <ClaudeApprovals agent={agent} />
      ) : (
        <OpenCodeProfile
          bare={bare}
          instructionsFile={agent.instructionsFile ?? null}
          overriddenNames={overriddenNames}
        />
      )}

      {/*
        Bare folders only, and outside the engine branch above: a handover is a
        brief dropped into the folder, which is a thing a folder has whatever
        engine reads it. A kit folder is published and Cinna already writes into
        it, so `.cinna/handovers` there would travel with the kit — it is not a
        handover target at all (`drafts/file_handovers` §3.8).
      */}
      {bare && <HandoversSetting agent={agent} />}

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
      ) : null}
      {/*
        Where a bare agent's grants live, and what that costs. They are keyed on
        the folder's real path, so moving or renaming the folder does not carry
        them — the same fact the Folder tab's identity row states about the
        agent itself, and worth repeating here because this is the card where
        the user decided to trust it.
      */}
      {bare && (
        <div className="mt-1 text-[10px] italic text-[var(--color-text-muted)]">
          Kept on this machine rather than in the folder, so nothing about a decision you make here
          is written into your repository. They are tied to where the folder sits: moving or
          renaming it starts a new agent{' '}
          {/*
            On Claude a new agent starts on the default setting — Automatic —
            which the paragraph above says approves what it is shown. "Asked
            again" would promise an ask that setting never makes.
          */}
          {onClaude ? 'on the default setting' : 'which is asked again'}.
        </div>
      )}
      {loading || rows.length === 0 ? null : (
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

/**
 * What the OpenCode profile lets an agent do without asking.
 *
 * The sentence is fixed text because the profile is: it is generated in
 * `configGenerator.ts` and is the same for every folder agent unless its
 * manifest overrides it, which the last paragraph reports.
 */
function OpenCodeProfile({
  bare,
  instructionsFile,
  overriddenNames
}: {
  bare: boolean
  /** A bare agent's own instructions file, as main resolved it. */
  instructionsFile: BareInstructionsFile | null
  overriddenNames: string[]
}): React.JSX.Element {
  return (
    <>
    {/*
      Every example here has to be a file the folder actually has.
      
      This card is the user's only statement of what an agent may do to their
      machine, and they read it about a repository they share with other
      people. For a bare folder two of the three examples named files that do
      not exist — `docs/WORKFLOW_PROMPT.md`'s manifest sibling, and
      `credentials/.env` — and a reader who spots two fictional examples
      discounts the third. The third is the one that matters: the paragraph
      below, about a command reaching anything they can.
    */}
    <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
      This agent reads, writes and runs commands inside its own folder without asking. It asks
      first before opening a file outside the folder, fetching a URL, editing{' '}
      {bare ? (
        <>
          its own{' '}
          <span className="font-mono">{instructionsFile ?? bareInstructionsFileList()}</span>
        </>
      ) : (
        'its own prompt or manifest'
      )}
      , running a command that names a key file, or running{' '}
      <span className="font-mono">sudo</span> or <span className="font-mono">rm -r</span>. Its
      file tools can never read or write{' '}
      {bare ? (
        'any file that looks like a key file'
      ) : (
        <>
          <span className="font-mono">credentials/.env</span> or any other key file
        </>
      )}
      .
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
    </>
  )
}

/**
 * Who answers a Claude agent's permission asks before the desktop does.
 *
 * Two settings, and the paragraph describes both **before** the control rather
 * than describing whichever is chosen under it — a sentence that changes with
 * the select would resize the card on every toggle (ux_rules §1), and a user
 * choosing needs to read both anyway.
 *
 * The description of *Automatic* is deliberately blunt. It was watched
 * against the binary (`claude_contract.md` §10): asked for a force push, a
 * global git config rewrite and a write under the home directory, the CLI's
 * classifier approved all of them and the desktop's callback never fired. A
 * card that called that "asks for anything unusual" would be describing a
 * gate that was not seen to close.
 *
 * The error slot under the control is always there, so a refused save does not
 * push the grants list down (ux_rules §12, the hint above and the message
 * below in a slot that is always rendered).
 */
function ClaudeApprovals({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const setApproval = useSetClaudeApproval()
  const [error, setError] = useState<string | null>(null)
  /**
   * The pick, until main has answered. The select is otherwise controlled by
   * the DTO, and main re-scans the folder before it answers — so without this
   * the control snapped back to the old value for the round trip and flipped
   * to the new one afterwards, which is the jump ux_rules §1 forbids. A
   * refused save clears it, and the DTO's own value shows through again.
   */
  const [pending, setPending] = useState<ClaudeApproval | null>(null)
  const stored: ClaudeApproval = agent.desktop.claudeApproval ?? DEFAULT_CLAUDE_APPROVAL
  const current = pending ?? stored

  const change = (value: string): void => {
    if (!isClaudeApproval(value) || value === current) return
    setError(null)
    setPending(value)
    setApproval.mutate(
      { agentId: agent.id, approval: value },
      {
        // The outcome first, then the reason (ux_rules §6).
        onError: (err) => setError(`Nothing was changed — ${lowerFirst(unwrapIpcError(err))}`),
        onSettled: () => setPending(null)
      }
    )
  }

  return (
    <>
      <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        This agent runs on Claude Code under your own login. Reading files and searching never ask.
        The setting below decides who approves a command, an edit or a fetch.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        <span className="font-medium text-[var(--color-text)]">Automatic</span> lets Claude Code’s
        own reviewer approve what it judges routine for what you asked, the way{' '}
        <span className="font-mono">claude</span> does in a terminal with auto mode on. In testing
        it approved
        everything it was shown, including a force push and a change to your global git config, so
        treat it as running the agent without a gate and give it work you would run yourself.{' '}
        <span className="font-medium text-[var(--color-text)]">Ask every time</span> brings every
        command, edit and fetch to a permission block in the chat, where “Always allow” remembers
        it below. On a model without automatic approvals, such as Haiku, the agent asks every time
        regardless and the transcript says so.
      </p>

      <div className="mt-3">
        <label htmlFor="claude-approval" className={LABEL}>
          Approvals
        </label>
        <select
          id="claude-approval"
          className={FIELD}
          value={current}
          disabled={setApproval.isPending}
          onChange={(event) => change(event.target.value)}
        >
          <option value="auto">Automatic</option>
          <option value="ask">Ask every time</option>
        </select>
        {/*
          Always rendered, and one line whatever the message: the turn-lock
          refusal is 93 characters, which wrapped at the 800px minimum and
          moved the list below by a line. The page's own action-error slot
          truncates with the full text on hover, so this does the same.
        */}
        <div
          className="mt-1 h-[15px] truncate text-[11px] leading-[15px] text-[var(--color-danger)]"
          title={error ?? undefined}
        >
          {error}
        </div>
      </div>
    </>
  )
}


function CodexApprovals({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const save = useSetCodexApproval()
  const [error, setError] = useState<string | null>(null)
  return <>
    <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
      Codex can edit files in the agent folder. Access outside its sandbox and network access
      require approval. Ask for approval sends those requests to this chat; Automatic lets
      Codex’s reviewer decide. Both modes keep the workspace sandbox enabled.
    </p>
    <div className="mt-3">
      <label htmlFor="codex-approval" className={LABEL}>Approvals</label>
      <select id="codex-approval" className={FIELD} value={agent.desktop.codexApproval ?? 'ask'}
        disabled={save.isPending} onChange={(event) => {
          const approval = event.target.value
          if (!isClaudeApproval(approval)) return
          setError(null)
          save.mutate({ agentId: agent.id, approval }, { onError: (err) => setError(unwrapIpcError(err)) })
        }}>
        <option value="ask">Ask for approval</option>
        <option value="auto">Automatic</option>
      </select>
      <div role="alert" className="mt-1 h-[15px] truncate text-[11px] text-[var(--color-danger)]" title={error ?? undefined}>{error}</div>
    </div>
  </>
}

/**
 * Whether a brief dropped into this folder runs without asking.
 *
 * **This is the security boundary, not the brief's own `execution: auto`**
 * (`drafts/file_handovers` §3.4). Anything that can write to the folder can
 * plant a brief — including a `git pull` — so the permission lives here, on the
 * desktop, per agent, and defaults to asking.
 *
 * Which is why the git line under the select is always rendered: the answer is
 * *evidence* for the choice above it, it has something true to say in every
 * state (`ux_rules.md` §1), and in the two states that forbid `auto` it is the
 * only thing on the card that explains why the option is greyed out. One line,
 * truncated with the whole sentence on hover, like the refusal slot on the
 * cards above — a status line that wrapped to two lines on a narrow card would
 * move the grants list the moment git answered (§12).
 *
 * The refusal, by contrast, is rendered only when there is one, below the
 * status line and last in the block: it exists only when something went wrong,
 * so a reserved slot for it would be padding (§1).
 *
 * In the one state where the line reports a stored setting that is not in
 * force, it carries the action that clears it — on the same line, so nothing
 * moves, and in the accent, because a text button in the colour of the sentence
 * beside it is not a control anybody finds (§11).
 */
function HandoversSetting({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const save = useSetHandovers()
  const query = useHandoversCheck(agent.id)
  /*
    A read that failed is not a read that is still running. Left as
    `undefined` the line below would say "Checking git…" for ever and the
    `auto` option would stay enabled on evidence nobody has — so a failure
    becomes the `unknown` answer, which is exactly what it is and which
    forbids `auto` for the same reason main does.
  */
  const check = query.data ?? (query.isError ? ({ result: 'unknown' } as const) : undefined)
  const [error, setError] = useState<string | null>(null)
  /**
   * The pick, until main has answered — the same optimistic hold the approval
   * selects use, for the same reason: main re-scans the folder before it
   * answers, and rendering the stored value alone snapped the control back for
   * the length of the round trip (§1).
   */
  const [pending, setPending] = useState<HandoverSetting | null>(null)
  const stored: HandoverSetting = agent.desktop.handovers ?? DEFAULT_HANDOVER_SETTING
  /*
    Disabled, not hidden: an option that vanishes teaches nothing, and the line
    below says what would have to change for it to come back. Only once the
    check has answered — greying it out while the answer is in flight would
    offer it a moment later, which is the same jump seen from the other side.
  */
  const autoBlocked = check !== undefined && !allowsAuto(check)
  const autoOverridden = autoBlocked && stored === 'auto'
  /*
    **The select shows what would happen, not what is stored.** A folder set to
    `auto` whose handovers git tracks asks anyway — main refuses the automatic
    start — so a select reading "Run automatically" beside a line saying
    automatic runs are unavailable made the user read the refusal as the bug.
    The stored value is not lost: the line below is where it still shows, and it
    comes back into force by itself once git stops objecting.
  */
  const effective: HandoverSetting = stored === 'auto' && autoOverridden ? 'ask' : stored
  const current = pending ?? effective

  /*
    The same slot, one sentence or the other: git's verdict, or — when the
    folder is set to `auto` and that verdict forbids it — the setting and the
    reason it is not in force, which is the only place the stored value is
    still visible now that the select shows the effective one.
  */
  const statusLine = autoOverridden
    ? handoverAutoOverriddenText(check)
    : handoverIgnoreText(check)

  return (
    <div className="mt-3">
      <label htmlFor="handovers-setting" className={LABEL}>
        Handovers
      </label>
      {/*
        One line, under the label and above the control it describes: this card
        has no (?) affordance to put standing explanation behind (§12), and a
        paragraph here would be read once and scrolled past for ever after.
      */}
      <div className="mb-1 text-[10px] text-[var(--color-text-muted)]">
        A brief left in <span className="font-mono">{HANDOVERS_DIR}/</span> becomes a task for this
        agent.
      </div>
      <select
        id="handovers-setting"
        className={FIELD}
        value={current}
        disabled={save.isPending}
        onChange={(event) => {
          const value = event.target.value
          if ((value !== 'ask' && value !== 'auto') || value === current) return
          setError(null)
          setPending(value)
          save.mutate(
            { agentId: agent.id, handovers: value },
            {
              // The outcome first, then the reason (§6). Nothing was granted,
              // and the select falls back to what is still stored on its own.
              onError: (err) => setError(`Nothing was changed — ${lowerFirst(unwrapIpcError(err))}`),
              onSettled: () => setPending(null)
            }
          )
        }}
      >
        <option value="ask">Ask before running</option>
        <option value="auto" disabled={autoBlocked}>
          Run automatically
        </option>
      </select>
      <div className="mt-1 flex items-baseline gap-2 text-[10px] leading-[15px]">
        <span className="truncate text-[var(--color-text-muted)]" title={statusLine}>
          {statusLine}
        </span>
        {/*
          The way out of a setting the user cannot otherwise reach. While git
          overrules `auto` the select shows the effective `ask`, so choosing
          `ask` in it is not a change and fires nothing — the stored `auto`
          stayed, silently, and came back into force the day the folder's
          .gitignore did. This is the one control that clears it.

          Accent, not the muted colour of the sentence it sits beside
          (`ux_rules.md` §11), and on the line that is already there, so
          nothing moves when it appears (§1).
        */}
        {autoOverridden && (
          <button
            type="button"
            className="shrink-0 font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)] disabled:opacity-50"
            disabled={save.isPending}
            onClick={() => {
              setError(null)
              setPending('ask')
              save.mutate(
                { agentId: agent.id, handovers: 'ask' },
                {
                  onError: (err) => setError(`Nothing was changed — ${lowerFirst(unwrapIpcError(err))}`),
                  onSettled: () => setPending(null)
                }
              )
            }}
          >
            Switch to ask
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="mt-1 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
    </div>
  )
}
