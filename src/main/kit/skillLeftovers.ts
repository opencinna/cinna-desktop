/**
 * What a crash in the middle of Get Version N or Edit skill can leave in an
 * agent's `skills/`: the folder moved aside as `.<name>.cinna-previous-<pid>-<ms>`
 * with no `skills/<name>/` in its place, and a staged copy
 * `.<name>.cinna-staging-<pid>-<ms>` that was never renamed. Both are
 * dot-names the skills scan skips, so the person's skill would simply be gone.
 *
 * {@link recoverSkillLeftovers} puts the newest set-aside folder back where
 * `skills/<name>/` is missing, and removes staged copies older than
 * {@link STALE_STAGING_MS}. A set-aside folder that is not put back — one
 * beside a `skills/<name>/` that exists (a crash after the swap, before the
 * cleanup), or an older one beside the newest — is moved out of the agent to
 * `backupFor`'s folder when one is given, never deleted: it may hold the only
 * copy of edits. Left in place, it would come back as the skill the day the
 * person removed `skills/<name>/` on purpose.
 *
 * Run at the start of Get Version N and Edit skill for the agent they act
 * on, and once per app start over every folder agent
 * (`skillPublishService.recoverLeftovers`, beside the caches' garbage
 * collection in `hub/core.ts`).
 *
 * Core: no Electron; files only. Never throws.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../logger/logger'

const logger = createLogger('skill-leftovers')

/** A staged copy younger than this may belong to a verb still running (another app instance). */
export const STALE_STAGING_MS = 10 * 60 * 1000

const LEFTOVER_RE = /^\.(.+)\.cinna-(previous|staging)-(\d+)-(\d+)$/

export interface SkillLeftoverSweep {
  /** Skill names whose folder was put back from a set-aside copy. */
  restored: string[]
  /** Set-aside copies moved out of the agent, to where `backupFor` named. */
  movedOut: string[]
  /** Stale staged copies removed. */
  removed: number
}

function stampOf(dir: string, tagged: number): number {
  if (Number.isFinite(tagged) && tagged > 0) return tagged
  try {
    return lstatSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Recover the leftovers in `<agentDir>/skills/` — of the skill `name` only,
 * when given. Returns what it did; failures are skipped (a later run retries).
 */
export function recoverSkillLeftovers(
  agentDir: string,
  name?: string,
  now: number = Date.now(),
  backupFor?: (skill: string, at: number) => string
): SkillLeftoverSweep {
  const result: SkillLeftoverSweep = { restored: [], movedOut: [], removed: 0 }
  const skillsDir = join(agentDir, 'skills')
  let entries: Dirent[]
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return result
  }
  const previous = new Map<string, { path: string; at: number }[]>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = LEFTOVER_RE.exec(entry.name)
    if (!match) continue
    const [, skill, kind, , ms] = match
    if (name !== undefined && skill !== name) continue
    const path = join(skillsDir, entry.name)
    const at = stampOf(path, Number(ms))
    if (kind === 'staging') {
      if (now - at < STALE_STAGING_MS) continue
      try {
        rmSync(path, { recursive: true, force: true })
        result.removed += 1
      } catch {
        /* retried on the next run */
      }
      continue
    }
    const list = previous.get(skill) ?? []
    list.push({ path, at })
    previous.set(skill, list)
  }
  for (const [skill, list] of previous) {
    const target = join(skillsDir, skill)
    const sorted = list.sort((a, b) => b.at - a.at)
    let rest = sorted
    if (!existsSync(target)) {
      try {
        renameSync(sorted[0].path, target)
        result.restored.push(skill)
        rest = sorted.slice(1)
      } catch {
        /* retried on the next run */
        continue
      }
    }
    if (!backupFor) continue
    for (const leftover of rest) {
      const to = backupFor(skill, leftover.at)
      if (moveOut(leftover.path, to)) result.movedOut.push(to)
    }
  }
  return result
}

/** Move `from` to `to` (which must not exist), across volumes by copy then remove. False when it stayed. */
function moveOut(from: string, to: string): boolean {
  try {
    if (existsSync(to)) return false
    mkdirSync(dirname(to), { recursive: true })
    try {
      renameSync(from, to)
    } catch {
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true })
      rmSync(from, { recursive: true, force: true })
    }
    return true
  } catch {
    return false
  }
}

/** {@link recoverSkillLeftovers}, logging what it put back or removed. */
export function sweepSkillLeftovers(agentDir: string, name?: string, backupFor?: (skill: string, at: number) => string): SkillLeftoverSweep {
  const swept = recoverSkillLeftovers(agentDir, name, Date.now(), backupFor)
  if (swept.restored.length > 0) logger.warn('skill folders put back after an interrupted swap', { agentDir, skills: swept.restored })
  if (swept.movedOut.length > 0) logger.warn('set-aside skill folders moved out of the agent', { agentDir, to: swept.movedOut })
  if (swept.removed > 0) logger.info('stale staged skill copies removed', { agentDir, removed: swept.removed })
  return swept
}
