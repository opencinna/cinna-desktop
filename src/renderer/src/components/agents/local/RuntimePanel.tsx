import { useMemo, useState } from 'react'
import { Check, Circle, Loader2, Minus } from 'lucide-react'
import { useOpenAgentPath, useSetLocalAgentRuntime } from '../../../hooks/useLocalAgents'
import { useDefaultChatMode } from '../../../hooks/useChatModes'
import { useModels } from '../../../hooks/useModels'
import { useProviders } from '../../../hooks/useProviders'
import { useEngineSkips, useEngineState, useStartEngine } from '../../../hooks/useEngine'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { isStaleWriteError } from '../../../../../shared/localAgents'
import { inheritedModelId, modelBelongsElsewhere } from '../../../../../shared/runtimeDefaults'

/**
 * "Runs with": the one thing on this page a user actually configures.
 *
 * Which credential and model the agent runs on, whether the engine that would
 * run it is up, and whether the secrets the folder declares are in place — on
 * one panel, as controls, with a warning only where something is wrong. It is
 * a viewer over `cinna-agent.json` like everything else here, so what it
 * writes is a credential **name** and a model id — never a key, and never our
 * internal provider id, which means nothing once the folder is on somebody
 * else's machine. The write goes through the same stamped `update-field` path
 * as the prompt editors, so an assistant editing the manifest while this is
 * open cannot be clobbered.
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
function SecretsLine({ agent }: { agent: LocalAgentDto }): React.JSX.Element | null {
  const openPath = useOpenAgentPath()
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
        onClick={() => openPath.mutate({ agentId: agent.id, relPath: 'credentials' })}
        className="text-[var(--color-text-muted)] underline-offset-2 transition-colors hover:text-[var(--color-text)] hover:underline"
        title="Reveal credentials/.env — values stay on this machine"
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
  const save = useSetLocalAgentRuntime()
  const [error, setError] = useState<string | null>(null)
  /**
   * What the last credential change did to the model, kept until the next one.
   *
   * Clearing a model the new credential cannot serve is right, but it rewrites
   * a file the user commits, so it cannot happen wordlessly (ux_rules rule 6).
   * Tagged with the agent it happened to: this panel is remounted with a new
   * `agent` when the page switches, and a notice about somebody else's model
   * would be worse than none.
   */
  const [dropped, setDropped] = useState<{ agentId: string; text: string } | null>(null)
  const skip = skips?.agents.find((entry) => entry.agentId === agent.id) ?? null

  const declaredCredential = agent.runtime?.credential ?? null
  const declaredModel = agent.runtime?.model ?? null

  /**
   * Credentials this app can actually make a call with. A managed row flagged
   * `unsupported` (an Anthropic OAuth token, not an API key) is excluded for the
   * same reason the chat modes exclude it: offering it produces a failure at the
   * first turn rather than at the moment of choosing.
   */
  const usable = useMemo(
    () => (providers ?? []).filter((provider) => provider.hasApiKey && !provider.unsupported),
    [providers]
  )

  /** The credential the manifest's reference resolves to — id, name, then type. */
  const selected = useMemo(() => {
    if (!declaredCredential) return null
    const needle = declaredCredential.trim().toLowerCase()
    return (
      usable.find((provider) => provider.id === declaredCredential) ??
      usable.find((provider) => provider.name.trim().toLowerCase() === needle) ??
      usable.find((provider) => provider.type.toLowerCase() === needle) ??
      null
    )
  }, [declaredCredential, usable])

  /**
   * The Default runtime's credential, looked up across *all* providers rather
   * than the usable ones — `runtimeService.resolveDefault` does the same, and a
   * default mode pointing at a keyless credential must read the same here as it
   * does to the engine. It is not offered as an option; it only names what
   * "Default" means.
   */
  const fallbackProvider = useMemo(
    () => (providers ?? []).find((provider) => provider.id === defaultMode?.providerId) ?? null,
    [providers, defaultMode?.providerId]
  )
  const effectiveProvider = selected ?? fallbackProvider

  const modelChoices = useMemo(
    () => (models ?? []).filter((model) => model.providerId === effectiveProvider?.id),
    [models, effectiveProvider?.id]
  )

  /**
   * The model this agent runs on when its manifest names none — for *this*
   * credential, not for the app. The rule is `shared/runtimeDefaults`, called
   * by the engine's own resolution too, so this label states what would
   * actually run rather than a second guess at it.
   */
  const inherited = useMemo(
    () =>
      inheritedModelId(effectiveProvider, {
        credentialId: defaultMode?.providerId ?? null,
        credentialType: fallbackProvider?.type ?? null,
        modelId: defaultMode?.modelId ?? null
      }),
    [effectiveProvider, fallbackProvider?.type, defaultMode?.providerId, defaultMode?.modelId]
  )

  /** That model by *name* — an id like `claude-sonnet-4-5-20250929` does not fit a select. */
  const inheritedName = useMemo(() => {
    if (!inherited) return null
    return (models ?? []).find((model) => model.id === inherited)?.name ?? inherited
  }, [models, inherited])

  const stamp = agent.stamps[MANIFEST_FILE] ?? null
  /**
   * The model registry is one network round trip *per credential*, so it lands
   * seconds after the provider list on a cold page. Editing before it arrives
   * cannot be done honestly: the Model select would offer a list it has not
   * loaded, and a credential change could not tell a model that belongs to
   * another catalogue from one the registry has simply not listed yet.
   */
  const modelsLoaded = models !== undefined
  const canEdit = stamp !== null && agent.readiness !== 'contract_too_new'
  const disabled = !canEdit || (!modelsLoaded && !modelsFailed) || save.isPending

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
  const status = ((): { text: string; tone: string } | null => {
    if (error) return { text: error, tone: DANGER }
    if (dropped && dropped.agentId === agent.id) return { text: dropped.text, tone: NOTE }
    // Before the provider list lands, every credential looks missing. Saying so
    // would put a false warning in the slot and then take it away again.
    if (!providers) {
      return modelsLoaded ? null : { text: 'Loading the model list…', tone: NOTE }
    }
    if (declaredCredential && !selected) {
      return {
        text: `This agent asks for “${declaredCredential}”, which is not configured on this machine.`,
        tone: WARN
      }
    }
    if (!effectiveProvider) {
      return { text: 'No AI credential to run on. Add one in Settings → AI Credentials.', tone: WARN }
    }
    // The Default runtime is named even when it cannot run — `resolveDefault`
    // does the same — so the panel has to say which of the two it is.
    if (!effectiveProvider.hasApiKey || effectiveProvider.unsupported) {
      return { text: `“${effectiveProvider.name}” has no API key this app can use.`, tone: WARN }
    }
    if (!modelsLoaded) {
      return modelsFailed
        ? { text: 'Could not load the model list. Models can still be typed into the manifest.', tone: WARN }
        : { text: 'Loading the model list…', tone: NOTE }
    }
    if (modelBelongsElsewhere(declaredModel, effectiveProvider, models ?? [], providers)) {
      const owner = (models ?? []).find((model) => model.id === declaredModel)
      const ownerName =
        providers.find((provider) => provider.id === owner?.providerId)?.name ?? 'another credential'
      // Action first: at the 800px minimum window this line is truncated, and
      // the half that survives has to be the half the user can act on.
      return {
        text: `Pick a model ${effectiveProvider.name} lists — “${declaredModel}” is ${ownerName}’s.`,
        tone: WARN
      }
    }
    // "Pick one" is only an instruction the user can follow while the select
    // has something in it; with an empty list the note below is the remedy.
    if (!declaredModel && inherited === null && modelChoices.length > 0) {
      return { text: 'No model set. Pick one, or this agent has nothing to run on.', tone: WARN }
    }
    if (skip) return { text: `The engine skipped this agent because ${skip.reason}.`, tone: WARN }
    if (modelChoices.length === 0) {
      return {
        text: 'No models listed for this credential yet. Open Settings → AI Credentials to load them.',
        tone: NOTE
      }
    }
    return null
  })()

  const commit = (credential: string | null, modelId: string | null): void => {
    if (!stamp) return
    setError(null)
    setDropped(null)
    save.mutate(
      { agentId: agent.id, expectedStamp: stamp, runtime: { credential, modelId } },
      {
        onError: (err) =>
          setError(
            isStaleWriteError(err)
              ? 'cinna-agent.json changed on disk since this page loaded. Reload the agent and try again.'
              : err instanceof Error
                ? err.message
                : 'Could not save that.'
          )
      }
    )
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
    commit(value || null, stale ? null : declaredModel)
    if (stale && next) {
      const name = (models ?? []).find((model) => model.id === declaredModel)?.name ?? declaredModel
      setDropped({ agentId: agent.id, text: `Dropped “${name}” — ${next.name} does not list it.` })
    }
  }

  return (
    <section
      aria-label="Runs with"
      className="@container relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3"
    >
      {/* Out of the flow: a save indicator that adds a row would move the tabs below. */}
      {save.isPending && (
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
            {usable.map((provider) => (
              <option key={provider.id} value={provider.name}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="runtime-model" className={LABEL}>
            Model
          </label>
          <select
            id="runtime-model"
            className={FIELD}
            title={inheritedName ? `Default: ${inheritedName}` : undefined}
            disabled={disabled}
            value={declaredModel ?? ''}
            onChange={(event) => commit(declaredCredential, event.target.value || null)}
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

      {(agent.credentials.length > 0 || !canEdit) && (
        <div className="mt-2 space-y-1.5 border-t border-[var(--color-border)] pt-2.5">
          <SecretsLine agent={agent} />
          {!canEdit && (
            <div className={NOTE}>
              {stamp === null
                ? 'cinna-agent.json could not be read, so the runtime cannot be changed here.'
                : 'This folder was built against a newer kit than this app understands, so it is read-only.'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
