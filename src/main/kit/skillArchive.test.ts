import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_UNPACKED_BYTES, readSkillArchive, SkillArchiveError, writeSkillTree } from './skillArchive'
import { CORE_BUILT_ERP_LOOKUP, sha256Of, skillTgz, tgzOf, type TarMember } from './testSupport/skillTar'

/**
 * The safe reader for catalog skill archives: what core builds is read, and
 * every shape that could write outside the skill folder, link out of it, or
 * fill the disk is refused before anything touches the disk.
 */

const refusal = (members: TarMember[], name = 'erp-lookup'): string => {
  try {
    readSkillArchive(tgzOf(members), name)
  } catch (err) {
    expect(err).toBeInstanceOf(SkillArchiveError)
    return (err as Error).message
  }
  throw new Error('expected a refusal')
}

const skillMd = (name = 'erp-lookup'): TarMember => ({
  name: `skills/${name}/SKILL.md`,
  body: `---\nname: ${name}\ndescription: x\n---\n`
})

describe('reading what core builds', () => {
  it('reads cinna-core’s own archive: pax long paths, the executable bit, the skills/<name>/ root', () => {
    const bytes = Buffer.from(CORE_BUILT_ERP_LOOKUP.base64, 'base64')
    expect(sha256Of(bytes)).toBe(CORE_BUILT_ERP_LOOKUP.sha256)
    const archive = readSkillArchive(bytes, 'erp-lookup')
    expect(archive.files.map((file) => file.path).sort()).toEqual([
      'SKILL.md',
      'docs/a-rather-long-folder-name-to-push-the-path-over-one-hundred-characters/notes-with-a-long-name.md',
      'scripts/run.sh'
    ])
    expect(archive.files.find((file) => file.path === 'scripts/run.sh')?.executable).toBe(true)
    expect(archive.files.find((file) => file.path === 'SKILL.md')?.executable).toBe(false)
    expect(archive.files.find((file) => file.path === 'SKILL.md')?.data.toString()).toContain('name: erp-lookup')
    expect(archive.dirs).toEqual([
      'docs',
      'docs/a-rather-long-folder-name-to-push-the-path-over-one-hundred-characters',
      'scripts'
    ])
  })

  it('reads a GNU long name and a pax long name alike', () => {
    const long = `skills/erp-lookup/${'d'.repeat(60)}/${'f'.repeat(60)}.md`
    for (const longName of ['gnu', 'pax'] as const) {
      const archive = readSkillArchive(tgzOf([skillMd(), { name: long, body: 'x', longName }]), 'erp-lookup')
      expect(archive.files.map((file) => file.path)).toContain(`${'d'.repeat(60)}/${'f'.repeat(60)}.md`)
    }
  })

  it('accepts one top-level <name>/ folder, as an upload carries it, and folder entries', () => {
    const archive = readSkillArchive(
      tgzOf([
        { name: 'erp-lookup/', type: '5' },
        { name: 'erp-lookup/SKILL.md', body: '---\nname: erp-lookup\ndescription: x\n---\n' },
        { name: 'erp-lookup/empty/', type: '5' }
      ]),
      'erp-lookup'
    )
    expect(archive.files.map((file) => file.path)).toEqual(['SKILL.md'])
    expect(archive.dirs).toEqual(['empty'])
  })
})

describe('refusals', () => {
  it('refuses a path that climbs out with ..', () => {
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/../../evil.sh', body: 'x' }])).toMatch(/outside its folder/)
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/a/../../../evil', body: 'x', longName: 'pax' }])).toMatch(
      /outside its folder/
    )
  })

  it('refuses an absolute path', () => {
    expect(refusal([skillMd(), { name: '/etc/passwd', body: 'x' }])).toMatch(/outside its folder/)
  })

  it('refuses a symbolic link, a hard link and a device', () => {
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/link', type: '2', linkname: '/etc/passwd' }])).toMatch(/symbolic link/)
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/hard', type: '1', linkname: 'skills/erp-lookup/SKILL.md' }])).toMatch(
      /hard link/
    )
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/dev', type: '3' }])).toMatch(/other than files and folders/)
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/fifo', type: '6' }])).toMatch(/other than files and folders/)
  })

  it('refuses two top-level folders, a folder with another name, and a stray file at the top', () => {
    expect(refusal([skillMd(), { name: 'skills/other/SKILL.md', body: 'x' }])).toMatch(/exactly one folder named erp-lookup/)
    expect(refusal([skillMd('other')])).toMatch(/exactly one folder named erp-lookup/)
    expect(refusal([skillMd(), { name: 'README.md', body: 'x' }])).toMatch(/exactly one folder named erp-lookup/)
    expect(refusal([{ name: 'erp-lookup/SKILL.md', body: 'x' }, { name: 'other/SKILL.md', body: 'x' }])).toMatch(
      /exactly one folder/
    )
  })

  it('refuses the same path twice, in any case, and a file where a folder is needed', () => {
    expect(refusal([skillMd(), skillMd()])).toMatch(/same file twice/)
    expect(refusal([skillMd(), { name: 'skills/erp-lookup/skill.md', body: 'x' }])).toMatch(/same file twice/)
    expect(
      refusal([skillMd(), { name: 'skills/erp-lookup/a', body: 'x' }, { name: 'skills/erp-lookup/a/b', body: 'y' }])
    ).toMatch(/same file twice/)
  })

  it('refuses an archive without SKILL.md at the top of its folder', () => {
    expect(refusal([{ name: 'skills/erp-lookup/docs/SKILL.md', body: 'x' }])).toMatch(/no SKILL.md/)
  })

  it('refuses a gzip bomb before it is unpacked whole', () => {
    // Zeros compress about a thousand to one: a small download, far over the unpacked cap.
    const bomb = gzipSync(Buffer.alloc(MAX_UNPACKED_BYTES + 1024 * 1024))
    expect(bomb.length).toBeLessThan(1024 * 1024)
    expect(() => readSkillArchive(bomb, 'erp-lookup')).toThrow(/more than 64 MB/)
  })

  it('refuses what is not gzip, and a damaged header', () => {
    expect(() => readSkillArchive(Buffer.from('plain text'), 'erp-lookup')).toThrow(/not a gzip file/)
    const tar = gzipSync(Buffer.concat([Buffer.alloc(100, 0x41), Buffer.alloc(412, 0x42)]))
    expect(() => readSkillArchive(tar, 'erp-lookup')).toThrow(SkillArchiveError)
  })
})

describe('laying it out', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cinna-skill-tree-'))
  })
  afterEach(() => {
    // Read-only folders cannot be emptied until they are writable again.
    const unlock = (dir: string): void => {
      chmodSync(dir, 0o755)
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (lstatSync(path).isDirectory()) unlock(path)
      }
    }
    unlock(root)
    rmSync(root, { recursive: true, force: true })
  })

  it('writes files read-only, keeps the execute bit, and locks the folders', () => {
    const target = join(root, 'erp-lookup')
    writeSkillTree(target, readSkillArchive(skillTgz('erp-lookup'), 'erp-lookup'))
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: erp-lookup')
    expect(statSync(join(target, 'SKILL.md')).mode & 0o777).toBe(0o444)
    expect(statSync(join(target, 'scripts', 'run.sh')).mode & 0o777).toBe(0o555)
    expect(statSync(join(target, 'scripts')).mode & 0o777).toBe(0o555)
    expect(statSync(target).mode & 0o777).toBe(0o555)
  })
})
