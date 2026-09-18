import { describe, expect, it } from 'vitest'
import type { MessagePart } from '../../../../shared/messageParts'
import { nestSubagentParts } from './subagentParts'

const text = (t: string, parentToolId?: string): MessagePart => ({ kind: 'text', text: t, ...(parentToolId ? { parentToolId } : {}) })
const agent = (id: string, input: Record<string, unknown> = { description: 'check pg', prompt: 'Confirm pg' }, parentToolId?: string): MessagePart =>
  ({ kind: 'tool', text: 'Agent: check pg', toolName: 'Agent', toolId: id, toolInput: input, ...(parentToolId ? { parentToolId } : {}) })
const bash = (id: string, parentToolId?: string): MessagePart =>
  ({ kind: 'tool', text: 'Bash: psql', toolName: 'Bash', toolId: id, ...(parentToolId ? { parentToolId } : {}) })
const result = (id: string, t: string, toolStream: 'stdout' | 'stderr' = 'stdout', parentToolId?: string): MessagePart =>
  ({ kind: 'tool_result', text: t, toolId: id, toolStream, ...(parentToolId ? { parentToolId } : {}) })

describe('nestSubagentParts', () => {
  it('is a no-op for parts without parentToolId or an Agent call', () => {
    const parts = [text('hi'), bash('b0'), result('b0', 'report'), bash('b1'), result('b1', 'ok')]
    const nested = nestSubagentParts(parts)
    expect(nested.items).toEqual(parts)
    expect(nested.origin).toEqual([0, 1, 2, 3, 4])
    expect(nested.groups.size).toBe(0)
  })

  it('nests the subagent’s parts under its Agent call and consumes the call’s result', () => {
    const parts = [
      text('Launching.'),
      agent('a1'),
      bash('b1', 'a1'),
      result('b1', 'ok', 'stdout', 'a1'),
      text('Confirmed "pg".', 'a1'),
      result('a1', 'Confirmed "pg".'),
      text('Done.')
    ]
    const nested = nestSubagentParts(parts)
    expect(nested.items).toEqual([parts[0], parts[1], parts[6]])
    expect(nested.origin).toEqual([0, 1, 6])
    expect([...nested.groups.keys()]).toEqual([1])
    const group = nested.groups.get(1)!
    expect(group.parts).toEqual([parts[2], parts[3], parts[4]])
    expect(group).toMatchObject({ parentToolId: 'a1', tool: parts[1], status: 'done', agentName: 'check pg', askMessage: 'Confirm pg' })
    expect(group.errorText).toBeUndefined()
  })

  it('reads a stderr result as an error with its text', () => {
    const parts = [agent('a1'), text('trying', 'a1'), result('a1', 'Subagent failed.', 'stderr')]
    const group = nestSubagentParts(parts).groups.get(0)!
    expect(group).toMatchObject({ status: 'error', errorText: 'Subagent failed.' })
  })

  it('is pending with no result while live, done once not', () => {
    const parts = [agent('a1'), bash('b1', 'a1')]
    expect(nestSubagentParts(parts, { live: true }).groups.get(0)!.status).toBe('pending')
    expect(nestSubagentParts(parts).groups.get(0)!.status).toBe('done')
  })

  it('groups parts whose Agent call is absent as "Subagent" at the first part', () => {
    const parts = [text('Meanwhile'), bash('b1', 'a0'), text('more of mine'), text('report', 'a0'), result('a0', 'done')]
    const nested = nestSubagentParts(parts)
    expect(nested.items).toEqual([parts[0], parts[1], parts[2]])
    const group = nested.groups.get(1)!
    expect(group.parts).toEqual([parts[1], parts[3]])
    expect(group).toMatchObject({ agentName: 'Subagent', status: 'done' })
    expect(group.tool).toBeUndefined()
    expect(group.askMessage).toBeUndefined()
  })

  it('keeps a nested subagent’s work inside its parent’s group', () => {
    const parts = [agent('a1'), agent('a2', { description: 'inner' }, 'a1'), bash('b2', 'a2'), text('outer report', 'a1')]
    const nested = nestSubagentParts(parts)
    expect(nested.items).toEqual([parts[0]])
    expect(nested.groups.get(0)!.parts).toEqual([parts[1], parts[2], parts[3]])
  })

  it('makes every Agent call a group, saved too, even with no subagent parts', () => {
    // Mutation: groups for calls without lane parts only while live → a saved call is a plain row.
    const parts = [agent('a1'), result('a1', 'report'), agent('a2'), text('x', 'a2')]
    const nested = nestSubagentParts(parts)
    expect(nested.items).toEqual([parts[0], parts[2]])
    expect([...nested.groups.keys()]).toEqual([0, 1])
    expect(nested.groups.get(0)).toMatchObject({ parentToolId: 'a1', status: 'done' })
  })

  it('shows a done report as the content of a group with no subagent parts', () => {
    // Mutation: always consume the result silently → an old row, or an agent whose
    // subagent frames never reach the desktop, loses the report entirely.
    const parts = [agent('a1'), result('a1', 'report'), agent('a2'), text('x', 'a2'), result('a2', 'x')]
    const nested = nestSubagentParts(parts)
    expect(nested.groups.get(0)?.parts).toEqual([parts[1]])
    // With a lane the report repeats the subagent's last words, so it stays hidden.
    expect(nested.groups.get(1)?.parts).toEqual([parts[3]])
  })

  it('keeps the error of a subagent that failed before it said anything, live and saved alike', () => {
    // Mutation: saved call without lane parts → a plain row, its stderr result a loose dot.
    const parts = [text('Launching.'), agent('a1'), result('a1', 'Subagent crashed.', 'stderr'), text('It failed.')]
    const live = nestSubagentParts(parts, { live: true })
    const saved = nestSubagentParts(parts)
    expect(saved).toEqual(live)
    expect(saved.items).toEqual([parts[0], parts[1], parts[3]])
    expect(saved.groups.get(1)).toMatchObject({ status: 'error', errorText: 'Subagent crashed.', parts: [] })
  })

  it('reads status from the result alone: none is pending live, done saved', () => {
    const parts = [agent('a1')]
    expect(nestSubagentParts(parts, { live: true }).groups.get(0)!.status).toBe('pending')
    expect(nestSubagentParts(parts).groups.get(0)!.status).toBe('done')
    expect(nestSubagentParts([...parts, result('a1', 'ok')], { live: true }).groups.get(0)!.status).toBe('done')
  })

  describe('a steer inside the turn', () => {
    // Live blocks: a steer is a `user` block. Saved: the turn is two rows,
    // split where the steer landed (`saveTurnRows`).
    type View = { kind: string; text: string; toolName?: string; toolId?: string; toolInput?: Record<string, unknown>; toolStream?: 'stdout' | 'stderr'; parentToolId?: string }
    const steer: View = { kind: 'user', text: 'also check mysql' }
    const before = [agent('a1'), bash('b1', 'a1'), text('Checking pg.', 'a1')]
    const after = [text('Now mysql.', 'a1'), result('a1', 'Subagent failed.', 'stderr')]

    it('nests each segment as the saved row it becomes', () => {
      // Mutation: nest the live list as one segment → one group spanning the steer, and its error above it.
      const live = nestSubagentParts<View>([...before, steer, ...after], { live: true })
      const rowOne = nestSubagentParts<View>(before)
      const rowTwo = nestSubagentParts<View>(after)
      const drop = <T>(nested: { items: T[]; groups: Map<number, unknown> }) => ({ items: nested.items, groups: [...nested.groups] })
      expect(drop(live)).toEqual({
        items: [...rowOne.items, steer, ...rowTwo.items],
        groups: [...drop(rowOne).groups, ...drop(rowTwo).groups.map(([i, g]) => [i + rowOne.items.length + 1, g])]
      })
      expect(live.origin).toEqual([0, 3, 4])
      expect(live.groups.get(0)).toMatchObject({ parentToolId: 'a1', status: 'done', parts: before.slice(1) })
      expect(live.groups.get(2)).toMatchObject({ parentToolId: 'a1', agentName: 'Subagent', status: 'error', errorText: 'Subagent failed.', parts: [after[0]] })
    })

    it('consumes an Agent call’s result only within its own segment', () => {
      const live = nestSubagentParts<View>([agent('a1'), steer, result('a1', 'late report')], { live: true })
      expect(live.items).toEqual([agent('a1'), steer, result('a1', 'late report')])
      expect(live.groups.get(0)!.status).toBe('done')
      expect(live.groups.size).toBe(1)
    })

    it('keeps the segment after the last steer live', () => {
      const live = nestSubagentParts<View>([text('hi'), steer, agent('a1')], { live: true })
      expect(live.groups.get(2)!.status).toBe('pending')
    })
  })

  it('opens a pending group for a live Agent call before its subagent speaks', () => {
    // Mutation: drop the live groups → the call stays a plain tool row until the first child part.
    const parts = [text('Launching.'), agent('a1'), bash('x1')]
    const nested = nestSubagentParts(parts, { live: true })
    expect(nested.items).toEqual(parts)
    expect(nested.groups.get(1)).toMatchObject({ parentToolId: 'a1', parts: [], status: 'pending', askMessage: 'Confirm pg' })
  })
})
