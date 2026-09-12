import { expect, it } from 'vitest'
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
