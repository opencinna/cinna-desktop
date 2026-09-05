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
 * `useProviders` and `useModels` — rather than fetching a parallel list. The
 * consequence to keep in mind: `useModels` is the *aggregate registry*, so a
 * credential whose models it has nothing for shows an empty model list, which
 * is why the model select stays enabled with a free-text fallback below it.
 */

const FIELD =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs ' +
  'text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50'
const LABEL = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]'
const NOTE = 'text-[10px] text-[var(--color-text-muted)]'
const WARN = 'text-[10px] text-[var(--color-warning)]'

/**
 * Why the engine left this agent out of its config, if it did.
 *
 * The panel's own warnings are derived from the manifest and the credential
 * list, so they cover the cases a user can see for themselves. This covers the
 * ones they cannot: a credential that exists and has a key but that the engine
 * refuses — an unsupported provider type, a gateway with no base URL — leaves
 * an agent that looks entirely fine here and does nothing when chatted with.
 */
function EngineSkipLine({ agentId }: { agentId: string }): React.JSX.Element | null {
  const { data: skips } = useEngineSkips()
  const skip = skips?.agents.find((entry) => entry.agentId === agentId)
  if (!skip) return null
  return <div className={`mt-2 ${WARN}`}>The engine skipped this agent because {skip.reason}.</div>
}

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
  const { data: models } = useModels()
  const { data: defaultMode } = useDefaultChatMode()
  const save = useSetLocalAgentRuntime()
  const [error, setError] = useState<string | null>(null)

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

  const fallbackProvider = useMemo(
    () => usable.find((provider) => provider.id === defaultMode?.providerId) ?? null,
    [usable, defaultMode?.providerId]
  )
  const effectiveProvider = selected ?? fallbackProvider

  /** The default mode's model by *name* — an id like `claude-sonnet-4-5-20250929` does not fit a select. */
  const defaultModelName = useMemo(() => {
    const id = defaultMode?.modelId
    if (!id) return null
    return (models ?? []).find((model) => model.id === id)?.name ?? id
  }, [models, defaultMode?.modelId])

  const modelChoices = useMemo(
    () => (models ?? []).filter((model) => model.providerId === effectiveProvider?.id),
    [models, effectiveProvider?.id]
  )

  const stamp = agent.stamps[MANIFEST_FILE] ?? null
  const canEdit = stamp !== null && agent.readiness !== 'contract_too_new'

  const commit = (credential: string | null, modelId: string | null): void => {
    if (!stamp) return
    setError(null)
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
            disabled={!canEdit || save.isPending}
            value={selected?.name ?? ''}
            onChange={(event) => commit(event.target.value || null, declaredModel)}
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
            disabled={!canEdit || save.isPending}
            value={declaredModel ?? ''}
            onChange={(event) => commit(declaredCredential, event.target.value || null)}
          >
            <option value="">
              {defaultModelName ? `Default (${defaultModelName})` : 'Default (none set)'}
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

      {(agent.credentials.length > 0 ||
        error ||
        !canEdit ||
        (declaredCredential && !selected) ||
        (effectiveProvider && modelChoices.length === 0)) && (
        <div className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-2.5">
          <SecretsLine agent={agent} />
          {declaredCredential && !selected && (
            <div className={WARN}>
              This agent asks for “{declaredCredential}”, which is not configured on this machine.
            </div>
          )}
          {effectiveProvider && modelChoices.length === 0 && (
            <div className={NOTE}>
              No models listed for this credential yet. Open Settings → AI Credentials to load them.
            </div>
          )}
          {!canEdit && (
            <div className={NOTE}>
              {stamp === null
                ? 'cinna-agent.json could not be read, so the runtime cannot be changed here.'
                : 'This folder was built against a newer kit than this app understands, so it is read-only.'}
            </div>
          )}
          {error && <div className="text-[10px] text-[var(--color-danger)]">{error}</div>}
        </div>
      )}
      <EngineSkipLine agentId={agent.id} />
    </section>
  )
}
