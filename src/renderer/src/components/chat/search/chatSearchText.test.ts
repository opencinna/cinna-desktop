import { describe, expect, it } from 'vitest'
import { countMatches, searchChatMessages, searchTimeLabel, textRanges } from './chatSearchText'

describe('chat search text', () => {
  it('counts case-insensitive, non-overlapping matches', () => {
    expect(countMatches('Retry, retrying, RETRY', 'retry')).toBe(3)
    expect(countMatches('aaaa', 'aa')).toBe(2)
    expect(countMatches('anything', '')).toBe(0)
  })

  it('finds user and assistant messages only, in transcript order', () => {
    const messages = [
      { id: '1', role: 'assistant', content: 'deploy now' },
      { id: '2', role: 'tool_call', content: 'deploy log' },
      { id: '3', role: 'error', content: 'deploy failed' },
      { id: '4', role: 'user', content: 'Deploy again, deploy!' }
    ]
    expect(searchChatMessages(messages, ' deploy ').map((hit) => [hit.message.id, hit.count])).toEqual([['1', 1], ['4', 2]])
    expect(searchChatMessages(messages, '  ')).toEqual([])
  })

  it('labels times relative to today', () => {
    const now = new Date(2026, 9, 14, 18, 0)
    expect(searchTimeLabel(new Date(2026, 9, 14, 9, 26), now)).toMatch(/^Today 0?9:26/)
    expect(searchTimeLabel(new Date(2026, 9, 13, 14, 12), now)).toMatch(/^Yesterday (14|0?2):12/)
    expect(searchTimeLabel(new Date(2026, 9, 10, 8, 0), now)).toMatch(/ 0?8:00/)
    expect(searchTimeLabel(new Date(2026, 8, 30, 8, 0), now)).not.toMatch(/\d\d:\d\d/)
  })

  it('finds ranges in rendered text, skipping buttons', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Retry <b>retry</b></p><button>retry</button>'
    expect(textRanges(root, 'RETRY').map((range) => range.toString())).toEqual(['Retry', 'retry'])
  })
})
