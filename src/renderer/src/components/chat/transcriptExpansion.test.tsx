vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AgentToolSubThread } from './AgentToolSubThread'
import { CollapsibleGroup } from './CollapsibleGroup'
import { NoticeBlock } from './NoticeBlock'
import { ToolResultBlock } from './ToolResultBlock'
import {
  TranscriptExpansionContext,
  createTranscriptExpansionStore,
  type TranscriptExpansionStore
} from './transcriptExpansion'

function inTranscript(store: TranscriptExpansionStore) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <TranscriptExpansionContext.Provider value={store}>{children}</TranscriptExpansionContext.Provider>
  }
}

describe('transcript expansion registry', () => {
  it('does not count an agent sub-thread opening because its agent streams', () => {
    const store = createTranscriptExpansionStore()
    const props = { agentName: 'Research', parts: [], status: 'pending' as const }
    const { container, rerender } = render(<AgentToolSubThread {...props} isStreaming={false} />, {
      wrapper: inTranscript(store)
    })
    const open = (): boolean => !!container.querySelector('svg.rotate-90')
    expect(open()).toBe(false)
    rerender(<AgentToolSubThread {...props} isStreaming />)
    expect(open()).toBe(true)
    expect(store.hasExpanded()).toBe(false)
    rerender(<AgentToolSubThread {...props} status="done" isStreaming={false} />)
    expect(open()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Research/ }))
    expect(open()).toBe(true)
    expect(store.hasExpanded()).toBe(true)
    act(() => store.collapseAll())
    expect(open()).toBe(false)
    expect(store.hasExpanded()).toBe(false)
  })

  it('measures a disclosure against its mount-time default, not its streaming state now', () => {
    const store = createTranscriptExpansionStore()
    const { rerender } = render(<ToolResultBlock content="out" isStreaming />, { wrapper: inTranscript(store) })
    expect(screen.getByText('out')).toBeTruthy()
    rerender(<ToolResultBlock content="out" isStreaming={false} />)
    expect(screen.getByText('out')).toBeTruthy()
    expect(store.hasExpanded()).toBe(false)
  })

  it('unregisters a counted block when it unmounts', () => {
    const store = createTranscriptExpansionStore()
    const { unmount } = render(<NoticeBlock content="Starting up" />, { wrapper: inTranscript(store) })
    fireEvent.click(screen.getByRole('button', { name: 'Show agent notice' }))
    expect(store.hasExpanded()).toBe(true)
    unmount()
    expect(store.hasExpanded()).toBe(false)
  })

  it('does not count a block opened inside a group the user then closed', () => {
    const store = createTranscriptExpansionStore()
    render(
      <CollapsibleGroup
        items={[
          { key: 'n', kind: 'tool_narration', node: <NoticeBlock content="Starting up" /> },
          { key: 'o', kind: 'tool_narration', node: <span>other step</span> }
        ]}
      />,
      { wrapper: inTranscript(store) }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand 2 steps' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show agent notice' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse 2 steps' }))
    expect(store.hasExpanded()).toBe(false)
    // Opening the group again brings both back into sight, and into the count.
    fireEvent.click(screen.getByRole('button', { name: 'Expand 2 steps' }))
    expect(store.hasExpanded()).toBe(true)
    act(() => store.collapseAll())
    expect(store.hasExpanded()).toBe(false)
  })

  it('is plain local state outside a transcript', () => {
    render(<NoticeBlock content="Starting up" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show agent notice' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide agent notice' }))
    expect(screen.getByRole('button', { name: 'Show agent notice' })).toBeTruthy()
  })

  it('notifies subscribers only when "anything expanded" flips', () => {
    const store = createTranscriptExpansionStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.set('a', () => {})
    store.set('b', () => {})
    store.set('a', null)
    expect(listener).toHaveBeenCalledTimes(1)
    store.set('b', null)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
