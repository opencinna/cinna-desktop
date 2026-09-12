import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CLAUDE_AGENT_FIELDS_DROPPED, CLAUDE_AGENTS_DIR, readFolderAgents } from './claudeAgents'

/**
 * `.claude/agents/*.md` → `options.agents`.
 *
 * Real files in a real temp folder, because the thing under test is what a
 * terminal `claude` would have found on disk and the desktop's `settingSources:
 * []` hides — see the module header. The boundary tests at the end are the
 * load-bearing ones: a frontmatter key that moved a permission decision away
 * from the desktop would pass every other test here and fail none of them.
 */

let dir: string
const agentsDir = (): string => join(dir, CLAUDE_AGENTS_DIR)
const write = (name: string, text: string): void => {
  mkdirSync(agentsDir(), { recursive: true })
  writeFileSync(join(agentsDir(), name), text)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-claude-agents-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readFolderAgents', () => {
  it('yields nothing for a folder with no agents directory, without throwing', () => {
    expect(readFolderAgents(dir)).toEqual({ agents: {}, skipped: [] })
    expect(readFolderAgents(join(dir, 'does-not-exist'))).toEqual({ agents: {}, skipped: [] })
  })

  it('reads a definition the way the folder wrote it', () => {
    write(
      'queue-handler-agent.md',
      [
        '---',
        'name: queue-handler-agent',
        'description: Queue Handler Agent — owns the accounting quality queue.',
        'tools: Bash, Read, Grep, Glob',
        'model: sonnet',
        '---',
        '',
        '# Queue Handler Agent',
        '',
        'You keep the ledger of the ledger.',
        ''
      ].join('\n')
    )
    const { agents, skipped } = readFolderAgents(dir)
    expect(skipped).toEqual([])
    expect(agents['queue-handler-agent']).toEqual({
      description: 'Queue Handler Agent — owns the accounting quality queue.',
      prompt: '# Queue Handler Agent\n\nYou keep the ledger of the ledger.',
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
      model: 'sonnet'
    })
  })

  it('falls back to the file name when there is no name, as the CLI does', () => {
    write('reviewer.md', '---\ndescription: Reviews.\n---\nReview it.\n')
    expect(Object.keys(readFolderAgents(dir).agents)).toEqual(['reviewer'])
  })

  it('accepts a YAML list for tools and skills, and the optional numbers', () => {
    write(
      'x.md',
      [
        '---',
        'description: d',
        'tools:',
        '  - Read',
        '  - Grep',
        'disallowedTools: Write',
        'skills: [a, b]',
        'maxTurns: 5',
        'effort: high',
        'background: true',
        '---',
        'p'
      ].join('\n')
    )
    expect(readFolderAgents(dir).agents.x).toEqual({
      description: 'd',
      prompt: 'p',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Write'],
      skills: ['a', 'b'],
      maxTurns: 5,
      effort: 'high',
      background: true
    })
  })

  it('skips, and names, a file the model could never pick', () => {
    write('no-frontmatter.md', 'Just prose.\n')
    write('no-description.md', '---\nname: x\n---\nbody\n')
    write('no-prompt.md', '---\ndescription: d\n---\n\n')
    write('notes.txt', '---\ndescription: not markdown\n---\nbody\n')
    const { agents, skipped } = readFolderAgents(dir)
    expect(agents).toEqual({})
    expect(skipped.map((s) => s.file)).toEqual([
      join(CLAUDE_AGENTS_DIR, 'no-description.md'),
      join(CLAUDE_AGENTS_DIR, 'no-frontmatter.md'),
      join(CLAUDE_AGENTS_DIR, 'no-prompt.md')
    ])
  })

  it('keeps every other file when one is bad', () => {
    write('bad.md', 'no frontmatter')
    write('good.md', '---\ndescription: d\n---\np\n')
    const { agents, skipped } = readFolderAgents(dir)
    expect(Object.keys(agents)).toEqual(['good'])
    expect(skipped).toHaveLength(1)
  })
})

describe('the boundary — what a file cannot say', () => {
  it.each(CLAUDE_AGENT_FIELDS_DROPPED)('drops %s however it is spelled in the file', (key) => {
    write('x.md', `---\ndescription: d\n${key}: bypassPermissions\n---\np\n`)
    expect(Object.hasOwn(readFolderAgents(dir).agents.x, key)).toBe(false)
  })

  it('never lets a subagent set its own permission mode', () => {
    // The one that matters. `bypassPermissions` here would run every tool of
    // the subagent without `canUseTool` being consulted — the grants store,
    // the permission block and the audit trail all bypassed by a text file.
    write('x.md', '---\ndescription: d\npermissionMode: bypassPermissions\n---\np\n')
    expect(readFolderAgents(dir).agents.x).toEqual({ description: 'd', prompt: 'p' })
  })

  it('never carries MCP servers, which strictMcpConfig exists to keep out', () => {
    write('x.md', '---\ndescription: d\nmcpServers: [gmail]\n---\np\n')
    expect(readFolderAgents(dir).agents.x).toEqual({ description: 'd', prompt: 'p' })
  })
})

describe('frontmatter the reader cannot represent', () => {
  it('skips a block-scalar description rather than offering a subagent described as "|"', () => {
    write('x.md', '---\ndescription: |\n  Reviews pull requests\n  carefully.\n---\np\n')
    const { agents, skipped } = readFolderAgents(dir)
    expect(agents).toEqual({})
    expect(skipped[0]?.reason).toMatch(/block scalar/)
  })

  it('skips an unquoted # rather than passing a truncated description', () => {
    write('x.md', '---\ndescription: Use for PR #123 style reviews\n---\np\n')
    const { agents, skipped } = readFolderAgents(dir)
    expect(agents).toEqual({})
    expect(skipped[0]?.reason).toMatch(/comment|#/)
  })

  it('reads the same description when it is quoted', () => {
    write('x.md', '---\ndescription: "Use for PR #123 style reviews"\n---\np\n')
    expect(readFolderAgents(dir).agents.x?.description).toBe('Use for PR #123 style reviews')
  })
})
