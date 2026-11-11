vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * The room the transcript keeps for the Pinned files block (`reserve`): the
 * scroller's right padding widened to the block's gutter, or its top gap
 * shrunk under a block in the flow above it; and the reader's place kept
 * across the rewrap unless the view is pinned to the bottom.
 */

const stick = vi.hoisted(() => ({
  containerRef: { current: null as HTMLElement | null },
  contentRef: { current: null as HTMLElement | null },
  pinned: false
}))
const anchor = vi.hoisted(() => ({ keep: vi.fn(), restore: vi.fn(), paddingAtKeep: [] as string[], paddingAtRestore: [] as string[] }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: [{ id: 'm1', role: 'user', content: 'hello' }] } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ ...stick, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./transcriptAnchor', () => ({ holdCollapseAnchor: () => () => {}, keepAnchor: anchor.keep }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

beforeEach(() => {
  stick.containerRef.current = null
  stick.contentRef.current = null
  stick.pinned = false
  anchor.paddingAtKeep = []
  anchor.paddingAtRestore = []
  anchor.restore.mockReset().mockImplementation(() => anchor.paddingAtRestore.push(stick.containerRef.current!.style.paddingRight))
  anchor.keep.mockReset().mockImplementation(() => {
    anchor.paddingAtKeep.push(stick.containerRef.current!.style.paddingRight)
    return anchor.restore
  })
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

const scroller = (): HTMLElement => document.querySelector<HTMLElement>('[data-transcript-scroll]')!

describe('the Pinned files reserve', () => {
  it('keeps no room by default, and does not touch the reader’s place', () => {
    render(<MessageStream chatId="chat" />)
    expect(scroller().style.paddingRight).toBe('')
    expect(scroller().style.getPropertyValue('--transcript-pt')).toBe('')
    expect(anchor.keep).not.toHaveBeenCalled()
  })

  it('widens the right padding to the block’s gutter, then gives it back', () => {
    const { rerender } = render(<MessageStream chatId="chat" />)
    rerender(<MessageStream chatId="chat" reserve="right" />)
    // 224 px block + 20 px to the edge + 12 px clear of the column.
    expect(scroller().style.paddingRight).toBe('256px')
    rerender(<MessageStream chatId="chat" reserve={null} />)
    expect(scroller().style.paddingRight).toBe('')
  })

  it('under a block above it, keeps only its own small top gap and sticks table headers below its fade', () => {
    // No docked sidebar: the top bar's buttons lie over the transcript, until the block is above it.
    useUIStore.setState({ sidebarOpen: false })
    const { rerender } = render(<MessageStream chatId="chat" />)
    expect(scroller().style.getPropertyValue('--sticky-table-top')).toBe('var(--topbar-h)')
    rerender(<MessageStream chatId="chat" reserve="top" />)
    expect(scroller().style.getPropertyValue('--transcript-pt')).toBe('12px')
    expect(scroller().style.paddingRight).toBe('')
    expect(scroller().style.getPropertyValue('--sticky-table-top')).toBe('var(--transcript-fade)')
    rerender(<MessageStream chatId="chat" />)
    expect(scroller().style.getPropertyValue('--transcript-pt')).toBe('')
  })

  it('reads the reader’s place before the column changes and puts it back after, once per change', () => {
    const { rerender } = render(<MessageStream chatId="chat" />)
    rerender(<MessageStream chatId="chat" reserve="right" />)
    expect(anchor.paddingAtKeep).toEqual([''])
    expect(anchor.paddingAtRestore).toEqual(['256px'])
    // A re-render with the same room moves nothing.
    rerender(<MessageStream chatId="chat" reserve="right" />)
    expect(anchor.keep).toHaveBeenCalledTimes(1)
    rerender(<MessageStream chatId="chat" reserve={null} />)
    expect(anchor.paddingAtKeep).toEqual(['', '256px'])
    expect(anchor.paddingAtRestore).toEqual(['256px', ''])
  })

  it('leaves a view pinned to the bottom to the stick model', () => {
    stick.pinned = true
    const { rerender } = render(<MessageStream chatId="chat" />)
    rerender(<MessageStream chatId="chat" reserve="right" />)
    expect(scroller().style.paddingRight).toBe('256px')
    expect(anchor.keep).not.toHaveBeenCalled()
  })
})
