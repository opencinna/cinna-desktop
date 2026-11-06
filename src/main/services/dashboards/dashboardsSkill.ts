/**
 * The `cinna-dashboards` skill: where it is, how each engine gets it, the
 * local Claude plugin that carries it, and the prompt's lines about it.
 *
 * Platform-owned, it arrives with the kit bundle (`make kit-sync`,
 * `resources/cinna-agent-kit/skills/cinna-dashboards/`, with its
 * `scripts/check_component.py`). It is delivered the way `cinna-artifacts` is
 * (`artifactsSkill.ts`) — Claude through a desktop-owned plugin, OpenCode
 * through `skills.paths`, Codex and Antigravity's native branch by a pointer
 * in the prompt, an isolated Antigravity home by a copy — with one difference:
 * dashboards are a desktop feature, so there is **no profile gate**. Every kit
 * agent on this computer gets it; a bare folder (no `cinna-agent.json`) never
 * does, since it has no `dashboards/` to build in. The caller decides which
 * agent is a kit agent; this module only knows the skill.
 *
 * The check script is named by absolute path in the prompt because the skill
 * folder is the desktop's own copy: the agents root's `.cinna-kit/` may be one
 * the user downloaded, a version behind (README §5.5, "The check script").
 *
 * Every answer degrades to "not delivered" rather than throwing.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { runtimeHost } from '../../host/runtimeHost'
import { contractTreeHash } from '../../kit/contractTreeHash'
import { swapInto } from '../../kit/treeSwap'
import { createLogger } from '../../logger/logger'
import { ownReferencePrefix } from '../../../shared/componentReference'
import type { CinnaAgentManifest } from '../../../shared/kit/manifest'
import type { TasksSkillEngine } from '../tasksSkillService'
import type { DashboardDesignGuide } from './designPack'

const logger = createLogger('dashboards-skill')

export const DASHBOARDS_SKILL_NAME = 'cinna-dashboards'
const SKILL_FILE = 'SKILL.md'
const CHECK_SCRIPT = ['scripts', 'check_component.py'] as const
const PLUGINS_DIR = 'cinna-plugins'
const PLUGIN_HASH_FILE = '.cinna-skill-hash'
/** A skill's own components live here, one folder each with a `component.json` (D15). */
const SKILL_DASHBOARDS_DIR = 'dashboards'
const COMPONENT_FILE = 'component.json'

export interface DashboardsSkillInfo {
  /** Present in this build (the bundle carries the skill's `SKILL.md`). */
  available: boolean
  dir: string
  skillFile: string
  /** The bundled `check_component.py`, absolute. */
  checkScript: string
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

/** Where the skill is, and whether this build has it. Never throws. */
export function dashboardsSkillInfo(): DashboardsSkillInfo {
  try {
    const dir = join(bundledKitDir(), 'skills', DASHBOARDS_SKILL_NAME)
    const skillFile = join(dir, SKILL_FILE)
    return { available: isFile(skillFile), dir, skillFile, checkScript: join(dir, ...CHECK_SCRIPT) }
  } catch {
    return { available: false, dir: '', skillFile: '', checkScript: '' }
  }
}

/** How a session's prompt names the skill: `skill` where the engine loads it, else a `SKILL.md` pointer. */
export type DashboardsSkillDelivery = { kind: 'skill' } | { kind: 'pointer'; path: string }

export function dashboardsSkillDeliveryFor(engine: TasksSkillEngine, info: DashboardsSkillInfo = dashboardsSkillInfo()): DashboardsSkillDelivery | null {
  if (!info.available) return null
  return engine === 'codex' || engine === 'antigravity' ? { kind: 'pointer', path: info.skillFile } : { kind: 'skill' }
}

/** What the prompt section needs: how the skill opens, the check script and the agent's own reference prefix. */
export interface DashboardsPromptInput {
  delivery: DashboardsSkillDelivery
  checkScript: string
  referencePrefix: string
  /** The desktop's design pack guide and example (`designPack.ts`), when this build has them. */
  design?: DashboardDesignGuide | null
}

/**
 * The agent's bundle id: the manifest's `bundle.bundle_id` (a tree exported
 * from a cloud bundle), else `app-data/desktop.json` `shared_remote.bundle_id`
 * (a team agent on this machine); the manifest wins (README §5.5). Null when
 * neither has one.
 */
export function agentBundleId(manifest: CinnaAgentManifest, sharedRemoteBundleId: string | null | undefined): string | null {
  const bundle = (manifest as Record<string, unknown>).bundle
  const fromManifest = bundle && typeof bundle === 'object' ? (bundle as Record<string, unknown>).bundle_id : null
  if (typeof fromManifest === 'string' && fromManifest.trim() !== '') return fromManifest.trim()
  return typeof sharedRemoteBundleId === 'string' && sharedRemoteBundleId.trim() !== '' ? sharedRemoteBundleId.trim() : null
}

/** The agent's own reference prefix, or null for a manifest with no id (nothing could resolve it). */
export function agentReferencePrefix(manifest: CinnaAgentManifest, sharedRemoteBundleId: string | null | undefined): string | null {
  const id = typeof manifest.id === 'string' ? manifest.id.trim() : ''
  const bundleId = agentBundleId(manifest, sharedRemoteBundleId)
  if (!id && !bundleId) return null
  return ownReferencePrefix(id, bundleId)
}

/** Quoted for a POSIX or Windows shell when the path has a space or a quote; as is otherwise. */
function quotedPath(path: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * The prompt's lines about the skill, or none. Short on purpose: `SKILL.md`
 * carries the how; the prompt carries what only the desktop knows — where the
 * check script is and which reference form this agent prints.
 */
export function cinnaDashboardsSection(input: DashboardsPromptInput | null): string[] {
  if (!input) return []
  const open = input.delivery.kind === 'skill'
    ? 'Open the `cinna-dashboards` skill before you build or change anything under `dashboards/`.'
    : `Read \`${input.delivery.path}\` before you build or change anything under \`dashboards/\`.`
  return [
    [
      '## Cinna dashboards',
      '',
      'When your owner wants to watch something over time, build a dashboard component under `dashboards/<name>/` and offer it by printing its reference on a line of its own.',
      open,
      // Ahead of the rest, and worded as a replacement: the skill names the kit's
      // own `templates/dashboard-html/`, and a softer line lost to it on OpenCode.
      ...(input.design
        ? [`- **An \`html\` view in Cinna Desktop uses the desktop's design pack, not the kit's \`templates/dashboard-html/\`.** Before you build or change one, read \`${input.design.guide}\`. Start from \`${input.design.example}\` (copy it to \`dashboards/<name>/\`), link \`_cinna/ui.css\` and \`_cinna/charts.js\` (Cinna Desktop serves them to the page), draw charts with \`CinnaCharts\`, and colour only with \`var(--cinna-*)\` — no hex, \`rgb()\` or \`hsl()\`.`]
        : []),
      `- Before you print a reference, check the component from this folder: \`uv run python ${quotedPath(input.checkScript)} dashboards/<name>\`, and fix everything it prints.`,
      `- Your references start with \`${input.referencePrefix}\`, for example \`${input.referencePrefix}<name>\`.`
    ].join('\n')
  ]
}

function pluginDir(): string {
  return join(runtimeHost.getPath('userData'), PLUGINS_DIR, DASHBOARDS_SKILL_NAME)
}

/**
 * The local Claude plugin carrying the skill, or null when this build has no
 * skill or the copy failed. Rebuilt only when the skill's tree hash changes,
 * swapped in whole (`swapInto`) as the artifacts plugin is.
 */
export function ensureDashboardsSkillPlugin(info: DashboardsSkillInfo = dashboardsSkillInfo()): string | null {
  if (!info.available) return null
  let target = ''
  try {
    target = pluginDir()
    const { hash } = contractTreeHash(info.dir)
    const hashFile = join(target, PLUGIN_HASH_FILE)
    if (existsSync(hashFile) && readFileSync(hashFile, 'utf8').trim() === hash) return target
    const staging = `${target}.tmp-${process.pid}-${Date.now()}`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(staging, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: DASHBOARDS_SKILL_NAME, description: 'Cinna dashboards — build live dashboard components. Provided by Cinna Desktop.', version: '1' }, null, 2)}\n`
    )
    cpSync(info.dir, join(staging, 'skills', DASHBOARDS_SKILL_NAME), { recursive: true })
    writeFileSync(join(staging, PLUGIN_HASH_FILE), `${hash}\n`)
    swapInto(staging, target)
    logger.info('dashboards skill plugin refreshed', { target, hash })
    return target
  } catch (error) {
    logger.warn('the dashboards skill plugin could not be written', { target, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * How many dashboard components a skill folder ships: the folders under its
 * `dashboards/` that hold a `component.json`. Zero for a folder with none, or
 * one that cannot be read. Validity is not judged here (the scanner does).
 */
export function skillDashboardComponentCount(skillDir: string): number {
  try {
    const entries: Dirent[] = readdirSync(join(skillDir, SKILL_DASHBOARDS_DIR), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && isFile(join(skillDir, SKILL_DASHBOARDS_DIR, entry.name, COMPONENT_FILE))).length
  } catch {
    return 0
  }
}
