/**
 * The `cinna-artifacts` skill: where it is, whether an agent should get it,
 * and the local Claude plugin that carries it.
 *
 * Platform-owned, it arrives with the kit bundle (`make kit-sync`,
 * `resources/cinna-agent-kit/skills/cinna-artifacts/`). It is delivered the
 * way `cinna-tasks` is (`tasksSkillService`) — Claude through a desktop-owned
 * plugin, OpenCode through `skills.paths`, Codex and Antigravity's native
 * branch by a pointer in the prompt, an isolated Antigravity home by a copy —
 * but **only while the active profile's instance keeps artifacts**: an agent
 * never reads about a tool it is not offered. The gate is installed by the
 * artifact service (`installArtifactsSkillGate`), so this module stays free of
 * the network and the database; with no gate installed it is closed.
 *
 * Every answer degrades to "not delivered" rather than throwing.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeHost } from '../../host/runtimeHost'
import { contractTreeHash } from '../../kit/contractTreeHash'
import { getLayout } from '../../kit/contractStore'
import { swapInto } from '../../kit/treeSwap'
import { createLogger } from '../../logger/logger'
import type { TasksSkillEngine } from '../tasksSkillService'

const logger = createLogger('artifacts-skill')

export const ARTIFACTS_SKILL_NAME = 'cinna-artifacts'
const SKILL_FILE = 'SKILL.md'
const PLUGINS_DIR = 'cinna-plugins'
const PLUGIN_HASH_FILE = '.cinna-skill-hash'

let gate: () => boolean = () => false

/** Whether the active profile may be told about artifacts. Installed by `artifactService`. */
export function installArtifactsSkillGate(next: () => boolean): void {
  gate = next
}

export interface ArtifactsSkillInfo {
  /** Present in this build and the active profile's instance keeps artifacts. */
  available: boolean
  dir: string
  skillFile: string
}

function bundledKitDir(): string {
  return runtimeHost.isPackaged
    ? join(runtimeHost.resourcesPath, 'cinna-agent-kit')
    : join(runtimeHost.getAppPath(), 'resources', 'cinna-agent-kit')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Where the skill is, and whether an agent gets it now. Never throws. */
export function artifactsSkillInfo(): ArtifactsSkillInfo {
  const dir = join(bundledKitDir(), 'skills', ARTIFACTS_SKILL_NAME)
  const skillFile = join(dir, SKILL_FILE)
  let open = false
  try {
    open = gate()
  } catch {
    open = false
  }
  return { available: open && isFile(skillFile), dir, skillFile }
}

/** The skill as a session's prompt names it: `skill` where the engine loads it, else a `SKILL.md` pointer. */
export type ArtifactsSkillDelivery = { kind: 'skill' } | { kind: 'pointer'; path: string }

export function artifactsSkillDeliveryFor(engine: TasksSkillEngine, info: ArtifactsSkillInfo = artifactsSkillInfo()): ArtifactsSkillDelivery | null {
  if (!info.available) return null
  return engine === 'codex' || engine === 'antigravity' ? { kind: 'pointer', path: info.skillFile } : { kind: 'skill' }
}

/**
 * Where a kit agent builds what it publishes: the bundled layout's `artifacts`
 * role (contract 1.13.0+), runtime-only like `app-data/`. Null under an older
 * contract, whose layout has no such folder — the prompt then names none,
 * rather than inventing a folder that would travel with a shared agent.
 */
export function artifactsFolderRole(): string | null {
  try {
    const role = getLayout().agent.roles.find((entry) => entry.role === 'artifacts' && entry.kind === 'directory')
    return role ? role.path.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

/** The prompt's lines about the skill, or none. */
export function cinnaArtifactsSection(delivery: ArtifactsSkillDelivery | null): string[] {
  if (!delivery) return []
  const open = delivery.kind === 'skill'
    ? 'Open the `cinna-artifacts` skill before your first `artifacts_publish` call or before building a page meant to be published.'
    : `Read \`${delivery.path}\` before your first \`artifacts_publish\` call or before building a page meant to be published.`
  return [
    [
      '## Cinna artifacts',
      '',
      'To give your owner a report, a set of files or a small dashboard they open in Cinna, publish it with `artifacts_publish` on the `cinna` tool server. Publishing does not wait for them: a new artifact is private to them, and publishing the same path again updates it for whoever they already shared it with. Only they share it.',
      open
    ].join('\n')
  ]
}

function pluginDir(): string {
  return join(runtimeHost.getPath('userData'), PLUGINS_DIR, ARTIFACTS_SKILL_NAME)
}

/**
 * The local Claude plugin carrying the skill, or null when it is not to be
 * delivered or the copy failed. Rebuilt only when the skill's tree hash
 * changes, swapped in whole (`swapInto`) as the `cinna-tasks` plugin is.
 */
export function ensureArtifactsSkillPlugin(info: ArtifactsSkillInfo = artifactsSkillInfo()): string | null {
  if (!info.available) return null
  const target = pluginDir()
  try {
    const { hash } = contractTreeHash(info.dir)
    const hashFile = join(target, PLUGIN_HASH_FILE)
    if (existsSync(hashFile) && readFileSync(hashFile, 'utf8').trim() === hash) return target
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(staging, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: ARTIFACTS_SKILL_NAME, description: 'Cinna artifacts — publish files as a page in Cinna. Provided by Cinna Desktop.', version: '1' }, null, 2)}\n`
    )
    cpSync(info.dir, join(staging, 'skills', ARTIFACTS_SKILL_NAME), { recursive: true })
    writeFileSync(join(staging, PLUGIN_HASH_FILE), `${hash}\n`)
    swapInto(staging, target)
    logger.info('artifacts skill plugin refreshed', { target, hash })
    return target
  } catch (error) {
    logger.warn('the artifacts skill plugin could not be written', { target, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
