import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSkillPublication, readSkillPublications, upsertSkillPublication, type SkillPublication } from './publications'

/**
 * `publications.json` `skills[]` (contract 1.10.0): where an agent's own
 * skills were shared. Written after a share; every other key of the ledger —
 * the agent's own `publications`, unknown keys — must survive the write.
 */

let dir: string
const file = (): string => join(dir, 'publications.json')
const read = (): Record<string, unknown> => JSON.parse(readFileSync(file(), 'utf8'))

const ENTRY: SkillPublication = {
  platform_url: 'https://cinna.test',
  name: 'erp-lookup',
  package_id: 'test.cinna.skill.erp-lookup',
  package_uuid: '0b6f3c1e-1111-4222-8333-444455556666',
  revision_number: 1,
  content_hash: 'abc'
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-publications-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('upsertSkillPublication', () => {
  it('creates the file with an empty publications array when there is none', () => {
    upsertSkillPublication(dir, ENTRY)
    expect(read()).toEqual({ publications: [], skills: [ENTRY] })
    expect(readFileSync(file(), 'utf8').endsWith('}\n')).toBe(true)
  })

  it('replaces the entry of the same server and name, keeping its unknown keys and every other key of the file', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        publications: [{ platform_url: 'https://cinna.test', agent_id: 'a1' }],
        future_key: { kept: true },
        skills: [
          { ...ENTRY, note: 'mine' },
          { ...ENTRY, platform_url: 'https://other.test' },
          { ...ENTRY, name: 'other-skill' }
        ]
      })
    )
    upsertSkillPublication(dir, { ...ENTRY, platform_url: 'https://cinna.test/', revision_number: 2, content_hash: 'def' })
    const document = read()
    expect(document.publications).toEqual([{ platform_url: 'https://cinna.test', agent_id: 'a1' }])
    expect(document.future_key).toEqual({ kept: true })
    expect(document.skills).toEqual([
      { ...ENTRY, note: 'mine', platform_url: 'https://cinna.test/', revision_number: 2, content_hash: 'def' },
      { ...ENTRY, platform_url: 'https://other.test' },
      { ...ENTRY, name: 'other-skill' }
    ])
  })

  it('adds publications: [] to a file that has none, and appends a new skill', () => {
    writeFileSync(file(), JSON.stringify({ skills: [{ ...ENTRY, name: 'other-skill' }] }))
    upsertSkillPublication(dir, ENTRY)
    expect(read()).toEqual({ skills: [{ ...ENTRY, name: 'other-skill' }, ENTRY], publications: [] })
  })

  it('never overwrites a file that is not a JSON object', () => {
    writeFileSync(file(), '{ not json')
    expect(() => upsertSkillPublication(dir, ENTRY)).toThrow()
    expect(readFileSync(file(), 'utf8')).toBe('{ not json')
    expect(existsSync(join(dir, '.publications.json.tmp'))).toBe(false)
  })
})

describe('readSkillPublications / findSkillPublication', () => {
  it('reads the well-formed entries and finds one by server (trailing slash or not) and name', () => {
    writeFileSync(file(), JSON.stringify({ publications: [], skills: [ENTRY, { name: 'broken' }, 'x'] }))
    expect(readSkillPublications(dir)).toEqual([ENTRY])
    expect(findSkillPublication(dir, 'https://cinna.test/', 'erp-lookup')).toEqual(ENTRY)
    expect(findSkillPublication(dir, 'https://other.test', 'erp-lookup')).toBeNull()
  })

  it('is empty without a file or with a broken one', () => {
    expect(readSkillPublications(dir)).toEqual([])
    writeFileSync(file(), 'nope')
    expect(readSkillPublications(dir)).toEqual([])
  })
})
