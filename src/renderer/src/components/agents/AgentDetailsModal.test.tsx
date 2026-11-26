import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDetailsFrameResult, AgentDetailsResult, AgentDetailsTarget, AgentDetailsView } from '../../../../shared/agentDetails'

/**
 * Agent Details in the renderer: the button appears only for an answer or a
 * failure worth retrying, the modal renders markdown as a document, shows the
 * publisher's HTML in a scriptless frame, and switches to the Platform
 * summary for a custom page.
 */

const get = vi.fn<(target: AgentDetailsTarget) => Promise<AgentDetailsResult>>()
const openFrame = vi.fn<(target: AgentDetailsTarget) => Promise<AgentDetailsFrameResult>>()
const releaseFrame = vi.fn<(token: string) => Promise<{ success: true }>>()
const frameEscape = new Set<() => void>()
const onEscape = vi.fn((handler: () => void) => {
  frameEscape.add(handler)
  return () => frameEscape.delete(handler)
})
window.api = { agentDetails: { get, openFrame, releaseFrame, onEscape } } as never

const { AgentDetailsButton } = await import('./AgentDetailsButton')
const { AgentDetailsModal } = await import('./AgentDetailsModal')
const { useAuthStore } = await import('../../stores/auth.store')

function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const TARGET: AgentDetailsTarget = { kind: 'agent', remoteAgentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }

const view = (over: Partial<AgentDetailsView> = {}): AgentDetailsView => ({
  source: 'custom',
  format: 'markdown',
  markdown: '# Weather Desk\n\nAsk me about **forecasts**.\n\n![Radar map](data:image/png;base64,xx)\n',
  generated: '## About\n\nGenerated summary.',
  warnings: [],
  revisionNumber: 10,
  ...over
})

beforeEach(() => {
  get.mockReset()
  openFrame.mockReset().mockResolvedValue({ ok: true, token: 'det-1', url: 'cinna-preview://det-1/' })
  releaseFrame.mockReset().mockResolvedValue({ success: true })
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user', cinnaServerUrl: 'https://cinna.test/' } as never })
})

const modal = () => render(<AgentDetailsModal target={TARGET} agentName="Weather" onClose={() => {}} />, { wrapper })

describe('AgentDetailsButton', () => {
  const button = () => render(<AgentDetailsButton target={TARGET} agentName="Weather" className="b" />, { wrapper })

  it.each([
    ['unsupported', 'Details are not available for this account.'],
    ['not_found', 'This agent has no Details page.']
  ] as const)('is hidden on %s', async (code, message) => {
    get.mockResolvedValue({ ok: false, code, message })
    button()
    await waitFor(() => expect(get).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /Details/ })).toBeNull()
  })

  it('is shown on unavailable, and the modal says why with Retry', async () => {
    get.mockResolvedValue({ ok: false, code: 'unavailable', message: 'Details could not be loaded. Try again.' })
    button()
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Weather' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Details could not be loaded. Try again.')
    // The modal reads again as it opens: Retry waits for that read.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false))
    get.mockResolvedValue({ ok: true, details: view() })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('forecasts')).toBeTruthy()
  })

  it('is shown for an answer', async () => {
    get.mockResolvedValue({ ok: true, details: view() })
    button()
    expect(await screen.findByRole('button', { name: 'Details of Weather' })).toBeTruthy()
  })
})

describe('AgentDetailsModal', () => {
  it('renders markdown as a document: an image is its alt text, raw HTML is dropped', async () => {
    get.mockResolvedValue({ ok: true, details: view({ markdown: '# T\n\n![Radar map](https://x/y.png)\n\n<b>raw</b> text\n' }) })
    modal()
    expect(await screen.findByText('[Radar map]')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-agent-details-markdown] b')).toBeNull()
  })

  it('switches between the publisher markdown and the Platform summary', async () => {
    get.mockResolvedValue({ ok: true, details: view() })
    modal()
    expect(await screen.findByText('forecasts')).toBeTruthy()
    const publisher = screen.getByRole('button', { name: 'Publisher’s page' })
    expect(publisher.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Platform summary' }))
    expect(screen.getByText('Generated summary.')).toBeTruthy()
    expect(screen.queryByText('forecasts')).toBeNull()
    fireEvent.click(publisher)
    expect(screen.getByText('forecasts')).toBeTruthy()
  })

  it('shows the publisher HTML in a frame without scripts or same origin, and releases it on the summary', async () => {
    get.mockResolvedValue({ ok: true, details: view({ format: 'html', markdown: null }) })
    modal()
    const frame = await waitFor(() => {
      const found = document.querySelector('iframe')
      if (!found) throw new Error('no frame yet')
      return found
    })
    expect(openFrame).toHaveBeenCalledWith(TARGET)
    expect(frame.getAttribute('src')).toBe('cinna-preview://det-1/')
    const sandbox = frame.getAttribute('sandbox') ?? ''
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-popups')
    expect(sandbox).not.toContain('allow-forms')
    fireEvent.click(screen.getByRole('button', { name: 'Platform summary' }))
    expect(screen.getByText('Generated summary.')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(releaseFrame).toHaveBeenCalledWith('det-1')
    fireEvent.click(screen.getByRole('button', { name: 'Publisher’s page' }))
    await waitFor(() => expect(openFrame).toHaveBeenCalledTimes(2))
  })

  it('offers no switch for a generated answer or a local agent', async () => {
    get.mockResolvedValue({ ok: true, details: view({ source: 'generated', markdown: '## About\n\nGenerated summary.' }) })
    modal()
    expect(await screen.findByText('Generated summary.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Platform summary' })).toBeNull()
  })

  it('keeps a frame failure in the body with Retry', async () => {
    get.mockResolvedValue({ ok: true, details: view({ format: 'html', markdown: null }) })
    openFrame.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: 'Details could not be loaded. Try again.' })
    modal()
    expect((await screen.findByRole('alert')).textContent).toContain('Details could not be loaded.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
  })

  it('says a version has no Details without offering Retry', async () => {
    get.mockResolvedValue({ ok: false, code: 'not_found', message: 'This agent has no Details page.' })
    modal()
    expect(await screen.findByText('This agent has no Details page.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('puts the frame on the HTML page colour, not the modal glass', async () => {
    get.mockResolvedValue({ ok: true, details: view({ format: 'html', markdown: null }) })
    modal()
    await waitFor(() => expect(document.querySelector('iframe')?.className).toContain('bg-[var(--color-html-page)]'))
  })

  it('takes Escape before anything else listening on the window', async () => {
    get.mockResolvedValue({ ok: true, details: view() })
    const onClose = vi.fn()
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    render(<AgentDetailsModal target={TARGET} agentName="Weather" onClose={onClose} />, { wrapper })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(behind).not.toHaveBeenCalled()
    window.removeEventListener('keydown', behind)
  })

  it('closes on Escape pressed inside the frame, which main forwards, and stops listening once closed', async () => {
    get.mockResolvedValue({ ok: true, details: view() })
    const onClose = vi.fn()
    const { unmount } = render(<AgentDetailsModal target={TARGET} agentName="Weather" onClose={onClose} />, { wrapper })
    expect(frameEscape.size).toBe(1)
    act(() => frameEscape.forEach((handler) => handler()))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(frameEscape.size).toBe(0)
  })
})
