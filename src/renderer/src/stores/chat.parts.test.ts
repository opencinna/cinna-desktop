import { expect, it } from 'vitest'
import type { RunEvent } from '../../../shared/runEvents'
import { useChatStore } from './chat.store'
it('grows the original live tool block after an intervening permission decision', () => {
  useChatStore.getState().startStreaming('request')
  const append = useChatStore.getState().appendDelta
  append('Run', 'tool', 'bash', undefined, 'call-1')
  append('Allow?', 'tool', 'permission', undefined, 'ask-1')
  append('Allowed', 'tool_result', undefined, undefined, 'ask-1', 'stdout')
  append(': pwd', 'tool', 'bash', { command: 'pwd' }, 'call-1')
  expect(useChatStore.getState().streamingBlocks).toHaveLength(3)
  expect(useChatStore.getState().streamingBlocks[0]).toMatchObject({ content: 'Run: pwd', toolInput: { command: 'pwd' } })
})

it('keeps the agent’s live paragraph one block while its subagent’s blocks interleave', () => {
  // Mutation: drop `parentToolId` from the store's merge key → three parent blocks.
  useChatStore.getState().startStreaming('request')
  const append = useChatStore.getState().appendDelta
  append('the Florian Rockenhä')
  append('Bash: psql', 'tool', 'Bash', undefined, 'bash-1', undefined, undefined, undefined, 'agent-1')
  append('ok', 'tool_result', undefined, undefined, 'bash-1', 'stdout', undefined, undefined, 'agent-1')
  append('Confirmed.', 'text', undefined, undefined, undefined, undefined, undefined, undefined, 'agent-1')
  append('user / Traffective')
  const blocks = useChatStore.getState().streamingBlocks
  expect(blocks).toHaveLength(4)
  expect(blocks[0]).toMatchObject({ type: 'text', kind: 'text', content: 'the Florian Rockenhäuser / Traffective' })
  expect(blocks[0]).not.toHaveProperty('parentToolId')
  expect(blocks.slice(1).map((b) => b.type === 'text' && b.parentToolId)).toEqual(['agent-1', 'agent-1', 'agent-1'])
})

it('opens a new live block for a `newPart` delta the lane rule would have joined', () => {
  // Mutation: ignore `newPart` in `appendDelta` → "launchedCommand" in one block.
  useChatStore.getState().startStreaming('request')
  const append = useChatStore.getState().appendDelta
  append('launched')
  append('Bash: x', 'tool', 'Bash', undefined, 'bash-1', undefined, undefined, undefined, 'agent-1')
  append('Command', 'text', undefined, undefined, undefined, undefined, undefined, undefined, undefined, true)
  append(' completed')
  const own = useChatStore.getState().streamingBlocks.filter((b) => b.type === 'text' && !b.parentToolId)
  expect(own.map((b) => (b.type === 'text' ? b.content : ''))).toEqual(['launched', 'Command completed'])
})

it('ends every lane at a user message taken into the turn, as the saved rows do', () => {
  // Mutation: drop the user-block check in `appendDelta` → the subagent's text runs on across the user block.
  useChatStore.getState().startStreaming('request')
  const append = useChatStore.getState().appendDelta
  const lane = (text: string): void => append(text, 'text', undefined, undefined, undefined, undefined, undefined, undefined, 'agent-1')
  lane('child before')
  useChatStore.getState().appendUserMessage('steer')
  lane(' child after')
  const blocks = useChatStore.getState().streamingBlocks
  expect(blocks.map((b) => (b.type === 'tool_call' ? '' : b.content))).toEqual(['child before', 'steer', ' child after'])
})

it('keeps a delegated agent’s subagent lane apart in its live sub-thread', () => {
  // Mutation: drop `parentToolId`/`newPart` from `appendToolSubEvent` → the parent's sentence is cut and the child's text glued on.
  const store = useChatStore.getState()
  store.startStreaming('request')
  store.addToolCall({ id: 'tc-1', name: 'ask_specialist', input: {}, providerType: 'agent' })
  const sub = (text: string, extra: Partial<Extract<RunEvent, { type: 'delta' }>> = {}): void =>
    useChatStore.getState().appendToolSubEvent('tc-1', { type: 'delta', kind: 'text', text, ...extra })
  sub('the Florian Rockenhä')
  sub('Bash: psql', { kind: 'tool', toolName: 'Bash', toolId: 'b1', parentToolId: 'agent-1' })
  sub('Confirmed.', { parentToolId: 'agent-1' })
  sub('user / Traffective')
  sub('Next', { newPart: true })
  const block = useChatStore.getState().streamingBlocks.find((b) => b.type === 'tool_call')
  const subParts = block?.type === 'tool_call' ? block.subParts ?? [] : []
  expect(subParts.map((part) => [part.text, part.parentToolId])).toEqual([
    ['the Florian Rockenhäuser / Traffective', undefined],
    ['Bash: psql', 'agent-1'],
    ['Confirmed.', 'agent-1'],
    ['Next', undefined]
  ])
})
