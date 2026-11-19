import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { NoticeWarningAnnouncer, resetNoticeWarningAnnouncerForTest } from './NoticeWarningAnnouncer'

/**
 * The transcript's live region for warning notices: present and empty from
 * the start, given each distinct live warning once — never again on a
 * re-render or a remount, and never an info notice.
 */

const u = undefined
const warn = (text: string): void => useChatStore.getState().appendDelta(text, 'notice', u, u, u, u, u, u, u, true, 'warning')

beforeEach(() => {
  resetNoticeWarningAnnouncerForTest()
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, activeRequestId: null })
})

describe('NoticeWarningAnnouncer', () => {
  it('starts empty, then reads each distinct warning once', () => {
    // Mutation: drop the `announced.has(key)` check → the remount below reads the warning again.
    act(() => useChatStore.getState().startStreaming('req-1'))
    const first = render(<NoticeWarningAnnouncer chatId="chat" />)
    const region = (): HTMLElement => screen.getByRole('status')
    expect(region().textContent).toBe('')

    act(() => useChatStore.getState().appendDelta('Starting up.', 'notice', u, u, u, u, u, u, u, true))
    expect(region().textContent).toBe('')

    act(() => warn('Gemini answered an error (503).'))
    expect(region().textContent).toBe('Gemini answered an error (503).')
    act(() => useChatStore.getState().appendDelta('Some text', 'text'))
    expect(region().textContent).toBe('Gemini answered an error (503).')

    // A remount (a chat switch and back) does not read it out again.
    first.unmount()
    render(<NoticeWarningAnnouncer chatId="chat" />)
    expect(region().textContent).toBe('')

    act(() => warn('No reply from Antigravity after 90 seconds.'))
    expect(region().textContent).toBe('No reply from Antigravity after 90 seconds.')
  })

  it('reads the same warning again in a later turn', () => {
    act(() => useChatStore.getState().startStreaming('req-1'))
    const first = render(<NoticeWarningAnnouncer chatId="chat" />)
    act(() => warn('Same error.'))
    expect(screen.getByRole('status').textContent).toBe('Same error.')
    const node = screen.getByRole('status').firstChild
    // The same mount, as in the app (the transcript is not remounted between turns).
    act(() => useChatStore.getState().startStreaming('req-2'))
    act(() => warn('Same error.'))
    expect(screen.getByRole('status').textContent).toBe('Same error.')
    // A new node, so the live region changed and is read again.
    expect(screen.getByRole('status').firstChild).not.toBe(node)
    first.unmount()
  })

  it('empties the region when the chat changes', () => {
    act(() => useChatStore.getState().startStreaming('req-1'))
    const view = render(<NoticeWarningAnnouncer chatId="chat" />)
    act(() => warn('Chat one error.'))
    expect(screen.getByRole('status').textContent).toBe('Chat one error.')
    // A chat switch replaces the live blocks with the other chat's (none here).
    act(() => useChatStore.getState().startStreaming('req-other'))
    view.rerender(<NoticeWarningAnnouncer chatId="other" />)
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
