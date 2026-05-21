import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppSettingsSchema } from '../../../shared/appSettings'
import { createLogger } from '../stores/logger.store'

const logger = createLogger('app-settings')

const APP_SETTINGS_KEY = ['app-settings'] as const

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
    }
  })
}
