import { describe, expect, it } from 'vitest'
import { continuesPart, continuingPartIndex, type PartMergeKey } from './partMerge'

const cases: [string, PartMergeKey, PartMergeKey, boolean][] = [
  ['text continues text', { kind: 'text' }, { kind: 'text' }, true],
  ['thinking does not continue text', { kind: 'text' }, { kind: 'thinking' }, false],
  ['command_result continues command_result', { kind: 'command_result' }, { kind: 'command_result' }, true],
  ['a file never continues a file', { kind: 'file' }, { kind: 'file' }, false],
  [
    'tool_result continues on the same id and stream',
    { kind: 'tool_result', toolId: 'c1', toolStream: 'stdout' },
    { kind: 'tool_result', toolId: 'c1', toolStream: 'stdout' },
    true
  ],
  [
    'tool_result on the other stream starts a part',
    { kind: 'tool_result', toolId: 'c1', toolStream: 'stdout' },
    { kind: 'tool_result', toolId: 'c1', toolStream: 'stderr' },
    false
  ],
  [
    'tool continues on the same name and id',
    { kind: 'tool', toolName: 'bash', toolId: 'c1' },
    { kind: 'tool', toolName: 'bash', toolId: 'c1' },
    true
  ],
  [
    'tool with another name starts a part',
    { kind: 'tool', toolName: 'bash', toolId: 'c1' },
    { kind: 'tool', toolName: 'edit', toolId: 'c1' },
    false
  ],
  [
    'two back-to-back asks with different ids are two parts',
    { kind: 'tool', toolName: 'cinna_permission_request', toolId: 'per_1' },
    { kind: 'tool', toolName: 'cinna_permission_request', toolId: 'per_2' },
    false
  ],
  [
    'a later A2A frame with no id continues the part that had one',
    { kind: 'tool', toolName: 'bash', toolId: 'c1' },
    { kind: 'tool', toolName: 'bash' },
    true
  ],
  [
    'a frame with an id continues a part whose first frame had none',
    { kind: 'tool', toolName: 'bash' },
    { kind: 'tool', toolName: 'bash', toolId: 'c1' },
    true
  ]
]

describe('continuesPart', () => {
  it.each(cases)('%s', (_name, last, next, expected) => {
    expect(continuesPart(last, next)).toBe(expected)
  })
})

describe('continuingPartIndex lanes', () => {
  it('continues the last part of the same lane, skipping other lanes', () => {
    const parts: PartMergeKey[] = [
      { kind: 'text' },
      { kind: 'tool', toolName: 'Bash', toolId: 'b1', parentToolId: 'agent-1' },
      { kind: 'tool_result', toolId: 'b1', toolStream: 'stdout', parentToolId: 'agent-1' },
      { kind: 'text', parentToolId: 'agent-1' }
    ]
    expect(continuingPartIndex(parts, { kind: 'text' })).toBe(0)
    expect(continuingPartIndex(parts, { kind: 'text', parentToolId: 'agent-1' })).toBe(3)
    expect(continuingPartIndex(parts, { kind: 'text', parentToolId: 'agent-2' })).toBe(-1)
  })

  it('treats an undefined entry as a main-lane break', () => {
    const parts = [{ kind: 'text' } as PartMergeKey, undefined, { kind: 'text', parentToolId: 'a' } as PartMergeKey]
    expect(continuingPartIndex(parts, { kind: 'text' })).toBe(-1)
    expect(continuingPartIndex(parts, { kind: 'text', parentToolId: 'a' })).toBe(2)
  })

  it('never merges across lanes', () => {
    expect(continuesPart({ kind: 'text' }, { kind: 'text', parentToolId: 'a' })).toBe(false)
  })

  it('is the plain last-part rule when no lane is set', () => {
    const parts: PartMergeKey[] = [{ kind: 'text' }, { kind: 'tool', toolName: 'Bash' }]
    expect(continuingPartIndex(parts, { kind: 'text' })).toBe(-1)
    expect(continuingPartIndex(parts, { kind: 'tool', toolName: 'Bash' })).toBe(1)
  })
})
