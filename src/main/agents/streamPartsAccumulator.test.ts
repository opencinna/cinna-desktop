import { expect, it } from 'vitest'
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
