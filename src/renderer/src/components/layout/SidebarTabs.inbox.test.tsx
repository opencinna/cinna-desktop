import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Leaving the Inbox by the tab that is already selected.
 *
 * The Inbox belongs to no tab, which makes it the one center the *unchanged*
 * tab has to be able to replace — and the body that replaces it was written for
 * a genuine tab change, where clearing the old tab's selection is the point.
 * Running that body for a press that changed no tab throws away the chat, job
 * or note the user was on before they stepped into the inbox.
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

  it('does nothing when the selected tab is pressed and the inbox is not open', () => {
    useUIStore.setState({ activeView: 'chat' } as never)
    render(createElement(SidebarTabs))
    screen.getByRole('button', { name: 'Chats' }).click()
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
  })
})
