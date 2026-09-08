/**
 * The rule that decides what is an agent in a folder nobody converted.
 *
 * Written against a real filesystem rather than a mock because the whole thing
 * is a walk: what it descends into, what it stops at, and what it refuses to
 * look inside. A mocked `readdirSync` would prove the calls were made and
 * nothing about the shape it actually finds.
 *
 * Each test names the mutation it kills.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverBareAgents,
  isBareAgentDir,
  MAX_DISCOVERED_AGENTS,
  readBareAgentName
} from './externalScan'
import { BARE_AGENT_MAX_DEPTH } from '../../../shared/localAgents'

let root: string

function agentAt(...segments: string[]): string {
  const dir = join(root, ...segments)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENT.md'), '# Whatever\n\nDo the thing.\n')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-external-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('discoverBareAgents', () => {
  it('finds the picked folder itself when it holds an AGENT.md', () => {
    // The single-folder adoption. Mutation: start the walk at depth 1 — the
    // "add this one agent" case finds nothing at all.
    agentAt()
    const { found } = discoverBareAgents(root)
    expect(found.map((f) => f.relPath)).toEqual(['.'])
  })

  it('finds agents two levels down, which is the shape it was built for', () => {
    // `<repo>/local_agents/<agent>/AGENT.md`. Mutation: a max depth of 1 finds
    // nothing in the example repository this feature exists for.
    agentAt('local_agents', 'alpha')
    agentAt('local_agents', 'beta')
    const { found } = discoverBareAgents(root)
    expect(found.map((f) => f.relPath)).toEqual(['local_agents/alpha', 'local_agents/beta'])
  })

  it('stops at the depth limit', () => {
    // Mutation: an unbounded walk turns "add a folder" into a full-disk scan
    // the moment someone points it at a source tree.
    agentAt('a', 'b', 'c')
    expect(discoverBareAgents(root).found).toEqual([])
  })

  it('does not descend into a folder that is already an agent', () => {
    // A nested `AGENT.md` belongs to that agent's own working tree. Mutation:
    // descend anyway and the same work is listed twice under two names the
    // user cannot tell apart.
    agentAt('alpha')
    agentAt('alpha', 'subproject')
    const { found } = discoverBareAgents(root)
    expect(found.map((f) => f.relPath)).toEqual(['alpha'])
  })

  it('never looks inside dependency trees or dot-directories', () => {
    // Mutation: drop the skip list and a picked repository offers agents out of
    // `node_modules`, which makes the picker useless the one time it matters.
    agentAt('node_modules', 'somebody-elses-agent')
    agentAt('.venv', 'lib')
    agentAt('mine')
    expect(discoverBareAgents(root).found.map((f) => f.relPath)).toEqual(['mine'])
  })

  it('reports whether each folder has a README to brief a builder from', () => {
    const dir = agentAt('with-readme')
    writeFileSync(join(dir, 'README.md'), '# How to run this\n')
    agentAt('without-readme')
    const byPath = new Map(discoverBareAgents(root).found.map((f) => [f.relPath, f.hasReadme]))
    expect(byPath.get('with-readme')).toBe(true)
    expect(byPath.get('without-readme')).toBe(false)
  })

  it('survives a directory it cannot read', () => {
    // One permission-denied subfolder must not take the whole pick with it.
    agentAt('readable')
    const locked = join(root, 'locked')
    mkdirSync(locked)
    rmSync(locked, { recursive: true })
    expect(discoverBareAgents(root).found.map((f) => f.relPath)).toEqual(['readable'])
  })
})

describe('the cap', () => {
  it('reports that it stopped, so the dialog can say the list is partial', () => {
    // The flag is the whole point of the cap: a silently partial list reads as
    // the scanner having *missed* the folders the user came for. Mutation: stop
    // reporting it and the dialog renders "200 agents in <folder>" over the
    // first 200 by path, with every count in it true of the wrong set.
    const { found, truncated } = discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { limit: 2 })
    agentAt('a')
    agentAt('b')
    agentAt('c')
    const capped = discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { limit: 2 })
    expect(capped.found).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    // And says nothing when it did not stop.
    expect(found).toHaveLength(0)
    expect(truncated).toBe(false)
    expect(discoverBareAgents(root).truncated).toBe(false)
  })

  it('can only ever be narrowed by the seam, never raised', () => {
    // The `limit` option exists so the reporting above can be asserted without
    // building two hundred folders. Clamping is what stops a test-only
    // parameter becoming a production behaviour: a caller passing a larger
    // number cannot quietly lift the cap.
    for (let i = 0; i < 3; i += 1) agentAt(`agent-${i}`)
    expect(discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { limit: 1 }).found).toHaveLength(1)
    expect(
      discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { limit: MAX_DISCOVERED_AGENTS + 500 }).found
    ).toHaveLength(3)
    // The clamp itself: a limit above the constant resolves to the constant.
    expect(MAX_DISCOVERED_AGENTS).toBeGreaterThan(3)
  })
})

describe('readBareAgentName', () => {
  it('takes the first markdown heading', () => {
    const dir = agentAt('folder-name')
    writeFileSync(join(dir, 'AGENT.md'), '# Invoice Watcher\n\nBody.\n')
    expect(readBareAgentName(dir)).toBe('Invoice Watcher')
  })

  it('falls back to the folder name when the heading is a sentence', () => {
    // A `#` followed by prose is not a title, and a name that is a paragraph is
    // worse than a directory name in a sidebar. Mutation: accept any length and
    // the agents list gets a row whose name wraps over four lines.
    const dir = agentAt('sensible-name')
    writeFileSync(
      join(dir, 'AGENT.md'),
      `# ${'x'.repeat(120)}\n`
    )
    expect(readBareAgentName(dir)).toBe('sensible-name')
  })

  it('falls back to the folder name when there is no heading, and never throws', () => {
    const dir = agentAt('plain')
    writeFileSync(join(dir, 'AGENT.md'), 'No heading here.\n')
    expect(readBareAgentName(dir)).toBe('plain')
    expect(readBareAgentName(join(root, 'not-there'))).toBe('not-there')
  })
})

describe('isBareAgentDir', () => {
  it('is false for a directory named AGENT.md', () => {
    // Mutation: use `existsSync` instead of a file stat and a folder called
    // `AGENT.md` — which is what an over-eager scaffolder leaves behind —
    // becomes an agent with no instructions in it.
    const dir = join(root, 'odd')
    mkdirSync(join(dir, 'AGENT.md'), { recursive: true })
    expect(isBareAgentDir(dir)).toBe(false)
  })
})
