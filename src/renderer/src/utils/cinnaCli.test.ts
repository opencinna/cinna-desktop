import { describe, expect, it } from 'vitest'
import { cinnaCliCommand, pairCinnaCliTools } from './cinnaCli'
import { unwrapConsoleOutput } from './consoleOutput'

describe('Cinna CLI presentation', () => {
  it('recognizes exact executable prefixes in shell arguments, preserving the full command', () => {
    expect(cinnaCliCommand('Bash', { command: '  cinna account agents --all  ' })).toBe('cinna account agents --all')
    expect(cinnaCliCommand('exec_command', { cmd: 'cinna --help' })).toBe('cinna --help')
    for (const command of ['cinnamon --help', 'echo cinna account', 'cat cinna', '']) {
      expect(cinnaCliCommand('Bash', { command })).toBeNull()
    }
    expect(cinnaCliCommand('Write', { command: 'cinna account' })).toBeNull()
    expect(cinnaCliCommand('Bash', { command: ['cinna'] })).toBeNull()
  })

  it('pairs concurrent calls by ID with all output streams, leaving unrelated results alone', () => {
    const call = (toolId: string, command = 'cinna account agents') => ({ kind: 'tool', toolId, toolName: 'Bash', toolInput: { command } })
    const items = [call('a'), call('b'), { kind: 'tool_result', toolId: 'b' },
      { kind: 'tool_result', toolId: 'a' }, { kind: 'tool_result', toolId: 'a' },
      { kind: 'tool_result', toolId: 'unknown' }, call('c', 'echo hello'),
      { kind: 'tool_result', toolId: 'c' }, { ...call('slash'), commandInvocation: '/run:foo' },
      { kind: 'tool_result', toolId: 'slash' }, { ...call('missing'), toolId: undefined },
      { kind: 'tool_result' }]
    const { calls, consumed } = pairCinnaCliTools(items)
    expect(calls.get(0)?.resultIndices).toEqual([3, 4])
    expect(calls.get(1)?.resultIndices).toEqual([2])
    expect(calls.get(10)?.resultIndices).toEqual([])
    expect([...consumed].sort()).toEqual([2, 3, 4])
    expect(calls.size).toBe(3)
  })

  it('removes full console wrappers without damaging table whitespace or literal fences', () => {
    const table = '  Agent         Build\n  Invoice       local'
    expect(unwrapConsoleOutput('```console\n' + table + '\n```')).toBe(table)
    expect(unwrapConsoleOutput('``` console\n' + table + '\n```')).toBe(table)
    expect(unwrapConsoleOutput('````text\n```console\n' + table + '\n```\n````')).toBe(table)
    for (const text of [table, 'before\n```console\noutput\n```', '```console\na\n```\n```console\nb\n```', '```json\n{}\n```']) {
      expect(unwrapConsoleOutput(text)).toBe(text)
    }
    expect(unwrapConsoleOutput('```console\npartial', true)).toBe('partial')
    expect(unwrapConsoleOutput('```console\npartial')).toBe('```console\npartial')
  })
})
