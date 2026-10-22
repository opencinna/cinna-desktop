import { afterEach, describe, expect, it } from 'vitest'
import { installChatSessionForgetter, releaseChatSessions } from './chatSessionRelease'
import { sessionActivityHub } from './sessionActivityHub'

afterEach(() => sessionActivityHub.clear('chat-rel'))

describe('releaseChatSessions', () => {
  it('writes the agent\'s work off as lost and leaves a user command running', () => {
    const forgotten: Array<[string, string | undefined]> = []
    const uninstall = installChatSessionForgetter((chatId, agentId) => forgotten.push([chatId, agentId]))
    sessionActivityHub.report('chat-rel', 'agent-a', { type: 'upsert', id: 'bg', kind: 'background', title: 'npm test' })
    sessionActivityHub.report('chat-rel', 'agent-a', { type: 'upsert', id: 'cmd', kind: 'command', title: 'sleep 60', canStop: true })
    releaseChatSessions('chat-rel', 'agent-a')
    releaseChatSessions('chat-rel')
    uninstall()
    const states = Object.fromEntries(sessionActivityHub.snapshot('chat-rel').items.map((item) => [item.id, item.state]))
    expect(states).toEqual({ bg: 'lost', cmd: 'running' })
    expect(forgotten).toEqual([['chat-rel', 'agent-a'], ['chat-rel', undefined]])
  })
})
