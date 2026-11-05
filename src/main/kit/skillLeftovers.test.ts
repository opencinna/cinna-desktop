import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { recoverSkillLeftovers, STALE_STAGING_MS } = await import('./skillLeftovers')

/**
 * What a crash between "move the folder aside" and "rename the staged copy in"
 * leaves in `skills/`, and how it is put right.
 */
let agentDir: string
const skills = (): string => join(agentDir, 'skills')
const NOW = 1_800_000_000_000

function folder(name: string, file = 'SKILL.md', body = name): void {
  mkdirSync(join(skills(), name), { recursive: true })
  writeFileSync(join(skills(), name, file), body)
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'cinna-skill-leftovers-'))
})
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
})

describe('recoverSkillLeftovers', () => {
  it('puts the newest set-aside folder back where the skill is missing', () => {
    folder(`.erp.cinna-previous-1-${NOW - 5000}`, 'SKILL.md', 'older')
    folder(`.erp.cinna-previous-2-${NOW - 1000}`, 'SKILL.md', 'newest')
    expect(recoverSkillLeftovers(agentDir, undefined, NOW)).toEqual({ restored: ['erp'], movedOut: [], removed: 0 })
    expect(readFileSync(join(skills(), 'erp', 'SKILL.md'), 'utf8')).toBe('newest')
    // The older one stays hidden beside it: never deleted while it may hold edits.
    expect(readdirSync(skills()).sort()).toEqual([`.erp.cinna-previous-1-${NOW - 5000}`, 'erp'])
  })

  it('leaves a set-aside folder alone while the skill folder exists', () => {
    folder('erp')
    folder(`.erp.cinna-previous-1-${NOW - 1000}`)
    expect(recoverSkillLeftovers(agentDir, undefined, NOW)).toEqual({ restored: [], movedOut: [], removed: 0 })
    expect(readdirSync(skills()).sort()).toEqual([`.erp.cinna-previous-1-${NOW - 1000}`, 'erp'])
  })

  it('removes staged copies older than the threshold only, and only of the named skill when given', () => {
    folder(`.erp.cinna-staging-1-${NOW - STALE_STAGING_MS - 1}`)
    folder(`.erp.cinna-staging-2-${NOW - 1000}`)
    folder(`.other.cinna-staging-3-${NOW - STALE_STAGING_MS - 1}`)
    folder(`.other.cinna-previous-3-${NOW - 1000}`)
    expect(recoverSkillLeftovers(agentDir, 'erp', NOW)).toEqual({ restored: [], movedOut: [], removed: 1 })
    expect(readdirSync(skills()).sort()).toEqual([
      `.erp.cinna-staging-2-${NOW - 1000}`,
      `.other.cinna-previous-3-${NOW - 1000}`,
      `.other.cinna-staging-3-${NOW - STALE_STAGING_MS - 1}`
    ])
    expect(recoverSkillLeftovers(agentDir, undefined, NOW)).toEqual({ restored: ['other'], movedOut: [], removed: 1 })
  })

  it('moves set-aside copies it does not put back out of the agent, so a removed skill never comes back', () => {
    const backups = join(agentDir, '..', `${agentDir.split('/').pop()}-backups`)
    const backupFor = (skill: string, at: number): string => join(backups, `${skill}-${at}`)
    // A crash after the swap, before the cleanup: the new folder is in place, the old one beside it.
    folder('erp', 'SKILL.md', 'current')
    folder(`.erp.cinna-previous-1-${NOW - 5000}`, 'SKILL.md', 'old')
    // Two set aside for a missing skill: the newest goes back, the older one out.
    folder(`.crm.cinna-previous-1-${NOW - 9000}`, 'SKILL.md', 'crm older')
    folder(`.crm.cinna-previous-2-${NOW - 2000}`, 'SKILL.md', 'crm newest')
    try {
      const swept = recoverSkillLeftovers(agentDir, undefined, NOW, backupFor)
      expect(swept.restored).toEqual(['crm'])
      expect(swept.movedOut.sort()).toEqual([backupFor('crm', NOW - 9000), backupFor('erp', NOW - 5000)].sort())
      expect(readdirSync(skills()).sort()).toEqual(['crm', 'erp'])
      expect(readFileSync(join(skills(), 'crm', 'SKILL.md'), 'utf8')).toBe('crm newest')
      expect(readFileSync(join(backupFor('erp', NOW - 5000), 'SKILL.md'), 'utf8')).toBe('old')
      // The person now removes erp on purpose: nothing brings it back.
      rmSync(join(skills(), 'erp'), { recursive: true })
      expect(recoverSkillLeftovers(agentDir, undefined, NOW, backupFor).restored).toEqual([])
      expect(readdirSync(skills())).toEqual(['crm'])
    } finally {
      rmSync(backups, { recursive: true, force: true })
    }
  })

  it('does nothing without a skills folder', () => {
    expect(recoverSkillLeftovers(agentDir)).toEqual({ restored: [], movedOut: [], removed: 0 })
  })
})
