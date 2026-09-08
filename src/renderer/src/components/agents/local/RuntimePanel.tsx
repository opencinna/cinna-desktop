import { useMemo, useState } from 'react'
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
import { useEngineSkips, useEngineState, useStartEngine } from '../../../hooks/useEngine'
import { useAppSettings, useSetAppSetting } from '../../../hooks/useAppSettings'
import { credentialOptionLabel } from '../../../utils/credentialLabel'
import { findCredentialByReference, isCredentialUsable } from '../../../../../shared/credentials'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { isStaleWriteError } from '../../../../../shared/localAgents'
import {
  defaultRuntimeModelId,
  modelBelongsElsewhere,
  resolveRuntimeModel
} from '../../../../../shared/runtimeDefaults'
import {
  describeCredential,
  describeEngineSkip,
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

const FIELD =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs ' +
  'text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50'
const LABEL = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]'
const NOTE = 'text-[10px] text-[var(--color-text-muted)]'
const WARN = 'text-[10px] text-[var(--color-warning)]'
const DANGER = 'text-[10px] text-[var(--color-danger)]'

/** The engine's state as a dot and a word, and the button that changes it. */
function EngineStatus(): React.JSX.Element {
  const { data: state } = useEngineState()
  const start = useStartEngine()
  const status = state?.status ?? 'stopped'
  const busy = status === 'installing' || status === 'starting' || start.isPending

  const text =
    status === 'running'
      ? `Running${state?.version ? ` · opencode ${state.version}` : ''}`
      : status === 'installing'
        ? 'Downloading — once, about a minute'
        : status === 'starting'
          ? 'Starting…'
          : status === 'failed'
            ? (state?.error ?? 'Could not start')
            : 'Not running'
  const dot =
    status === 'running'
      ? 'text-[var(--color-success)]'
      : status === 'failed'
        ? 'text-[var(--color-danger)]'
        : 'text-[var(--color-text-muted)]'

  return (
    <div>
      <span className={LABEL}>Engine</span>
      <div className="flex h-[26px] items-center gap-2 text-xs">
        <Circle size={7} className={`shrink-0 fill-current ${dot}`} />
        <span
          className={`min-w-0 truncate ${
            status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
          }`}
          title={text}
        >
          {text}
        </span>
        {status !== 'running' && (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={busy}
            className="shrink-0 rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium
              text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]
              disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : 'Start'}
          </button>
        )}
      </div>
    </div>
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

export function RuntimePanel({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const { data: providers } = useProviders()
  const { data: models, isError: modelsFailed } = useModels()
  const { data: defaultMode } = useDefaultChatMode()
  const { data: skips } = useEngineSkips()
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
  const skip = skips?.agents.find((entry) => entry.agentId === agent.id) ?? null

  const declaredCredential = agent.runtime?.credential ?? null
  const declaredModel = agent.runtime?.model ?? null
  const declaredComplexity = isWorkComplexity(agent.runtime?.complexity)
    ? agent.runtime.complexity
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
  const selected = useMemo(
    () =>
      declaredCredential
        ? findCredentialByReference(providers ?? [], declaredCredential)
        : null,
    [declaredCredential, providers]
  )

  /**
   * The Default runtime's credential, looked up across *all* providers rather
   * than the usable ones — `runtimeService.resolveDefault` does the same, and a
   * default mode pointing at a keyless credential must read the same here as it
   * does to the engine. It is not offered as an option; it only names what
   * "Default" means.
   */
  /**
   * **This machine's pinned credential wins over the default chat mode**, the
   * same order `runtimeService.resolveDefault` applies. Settings → Local Agents
   * → Default AI credential writes `localAgentsDefaultCredentialId`, and a
   * panel that kept reading the chat mode alone would label an agent
   * `Default (OpenAI)` while the engine built it on the pinned Anthropic key —
   * a user reading this card to find out which key they are spending would be
   * told the wrong one, which is the exact failure this module was rebuilt
   * around.
   *
   * A pin naming a credential this machine no longer has falls through to the
   * chat mode, again matching main.
   */
  const pinnedProvider = useMemo(() => {
    const pinned = settings?.localAgentsDefaultCredentialId ?? ''
    return pinned === ''
      ? null
      : ((providers ?? []).find((provider) => provider.id === pinned) ?? null)
  }, [providers, settings?.localAgentsDefaultCredentialId])
  const fallbackProvider = useMemo(
    () =>
      pinnedProvider ??
      (providers ?? []).find((provider) => provider.id === defaultMode?.providerId) ??
      null,
    [pinnedProvider, providers, defaultMode?.providerId]
  )
  const effectiveProvider = selected ?? fallbackProvider

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
  const unconvertible =
    declaredModel !== null && classifyModel(declaredModel, providerType) === null
  /**
   * The model id the last model → tier conversion moved away from, so the
   * reverse toggle restores it rather than re-deriving one. See
   * {@link toggleAdvanced}: `bestInTier` prefers a stable alias, so re-deriving
   * would quietly trade a deliberately pinned dated snapshot for a floating one.
   */
  const [pinned, setPinned] = useState<{ agentId: string; modelId: string } | null>(null)
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
  const pickerUnknown = declaredView === null && view?.agentId !== agent.id && !settingsLoaded

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
    !canEdit || (!modelsLoaded && !modelsFailed) || !settingsLoaded || saving

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

  const status = ((): { text: string; tone: string } | null => {
    if (error) return { text: error, tone: DANGER }
    // What the user just clicked outranks a note about a write before it.
    if (secrets) return secrets
    if (dropped && dropped.agentId === agent.id && noteStillTrue(dropped)) {
      return { text: dropped.text, tone: NOTE }
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
    // The engine's own skip, worded here rather than in `configGenerator`.
    if (skip) return { text: describeEngineSkip(skip.code), tone: WARN }
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
          : `Default — follows your default chat mode, on ${nameOf(choice.modelId)}.`,
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

  const commit = (
    credential: string | null,
    modelId: string | null,
    complexity: WorkComplexity | null,
    options: { note?: string; view?: boolean; persist?: boolean; keep?: string | null } = {}
  ): void => {
    if (!bare && !stamp) return
    setError(null)
    // A message about credentials/.env must not survive the next thing the user
    // does in the pickers above it.
    setSecrets(null)
    if (options.note) note(options.note, { model: modelId, complexity })
    else setDropped(null)
    const runtime = { credential, modelId, complexity }
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
  const changeCredential = (value: string): void => {
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
    commit(
      value || null,
      bothSet && !advanced ? null : stale ? null : declaredModel,
      bothSet && advanced ? null : declaredComplexity,
      stale && next
        ? { note: `Dropped “${nameOf(declaredModel)}” — ${next.name} does not list it.` }
        : {}
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
      commit(declaredCredential, model, null, {
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
      commit(declaredCredential, null, tier, {
        view: next,
        persist: true,
        keep: declaredModel,
        note: `Switched to ${WORK_COMPLEXITY_LABELS[tier]} — the tier “${nameOf(declaredModel)}” belongs to.`
      })
    }
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
          <label htmlFor="runtime-credential" className={LABEL}>
            Credential
          </label>
          <select
            id="runtime-credential"
            className={FIELD}
            title={
              selected
                ? selected.name
                : fallbackProvider
                  ? `Default: ${fallbackProvider.name}`
                  : undefined
            }
            disabled={disabled}
            value={selected?.name ?? ''}
            onChange={(event) => changeCredential(event.target.value)}
          >
            <option value="">
              {fallbackProvider ? `Default (${fallbackProvider.name})` : 'Default (none set)'}
            </option>
            {/*
              A credential the manifest names that is not offered — configured
              but keyless — still needs an option, or the select would render
              blank over a file that plainly names one. Same reason the Model
              select carries an entry for an id the registry never listed.
            */}
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
              {pickerUnknown ? 'Runs on' : advanced ? 'Model' : 'Work complexity'}
            </label>
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
                  ? `Advanced stays on — “${nameOf(declaredModel)}” matches no work complexity.`
                  : 'Pick the exact model instead of how hard the work is'
              }
            >
              <input
                type="checkbox"
                className="size-3 accent-[var(--color-accent)]"
                checked={advanced}
                disabled={disabled || unconvertible}
                onChange={(event) => toggleAdvanced(event.target.checked)}
              />
              Advanced
            </label>
          </div>
          {pickerUnknown ? (
            /* Same footprint, no claim: which picker this agent gets is not
               known yet, and guessing is what produces the swap. */
            <select id="runtime-pending" aria-label="Runs on" className={FIELD} disabled>
              <option>Loading…</option>
            </select>
          ) : advanced ? (
            <select
              id="runtime-model"
              aria-label="Model"
              className={FIELD}
              title={inheritedName ? `Default: ${inheritedName}` : undefined}
              disabled={disabled}
              value={declaredModel ?? ''}
              onChange={(event) => commit(declaredCredential, event.target.value || null, null)}
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
                  declaredCredential,
                  null,
                  isWorkComplexity(event.target.value) ? event.target.value : null
                )
              }
            >
              <option value="">
                {!modelsLoaded || inheritedName ? 'Default' : 'Default (none set)'}
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
                  {modelsLoaded && !tierModels[tier] ? ' (none listed)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="col-span-2 @2xl:col-span-1">
          <EngineStatus />
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
        {status && (
          <div className={`truncate ${status.tone}`} title={status.text}>
            {status.text}
          </div>
        )}
      </div>

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
