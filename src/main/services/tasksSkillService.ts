/**
 * The `cinna-tasks` skill: where it is, whether it is there, and the local
 * Claude plugin that carries it into a session.
 *
 * The skill is platform-owned and arrives with the kit bundle through
 * `make kit-sync` (`resources/cinna-agent-kit/skills/cinna-tasks/`): `SKILL.md`
 * and `references/file-protocol.md`. It teaches what a Cinna task is and the
 * `tasks_*` verbs; the system prompt keeps only the two rules that must never
 * be missed and one line saying how to open it (`cinnaTasksSection`), and the
 * turn header names it when it is available.
 *
 * Delivery differs per engine, and this module answers all three:
 *
 * * **Claude** loads it as a skill of a desktop-owned local plugin,
 *   materialised under `<userData>/cinna-plugins/cinna-tasks/` and passed as
 *   `plugins: [{ type: 'local', path }]` in both launch modes
 *   (`acpLaunchers.ts`). Copied, not pointed at: a plugin is a directory with a
 *   `.claude-plugin/plugin.json`, and the bundle is read-only in a package.
 * * **OpenCode** reads the bundle's `skills/` directory through `skills.paths`
 *   in the generated config (`configGenerator.ts`).
 * * **Codex** has no skill loader: its prompt points at `SKILL.md` by absolute
 *   path.
 *
 * Every answer degrades to "not available" rather than throwing: a build
 * whose bundle has no skill yet runs its agents exactly as before, with a
 * prompt that says nothing about a skill it cannot open.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { contractTreeHash } from '../kit/contractTreeHash'
import { swapInto } from '../kit/treeSwap'
import { createLogger } from '../logger/logger'
import type { CinnaTasksSkillDelivery } from '../../shared/handovers'

const logger = createLogger('tasks-skill')

/** The skill's name, its folder name, and the plugin's name. */
export const TASKS_SKILL_NAME = 'cinna-tasks'

/** The skill's entry file inside its folder. */
export const TASKS_SKILL_FILE = 'SKILL.md'

/**
 * A dev-only override of the skill folder, for running against the protocol
 * draft before the bundle carries it. Ignored in a packaged build.
 */
export const TASKS_SKILL_DIR_ENV = 'CINNA_TASKS_SKILL_DIR'

/** Folder of desktop-owned plugins under `userData`. */
const PLUGINS_DIR = 'cinna-plugins'

/** Content hash of the copied skill, beside the plugin it describes. */
const PLUGIN_HASH_FILE = '.cinna-skill-hash'

export interface TasksSkillInfo {
  /** True when `SKILL.md` is present. Everything else is meaningless otherwise. */
  available: boolean
  /** The skill's folder (`…/skills/cinna-tasks`). */
  dir: string
  /** Absolute path of `SKILL.md`. */
  skillFile: string
  /** The folder holding the skill folder — what OpenCode's `skills.paths` takes. */
  skillsRoot: string
  /** `version` from the frontmatter, or null when it has none. */
  version: string | null
}

/** The bundled kit, packaged or in the repo — the same rule as `contractStore`. */
function bundledKitDir(): string {
  return runtimeHost.isPackaged
    ? join(runtimeHost.resourcesPath, 'cinna-agent-kit')
    : join(runtimeHost.getAppPath(), 'resources', 'cinna-agent-kit')
}

/** The skill's folder: the dev override when set (unpackaged only), else the bundle's. */
export function tasksSkillDir(): string {
  const override = process.env[TASKS_SKILL_DIR_ENV]
  if (override && !runtimeHost.isPackaged) return override
  return join(bundledKitDir(), 'skills', TASKS_SKILL_NAME)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** `version:` from a `SKILL.md` frontmatter, quotes stripped; null when absent. */
export function readSkillVersion(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return null
  const line = /^version:\s*(.+?)\s*$/m.exec(match[1])
  if (!line) return null
  const value = line[1].replace(/^(["'])(.*)\1$/, '$2').trim()
  return value === '' ? null : value
}

/** Where the skill is and whether it is there. Never throws. */
export function tasksSkillInfo(): TasksSkillInfo {
  const dir = tasksSkillDir()
  const skillFile = join(dir, TASKS_SKILL_FILE)
  const skillsRoot = join(dir, '..')
  let version: string | null = null
  const available = isFile(skillFile)
  if (available) {
    try {
      version = readSkillVersion(readFileSync(skillFile, 'utf8'))
    } catch {
      /* present but unreadable: still named, without a version */
    }
  }
  return { available, dir, skillFile, skillsRoot, version }
}

/** The turn header's `tasks skill:` value, e.g. `cinna-tasks v1`; null when unavailable. */
export function tasksSkillLabel(info: TasksSkillInfo = tasksSkillInfo()): string | null {
  if (!info.available) return null
  return info.version ? `${TASKS_SKILL_NAME} v${info.version}` : TASKS_SKILL_NAME
}

/** The plugin's folder under `userData`. */
export function tasksSkillPluginDir(): string {
  return join(runtimeHost.getPath('userData'), PLUGINS_DIR, TASKS_SKILL_NAME)
}

/**
 * Materialise the local Claude plugin and return its path, or null when the
 * skill is unavailable or the copy failed.
 *
 * The plugin is rebuilt only when the skill's tree hash differs from the one
 * stored beside it. The new copy is built in a sibling temp folder and swapped
 * in by `swapInto`: the old plugin is parked and put back if the new one
 * cannot be renamed in, so a failed refresh keeps the old plugin, and a
 * session never reads half of either.
 */
export function ensureTasksSkillPlugin(info: TasksSkillInfo = tasksSkillInfo()): string | null {
  if (!info.available) return null
  const target = tasksSkillPluginDir()
  try {
    const { hash } = contractTreeHash(info.dir)
    const hashFile = join(target, PLUGIN_HASH_FILE)
    if (existsSync(hashFile) && readFileSync(hashFile, 'utf8').trim() === hash) return target

    const staging = `${target}.tmp-${process.pid}-${Date.now()}`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(staging, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({
        name: TASKS_SKILL_NAME,
        description: 'Cinna tasks — shared work items on the cinna tool server. Provided by Cinna Desktop.',
        version: '1'
      }, null, 2)}\n`
    )
    cpSync(info.dir, join(staging, 'skills', TASKS_SKILL_NAME), { recursive: true })
    writeFileSync(join(staging, PLUGIN_HASH_FILE), `${hash}\n`)
    swapInto(staging, target)
    logger.info('tasks skill plugin refreshed', { target, hash })
    return target
  } catch (error) {
    logger.warn('the tasks skill plugin could not be written', {
      target,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

/**
 * How a system prompt should tell the agent to open the skill: `skill` when
 * the engine loads it by itself (Claude through the plugin, OpenCode through
 * `skills.paths`), `pointer` with the absolute `SKILL.md` path otherwise, or
 * null when there is no skill to open.
 */
export type TasksSkillDelivery = CinnaTasksSkillDelivery

/** The engines a folder agent runs on. */
export type TasksSkillEngine = 'claude' | 'codex' | 'opencode'

export function tasksSkillDeliveryFor(
  engine: TasksSkillEngine,
  info: TasksSkillInfo = tasksSkillInfo()
): TasksSkillDelivery | null {
  if (!info.available) return null
  return engine === 'codex' ? { kind: 'pointer', path: info.skillFile } : { kind: 'skill' }
}
