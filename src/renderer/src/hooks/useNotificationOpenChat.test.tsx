import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { useNotificationOpenChat } from './useNotificationOpenChat'

let pushed: ((data: { chatId: string }) => void) | null = null
const takePendingOpenChat = vi.fn<() => Promise<{ chatId: string } | null>>()

beforeEach(() => {
  pushed = null
  takePendingOpenChat.mockReset().mockResolvedValue(null)
  vi.stubGlobal('api', {
    notifications: {
      onOpenChat: (handler: (data: { chatId: string }) => void) => {
        pushed = handler
        return () => { pushed = null }
      },
      takePendingOpenChat
    }
  })
  Object.assign(window, { api: (globalThis as unknown as { api: unknown }).api })
  useChatStore.getState().setActiveChatId(null)
  useUIStore.getState().setActiveView('settings')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useNotificationOpenChat', () => {
  it('opens a chat a click asked for before the renderer was mounted', async () => {
    // Mutation: drop the take-on-mount → the chat a recreated window was asked for never opens.
    takePendingOpenChat.mockResolvedValue({ chatId: 'chat-1' })
    renderHook(() => useNotificationOpenChat())
    expect(takePendingOpenChat).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-1'))
    expect(useUIStore.getState().activeView).toBe('chat')
  })

  it('takes the pending chat on every push, so a delivered click is not reopened at the next mount', async () => {
    // Mutation: drop the take in the push handler → main keeps the click and a later mount opens it again.
    renderHook(() => useNotificationOpenChat())
    await waitFor(() => expect(takePendingOpenChat).toHaveBeenCalledTimes(1))
    pushed!({ chatId: 'chat-3' })
    expect(takePendingOpenChat).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().activeChatId).toBe('chat-3')
  })

  it('opens the chat a push names, and nothing when none is pending', async () => {
    renderHook(() => useNotificationOpenChat())
    await waitFor(() => expect(takePendingOpenChat).toHaveBeenCalled())
    expect(useChatStore.getState().activeChatId).toBeNull()
    pushed!({ chatId: 'chat-2' })
    expect(useChatStore.getState().activeChatId).toBe('chat-2')
    expect(useUIStore.getState().activeView).toBe('chat')
  })
})
