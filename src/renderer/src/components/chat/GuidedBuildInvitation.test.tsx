import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { GUIDED_BUILD_STARTERS, GuidedBuildInvitation, guidedBuildPlaceholder } from './GuidedBuildInvitation'

const markGuidedBuildDone = vi.fn()
const onFill = vi.fn()

function mount(hold: string | null = null, withHeading?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <GuidedBuildInvitation agentId="folder:a" agentName="Mail helper" hold={hold} onFill={onFill} withHeading={withHeading} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  markGuidedBuildDone.mockReset().mockResolvedValue({ ok: true, value: { id: 'folder:a' } })
  onFill.mockReset()
  window.api = { localAgents: { markGuidedBuildDone } } as never
})

describe('the guided-build invitation', () => {
  it('invites the person to set the agent up, in its own name', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'Set up Mail helper' })).toBeTruthy()
    expect(screen.getByText('A blank agent. Say what job it should do — it asks a few questions, then builds itself with you.')).toBeTruthy()
    expect(guidedBuildPlaceholder('Mail helper')).toBe('Describe what Mail helper should do for you…')
  })

  it('is only its starters and links where the screen’s own heading box says the rest', () => {
    // Mutation: keep the heading here too, and the main New chat screen shows it twice.
    mount(null, false)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByText(/A blank agent/)).toBeNull()
    expect(screen.getByRole('region', { name: 'Set up Mail helper' })).toBeTruthy()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      ...GUIDED_BUILD_STARTERS.map((s) => s.label), 'What can agents do?', 'Skip guidance'
    ])
  })

  it('fills the composer from a starter and never sends', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Check something daily' }))
    expect(onFill).toHaveBeenCalledWith('Every ⟨weekday morning⟩, check ⟨where⟩ and tell me ⟨what⟩.')
    expect(GUIDED_BUILD_STARTERS.map((s) => s.label)).toEqual([
      'Help me with a job', 'Check something daily', 'Work on files I send', 'Interview me'
    ])
    // Every starter but the open one carries a placeholder to type over.
    expect(GUIDED_BUILD_STARTERS.slice(0, 3).every((s) => s.text.includes('⟨'))).toBe(true)
  })

  it('holds its starters while the agent’s prompts are drafted', () => {
    mount('Drafting this agent’s prompts — send when it finishes.')
    const starter = screen.getByRole('button', { name: 'Interview me' }) as HTMLButtonElement
    expect(starter.disabled).toBe(true)
    fireEvent.click(starter)
    expect(onFill).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Skip guidance' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('lists the seven capabilities in plain words behind What can agents do?', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'What can agents do?' }))
    const popover = screen.getByRole('dialog', { name: 'What can agents do?' })
    expect(popover.querySelectorAll('li')).toHaveLength(7)
    expect(popover.textContent).toContain('Credentials tab')
    expect(popover.textContent).not.toMatch(/manifest|\.json|\.py/)
  })

  it('marks the guided build dismissed on Skip guidance, and says a failure', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Skip guidance' }))
    await waitFor(() => expect(markGuidedBuildDone).toHaveBeenCalledWith('folder:a'))

    markGuidedBuildDone.mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'That agent is no longer in your agents folder.' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip guidance' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That agent is no longer in your agents folder.')
  })
})
