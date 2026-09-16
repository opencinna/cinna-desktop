import { describe, expect, it } from 'vitest'
import { StreamPartsAccumulator } from './streamPartsAccumulator'

it('updates a tool by identity after its permission and decision have arrived', () => {
  const accumulator = new StreamPartsAccumulator()
  const events: unknown[] = []
  const port = { postMessage: (event: unknown) => { events.push(event) } }
  const tool = (text: string) => ({ kind: 'text', text, metadata: {
    'cinna.content_kind': 'tool', 'cinna.tool_name': 'bash', 'cinna.tool_id': 'call-1'
  } })
  const ask = { kind: 'text', text: 'Allow?', metadata: {
    'cinna.content_kind': 'tool', 'cinna.tool_name': 'permission', 'cinna.tool_id': 'permission-1'
  } }
  const decision = { kind: 'text', text: 'Allowed', metadata: {
    'cinna.content_kind': 'tool_result', 'cinna.tool_id': 'permission-1'
  } }
  accumulator.ingestMessage({ messageId: 'm', parts: [tool('Run command'), ask, decision] }, port)
  accumulator.ingestMessage({ messageId: 'm', parts: [tool('Run command: pwd'), ask, decision] }, port)
  expect(accumulator.snapshotParts()).toHaveLength(3)
  expect(accumulator.snapshotParts()[0]).toMatchObject({ toolId: 'call-1', text: 'Run command: pwd' })
  expect(events).toHaveLength(4)
})

it('hides a half-written attach tag only in a mid-stream snapshot', () => {
  // The quit flush saves a part once and never revisits it, so the tag's first
  // half must not reach the row. Mutation: drop `opts` in `snapshotParts` → fails.
  const accumulator = new StreamPartsAccumulator()
  const port = { postMessage: () => {} }
  accumulator.ingestMessage({ messageId: 'm', parts: [{ kind: 'text', text: 'See <cinna_attach>/reports/q3' }] }, port)
  expect(accumulator.snapshotParts({ streaming: true })).toEqual([{ kind: 'text', text: 'See ' }])
  expect(accumulator.snapshotParts()[0]).toMatchObject({ text: 'See <cinna_attach>/reports/q3' })
})

describe('replay', () => {
  const toolPart = (text: string, meta: Record<string, unknown> = {}) => ({ kind: 'text', text, metadata: {
    'cinna.content_kind': 'tool', 'cinna.tool_name': 'askuserquestion', ...meta
  } })
  const textPart = (text: string) => ({ kind: 'text', text, metadata: { 'cinna.content_kind': 'text' } })
  const QUESTION = 'Using tool: askuserquestion\n1 question'

  function setup() {
    const accumulator = new StreamPartsAccumulator()
    const events: { text: string }[] = []
    const port = { postMessage: (event: { text: string }) => { events.push(event) } }
    return { accumulator, events, port }
  }

  it('skips a replayed part that names the same tool id, whatever its text', () => {
    // Mutation: ignore `replay` in `ingest` → the part text doubles.
    const { accumulator, events, port } = setup()
    accumulator.ingestMessage({ messageId: 'working', parts: [toolPart(QUESTION, { 'cinna.tool_id': 'q-1' })] }, port)
    accumulator.ingestMessage({ messageId: 'final', parts: [toolPart('Using tool: askuserquestion', { 'cinna.tool_id': 'q-1' })] }, port, { replay: true })
    expect(accumulator.snapshotParts()).toEqual([{ kind: 'tool', text: QUESTION, toolName: 'askuserquestion', toolId: 'q-1' }])
    expect(events).toHaveLength(1)
  })

  it('skips a replayed part with no tool id by kind, tool name and text', () => {
    const { accumulator, events, port } = setup()
    const input = { questions: [{ question: 'Which env?' }] }
    accumulator.ingestMessage({ messageId: 'working', parts: [toolPart(QUESTION, { 'cinna.tool_input': input })] }, port)
    accumulator.ingestMessage({ messageId: 'final', parts: [toolPart(QUESTION, { 'cinna.tool_input': input })] }, port, { replay: true })
    expect(accumulator.snapshotParts()).toEqual([{ kind: 'tool', text: QUESTION, toolName: 'askuserquestion', toolInput: input }])
    expect(events).toHaveLength(1)
  })

  it('still ingests a replayed part that matches nothing, and a second copy of a matched one', () => {
    const { accumulator, events, port } = setup()
    accumulator.ingestMessage({ messageId: 'working', parts: [textPart('Hello'), toolPart(QUESTION)] }, port)
    accumulator.ingestMessage({
      messageId: 'final',
      parts: [toolPart(QUESTION), toolPart('Using tool: askuserquestion\n2 questions'), toolPart(QUESTION, { 'cinna.tool_input': { a: 1 } })]
    }, port, { replay: true })
    // A differing input is a different call; so is the second copy — the first
    // accumulated part answers only once.
    expect(accumulator.snapshotParts().map((p) => p.text)).toEqual([
      'Hello',
      `${QUESTION}Using tool: askuserquestion\n2 questions${QUESTION}`
    ])
    expect(events).toHaveLength(4)
  })

  it('does not skip a different input when both parts carry one', () => {
    const { accumulator, port } = setup()
    accumulator.ingestMessage({ messageId: 'a', parts: [toolPart(QUESTION, { 'cinna.tool_input': { a: 1 } })] }, port)
    accumulator.ingestMessage({ messageId: 'b', parts: [textPart('between'), toolPart(QUESTION, { 'cinna.tool_input': { a: 2 } })] }, port, { replay: true })
    expect(accumulator.snapshotParts().map((p) => p.kind)).toEqual(['tool', 'text', 'tool'])
  })

  it('merges a repeated part as before without replay', () => {
    const { accumulator, events, port } = setup()
    accumulator.ingestMessage({ messageId: 'working', parts: [toolPart(QUESTION, { 'cinna.tool_id': 'q-1' })] }, port)
    accumulator.ingestMessage({ messageId: 'final', parts: [toolPart(QUESTION, { 'cinna.tool_id': 'q-1' })] }, port)
    expect(accumulator.snapshotParts()).toEqual([{ kind: 'tool', text: QUESTION + QUESTION, toolName: 'askuserquestion', toolId: 'q-1' }])
    expect(events).toHaveLength(2)
  })

  it('skips a replayed notice with the same text', () => {
    const { accumulator, port } = setup()
    const notice = { kind: 'text', text: 'Starting up', metadata: { 'cinna.content_kind': 'notice' } }
    accumulator.ingestMessage({ messageId: 'a', parts: [notice] }, port)
    accumulator.ingestMessage({ messageId: 'b', parts: [notice] }, port, { replay: true })
    expect(accumulator.snapshotNotices().map((n) => n.text)).toEqual(['Starting up'])
  })
})
