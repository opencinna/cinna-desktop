import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppSettingsSchema } from '../../../shared/appSettings'
import { createLogger } from '../stores/logger.store'
import { AGENT_CREDENTIAL_BINDINGS_KEY, LOCAL_AGENTS_KEY } from './useLocalAgents'
import { DEFAULT_RUNTIME_KEY } from './useEngine'

const logger = createLogger('app-settings')

const APP_SETTINGS_KEY = ['app-settings'] as const

/**
 * Where AI Functions will run, as main decides it. Derived in main from the
 * AI Functions binding *and* the chosen credential's row, so it is stale after
 * either changes: `useSetAppSetting` invalidates it on every write, and the
 * provider mutations and account-config sync in `useProviders` do too.
 */
export const AI_FUNCTIONS_BACKEND_KEY = ['ai-functions-backend'] as const

/**
 * Tagged union over the schema so `(key, value)` stays type-safe at the
 * call site even as new settings are added — TanStack Query can't infer
 * a generic `<K>` mutation-fn parameter on its own.
 */
type SetSettingInput = {
  [K in keyof AppSettingsSchema]: { key: K; value: AppSettingsSchema[K] }
}[keyof AppSettingsSchema]

/**
 * Read the installation-global app settings. Cached across mounts so
 * opening the Settings page (or any future feature-flag consumer) doesn't
 * re-fetch on every navigation — TanStack Query handles the invalidation
 * on writes.
 */
export function useAppSettings() {
  return useQuery({
    queryKey: APP_SETTINGS_KEY,
    queryFn: () => window.api.settings.getAll()
  })
}

/**
 * Main's answer to "where do titles and drafts run right now". The Features tab
 * renders only this, never its own reading of the binding. One fixed key, so a
 * refetch keeps showing the previous answer until the new one lands.
 */
export function useAiFunctionsBackend() {
  return useQuery({
    queryKey: AI_FUNCTIONS_BACKEND_KEY,
    queryFn: () => window.api.settings.aiFunctionsBackend()
  })
}

/**
 * Write a single app setting. Optimistically updates the cache so the
 * toggle in the UI flips instantly; on failure the previous snapshot is
 * restored and the error is logged for the renderer overlay (Cmd+`).
 */
export function useSetAppSetting() {
  const queryClient = useQueryClient()

  return useMutation<
    { success: true },
    Error,
    SetSettingInput,
    { previous?: AppSettingsSchema }
  >({
    mutationFn: (input) => window.api.settings.set(input.key, input.value),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: APP_SETTINGS_KEY })
      const previous = queryClient.getQueryData<AppSettingsSchema>(APP_SETTINGS_KEY)
      if (previous) {
        queryClient.setQueryData<AppSettingsSchema>(APP_SETTINGS_KEY, {
          ...previous,
          [input.key]: input.value
        })
      }
      return { previous }
    },
    onError: (err, input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(APP_SETTINGS_KEY, context.previous)
      }
      logger.warn('failed to update app setting', {
        key: input.key,
        error: err instanceof Error ? err.message : String(err)
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: APP_SETTINGS_KEY })
      queryClient.invalidateQueries({ queryKey: ['local-development-context'] })
      // `localAgentsDefaultCredentialId` lives here and outranks the default
      // chat mode in an agent's runtime chain, so pinning or clearing it moves
      // which credential the sidebar is judging. Invalidated unconditionally
      // rather than on that one key: this mutation writes one setting at a
      // time, and the query is a synchronous main-side map.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
      /**
       * `localAgentsDefaultEngine` is the other setting a *main-side* answer is
       * derived from: main resolves the Default Runtime out of it plus what is
       * installed, and every surface that names what an agent runs on reads that
       * one value. Invalidated here rather than at the Settings screen for the
       * same reason as the line above — this hook is the one place that knows a
       * setting was written, and the agent page's panel is a different component
       * that must not be able to forget.
       *
       * Main also re-indexes the agent rows on this key (see `settings:set`),
       * so the local agent list is asked again too: the row's cached launcher is
       * what decides whether the composer offers a question path.
       */
      queryClient.invalidateQueries({ queryKey: DEFAULT_RUNTIME_KEY })
      queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
      // `aiFunctionsCredentialId` / `aiFunctionsModelId` are what main's
      // "Runs on" answer is derived from. Unconditional for the same reason
      // as the credential bindings above.
      queryClient.invalidateQueries({ queryKey: AI_FUNCTIONS_BACKEND_KEY })
    }
  })
}
