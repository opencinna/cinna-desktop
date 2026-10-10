import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { collectSkillTree, MAX_SKILL_UPLOAD_BYTES, packSkillTarGz, skillTreeHash } from './skillPack'
import { readSkillArchive } from './skillArchive'

/**
 * The upload archive of an authored skill: what core's upload parser
 * (`skill_upload.safe_extract`) takes — one top-level `<name>/`, files and
 * folders only — written deterministically, read back by the desktop's own
 * safe reader, and the preflight refusals that keep a folder from being sent.
 */

let root: string
let skillDir: string

const SKILL_MD = '---\nname: erp-lookup\ndescription: Look things up in the ERP.\n---\n\nUse it.\n'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-skill-pack-'))
  skillDir = join(root, 'erp-lookup')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD)
  writeFileSync(join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(skillDir, 'scripts', 'run.sh'), 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The member headers of a tar stream: name, type flag, mode, size, mtime, uid. */
function members(tgz: Buffer): { name: string; type: string; mode: number; size: number; mtime: number; uid: number }[] {
  const tar = gunzipSync(tgz)
  const out: { name: string; type: string; mode: number; size: number; mtime: number; uid: number }[] = []
  let offset = 0
  let paxPath: string | null = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      paxPath = /\d+ path=(.*)\n/s.exec(data.toString('utf8'))?.[1] ?? null
      continue
    }
    out.push({
      name: paxPath ?? field(0, 100),
      type,
      mode: parseInt(field(100, 8).trim(), 8),
      size,
      mtime: parseInt(field(136, 12).trim(), 8),
      uid: parseInt(field(108, 8).trim(), 8)
    })
    paxPath = null
  }
  return out
}

function pack(): Buffer {
  const collected = collectSkillTree(skillDir)
  if (!collected.ok) throw new Error(`not packable: ${collected.problem}`)
  return packSkillTarGz('erp-lookup', collected.tree)
}

describe('packSkillTarGz', () => {
  it('writes one top-level folder named like the skill, folders and files only, in path order', () => {
    expect(members(pack()).map((m) => [m.name, m.type])).toEqual([
      ['erp-lookup/', '5'],
      ['erp-lookup/SKILL.md', '0'],
      ['erp-lookup/scripts/', '5'],
      ['erp-lookup/scripts/run.sh', '0']
    ])
  })

  it('collapses modes to 0755 / 0644 and zeroes mtime and owner', () => {
    const byName = new Map(members(pack()).map((m) => [m.name, m]))
    expect(byName.get('erp-lookup/')?.mode).toBe(0o755)
    expect(byName.get('erp-lookup/scripts/run.sh')?.mode).toBe(0o755)
    expect(byName.get('erp-lookup/SKILL.md')?.mode).toBe(0o644)
    for (const member of byName.values()) {
      expect(member.mtime).toBe(0)
      expect(member.uid).toBe(0)
    }
  })

  it('is deterministic: the same folder packs to the same bytes, with a gzip header of mtime 0 and OS 255', () => {
    const first = pack()
    const second = pack()
    expect(second.equals(first)).toBe(true)
    expect(first.readUInt32LE(4)).toBe(0)
    expect(first[9]).toBe(0xff)
  })

  it('round-trips through the desktop’s safe reader (the `<name>/` root an upload carries)', () => {
    const archive = readSkillArchive(pack(), 'erp-lookup')
    expect(archive.dirs).toEqual(['scripts'])
    expect(archive.files.map((file) => [file.path, file.data.toString('utf8'), file.executable])).toEqual([
      ['SKILL.md', SKILL_MD, false],
      ['scripts/run.sh', '#!/bin/sh\necho hi\n', true]
    ])
  })

  it('carries a long or non-ASCII path in a pax record the reader takes', () => {
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}`
    mkdirSync(join(skillDir, deep), { recursive: true })
    writeFileSync(join(skillDir, deep, 'notes.md'), 'long')
    writeFileSync(join(skillDir, 'résumé.md'), 'accent')
    const tgz = pack()
    const names = members(tgz).map((m) => m.name)
    expect(names).toContain(`erp-lookup/${deep}/notes.md`)
    expect(names).toContain('erp-lookup/résumé.md')
    const files = readSkillArchive(tgz, 'erp-lookup').files.map((file) => file.path)
    expect(files).toContain(`${deep}/notes.md`)
    expect(files).toContain('résumé.md')
  })

  it('leaves out the folders and files core never snapshots', () => {
    for (const dir of ['.git', '__pycache__', 'node_modules', '.venv', 'scripts/__pycache__']) {
      mkdirSync(join(skillDir, dir), { recursive: true })
      writeFileSync(join(skillDir, dir, 'x.txt'), 'junk')
    }
    writeFileSync(join(skillDir, 'scripts', 'mod.pyc'), 'compiled')
    expect(members(pack()).map((m) => m.name)).toEqual([
      'erp-lookup/',
      'erp-lookup/SKILL.md',
      'erp-lookup/scripts/',
      'erp-lookup/scripts/run.sh'
    ])
  })
})

describe('collectSkillTree refusals', () => {
  it('refuses a link anywhere in the folder, naming it', () => {
    symlinkSync(join(skillDir, 'SKILL.md'), join(skillDir, 'scripts', 'alias.md'))
    expect(collectSkillTree(skillDir)).toEqual({ ok: false, problem: 'link', paths: ['scripts/alias.md'] })
  })

  it('refuses secret-looking files by core’s filename rule, naming each', () => {
    writeFileSync(join(skillDir, '.env'), 'TOKEN=x')
    writeFileSync(join(skillDir, 'scripts', 'server.pem'), 'key')
    writeFileSync(join(skillDir, '.env.example'), 'TOKEN=')
    expect(collectSkillTree(skillDir)).toEqual({ ok: false, problem: 'secrets', paths: ['.env', 'scripts/server.pem'] })
  })

  it('refuses a folder whose files add up to more than 16 MiB, without reading them', () => {
    writeFileSync(join(skillDir, 'data.bin'), '')
    truncateSync(join(skillDir, 'data.bin'), MAX_SKILL_UPLOAD_BYTES)
    expect(collectSkillTree(skillDir)).toMatchObject({ ok: false, problem: 'too_large' })
  })

  it('refuses more than 2000 files and folders', () => {
    mkdirSync(join(skillDir, 'many'))
    for (let index = 0; index < 1998; index++) writeFileSync(join(skillDir, 'many', `${index}.txt`), '')
    expect(collectSkillTree(skillDir)).toMatchObject({ ok: false, problem: 'too_many_files' })
  })
})

describe('skillTreeHash', () => {
  it('is core’s hash_workspace_tree over skills/<name>/…: path NUL bytes NUL, in path order', () => {
    // Computed with core's algorithm (PublishService.hash_workspace_tree) over
    // a snapshot root holding skills/erp-lookup/{SKILL.md,scripts/run.sh}.
    const files = [
      { path: 'scripts/run.sh', data: Buffer.from('#!/bin/sh\necho hi\n') },
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) }
    ]
    expect(skillTreeHash('erp-lookup', files)).toBe('bf75b2cae131606896b5f8c5349c5b354e607f766239256631cdf36345a2c82a')
  })
})
