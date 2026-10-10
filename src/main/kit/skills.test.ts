import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ISSUE_MESSAGES,
  PLATFORM_SKILL_NAMES,
  agentSkillRows,
  catalogSkillName,
  catalogSkillRows,
  coerceVersion,
  skillVersionProblem,
  deliverableSkills,
  isSecretFilename,
  parseCredentialDeclarations,
  parseSkillFrontmatter,
  scanAgentSkills
} from './skills'
import { TASKS_SKILL_NAME } from '../services/tasksSkillService'

/**
 * A kit agent's own skills, read the way cinna-core's `skill_manifest.py`
 * reads them. The cases are ported from core's tests of that module: the same
 * folder must get the same codes on both sides, because the kit validator core
 * ships next is that module.
 */

let agent: string

function skill(name: string, text: string | null, extra: Record<string, string> = {}): string {
  const dir = join(agent, 'skills', name)
  mkdirSync(dir, { recursive: true })
  if (text !== null) writeFileSync(join(dir, 'SKILL.md'), text)
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const md = (front: string, body = '# Body\n'): string => `---\n${front}\n---\n\n${body}`

function only(name: string) {
  const found = scanAgentSkills(agent).find((entry) => entry.name === name)
  if (!found) throw new Error(`no skill ${name}`)
  return found
}

const codes = (name: string): string[] => only(name).issues.map((issue) => issue.code)

beforeEach(() => {
  agent = mkdtempSync(join(tmpdir(), 'cinna-skills-'))
})

afterEach(() => {
  rmSync(agent, { recursive: true, force: true })
})

describe('frontmatter', () => {
  it('reads scalars, flow and block sequences, block scalars and nested mappings', () => {
    const { frontmatter, body } = parseSkillFrontmatter([
      '---',
      'name: pdf-tools',
      'description: >',
      '  Fill and',
      '  merge PDFs.',
      'tags: [a, b, "c"]',
      'allowed:',
      '  - Bash(git:*)',
      '  - http://host/x',
      'metadata:',
      '  owner: ops',
      'flag: yes',
      'count: 3',
      'empty: ~',
      '# a comment',
      '---',
      '',
      '',
      '# Body'
    ].join('\n'))
    expect(frontmatter).toEqual({
      name: 'pdf-tools',
      description: 'Fill and merge PDFs.',
      tags: ['a', 'b', 'c'],
      allowed: ['Bash(git:*)', 'http://host/x'],
      metadata: { owner: 'ops' },
      flag: true,
      count: 3n,
      empty: null
    })
    expect(body).toBe('# Body')
  })

  it('keeps an inline comment and splits a flow sequence on every comma, as core does', () => {
    const { frontmatter } = parseSkillFrontmatter('---\nname: foo # note\ntags: ["a, b", c]\n---\n')
    expect(frontmatter.name).toBe('foo # note')
    expect(frontmatter.tags).toEqual(['"a', 'b"', 'c'])
  })

  it('reads `- key: value` items as one mapping each, extended by the indented lines after', () => {
    const { frontmatter } = parseSkillFrontmatter([
      '---',
      'credentials:',
      '  - slot: gmail',
      '    type: gmail_oauth',
      '    description: Mail',
      '  - slot: "8080"',
      '    type: api_token',
      '---'
    ].join('\n'))
    expect(frontmatter.credentials).toEqual([
      { slot: 'gmail', type: 'gmail_oauth', description: 'Mail' },
      { slot: '8080', type: 'api_token' }
    ])
  })

  it('refuses a document with no fence or an unclosed one', () => {
    expect(() => parseSkillFrontmatter('name: x\n')).toThrow()
    expect(() => parseSkillFrontmatter('---\nname: x\n')).toThrow()
    expect(parseSkillFrontmatter('---\nname: x\n...\nbody').frontmatter).toEqual({ name: 'x' })
  })

  it('coerces a version the way core does: one line, numbers as Python prints them', () => {
    expect(coerceVersion('1.2.0')).toBe('1.2.0')
    expect(coerceVersion(1n)).toBe('1')
    expect(coerceVersion(1)).toBe('1.0')
    expect(coerceVersion(1.5)).toBe('1.5')
    expect(coerceVersion(true)).toBeNull()
    expect(coerceVersion(['1'])).toBeNull()
    expect(coerceVersion('1\n2')).toBeNull()
    expect(coerceVersion('x'.repeat(80))).toBe('x'.repeat(64))
  })
})

describe('credential declarations', () => {
  it('normalises valid slots', () => {
    expect(parseCredentialDeclarations([{ slot: ' api.example.com/v1 ', type: 'api_token', description: ' ' }])).toEqual({
      credentials: [{ slot: 'api.example.com/v1', type: 'api_token', description: null }],
      problem: null
    })
    expect(parseCredentialDeclarations(undefined)).toEqual({ credentials: [], problem: null })
    expect(parseCredentialDeclarations('')).toEqual({ credentials: [], problem: null })
  })

  it.each([
    ['nope', 'it must be a list of entries, each with a slot and a type'],
    [['x'], 'entry 1 is not a mapping with a slot and a type'],
    [[{ slot: 8080n, type: 'api_token' }], 'entry 1: slot must be text; quote it in SKILL.md'],
    [[{ type: 'api_token' }], 'entry 1 has no slot'],
    [[{ slot: 'has space', type: 'api_token' }], "the slot 'has space' is not a valid service URI (letters, digits and . _ : / @ + -, no spaces)"],
    [[{ slot: 'a', type: 'api_token' }, { slot: 'a', type: 'api_token' }], "the slot 'a' is declared twice"],
    [[{ slot: 'a' }], "the slot 'a' has no type"],
    [[{ slot: 'a', type: 'mcp_provider' }], "the slot 'a' has type 'mcp_provider', which a skill cannot declare"],
    [[{ slot: 'a', type: 'telepathy' }], "the slot 'a' has an unknown type 'telepathy'"],
    [[{ slot: 'a', type: 'api_token', description: 3n }], "the description of the slot 'a' must be text; quote it in SKILL.md"]
  ])('names the first problem: $1', (raw, problem) => {
    expect(parseCredentialDeclarations(raw as never)).toEqual({ credentials: [], problem })
  })

  it('caps the number of slots', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ slot: `s${i}`, type: 'api_token' }))
    expect(parseCredentialDeclarations(many).problem).toBe('it declares more than 20 credentials')
  })
})

describe('scanning an agent’s skills', () => {
  it('has no skills without a skills/ folder, or with one that is a file', () => {
    expect(scanAgentSkills(agent)).toEqual([])
    writeFileSync(join(agent, 'skills'), 'not a folder')
    expect(scanAgentSkills(agent)).toEqual([])
  })

  it('reads a valid skill as deliverable, with its version and credential slots', () => {
    skill('pdf-tools', md([
      'name: pdf-tools',
      'description: Fill and merge PDFs.',
      'version: 1.0',
      'credentials:',
      '  - slot: docs.example.com',
      '    type: api_token',
      '    description: The docs API'
    ].join('\n')))
    expect(scanAgentSkills(agent)).toEqual([{
      name: 'pdf-tools',
      description: 'Fill and merge PDFs.',
      version: '1.0',
      source: 'authored',
      path: 'skills/pdf-tools/SKILL.md',
      deliverable: true,
      issues: [],
      credentials: [{ slot: 'docs.example.com', type: 'api_token', description: 'The docs API' }]
    }])
  })

  it('reads a SKILL.md that starts with a byte-order mark', () => {
    skill('bom', `﻿${md('name: bom\ndescription: With a BOM.')}`)
    expect(only('bom').deliverable).toBe(true)
  })

  it('delivers only a skill whose name matches its folder and which has a description', () => {
    // Claude names a plugin skill by its folder and OpenCode by its frontmatter
    // name: a mismatched pair would be two different skills.
    skill('folder-name', md('name: other-name\ndescription: Mismatched.'))
    skill('no-description', md('name: no-description'))
    expect(codes('folder-name')).toEqual(['name_mismatch'])
    expect(codes('no-description')).toEqual(['missing_description'])
    expect(deliverableSkills(scanAgentSkills(agent))).toEqual([])
  })

  it.each([
    ['missing_skill_md', 'no-file', null],
    ['invalid_frontmatter', 'no-fence', '# just markdown\n'],
    ['missing_name', 'no-name', md('description: x')],
    ['invalid_name', 'bad-name', md('name: Bad_Name\ndescription: x')],
    ['reserved_name', 'run', md('name: run\ndescription: x')],
    ['description_too_long', 'long', md(`name: long\ndescription: ${'x'.repeat(1025)}`)],
    ['invalid_credentials', 'creds', md('name: creds\ndescription: x\ncredentials: nope')]
  ])('flags %s and keeps the skill out', (code, name, text) => {
    skill(name, text)
    const entry = only(name)
    expect(entry.deliverable).toBe(false)
    expect(entry.issues).toEqual([{ code, message: expect.any(String), severity: 'error' }])
    if (code !== 'invalid_credentials') expect(entry.issues[0].message).toBe(ISSUE_MESSAGES[code])
  })

  it('says what is wrong with a credentials block', () => {
    skill('creds', md('name: creds\ndescription: x\ncredentials:\n  - slot: a\n    type: telepathy'))
    expect(only('creds').issues[0].message).toBe(
      "The credentials block in SKILL.md is invalid: the slot 'a' has an unknown type 'telepathy'."
    )
  })

  it('reserves the platform’s own skill name', () => {
    expect(PLATFORM_SKILL_NAMES.has(TASKS_SKILL_NAME)).toBe(true)
    skill(TASKS_SKILL_NAME, md(`name: ${TASKS_SKILL_NAME}\ndescription: Mine.`))
    expect(only(TASKS_SKILL_NAME).issues).toEqual([
      { code: 'reserved_name', message: 'This name is reserved by a platform skill.', severity: 'error' }
    ])
  })

  it('flags a SKILL.md that is not UTF-8 as unreadable', () => {
    const dir = skill('latin', null)
    writeFileSync(join(dir, 'SKILL.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]))
    expect(codes('latin')).toEqual(['unreadable'])
  })

  it('warns, without withholding the skill, about credential-looking files and an oversized body', () => {
    skill('leaky', md('name: leaky\ndescription: x', 'y'.repeat(64 * 1024 + 1)), {
      'scripts/.env': 'K=v',
      'keys/server.pem': 'x',
      '.env.example': 'K=',
      'node_modules/id_rsa': 'skipped'
    })
    const entry = only('leaky')
    expect(entry.deliverable).toBe(true)
    expect(entry.issues).toEqual([
      { code: 'secrets', message: ISSUE_MESSAGES.secrets, severity: 'warning', paths: ['keys/server.pem', 'scripts/.env'] },
      { code: 'oversized', message: ISSUE_MESSAGES.oversized, severity: 'warning' }
    ])
  })

  it('warns, without withholding the skill, about links inside it, which Share refuses', () => {
    const dir = skill('linky', md('name: linky\ndescription: x'), { 'notes-real.md': 'n', 'docs/a.md': 'a' })
    symlinkSync(join(dir, 'notes-real.md'), join(dir, 'notes.md'))
    symlinkSync(join(dir, 'docs'), join(dir, 'more-docs'), 'dir')
    const entry = only('linky')
    expect(entry.deliverable).toBe(true)
    expect(entry.issues).toEqual([
      { code: 'links', message: ISSUE_MESSAGES.links, severity: 'warning', paths: ['more-docs', 'notes.md'] }
    ])
  })

  it('matches core’s secret filenames', () => {
    for (const name of ['.env', '.env.local', 'prod.env', 'credentials.json', 'id_ed25519', 'a.key', 'b.p12']) {
      expect(isSecretFilename(name), name).toBe(true)
    }
    for (const name of ['.env.example', 'prod.env.sample', 'README.md', 'environment.txt']) {
      expect(isSecretFilename(name), name).toBe(false)
    }
  })

  it('skips plain files and dot-folders at the root, and refuses a symlinked folder', () => {
    mkdirSync(join(agent, 'skills'), { recursive: true })
    writeFileSync(join(agent, 'skills', 'README.md'), '# Skills\n')
    skill('.hidden', md('name: hidden\ndescription: x'))
    const real = mkdtempSync(join(tmpdir(), 'cinna-skill-elsewhere-'))
    try {
      writeFileSync(join(real, 'SKILL.md'), md('name: linked\ndescription: x'))
      symlinkSync(real, join(agent, 'skills', 'linked'), 'dir')
      expect(scanAgentSkills(agent).map((entry) => [entry.name, entry.issues.map((i) => i.code)])).toEqual([
        ['linked', ['not_a_directory']]
      ])
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('applies the budget in name order, and a broken skill costs nothing', () => {
    skill('a-broken', md('name: a-broken'))
    skill('b-first', md('name: b-first\ndescription: x'))
    skill('c-second', md('name: c-second\ndescription: x'))
    const entries = scanAgentSkills(agent, { maxSkills: 1 })
    expect(entries.map((entry) => [entry.name, entry.deliverable, entry.issues.map((i) => i.code)])).toEqual([
      ['a-broken', false, ['missing_description']],
      ['b-first', true, []],
      ['c-second', false, ['budget']]
    ])
    expect(scanAgentSkills(agent, { maxTotalBytes: 10 }).filter((entry) => entry.deliverable)).toEqual([])
  })
})

describe('kit.py parity (contract 1.10.0)', () => {
  it('reserves exactly the platform skills the bundled kit.json names', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
    const kit = JSON.parse(readFileSync(join(repoRoot, 'resources/cinna-agent-kit/kit.json'), 'utf8')) as { platform_skills: Record<string, string> }
    expect([...PLATFORM_SKILL_NAMES].sort()).toEqual(Object.keys(kit.platform_skills).sort())
  })

  it('says why a version would not be kept as written, as skill_version_problem does', () => {
    expect(skillVersionProblem(undefined)).toBeNull()
    expect(skillVersionProblem(null)).toBeNull()
    expect(skillVersionProblem(2n)).toBeNull()
    expect(skillVersionProblem(1.5)).toBeNull()
    expect(skillVersionProblem('1.2.0')).toBeNull()
    expect(skillVersionProblem('')).toBeNull()
    expect(skillVersionProblem(true)).toMatch(/one line of text/)
    expect(skillVersionProblem(['1'])).toMatch(/one line of text/)
    expect(skillVersionProblem('1\t2')).toMatch(/one line of text/)
    expect(skillVersionProblem('v'.repeat(65))).toMatch(/longer than 64/)
    // Code points, as Python counts: 64 emoji are 128 UTF-16 units and still fine.
    expect(skillVersionProblem('😀'.repeat(64))).toBeNull()
  })

  it('reads the skill name a package id carries, as catalog_skill_name does', () => {
    expect(catalogSkillName('io.example.team.skill.pdf-report')).toBe('pdf-report')
    expect(catalogSkillName('io.example.team.skill.csv-export.1a2b3c4d')).toBe('csv-export')
    expect(catalogSkillName('io.skill.example.skill.Bad_Name')).toBeNull()
    expect(catalogSkillName('io.example.skill')).toBeNull()
    expect(catalogSkillName('com.example.reports')).toBeNull()
    expect(catalogSkillName(7)).toBeNull()
  })
})

describe('catalog skill rows', () => {
  const PIN = {
    package_id: 'io.example.team.skill.csv-export',
    package_uuid: '6f1e2d3c-4b5a-4968-8776-655443322110',
    name: 'csv-export',
    revision_number: 4,
    version: '2.0.0',
    archive_sha256: 'a'.repeat(64)
  }

  it('lists each pin as a catalog row that is never deliverable, flagged as not on this computer', () => {
    expect(catalogSkillRows({ catalog_skills: [PIN] }, new Set())).toEqual([{
      name: 'csv-export',
      description: '',
      version: '2.0.0',
      source: 'catalog',
      path: '',
      deliverable: false,
      issues: [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' }],
      credentials: [],
      packageId: 'io.example.team.skill.csv-export',
      packageUuid: '6f1e2d3c-4b5a-4968-8776-655443322110',
      revisionNumber: 4
    }])
  })

  it('puts a name clash on the pin’s own row, and skips pins with no usable name', () => {
    const rows = catalogSkillRows({
      catalog_skills: [
        { ...PIN, name: 'pdf-tools' },
        { ...PIN, name: 'cinna-tasks' },
        PIN,
        PIN,
        { ...PIN, name: 'Not_A_Name' },
        'nope'
      ]
    }, new Set(['pdf-tools']))
    expect(rows.map((row) => [row.name, row.issues.map((i) => `${i.severity}:${i.code}`)])).toEqual([
      ['pdf-tools', ['error:name_clash', 'warning:not_downloaded']],
      ['cinna-tasks', ['error:reserved_name', 'warning:not_downloaded']],
      ['csv-export', ['warning:not_downloaded']],
      ['csv-export', ['error:duplicate_pin', 'warning:not_downloaded']]
    ])
    expect(catalogSkillRows({}, new Set())).toEqual([])
    expect(catalogSkillRows({ catalog_skills: 'nope' }, new Set())).toEqual([])
    expect(catalogSkillRows({ catalog_skills: [{ ...PIN, version: 7, revision_number: 0 }] }, new Set())[0])
      .toMatchObject({ version: null, revisionNumber: null })
  })

  it('merges own and catalog rows by name, and only the own ones are what engines read', () => {
    skill('zeta', md('name: zeta\ndescription: z'))
    skill('alpha', md('name: alpha\ndescription: a'))
    const rows = agentSkillRows(agent, { catalog_skills: [PIN, { ...PIN, name: 'zeta', package_uuid: '0b5c1f8e-6a43-4d7e-9a51-2f0c7d1e9b34' }] })
    expect(rows.map((row) => [row.name, row.source])).toEqual([
      ['alpha', 'authored'],
      ['csv-export', 'catalog'],
      ['zeta', 'authored'],
      ['zeta', 'catalog']
    ])
    expect(deliverableSkills(rows).map((row) => row.name)).toEqual(['alpha', 'zeta'])
    expect(scanAgentSkills(agent).map((row) => row.source)).toEqual(['authored', 'authored'])
  })

  describe('with the cache as resolver', () => {
    /** A cached copy of a skill, outside the agent folder. */
    function cached(name: string, text: string): string {
      const dir = join(agent, '..', `${agent.split('/').pop()}-cache`, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), text)
      return dir
    }
    afterEach(() => rmSync(join(agent, '..', `${agent.split('/').pop()}-cache`), { recursive: true, force: true }))

    it('delivers a cached revision that passes the per-skill checks, with its own description, slots and absolute path', () => {
      const dir = cached('csv-export', md('name: csv-export\ndescription: Export CSV.\ncredentials:\n  - slot: erp-api\n    type: api_token'))
      const seen: unknown[] = []
      const rows = catalogSkillRows({ catalog_skills: [PIN] }, new Set(), (ref) => {
        seen.push(ref)
        return { state: 'ready', dir }
      })
      expect(seen).toEqual([{ packageUuid: PIN.package_uuid, revisionNumber: 4, name: 'csv-export', archiveSha256: PIN.archive_sha256 }])
      expect(rows[0]).toMatchObject({
        source: 'catalog',
        deliverable: true,
        description: 'Export CSV.',
        version: '2.0.0',
        path: join(dir, 'SKILL.md'),
        issues: [],
        credentials: [{ slot: 'erp-api', type: 'api_token', description: null }]
      })
    })

    it('keeps a cached copy that breaks the rules, or whose name clashes, from every engine', () => {
      const wrong = cached('csv-export', md('name: other-name\ndescription: x'))
      expect(catalogSkillRows({ catalog_skills: [PIN] }, new Set(), () => ({ state: 'ready', dir: wrong }))[0]).toMatchObject({
        deliverable: false,
        issues: [{ code: 'name_mismatch', severity: 'error' }]
      })
      const good = cached('csv-export', md('name: csv-export\ndescription: x'))
      const clash = catalogSkillRows({ catalog_skills: [PIN] }, new Set(['csv-export']), () => ({ state: 'ready', dir: good }))[0]
      expect(clash.deliverable).toBe(false)
      expect(clash.issues.map((issue) => issue.code)).toEqual(['name_clash'])
    })

    it('says why the last download failed, and stays undelivered while missing', () => {
      const failed = catalogSkillRows({ catalog_skills: [PIN] }, new Set(), () => ({ state: 'failed', message: 'Not yours yet.' }))[0]
      expect(failed).toMatchObject({ deliverable: false, path: '', issues: [{ code: 'download_failed', message: 'Not yours yet.', severity: 'warning' }] })
      const missing = catalogSkillRows({ catalog_skills: [PIN] }, new Set(), () => ({ state: 'missing' }))[0]
      expect(missing.issues.map((issue) => issue.code)).toEqual(['not_downloaded'])
      expect(deliverableSkills(agentSkillRows(agent, { catalog_skills: [PIN] }, () => { throw new Error('boom') }))).toEqual([])
    })
  })
})
