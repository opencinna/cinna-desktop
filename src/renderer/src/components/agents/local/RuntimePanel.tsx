import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, Circle, Loader2, Minus } from 'lucide-react'
import {
  useOpenAgentCredentials,
  useSetBareAgentRuntime,
  useSetLocalAgentRuntime
} from '../../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../../utils/ipcError'
import { useDefaultChatMode } from '../../../hooks/useChatModes'
import { useModels } from '../../../hooks/useModels'
import { useProviders } from '../../../hooks/useProviders'
import {
  useAntigravityAuth,
  useClaudeAuth,
  useCodexAuth,
  useEngineLogin,
  type EngineLoginControl
} from '../../../hooks/useLocalTools'
import {
  useAntigravityBinary,
  useClaudeBinary,
  useCodexBinary,
  useDefaultRuntime,
  useEngineBinary
} from '../../../hooks/useEngine'
import { claudeVersionLabel } from '../../settings/claudeStatus'
import { codexVersionLabel } from '../../settings/codexStatus'
import { antigravityDefaultOptionLabel, antigravityRunModelLabel, antigravityVersionLabel } from '../../settings/antigravityStatus'
import { AntigravityTermsTip } from '../../settings/AntigravityTermsTip'
import { useRuntimeSetup } from '../../../hooks/useRuntimeSetup'
import { useAppSettings, useSetAppSetting } from '../../../hooks/useAppSettings'
import { useAgentCredentialResolution } from '../../../hooks/useAgentAiCredential'
import { credentialOptionLabel } from '../../../utils/credentialLabel'
import { isCredentialUsable } from '../../../../../shared/credentials'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import {
  ANTIGRAVITY_TIER_MODEL,
  CLAUDE_TIER_ALIAS,
  claudeModelForComplexity,
  codexEffortForComplexity,
  codexEffortForRuntime,
  declaredEffort as declaredEffortOf,
  DEFAULT_AGENT_ENGINE,
  ENGINE_LOGIN_NAMES,
  effectiveEngine,
  isAgentEngine,
  KEEP_ENGINE,
  PINNED_ANTIGRAVITY_VERSION,
  PINNED_CLAUDE_VERSION,
  PINNED_CODEX_VERSION,
  type AgentEngine,
  type ClaudeAuthState,
  type EngineLoginId,
  loginFailureLead,
  loginPendingText,
  opencodeVersionLabel
} from '../../../../../shared/engine'
import { FIELD, LABEL, SUMMARY_BADGE } from './fieldClasses'
import { useRuntimeModelCatalog, useRuntimeModelCatalogRefresh } from '../../../hooks/useRuntimeModelCatalog'
import { useUIStore } from '../../../stores/ui.store'
import {
  catalogDefaultModel,
  catalogNeedsRefresh,
  cliModelTier,
  effortsFor,
  isModelOffered
} from '../../../../../shared/runtimeModelCatalog'
import { SettingsInfoTip } from '../../settings/SettingsLayout'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { isStaleWriteError } from '../../../../../shared/localAgents'
import {
  defaultRuntimeModelId,
  modelBelongsElsewhere,
  resolveRuntimeModel
} from '../../../../../shared/runtimeDefaults'
import {
  describeCredential,
  describeModel,
  NO_CATALOGUE,
  type RuntimeFacts,
  type RuntimeMessage
} from '../../../../../shared/runtimeMessages'
import {
  bestInTier,
  classifyModel,
  isWorkComplexity,
  WORK_COMPLEXITIES,
  WORK_COMPLEXITY_HINTS,
  WORK_COMPLEXITY_LABELS,
  type WorkComplexity
} from '../../../../../shared/modelFamilies'

/**
 * "Runs with": the one thing on this page a user actually configures.
 *
 * Which credential and model the agent runs on, whether the engine that would
 * run it is up, and whether the secrets the folder declares are in place — on
 * one panel, as controls, with a warning only where something is wrong. What it
 * writes is a credential **name** and a model id — never a key, and never our
 * internal provider id, which means nothing once the folder is on somebody
 * else's machine.
 *
 * ## One panel, two places to keep the answer
 *
 * For a **kit** agent it is a viewer over `cinna-agent.json` like everything
 * else here: the write goes through the same stamped `update-field` path as the
 * prompt editors, so an assistant editing the manifest while this is open
 * cannot be clobbered.
 *
 * A **bare** agent has no manifest, and its folder is one Cinna promised to
 * write nothing into — so its choice lands in that agent's state under
 * `userData` instead, through `setRuntime`, with no stamp because there is no
 * file in the folder for anyone else to have changed. That is the entire
 * difference, and it is confined to `commit` and one note at the foot of the
 * panel. The scanner puts both on `agent.runtime`, so every picker, every tier
 * resolution and every message below reads one field and asks no questions
 * about where it came from.
 *
 * This was two components, and the bare one had no controls at all: it could
 * only report that the agent ran on the Default runtime. An agent the user
 * adopted from their own repository is not a lesser agent, and "which credential
 * pays for this" is the one question they most need an answer to.
 *
 * Both pickers read from the hooks the rest of the app already uses —
 * `useProviders` and `useModels` — rather than fetching a parallel list, and
 * what "Default" resolves to comes from `shared/runtimeDefaults`, the same
 * function the engine's own resolution calls. That sharing is the point: the
 * bug this panel was rebuilt around was a label that predicted a different
 * runtime than the one the engine would build.
 *
 * The consequence to keep in mind: `useModels` is the *aggregate registry* and
 * one network round trip per credential, so it lands after the provider list.
 * Until it does, the pickers cannot answer honestly — a model the registry has
 * not listed yet is indistinguishable from one that belongs to another
 * credential — so they wait, and the reserved line below them says so.
 *
 * ## Work Complexity
 *
 * The second picker asks how hard the work is — Simple, Medium, Complex — rather
 * than which model to run, because a provider catalogue is a list nobody outside
 * this industry can read and it grows on its own. Each option still names the
 * model it resolves to on the selected credential: the user is choosing what gets
 * billed, and a tier that did not say what it meant would be worse than the list
 * it replaced.
 *
 * **Advanced** swaps it for the raw model list. It is a remembered preference
 * (`localAgentsModelAdvanced`) but not a mode — the agent's own runtime wins. An
 * agent that names a model always opens on the model picker and one that names a
 * tier always opens on the tier, or the panel would show a choice it has not made.
 * Ticking the box therefore *converts*: a model becomes the tier it belongs to,
 * a tier becomes the model it currently resolves to. Both directions keep the
 * agent on the same runtime, and both say what they did in the status line —
 * they rewrite the agent's runtime behind a control that only claims to change
 * the view, so they cannot happen wordlessly.
 */

/**
 * The Runs-on select's value for the Claude engine.
 *
 * Prefixed so it cannot be confused with a credential *name*, which is what
 * every other option's value is. A credential literally called `engine:claude`
 * would be shadowed by this; that is accepted rather than defended against,
 * because the alternative is a second parallel control and the collision needs
 * a user to name a credential after an implementation detail of this select.
 */
const CLAUDE_OPTION = 'engine:claude'
const CODEX_OPTION = 'engine:codex'
const ANTIGRAVITY_OPTION = 'engine:antigravity'
/**
 * Selected, never pickable: an engine this build cannot run with no credential
 * named runs on OpenCode with the fallback credential. Selecting `''` there
 * claimed the machine's Default runtime — Claude Agent on some machines — and
 * picking Default fired no change, so the unrecognised engine could not be dropped.
 */
const UNSUPPORTED_OPTION = 'engine:unsupported'

/**
 * {@link FIELD} without its `w-full`, for the two selects that share the Model
 * column's row: `w-full` is emitted after `w-[4.75rem]` in the built CSS and
 * wins, so the effort select took the row and the model select shrank to its
 * chevron. Each of the two sets its own width instead.
 */
const FIELD_IN_ROW = FIELD.replace(/(^|\s)w-full(\s|$)/, ' ').trim()

const NOTE = 'text-[10px] text-[var(--color-text-muted)]'
const WARN = 'text-[10px] text-[var(--color-warning)]'
const DANGER = 'text-[10px] text-[var(--color-danger)]'

/** One line of the panel's reserved status slot; `login` makes it the logged-out line with its button. */
/**
 * `title` carries the full sentence when `text` is the short form that fits the
 * 800px line; `refresh` puts the labelled Refresh button after the text.
 */
type StatusLine = { text: string; tone: string; login?: EngineLoginId; title?: string; refresh?: true }

/**
 * A bordered button at **this panel's** scale, sized to the 16px status slot.
 *
 * Not `SettingsButton`: that is the Settings scale (13px, ~28px tall), and in
 * the reserved `h-4` line it would either overflow it or grow the panel and move
 * the tab strip below (ux_rules rules 1 and 12 — a component takes the scale of
 * the surface it renders into). Primary text colour and a border, so it reads
 * as a control beside the muted and red prose around it (rule 11).
 */
const LINE_BUTTON =
  'inline-flex h-4 shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 ' +
  'text-[10px] font-medium leading-none text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'

/**
 * The logged-out line: **Log in**, then what is happening.
 *
 * The button runs the engine's own login (`claude auth login` / `codex login`)
 * on the binary the turns use — usually Cinna's managed copy, which is not on
 * PATH, so the old "run `claude` in a terminal" pointed at a binary that was
 * not there. It stays in place in every state so the row never shifts: idle it
 * says why, pending it waits on the browser beside Cancel, and after a sign-in
 * that did not finish it introduces the terminal command shown on the row
 * below ({@link LoginCommandRow}).
 */
function LoginLine({ text, tone, engine, login }: {
  text: string
  tone: string
  engine: EngineLoginId
  login: EngineLoginControl
}): React.JSX.Element {
  // The lead is shared with the composer and the build page, so all three say it alike.
  const lead = loginFailureLead(login.failure)
  const line = login.pending
    ? loginPendingText(engine, login.phase)
    : lead
      ? login.failure?.command
        ? `${lead} You can also run this in a terminal:`
        : lead
      : text
  return (
    <div className="flex h-4 min-w-0 items-center gap-2">
      {/* Google's terms behind a (?) before Log in: one fixed icon inside the
          line's fixed height, so it reserves no row, and ahead of the button
          whose spinner widens it, so it never slides (ux_rules rule 1). */}
      {engine === 'antigravity' && (
        <span className="flex h-4 shrink-0 items-center">
          <AntigravityTermsTip />
        </span>
      )}
      <button
        type="button"
        className={LINE_BUTTON}
        aria-disabled={login.pending || undefined}
        aria-busy={login.pending}
        onClick={() => { if (!login.pending) login.start() }}
      >
        {login.pending && <Loader2 size={10} className="animate-spin" />}
        Log in
      </button>
      <span className={`min-w-0 truncate ${login.pending ? NOTE : tone}`} title={line}>
        {line}
      </span>
      {login.pending && (
        <button type="button" className={LINE_BUTTON} onClick={login.cancel}>
          Cancel
        </button>
      )}
    </div>
  )
}

/**
 * The terminal fallback after a sign-in that did not finish: the exact command
 * — absolute binary, quoted — and a copy button. Rendered only then, below the
 * reserved line, so the healthy panel keeps its height (ux_rules rule 1).
 */
function LoginCommandRow({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px]">
      <code className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]" title={command}>
        {command}
      </code>
      <button
        type="button"
        className={LINE_BUTTON}
        onClick={() => {
          // Main's clipboard: `navigator.clipboard` rejects without document focus.
          void window.api.clipboard
            .writeText(command)
            .then((result) => setCopied(result.success ? 'yes' : 'failed'))
            .catch(() => setCopied('failed'))
        }}
      >
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * The third column's row: a dot, a word, and optionally one button.
 *
 * **Extracted because the panel's footprint depends on it.** Both engines
 * render into this slot, and switching between them must not change the panel's
 * height — the page's tab strip sits directly below and moving it out from
 * under the pointer that just used the select is what ux_rules rule 1 exists to
 * prevent. While the two branches each inlined their own `h-[26px]`, that
 * property held only because two independent literals happened to agree, and
 * nothing would have failed if one of them drifted.
 *
 * `dot` and `tone` are passed in rather than derived, because the two engines
 * report different things through the same row. They used to differ more: a
 * green dot on OpenCode meant *the shared process is running*, where Claude's
 * only knowable fact was that a binary had been found. Phase 3 gave both the
 * same shape — a binary, and where it came from — so both are muted now, and
 * the colours are still the caller's to pass because the *states* are not the
 * same set.
 */
function EngineRow({
  label,
  dot,
  tone,
  text,
  title,
  action
}: {
  label: string
  dot: string
  tone: string
  text: string
  title: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <div className="flex h-[26px] items-center gap-2 text-xs">
        <Circle size={7} className={`shrink-0 fill-current ${dot}`} />
        <span className={`min-w-0 truncate ${tone}`} title={title}>
          {text}
        </span>
        {action}
      </div>
    </div>
  )
}

/**
 * Which `opencode` this agent will run on, and nothing about a process.
 *
 * **There is no Start button any more, and no "Running".** Before phase 3 of
 * the agent runtime plan one shared `opencode serve` sat behind every folder
 * agent, so this row reported a server and offered to start it. A turn now
 * spawns its own child, speaks ACP to it over stdio and lets the pool reap it
 * two minutes later — so "running" would be true for a couple of minutes after
 * a message and false the rest of the time, describing an implementation detail
 * that appears and disappears on its own. A row like that is the healthy state
 * wearing a status light (ux_rules rules 2 and 12).
 *
 * What is left is the same fact the Claude row reports, which is why the two
 * now read alike: **a binary was found, and where it came from.** The dot stays
 * muted for it, because a found file is not an achievement; `failed` is the one
 * state a user can act on — a path they typed in Settings — and the reserved
 * line below the grid carries its sentence, exactly as it carries Claude's.
 */
function EngineStatus(): React.JSX.Element {
  const { data: binary } = useEngineBinary()
  const state = binary?.state ?? 'unresolved'

  // Short enough for the column that never grows — the same 219px cap that cut
  // the Claude row's copy down (ux_rules rule 7). The explanation lives in the
  // reserved line below and in `title`.
  const text =
    state === 'ready'
      // 2.x's `--version` line already says `opencode v2.0.27`.
      ? `opencode${binary?.state === 'ready' && binary.version ? ` ${opencodeVersionLabel(binary.version)}` : ''}`
      : state === 'resolving'
        ? 'Downloading…'
        : state === 'failed'
          ? 'Not available'
          : 'On the first message'
  const title =
    state === 'ready' && binary?.state === 'ready'
      ? binary.path
      : state === 'resolving'
        ? 'Downloading the pinned opencode build. This happens once and takes about a minute.'
        : state === 'failed' && binary?.state === 'failed'
          ? binary.error
          : 'Cinna resolves an opencode the first time you chat with this agent — yours from PATH if you have one, a verified copy otherwise.'

  return (
    <EngineRow
      label="Engine"
      /*
        **One light per state.** `failed` was an amber dot over red text — two
        different claims about the same fact, side by side (ux_rules rule 2).
        Danger for both: unlike the Claude rung's `awaiting auth` amber, this is
        not a state one command fixes on a healthy install; there is no engine
        to run on at all until the user changes something.

        `ready` stays muted, and deliberately differs from Settings' green tick
        for the same fact: this cell's vocabulary is shared with the Claude rung
        beside it, where muted means "a binary was found" and green is reserved
        for something running. Each side matches its own neighbours, which is
        the rule that wins when two surfaces disagree.
      */
      dot={
        state === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
      }
      tone={
        state === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
      }
      text={text}
      title={title}
    />
  )
}


/**
 * A pinned CLI that is not here, in each surface's words: the summary badge and
 * Engine cell (`badge`), the Runs-on option (`option`), the reserved line
 * (`line`) and the Engine cell's tooltip (`hint`).
 *
 * **Two different failures.** With a path saved in Local Development nothing
 * was installing — main only stats that file and runs its `--version` — so
 * "Install failed… could not be installed" described something that never
 * happened, and sent the user to a *Try again* that re-checks the same path.
 * A saved path is the whole test: main never downloads over one. "Not usable"
 * rather than "not found", because the file may exist and refuse to run.
 * Remedy first in `line`: it is measured to clip (ux_rules rule 7).
 */
function cliFailureCopy(
  name: string,
  pathNoun: string,
  pathSet: boolean
): { badge: string; option: string; line: string; hint: string } {
  return pathSet
    ? {
        badge: 'Path not usable',
        option: 'path not usable',
        line: `Fix the ${pathNoun} path in Settings → Local Development: it could not be run.`,
        hint: `The ${pathNoun} path you set could not be run. Fix or clear it in Settings → Local Development.`
      }
    : {
        badge: 'Install failed',
        option: 'install failed',
        line: `Try again in Settings → Agents → Runtime: ${name} could not be installed.`,
        hint: `${name} could not be installed. Try again in Settings → Agents → Runtime.`
      }
}

/**
 * Who pays, as much of it as the CLI actually said.
 *
 * The account and the plan answer one question between them — *which login is
 * this turn billed to?* — and either can be absent, so the four shapes are
 * spelled out rather than assembled from optional fragments: a half-built
 * sentence with a stray dash or an empty parenthesis is worse than the shorter
 * true one.
 *
 * The plan is passed through, capitalised and no more. This app does not own the
 * set of plan names, and a lookup table would render one it had not heard of as
 * blank on the very line that exists to say who pays.
 *
 * The account **is** shown, and the organisation deliberately is not: `orgId`
 * and `orgName` are never read out of the CLI's answer at all. This line can
 * outrun its width at the 800px minimum with a long address, which the `title`
 * on the status line covers — the alternative was naming a subscription without
 * naming whose, on a machine that may hold more than one login.
 */
function accountSuffix(email: string | null, subscriptionType: string | null): string {
  const plan = subscriptionType
    ? `${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)} plan`
    : null
  if (email && plan) return ` — ${email} (${plan})`
  if (email) return ` — ${email}`
  if (plan) return ` (${plan})`
  return ''
}

/**
 * The user's own Claude Code install, as a fact about their machine.
 *
 * Deliberately **not** a mirror of {@link EngineStatus}: there is no process
 * this app starts, nothing to report as running or stopped, and so no Start
 * button. What can be said is what was detected, and that is all that is said.
 *
 * "Claude Code" is the right words here even though the picker above says
 * "Claude Agent" — a product name is constrained for a third-party surface, but
 * naming the tool the user installed, at the path they installed it to, is a
 * statement about their machine and is what makes the line diagnosable.
 *
 * **The cell's text is about the install; only its dot knows about the login.**
 * Not because the login is unknowable — `claude auth status` answers it for
 * free, and the reserved line below says what it found — but because this
 * column is fixed at 219px and does not widen with the window, so the text
 * holds the shortest true thing and the line that can grow carries the
 * meaning. The dot is the exception, and `const dot` below says why.
 */
function ClaudeStatus({
  label = 'Claude Code',
  tool,
  unknown,
  auth,
  hint,
  missingText = 'Not installed'
}: {
  label?: string
  tool?: { path: string | null; version: string | null }
  /**
   * What the cell says when there is no tool. "Not installed" is a statement
   * about a CLI the user installs; for one Cinna manages the only tool-less
   * state is an install that failed, and the sentence beside the cell and the
   * summary badge both already say *Install failed*.
   */
  missingText?: string
  /**
   * The tooltip when there is no path to show. Without it the fallback is "none
   * was found on this machine" — true for a CLI the user installs, false for
   * one Cinna manages and simply has not fetched yet.
   */
  hint?: string
  /** Detection is still in flight — say so rather than denying an install. */
  unknown?: boolean
  /** What the login probe found, or undefined while it is still asking. */
  auth?: ClaudeAuthState
}): React.JSX.Element {
  if (unknown) {
    return (
      <EngineRow
        label="Engine"
        dot="text-[var(--color-text-muted)]"
        tone="text-[var(--color-text-muted)]"
        text="Checking…"
        title={`Looking for ${label} on this machine`}
      />
    )
  }
  // **Short enough for the column that will never grow.** This cell is fixed at
  // 219px once the grid reaches three columns and does not widen with the
  // window — the panel's content caps at 729px — so the *wider* the window, the
  // more certain a long string clips. "No Claude Code found on this machine"
  // needs 232px and was therefore permanently truncated at every width from
  // 1200px up, which is where a default-sized window sits (ux_rules rule 7).
  // The reserved line below carries the explanation; this cell names the state.
  const text = tool ? `${label}${tool.version ? ` ${tool.version}` : ''}` : missingText
  /**
   * **Warning for a login this app knows is missing, and only for that.**
   *
   * The reserved line below turns red on a logged-out machine while this dot —
   * the one glanceable indicator in the row — stayed neutral grey, saying
   * nothing about a state the app had just gone and found out. The type scale's
   * Status Indicator Pattern assigns `--color-warning` to exactly this case
   * ("Awaiting auth"), which is also why it is not `--color-danger`: the
   * install is fine and one command fixes it.
   *
   * The rule this does **not** break is the one about green, and it is the
   * reason this dot is never the success colour whatever the login says: one
   * option away in this same select a green dot in this exact slot means *the
   * process is running*. Green in both would be one indicator, in one position,
   * meaning two things, and the weaker claim would be read as the stronger
   * (rule 9). `unknown` and in-flight stay muted too, because neither is
   * evidence of anything.
   */
  const dot = !tool
    ? 'text-[var(--color-danger)]'
    : auth === 'logged_out'
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-text-muted)]'
  return (
    <EngineRow
      // The same label as the OpenCode branch, not a second name for one slot:
      // "Runs with" is the whole section's accessible name, and a control inside
      // it announcing those words would be two things with one name on one
      // surface (rule 10). On this path the engine *is* the user's Claude Code.
      label="Engine"
      dot={dot}
      tone={tool ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-danger)]'}
      text={text}
      title={tool?.path ?? hint ?? `No ${label} was found on this machine.`}
    />
  )
}

/**
 * The credential slots `cinna-agent.json` declares and whether
 * `credentials/.env` defines their variables. Names only: no value in that file
 * is ever read by the desktop, so this can say a key is present and no more.
 */
function SecretsLine({
  agent,
  onOutcome
}: {
  agent: LocalAgentDto
  /** Say what the click did in the panel's one reserved line — never a new row. */
  onOutcome: (outcome: { text: string; tone: string } | null) => void
}): React.JSX.Element | null {
  const openCredentials = useOpenAgentCredentials()
  if (agent.credentials.length === 0) return null
  const missing = agent.credentials.filter((slot) => !slot.satisfied && !slot.optional)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
      <span className="font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        Secrets
      </span>
      {agent.credentials.map((slot) => (
        <span
          key={slot.name}
          className="flex items-center gap-1 text-[var(--color-text-secondary)]"
          title={
            slot.expectedKeys.length === 0
              ? 'No variable names declared'
              : slot.expectedKeys
                  .map((key) => `${key}${slot.presentKeys.includes(key) ? ' ✓' : ''}`)
                  .join('  ')
          }
        >
          {slot.satisfied ? (
            <Check size={11} className="text-[var(--color-success)]" />
          ) : (
            <Minus
              size={11}
              className={slot.optional ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-warning)]'}
            />
          )}
          {slot.name}
          {slot.optional && <span className="text-[var(--color-text-muted)]">(optional)</span>}
        </span>
      ))}
      <button
        type="button"
        onClick={() => {
          onOutcome(null)
          openCredentials.mutate(agent.id, {
            /**
             * Two outcomes the user cannot see for themselves. A refusal — a
             * read-only `credentials/`, a `.env` symlinked out of the folder —
             * otherwise left the click completely inert, and a reveal means the
             * editor step did not happen, which is the *normal* outcome
             * wherever nothing is registered for `.env` (ux_rules rule 6).
             * `created` needs no line: the file opens in front of the user.
             */
            onSuccess: (result) =>
              onOutcome(
                result.revealed
                  ? {
                      text: 'Nothing here opens .env, so credentials/.env was shown in the file manager.',
                      tone: NOTE
                    }
                  : null
              ),
            onError: (err) =>
              onOutcome({
                text: unwrapIpcError(err, 'credentials/.env could not be opened.'),
                tone: DANGER
              })
          })
        }}
        disabled={openCredentials.isPending}
        className="text-[var(--color-text-muted)] underline-offset-2 transition-colors hover:text-[var(--color-text)]
          hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        title="Opens it in your text editor, creating it if it isn’t there yet — values stay on this machine"
      >
        {missing.length > 0 ? 'Add them in credentials/.env' : 'Edit credentials/.env'}
      </button>
    </div>
  )
}

export function RuntimePanel({
  agent,
  compact = false,
  leading
}: {
  agent: LocalAgentDto
  compact?: boolean
  /**
   * Compact only: a unit for the same row, before the runtime's badges (the
   * team-sharing state). First, so the runtime label settling and the model
   * and issue badges arriving late never move it.
   */
  leading?: ReactNode
}): React.JSX.Element {
  const { data: providers } = useProviders()
  const { data: models, isError: modelsFailed } = useModels()
  const { data: defaultMode } = useDefaultChatMode()
  const { data: settings } = useAppSettings()
  const setSetting = useSetAppSetting()
  /**
   * Where this agent's choice is kept — the one thing that differs by kind.
   *
   * A kit agent's runtime is a block in `cinna-agent.json`: a stamped write,
   * refusable because an assistant may have edited the file since this panel
   * read it. A bare folder has no manifest and is never written into, so the
   * same three values go to that agent's state under `userData` — no stamp, no
   * stale-write refusal, and nothing appearing in the user's `git status`.
   *
   * Everything below this line is deliberately common: the pickers, the tier
   * resolution, the Advanced conversion and every message they produce read
   * `agent.runtime`, which the scanner fills from the manifest for one kind and
   * from the desktop state for the other. Two panels is what this used to be,
   * and the bare one could only say what the runtime *was*.
   */
  const bare = agent.kind === 'bare'
  const saveManifest = useSetLocalAgentRuntime()
  const saveBare = useSetBareAgentRuntime()
  const saving = bare ? saveBare.isPending : saveManifest.isPending
  const [error, setError] = useState<string | null>(null)
  /**
   * What the last click on the secrets line did, where the user clicked it.
   *
   * Its own state rather than `error`, because one of the two things it says is
   * a note and not a failure, and because it is cleared by a *different* event:
   * a save clears it (below), since a message about `credentials/.env` must not
   * outlive the action the user has since taken in the pickers above it.
   */
  const [secrets, setSecrets] = useState<{ text: string; tone: string } | null>(null)
  /**
   * What the last credential change did to the model, kept until the next one.
   *
   * Clearing a model the new credential cannot serve is right, but it rewrites
   * a file the user commits, so it cannot happen wordlessly (ux_rules rule 6).
   * Tagged with the agent it happened to: this panel is remounted with a new
   * `agent` when the page switches, and a notice about somebody else's model
   * would be worse than none.
   */
  /**
   * What the last action did, kept until the manifest stops matching it.
   *
   * The note describes a specific state of `cinna-agent.json`, and it sits at
   * priority 2 — above almost everything. An assistant editing the file while
   * this panel is open therefore left a sentence claiming a write the file no
   * longer reflected, outranking the messages that were still true.
   *
   * Two states rather than one, and that is what makes it race-free: `was` is
   * the manifest when the note was made and `wrote` is what the write put there.
   * The note stands while the file is in either — which covers the window
   * between `setDropped` and the query refetching, without an effect and without
   * the note flickering off and back on. A *third* state is somebody else's
   * edit, and the note goes.
   */
  interface NoteState {
    model: string | null
    complexity: WorkComplexity | null
  }
  const [dropped, setDropped] = useState<{
    agentId: string
    text: string
    was: NoteState
    wrote: NoteState
  } | null>(null)

  const { data: claudeAuth } = useClaudeAuth()
  const { data: codexAuth } = useCodexAuth()
  const { data: antigravityAuth } = useAntigravityAuth()
  const { data: binary } = useEngineBinary()
  const { data: codexBinary } = useCodexBinary()
  const { data: claudeBinary } = useClaudeBinary()
  const { data: antigravityBinary } = useAntigravityBinary()
  const declaredCredential = agent.runtime?.credential ?? null
  const declaredModel = agent.runtime?.model ?? null
  /**
   * The engine the manifest names, if it is one this build knows. Read through
   * `isAgentEngine`, so a value a newer tool wrote reads as none here — and is
   * never written back by this panel: saves that are not an engine pick send
   * `KEEP_ENGINE`, and main leaves the file's value as it is.
   */
  const declaredEngine = isAgentEngine(agent.runtime?.engine) ? agent.runtime.engine : null
  /**
   * This agent runs on the user's own Claude Code install rather than on a
   * credential this app holds.
   *
   * Almost every gate below is about a credential, a model catalogue or the
   * OpenCode engine — none of which exists on this path — so this is checked
   * early and branched on rather than woven through each one.
   */
  /**
   * An engine the manifest names that this build cannot run. The agent runs on
   * **OpenCode** (`effectiveEngine`: a preference, never refused), so the panel
   * treats it as an OpenCode agent everywhere: Runs on selects what actually
   * runs, and the preference is told behind the (?) beside its label.
   */
  const declaredEngineRaw = typeof agent.runtime?.engine === 'string' ? agent.runtime.engine.trim() : ''
  const unsupportedEngine = declaredEngineRaw !== '' && !isAgentEngine(declaredEngineRaw) ? declaredEngineRaw : null
  /**
   * **This machine's Default Runtime**, resolved by main and read here as one
   * value.
   *
   * Not assembled from the setting and the detected tools, which this component
   * also has: that sum is `resolveDefaultEngine`, the launcher runs it, and a
   * second copy here is the arrangement that has twice let this panel name a
   * runtime the engine did not build. `undefined` is *not answered yet*, which
   * is a third state the panel needs — see `engineUnknown`.
   */
  const { data: defaultRuntime } = useDefaultRuntime()
  /**
   * The engine the **folder itself** settles, or null when it leaves it to this
   * machine.
   *
   * The same two rungs `effectiveEngine` applies before the default: a declared
   * engine, then a declared credential or model — either of which is an
   * OpenCode-shaped answer, because the Claude path spends no credential and
   * knows no catalogue id. Written out rather than taken from the helper
   * because the panel needs the *intermediate* answer: whether the file decided,
   * which is what tells it whether it may claim anything before the machine
   * default arrives.
   */
  const engineFromFile: AgentEngine | null =
    declaredEngine ??
    (unsupportedEngine !== null || (agent.runtime?.credential ?? '') !== '' || (agent.runtime?.model ?? '') !== ''
      ? 'opencode'
      : null)
  /**
   * Nothing can answer "which engine" yet: the folder leaves it to the machine
   * and the machine has not said.
   *
   * The panel withholds its claim rather than guessing, for the reason
   * `pickerUnknown` exists one screen down — guessing `opencode` renders the
   * tier-or-model pickers and the OpenCode engine column, and the query then
   * replaces both a moment later, swapping controls out from under the pointer
   * (ux_rules rule 1).
   */
  const engineUnknown = engineFromFile === null && defaultRuntime === undefined
  /**
   * What this agent actually runs on — the file first, this machine second.
   *
   * Through the **shared** helper, which `runtimeService.resolve` and the ACP
   * driver's dispatch also call, so the panel and the launcher cannot disagree
   * about an agent that names no engine. Everything below branches on this
   * rather than on the declared value: an agent that declares nothing on a
   * machine defaulting to Claude Agent *is* a Claude agent, and a panel that
   * read only the file would explain it with a credential ladder about a key it
   * will never spend.
   */
  const onClaude =
    effectiveEngine(agent.runtime, defaultRuntime?.engine ?? DEFAULT_AGENT_ENGINE) === 'claude'
  /**
   * The Claude Code this agent would run on, or undefined — **the pinned CLI's
   * state, not PATH detection**, on exactly `codexTool`'s terms below: Cinna
   * verifies its own Claude Code (or runs the explicit path), so it is *here* in
   * every state but a failed install, and the option is always offered. A
   * `claude` on PATH is only what "Open in…" launches.
   */
  const claudePathSet = (settings?.localAgentsClaudePath ?? '').trim() !== ''
  const claudeTool =
    claudeBinary?.state === 'failed'
      ? undefined
      : {
          path: claudeBinary?.state === 'ready' ? claudeBinary.path : null,
          version: claudeVersionLabel(claudeBinary, claudePathSet)
        }
  /** Why Claude Code is not here, in every surface's words — see {@link cliFailureCopy}. */
  const claudeFailure = claudeTool ? null : cliFailureCopy('Claude Code', 'Claude', claudePathSet)
  const onCodex = effectiveEngine(agent.runtime, defaultRuntime?.engine ?? DEFAULT_AGENT_ENGINE) === 'codex'
  const onAntigravity =
    effectiveEngine(agent.runtime, defaultRuntime?.engine ?? DEFAULT_AGENT_ENGINE) === 'antigravity'
  const onCli = onClaude || onCodex || onAntigravity
  /** The in-app login for this agent's CLI engine; asks main nothing on OpenCode. */
  const loginEngine: EngineLoginId | null = onCodex
    ? 'codex'
    : onClaude
      ? 'claude'
      : onAntigravity
        ? 'antigravity'
        : null
  const engineLogin = useEngineLogin(loginEngine)
  /**
   * Picking Claude, Codex or Antigravity under Runs on is a gesture toward that
   * runtime: main then asks whether it is signed in and opens the sign-in on a
   * definite "no". `install: false` — an engine that is not on disk is left to
   * the install line below, and this pick downloads nothing.
   */
  const runtimeSetup = useRuntimeSetup()
  /**
   * A login main ran for a setup (from this pick, or a Settings card) never
   * passes through `useEngineLogin`, so its failure is not that hook's. Shown
   * here too, as Settings shows it — while this engine is still not logged in.
   */
  const setupResult = loginEngine ? runtimeSetup.result(loginEngine) : null
  const authStateByEngine: Record<EngineLoginId, string | undefined> = {
    claude: claudeAuth?.state,
    codex: codexAuth?.state,
    antigravity: antigravityAuth?.state
  }
  const engineAuthState = loginEngine ? authStateByEngine[loginEngine] : undefined
  const setupLoginFailure =
    setupResult?.outcome === 'login_failed' && engineAuthState !== 'logged_in' ? setupResult.login : null
  const login: EngineLoginControl =
    engineLogin.pending || engineLogin.failure || !setupLoginFailure
      ? engineLogin
      : { ...engineLogin, failure: setupLoginFailure }
  // A failed sign-in belongs to the agent and engine it was shown against.
  const resetLogin = login.reset
  /**
   * The terminal command under the line: the last failed sign-in's, **kept
   * while a retry is pending** so the card does not shrink on the press and
   * grow again when the retry fails too (ux_rules rule 1). Dropped after a
   * cancel or a sign-in that worked, and with the agent or engine it was for.
   */
  const [loginCommand, setLoginCommand] = useState<string | null>(null)
  const failedCommand = loginFailureLead(login.failure) ? (login.failure?.command ?? null) : null
  // The reset first: on mount both run, and it must not wipe the command just kept.
  useEffect(() => { resetLogin(); setLoginCommand(null) }, [agent.id, loginEngine, resetLogin])
  useEffect(() => { if (failedCommand) setLoginCommand(failedCommand) }, [failedCommand])
  // Gone outside a login (a cancel, a fix that made it stale): a retry must not
  // bring back a command naming the binary that was replaced.
  useEffect(() => { if (!login.pending && !failedCommand) setLoginCommand(null) }, [login.pending, failedCommand])
  const shownLoginCommand = login.pending ? loginCommand : failedCommand
  /**
   * **The managed CLI's state, not PATH detection.** Every Codex session runs on
   * the pinned copy Cinna installs — or the explicit path from Settings — so a
   * `codex` on the user's PATH says nothing about whether this agent can run.
   * Codex is therefore *here* in every state but one: an install that failed.
   * "Not fetched yet" is not a problem to report; the first Codex turn fetches
   * it, exactly as OpenCode's binary arrives.
   *
   * Shaped like a detected tool on purpose, so the four reads below — the
   * reserved line, the summary badge, whether the option is offered, and the
   * engine cell — keep asking one question.
   */
  const codexPathSet = (settings?.localAgentsCodexPath ?? '').trim() !== ''
  const codexTool =
    codexBinary?.state === 'failed'
      ? undefined
      : {
          path: codexBinary?.state === 'ready' ? codexBinary.path : null,
          // The Settings picker's label, from its function: built inline here it
          // said `<pin> managed` over a saved path that had not been checked.
          version: codexVersionLabel(codexBinary, codexPathSet)
        }
  const codexFailure = codexTool ? null : cliFailureCopy('Codex', 'Codex', codexPathSet)
  /** The pinned Antigravity server, on exactly `codexTool`'s terms. */
  const antigravityPathSet = (settings?.localAgentsAntigravityPath ?? '').trim() !== ''
  const antigravityTool =
    antigravityBinary?.state === 'failed'
      ? undefined
      : {
          path: antigravityBinary?.state === 'ready' ? antigravityBinary.path : null,
          version: antigravityVersionLabel(antigravityBinary, antigravityPathSet)
        }
  const antigravityFailure = antigravityTool
    ? null
    : cliFailureCopy('Antigravity', 'Antigravity', antigravityPathSet)
  const declaredComplexity = isWorkComplexity(agent.runtime?.complexity)
    ? agent.runtime.complexity
    : null
  /** `runtime.effort`, read only beside a declared model, as the launchers read it. */
  const declaredEffort = declaredEffortOf(agent.runtime)

  /**
   * **The CLI runtime's own model list**, for the Advanced picker on Claude,
   * Codex and Antigravity: what the tool last advertised for this profile
   * (kept across restarts by main), never a list of our own. The engine is
   * named by its boolean, not compared by string, so the kind-branch ratchet
   * stays where it is.
   */
  const cliEngine: 'claude' | 'codex' | 'antigravity' | null =
    onCodex ? 'codex' : onAntigravity ? 'antigravity' : onClaude ? 'claude' : null
  const cliName = cliEngine ? ENGINE_LOGIN_NAMES[cliEngine] : ''
  const { data: cliCatalog } = useRuntimeModelCatalog(cliEngine)
  const cliCatalogKnown = !!cliCatalog && cliCatalog.source !== 'unavailable' && cliCatalog.models.length > 0
  /** A model by the name the tool gives it, else its id. */
  const cliNameOf = (id: string | null): string | null =>
    id ? (cliCatalog?.models.find((model) => model.id === id)?.name ?? id) : null
  /** A tier's model by the tool's name for it when listed, else by `fallback` — the same words in the tier and Advanced views. */
  const cliListedName = (id: string, fallback: string): string =>
    cliCatalog?.models.find((model) => model.id === id)?.name ?? fallback
  /** What an agent naming no model of its own runs on, by name. */
  const cliDefaultName = onClaude ? cliListedName(claudeModelForComplexity(declaredComplexity), claudeModelForComplexity(declaredComplexity))
    : onAntigravity ? (declaredComplexity
      ? cliListedName(ANTIGRAVITY_TIER_MODEL[declaredComplexity], antigravityRunModelLabel(null, declaredComplexity))
      : antigravityRunModelLabel(null, null))
    : onCodex && catalogDefaultModel(cliCatalog) ? cliNameOf(catalogDefaultModel(cliCatalog))
    : null
  /**
   * The declared model, judged against that list with the driver's own matching
   * (`isModelOffered`): `true` only once the list is known and lacks it. Never a
   * warning on a guess — an unknown list says nothing.
   */
  const staleModel = cliEngine !== null && declaredModel !== null && isModelOffered(cliCatalog, declaredModel) === false
  /** What the CLI choice converts back to on the tier picker, when the panel can tell (`cliModelTier`). */
  const cliTier = cliEngine && declaredModel !== null ? cliModelTier(cliEngine, declaredModel, declaredEffort, cliCatalog) : undefined
  /**
   * Codex converts by its *default* model, which only the list names. Until the
   * list is known the conversion is neither possible nor refused: the checkbox
   * waits, disabled, and says nothing it would have to take back.
   */
  const cliSessionList = cliCatalog?.source === 'session'
  const cliConversionPending = onCodex && declaredModel !== null && (!cliSessionList || catalogDefaultModel(cliCatalog) === null)
  /**
   * Why Advanced stays on, once — the status line and the checkbox's tooltip
   * read the same branch. The effort is the cause when the model alone would
   * convert.
   */
  const cliUnconvertibleReason = cliEngine && declaredModel !== null && cliTier === null
    ? declaredModel === 'default'
      ? `${cliName}’s own default has no work complexity — pick a model first.`
      : declaredEffort && cliModelTier(cliEngine, declaredModel, null, cliCatalog)
      ? `Advanced stays on — “${declaredEffort}” effort matches no work complexity.`
      : `Advanced stays on — “${cliNameOf(declaredModel)}” matches no work complexity.`
    : null

  /**
   * Which picker this agent gets.
   *
   * The manifest decides on arrival: showing the tier for an agent pinned to a
   * model would misreport what it runs on, which is the failure this panel
   * exists to avoid. The remembered preference breaks the tie for an agent that
   * declares neither.
   *
   * After that the view is **sticky for this agent**, and that is not a
   * refinement — it is the difference between a working panel and one that
   * swaps the control out from under the pointer. Both pickers have choices
   * that leave the manifest declaring nothing: selecting `Default` in either,
   * or switching to a credential that does not list the pinned model. Deriving
   * the view from the manifest alone would answer every one of those by
   * replacing the control the user was just working in with the other one
   * (ux_rules rule 1), and stranding them — the model they came to pick is now
   * behind a checkbox they did not tick.
   *
   * Tagged with the agent, like the notice below and for the same reason: the
   * panel is handed a new `agent` when the page switches, and inheriting the
   * last agent's view would misreport this one's manifest on arrival.
   */
  /**
   * The remembered picker preference is a query too, and it lands on its own
   * schedule — so "which picker" has no answer until it does. Declared up here
   * because the view derivation below needs it, not only the `disabled` gate.
   */
  const settingsLoaded = settings !== undefined
  const [view, setView] = useState<{ agentId: string; advanced: boolean } | null>(null)

  /**
   * Credentials this app can actually make a call with. A managed row flagged
   * `unsupported` (an Anthropic OAuth token, not an API key) is excluded for the
   * same reason the chat modes exclude it: offering it produces a failure at the
   * first turn rather than at the moment of choosing.
   */
  const usable = useMemo(
    () => (providers ?? []).filter(isCredentialUsable),
    [providers]
  )

  /**
   * The credential the manifest's reference resolves to — id, name, then type,
   * searched across **all** providers and preferring a usable one.
   *
   * The **same function** the engine resolves with, not a mirror of it. It used
   * to be a hand-copied one, and the copy is what this comment used to explain:
   * searching only the usable ones made a configured-but-keyless credential
   * resolve to nothing, so the panel said "which is not configured on this
   * machine" — untrue, and it hid the message written for exactly that case. It
   * also fell through to the *default* credential and resolved the catalogue
   * against it, which with tiers labels the picker from a catalogue belonging to
   * a credential the agent does not name.
   *
   * That was fixed once on each side, and then the two drifted again the moment
   * main's tie-break learned to prefer a credential that is switched **on**: two
   * rows named `Anthropic`, one of them off, and the panel resolved the off one
   * while the engine ran the other. So the resolution moved to
   * `shared/credentials`, and neither side has a copy any more.
   */
  /**
   * The Default runtime's credential, looked up across *all* providers rather
   * than the usable ones — `runtimeService.resolveDefault` does the same, and a
   * default mode pointing at a keyless credential must read the same here as it
   * does to the engine. It is not offered as an option; it only names what
   * "Default" means.
   */
  /**
   * **This machine's pinned credential wins over the default chat mode**, the
   * same order `runtimeService.resolveDefault` applies. Settings → Agents
   * → Default AI credential writes `localAgentsDefaultCredentialId`, and a
   * panel that kept reading the chat mode alone would label an agent
   * `Default (OpenAI)` while the engine built it on the pinned Anthropic key —
   * a user reading this card to find out which key they are spending would be
   * told the wrong one, which is the exact failure this module was rebuilt
   * around.
   *
   * A pin naming a credential this machine no longer has falls through to the
   * chat mode, again matching main.
   *
   * All three, and whether the agent's credential is missing, come from
   * `useAgentCredentialResolution`, which the composer's notice row reads too.
   */
  const {
    selected,
    pinnedProvider,
    fallbackProvider,
    effectiveProvider,
    credentialMissing,
    issue: credentialIssue
  } = useAgentCredentialResolution(declaredCredential)

  const modelChoices = useMemo(
    () => (models ?? []).filter((model) => model.providerId === effectiveProvider?.id),
    [models, effectiveProvider?.id]
  )

  /** The chosen credential's catalogue — what a tier is resolved against. */
  const catalogue = useMemo(
    () => modelChoices.map((model) => ({ id: model.id })),
    [modelChoices]
  )
  const providerType = effectiveProvider?.type ?? ''

  /** What the agent's own runtime says the view is, or null when it names neither. */
  const declaredView = declaredModel !== null ? true : declaredComplexity !== null ? false : null

  /**
   * A pinned model that belongs to no family — a gateway's `my-private-llm-7b`,
   * the ordinary case for `openai_compatible`.
   *
   * The tier picker cannot represent this file at all, so Advanced is not a
   * preference here but the only truthful view, and the checkbox is **disabled**
   * rather than left to spring back. A control that snaps to its old value tells
   * the user nothing and invites a second identical click; a disabled one with
   * the reason beside it is a state they can read once and act on. It also
   * removes the need to instruct anyone to clear a hand-written id they cannot
   * retype — clearing the model enables the checkbox on its own.
   */
  const unconvertible = onCli
    ? declaredModel !== null && !cliConversionPending && cliTier === null
    : declaredModel !== null && classifyModel(declaredModel, providerType) === null
  /**
   * The model id the last model → tier conversion moved away from, so the
   * reverse toggle restores it rather than re-deriving one. See
   * {@link toggleAdvanced}: `bestInTier` prefers a stable alias, so re-deriving
   * would quietly trade a deliberately pinned dated snapshot for a floating one.
   */
  const [pinned, setPinned] = useState<{ agentId: string; modelId: string } | null>(null)
  // The same rule on every engine now that the CLI runtimes list their models:
  // the agent's own runtime first, then this agent's sticky view, then the
  // remembered preference.
  const advanced = unconvertible
    ? true
    : view?.agentId === agent.id
      ? view.advanced
      : (declaredView ?? settings?.localAgentsModelAdvanced === true)
  /**
   * True while nothing can answer "which picker" yet: the manifest declares
   * neither and the preference has not arrived.
   *
   * Disabling the control is not enough on its own. `settings?.x === true` reads
   * `false` in flight, so the tier select would *render* and then be replaced by
   * the model select the moment the query resolved for a user whose preference
   * is Advanced — the swap happening behind a disabled control rather than not
   * happening (rule 1). So neither picker is claimed until one is known.
   */
  const pickerUnknown =
    engineUnknown ||
    (declaredView === null && view?.agentId !== agent.id && !settingsLoaded)

  /**
   * **Ask the tool for its list** when the Advanced picker for it is on screen
   * and the list is missing or a day old, and when the agent names a model and
   * no list is known at all (so the stale warning has something to judge by).
   * Main opens a session with no prompt; nothing is billed.
   */
  const wantCliRefresh = cliEngine !== null && cliCatalog !== undefined && (cliConversionPending ||
    ((!compact && advanced && !pickerUnknown && catalogNeedsRefresh(cliCatalog)) || (declaredModel !== null && !cliCatalogKnown)))
  const cliRefresh = useRuntimeModelCatalogRefresh(cliEngine, wantCliRefresh)
  /** Nothing to list yet: the catalogue query, or a refresh of a missing one, is in flight. */
  const cliCatalogLoading = cliEngine !== null && (cliCatalog === undefined || (!cliCatalogKnown && cliRefresh.isFetching))
  const cliRefreshError = cliRefresh.data?.error ?? null
  /** A refresh is in flight for a list already shown (Refresh pressed over a stale model). */
  const cliRefreshing = cliEngine !== null && cliRefresh.isFetching
  /** The effort select is shown where the tool offers efforts, and kept in place on the two that do. */
  /**
   * **Two different things, named apart.** Unset is Cinna's choice — the tier
   * floor on Claude (Sonnet), the server's or the CLI's default elsewhere — so
   * it reads "Not set — <what runs>". The tool's own `default` entry (Claude
   * lists one) is an ordinary choice that hands the pick to the tool, so it is
   * listed like any model, named as the tool's default.
   */
  const cliToolDefault = cliCatalog?.models.find((model) => model.id === 'default') ?? null
  const cliToolDefaultLabel = cliToolDefault
    ? `${cliName} default${cliToolDefault.description && cliToolDefault.description.length <= 24 ? ` (${cliToolDefault.description})` : ''}`
    : ''
  const cliUnsetLabel = onCodex
    ? `Not set — ${cliDefaultName ? `${cliDefaultName} (Codex default)` : 'Codex default'}`
    : `Not set — ${cliDefaultName ?? `${cliName} default`}`
  /** The chosen model's own efforts: none until a model is chosen, none for a model that offers none. */
  const cliEfforts = (effortsFor(cliCatalog, declaredModel) ?? []).filter((effort) => effort.id !== 'default')
  const effortSlot = (onClaude || onCodex) && !pickerUnknown && advanced

  /**
   * The Default runtime, flattened the way `runtimeService.resolveDefault`
   * flattens it — through the shared helper rather than from `defaultMode` raw,
   * because the two disagreed for a second credential of the same provider type
   * and the floor below would have turned that disagreement into a label naming
   * a model the engine never picks.
   */
  const fallback = useMemo(
    () => ({
      // `fallbackProvider?.id`, not `defaultMode.providerId`: when the default
      // mode points at a credential this machine no longer has,
      // `resolveDefault` reports no credential at all, and a fallback that
      // still named the missing id would be a second shape of the same value
      // for the two sides to disagree over later.
      credentialId: fallbackProvider?.id ?? null,
      credentialType: fallbackProvider?.type ?? null,
      // The chat mode's model applies only when the chat mode is what resolved
      // the credential. A pin carries no model of its own, so its credential's
      // default is the answer — `resolveDefault` passes `null` on that branch
      // for the same reason, and lending the mode's model to a different key
      // would name a model that key may not even have.
      modelId: defaultRuntimeModelId(
        fallbackProvider,
        pinnedProvider ? null : (defaultMode?.modelId ?? null)
      )
    }),
    [fallbackProvider, pinnedProvider, defaultMode?.modelId]
  )

  /**
   * What this agent actually runs on, and what "Default" would mean if it
   * declared nothing — both from `resolveRuntimeModel`, which is the function
   * the engine's config generator calls. Two calls rather than one because the
   * `Default (…)` label has to answer a hypothetical: what happens when the user
   * clears their choice.
   */
  const choice = useMemo(
    () =>
      resolveRuntimeModel({
        chosen: effectiveProvider,
        fallback,
        declaredModel,
        declaredComplexity,
        catalogue
      }),
    [effectiveProvider, fallback, declaredModel, declaredComplexity, catalogue]
  )
  const inherited = useMemo(
    () =>
      resolveRuntimeModel({
        chosen: effectiveProvider,
        fallback,
        declaredModel: null,
        declaredComplexity: null,
        catalogue
      }).modelId,
    [effectiveProvider, fallback, catalogue]
  )

  /** A model by *name* — an id like `claude-sonnet-4-5-20250929` does not fit a select. */
  const nameOf = useMemo(() => {
    const byId = new Map((models ?? []).map((model) => [model.id, model.name]))
    return (id: string | null): string | null => (id ? (byId.get(id) ?? id) : null)
  }, [models])
  const inheritedName = nameOf(inherited)

  /**
   * What each tier resolves to on this credential, for the option labels. The
   * user is picking what gets billed, so the tier names its model rather than
   * asking them to trust it.
   */
  const tierModels = useMemo(() => {
    const out = {} as Record<WorkComplexity, string | null>
    for (const tier of WORK_COMPLEXITIES) out[tier] = bestInTier(tier, catalogue, providerType)
    return out
  }, [catalogue, providerType])

  /**
   * This runtime, as `shared/runtimeMessages` needs to see it.
   *
   * The panel used to word its own credential and model problems, and so did
   * `runtimeService.resolve`. The two agreed, which is exactly the state that
   * precedes them not agreeing — and the service's copy had no consumer, so
   * nothing could have caught the drift. Both sides answer from this shape now.
   */
  const facts = useMemo(
    (): RuntimeFacts => ({
      credentialRef: declaredCredential,
      credentialResolved: selected !== null,
      credentialName: effectiveProvider?.name ?? null,
      credentialUsable:
        effectiveProvider !== null && isCredentialUsable(effectiveProvider),
      // The user's off switch, kept apart from usability for the reason
      // `RuntimeFacts` gives: a credential with no key wants "add a key", a
      // credential switched off wants "turn it back on", and the engine now
      // refuses to run on either (`collectEngineProviders`).
      credentialEnabled: effectiveProvider?.enabled ?? false,
      complexity: declaredComplexity,
      modelId: choice.modelId,
      modelSource: choice.origin,
      replacedModelId: choice.replaced,
      catalogueKnown: modelChoices.length > 0
    }),
    [declaredCredential, selected, effectiveProvider, declaredComplexity, choice, modelChoices.length]
  )

  /** Null for a bare agent, which has no manifest to stamp — and needs none. */
  const stamp = agent.stamps[MANIFEST_FILE] ?? null
  /**
   * The model registry is one network round trip *per credential*, so it lands
   * seconds after the provider list on a cold page. Editing before it arrives
   * cannot be done honestly: the Model select would offer a list it has not
   * loaded, and a credential change could not tell a model that belongs to
   * another catalogue from one the registry has simply not listed yet.
   */
  const modelsLoaded = models !== undefined
  const canEdit = bare || (stamp !== null && agent.readiness !== 'contract_too_new')
  const disabled =
    !canEdit ||
    // **The Claude path never waits for the model registry.** There is no
    // catalogue to resolve a tier against — a plan serves what the plan serves,
    // addressed by alias — so gating on it would leave both pickers disabled
    // for ever on a machine with no AI credential configured at all, which is
    // exactly the machine most likely to be using this engine.
    (!onCli && !modelsLoaded && !modelsFailed) ||
    !settingsLoaded ||
    saving

  /**
   * One line, one message, in the reserved slot below the selects.
   *
   * Prioritised rather than stacked, because the slot has a fixed height: a
   * panel that grows on a credential change pushes the page's tab strip down
   * mid-interaction (ux_rules rule 1), which is why the save spinner a few
   * lines below is out of the flow. Everything that used to be its own
   * conditional row goes through here — the refused save and the engine's skip
   * reason included — so no message anywhere in this panel can move the page.
   *
   * Order is "what blocks the agent first, and what the user can act on": a
   * failed write, then what this panel just did, then a credential that does
   * not exist, then a pair that cannot run, then a missing model. The engine's
   * own skip sits below all of them, so the one skip reason that restates a
   * message above it — "its runtime names no model" — never gets the slot.
   */
  /** Does the file still say what the note says it says? */
  const noteStillTrue = (note: { was: NoteState; wrote: NoteState }): boolean =>
    (note.wrote.model === declaredModel && note.wrote.complexity === declaredComplexity) ||
    (note.was.model === declaredModel && note.was.complexity === declaredComplexity)

  /** Record a note against the manifest state it is about. */
  const note = (text: string, wrote?: NoteState): void =>
    setDropped({
      agentId: agent.id,
      text,
      was: { model: declaredModel, complexity: declaredComplexity },
      wrote: wrote ?? { model: declaredModel, complexity: declaredComplexity }
    })

  /** Shared tone → this panel's colour token. */
  const toned = (message: RuntimeMessage): { text: string; tone: string } => ({
    text: message.text,
    tone: message.tone === 'warn' ? WARN : NOTE
  })

  /**
   * What the reserved line says about the CLI runtime's model list, below the
   * install and login rungs and above the healthy sentence: a declared model
   * the tool no longer offers first (it runs on the tool's default instead, and
   * the chat says so), then — only in the Advanced view, where the list is the
   * control — that it is being fetched or could not be, then why Advanced is
   * not available.
   */
  const cliCatalogLine = (): StatusLine | null => {
    // Short, so the line fits at 800px; the whole sentence is the `title`.
    if (cliRefreshing && (staleModel || (advanced && !cliCatalogKnown))) return { text: `Checking ${cliName}’s models…`, tone: NOTE }
    if (staleModel) {
      return {
        text: 'Model no longer offered — choose another.',
        title: `${cliName} no longer offers “${declaredModel}”, so its turns run on ${cliName}’s default until another model is chosen.`,
        tone: WARN,
        refresh: true
      }
    }
    if (advanced && cliCatalogLoading) return { text: `Checking ${cliName}’s models…`, tone: NOTE }
    // Codex converts only by its own session's list; a cached one is shown but cannot convert.
    if (cliConversionPending) {
      if (cliRefreshError) return { text: `Couldn’t list ${cliName}’s models.`, title: cliRefreshError, tone: WARN, refresh: true }
      if (cliRefreshing) return { text: `Checking ${cliName}’s models…`, tone: NOTE }
    }
    if (advanced && !cliCatalogKnown) {
      return cliRefreshError
        ? { text: `Couldn’t list ${cliName}’s models.`, title: cliRefreshError, tone: WARN, refresh: true }
        : { text: `${cliName} has not listed its models yet.`, tone: WARN, refresh: true }
    }
    if (unconvertible && cliUnconvertibleReason) {
      if (declaredModel === 'default') return { text: cliUnconvertibleReason, tone: NOTE }
      return {
        text: declaredEffort && cliEngine && declaredModel && cliModelTier(cliEngine, declaredModel, null, cliCatalog)
          ? `Advanced stays on — no tier for “${declaredEffort}” effort.`
          : `Advanced stays on — no tier for “${cliNameOf(declaredModel)}”.`,
        title: cliUnconvertibleReason,
        tone: NOTE
      }
    }
    return null
  }

  const status = ((): StatusLine | null => {
    if (error) return { text: error, tone: DANGER }
    // What the user just clicked outranks a note about a write before it.
    if (secrets) return secrets
    if (dropped && dropped.agentId === agent.id && noteStillTrue(dropped)) {
      return { text: dropped.text, tone: NOTE }
    }
    /**
     * **No engine to run on outranks every question about which model.**
     *
     * A binary this machine could not get — a path typed into Settings that
     * does not work, a download that could not reach the network — is the one
     * engine-level state left that a user can act on, and it sits here for the
     * same reason the Claude rung below sits above the credential ladder: with
     * no engine, "your default chat mode uses a switched-off credential" is a
     * true sentence about something that would not help. It is also what the
     * Engine column is showing in red at that moment, and a cell whose only
     * explanation was a hover `title` while the line below talked about a
     * credential was the mismatch this ordering fixes.
     *
     * It replaces the shared config's *skip* list, which used to fill this slot
     * with `credential_unavailable` / `no_model`. Those are not lost: the
     * credential and model rungs below say the same things from *this* agent's
     * resolved runtime, rather than echoing what one global config generation
     * happened to leave out.
     */
    if (!onCli && binary?.state === 'failed') return { text: binary.error, tone: DANGER }
    /**
     * **The Claude engine leaves the credential ladder entirely**, above every
     * loading state below it.
     *
     * Everything from here down is about a credential row, a model catalogue or
     * the OpenCode engine. Run this path through them and a perfectly healthy
     * agent is explained with "your default chat mode uses a credential that is
     * switched off" — a sentence about a key it does not spend, which the user
     * would act on by changing something that cannot help.
     *
     * What is said is only what is knowable *before* a turn — and that set grew.
     * Whether the install is logged in used to need a turn to find out, so this
     * line claimed nothing about it; `claude auth status` now answers it for
     * free, and the ladder below says login or logout on the strength of that.
     * What is still never asserted is a subscription the CLI did not name: the
     * plan is reported when it reports one, and inferring one because this app
     * stripped an environment variable would be a claim about an environment it
     * does not fully control.
     */
    if (onCodex) {
      // Its own state query, not PATH detection: see `codexTool`.
      if (codexBinary === undefined) return null
      // Only a failure reaches here — an install, or a saved path; the copy
      // branches on which (`cliFailureCopy`).
      if (codexFailure) return { text: codexFailure.line, tone: DANGER }
      // The Log in button leads the line (see `LoginLine`); the turn error says
      // "choose Log in", so the two surfaces give one instruction.
      if (codexAuth?.state === 'logged_out') return { text: 'Codex is not logged in.', tone: DANGER, login: 'codex' }
      const catalogLine = cliCatalogLine()
      if (catalogLine) return catalogLine
      {
        const codexModel = cliNameOf(declaredModel) ?? cliDefaultName ?? 'its configured default model'
        const codexEffort = codexEffortForRuntime(agent.runtime)
        return {
          // Short: a long model id must not push the effort off the 800px line.
          text: `Codex on ${codexModel}, ${codexEffort} reasoning effort.`,
          title: `Codex uses your CLI login and configuration, on ${codexModel}, with ${codexEffort} reasoning effort.`,
          tone: NOTE
        }
      }
    }
    if (onAntigravity) {
      // The Codex rung, on Google's login. No effort: Antigravity has none to set.
      if (antigravityBinary === undefined) return null
      if (antigravityFailure) return { text: antigravityFailure.line, tone: DANGER }
      if (antigravityAuth?.state === 'logged_out') {
        return { text: 'Antigravity is not logged in.', tone: DANGER, login: 'antigravity' }
      }
      const catalogLine = cliCatalogLine()
      if (catalogLine) return catalogLine
      return { text: `Antigravity uses your Google login, on ${cliNameOf(declaredModel) ?? cliDefaultName}.`, tone: NOTE }
    }
    if (onClaude) {
      // Silent until its own state query answers — not PATH detection, which
      // this engine no longer depends on. The slot is reserved, so saying
      // nothing costs no movement.
      if (claudeBinary === undefined) return null
      if (claudeFailure) {
        return {
          /*
            As on the Codex rung above. The retry is not offered *here*: this
            panel is a viewer over one agent's runtime, and a machine-wide
            install button on it would be the second place a single fact is
            acted on. This is the only place the full sentence lives — the
            Engine column says the two words.
          */
          text: claudeFailure.line,
          tone: DANGER
        }
      }
      // **The login, now that it is knowable before a turn** — `claude auth
      // status` answers it for free, so the panel is no longer guessing.
      //
      // **Silent until the probe answers**, for the same reason the binary
      // state is silent one rung up. `undefined` is the query in flight, and filling
      // the slot with the reassuring install sentence meant a logged-out
      // machine read healthy in muted grey and was then contradicted in red
      // about a tenth of a second later — measured at t=891ms and t=996ms on a
      // real machine. There is no movement either way, the line is reserved;
      // what a retraction costs is that the next reassuring sentence here is
      // worth less. `unknown` is different and does *not* land here: that is an
      // answer, and the install sentence is the true thing to say about it.
      if (claudeAuth === undefined) return null
      if (claudeAuth.state === 'logged_out') {
        return {
          // **The remedy is the button that leads the line** (`LoginLine`): the
          // engine's own login, run on the binary the turns use. The text after
          // it is short on purpose — this slot is 414px at the 800px minimum,
          // and the button takes some of it. Not
          // `describeEngineSkip('claude_not_logged_in')`: that sentence is a
          // *turn error* and opens "This agent runs on Claude…", which is
          // narration on a panel that says so two rows up — but it names the
          // same **Log in**, so the two read as one instruction.
          text: 'Claude Code is not logged in.',
          tone: DANGER,
          login: 'claude'
        }
      }
      const catalogLine = cliCatalogLine()
      if (catalogLine) return catalogLine
      const claudeModel = cliNameOf(declaredModel) ?? cliDefaultName
      return {
        // **Both names, in one sentence, because both are on the screen.** The
        // select says "Claude Agent" and the column beside it says "Claude Code
        // 2.1.266" — one product under a permitted product name and a factual
        // one — and nothing else on the surface says they are the same thing.
        // Tying them here rather than in either cell is what keeps it free:
        // this line spans the panel, while the option and the Engine column are
        // the two width-constrained places (rule 7).
        //
        // **"login" only once one was observed.** Until the probe answers this
        // says "install", which is the weaker claim and the only one detection
        // supports; a machine that is installed but logged out would otherwise
        // read as completely healthy and the user would find out at the first
        // turn (rule 9). The plan is named when the CLI reports one and never
        // inferred — asserting a subscription because an environment variable
        // was stripped is a claim about an environment this app does not fully
        // control.
        text:
          claudeAuth.state === 'logged_in'
            ? `Claude Agent runs on your own Claude Code login${accountSuffix(claudeAuth.email, claudeAuth.subscriptionType)}, on ${claudeModel}.`
            : `Claude Agent runs on Claude Code, on ${claudeModel}.`,
        tone: NOTE
      }
    }
    // Before the provider list lands, every credential looks missing. Saying so
    // would put a false warning in the slot and then take it away again.
    if (!providers) {
      return modelsLoaded ? null : { text: 'Loading the model list…', tone: NOTE }
    }
    // Credential problems, from the shared ladder. Above the loading states
    // below, because a missing or keyless credential is knowable without the
    // model registry and is what the user must fix first either way.
    const credential = describeCredential(facts)
    if (credential) return toned(credential)
    if (!modelsLoaded) {
      return modelsFailed
        ? {
            // The remedy names a file, so it is only offered to an agent that
            // has one: a bare folder has no manifest to type a model into, and
            // advice that cannot be taken is worse than none (ux_rules rule 9).
            text: bare
              ? 'Could not load the model list.'
              : `Could not load the model list. Models can still be typed into ${MANIFEST_FILE}.`,
            tone: WARN
          }
        : { text: 'Loading the model list…', tone: NOTE }
    }
    // What became of the model — substitution, an empty tier, nothing set — from
    // the same shared ladder, with model names rather than ids.
    const model = describeModel(facts, (id) => nameOf(id) ?? '')
    if (model) return toned(model)
    if (modelBelongsElsewhere(declaredModel, effectiveProvider, models ?? [], providers)) {
      const owner = (models ?? []).find((model) => model.id === declaredModel)
      const ownerName =
        providers.find((provider) => provider.id === owner?.providerId)?.name ?? 'another credential'
      // Action first: at the 800px minimum window this line is truncated, and
      // the half that survives has to be the half the user can act on.
      return {
        text: `Pick a model ${facts.credentialName} lists — “${declaredModel}” is ${ownerName}’s.`,
        tone: WARN
      }
    }
    /**
     * Why the Advanced checkbox is not available. Standing rather than fired by
     * a click, so the state is legible before the user tries it.
     *
     * Consequence first, because the length of what follows is not ours: the
     * model id is the user's, and a real gateway one
     * (`meta-llama/Llama-3.3-70B-Instruct`) is twice the length of a short
     * sample. With the id leading, that pushes the clause explaining the
     * disabled control to within a few pixels of the 800px line's edge and a
     * longer id past it — clipping the only half the user needs. Leading with it
     * instead ends it at a fixed offset whatever the id, and what falls off is
     * the reason, which the `title` carries in full.
     */
    if (unconvertible) {
      return {
        text: `Advanced stays on — “${nameOf(declaredModel)}” matches no work complexity.`,
        tone: NOTE
      }
    }
    /**
     * The only entry that reports a healthy state: which model this agent
     * actually runs on.
     *
     * It is here rather than in the select's own label because that label is the
     * panel's permanent visible state and could not hold a model name at the
     * 800px minimum without truncating (rule 7). It sits at the bottom of the
     * priority list because it is the least urgent thing the slot can say — any
     * warning above displaces it, which is right: a user whose credential is
     * missing does not need to be told what tier resolved to.
     *
     * Only in the tier view. The Advanced select already names the model, and
     * repeating it under the control would be a sub-line that restates its own
     * title (rule 7).
     */
    if (!advanced && choice.modelId) {
      /**
       * Labels name the thing, hints name the consequence (rule 7) — and the
       * consequence is the whole reason a tier is worth choosing over a model.
       *
       * `Default` and a tier are not the same kind of answer, and the panel used
       * to render them identically whenever they resolved to the same model:
       * Default *follows the user's default chat mode* and moves when it moves,
       * while a tier is pinned to the folder and travels with it. The cost hint
       * ("fastest and cheapest") had the same problem in the other direction —
       * it existed, but only as an `<option title>`, which macOS does not render,
       * so nobody choosing for the first time ever saw it.
       */
      return {
        text: declaredComplexity
          ? `${WORK_COMPLEXITY_LABELS[declaredComplexity]} — ${WORK_COMPLEXITY_HINTS[declaredComplexity]}, on ${nameOf(choice.modelId)}.`
          : // "the Default runtime", not "your default chat mode": since this
            // machine gained a pinned credential — and now a pinned engine —
            // the chat mode is only one of the things the default can be, and
            // naming it outright told users on a pin the wrong source.
            `Default — follows the Default runtime, on ${nameOf(choice.modelId)}.`,
        tone: NOTE
      }
    }
    // Below it, because a credential that lists nothing *and* still resolves a
    // model is a working agent, not a problem to fix — the note is here to
    // explain a picker with nothing in it, which is only puzzling once nothing
    // resolved either.
    if (modelChoices.length === 0) return toned(NO_CATALOGUE)
    return null
  })()

  /**
   * The credential a commit should carry, given which engine is showing.
   *
   * **Null on the Claude path, always.** A manifest may legally carry both an
   * engine and a credential — the validator only warns, so a folder written by
   * a newer tool keeps running — and this panel reads it correctly by showing
   * no credential at all. Forwarding `declaredCredential` anyway handed
   * `runtimeService.validate` the one pair it refuses, built out of a control
   * that is not on screen: the write failed, the picker snapped back, and the
   * tier became unchangeable with the refusal explaining a credential the user
   * could not see (ux_rules rule 6). Dropping it is what switching *to* this
   * engine already does.
   */
  const commitCredential = (value: string | null): string | null => (onCli ? null : value)

  const commit = (
    credential: string | null,
    modelId: string | null,
    complexity: WorkComplexity | null,
    options: {
      note?: string
      view?: boolean
      persist?: boolean
      keep?: string | null
      /**
       * The engine to write. **Absent means "keep what the file names"** —
       * sent as `KEEP_ENGINE`, which main resolves against the file — and that
       * is what every caller but the Runs-on picker wants. The file may name an
       * engine this build does not recognise, which this panel cannot write
       * back; sending anything but "keep" from a model or tier change erased it.
       */
      engine?: AgentEngine | null
      /**
       * The effort to write beside `modelId`. Absent keeps the declared one
       * while the model stays the same and drops it otherwise — an effort is
       * the effort *of* a model, and main never writes one without a model.
       */
      effort?: string | null
    } = {}
  ): void => {
    if (!bare && !stamp) return
    setError(null)
    // A message about credentials/.env must not survive the next thing the user
    // does in the pickers above it.
    setSecrets(null)
    if (options.note) note(options.note, { model: modelId, complexity })
    else setDropped(null)
    const effort = modelId === null ? null
      : options.effort !== undefined ? options.effort
      : modelId === declaredModel ? declaredEffort : null
    const runtime = {
      engine: options.engine === undefined ? KEEP_ENGINE : options.engine,
      credential,
      modelId,
      complexity,
      // Absent is "none" to main, so the key travels only when there is one.
      ...(effort ? { effort } : {})
    }
    const handlers = {
      /**
       * The view moves only once the file has. A refused write (a read-only
       * folder, a stale stamp) that had already flipped the picker would leave
       * the panel showing a control the manifest does not back — the Model
       * select reading `Default` over a manifest that still says
       * `complexity: medium`. Same for the remembered preference: the
       * checkbox, the visible picker and the stored default now cannot
       * disagree, because one success sets all three.
       *
       * **The `agentId` tag is the guarantee here, not the callback being
       * dropped.** Switching agents *re-renders* this panel rather than
       * unmounting it — `LocalAgentPage` gives it no `key` — so a callback
       * issued for agent A does run after the page has moved to agent B, and
       * what keeps it honest is that every piece of state it sets is stamped
       * with the agent the write was *about* and every read gates on that
       * stamp. A drop only happens on the narrower path of leaving the agent
       * page entirely, where its one effect is that `setSetting` does not
       * persist while the manifest write still lands — self-healing, since
       * `declaredView` decides the view on return.
       */
      onSuccess: () => {
        setView({ agentId: agent.id, advanced: options.view ?? advanced })
        if (options.keep !== undefined) {
          setPinned(options.keep === null ? null : { agentId: agent.id, modelId: options.keep })
        }
        if (options.persist) {
          setSetting.mutate({ key: 'localAgentsModelAdvanced', value: options.view ?? advanced })
        }
      },
      onError: (err: Error) =>
        setError(
          // Only reachable on the manifest path: a bare agent's write guards no
          // file the user can edit, so there is nothing to have gone stale.
          isStaleWriteError(err)
            ? `${MANIFEST_FILE} changed on disk since this page loaded. Reload the agent and try again.`
            : err instanceof Error
              ? err.message
              : 'Could not save that.'
        )
    }
    if (bare) saveBare.mutate({ agentId: agent.id, runtime }, handlers)
    else if (stamp)
      saveManifest.mutate({ agentId: agent.id, expectedStamp: stamp, runtime }, handlers)
  }

  /**
   * Changing the credential drops a model that belonged to the old one.
   *
   * A model id is only meaningful to the catalogue that lists it: keeping
   * `claude-sonnet-4-5` while moving to OpenAI writes a manifest the engine
   * turns into `openai/claude-sonnet-4-5`, which fails on the agent's first
   * turn rather than here. Same clear as the chat-mode form does.
   *
   * Two things are deliberately *not* cleared. A model the registry has never
   * listed is a hand-written id for a catalogue we cannot see, so calling it
   * wrong would be a guess. And when the target credential is unknown —
   * "Default" with no default runtime behind it — there is nothing to compare
   * against, and wiping the user's model on a credential change they may be
   * about to undo would take a choice out of a file they committed.
   */
  /**
   * The one picker's answer, which is now either an engine or a credential.
   *
   * Switching **to** Claude clears the credential — that path spends none, and
   * `runtimeService.validate` refuses to write both. Switching **away** clears
   * the engine. In both directions the *tier* survives, for the same reason it
   * survives a credential change: `medium` means the same thing on either
   * engine, so the user's answer to "how hard is this work" is not something a
   * change of runtime should silently discard.
   *
   * A concrete model does not survive the move to Claude. It cannot: an id from
   * a provider's catalogue means nothing to a plan addressed by alias, and
   * carrying it over would leave the manifest naming a model that engine will
   * never serve. The status line says so rather than letting it vanish quietly.
   */
  const changeRuntimeTarget = (value: string): void => {
    /**
     * A pick here replaces the file's engine. When the file named one this
     * build cannot run, the pick drops it — said on the status line, the way a
     * dropped model is, because the file loses a value the user may have
     * written on purpose.
     */
    const droppedEngine = unsupportedEngine ? `Dropped engine “${unsupportedEngine}”.` : undefined
    const withDropped = (text: string | undefined): string | undefined =>
      droppedEngine && text ? `${droppedEngine} ${text}` : (droppedEngine ?? text)
    if (value === CODEX_OPTION) {
      commit(null, null, declaredComplexity, { engine: 'codex', note: withDropped(declaredModel ? 'Codex will use its configured default model.' : undefined) })
      runtimeSetup.setup('codex', { install: false })
      return
    }
    if (value === ANTIGRAVITY_OPTION) {
      commit(null, null, declaredComplexity, { engine: 'antigravity', note: withDropped(declaredModel ? `Antigravity will use ${antigravityRunModelLabel(null, declaredComplexity)}.` : undefined) })
      runtimeSetup.setup('antigravity', { install: false })
      return
    }
    if (value === CLAUDE_OPTION) {
      commit(null, null, declaredComplexity, {
        engine: 'claude',
        note: withDropped(declaredModel
          ? `Dropped “${nameOf(declaredModel)}” — Claude Agent runs on ${claudeModelForComplexity(declaredComplexity)}.`
          : undefined)
      })
      runtimeSetup.setup('claude', { install: false })
      return
    }
    if (onCli) {
      // Leaving the Claude engine for a credential. The model is already null
      // on that path, so there is nothing to drop.
      commit(value || null, null, declaredComplexity, { engine: null })
      return
    }
    changeCredential(value, unsupportedEngine ? { engine: null, droppedEngine } : undefined)
  }

  /**
   * A model pick in the CLI Advanced view. The declared effort follows the
   * model when the new one offers it; one it does not offer is dropped, and
   * the line says so — efforts are per model. A model never seen as a
   * session's own (no entry) keeps it: there is nothing to judge by.
   */
  const changeCliModel = (model: string | null): void => {
    const offered = effortsFor(cliCatalog, model)
    const keeps = declaredEffort !== null && model !== null && (offered === undefined || offered.some((effort) => effort.id === declaredEffort))
    commit(null, model, null, {
      effort: keeps ? declaredEffort : null,
      ...(declaredEffort && model && !keeps ? { note: `Dropped “${declaredEffort}” effort — ${cliNameOf(model)} does not offer it.` } : {})
    })
  }

  const changeCredential = (
    value: string,
    /**
     * Set only from the Runs-on picker over an engine this build cannot run:
     * the pick replaces it, so the write removes the engine and the status line
     * says so. Every other credential change keeps the file's engine.
     */
    replace?: { engine: null; droppedEngine: string | undefined }
  ): void => {
    const next = value ? (usable.find((provider) => provider.name === value) ?? null) : fallbackProvider
    const stale = modelBelongsElsewhere(declaredModel, next, models ?? [], providers ?? [])
    /**
     * Forward what the *manifest* holds, and let the view break only a genuine
     * collision.
     *
     * A tier survives a credential change where a model does not, and that is
     * the point of it: `medium` means the same thing on every credential, so
     * moving the agent to another key keeps the choice, and the status line says
     * so if the new one lists nothing in that tier. The one exception is a
     * manifest that carries both keys, below — there, something has to give.
     *
     * This has to keep "the desktop never writes both" true — a manifest can
     * legally carry `model` and `complexity` together since the validator
     * stopped calling that an error, and sending both made `applyToManifest`
     * throw a refusal about a key the user cannot see, from a control that has
     * nothing to do with it. But sending only the *view's* field went too far
     * the other way and deleted the other one. That is reachable, and cruelly:
     * an agent whose tier resolves to nothing shows the Model picker over a
     * manifest that still says `complexity: complex`, having just advised
     * "pick another complexity or another credential" — and taking the second
     * half of that advice here silently destroyed the tier.
     *
     * So: a single-field manifest keeps its field whichever picker is showing,
     * and only a both-set one loses one — the one not on screen.
     */
    const bothSet = declaredModel !== null && declaredComplexity !== null
    const staleNote = stale && next ? `Dropped “${nameOf(declaredModel)}” — ${next.name} does not list it.` : undefined
    const noteText = [replace?.droppedEngine, staleNote].filter(Boolean).join(' ') || undefined
    commit(
      value || null,
      bothSet && !advanced ? null : stale ? null : declaredModel,
      bothSet && advanced ? null : declaredComplexity,
      {
        ...(noteText ? { note: noteText } : {}),
        ...(replace ? { engine: replace.engine } : {})
      }
    )
  }

  /**
   * Advanced converts rather than merely switching view, because the manifest —
   * not the checkbox — decides which picker an agent gets. Leaving the file
   * alone would tick the box and show the tier anyway, which reads as a broken
   * control; converting keeps the agent on the same runtime and leaves the file
   * saying one thing.
   *
   * **A conversion that cannot be made is never approximated.** Both directions
   * have a case with no honest answer: a tier the credential lists no model for
   * (or lists nothing at all for, because the registry failed to load), and a
   * model id no family recognises — a gateway's `my-private-llm-7b`, which is
   * the ordinary case for `openai_compatible`. Writing through either would
   * delete a choice out of a file the user commits, silently move the agent onto
   * a different model, and — for the unrecognised id — put it beyond the reach of
   * the select that would have to offer it back. So neither writes.
   *
   * They differ in whether the *view* still moves, and the rule is one question:
   * **can the picker the user asked for represent this file honestly?**
   *
   * - Tier → model, tier resolves to nothing: yes. The file's tier names no
   *   model, so a model picker sitting on `Default` is not lying about anything,
   *   and it is where the user can fix it — picking a model replaces the tier.
   *   The view moves, the file does not, and the line names the tier still in it.
   * - Model → tier, model belongs to no family: no. The file names a model that
   *   is *running*, and a tier picker cannot say so — it would read `Default`
   *   over a live pinned id, which is the misreport this panel exists to
   *   prevent. That case never reaches this function at all: `unconvertible`
   *   above disables the checkbox and puts the reason beside it, because a
   *   control that springs back tells the user nothing and invites an identical
   *   second click. The `!tier` guard below stays anyway — the guarantee is
   *   "never convert what cannot be converted", and a guarantee that lives only
   *   in whether a control is clickable is one line of JSX away from being lost.
   *
   * So of the three outcomes only the first goes near the mutation: a
   * conversion that writes moves the view in `onSuccess`; a deliberate no-op
   * moves it immediately, because it succeeded — it just had nothing to write;
   * a refused write moves nothing at all.
   *
   * The round trip is lossless. `bestInTier` prefers a stable alias, so a
   * deliberately pinned `claude-haiku-4-5-20251001` would come back from a
   * there-and-back toggle as `claude-haiku-4-5` — a dated snapshot silently
   * traded for a floating one, by a control that only claims to change the view.
   * The id it converted away from is remembered instead, and restored when the
   * tier has not moved since.
   */
  const toggleAdvanced = (next: boolean): void => {
    setDropped(null)
    /**
     * The stored preference always equals the picker the user actually got.
     * Moving one without the other is how the checkbox, the visible control and
     * the next agent's default come apart.
     */
    const applyView = (value: boolean): void => {
      setView({ agentId: agent.id, advanced: value })
      setSetting.mutate({ key: 'localAgentsModelAdvanced', value })
    }

    const converting = next ? declaredComplexity !== null : declaredModel !== null

    // Nothing in the manifest to convert: a pure view change, and the
    // preference is the whole of it.
    if (!converting || !canEdit) {
      applyView(next)
      return
    }

    /**
     * **The CLI runtimes convert by their own names**, on OpenCode's terms: a
     * tier becomes the model it runs on today (Claude's alias, Antigravity's
     * Flash level, Codex's default model at the tier's effort), and a model
     * goes back to the tier it belongs to. A target the tool no longer lists
     * becomes the tool's default, and the line says so; a model no tier
     * describes never reaches here (`unconvertible` disables the checkbox).
     */
    if (cliEngine) {
      if (next && declaredComplexity !== null) {
        // **No list, no conversion**: what the tier runs on cannot be checked
        // against what the tool offers, so the view moves and the file keeps
        // its tier. The reserved line keeps saying why the list is missing
        // (Codex counts only its own session's list: its cache ignores the
        // user's configured model).
        if (!cliCatalogKnown || (onCodex && !cliSessionList)) {
          applyView(true)
          return
        }
        const tierLabel = WORK_COMPLEXITY_LABELS[declaredComplexity]
        const wanted = onCodex ? catalogDefaultModel(cliCatalog)
          : onAntigravity ? ANTIGRAVITY_TIER_MODEL[declaredComplexity] : CLAUDE_TIER_ALIAS[declaredComplexity]
        const wantedEffort = onCodex ? codexEffortForComplexity(declaredComplexity) : null
        let target = wanted
        let replaced: string | null = null
        if (wanted && cliCatalogKnown && isModelOffered(cliCatalog, wanted) === false) {
          target = catalogDefaultModel(cliCatalog)
          replaced = wanted
        }
        if (!target) {
          // Codex with no list yet: nothing honest to pin, so the view moves
          // and the file keeps its tier — said, as OpenCode says it.
          applyView(true)
          note(`Still ${tierLabel} in the file — ${cliName} has not listed its models yet. Pick one to replace it.`)
          return
        }
        // An effort the tool does not list is not written.
        const effort = wantedEffort && (effortsFor(cliCatalog, target) ?? []).some((choice) => choice.id === wantedEffort) ? wantedEffort : null
        commit(null, target, null, {
          view: true,
          persist: true,
          keep: null,
          effort,
          note: replaced
            ? `Pinned “${cliNameOf(target)}” — ${cliName} no longer offers “${replaced}”, what ${tierLabel} ran on.`
            : `Pinned “${cliNameOf(target)}”${effort ? ` at ${effort} effort` : ''} — what ${tierLabel} ran on.`
        })
        return
      }
      if (!next && declaredModel !== null) {
        // Unreachable through the checkbox while `unconvertible` — kept, as below.
        if (!cliTier) return
        const tier = cliTier.tier
        commit(null, null, tier, {
          view: false,
          persist: true,
          keep: null,
          note: tier
            ? `Switched to ${WORK_COMPLEXITY_LABELS[tier]} — the tier “${cliNameOf(declaredModel)}” belongs to.`
            : `Switched to Default — “${cliNameOf(declaredModel)}” is ${cliName}’s default.`
        })
      }
      return
    }

    if (next && declaredComplexity !== null) {
      // The id this agent was pinned to before the opposite conversion, when the
      // tier has not moved since — so there and back is a no-op on the file.
      const remembered =
        pinned?.agentId === agent.id &&
        classifyModel(pinned.modelId, providerType)?.tier === declaredComplexity
          ? pinned.modelId
          : null
      const model = remembered ?? tierModels[declaredComplexity]
      if (!model) {
        // A deliberate no-op, not a failure: the user gets the picker they asked
        // for and the file keeps the tier it has. This must not go through the
        // mutation — `onSuccess` is what moves the view, and nothing is being
        // written, so routing it there would spring the checkbox back under the
        // pointer that just clicked it.
        applyView(true)
        // Names the tier the file still holds, not merely that nothing changed:
        // the Model select now reads `Default` over a manifest that says
        // Complex, and this line is the only thing that says otherwise. No
        // `wrote` — nothing was written, so it is true of the file as it stands.
        note(
          `Still ${WORK_COMPLEXITY_LABELS[declaredComplexity]} in the file — ${
            effectiveProvider?.name ?? 'this credential'
          } lists no model for it. Pick one to replace it.`
        )
        return
      }
      commit(commitCredential(declaredCredential), model, null, {
        view: next,
        persist: true,
        keep: null,
        note: `Pinned “${nameOf(model)}” — what ${WORK_COMPLEXITY_LABELS[declaredComplexity]} resolved to.`
      })
      return
    }

    if (!next && declaredModel !== null) {
      const tier = classifyModel(declaredModel, providerType)?.tier ?? null
      // Unreachable through the checkbox, which `unconvertible` disables — kept
      // because "never convert what cannot be converted" is the guarantee, and a
      // guarantee that lives only in whether a control is clickable is one line
      // of JSX away from being lost.
      if (!tier) return
      commit(commitCredential(declaredCredential), null, tier, {
        view: next,
        persist: true,
        keep: declaredModel,
        note: `Switched to ${WORK_COMPLEXITY_LABELS[tier]} — the tier “${nameOf(declaredModel)}” belongs to.`
      })
    }
  }

  /**
   * "Choose model" in the composer's row: once this agent's Model select is on
   * screen and enabled, it takes focus and the request is spent. It waits only
   * while the list is still being read; once that has settled with no enabled
   * Model select (the tier view, a list that could not be read) the request is
   * spent anyway, so a later tick of Advanced cannot steal focus. Leaving the
   * agent drops it too.
   */
  const focusRequest = useUIStore((state) => state.pendingRuntimeModelFocusId)
  const listSettled = !pickerUnknown && (cliEngine === null || (cliCatalog !== undefined && !cliCatalogLoading && !cliRefreshing))
  useEffect(() => {
    if (compact || focusRequest !== agent.id) return
    const select = document.getElementById('runtime-model') as HTMLSelectElement | null
    if (select && !select.disabled) select.focus()
    else if (!listSettled) return
    useUIStore.getState().setPendingRuntimeModelFocusId(null)
  })
  useEffect(() => {
    if (compact) return
    const id = agent.id
    return () => {
      if (useUIStore.getState().pendingRuntimeModelFocusId === id) useUIStore.getState().setPendingRuntimeModelFocusId(null)
    }
  }, [agent.id, compact])

  if (compact) {
    // Use the same resolved engine, credential and model as the settings controls.
    const subscription = claudeAuth?.state === 'logged_in' &&
      (claudeAuth.authMethod === 'claude.ai' || !!claudeAuth.subscriptionType)
    const label = engineUnknown ? 'Loading runtime…'
      : onCodex ? 'Codex'
      : onAntigravity ? 'Antigravity'
      : onClaude ? `Claude Agent${subscription ? ' with subscription' : ''}`
      : effectiveProvider && !credentialMissing ? `OpenCode with ${effectiveProvider.name}` : 'OpenCode'
    const model = engineUnknown ? null
      : onCodex ? `${cliNameOf(declaredModel) ?? cliDefaultName ?? 'CLI default'} · ${codexEffortForRuntime(agent.runtime)} effort`
      : onAntigravity ? (cliNameOf(declaredModel) ?? cliDefaultName)
      : onClaude ? `${cliNameOf(declaredModel) ?? cliDefaultName}${declaredEffort ? ` · ${declaredEffort} effort` : ''}`
      : !credentialMissing && modelsLoaded ? nameOf(choice.modelId) : null
    const issue = engineUnknown ? null
      : onCodex ? (codexFailure ? codexFailure.badge : codexAuth?.state === 'logged_out' ? 'Sign-in required' : staleModel ? 'Model unavailable' : null)
      : onAntigravity
        ? (antigravityFailure ? antigravityFailure.badge : antigravityAuth?.state === 'logged_out' ? 'Sign-in required' : staleModel ? 'Model unavailable' : null)
      : onClaude ? (claudeFailure ? claudeFailure.badge : claudeAuth?.state === 'logged_out' ? 'Sign-in required' : staleModel ? 'Model unavailable' : null)
      : credentialIssue === 'missing' ? 'AI credential needed'
      : status?.tone === DANGER || status?.tone === WARN ? 'Setup needed' : null
    const badge = SUMMARY_BADGE
    return <div role="group" aria-label="Runtime summary" className="mt-2 flex flex-wrap items-center gap-1.5">
      {leading}
      <span className={badge} title={onClaude && claudeAuth?.state === 'logged_in'
        ? `Claude Code${accountSuffix(claudeAuth.email, claudeAuth.subscriptionType)}` : label}>{label}</span>
      {model && <span className={badge} title={`Model: ${model}`}>{model}</span>}
      {issue && <span className={`${badge} !text-[var(--color-warning)]`} title={status?.text}>{issue}</span>}
    </div>
  }

  return (
    <section
      aria-label="Runs with"
      className="@container relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3"
    >
      {/* Out of the flow: a save indicator that adds a row would move the tabs below. */}
      {saving && (
        <Loader2
          size={12}
          aria-label="Saving"
          className="absolute right-3 top-3 animate-spin text-[var(--color-text-muted)]"
        />
      )}
      {/*
        Two columns until the *panel* is wide enough for three (a container
        query, not a viewport one: the window's minimum width is 800px, which
        already passes `md:`, and three columns there gave each select 129px —
        less than "Default (none set)" needs). At 42rem the third column is
        216px, enough for a model name. The engine line takes the full second
        row until then.
      */}
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        <div>
          {/*
            An engine this build cannot run is a preference the file states, not
            a runtime: the select shows what runs, and the (?) says what the file
            asked for. No tip otherwise — the label alone is the whole story.
          */}
          {unsupportedEngine ? (
            <div className="mb-1 flex items-center gap-1">
              <label htmlFor="runtime-credential" className={`${LABEL} !mb-0`}>
                Runs on
              </label>
              {/* Negative margin: the (?) must not make this label row taller than the Model label beside it, or the two selects stop lining up. */}
              <span className="-my-1 inline-flex">
                <SettingsInfoTip label="About Runs on">
                  {`${MANIFEST_FILE} asks for ${unsupportedEngine}; this version runs it on OpenCode.`}
                </SettingsInfoTip>
              </span>
            </div>
          ) : (
            <label htmlFor="runtime-credential" className={LABEL}>
              Runs on
            </label>
          )}
          <select
            id="runtime-credential"
            className={FIELD}
            title={
              onCodex ? 'Your Codex CLI login and configuration' : onAntigravity
                ? 'Your Google login — this app holds no credential for it'
                : onClaude
                ? 'Your own Claude Code login — this app holds no credential for it'
                : selected
                  ? selected.name
                  : fallbackProvider
                    ? `Default runtime: ${fallbackProvider.name}`
                    : undefined
            }
            disabled={disabled}
            /*
              **What the file declares, not what it runs on.** `onClaude` is now
              true for an agent that declares nothing on a machine whose Default
              Runtime is Claude Agent — and that agent is on the *Default*, which
              is the option that has to be selected. Reading the effective engine
              here showed `Claude Agent` over a manifest that names no engine, so
              the control claimed a pin the file does not hold and clearing it
              was impossible.
            */
            value={
              declaredEngine === 'codex' ? CODEX_OPTION : declaredEngine === 'antigravity'
                ? ANTIGRAVITY_OPTION
                : declaredEngine === 'claude'
                ? CLAUDE_OPTION
                : unsupportedEngine && !selected
                  ? UNSUPPORTED_OPTION
                  : (selected?.name ?? '')
            }
            onChange={(event) => changeRuntimeTarget(event.target.value)}
          >
            {/*
              **"Default runtime", the same words Settings uses for the setting
              this follows** — and then what it currently resolves to, which is
              either the Claude Agent runtime or the credential the AI-credentials
              one spends. It named only the credential before, which was the whole
              truth while there was one runtime and is now the wrong half of it on
              a machine defaulting to Claude.

              Silent about the name until the machine has answered: claiming
              `(none set)` while the query is in flight would be a retraction a
              moment later, on the panel's permanent visible state.
            */}
            <option value="">
              {defaultRuntime ? {
                codex: 'Default runtime (Codex)',
                antigravity: 'Default runtime (Antigravity)',
                claude: 'Default runtime (Claude Agent)',
                opencode: fallbackProvider ? `Default runtime (${fallbackProvider.name})` : 'Default runtime (none set)'
              }[defaultRuntime.engine] : 'Default runtime'}
            </option>
            {unsupportedEngine && !selected && (
              <option value={UNSUPPORTED_OPTION} disabled>
                {fallbackProvider ? `OpenCode (${fallbackProvider.name})` : 'OpenCode (none set)'}
              </option>
            )}
            {/*
              **Two honest lists behind one separator, not one list pretending.**
              An engine is not a credential row — it has no key, no `enabled`
              flag and no catalogue — so merging them into a flat list would make
              every credential-shaped question below ("is it switched off?")
              read as if it applied to both.

              The label is “Claude Agent” rather than “Claude Code”: the latter
              is not a permitted name for a third-party product's own surface.
              The status line beneath may still say “Claude Code 2.1.266”,
              because that is a statement about the user's machine.
            */}
            {/*
              Offered where a `claude` was detected, or where the **file** names
              it — not where it is merely this machine's default. A default that
              resolved to Claude Agent already appears as the first option, and
              a second entry for it on a machine with no `claude` would be an
              option that fails after the click (ux_rules rule 4).
            */}
            {/*
              **Kept when it failed, and marked with why** — Settings keeps the
              button and reads "Unavailable", and an option that vanished here
              made the two surfaces disagree about whether the runtime exists.
              The mark is the label, not the value: the file is written from
              the value.
            */}
            <optgroup label="Codex CLI">
              <option value={CODEX_OPTION}>{codexFailure ? `Codex (${codexFailure.option})` : 'Codex'}</option>
            </optgroup>
            <optgroup label="Google Antigravity">
              <option value={ANTIGRAVITY_OPTION}>
                {antigravityFailure ? `Antigravity (${antigravityFailure.option})` : 'Antigravity'}
              </option>
            </optgroup>
            <optgroup label="On this machine">
              <option value={CLAUDE_OPTION}>
                {claudeFailure ? `Claude Agent (${claudeFailure.option})` : 'Claude Agent'}
              </option>
            </optgroup>
            {/*
              A credential the manifest names that is not offered — configured
              but keyless — still needs an option, or the select would render
              blank over a file that plainly names one. Same reason the Model
              select carries an entry for an id the registry never listed.
            */}
            <optgroup label="AI credentials">
            {selected && !usable.some((provider) => provider.id === selected.id) && (
              <option value={selected.name}>{credentialOptionLabel(selected)}</option>
            )}
            {/*
              The label is marked, the value is not: `changeCredential` writes
              this string into the manifest as the credential *reference*, so
              the option's `value` stays the bare name. This list deliberately
              includes credentials that cannot run — that is what lets an agent
              pointing at one say so rather than appearing unconfigured — which
              makes it the picker that most needs to say which those are.
            */}
            {usable.map((provider) => (
              <option key={provider.id} value={provider.name}>
                {credentialOptionLabel(provider)}
              </option>
            ))}
            </optgroup>
          </select>
        </div>

        <div>
          {/*
            Label and Advanced share one row, and the checkbox is rendered in
            both views, so switching between them cannot change the panel's
            height and shove the page's tab strip out from under the pointer
            that just used it (ux_rules rule 1).
          */}
          <div className="mb-1 flex h-[15px] items-center justify-between gap-2">
            <label
              htmlFor={
                pickerUnknown ? 'runtime-pending' : advanced ? 'runtime-model' : 'runtime-complexity'
              }
              className={`${LABEL} mb-0`}
            >
              {/*
                Three names for one column, and the pending one is deliberately
                neither of the other two: claiming "Model" or "Work complexity"
                before it is known is the swap rule 1 forbids. It is also not
                "Runs on" — that is the *first* column's name, and one surface
                must not announce two controls identically (rule 10).
              */}
              {pickerUnknown ? 'Model choice' : advanced ? 'Model' : 'Work complexity'}
            </label>
            {/*
              On every engine: the CLI runtimes list their own models now
              (`useRuntimeModelCatalog`), so Advanced has a real list behind it
              there too.
            */}
            <label
              className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-[var(--color-text-muted)]
                transition-colors hover:text-[var(--color-text)]"
              // The reserved line below is *one* prioritised message, so a
              // missing credential or a refused write displaces the standing
              // explanation and leaves this control disabled with nothing
              // visible saying why. The tooltip is the only per-control surface
              // left, so it carries the same sentence rather than advertising an
              // action the checkbox can no longer perform.
              title={
                unconvertible
                  ? (onCli ? (cliUnconvertibleReason ?? undefined) : `Advanced stays on — “${nameOf(declaredModel)}” matches no work complexity.`)
                  : cliConversionPending
                    ? (cliRefreshError ? `Couldn’t list ${cliName}’s models: ${cliRefreshError}`
                      : cliRefreshing ? `Checking ${cliName}’s models…` : `${cliName} has not listed its models yet.`)
                    : 'Pick the exact model instead of how hard the work is'
              }
            >
              <input
                type="checkbox"
                className="size-3 accent-[var(--color-accent)]"
                checked={advanced}
                disabled={disabled || unconvertible || cliConversionPending}
                onChange={(event) => toggleAdvanced(event.target.checked)}
              />
              Advanced
            </label>
          </div>
          {pickerUnknown ? (
            /* Same footprint, no claim: which picker this agent gets is not
               known yet, and guessing is what produces the swap. */
            <select id="runtime-pending" aria-label="Model choice" className={FIELD} disabled>
              <option>Loading…</option>
            </select>
          ) : advanced && onCli ? (
            /*
              **The tool's own list, verbatim**, with the effort beside it on
              the two runtimes that have one. One row in every state — loading,
              unavailable, listed — so the column never changes height; the
              reason for a disabled list is on the reserved line below.
            */
            <div className="flex gap-1">
              <select
                id="runtime-model"
                aria-label="Model"
                className={`${FIELD_IN_ROW} min-w-0 flex-1`}
                title={declaredModel ?? undefined}
                disabled={disabled || cliCatalogLoading || !cliCatalogKnown}
                value={cliCatalogLoading ? '' : (declaredModel ?? '')}
                onChange={(event) => changeCliModel(event.target.value || null)}
              >
                {cliCatalogLoading ? (
                  <option value="">Checking models…</option>
                ) : (
                  <>
                    {/*
                      **One Default.** A tool that lists its own `default`
                      (Claude) gets that entry as the Default, named by what it
                      runs; "not set" is then offered only while nothing is set,
                      named by the floor it runs on. Elsewhere unset is the
                      Default, named by the model it runs.
                    */}
                    <option value="">{cliUnsetLabel}</option>
                    {/* Still selectable when the list lacks it, so the select never misreports the file. */}
                    {declaredModel && !(cliCatalog?.models ?? []).some((model) => model.id === declaredModel) && (
                      <option value={declaredModel}>{declaredModel}</option>
                    )}
                    {(cliCatalog?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id} title={model.description ? `${model.id} — ${model.description}` : model.id}>
                        {model === cliToolDefault ? cliToolDefaultLabel : model.name}
                      </option>
                    ))}
                  </>
                )}
              </select>
              {effortSlot && (
                <select
                  id="runtime-effort"
                  aria-label="Effort"
                  title={declaredModel ? 'Reasoning effort' : 'Pick a model to set its reasoning effort'}
                  // Compact and fixed: the model name gets the room (`Xhigh` fits).
                  className={`${FIELD_IN_ROW} w-[4.75rem] shrink-0`}
                  disabled={disabled || cliCatalogLoading || !cliCatalogKnown || declaredModel === null || cliEfforts.length === 0}
                  value={declaredEffort ?? ''}
                  onChange={(event) => commit(null, declaredModel, null, { effort: event.target.value || null })}
                >
                  <option value="">Default</option>
                  {declaredEffort && !cliEfforts.some((effort) => effort.id === declaredEffort) && (
                    <option value={declaredEffort}>{declaredEffort}</option>
                  )}
                  {cliEfforts.map((effort) => (
                    <option key={effort.id} value={effort.id} title={effort.name}>
                      {effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : advanced ? (
            <select
              id="runtime-model"
              aria-label="Model"
              className={FIELD}
              title={inheritedName ? `Default: ${inheritedName}` : undefined}
              disabled={disabled}
              value={declaredModel ?? ''}
              onChange={(event) =>
                commit(commitCredential(declaredCredential), event.target.value || null, null)
              }
            >
              <option value="">
                {!modelsLoaded ? 'Default' : inheritedName ? `Default (${inheritedName})` : 'Default (none set)'}
              </option>
              {/*
                A model the manifest names but the registry has never listed
                still has to be selectable, or opening this panel would silently
                reset the agent's model to the default the moment the user
                touched the credential picker.
              */}
              {declaredModel && !modelChoices.some((model) => model.id === declaredModel) && (
                <option value={declaredModel}>{declaredModel}</option>
              )}
              {modelChoices.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          ) : (
            <select
              id="runtime-complexity"
              aria-label="Work complexity"
              className={FIELD}
              // The whole scale, not the tier already chosen: the point of a
              // tooltip here is to help someone who has not chosen yet.
              title={WORK_COMPLEXITIES.map(
                (tier) => `${WORK_COMPLEXITY_LABELS[tier]} — ${WORK_COMPLEXITY_HINTS[tier]}`
              ).join('\n')}
              disabled={disabled}
              value={declaredComplexity ?? ''}
              onChange={(event) =>
                commit(
                  commitCredential(declaredCredential),
                  null,
                  isWorkComplexity(event.target.value) ? event.target.value : null
                )
              }
            >
              <option value="">
                {onCodex ? 'Default (medium effort)' : onAntigravity ? antigravityDefaultOptionLabel() : onClaude
                  ? // The Medium floor, named: an agent that picks no tier on
                    // this engine runs on `sonnet`, and there is no catalogue
                    // that could make that "none set". By the tool's name when listed.
                    `Not set — ${cliListedName(claudeModelForComplexity(null), claudeModelForComplexity(null))}`
                  : !modelsLoaded || inheritedName
                    ? 'Default'
                    : 'Default (none set)'}
              </option>
              {/*
                The tier alone, and the model it resolves to on the line below.
                Naming the model here instead put `Medium (Claude Sonnet 4.5)` —
                170px — into a 163px control at the window's 800px minimum, so
                the panel's permanent visible state was a truncated one
                (ux_rules rule 7). The suffix is kept for the one case that has
                to be legible *before* choosing: a tier this credential cannot
                serve, which is short and is a warning rather than a fact.
              */}
              {WORK_COMPLEXITIES.map((tier) => (
                <option key={tier} value={tier} title={WORK_COMPLEXITY_HINTS[tier]}>
                  {WORK_COMPLEXITY_LABELS[tier]}
                  {/*
                    "(none listed)" is a statement about a credential's
                    catalogue. There is none here, and every tier resolves — so
                    the suffix would be both false and alarming.
                  */}
                  {!onCli && modelsLoaded && !tierModels[tier] ? ' (none listed)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="col-span-2 @2xl:col-span-1">
          {/*
            **Which engine's binary is this agent's business.** A Claude agent
            has nothing to do with `opencode`, so reporting that binary beside
            it would be a fact about something unrelated (ux_rules rule 9) — and
            it used to be worse than unrelated: the row reported the shared
            server's state and offered a Start button that changed nothing for
            this agent. The column keeps its place and its label so the grid
            does not reflow; only what it reports changes.
          */}
          {onCodex ? (
            <ClaudeStatus
              label="Codex"
              tool={codexTool}
              // Not PATH detection, which this engine
              // no longer depends on. Only its own state query can be unknown.
              unknown={codexBinary === undefined}
              auth={codexAuth?.state}
              missingText={codexFailure?.badge ?? 'Install failed'}
              hint={
                codexFailure
                  ? codexFailure.hint
                  : `Cinna downloads and verifies Codex ${PINNED_CODEX_VERSION} the first time a Codex agent runs.`
              }
            />
          ) : onAntigravity ? (
            <ClaudeStatus
              label="Antigravity"
              tool={antigravityTool}
              unknown={antigravityBinary === undefined}
              auth={antigravityAuth?.state}
              missingText={antigravityFailure?.badge ?? 'Install failed'}
              hint={
                antigravityFailure
                  ? antigravityFailure.hint
                  : `Cinna downloads and verifies Antigravity ${PINNED_ANTIGRAVITY_VERSION} the first time an Antigravity agent runs.`
              }
            />
          ) : onClaude ? (
            <ClaudeStatus
              tool={claudeTool}
              unknown={claudeBinary === undefined}
              auth={claudeAuth?.state}
              missingText={claudeFailure?.badge ?? 'Install failed'}
              hint={
                claudeFailure
                  ? claudeFailure.hint
                  : `Cinna verifies Claude Code ${PINNED_CLAUDE_VERSION} the first time a Claude agent runs.`
              }
            />
          ) : (
            <EngineStatus />
          )}
        </div>
      </div>

      {/*
        A reserved line, not a conditional one. What it says changes with every
        credential switch, and a row that comes and goes would move the page's
        tab strip out from under the pointer that just used the select — the
        same reason the save spinner above is out of the flow. Truncated with
        the full sentence in `title`, so a long credential or model name cannot
        wrap into a second row and reintroduce the shift.
      */}
      <div className="mt-2 h-4">
        {status?.login ? (
          <LoginLine text={status.text} tone={status.tone} engine={status.login} login={login} />
        ) : status?.refresh ? (
          /*
            The list could not be read, or no longer lists the agent's model:
            the sentence, then the labelled way to ask the tool again, at this
            panel's scale and inside the reserved line (rule 1). It bypasses
            the ten-minute wait between automatic refreshes.
          */
          <div className="flex h-4 min-w-0 items-center gap-2">
            <div className={`min-w-0 truncate ${status.tone}`} title={status.title ?? status.text}>
              {status.text}
            </div>
            <button type="button" className={LINE_BUTTON} onClick={() => cliRefresh.retry()}>
              Refresh
            </button>
          </div>
        ) : status && (
          <div className={`truncate ${status.tone}`} title={status.title ?? status.text}>
            {status.text}
          </div>
        )}
      </div>
      {status?.login && shownLoginCommand && <LoginCommandRow key={shownLoginCommand} command={shownLoginCommand} />}

      {(agent.credentials.length > 0 || !canEdit || bare) && (
        <div className="mt-2 space-y-1.5 border-t border-[var(--color-border)] pt-2.5">
          <SecretsLine agent={agent} onOutcome={setSecrets} />
          {/*
            Where the choice went, for the one kind of agent whose folder does
            not hold it. Static and always present, so it cannot move the tab
            strip below (ux_rules rule 1) — and it is not a hint restating its
            label (rule 7): every other card on this page is a viewer over a
            file in the folder, and this one is the exception.

            Scoped to **this choice**, deliberately. "Nothing is written to the
            folder" is one tab away from being false — the Prompts tab is a live
            editor over `AGENT.md` — and a page that overstates the promise by a
            single file is the exact failure ux_rules rule 9 records.
          */}
          {bare && (
            <div className={NOTE}>
              This choice is kept in Cinna, not in the folder — so a folder that moves starts over
              on the default.
            </div>
          )}
          {!canEdit && (
            <div className={NOTE}>
              {stamp === null
                ? `${MANIFEST_FILE} could not be read, so the runtime cannot be changed here.`
                : 'This folder was built against a newer kit than this app understands, so it is read-only.'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
