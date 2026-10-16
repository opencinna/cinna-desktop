import { describe, it, expect } from 'vitest'
import { forbiddenShareWordPattern } from '../../../shared/agentSharing'
import {
  ADOPTION_SUMMARY_HEADING,
  MAX_BRIEF_CHARS,
  MAX_FILE_DIFF_CHARS,
  buildAdoptionBrief,
  carriesInstructions,
  liftAdoptionSummary
} from './adoptionBrief'

/**
 * The first message of an adoption session: what it says, what it holds back,
 * and the words it never uses. Pure, so no git here — `sharingService.test.ts`
 * proves what goes in from real repositories.
 */

const EMPTY = { teamVersions: [], mineVersions: [], teamDiff: [], mineDiff: [] }

const version = (note: string, files: string[]) => ({ note, author: 'Bea', date: '2026-10-16T10:00:00Z', files })

const fileDiff = (path: string, body: string) => ({
  path,
  diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${body}`
})

const INNOCUOUS = {
  teamVersions: [version('Adds the payment terms', ['knowledge/terms.md', 'scripts/run.py'])],
  mineVersions: [version('Changes made before bringing the team’s version in', ['AGENT.md'])],
  teamDiff: [fileDiff('knowledge/terms.md', 'Net 30.'), fileDiff('scripts/run.py', 'print(1)')],
  mineDiff: [fileDiff('AGENT.md', 'Line three.')]
}

describe('the adoption brief', () => {
  it('says nothing the sharing surfaces never say — with empty inputs and with innocuous ones', () => {
    const pattern = forbiddenShareWordPattern()
    for (const brief of [buildAdoptionBrief(EMPTY), buildAdoptionBrief(INNOCUOUS)]) {
      for (const line of brief.split('\n')) expect(line).not.toMatch(pattern)
    }
  })

  it('lists each version with its note, author, date and files, shows instruction-bearing changes and names the rest', () => {
    const brief = buildAdoptionBrief(INNOCUOUS)
    expect(brief).toContain('## The team’s versions since we last matched')
    expect(brief).toContain('- Adds the payment terms — Bea, 2026-10-16T10:00:00Z (knowledge/terms.md, scripts/run.py)')
    expect(brief).toContain('### What the team changed')
    expect(brief).toContain('`knowledge/terms.md`\n\n```diff\ndiff --git a/knowledge/terms.md')
    expect(brief).toContain('+Net 30.')
    expect(brief).toContain('Other files changed, not shown here: scripts/run.py.')
    expect(brief).not.toContain('print(1)')
    expect(brief).toContain('## My versions since then')
    expect(brief).toContain('- Changes made before bringing the team’s version in — Bea, 2026-10-16T10:00:00Z (AGENT.md)')
    expect(brief).toContain('### What I changed')
    expect(brief).toContain('+Line three.')
    // The asks, in order, ending with the heading the summary is lifted from.
    const asks = brief.slice(brief.indexOf('## What I need from you'))
    expect(asks.indexOf('disagree')).toBeLessThan(asks.indexOf('never guessed'))
    expect(asks.indexOf('never guessed')).toBeLessThan(asks.indexOf('one consistent set of instructions'))
    expect(asks.indexOf('one consistent set')).toBeLessThan(asks.indexOf('version-control commands'))
    expect(asks).toContain('`id` in `cinna-agent.json`')
    expect(asks).toContain('`credentials/` or `app-data/`')
    expect(asks.trim().endsWith(`\`${ADOPTION_SUMMARY_HEADING}\`.`)).toBe(true)
  })

  it('says so in one line when a side has nothing', () => {
    const brief = buildAdoptionBrief(EMPTY)
    expect(brief).toContain('The team recorded no versions since then.')
    expect(brief).toContain('The team changed no files.')
    expect(brief).toContain('I recorded no versions since then.')
    expect(brief).toContain('I changed no files.')
    expect(brief).toContain('## What I need from you')
  })

  it('knows which files carry instructions', () => {
    for (const path of ['AGENT.md', 'docs/WORKFLOW_PROMPT.md', 'cinna-agent.json', 'skills/x/SKILL.md', 'knowledge/a.csv', 'config/rules.yaml']) {
      expect(carriesInstructions(path)).toBe(true)
    }
    for (const path of ['scripts/run.py', 'pyproject.toml', 'files/report.pdf', '.gitignore']) {
      expect(carriesInstructions(path)).toBe(false)
    }
  })

  it('cuts one file’s change at the cap and says how many lines were left out', () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `+line ${i} of a long change`)
    const diff = `diff --git a/AGENT.md b/AGENT.md\n${lines.join('\n')}`
    const brief = buildAdoptionBrief({ ...EMPTY, teamDiff: [{ path: 'AGENT.md', diff }] })
    const block = brief.slice(brief.indexOf('```diff'), brief.indexOf('\n```', brief.indexOf('```diff')))
    expect(block.length).toBeLessThanOrEqual(MAX_FILE_DIFF_CHARS + 60)
    expect(block).toMatch(/\n… \(\d+ more lines not shown\)$/)
    expect(block).not.toContain('+line 999 ')
  })

  it('keeps the whole brief under its cap by leaving files out, never the asks', () => {
    const body = Array.from({ length: 150 }, (_, i) => `+line ${i}`).join('\n')
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `knowledge/file-${i}.md`, diff: `diff --git a/f b/f\n${body}` }))
    const brief = buildAdoptionBrief({ ...EMPTY, teamDiff: many, mineDiff: many.slice(0, 5) })
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
    expect(brief).toMatch(/… \d+ more files are not shown here; read them in the folder\./)
    expect(brief).toContain('## My versions since then')
    expect(brief).toContain('## What I need from you')
    expect(brief.trim().endsWith(`\`${ADOPTION_SUMMARY_HEADING}\`.`)).toBe(true)
  })

  it('lifts the summary after its heading — as a heading, bold, or bare — and null when absent or empty', () => {
    expect(liftAdoptionSummary('I read both sides.\n\n## Summary of what I did\n\nKept one rule.\nRemoved the other.\n')).toBe(
      'Kept one rule.\nRemoved the other.'
    )
    expect(liftAdoptionSummary('Done.\n\n**Summary of what I did:**\nMerged nothing.')).toBe('Merged nothing.')
    expect(liftAdoptionSummary('Done.\n\nsummary of what I did\nOne line.')).toBe('One line.')
    expect(liftAdoptionSummary('No heading here.')).toBeNull()
    expect(liftAdoptionSummary('## Summary of what I did\n\n   \n')).toBeNull()
    expect(liftAdoptionSummary('')).toBeNull()
    // Capped: a long summary does not become a long version note.
    const long = `## Summary of what I did\n${'x'.repeat(5_000)}`
    expect(liftAdoptionSummary(long)?.length).toBe(1_500)
  })
})
