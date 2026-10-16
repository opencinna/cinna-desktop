import { useMemo } from 'react'
import { findCredentialByReference } from '../../../shared/credentials'
import { DEFAULT_AGENT_ENGINE, effectiveEngine } from '../../../shared/engine'
import type { LocalAgentDto } from '../../../shared/localAgents'
import { useAppSettings } from './useAppSettings'
import { useDefaultChatMode } from './useChatModes'
import { useDefaultRuntime } from './useEngine'
import { useProviders } from './useProviders'

type Provider = NonNullable<ReturnType<typeof useProviders>['data']>[number]

/**
 * What is wrong with the AI credential an OpenCode agent would spend, or null:
 * `missing` — the manifest names a credential this machine does not have, or
 * nothing resolves at all; `inactive` — it resolves to one the user switched off.
 */
export type AiCredentialIssue = 'missing' | 'inactive' | null

export interface AgentCredentialResolution {
  providers: Provider[] | undefined
  /** The credential the agent's own `runtime.credential` resolves to. */
  selected: Provider | null
  /** This machine's pinned Default AI credential, when it names one that exists. */
  pinnedProvider: Provider | null
  /** What "Default" means here: the pin, else the default chat mode's credential. */
  fallbackProvider: Provider | null
  /** The credential the engine is built on: the agent's own, else the default. */
  effectiveProvider: Provider | null
  /** The agent names a credential and nothing on this machine answers to it. */
  credentialMissing: boolean
  /** The providers, settings and chat modes the fallback depends on have all answered. */
  loaded: boolean
  issue: AiCredentialIssue
}

/**
 * The one judgement of an agent's AI credential, for the Runs with panel's
 * "AI credential needed" badge and the composer's notice row. `providers`
 * undefined (not loaded) never says `missing` by itself; a declared reference
 * that resolves to nothing does.
 */
export function aiCredentialIssue(
  resolution: Pick<AgentCredentialResolution, 'providers' | 'effectiveProvider' | 'credentialMissing'>
): AiCredentialIssue {
  const { providers, effectiveProvider, credentialMissing } = resolution
  if (credentialMissing || (providers !== undefined && !effectiveProvider)) return 'missing'
  if (effectiveProvider && !effectiveProvider.enabled) return 'inactive'
  return null
}

/**
 * Which AI credential an agent's runtime resolves to, in the order
 * `runtimeService.resolve` applies: the agent's own reference (through the
 * shared `findCredentialByReference`, the function the engine resolves with),
 * then **this machine's pinned credential**, then the default chat mode's.
 * A pin naming a credential that no longer exists falls through, as in main.
 */
export function useAgentCredentialResolution(declaredCredential: string | null): AgentCredentialResolution {
  const { data: providers } = useProviders()
  const { data: defaultMode, isPending: modesPending } = useDefaultChatMode()
  const { data: settings } = useAppSettings()
  const selected = useMemo(
    () => (declaredCredential ? findCredentialByReference(providers ?? [], declaredCredential) : null),
    [declaredCredential, providers]
  )
  const pinnedProvider = useMemo(() => {
    const pinned = settings?.localAgentsDefaultCredentialId ?? ''
    return pinned === '' ? null : ((providers ?? []).find((provider) => provider.id === pinned) ?? null)
  }, [providers, settings?.localAgentsDefaultCredentialId])
  const fallbackProvider = useMemo(
    () => pinnedProvider ?? (providers ?? []).find((provider) => provider.id === defaultMode?.providerId) ?? null,
    [pinnedProvider, providers, defaultMode?.providerId]
  )
  const effectiveProvider = selected ?? fallbackProvider
  const credentialMissing = !!declaredCredential && !selected
  return {
    providers,
    selected,
    pinnedProvider,
    fallbackProvider,
    effectiveProvider,
    credentialMissing,
    loaded: providers !== undefined && settings !== undefined && !modesPending,
    issue: aiCredentialIssue({ providers, effectiveProvider, credentialMissing })
  }
}

/**
 * The AI credential problem of a folder agent that runs on OpenCode, or null —
 * for any other engine (they spend no credential of this app's), before the
 * provider list, settings, chat modes or this machine's default runtime have answered (so nothing
 * appears and then vanishes), and for no agent.
 */
export function useAgentAiCredentialIssue(agent: LocalAgentDto | null | undefined): AiCredentialIssue {
  const resolution = useAgentCredentialResolution(agent?.runtime?.credential ?? null)
  const { data: defaultRuntime } = useDefaultRuntime()
  // Every input the fallback reads, not just the providers: before the chat
  // modes or settings answer, an agent with no credential of its own resolves
  // to nothing and would show the row for a moment (ux_rules rule 1).
  if (!agent || !resolution.loaded || defaultRuntime === undefined) return null
  if (effectiveEngine(agent.runtime, defaultRuntime.engine ?? DEFAULT_AGENT_ENGINE) !== 'opencode') return null
  return resolution.issue
}
