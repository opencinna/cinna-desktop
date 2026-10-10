/**
 * The local Claude plugin that carries a kit agent's own skills into its
 * sealed (`settingSources: []`) session.
 *
 * Built like the `cinna-tasks` plugin (`tasksSkillService.ensureTasksSkillPlugin`)
 * and passed beside it in the same `plugins` array, with one difference that
 * matters: **the skills are symlinked, not copied**. Each
 * `skills/<name>` inside the plugin is a link to the agent's real
 * `skills/<name>/`, so an edit to a `SKILL.md` reaches the next turn with no
 * rebuild, and the plugin is rebuilt only when the *set* of skills changes.
 * A pinned catalog skill whose revision is cached is linked the same way, to
 * its read-only folder in the shared cache (`catalogSkillCache.ts`), so a
 * re-pin to another revision is a changed link and a rebuild.
 *
 * What was proven on Claude Code 2.1.276 / adapter 0.76.0, and why the shape
 * is what it is:
 *
 * * Two local plugins in one `plugins` array both load, isolated and native.
 * * A per-skill symlink under the plugin's `skills/` is listed and invocable
 *   as `<plugin>:<folder>` — the **folder** name, which is why only a skill
 *   whose frontmatter name matches its folder is delivered (`kit/skills.ts`).
 * * `plugin.json`'s own `skills` key with an absolute or `../` path silently
 *   loads nothing, so the links are the only way in.
 * * A plugin `name` with a space in it silently drops the whole plugin; the
 *   agent's slug is used only when it is a clean kebab name.
 *
 * Lives at `<userData>/cinna-plugins/agents/<key>/`, keyed by a hash of the
 * agent id — stable across a rename of the folder or of the agent, and never a
 * path component built from a renderer string.
 *
 * Never throws: a plugin that cannot be written is a session without the
 * agent's skills, logged, not a turn that fails.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { swapInto } from '../kit/treeSwap'
import { manifestPath, parseManifest } from '../kit/manifestIo'
import { agentSkillRows, deliverableSkills, SKILL_NAME_RE, SKILLS_DIR, MAX_NAME_LENGTH } from '../kit/skills'
import { createLogger } from '../logger/logger'
import type { LocalAgentSkill } from '../../shared/localAgents'
import type { CinnaAgentManifest } from '../../shared/kit/manifest'
import { TASKS_SKILL_NAME } from './tasksSkillService'
import { catalogSkillCache } from './catalogSkillCache'

const logger = createLogger('agent-skills-plugin')

/** Under `userData`, beside the `cinna-tasks` plugin. */
const PLUGINS_DIR = 'cinna-plugins'
const AGENTS_DIR = 'agents'

/** The plugin's name when the agent's slug cannot be one. */
export const FALLBACK_PLUGIN_NAME = 'agent-skills'

/** What the plugin was built from, beside it: rebuilt only when this differs. */
const STATE_FILE = '.cinna-agent-skills.json'

export interface AgentSkillsPluginInput {
  /** The agent row id (`folder:<manifest id>`); the plugin's folder is keyed by it. */
  agentId: string
  slug: string
  /** Absolute path of the agent folder. */
  agentDir: string
  skills: readonly LocalAgentSkill[] | undefined
}

interface PluginState {
  name: string
  links: Record<string, string>
}

/** `<userData>/cinna-plugins/agents/<hash of the agent id>`. */
export function agentSkillsPluginDir(agentId: string): string {
  const key = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  return join(runtimeHost.getPath('userData'), PLUGINS_DIR, AGENTS_DIR, key)
}

/**
 * The plugin's `name`: the agent's slug when it is a clean kebab name, else
 * `agent-skills`. Never `cinna-tasks`, which is the desktop's other plugin.
 */
export function agentSkillsPluginName(slug: string): string {
  return slug.length <= MAX_NAME_LENGTH && SKILL_NAME_RE.test(slug) && slug !== TASKS_SKILL_NAME
    ? slug
    : FALLBACK_PLUGIN_NAME
}

function readState(dir: string): PluginState | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as PluginState
    return value && typeof value.name === 'string' && value.links && typeof value.links === 'object' ? value : null
  } catch {
    return null
  }
}

function sameState(a: PluginState | null, b: PluginState): boolean {
  if (!a || a.name !== b.name) return false
  const keys = Object.keys(b.links)
  return Object.keys(a.links).length === keys.length && keys.every((key) => a.links[key] === b.links[key])
}

/** Every link the state names is still a link — a hand-deleted one rebuilds. */
function linksPresent(dir: string, state: PluginState): boolean {
  return Object.keys(state.links).every((name) => {
    try {
      return lstatSync(join(dir, SKILLS_DIR, name)).isSymbolicLink()
    } catch {
      return false
    }
  })
}

/**
 * Remove what an interrupted build left beside `target`: the staging tree
 * (`<target>.tmp-<pid>-<ms>`) and the previous plugin `swapInto` parks at
 * `<staging>.previous`, plus any `<target>.previous*`. Best effort; `rm`
 * unlinks the skill links and never follows them into the agent's folder.
 */
function sweepLeftovers(target: string): void {
  const parent = dirname(target)
  const key = basename(target)
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(`${key}.tmp-`) && !name.startsWith(`${key}.previous`)) continue
    try {
      rmSync(join(parent, name), { recursive: true, force: true })
    } catch {
      /* best effort: tried again on the next build */
    }
  }
}

/**
 * The slug the scanner gives the agent (`manifest.slug`, else the folder
 * name), read fresh from the manifest — the one slug source every caller of
 * {@link ensureKitAgentSkillsPlugin} shares, so two callers never flap the
 * plugin's name.
 */
function readKitManifest(agentDir: string): { slug: string; manifest: CinnaAgentManifest | null } {
  try {
    const manifest = parseManifest(readFileSync(manifestPath(agentDir), 'utf8'))
    return { slug: typeof manifest.slug === 'string' ? manifest.slug : basename(agentDir), manifest }
  } catch {
    // The folder name, as the scanner does; no manifest, no catalog pins.
    return { slug: basename(agentDir), manifest: null }
  }
}

/**
 * Every skill a kit agent's engine is given, fresh from disk: its own
 * deliverable `skills/<name>/` and each pinned catalog skill whose revision is
 * in the cache and passes the same checks (`kit/skills.ts` `catalogSkillRows`).
 * A name is never on both: a pin that clashes with an own skill is an error.
 */
export function kitAgentDeliverableSkills(agentDir: string, manifest: unknown): LocalAgentSkill[] {
  return deliverableSkills(agentSkillRows(agentDir, manifest, catalogSkillCache.resolve))
}

/** Where a deliverable skill's folder is: the agent's own, or the catalog cache's. */
function skillFolder(agentDir: string, skill: LocalAgentSkill): string {
  return skill.source === 'catalog' && isAbsolute(skill.path)
    ? dirname(skill.path)
    : join(agentDir, SKILLS_DIR, skill.name)
}

export interface KitAgentSkillsPlugin {
  /** The plugin folder; its `skills/` is the links folder OpenCode reads. */
  dir: string
  /** The deliverable skill names it links. */
  skills: string[]
}

/**
 * The **one** entry point for a kit agent's skills plugin, used by the Claude
 * launcher and by OpenCode's config alike. Both write the same folder, so
 * both must build it from the same input: the skills are scanned fresh (a
 * just-added skill reaches the next session) and the slug read fresh from the
 * manifest. Null when nothing is deliverable or the plugin could not be
 * written. The caller decides that the agent is a kit agent.
 */
export function ensureKitAgentSkillsPlugin(agent: { id: string; path: string }): KitAgentSkillsPlugin | null {
  const { slug, manifest } = readKitManifest(agent.path)
  const skills = kitAgentDeliverableSkills(agent.path, manifest)
  if (skills.length === 0) return null
  const dir = ensureAgentSkillsPlugin({ agentId: agent.id, slug, agentDir: agent.path, skills })
  return dir ? { dir, skills: skills.map((skill) => skill.name) } : null
}

/**
 * Materialise the agent's skills plugin and return its path, or null when the
 * agent has no deliverable skill or the plugin could not be written. Callers
 * outside this module go through {@link ensureKitAgentSkillsPlugin}.
 */
export function ensureAgentSkillsPlugin(input: AgentSkillsPluginInput): string | null {
  const skills = deliverableSkills(input.skills)
  if (skills.length === 0) return null
  const target = agentSkillsPluginDir(input.agentId)
  sweepLeftovers(target)
  const wanted: PluginState = {
    name: agentSkillsPluginName(input.slug),
    links: Object.fromEntries(skills.map((skill) => [skill.name, skillFolder(input.agentDir, skill)]))
  }
  try {
    if (existsSync(target) && sameState(readState(target), wanted) && linksPresent(target, wanted)) return target

    const staging = `${target}.tmp-${process.pid}-${Date.now()}`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(staging, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({
        name: wanted.name,
        description: 'This agent’s skills: its own skills/ folder and the catalog skills it pins. Provided by Cinna Desktop.',
        version: '1'
      }, null, 2)}\n`
    )
    mkdirSync(join(staging, SKILLS_DIR), { recursive: true })
    for (const [name, link] of Object.entries(wanted.links)) {
      // A junction on Windows: it needs no developer mode, and a directory is
      // all a skill is.
      symlinkSync(link, join(staging, SKILLS_DIR, name), process.platform === 'win32' ? 'junction' : 'dir')
    }
    writeFileSync(join(staging, STATE_FILE), `${JSON.stringify(wanted)}\n`)
    // The previous plugin is removed by `rm`, which unlinks a symlink and
    // never follows it into the agent's folder.
    swapInto(staging, target)
    logger.info('agent skills plugin refreshed', { agentId: input.agentId, skills: Object.keys(wanted.links).length })
    return target
  } catch (error) {
    logger.warn('the agent skills plugin could not be written', {
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}
