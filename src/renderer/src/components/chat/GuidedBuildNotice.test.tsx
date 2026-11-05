import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AlertTriangle } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { GUIDED_BUILD_NOTICE_TEXT, guidedBuildPlaceholder, useGuidedBuildNotice } from './GuidedBuildNotice'
import { ComposerNoticePanel, type ComposerNotice } from './ComposerNoticePanel'

const markGuidedBuildDone = vi.fn()

const WARNING: ComposerNotice = { key: 'w', tone: 'warning', icon: AlertTriangle, text: 'Engine not installed' }

function Harness({ agentId, extra = [] }: { agentId: string | null; extra?: ComposerNotice[] }): React.JSX.Element {
  const notice = useGuidedBuildNotice(agentId)
  return <ComposerNoticePanel notices={[...(notice ? [notice] : []), ...extra]} />
}

function mount(agentId: string | null = 'folder:a', extra: ComposerNotice[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (id: string | null) => <QueryClientProvider client={client}><Harness agentId={id} extra={extra} /></QueryClientProvider>
  const view = render(tree(agentId))
  return { ...view, rerender: (id: string | null) => view.rerender(tree(id)) }
}

beforeEach(() => {
  markGuidedBuildDone.mockReset().mockResolvedValue({ ok: true, value: { id: 'folder:a' } })
  window.api = { localAgents: { markGuidedBuildDone } } as never
})

describe('the guided-build composer row', () => {
  it('is one accent line with Skip guidance on its right and no ×, in a panel named Guidance', () => {
    mount()
    const panel = screen.getByRole('status', { name: 'Guidance' })
    expect(panel.getAttribute('data-tone')).toBe('accent')
    const row = within(panel).getByText(GUIDED_BUILD_NOTICE_TEXT)
    expect(GUIDED_BUILD_NOTICE_TEXT).toBe('New agent — this chat starts with guidance, then builds it with you.')
    expect(row.className).toContain('truncate')
    expect(row.getAttribute('title')).toBe(GUIDED_BUILD_NOTICE_TEXT)
    // The Compass glyph, then the sentence, then the action, on one line.
    const line = row.parentElement as HTMLElement
    expect(line.querySelector('svg.lucide-compass')).toBeTruthy()
    expect(within(line).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.querySelector('[aria-hidden="false"]')?.textContent)).toEqual(['Skip guidance'])
    expect(within(panel).queryByRole('button', { name: /dismiss/i })).toBeNull()
    expect(guidedBuildPlaceholder('Mail helper')).toBe('Describe what Mail helper should do for you…')
  })

  it('is no row without an agent', () => {
    mount(null)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stacks first with a readiness row, and the panel is the agent’s status again', () => {
    mount('folder:a', [WARNING])
    const panel = screen.getByRole('status', { name: 'Agent status' })
    expect(within(panel).getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent)).toEqual([
      GUIDED_BUILD_NOTICE_TEXT, 'Engine not installed'
    ])
  })

  it('marks the guided build dismissed on Skip guidance, Skipping… meanwhile', async () => {
    let resolve: (v: unknown) => void = () => {}
    markGuidedBuildDone.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Skip guidance' }))
    await waitFor(() => expect(markGuidedBuildDone).toHaveBeenCalledWith('folder:a'))
    const pending = await screen.findByRole('button', { name: 'Skipping…' })
    expect(pending.getAttribute('aria-disabled')).toBe('true')
    // A second click while it runs asks nothing more.
    fireEvent.click(pending)
    expect(markGuidedBuildDone).toHaveBeenCalledTimes(1)
    resolve({ ok: true, value: { id: 'folder:a' } })
    // Done, it stays Skipping… until the refetched folder list ends the row.
    await waitFor(() => expect(markGuidedBuildDone).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('button', { name: 'Skipping…' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('says a failure in the sentence’s place, beside the button, and only for that agent', async () => {
    markGuidedBuildDone.mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'That agent is no longer in your agents folder.' })
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Skip guidance' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('That agent is no longer in your agents folder.')
    expect(screen.queryByText(GUIDED_BUILD_NOTICE_TEXT)).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Skip guidance' })).toBeTruthy()
    view.rerender('folder:b')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(GUIDED_BUILD_NOTICE_TEXT)).toBeTruthy()
  })
})
