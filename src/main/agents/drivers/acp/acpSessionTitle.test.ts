import { describe, expect, it, vi } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import stopFixture from './__fixtures__/codex/async_task_stop.json'
import { agentTitlesChat, createSessionTitles, isPromptPlaceholder, sessionInfoTitle, type SessionTitleScope } from './acpSessionTitle'

const SCOPE: SessionTitleScope = { launcherId: 'codex', chatId: 'chat', agentId: 'agent', sessionId: 'root', profileUserId: 'user' }
const info = (title: unknown, sessionId = 'root'): SessionNotification =>
  ({ sessionId, update: { sessionUpdate: 'session_info_update', title } }) as unknown as SessionNotification

describe('a Codex thread title, as recorded', () => {
  const titles = (stopFixture as unknown as { notifications: SessionNotification[] }).notifications.map(sessionInfoTitle).filter((title): title is string => title !== null)

  it('is the prompt verbatim first, then the generated title', () => {
    expect(titles).toHaveLength(2)
    expect(isPromptPlaceholder(titles[0], [titles[0]])).toBe(true)
    expect(isPromptPlaceholder(titles[1], [titles[0]])).toBe(false)
  })
})

describe('isPromptPlaceholder', () => {
  it('matches the prompt, whitespace-normalized, and a start of it', () => {
    expect(isPromptPlaceholder('Fix  the\nparser', ['Fix the parser'])).toBe(true)
    // A short title the prompt starts with is Codex's name for it; a long cut is the prompt.
    expect(isPromptPlaceholder('Fix flaky parser test', ['Fix flaky parser test and add coverage'])).toBe(false)
    expect(isPromptPlaceholder('Refactor the parser module so that every token', ['Refactor the parser module so that every token keeps its span'])).toBe(true)
    expect(isPromptPlaceholder('Parser fix', ['Fix the parser'])).toBe(false)
  })
})

describe('createSessionTitles', () => {
  it('offers only a root session’s generated title, for an engine that names its chat', () => {
    const sink = vi.fn()
    const titles = createSessionTitles(sink)
    titles.prompted(SCOPE, [{ type: 'text', text: 'Fix the parser' }])
    titles.observe(SCOPE, info('Fix the parser'))
    titles.observe(SCOPE, info('Title of a child', 'child'))
    titles.observe(SCOPE, { sessionId: 'root', update: { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } } } as unknown as SessionNotification)
    titles.observe(SCOPE, info('Parser repair'))
    expect(sink.mock.calls).toEqual([[{ profileUserId: 'user', chatId: 'chat', agentId: 'agent', title: 'Parser repair' }]])
  })

  it('knows a placeholder of a prompt sent in several blocks', () => {
    const sink = vi.fn()
    const titles = createSessionTitles(sink)
    titles.prompted(SCOPE, [{ type: 'text', text: '[user] earlier' }, { type: 'text', text: 'Now this' }])
    titles.observe(SCOPE, info('[user] earlier Now this'))
    titles.observe(SCOPE, info('Now this'))
    expect(sink).not.toHaveBeenCalled()
  })

  it('names nothing for Claude, a nested turn, or a session it never prompted', () => {
    const sink = vi.fn()
    const titles = createSessionTitles(sink)
    const claude = { ...SCOPE, launcherId: 'claude' as const }
    const nested = { ...SCOPE, profileUserId: undefined }
    for (const scope of [claude, nested]) {
      titles.prompted(scope, [{ type: 'text', text: 'hi' }])
      titles.observe(scope, info('A title'))
    }
    titles.observe({ ...SCOPE, sessionId: 'loaded' }, info('A title', 'loaded'))
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('agentTitlesChat', () => {
  it('is true for a local Codex agent or runtime, and for nothing else', () => {
    expect(agentTitlesChat({ driver: 'acp', driverConfig: { launcher: 'codex', conductorChatId: 'c' } })).toBe(true)
    expect(agentTitlesChat({ driver: 'acp', driverConfig: { launcher: 'claude' } })).toBe(false)
    expect(agentTitlesChat({ driver: 'acp', driverConfig: { launcher: 'codex', transport: 'websocket' } })).toBe(false)
    expect(agentTitlesChat({ driver: 'a2a', driverConfig: null })).toBe(false)
  })
})
