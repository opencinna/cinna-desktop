import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const host = vi.hoisted(() => ({ isPackaged: false, appPath: '', resourcesPath: '', userData: '' }))
vi.mock('../host/runtimeHost', () => ({
  runtimeHost: {
    get isPackaged() { return host.isPackaged },
    get resourcesPath() { return host.resourcesPath },
    getAppPath: () => host.appPath,
    getPath: () => host.userData
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  TASKS_SKILL_DIR_ENV,
  ensureTasksSkillPlugin,
  readSkillVersion,
  tasksSkillDeliveryFor,
  tasksSkillDir,
  tasksSkillInfo,
  tasksSkillLabel,
  tasksSkillPluginDir
} from './tasksSkillService'

/**
 * The `cinna-tasks` skill's resolver and its Claude plugin.
 *
 * The skill arrives with the kit bundle; until then everything here must say
 * "not available" and nothing may throw, so a build without it runs exactly as
 * before. The plugin is a copy refreshed only when the skill's content changes.
 */

const SKILL = '---\nname: cinna-tasks\ndescription: Cinna tasks.\nversion: "1"\n---\n\n# Cinna tasks\n'

let root: string
let savedEnv: string | undefined

function writeSkill(dir: string, text = SKILL): void {
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text)
  writeFileSync(join(dir, 'references', 'file-protocol.md'), '# Files\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-tasks-skill-'))
  host.isPackaged = false
  host.appPath = join(root, 'app')
  host.resourcesPath = join(root, 'Resources')
  host.userData = join(root, 'userData')
  savedEnv = process.env[TASKS_SKILL_DIR_ENV]
  delete process.env[TASKS_SKILL_DIR_ENV]
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[TASKS_SKILL_DIR_ENV]
  else process.env[TASKS_SKILL_DIR_ENV] = savedEnv
  rmSync(root, { recursive: true, force: true })
})

describe('where the skill is', () => {
  it('is the kit bundle’s skills/cinna-tasks, in the repo and in a package', () => {
    expect(tasksSkillDir()).toBe(join(root, 'app', 'resources', 'cinna-agent-kit', 'skills', 'cinna-tasks'))
    host.isPackaged = true
    expect(tasksSkillDir()).toBe(join(root, 'Resources', 'cinna-agent-kit', 'skills', 'cinna-tasks'))
  })

  it('follows the dev override, but never in a packaged build', () => {
    // Mutation: honour the variable when packaged and an installed app's
    // agents read whatever folder an environment happens to name.
    process.env[TASKS_SKILL_DIR_ENV] = join(root, 'draft')
    expect(tasksSkillDir()).toBe(join(root, 'draft'))
    host.isPackaged = true
    expect(tasksSkillDir()).toBe(join(root, 'Resources', 'cinna-agent-kit', 'skills', 'cinna-tasks'))
  })
})

describe('whether it is there', () => {
  it('is unavailable without SKILL.md, and every answer degrades to nothing', () => {
    const info = tasksSkillInfo()
    expect(info.available).toBe(false)
    expect(tasksSkillLabel(info)).toBeNull()
    expect(tasksSkillDeliveryFor('claude', info)).toBeNull()
    expect(tasksSkillDeliveryFor('codex', info)).toBeNull()
    expect(ensureTasksSkillPlugin(info)).toBeNull()
    expect(existsSync(tasksSkillPluginDir())).toBe(false)
  })

  it('reads the version for the turn header, and tells each engine how to open it', () => {
    const dir = join(root, 'draft', 'cinna-tasks')
    writeSkill(dir)
    process.env[TASKS_SKILL_DIR_ENV] = dir
    const info = tasksSkillInfo()
    expect(info).toMatchObject({ available: true, version: '1', skillFile: join(dir, 'SKILL.md'), skillsRoot: join(root, 'draft') })
    expect(tasksSkillLabel(info)).toBe('cinna-tasks v1')
    expect(tasksSkillDeliveryFor('claude', info)).toEqual({ kind: 'skill' })
    expect(tasksSkillDeliveryFor('opencode', info)).toEqual({ kind: 'skill' })
    // Codex has no skill loader: it is pointed at the file.
    expect(tasksSkillDeliveryFor('codex', info)).toEqual({ kind: 'pointer', path: join(dir, 'SKILL.md') })
  })

  it('reads a version quoted, bare or absent', () => {
    expect(readSkillVersion('---\nversion: "2"\n---\n')).toBe('2')
    expect(readSkillVersion("---\nname: x\nversion: 3\n---\n")).toBe('3')
    expect(readSkillVersion('---\nname: x\n---\n')).toBeNull()
    expect(readSkillVersion('no frontmatter')).toBeNull()
  })
})

describe('the Claude plugin', () => {
  it('is a local plugin holding a copy of the skill', () => {
    const dir = join(root, 'draft', 'cinna-tasks')
    writeSkill(dir)
    process.env[TASKS_SKILL_DIR_ENV] = dir
    const plugin = ensureTasksSkillPlugin()
    expect(plugin).toBe(join(root, 'userData', 'cinna-plugins', 'cinna-tasks'))
    const manifest = JSON.parse(readFileSync(join(plugin!, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'cinna-tasks', version: '1' })
    expect(typeof manifest.description).toBe('string')
    expect(readFileSync(join(plugin!, 'skills', 'cinna-tasks', 'SKILL.md'), 'utf8')).toBe(SKILL)
    expect(readFileSync(join(plugin!, 'skills', 'cinna-tasks', 'references', 'file-protocol.md'), 'utf8')).toBe('# Files\n')
  })

  it('is rewritten when the skill changes, and left alone when it does not', () => {
    // Mutation: skip the hash and an updated bundle never reaches Claude;
    // drop the early return and every turn rewrites the folder under a
    // session that may be reading it.
    const dir = join(root, 'draft', 'cinna-tasks')
    writeSkill(dir)
    process.env[TASKS_SKILL_DIR_ENV] = dir
    const plugin = ensureTasksSkillPlugin()!
    const marker = join(plugin, 'untouched')
    writeFileSync(marker, '')
    expect(ensureTasksSkillPlugin()).toBe(plugin)
    expect(existsSync(marker)).toBe(true)

    writeSkill(dir, SKILL.replace('# Cinna tasks', '# Cinna tasks, revised'))
    expect(ensureTasksSkillPlugin()).toBe(plugin)
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(plugin, 'skills', 'cinna-tasks', 'SKILL.md'), 'utf8')).toContain('revised')
  })

  it('answers null rather than throwing when it cannot be written', () => {
    const dir = join(root, 'draft', 'cinna-tasks')
    writeSkill(dir)
    process.env[TASKS_SKILL_DIR_ENV] = dir
    // userData is a file, so nothing can be created under it.
    writeFileSync(host.userData, '')
    expect(ensureTasksSkillPlugin()).toBeNull()
  })
})
