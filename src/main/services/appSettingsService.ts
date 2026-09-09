import { isAbsolute } from 'node:path'
import { appSettingsRepo, DEFAULTS } from '../db/appSettings'
import type {
  AppSettingKey,
  AppSettingsSchema
} from '../../shared/appSettings'
import { AppSettingsError } from '../errors'
import { createLogger } from '../logger/logger'
import { assertUsableRoot } from './localAgents/pathRules'
import { isLocalToolId } from '../../shared/localTools'

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
 *
 * A key whose *type* does not make it safe adds an entry to {@link VALUE_CHECKS}
 * as well. Every setting was a boolean until `localAgentsHome`, and a boolean is
 * fully described by its type; a filesystem path is not.
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

/**
 * Extra per-key checks, for settings a `typeof` cannot make safe.
 *
 * `localAgentsHome` names a directory this app creates files in and hands to
 * the "open in…" guard as an allowed root, so an arbitrary string is not an
 * acceptable value even though it is the right type. The path rules are shared
 * with the rest of that feature, so a folder rejected here is exactly the set
 * rejected everywhere else.
 *
 * The read side stays defensive regardless — `agentsHomeService` re-validates
 * and falls back to the default — but rejecting at the boundary means the user
 * is told, instead of saving a value that is silently ignored forever.
 */
const VALUE_CHECKS: {
  [K in AppSettingKey]?: (value: AppSettingsSchema[K]) => void
} = {
  localAgentsHome: (value) => {
    // Empty means "use the built-in default", which is always valid.
    if (value.trim() === '') return
    try {
      assertUsableRoot(value)
    } catch {
      throw new AppSettingsError(
        'invalid_value',
        'Choose a folder inside your home directory or on a mounted volume.'
      )
    }
  },
  /**
   * A path to an executable, not a folder this app writes into, so
   * `assertUsableRoot`'s rules do not apply — but an accepted relative path
   * would be resolved against `process.cwd()`, which for a packaged app is
   * wherever the OS happened to launch it from. Absolute or empty.
   *
   * Whether the file exists and runs is deliberately *not* checked here:
   * `binaryResolver` has to spawn it to find out, and a user pasting a path
   * before installing the binary should be able to save it and be told about
   * the problem by the engine's own status line rather than by a rejected save.
   */
  /**
   * A JSON object of `{ "<path>": true }`, or empty — the agents-home paths the
   * user has had explained to them. Same reasoning as `localDevConsent`: the
   * shape is checked once here rather than defended at every read.
   *
   * `false` is refused rather than accepted and ignored. A refusal is
   * deliberately not recorded (see the schema note), so a `false` in this store
   * could only come from something writing a shape this feature does not have.
   */
  localAgentsHomeAcknowledged: (value) => {
    if (value.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new AppSettingsError('invalid_value', 'The agents-home acknowledgement must be JSON.')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppSettingsError(
        'invalid_value',
        'The agents-home acknowledgement must be an object.'
      )
    }
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (entry !== true) {
        throw new AppSettingsError(
          'invalid_value',
          'The agents-home acknowledgement maps a folder path to true.'
        )
      }
    }
  },
  /**
   * A JSON object of `{ "<host>": boolean }`, or empty. The generic `typeof`
   * gate only proves it is a string, and this value is written by the
   * local-dev consent flow *and* reachable through the generic `settings:set`
   * channel — so the shape is checked here rather than defended at every read.
   */
  localDevConsent: (value) => {
    if (value.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new AppSettingsError('invalid_value', 'Local development consent must be JSON.')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppSettingsError('invalid_value', 'Local development consent must be an object.')
    }
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (typeof entry !== 'boolean') {
        throw new AppSettingsError(
          'invalid_value',
          'Local development consent maps a host to true or false.'
        )
      }
    }
  },

  localAgentsEnginePath: (value) => {
    const trimmed = value.trim()
    if (trimmed === '') return
    if (!isAbsolute(trimmed)) {
      throw new AppSettingsError(
        'invalid_value',
        'The engine path must be an absolute path to the opencode executable.'
      )
    }
  },

  /**
   * A known tool id or empty. Known, not *installed*: the value is read back
   * against the detected list every time, so a tool that was uninstalled after
   * being chosen degrades to "ask" rather than to a rejected setting. An
   * arbitrary string here is what `local-tools:open-in` would otherwise be
   * asked to launch.
   */
  localAgentsDefaultTool: (value) => {
    if (value === '') return
    if (!isLocalToolId(value)) {
      throw new AppSettingsError('invalid_value', 'That is not a tool Cinna knows how to open.')
    }
  }
}

function runValueCheck<K extends AppSettingKey>(key: K, value: AppSettingsSchema[K]): void {
  const check = VALUE_CHECKS[key] as ((v: AppSettingsSchema[K]) => void) | undefined
  check?.(value)
}

export const appSettingsService = {
  getAll(): AppSettingsSchema {
    return appSettingsRepo.getAll()
  },

  set(key: string, value: unknown): void {
    assertKnownKey(key)
    assertValueShape(key, value)
    runValueCheck(key, value)
    appSettingsRepo.set(key, value)
    logger.info('app setting updated', { key, valueType: typeof value })
  }
}
