/**
 * Shared plumbing for the golden-stream tests — phase 0 of the agent runtime
 * plan (`drafts/agent_runtime/phase_0_characterization.md`).
 *
 * A golden test drives one runner with one recorded input and compares the
 * **whole sequence** it emitted — every `onEvent` call in order, plus the
 * returned `RunAgentTurnResult` — against an expectation file on disk.
 *
 * ## Why an expectation file and not a Vitest snapshot
 *
 * A snapshot updates itself with `-u`, and a refactor that changes the stream
 * is exactly the moment someone reaches for `-u`. An expectation file is only
 * ever changed by a person editing it (or deleting it and regenerating), so a
 * difference in the diff is a decision somebody made. Phase 1 rewrites these
 * files mechanically into the new vocabulary; anything the mapping cannot
 * explain is a regression.
 *
 * ## Layout
 *
 * ```
 * __golden__/<runner>/<scenario>.fixture.json    the recorded input
 * __golden__/<runner>/<scenario>.expected.json   { _notes?, events, result }
 * ```
 *
 * A fixture recorded from a real binary carries a top-level
 * `"recorded_from": "<binary> <version>"`; one lifted from an inline test
 * fixture carries `"recorded_from": "hand-written"`.
 *
 * `_notes` in an expectation is free text for the reader and is **not
 * compared** — use it to say why a surprising event is pinned as-is.
 *
 * `_phase1_note`, `_phase2_note` — any `_phase<N>_note` — is the same kind of
 * key, and is not compared either. A later phase leaves every `_notes` entry
 * exactly as an earlier one wrote it, so where one stopped being true — the
 * stream now says something a note says it does not — the correction goes
 * here, beside the note it corrects. A fixture is never compared, so a stale
 * sentence in one gets the same sibling key without the harness needing to
 * know.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { RunEvent } from '../../../../shared/runEvents'
import type { RunAgentTurnResult } from '../../../services/a2aStreamingService'

export type GoldenRunner = 'a2a' | 'opencode' | 'claude'

/** What one golden run produced. */
export interface GoldenCapture {
  events: RunEvent[]
  result: RunAgentTurnResult
}

/** An expectation file: the capture itself, plus notes that are never compared. */
type Expectation = { _notes?: string[] } & Record<string, unknown>

/** Keys a reader writes for the next reader: `_notes`, `_phase1_note`, `_phase2_note`, … */
const NOTE_KEY = /^_(?:notes|phase\d+_note)$/

const ROOT = dirname(fileURLToPath(import.meta.url))

const fixturePath = (runner: GoldenRunner, scenario: string): string =>
  join(ROOT, runner, `${scenario}.fixture.json`)
const expectedPath = (runner: GoldenRunner, scenario: string): string =>
  join(ROOT, runner, `${scenario}.expected.json`)

/**
 * Every scenario that has a fixture on disk for this runner, sorted.
 *
 * A golden file lists its scenarios by hand, so a fixture added without its
 * name would otherwise never run — and a characterization that silently does
 * not execute is worse than none. Each golden file asserts its list against this.
 */
export function listScenarios(runner: GoldenRunner): string[] {
  const dir = join(ROOT, runner)
  if (!existsSync(dir)) return []
  const names: Dirent[] = readdirSync(dir, { withFileTypes: true })
  return names
    .filter((d) => d.isFile() && d.name.endsWith('.fixture.json'))
    .map((d) => d.name.slice(0, -'.fixture.json'.length))
    .sort()
}

/** Load a recorded input. Throws with the path when it is missing. */
export function readFixture<T = unknown>(runner: GoldenRunner, scenario: string): T {
  const path = fixturePath(runner, scenario)
  if (!existsSync(path)) throw new Error(`golden fixture missing: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Keys whose values are wall-clock and must never be compared. */
const TIME_KEYS = new Set([
  'ts',
  'time',
  'timestamp',
  'createdAt',
  'updatedAt',
  'startedAt',
  'endedAt',
  'completedAt'
])

/**
 * A UUID, for a runner that mints them — pass it in `ids` explicitly.
 *
 * Not applied by default: placeholders number by first appearance, so two
 * fixture UUIDs that swapped places, or a `contextId` replaced by another,
 * would normalise to the same JSON. Only ids the code *generates* belong in
 * `ids`; an id that came from the fixture must be compared verbatim.
 */
export const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

export interface NormaliseOptions {
  /**
   * Patterns for ids the runner generates itself (nanoid, minted request ids).
   * Each distinct match becomes `<label#n>` in order of first appearance, so
   * two fields that carried the same id still carry the same placeholder —
   * which is what lets a `tool_result` still be seen to answer its `tool_use`.
   * Never list a pattern that also matches ids taken from the fixture.
   */
  ids?: { label: string; pattern: RegExp }[]
  /** Extra keys whose values are wall-clock. */
  timeKeys?: string[]
}

/**
 * Replace wall-clock values and generated ids with stable placeholders.
 *
 * Deterministic and order-preserving: the same capture always normalises to
 * the same JSON. `undefined` fields are dropped, because that is what a JSON
 * round trip does and the expectation lives on disk as JSON.
 */
export function normalise<T>(value: T, options: NormaliseOptions = {}): T {
  const timeKeys = new Set([...TIME_KEYS, ...(options.timeKeys ?? [])])
  const patterns = options.ids ?? []
  const seen = new Map<string, string>()
  const counters = new Map<string, number>()

  const replaceIds = (s: string): string => {
    let out = s
    for (const { label, pattern } of patterns) {
      const global = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g')
      out = out.replace(global, (match) => {
        const key = `${label}:${match}`
        let placeholder = seen.get(key)
        if (!placeholder) {
          const n = (counters.get(label) ?? 0) + 1
          counters.set(label, n)
          placeholder = `<${label}#${n}>`
          seen.set(key, placeholder)
        }
        return placeholder
      })
    }
    return out
  }

  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && timeKeys.has(key) && (typeof v === 'number' || typeof v === 'string')) {
      return '<time>'
    }
    if (typeof v === 'string') return replaceIds(v)
    if (Array.isArray(v)) return v.map((item) => walk(item))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(v)) {
        if (child === undefined) continue
        out[k] = walk(child, k)
      }
      return out
    }
    return v
  }

  return walk(value) as T
}

/**
 * Compare a capture with its expectation file.
 *
 * With `GOLDEN_WRITE=1` a **missing** expectation is written from the capture
 * and the test fails with the path, so a first run can never pass silently.
 * An existing file is never overwritten: to change one, edit it, or delete it
 * and regenerate — and review what came out.
 */
export function expectGolden(
  runner: GoldenRunner,
  scenario: string,
  capture: GoldenCapture,
  options: NormaliseOptions = {}
): void {
  const actual = normalise(JSON.parse(JSON.stringify(capture)) as GoldenCapture, options)
  compareWithFile(expectedPath(runner, scenario), { events: actual.events, result: actual.result })
}

/**
 * Compare a second capture of the same scenario with
 * `<scenario>.<name>.expected.json`.
 *
 * For the half of a runner's behaviour that never reaches `onEvent`: the
 * replies an engine runner posts over HTTP, what a permission callback returned
 * to an SDK, what reached `saveSession`. Phase 1 rewrites the event vocabulary
 * and should leave these files alone; phase 3 replaces the transports and is
 * expected to rewrite them. Same rules as {@link expectGolden}.
 */
export function expectGoldenSidecar(
  runner: GoldenRunner,
  scenario: string,
  name: string,
  capture: object,
  options: NormaliseOptions = {}
): void {
  const actual = normalise(JSON.parse(JSON.stringify(capture)) as Record<string, unknown>, options)
  compareWithFile(join(ROOT, runner, `${scenario}.${name}.expected.json`), actual)
}

function compareWithFile(path: string, actual: Record<string, unknown>): void {
  if (!existsSync(path)) {
    if (process.env.GOLDEN_WRITE === '1') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(actual, null, 2) + '\n')
      throw new Error(`golden expectation written, review it and re-run: ${path}`)
    }
    throw new Error(`golden expectation missing (run with GOLDEN_WRITE=1 to create it): ${path}`)
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Expectation
  const expected = Object.fromEntries(Object.entries(parsed).filter(([key]) => !NOTE_KEY.test(key)))
  expect(actual).toEqual(expected)
}
