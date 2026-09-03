import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * The menu-bar popup's failure layout — the same repair as the overlay's, and
 * the surface where it matters most: the tray is what a user looks at *instead*
 * of opening the app, so a blank popup is a silent answer.
 *
 * `TrayPanel` rendered `error ? <error> : <list>`. A folder agent's status is
 * read off local disk and is unaffected by anything the Cinna leg does, so a
 * remote failure blanking the popup hides good data to report a fault about
 * something else.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { TrayPanel } = await import('./TrayPanel')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

const folderRow = {
  agentId: 'folder:alpha',
  remoteAgentId: 'folder:alpha',
  name: 'Alpha',
  environmentId: 'local',
  severity: 'error',
  summary: 'disk full',
  reportedAt: '2026-09-02T10:15:00Z',
  reportedAtSource: 'frontmatter',
  fetchedAt: '2026-09-02T10:16:00Z',
  raw: null,
  body: '',
  hasStructuredMetadata: true,
  prevSeverity: null,
  severityChangedAt: null
}

function setApi(listResult: unknown): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    agentStatus: { list: vi.fn().mockResolvedValue(listResult), get: vi.fn() },
    tray: { startChat: vi.fn(), openStatusDetail: vi.fn(), hidePopup: vi.fn() }
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  setApi({ success: true, items: [], remoteError: null })
})

describe('TrayPanel — a remote failure with local rows to show', () => {
  it('keeps the folder agent in the popup and still reports the Cinna failure', async () => {
    setApi({
      success: true,
      items: [folderRow],
      remoteError: { code: 'remote_unreachable', message: 'Failed to reach Cinna backend' }
    })

    render(createElement(TrayPanel), { wrapper })

    // Consequence first: the tray still tells the user what their local agent said.
    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
    expect(screen.getByText('Failed to reach Cinna backend')).toBeTruthy()
  })

  it('names an expired session in the strip, not just a generic error', async () => {
    setApi({
      success: true,
      items: [folderRow],
      remoteError: { code: 'reauth_required', message: 'Session expired' }
    })

    render(createElement(TrayPanel), { wrapper })

    expect(await screen.findByText('Alpha')).toBeTruthy()
    // The tray has no re-auth button (there is no window to authenticate in), so
    // the copy has to carry the instruction the panel version puts on a button.
    expect(await screen.findByText(/open the app to re-authenticate/i)).toBeTruthy()
  })

  it('still takes the whole popup when there is nothing else to show', async () => {
    setApi({ success: false, code: 'remote_unreachable', error: 'Failed to reach Cinna backend' })

    render(createElement(TrayPanel), { wrapper })

    expect(await screen.findByText('Failed to reach Cinna backend')).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByText('No agents have reported status yet.')).toBeNull()
    )
  })
})
