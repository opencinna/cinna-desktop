/**
 * A tile's params and its effective refresh rule (README D4).
 *
 * - **Params** are validated against the component's `params` specs: `enum`
 *   one of `values`, `month` `YYYY-MM` or `current`, `date` `YYYY-MM-DD` or
 *   `today`, `date_range` `{from, to}` (dates or "" for an open end, from ≤ to), `number`,
 *   `boolean`, `text` up to 200 characters. A bad value refuses the whole
 *   change with a sentence naming the param.
 * - **The effective rule** is the component's `refresh` with the tile's
 *   override over it, field by field; every place the policy reads a rule
 *   reads this one.
 *
 * Core module: no Electron.
 */

import { MIN_WHILE_OPEN_EVERY_MS, PARAM_NAME_PATTERN } from '../../kit/dashboardsProtocol'
import { DEFAULT_MAX_AGE, parseDuration, type ComponentParamSpec, type TileRefreshOverride } from '../../../shared/dashboards'
import type { ComponentSpec } from './componentScanner'

/** A `text` param's value is at most this long. */
export const MAX_TEXT_PARAM_LENGTH = 200

/** A `tools/call`'s arguments, as JSON, are at most this large. */
export const MAX_CALL_PARAMS_BYTES = 64 * 1024

const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** One value checked against its spec: the value to keep, or the sentence that refuses it. */
export function checkParamValue(name: string, spec: ComponentParamSpec, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const label = spec.label ?? name
  const refuse = (rule: string) => ({ ok: false as const, message: `${label} ${rule}.` })
  switch (spec.type) {
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value) ? { ok: true, value } : refuse(`must be one of ${(spec.values ?? []).join(', ')}`)
    case 'month':
      return value === 'current' || (typeof value === 'string' && MONTH_RE.test(value)) ? { ok: true, value } : refuse('must be a month (YYYY-MM) or current')
    case 'date':
      return value === 'today' || (typeof value === 'string' && DATE_RE.test(value)) ? { ok: true, value } : refuse('must be a date (YYYY-MM-DD) or today')
    case 'date_range': {
      // Either end may be "": the range is open on that side.
      const end = (v: unknown) => typeof v === 'string' && (v === '' || DATE_RE.test(v))
      if (!isRecord(value) || !end(value.from) || !end(value.to)) {
        return refuse('must be a range {from, to} of dates (YYYY-MM-DD, or empty for an open end)')
      }
      if (value.from && value.to && (value.from as string) > (value.to as string)) return refuse('must start on or before its end')
      return { ok: true, value: { from: value.from, to: value.to } }
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : refuse('must be a number')
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : refuse('must be true or false')
    case 'text':
      return typeof value === 'string' && value.length <= MAX_TEXT_PARAM_LENGTH ? { ok: true, value } : refuse(`must be text of at most ${MAX_TEXT_PARAM_LENGTH} characters`)
    default:
      return refuse('has a type this version does not know')
  }
}

/**
 * The params a tile keeps after `input`, which is the whole set (the native
 * filter sends the tile's stored params with one value changed, a cleared
 * field's key left out; the page's `setParams` sends its set): a key left out
 * or `null` has no value, so its default applies. Names the component does
 * not declare are dropped. Defaults are never written in, so a `current`
 * month stays the word.
 */
export function normalizeTileParams(
  input: unknown,
  specs: Record<string, ComponentParamSpec>
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: 'No params to set.' }
  const next: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(input)) {
    const spec = Object.prototype.hasOwnProperty.call(specs, name) ? specs[name] : undefined
    if (!spec || value === null || value === undefined) continue
    const checked = checkParamValue(name, spec, value)
    if (!checked.ok) return checked
    next[name] = checked.value
  }
  return { ok: true, params: next }
}

/**
 * A `tools/call`'s arguments: a value for a declared param is checked like a
 * tile's; any other key is the endpoint's own drill-down argument (the
 * schema lets an endpoint take params the tile has no control for — its
 * `endpoints[].description` names them, as `deal_history` takes `deal_id`)
 * and passes through when its name is a param name. The whole is capped.
 */
export function checkCallParams(
  input: unknown,
  specs: Record<string, ComponentParamSpec>
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, params: {} }
  if (!isRecord(input)) return { ok: false, message: 'The call’s params must be an object.' }
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(input) ?? '')
  } catch {
    return { ok: false, message: 'The call’s params are not JSON.' }
  }
  if (size > MAX_CALL_PARAMS_BYTES) return { ok: false, message: 'The call’s params are too large (over 64 KB).' }
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!PARAM_NAME_PATTERN.test(name)) return { ok: false, message: `“${name.slice(0, 40)}” is not a param name (letters, digits and _ only).` }
    const spec = Object.prototype.hasOwnProperty.call(specs, name) ? specs[name] : undefined
    if (spec && value !== null) {
      const checked = checkParamValue(name, spec, value)
      if (!checked.ok) return checked
      out[name] = checked.value
    } else out[name] = value
  }
  return { ok: true, params: out }
}

/** A component's refresh rule with a tile's override over it: what the policy reads. */
export interface EffectiveRefresh {
  maxAgeMs: number
  manual: boolean
  /** Null: no interval. */
  whileOpenEveryMs: number | null
  afterTurn: boolean
  onAppStart: boolean
  command: string | null
  schedule: string | null
}

const DEFAULT_MAX_AGE_MS = parseDuration(DEFAULT_MAX_AGE) ?? 15 * 60_000

export function effectiveRefresh(spec: ComponentSpec | null | undefined, override: TileRefreshOverride | null | undefined): EffectiveRefresh {
  const every = override?.whileOpenEvery !== undefined ? override.whileOpenEvery : (spec?.whileOpenEvery ?? null)
  const everyMs = every === null ? null : parseDuration(every)
  return {
    maxAgeMs: parseDuration(override?.maxAge) ?? spec?.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    manual: override?.manual === true,
    whileOpenEveryMs: everyMs !== null && everyMs >= MIN_WHILE_OPEN_EVERY_MS ? everyMs : null,
    afterTurn: override?.afterTurn ?? spec?.afterTurn ?? false,
    onAppStart: override?.onAppStart ?? spec?.onAppStart ?? false,
    command: spec?.refreshCommand ?? null,
    schedule: spec?.schedule ?? null
  }
}
