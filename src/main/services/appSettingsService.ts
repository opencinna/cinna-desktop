import { appSettingsRepo, DEFAULTS } from '../db/appSettings'
import type {
  AppSettingKey,
  AppSettingsSchema
} from '../../shared/appSettings'
import { AppSettingsError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('app-settings')

/**
 * Single chokepoint for reads and writes to the installation-global
 * `app_settings` KV store. Owns runtime validation so the IPC layer can
 * trust the renderer-supplied `(key, value)` pair before it reaches the
 * repo — TypeScript's generics are erased at the IPC boundary, so without
 * this gate any string key / any JSON value would be persisted.
 *
 * Validation rules:
 *   - `key` must be a declared field of {@link AppSettingsSchema} (mirrors
 *     `DEFAULTS`)
 *   - `value` must match the typeof the schema's default for that key
 *
 * Add a new setting by adding a key to `AppSettingsSchema` in `shared/` and
 * a default in `appSettingsRepo`'s `DEFAULTS` — validation picks it up
 * automatically.
 */

function assertKnownKey(key: string): asserts key is AppSettingKey {
  // `key in DEFAULTS` would accept inherited properties (e.g. `toString`,
  // `__proto__`); `Object.hasOwn` confines us to the literal schema fields.
  if (!Object.hasOwn(DEFAULTS, key)) {
    throw new AppSettingsError('invalid_key', `Unknown app setting: ${key}`)
  }
}

function assertValueShape<K extends AppSettingKey>(
  key: K,
  value: unknown
): asserts value is AppSettingsSchema[K] {
  const expected = typeof DEFAULTS[key]
  const actual = typeof value
  if (expected !== actual) {
    throw new AppSettingsError(
      'invalid_value',
      `App setting "${key}" expects ${expected}, got ${actual}`
    )
  }
}

export const appSettingsService = {
  getAll(): AppSettingsSchema {
    return appSettingsRepo.getAll()
  },

  set(key: string, value: unknown): void {
    assertKnownKey(key)
    assertValueShape(key, value)
    appSettingsRepo.set(key, value)
    logger.info('app setting updated', { key, valueType: typeof value })
  }
}
