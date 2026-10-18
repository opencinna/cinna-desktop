import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The running sessions per agent, read from the process-local turn maps: a
 * main-owned run, or a task runner working in a chat. Only chats the profile
 * sees, only turns an agent answers, newest first; a turn opening or closing
 * is pushed to the windows.
 */

const chats = vi.hoisted(() => new Map<string, { id: string; title: string; agentId: string | null; deletedAt: Date | null }>())
vi.mock('../auth/chatScope', () => ({
  visibleChat: (profileUserId: string, chatId: string) => profileUserId === 'profile-1' ? chats.get(chatId) : undefined
}))
const publishEvent = vi.hoisted(() => vi.fn())
vi.mock('../host/events', () => ({ publishEvent }))

const { activeAgentSessions, liveAgentIds } = await import('./activeAgentSessions')
const { activeRunsByChat, runClosed, runOpened } = await import('./runExecutionState')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { AGENT_SESSIONS_CHANGED_CHANNEL } = await import('../../shared/agentSessions')

function chat(id: string, title: string, agentId: string | null, deletedAt: Date | null = null): void {
  chats.set(id, { id, title, agentId, deletedAt })
}

function open(chatId: string, agentId: string | null): void {
  activeRunsByChat.set(chatId, { id: `run-${chatId}`, agentId } as never)
  runOpened(chatId)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
  publishEvent.mockClear()
})

afterEach(() => {
  for (const chatId of [...activeRunsByChat.keys()]) { activeRunsByChat.delete(chatId); runClosed(chatId) }
  taskRunnersByChat.clear()
  chats.clear()
  vi.useRealTimers()
})

describe('activeAgentSessions', () => {
  it('lists each agent’s running chats, newest first, with the title the warning names', () => {
    chat('c-old', 'Reconcile August', 'agent-a')
    chat('c-new', 'New Chat', 'agent-a')
    chat('c-task', 'Close the books', 'agent-b')
    open('c-old', 'agent-a')
    vi.setSystemTime(new Date('2026-10-18T10:05:00Z'))
    open('c-new', 'agent-a')
    // A task runner working in a chat, with no main-owned run: the chat's bound agent.
    taskRunnersByChat.set('c-task', { userId: 'profile-1', taskId: 't-1', id: 'r-1', working: true, cancel: () => {} })

    expect(activeAgentSessions('profile-1')).toEqual([
      { agentId: 'agent-a', chatId: 'c-new', title: null, startedAt: Date.parse('2026-10-18T10:05:00Z') },
      { agentId: 'agent-a', chatId: 'c-old', title: 'Reconcile August', startedAt: Date.parse('2026-10-18T10:00:00Z') },
      { agentId: 'agent-b', chatId: 'c-task', title: 'Close the books' }
    ])
  })

  it('leaves out the local model, an idle runner, a trashed chat and a chat the profile does not see', () => {
    chat('c-model', 'Plain chat', null)
    chat('c-idle', 'Waiting', 'agent-a')
    chat('c-trashed', 'Gone', 'agent-a', new Date())
    open('c-model', null)
    taskRunnersByChat.set('c-idle', { userId: 'profile-1', taskId: 't-2', id: 'r-2', working: false, cancel: () => {} })
    open('c-trashed', 'agent-a')
    open('c-elsewhere', 'agent-a')
    expect(activeAgentSessions('profile-1')).toEqual([])
    expect(activeAgentSessions('profile-2')).toEqual([])
  })

  it('takes the run’s own agent over the chat’s bound one', () => {
    chat('c-1', 'Handover', 'agent-a')
    open('c-1', 'agent-z')
    expect(activeAgentSessions('profile-1').map((session) => session.agentId)).toEqual(['agent-z'])
  })

  it('tells the windows when a turn takes or lets go of a chat', () => {
    chat('c-1', 'Reconcile August', 'agent-a')
    open('c-1', 'agent-a')
    expect(publishEvent).toHaveBeenCalledWith(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId: 'c-1' })
    publishEvent.mockClear()
    activeRunsByChat.delete('c-1')
    runClosed('c-1')
    expect(publishEvent).toHaveBeenCalledWith(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId: 'c-1' })
    expect(activeAgentSessions('profile-1')).toEqual([])
  })
})

describe('a task runner’s reservation', () => {
  const runner = (working: boolean) => ({ userId: 'profile-1', taskId: 't-1', id: 'r-1', working, cancel: () => {} })

  it('tells the windows when a runner starts or stops working in a chat, with no run opening or closing', () => {
    // Mutation: drop the `onTaskRunnerWorkingChanged` subscription (or the
    // map's notify) → a queued autonomous task never raises the notice, and a
    // cancelled one leaves it stale.
    chat('c-task', 'Close the books', 'agent-b')
    taskRunnersByChat.set('c-task', runner(true))
    expect(publishEvent).toHaveBeenCalledWith(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId: 'c-task' })
    expect(activeAgentSessions('profile-1').map((session) => session.chatId)).toEqual(['c-task'])

    // Waiting on an ask: no longer working.
    publishEvent.mockClear()
    taskRunnersByChat.set('c-task', runner(false))
    expect(publishEvent).toHaveBeenCalledWith(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId: 'c-task' })
    expect(activeAgentSessions('profile-1')).toEqual([])

    // Working again, then cancelled (removed).
    taskRunnersByChat.set('c-task', runner(true))
    publishEvent.mockClear()
    taskRunnersByChat.delete('c-task')
    expect(publishEvent).toHaveBeenCalledWith(AGENT_SESSIONS_CHANGED_CHANNEL, { chatId: 'c-task' })
    expect(activeAgentSessions('profile-1')).toEqual([])
  })

  it('stays quiet when nothing a window shows moved: an idle reservation, or one replaced still working', () => {
    taskRunnersByChat.set('c-idle', runner(false))
    taskRunnersByChat.delete('c-idle')
    taskRunnersByChat.set('c-task', runner(true))
    publishEvent.mockClear()
    taskRunnersByChat.set('c-task', { ...runner(true), id: 'r-2' })
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

describe('liveAgentIds', () => {
  it('names the agent of every turn running now, a chat the profile does not see included', () => {
    chat('c-1', 'Reconcile August', 'agent-a')
    open('c-1', 'agent-a')
    open('c-elsewhere', 'agent-b')
    taskRunnersByChat.set('c-1b', { userId: 'profile-1', taskId: 't-3', id: 'r-3', working: true, cancel: () => {} })
    expect(liveAgentIds('profile-1').sort()).toEqual(['agent-a', 'agent-b'])
  })
})
