import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useOpenAgentPath, useSetLocalAgentRuntime } from '../../../hooks/useLocalAgents'
import { useDefaultChatMode } from '../../../hooks/useChatModes'
import { useModels } from '../../../hooks/useModels'
import { useProviders } from '../../../hooks/useProviders'
import { useEngineSkips, useEngineState, useStartEngine } from '../../../hooks/useEngine'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { isStaleWriteError } from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'

/**
 * Runtime: which credential and which model this agent runs on, and whether the
 * engine that would run it is up.
 *
 * The card is a viewer over `cinna-agent.json` like every other card here, so
 * what it writes is a credential **name** and a model id — never a key, and
 * never our internal provider id, which means nothing once the folder is on
 * somebody else's machine. The write goes through the same stamped
 * `update-field` path as the prompt editors, so an assistant editing the
 * manifest while this is open cannot be clobbered.
 *
 * Both pickers read from the hooks the rest of the app already uses —
 * `useProviders` and `useModels` — rather than fetching a parallel list. The
 * consequence to keep in mind: `useModels` is the *aggregate registry*, so a
 * credential whose models it has nothing for shows an empty model list, which
 * is why the model select stays enabled with a free-text fallback below it.
 */

const EMPTY = 'text-[10px] italic text-[var(--color-text-muted)]'
const FIELD =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs ' +
  'text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Why the engine left this agent out of its config, if it did.
 *
 * The card's own warnings are derived from the manifest and the credential
 * list, so they cover the cases a user can see for themselves. This covers the
 * ones they cannot: a credential that exists and has a key but that the engine
 * refuses — an unsupported provider type, a gateway with no base URL — leaves
 * an agent that looks entirely fine here and does nothing when chatted with.
 */
function EngineSkipLine({ agentId }: { agentId: string }): React.JSX.Element | null {
  const { data: skips } = useEngineSkips()
  const skip = skips?.agents.find((entry) => entry.agentId === agentId)
  if (!skip) return null
  return (
    <div className="mt-2 text-[10px] text-[var(--color-warning)]">
      The engine skipped this agent because {skip.reason}.
    </div>
  )
}

/** One line saying what the engine is doing, and the button that changes it. */
function EngineLine(): React.JSX.Element {
  const { data: state } = useEngineState()
  const start = useStartEngine()
  const status = state?.status ?? 'stopped'
  const busy = status === 'installing' || status === 'starting' || start.isPending

  const text =
    status === 'running'
      ? `Running${state?.version ? ` · opencode ${state.version}` : ''}`
      : status === 'installing'
        ? 'Downloading the engine — this happens once and takes a minute.'
        : status === 'starting'
          ? 'Starting…'
          : status === 'failed'
            ? (state?.error ?? 'The engine could not start.')
            : 'Not running.'

  return (
    <div className="flex items-start gap-2">
      <span
        className={
          status === 'failed'
            ? 'text-[var(--color-danger)]'
            : status === 'running'
              ? 'text-[var(--color-text-secondary)]'
              : 'text-[var(--color-text-muted)]'
        }
      >
        {text}
      </span>
      <div className="flex-1" />
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
  )
}

export function RuntimeCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const { data: providers } = useProviders()
  const { data: models } = useModels()
  const { data: defaultMode } = useDefaultChatMode()
  const openPath = useOpenAgentPath()
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
    <AgentCard
      title="Runtime"
      file={MANIFEST_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })}
      actions={
        save.isPending ? (
          <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
        ) : null
      }
    >
      <dl className="space-y-2 text-xs">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 pt-1 text-[var(--color-text-muted)]">Credential</dt>
          <dd className="min-w-0 flex-1">
            <select
              className={FIELD}
              disabled={!canEdit || save.isPending}
              value={selected?.name ?? ''}
              onChange={(event) => commit(event.target.value || null, declaredModel)}
            >
              <option value="">
                {fallbackProvider
                  ? `Default chat mode (${fallbackProvider.name})`
                  : 'Default chat mode — none configured'}
              </option>
              {usable.map((provider) => (
                <option key={provider.id} value={provider.name}>
                  {provider.name}
                </option>
              ))}
            </select>
            {declaredCredential && !selected && (
              <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                This agent asks for “{declaredCredential}”, which is not configured on this
                machine.
              </div>
            )}
          </dd>
        </div>

        <div className="flex gap-2">
          <dt className="w-24 shrink-0 pt-1 text-[var(--color-text-muted)]">Model</dt>
          <dd className="min-w-0 flex-1">
            <select
              className={FIELD}
              disabled={!canEdit || save.isPending}
              value={declaredModel ?? ''}
              onChange={(event) => commit(declaredCredential, event.target.value || null)}
            >
              <option value="">
                {defaultMode?.modelId
                  ? `Default chat mode (${defaultMode.modelId})`
                  : 'Default chat mode — none configured'}
              </option>
              {/*
                A model the manifest names but the registry has never listed
                still has to be selectable, or opening this card would silently
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
            {effectiveProvider && modelChoices.length === 0 && (
              <div className={`mt-1 ${EMPTY}`}>
                No models listed for this credential yet. Open Settings → AI Credentials to load
                them.
              </div>
            )}
          </dd>
        </div>

        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-[var(--color-text-muted)]">Engine</dt>
          <dd className="min-w-0 flex-1">
            <EngineLine />
          </dd>
        </div>
      </dl>

      <EngineSkipLine agentId={agent.id} />

      {!canEdit && (
        <div className={`mt-2 ${EMPTY}`}>
          {stamp === null
            ? 'cinna-agent.json could not be read, so the runtime cannot be changed here.'
            : 'This folder was built against a newer kit than this app understands, so it is read-only.'}
        </div>
      )}
      {error && <div className="mt-2 text-[10px] text-[var(--color-danger)]">{error}</div>}
      {!declaredCredential && !declaredModel && (
        <div className={`mt-2 ${EMPTY}`}>
          Nothing is set, so this agent follows your default chat mode. Choosing here writes a
          credential name and a model into <code>cinna-agent.json</code> — never a key.
        </div>
      )}
    </AgentCard>
  )
}
