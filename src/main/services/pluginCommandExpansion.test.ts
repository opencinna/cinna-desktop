import { describe, expect, it } from 'vitest'
import { expandPluginCommand, SHELL_LEAD_IN, type PluginCommandTemplate } from './pluginCommandExpansion'

/** claude-plugins-official `commit-commands/commands/commit.md`, its body as `readPluginCommand` gives it. */
const COMMIT = `## Context

- Current git status: !\`git status\`
- Current git diff (staged and unstaged changes): !\`git diff HEAD\`
- Current branch: !\`git branch --show-current\`
- Recent commits: !\`git log --oneline -10\`

## Your task

Based on the above changes, create a single git commit.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
`

const COMMANDS: PluginCommandTemplate[] = [
  { name: 'commit-commands:commit', template: COMMIT },
  { name: 'notes:say', template: 'Say $ARGUMENTS, first $1 then $2, never $3.' },
  { name: 'notes:plain', template: 'Read @docs/notes.md and summarise it.\n' },
  { name: 'notes:sub:deep', template: 'Deep $1' }
]

describe('expandPluginCommand', () => {
  it('turns commit-commands:commit into its template, each shell line a command the model runs first', () => {
    const out = expandPluginCommand('/commit-commands:commit', COMMANDS)
    expect(out).toBe(
      'The user ran the command /commit-commands:commit. Follow its instructions:\n\n' +
        SHELL_LEAD_IN +
        '\n\n## Context\n\n' +
        '- Current git status: [run `git status` and use its output here]\n' +
        '- Current git diff (staged and unstaged changes): [run `git diff HEAD` and use its output here]\n' +
        '- Current branch: [run `git branch --show-current` and use its output here]\n' +
        '- Recent commits: [run `git log --oneline -10` and use its output here]\n\n' +
        '## Your task\n\nBased on the above changes, create a single git commit.\n\n' +
        'You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.'
    )
    expect(out).not.toContain('!`')
  })

  it('puts the arguments in $ARGUMENTS and the words in $1…$9, empty when missing', () => {
    expect(expandPluginCommand('/notes:say  red  blue ', COMMANDS)).toBe(
      'The user ran the command /notes:say. Follow its instructions:\n\nSay red  blue, first red then blue, never .'
    )
    expect(expandPluginCommand('/notes:say', COMMANDS)).toBe('The user ran the command /notes:say. Follow its instructions:\n\nSay , first  then , never .')
  })

  it('appends the arguments when the template has no placeholder, and leaves @file references as written', () => {
    expect(expandPluginCommand('/notes:plain only the intro', COMMANDS)).toBe(
      'The user ran the command /notes:plain. Follow its instructions:\n\nRead @docs/notes.md and summarise it.\n\nARGUMENTS: only the intro'
    )
    expect(expandPluginCommand('/notes:plain', COMMANDS)).toBe('The user ran the command /notes:plain. Follow its instructions:\n\nRead @docs/notes.md and summarise it.')
  })

  it('substitutes arguments inside a shell line, and never reads arguments as a shell line or a placeholder', () => {
    const commands = [{ name: 'p:log', template: 'Log: !`git log -n $1`\nAsked: $ARGUMENTS' }]
    expect(expandPluginCommand('/p:log 3 !`rm -rf x` $2', commands)).toBe(
      'The user ran the command /p:log. Follow its instructions:\n\n' + SHELL_LEAD_IN + '\n\nLog: [run `git log -n 3` and use its output here]\nAsked: 3 !`rm -rf x` $2'
    )
  })

  it('keeps a backtick in the arguments from ending a shell marker', () => {
    const commands = [{ name: 'p:echo', template: 'Echo: !`echo $1`' }]
    expect(expandPluginCommand('/p:echo `x`', commands)).toBe(
      'The user ran the command /p:echo. Follow its instructions:\n\n' + SHELL_LEAD_IN + "\n\nEcho: [run `echo 'x'` and use its output here]"
    )
  })

  it('names a nested command sub:stem, and takes OpenCode’s /<agent key>/ form only given that key', () => {
    expect(expandPluginCommand('/notes:sub:deep dive', COMMANDS)).toBe('The user ran the command /notes:sub:deep. Follow its instructions:\n\nDeep dive')
    expect(expandPluginCommand('/agent-1/notes:sub:deep dive', COMMANDS, { agentKey: 'agent-1' })).toBe(
      'The user ran the command /notes:sub:deep. Follow its instructions:\n\nDeep dive'
    )
    expect(expandPluginCommand('/agent-1/notes:sub:deep dive', COMMANDS)).toBeNull()
    expect(expandPluginCommand('/agent-2/notes:sub:deep dive', COMMANDS, { agentKey: 'agent-1' })).toBeNull()
  })

  it('answers null for anything that is not one of the commands', () => {
    for (const text of ['/compact', '/goal clear', '/notes:missing', '/notes', 'please /notes:say hi', 'hello', '', '/']) {
      expect(expandPluginCommand(text, COMMANDS), text).toBeNull()
    }
    expect(expandPluginCommand('/notes:say hi', [])).toBeNull()
  })
})
