/**
 * The A2A golden tests' second expectation: what a turn **did**, beside what it
 * emitted.
 *
 * `expectGolden` compares `{ events, result }` and nothing else, and two things
 * an A2A turn does never show up there: what it sent the agent (the remembered
 * `contextId`/`taskId`, `cinna_file_ids`, the bearer) and what it handed the
 * session store. Those are exactly what phase 2 moves behind a driver, so each
 * scenario pins them in `<scenario>.effects.expected.json` beside its
 * `<scenario>.expected.json`, through the harness's `expectGoldenSidecar` —
 * the same file rules the OpenCode and Claude goldens use.
 */

import { expectGoldenSidecar, type NormaliseOptions } from '../harness'
import type { RecordedRequest, SessionPatch, SessionRow } from './fakeAgent'

export interface A2aEffects {
  /** Every HTTP request the turn made, in order. */
  requests: RecordedRequest[]
  /** What `a2aSessionRepo.getByChatAndAgent` returned, per call. */
  sessionReads: (SessionRow | null)[]
  /** Every patch handed to `a2aSessionRepo.upsert`, verbatim. */
  sessionUpserts: SessionPatch[]
  /** Every id `onTaskId` surfaced, in order — what a cancel would target. */
  taskIdsSurfaced: string[]
  /** How many times `onClient` fired. */
  clientsSurfaced: number
}

/** Compare a turn's effects with `<scenario>.effects.expected.json`. */
export function expectEffects(
  scenario: string,
  effects: A2aEffects,
  options: NormaliseOptions = {}
): void {
  expectGoldenSidecar('a2a', scenario, 'effects', effects, options)
}
