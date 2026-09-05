import { act, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * Delete is the one destructive action on the agent page. Three things are
 * pinned: it always confirms first, a confirmed delete clears the selection
 * (the row is gone, and a page still asking for it would report the folder as
 * "not indexed"), and a `turn_in_progress` refusal is explained as "busy",
 * not as a failure — nothing was removed. Stamp identity is only offered to a
 * legacy folder.
 */

const remove = vi.fn()
let removePending = false
/** The hook-level `onSuccess` the menu registers — the one that survives unmounts. */
let hookOptions: { onSuccess?: () => void } | undefined
const setActiveLocalAgentId = vi.fn()
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveLocalAgentId })
}))
vi.mock('../../../hooks/useLocalAgents', () => ({
  useDeleteLocalAgent: (options?: { onSuccess?: () => void }) => {
    hookOptions = options
    return { mutate: remove, isPending: removePending }
  },
  useRescanLocalAgents: () => ({ mutate: vi.fn(), isPending: false }),
  useStampAgentIdentity: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../../hooks/useLocalTools', () => ({
  useOpenIn: () => ({ mutate: vi.fn() })
}))

const { AgentActionsMenu } = await import('./AgentActionsMenu')

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:alpha',
    name: 'Alpha',
    path: '/tmp/agents/alpha',
    rootId: 'root-1',
    identity: 'manifest',
    stamps: { 'cinna-agent.json': { mtimeMs: 1, size: 1, hash: 'h' } },
    ...overrides
  } as LocalAgentDto
}

function openMenu(a: LocalAgentDto = agent()): void {
  render(createElement(AgentActionsMenu, { agent: a, onError: vi.fn() }))
  fireEvent.click(screen.getByRole('button', { name: /more actions/i }))
}

type DeleteOptions = { onError: (err: Error) => void }
function lastDeleteOptions(): DeleteOptions {
  return remove.mock.calls[0][1] as DeleteOptions
}

afterEach(() => {
  vi.clearAllMocks()
  removePending = false
  hookOptions = undefined
})

describe('AgentActionsMenu — delete', () => {
  it('asks before deleting, then deletes and clears the selection', () => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /delete agent/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /move to trash/i }))
    expect(remove).toHaveBeenCalledWith('folder:alpha', expect.anything())

    // Success is handled at hook level — a mutate-level callback is dropped by
    // TanStack once the caller has unmounted, and the dialog can be dismissed.
    act(() => hookOptions?.onSuccess?.())
    expect(setActiveLocalAgentId).toHaveBeenCalledWith(null)
    expect(screen.queryByRole('dialog', { name: /delete agent/i })).toBeNull()
  })

  it('cannot be dismissed while the delete is in flight', () => {
    removePending = true
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(screen.getByRole('dialog', { name: /delete agent/i })).toBeTruthy()
    expect((screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('explains a mid-turn refusal as busy and keeps the dialog open', () => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    fireEvent.click(screen.getByRole('button', { name: /move to trash/i }))

    const busy = Object.assign(new Error('This agent is busy right now.'), {
      code: 'turn_in_progress'
    })
    act(() => lastDeleteOptions().onError(busy))
    expect(screen.getByText(/middle of a turn/i)).toBeTruthy()
    expect(screen.getByRole('dialog', { name: /delete agent/i })).toBeTruthy()
    expect(setActiveLocalAgentId).not.toHaveBeenCalled()
  })

  it('cancels without deleting', () => {
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: /delete agent/i })).toBeNull()
  })
})

describe('AgentActionsMenu — stamp identity', () => {
  it('is offered only to a legacy folder', () => {
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /stamp identity/i })).toBeNull()
  })

  it('appears for a legacy folder whose manifest could be read', () => {
    openMenu(agent({ identity: 'legacy' }))
    expect(screen.getByRole('menuitem', { name: /stamp identity/i })).toBeTruthy()
  })
})
