import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Leaving a tabless view by the tab that is already selected.
 *
 * The Inbox belongs to no tab, which makes it the one center the *unchanged*
 * tab has to be able to replace — and the body that replaces it was written for
 * a genuine tab change, where clearing the old tab's selection is the point.
 * Running that body for a press that changed no tab throws away the chat, job
 * or note the user was on before they stepped into the inbox.
 *
 * The task page is the second such center, and it is reached from *two* places
 * — a job's run rows and an inbox entry — so which tab is selected while it is
 * open depends on where the user came from. Pressing that tab has to get them
 * out. Left as the inbox's special case, opening a task from the inbox with
 * Chats selected would have been a screen with no way back to the chat list.
 */

vi.mock('../../hooks/useChat', () => ({
  useChatList: () => ({ data: [{ id: 'first-chat' }, { id: 'other-chat' }] })
}))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { SidebarTabs } = await import('./SidebarTabs')
const { useUIStore } = await import('../../stores/ui.store')
const { useChatStore } = await import('../../stores/chat.store')

beforeEach(() => {
  useUIStore.setState({ activeView: 'inbox', sidebarTab: 'chats', activeJobId: 'j1' } as never)
  useChatStore.setState({ activeChatId: 'other-chat' } as never)
})

describe('SidebarTabs and the inbox', () => {
  it('leaves the inbox on the tab already selected, keeping what was open', () => {
    // Mutation: delete the `target === sidebarTab` early return and this fails
    // on the last line — the user comes back from the inbox to the *first*
    // chat rather than the one they left.
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Chats' }).click()
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
  })

  it('still clears the old tab when the tab really changes', () => {
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Jobs' }).click()
    expect(useUIStore.getState().activeView).toBe('job-detail')
    expect(useUIStore.getState().activeJobId).toBeNull()
  })

  it('leaves the task page the same way, whichever tab is selected under it', () => {
    // Mutation: narrow `TABLESS_VIEWS` back to `['inbox']` and this fails —
    // the press is swallowed and the user stays on the task with the Chats
    // list beside it.
    useUIStore.setState({ activeView: 'task' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Chats' }).click()
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
  })

  it('forgets the task when the tab really changes', () => {
    useUIStore.setState({ activeView: 'task', activeTaskId: 't1' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Notes' }).click()
    expect(useUIStore.getState().activeView).toBe('note-detail')
    expect(useUIStore.getState().activeTaskId).toBeNull()
  })

  it('does nothing when the selected tab is pressed and the inbox is not open', () => {
    useUIStore.setState({ activeView: 'chat' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Chats' }).click()
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
  })
})

describe('SidebarTabs returning to Chats from another tab', () => {
  it('reopens the chat that was open last, such as the one a note was saved from', () => {
    useUIStore.setState({ activeView: 'note-detail', sidebarTab: 'notes', activeNoteId: 'n1' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Chats' }).click()
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
  })

  it.each([null, 'deleted-chat'])('falls back to the first chat when the last one is %s', (lastChatId) => {
    useUIStore.setState({ activeView: 'job-detail', sidebarTab: 'jobs' } as never)
    useChatStore.setState({ activeChatId: lastChatId } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Chats' }).click()
    expect(useChatStore.getState().activeChatId).toBe('first-chat')
  })
})
