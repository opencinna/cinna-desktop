import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `hasNotes` gates the hint that teaches the `?` note picker. The picker opens
 * only with Notes on (Settings → Features → Capabilities), so a profile with
 * notes but Notes off must not be taught a key that does nothing.
 */

const state = vi.hoisted(() => ({ notesEnabled: true, notes: [{ id: 'n1', title: 'Plan', body: '' }] as Array<{ id: string; title: string; body: string }> }))
vi.mock('./useCapabilities', () => ({ useCapabilities: () => ({ notesEnabled: state.notesEnabled, dashboardsEnabled: false, loaded: true }) }))
vi.mock('./useNotes', async () => {
  const { splitNotes } = await import('../utils/noteFormat/noteIndex')
  return { useNoteCollections: () => ({ ...splitNotes(state.notes), isLoading: false }) }
})
vi.mock('./useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('./useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('./useChatModes', () => ({ useChatModes: () => ({ data: [] }) }))
vi.mock('./useCliCommands', () => ({ useCliCommands: () => ({ data: [] }) }))
vi.mock('./useAttachDestination', () => ({ useHasAttachDestination: () => false }))

const { useHintContext } = await import('./useHintContext')

beforeEach(() => {
  state.notesEnabled = true
  state.notes = [{ id: 'n1', title: 'Plan', body: '' }]
})

describe('useHintContext hasNotes', () => {
  it('is true with notes while Notes is on', () => {
    expect(renderHook(() => useHintContext(null, 0)).result.current.hasNotes).toBe(true)
  })

  it('is false while Notes is off, notes or not', () => {
    state.notesEnabled = false
    expect(renderHook(() => useHintContext(null, 0)).result.current.hasNotes).toBe(false)
  })

  it('is false when the only notes are Assistant memory notes', () => {
    state.notes = [{ id: 'm1', title: 'Tea', body: '---\nkind: assistant-memory\n---\nLikes tea' }]
    expect(renderHook(() => useHintContext(null, 0)).result.current.hasNotes).toBe(false)
  })

  it('is false with no notes', () => {
    state.notes = []
    expect(renderHook(() => useHintContext(null, 0)).result.current.hasNotes).toBe(false)
  })
})
