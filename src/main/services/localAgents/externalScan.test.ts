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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverBareAgents,
  isBareAgentDir,
  MAX_DISCOVERED_AGENTS,
  readBareAgentName,
  resolveBareInstructionsFile
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
    mkdirSync(join(dir, 'CLAUDE.md'), { recursive: true })
    expect(isBareAgentDir(dir)).toBe(false)
  })
})

/** A folder at `segments` whose instructions are `file`. */
function instructionsAt(file: string, ...segments: string[]): string {
  const dir = join(root, ...segments)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), '# Whatever\n\nDo the thing.\n')
  return dir
}

describe('which file makes a folder an agent', () => {
  it('finds a folder by each of AGENT.md, AGENTS.md and CLAUDE.md', () => {
    // Mutation: drop a name from the list and a project folder carrying only
    // that file is "nothing in this folder" again.
    instructionsAt('AGENT.md', 'a')
    instructionsAt('AGENTS.md', 'b')
    instructionsAt('CLAUDE.md', 'c')
    expect(discoverBareAgents(root).found.map((f) => [f.relPath, f.instructionsFile])).toEqual([
      ['a', 'AGENT.md'],
      ['b', 'AGENTS.md'],
      ['c', 'CLAUDE.md']
    ])
  })

  it('takes AGENT.md, then AGENTS.md, then CLAUDE.md when a folder has several', () => {
    // Mutation: reorder the list and the agent runs on whichever file sorts
    // first, which is not the one its author wrote for it.
    const dir = instructionsAt('CLAUDE.md', 'x')
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n')
    expect(resolveBareInstructionsFile(dir)).toBe('AGENTS.md')
    writeFileSync(join(dir, 'AGENT.md'), '# Agent\n')
    expect(resolveBareInstructionsFile(dir)).toBe('AGENT.md')
    // One folder, one agent, whichever file won.
    expect(discoverBareAgents(root).found.map((f) => [f.relPath, f.instructionsFile])).toEqual([
      ['x', 'AGENT.md']
    ])
  })

  it('does not count AGENTS.md or CLAUDE.md in a folder the kit made', () => {
    // The kit scaffolds both into every agent folder and every workshop root.
    // Mutation: drop the guard and adopting a tree of kit agents lists each one
    // as a bare agent, with no commands, credential slots or runtime.
    const kitAgent = instructionsAt('AGENTS.md', 'Local', 'alpha')
    writeFileSync(join(kitAgent, 'CLAUDE.md'), '# alpha\n')
    writeFileSync(join(kitAgent, 'cinna-agent.json'), '{}')
    const workshop = instructionsAt('CLAUDE.md', 'workshop')
    mkdirSync(join(workshop, '.cinna-kit'))

    expect(resolveBareInstructionsFile(kitAgent)).toBeNull()
    expect(resolveBareInstructionsFile(workshop)).toBeNull()
    expect(discoverBareAgents(root).found).toEqual([])

    // `AGENT.md` keeps counting beside a manifest, exactly as it always did.
    writeFileSync(join(kitAgent, 'AGENT.md'), '# Alpha\n')
    expect(resolveBareInstructionsFile(kitAgent)).toBe('AGENT.md')
  })

  it('lists the AGENT.md agents under a root CLAUDE.md, not the root', () => {
    // The shape the walk rule exists for: a team repository of agents with a
    // `CLAUDE.md` at the top for the people working on it. Mutation: let a weak
    // root be the agent and this finds `.` alone — and rescanning a root already
    // registered prunes both agents, taking their sessions with them.
    writeFileSync(join(root, 'CLAUDE.md'), '# Team repository\n')
    agentAt('local_agents', 'a')
    agentAt('local_agents', 'b')
    expect(discoverBareAgents(root).found.map((f) => f.relPath)).toEqual([
      'local_agents/a',
      'local_agents/b'
    ])
  })

  it('walks a weak folder with AGENT.md below it like any other, rule and all', () => {
    // Mutation: once the root is ruled out, stop applying the rule — `w` is
    // then an agent and hides `w/inner`, or `y` is skipped for not being strong.
    writeFileSync(join(root, 'CLAUDE.md'), '# Team repository\n')
    agentAt('x')
    instructionsAt('CLAUDE.md', 'y')
    instructionsAt('AGENTS.md', 'w')
    agentAt('w', 'inner')
    expect(discoverBareAgents(root).found.map((f) => [f.relPath, f.instructionsFile])).toEqual([
      ['w/inner', 'AGENT.md'],
      ['x', 'AGENT.md'],
      ['y', 'CLAUDE.md']
    ])
  })

  it('is the agent itself when only weak files sit below it', () => {
    // A nested `CLAUDE.md` is part of that agent's working tree, the same rule
    // as a nested `AGENT.md` under a strong one. Mutation: let any match below
    // disqualify a weak folder and this lists `sub` instead of the agent.
    writeFileSync(join(root, 'CLAUDE.md'), '# One agent\n')
    instructionsAt('CLAUDE.md', 'sub')
    expect(discoverBareAgents(root).found.map((f) => [f.relPath, f.instructionsFile])).toEqual([
      ['.', 'CLAUDE.md']
    ])
  })

  it('looks for AGENT.md below a weak folder only where the walk itself would', () => {
    // Out of reach, inside a dependency tree or inside a dot-directory, an
    // `AGENT.md` is one the walk would never list — so it must not stop the
    // weak folder above it being the agent. Mutation: an unbounded or unfiltered
    // probe finds `.`'s agents nowhere and the folder has no agent at all.
    writeFileSync(join(root, 'AGENTS.md'), '# One agent\n')
    agentAt('a', 'b', 'c')
    agentAt('node_modules', 'pkg')
    agentAt('.claude', 'skill')
    expect(discoverBareAgents(root).found.map((f) => f.relPath)).toEqual(['.'])
  })

  it('does not count its look below toward the cap', () => {
    // Mutation: count the probe's `AGENT.md` towards the limit and a root
    // holding exactly as many agents as the cap reports itself truncated,
    // dropping the last one.
    writeFileSync(join(root, 'CLAUDE.md'), '# Team repository\n')
    agentAt('local_agents', 'a')
    agentAt('local_agents', 'b')
    const capped = discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { limit: 2 })
    expect(capped.found.map((f) => f.relPath)).toEqual(['local_agents/a', 'local_agents/b'])
    expect(capped.truncated).toBe(false)
  })
})

describe('readBareAgentName — other instruction files', () => {
  it('reads the heading from the file the folder has', () => {
    const dir = instructionsAt('AGENTS.md', 'folder-name')
    writeFileSync(join(dir, 'AGENTS.md'), '# Support Desk\n\nBody.\n')
    expect(readBareAgentName(dir)).toBe('Support Desk')
  })

  it('falls back to the folder name when the heading is only the file’s own name', () => {
    // `# CLAUDE.md` is a very common first line. Mutation: accept it and every
    // such agent is listed as "CLAUDE.md", a sidebar of identical rows.
    const dir = instructionsAt('CLAUDE.md', 'support-bot')
    for (const heading of ['CLAUDE.md', 'Claude', 'claude.MD']) {
      writeFileSync(join(dir, 'CLAUDE.md'), `# ${heading}\n\nBody.\n`)
      expect(readBareAgentName(dir)).toBe('support-bot')
    }
    const agents = instructionsAt('AGENTS.md', 'triage')
    writeFileSync(join(agents, 'AGENTS.md'), '# Agents\n')
    expect(readBareAgentName(agents)).toBe('triage')
    const agent = instructionsAt('AGENT.md', 'nightly')
    writeFileSync(join(agent, 'AGENT.md'), '# AGENT.md\n')
    expect(readBareAgentName(agent)).toBe('nightly')
  })
})

describe('keep — a weak folder already known as an agent', () => {
  it('stays the agent when an AGENT.md sits below it, and is not descended into', () => {
    // A repository adopted by its `CLAUDE.md`, then a `git pull` adds an example
    // agent inside it. Mutation: ignore `keep` and `.` turns into a container
    // listing `examples/bot`, which prunes the adopted agent on the next rescan.
    writeFileSync(join(root, 'CLAUDE.md'), '# Repo helper\n')
    agentAt('examples', 'bot')
    const keep = vi.fn((absPath: string) => absPath === root)
    expect(
      discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { keep }).found.map((f) => [
        f.relPath,
        f.instructionsFile
      ])
    ).toEqual([['.', 'CLAUDE.md']])
    expect(keep).toHaveBeenCalledWith(root)
    // Not known: the ordinary rule, `AGENT.md` below wins.
    expect(
      discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { keep: () => false }).found.map(
        (f) => f.relPath
      )
    ).toEqual(['examples/bot'])
  })

  it('is asked only about a weak folder with an AGENT.md below it', () => {
    // The common path must not pay for it. Mutation: consult `keep` before the
    // strong check or before the probe below, and it is asked about `strong` or
    // `weak-alone` too, which would be one index read per walk on every scan.
    agentAt('strong')
    agentAt('strong', 'nested')
    instructionsAt('CLAUDE.md', 'weak-alone')
    instructionsAt('AGENTS.md', 'weak-over')
    agentAt('weak-over', 'inner')
    const keep = vi.fn((_absPath: string) => false)
    const { found } = discoverBareAgents(root, BARE_AGENT_MAX_DEPTH, { keep })
    expect(found.map((f) => f.relPath)).toEqual(['strong', 'weak-alone', 'weak-over/inner'])
    expect(keep.mock.calls).toEqual([[join(root, 'weak-over')]])
  })
})
