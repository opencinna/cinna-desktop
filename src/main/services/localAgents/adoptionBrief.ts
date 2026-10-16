/**
 * The first message of an adoption session — Bring together — written by the
 * app in the user's voice to the agent.
 *
 * Pure: no git, no Electron, no file system. `sharingService` reads the two
 * sides from git (`readVersionsBetween`, `diffBetween`) and this turns them
 * into one message the renderer sends through the ordinary chat path. Visible
 * rather than a system-prompt injection: the user can read what was asked,
 * and every engine gets the same words.
 *
 * The fixed wording is held to `FORBIDDEN_SHARE_WORDS`: the user reads the
 * agent's reply, and the agent echoes the words it was given. A diff's own
 * content is not held to it — it is the user's and the team's text.
 */
import type { AdoptionVersion } from './gitService'

/** The heading the agent is asked to end with; `liftAdoptionSummary` reads what follows it. */
export const ADOPTION_SUMMARY_HEADING = 'Summary of what I did'

/** Most of one file's change the brief carries. */
export const MAX_FILE_DIFF_CHARS = 6_000

/** Most of the whole brief; the asks are never cut, the diffs are. */
export const MAX_BRIEF_CHARS = 40_000

/** Most of the agent's summary lifted into the recorded version's note. */
const MAX_SUMMARY_CHARS = 1_500

export interface FileDiff {
  path: string
  diff: string
}

export interface AdoptionBriefInput {
  /** The team's versions since the two sides last matched, oldest first. */
  teamVersions: AdoptionVersion[]
  /** This folder's versions since then, oldest first. */
  mineVersions: AdoptionVersion[]
  /** What the team changed, per file. */
  teamDiff: FileDiff[]
  /** What this folder changed, per file. */
  mineDiff: FileDiff[]
}

/**
 * The files whose content the agent reads: anything that tells it what to do.
 * Every other changed file is named, not shown.
 */
export function carriesInstructions(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    lower.endsWith('.md') ||
    lower === 'cinna-agent.json' ||
    lower.startsWith('skills/') ||
    lower.startsWith('knowledge/') ||
    lower.startsWith('config/')
  )
}

const OPENING = [
  'The team changed this agent while I was changing it too, and the app has just put both sets of changes into this folder.',
  'They were combined line by line, without anyone reading what they mean, so I need you to read both sides and make the instructions consistent again.'
].join(' ')

const ASKS = [
  '## What I need from you',
  '',
  '1. Find where the two sides disagree — the same fact stated two ways — or overlap — the same rule twice, in different words or places — and where my changes landed in a structure the team changed.',
  '2. A business fact the two sides state differently is asked, never guessed: ask me, using the team’s notes above as the context for the question.',
  '3. Make the edits so one consistent set of instructions remains.',
  '4. Do not run version-control commands; the app records and shares the result.',
  '5. Do not change the `id` in `cinna-agent.json`.',
  '6. Do not touch `credentials/` or `app-data/`.',
  `7. End your reply with a section headed exactly \`${ADOPTION_SUMMARY_HEADING}\`.`
].join('\n')

function versionLine(version: AdoptionVersion): string {
  const files = version.files.length > 0 ? ` (${version.files.join(', ')})` : ''
  return `- ${version.note || 'No note'} — ${version.author || 'Unknown'}, ${version.date}${files}`
}

function versionList(versions: AdoptionVersion[], none: string): string {
  return versions.length === 0 ? none : versions.map(versionLine).join('\n')
}

/** One file's change, cut to {@link MAX_FILE_DIFF_CHARS} with a line saying how much was left out. */
function cappedDiff(diff: string): string {
  if (diff.length <= MAX_FILE_DIFF_CHARS) return diff
  const kept = diff.slice(0, MAX_FILE_DIFF_CHARS)
  const cut = kept.lastIndexOf('\n')
  const shown = cut > 0 ? kept.slice(0, cut) : kept
  const hidden = diff.slice(shown.length).split('\n').filter((line) => line !== '').length
  return `${shown}\n… (${hidden} more lines not shown)`
}

interface DiffSection {
  heading: string
  /** The fenced blocks, one per instruction-bearing file. */
  blocks: string[]
  /** The one line naming every other changed file; '' when none. */
  others: string
  none: string
}

function diffSection(heading: string, diffs: FileDiff[], none: string): DiffSection {
  const shown = diffs.filter((entry) => carriesInstructions(entry.path))
  const named = diffs.filter((entry) => !carriesInstructions(entry.path)).map((entry) => entry.path)
  return {
    heading,
    blocks: shown.map((entry) => `\`${entry.path}\`\n\n\`\`\`diff\n${cappedDiff(entry.diff)}\n\`\`\``),
    others: named.length > 0 ? `Other files changed, not shown here: ${named.join(', ')}.` : '',
    none
  }
}

/**
 * The brief. Shape: what is happening; the team's versions and what they
 * changed; mine and what I changed; the asks. Every fixed sentence passes
 * `forbiddenShareWordPattern()` (the test reads the brief built from empty
 * and innocuous inputs). Capped at {@link MAX_BRIEF_CHARS}: when the diffs do
 * not fit, the ones that remain are replaced by one line saying how many
 * files were left out, and the asks are never dropped.
 */
export function buildAdoptionBrief(input: AdoptionBriefInput): string {
  const team = diffSection('### What the team changed', input.teamDiff, 'The team changed no files.')
  const mine = diffSection('### What I changed', input.mineDiff, 'I changed no files.')
  const head = [
    OPENING,
    '',
    '## The team’s versions since we last matched',
    '',
    versionList(input.teamVersions, 'The team recorded no versions since then.'),
    ''
  ]
  const middle = ['', '## My versions since then', '', versionList(input.mineVersions, 'I recorded no versions since then.'), '']
  const tail = ['', ASKS, '']

  // What the diffs may take: everything else is fixed and never cut.
  const fixed = [...head, team.heading, '', middle, mine.heading, '', tail].flat().join('\n').length
  let budget = MAX_BRIEF_CHARS - fixed
  const render = (section: DiffSection): string[] => {
    const parts: string[] = []
    if (section.blocks.length === 0 && section.others === '') return [section.none]
    let left = 0
    for (const block of section.blocks) {
      if (block.length + 2 <= budget) {
        parts.push(block, '')
        budget -= block.length + 2
      } else {
        left += 1
      }
    }
    if (left > 0) {
      const line = `… ${left} more ${left === 1 ? 'file is' : 'files are'} not shown here; read ${left === 1 ? 'it' : 'them'} in the folder.`
      parts.push(line, '')
      budget -= line.length + 2
    }
    if (section.others !== '') parts.push(section.others)
    return parts
  }
  const teamBody = render(team)
  const mineBody = render(mine)
  return [...head, team.heading, '', ...teamBody, ...middle, mine.heading, '', ...mineBody, ...tail].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** `## Summary of what I did`, `**Summary of what I did:**`, `**Summary of what I did**:`, or the bare line. */
const SUMMARY_HEADING_LINE = /^#{0,6}\s*\**\s*Summary of what I did\s*:?\s*\**\s*:?\s*$/im

/**
 * The agent's own summary: the text after the line that is the
 * {@link ADOPTION_SUMMARY_HEADING} (as a markdown heading, bold, or bare,
 * with or without a colon), trimmed, at most {@link MAX_SUMMARY_CHARS}. Null
 * when the heading is absent or nothing follows it.
 */
export function liftAdoptionSummary(text: string): string | null {
  const match = SUMMARY_HEADING_LINE.exec(text)
  if (!match) return null
  const after = text.slice(match.index + match[0].length).trim()
  if (after === '') return null
  return after.slice(0, MAX_SUMMARY_CHARS)
}
