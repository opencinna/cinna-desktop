import { isClaudeApiCredential, pickClaudeApiCredential } from '../../../shared/claudeAuthMode'
import { useProviders } from './useProviders'
import { useDefaultChatMode } from './useChatModes'
import { useAppSettings } from './useAppSettings'

/**
 * The Anthropic credential Claude Agent spends in API Token mode, by main's
 * rule: the one chosen in Settings, else the Default AI credential (the
 * machine's pinned one while it exists, else the default chat mode's) when it
 * qualifies, else the first usable one. One answer for the Settings row and
 * the agent page, so the two never name different keys.
 */
type Provider = NonNullable<ReturnType<typeof useProviders>['data']>[number]

export function useClaudeApiCredential(): {
  mode: 'subscription' | 'api_key'
  chosenId: string
  usable: Provider[]
  inForce: Provider | null
  chosenGone: boolean
  providersLoaded: boolean
} {
  const { data: providers } = useProviders()
  const { data: defaultMode } = useDefaultChatMode()
  const { data: appSettings } = useAppSettings()
  const mode = appSettings?.claudeAuthMode === 'api_key' ? 'api_key' : 'subscription'
  const chosenId = appSettings?.claudeApiCredentialId?.trim() ?? ''
  const all = providers ?? []
  const pinnedId = appSettings?.localAgentsDefaultCredentialId?.trim() ?? ''
  const preferredId = pinnedId && all.some((p) => p.id === pinnedId) ? pinnedId : (defaultMode?.providerId ?? null)
  const inForce = pickClaudeApiCredential(all, chosenId, chosenId ? null : preferredId)
  return {
    mode,
    chosenId,
    usable: all.filter(isClaudeApiCredential),
    inForce,
    chosenGone: chosenId !== '' && inForce === null,
    providersLoaded: providers !== undefined
  }
}
