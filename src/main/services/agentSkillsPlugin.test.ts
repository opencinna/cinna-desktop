import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { LocalAgentSkill } from '../../shared/localAgents'
import { catalogSkillRefOf, scanAgentSkills } from '../kit/skills'
import { readSkillArchive } from '../kit/skillArchive'
import { sha256Of, skillTgz } from '../kit/testSupport/skillTar'
import { catalogSkillCache, removeTree } from './catalogSkillCache'

const host = vi.hoisted(() => ({ userData: '' }))
vi.mock('../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, resourcesPath: '', getAppPath: () => '', getPath: () => host.userData }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  FALLBACK_PLUGIN_NAME,
  agentSkillsPluginDir,
  agentSkillsPluginName,
  ensureAgentSkillsPlugin,
  ensureKitAgentSkillsPlugin
} from './agentSkillsPlugin'

/**
 * A kit agent's skills as a local Claude plugin: links to the real skill
 * folders, only the deliverable ones, rebuilt only when the set changes, and
 * no plugin at all when nothing is deliverable.
 */

let root: string
let agentDir: string

const skill = (name: string, deliverable = true): LocalAgentSkill => ({
  name, description: `${name} things`, version: null, source: 'authored', path: `skills/${name}/SKILL.md`,
  deliverable, issues: deliverable ? [] : [{ code: 'name_mismatch', message: 'x', severity: 'error' }], credentials: []
})

function writeSkill(name: string): void {
  mkdirSync(join(agentDir, 'skills', name), { recursive: true })
  writeFileSync(join(agentDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
}

const input = (skills: LocalAgentSkill[], slug = 'invoice-reader') => ({ agentId: 'folder:abc', slug, agentDir, skills })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-agent-skills-'))
  host.userData = join(root, 'userData')
  agentDir = join(root, 'agents', 'invoice-reader')
  writeSkill('pdf-tools')
  writeSkill('ledger')
  writeSkill('broken')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the agent skills plugin', () => {
  it('links each deliverable skill to the agent’s real folder, under a stable per-agent key', () => {
    const dir = ensureAgentSkillsPlugin(input([skill('ledger'), skill('pdf-tools'), skill('broken', false)]))
    expect(dir).toBe(agentSkillsPluginDir('folder:abc'))
    expect(dir).toMatch(/cinna-plugins[\\/]agents[\\/][0-9a-f]{16}$/)
    expect(JSON.parse(readFileSync(join(dir!, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'invoice-reader' })
    expect(readdirSync(join(dir!, 'skills')).sort()).toEqual(['ledger', 'pdf-tools'])
    for (const name of ['ledger', 'pdf-tools']) {
      const link = join(dir!, 'skills', name)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(agentDir, 'skills', name))
    }
    // Live: an edit in the agent folder is what the plugin serves, with no rebuild.
    writeFileSync(join(agentDir, 'skills', 'ledger', 'SKILL.md'), 'edited')
    expect(readFileSync(join(dir!, 'skills', 'ledger', 'SKILL.md'), 'utf8')).toBe('edited')
  })

  it('is no plugin when nothing is deliverable', () => {
    expect(ensureAgentSkillsPlugin(input([]))).toBeNull()
    expect(ensureAgentSkillsPlugin(input([skill('broken', false)]))).toBeNull()
    expect(ensureAgentSkillsPlugin({ ...input([]), skills: undefined })).toBeNull()
    expect(existsSync(agentSkillsPluginDir('folder:abc'))).toBe(false)
  })

  it('rebuilds only when the set of skills changes, and never touches the real folders', () => {
    const dir = ensureAgentSkillsPlugin(input([skill('ledger')]))!
    const marker = join(dir, 'marker')
    writeFileSync(marker, 'same build')
    // Same set: the same plugin, untouched.
    expect(ensureAgentSkillsPlugin(input([skill('ledger')]))).toBe(dir)
    expect(existsSync(marker)).toBe(true)

    // A skill added: rebuilt, and the agent's own files survive the old plugin's removal.
    expect(ensureAgentSkillsPlugin(input([skill('ledger'), skill('pdf-tools')]))).toBe(dir)
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['ledger', 'pdf-tools'])
    expect(readFileSync(join(agentDir, 'skills', 'ledger', 'SKILL.md'), 'utf8')).toContain('name: ledger')

    // A skill removed: rebuilt again.
    writeFileSync(marker, 'second build')
    expect(ensureAgentSkillsPlugin(input([skill('pdf-tools')]))).toBe(dir)
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(join(dir, 'skills'))).toEqual(['pdf-tools'])
    expect(existsSync(join(agentDir, 'skills', 'ledger', 'SKILL.md'))).toBe(true)
  })

  it('rebuilds when a link was removed by hand, or the slug changed', () => {
    const dir = ensureAgentSkillsPlugin(input([skill('ledger')]))!
    rmSync(join(dir, 'skills', 'ledger'))
    ensureAgentSkillsPlugin(input([skill('ledger')]))
    expect(lstatSync(join(dir, 'skills', 'ledger')).isSymbolicLink()).toBe(true)

    ensureAgentSkillsPlugin(input([skill('ledger')], 'renamed-agent'))
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('renamed-agent')
  })

  it('names the plugin by the slug only when Claude will load that name', () => {
    expect(agentSkillsPluginName('invoice-reader')).toBe('invoice-reader')
    // A space silently drops the whole plugin; cinna-tasks is the other plugin.
    expect(agentSkillsPluginName('Invoice Reader')).toBe(FALLBACK_PLUGIN_NAME)
    expect(agentSkillsPluginName('under_score')).toBe(FALLBACK_PLUGIN_NAME)
    expect(agentSkillsPluginName('cinna-tasks')).toBe(FALLBACK_PLUGIN_NAME)
    expect(agentSkillsPluginName('x'.repeat(65))).toBe(FALLBACK_PLUGIN_NAME)
  })

  it('never links an authored cinna-tasks, by folder or by frontmatter name, so OpenCode cannot be handed one', () => {
    // OpenCode reads this links folder (skills.paths) and registers each skill
    // by its frontmatter name; a later path wins, so an authored cinna-tasks
    // in it would replace the platform skill (probed on 1.18.27).
    mkdirSync(join(agentDir, 'skills', 'cinna-tasks'), { recursive: true })
    writeFileSync(join(agentDir, 'skills', 'cinna-tasks', 'SKILL.md'), '---\nname: cinna-tasks\ndescription: Impostor.\n---\n')
    mkdirSync(join(agentDir, 'skills', 'own-tasks'), { recursive: true })
    writeFileSync(join(agentDir, 'skills', 'own-tasks', 'SKILL.md'), '---\nname: cinna-tasks\ndescription: Impostor.\n---\n')
    const dir = ensureAgentSkillsPlugin(input(scanAgentSkills(agentDir)))!
    const linked = readdirSync(join(dir, 'skills')).sort()
    expect(linked).toEqual(['broken', 'ledger', 'pdf-tools'])
    for (const name of linked) {
      expect(readFileSync(join(dir, 'skills', name, 'SKILL.md'), 'utf8')).not.toContain('name: cinna-tasks')
    }
  })

  it('keys the plugin by agent, so two agents never share one', () => {
    expect(agentSkillsPluginDir('folder:a')).not.toBe(agentSkillsPluginDir('folder:b'))
  })

  it('sweeps the staging and parked trees an interrupted build left beside the plugin', () => {
    const dir = agentSkillsPluginDir('folder:abc')
    mkdirSync(join(dir, '..'), { recursive: true })
    // swapInto parks the previous plugin at `<staging>.previous`.
    const staging = `${dir}.tmp-123-456`
    for (const leftover of [staging, `${staging}.previous`, `${dir}.previous`]) {
      mkdirSync(join(leftover, 'skills'), { recursive: true })
    }
    // A leftover's link is unlinked, never followed into the agent's folder.
    symlinkSync(join(agentDir, 'skills', 'ledger'), join(staging, 'skills', 'ledger'), 'dir')
    const other = `${agentSkillsPluginDir('folder:other')}.tmp-1-2`
    mkdirSync(other, { recursive: true })

    ensureAgentSkillsPlugin(input([skill('ledger')]))
    expect(readdirSync(join(dir, '..')).sort()).toEqual([basename(dir), basename(other)].sort())
    expect(existsSync(join(agentDir, 'skills', 'ledger', 'SKILL.md'))).toBe(true)
    // Swept on the fast path too, when nothing needs rebuilding.
    mkdirSync(staging)
    ensureAgentSkillsPlugin(input([skill('ledger')]))
    expect(existsSync(staging)).toBe(false)
  })
})

describe('ensureKitAgentSkillsPlugin, the one builder both engines use', () => {
  it('scans the folder fresh and names the plugin by the manifest slug, not the folder name', () => {
    writeFileSync(join(agentDir, 'cinna-agent.json'), JSON.stringify({ slug: 'ledger-keeper' }))
    const built = ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })
    expect(built).toEqual({ dir: agentSkillsPluginDir('folder:abc'), skills: ['broken', 'ledger', 'pdf-tools'] })
    expect(JSON.parse(readFileSync(join(built!.dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('ledger-keeper')

    // A skill added on disk is in the very next build, from either caller.
    writeSkill('fresh-one')
    expect(ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })?.skills).toContain('fresh-one')
    expect(readdirSync(join(built!.dir, 'skills'))).toContain('fresh-one')
  })

  it('falls back to the folder name when the manifest names no slug, as the scanner does', () => {
    const built = ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })!
    expect(JSON.parse(readFileSync(join(built.dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('invoice-reader')
  })

  it('is null when nothing in skills/ is deliverable', () => {
    rmSync(join(agentDir, 'skills'), { recursive: true, force: true })
    expect(ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })).toBeNull()
  })
})

describe('pinned catalog skills', () => {
  const UUID = '0b6f3c1e-1111-4222-8333-444455556666'
  const pin = (revision: number, archive: Buffer, name = 'erp-lookup') => ({
    package_id: `test.cinna.skill.${name}`,
    package_uuid: UUID,
    name,
    revision_number: revision,
    archive_sha256: sha256Of(archive)
  })

  beforeEach(() => {
    catalogSkillCache._reset(join(root, 'userData', 'catalog-skills'))
  })
  afterEach(() => {
    removeTree(join(root, 'userData', 'catalog-skills'))
    catalogSkillCache._reset()
  })

  it('links a cached revision to its read-only folder in the shared cache, beside the agent’s own', () => {
    const archive = skillTgz('erp-lookup')
    const pinned = pin(2, archive)
    writeFileSync(join(agentDir, 'cinna-agent.json'), JSON.stringify({ slug: 'invoice-reader', catalog_skills: [pinned] }))
    // Not on this computer yet: the agent's own skills only.
    expect(ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })?.skills).toEqual(['broken', 'ledger', 'pdf-tools'])

    const cached = catalogSkillCache.install(
      'https-cinna.test',
      { ...catalogSkillRefOf(pinned), packageId: pinned.package_id },
      readSkillArchive(archive, 'erp-lookup')
    )
    const built = ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })!
    expect(built.skills).toEqual(['broken', 'erp-lookup', 'ledger', 'pdf-tools'])
    expect(readlinkSync(join(built.dir, 'skills', 'erp-lookup'))).toBe(cached)
    expect(readlinkSync(join(built.dir, 'skills', 'ledger'))).toBe(join(agentDir, 'skills', 'ledger'))
    expect(readFileSync(join(built.dir, 'skills', 'erp-lookup', 'SKILL.md'), 'utf8')).toContain('name: erp-lookup')
  })

  it('never links a pin whose name is one of the agent’s own skills, or whose digest is not the cached one', () => {
    const archive = skillTgz('ledger')
    const clashing = pin(1, archive, 'ledger')
    catalogSkillCache.install('https-cinna.test', catalogSkillRefOf(clashing), readSkillArchive(archive, 'ledger'))
    writeFileSync(join(agentDir, 'cinna-agent.json'), JSON.stringify({ catalog_skills: [clashing] }))
    const built = ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })!
    expect(readlinkSync(join(built.dir, 'skills', 'ledger'))).toBe(join(agentDir, 'skills', 'ledger'))

    rmSync(join(agentDir, 'skills', 'ledger'), { recursive: true, force: true })
    writeFileSync(join(agentDir, 'cinna-agent.json'), JSON.stringify({ catalog_skills: [{ ...clashing, archive_sha256: 'b'.repeat(64) }] }))
    expect(ensureKitAgentSkillsPlugin({ id: 'folder:abc', path: agentDir })?.skills).toEqual(['broken', 'pdf-tools'])
  })
})
