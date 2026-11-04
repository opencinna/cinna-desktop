import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudTileMarkCode, ComponentInfo, TileComponentState, TileResultDto, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { Tile } from './Tile'
import { CLOUD_FRAME_REOPEN_GAP_MS } from './views/WebView'
import { tileResultKey } from '../../hooks/useDashboards'
import { useUIStore } from '../../stores/ui.store'

/** A cloud tile's states (D6.10): cached data stays, the mark says why and carries the action its code has. */

const CLOUD = { remoteAgentId: 'core-1', server: 'cinna.example.com' }

const COMPONENT: ComponentInfo = {
  agentId: 'remote-row-1', manifestId: '', agentName: 'Cloud Sales', name: 'deals', skill: null, title: 'Deals',
  description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: '15m', refreshCommand: null,
  refresh: { maxAge: '15m', whileOpenEvery: null, afterTurn: false, onAppStart: false, command: null, schedule: null },
  params: {}, prompts: [], valid: true, findings: [], missingCredentials: [], cloud: CLOUD
}

function tileView(over: { view?: 'list' | 'html'; state?: TileComponentState; component?: ComponentInfo | null } = {}): TileView {
  const component = over.component === null ? null : { ...(over.component ?? COMPONENT), view: over.view ?? 'list' }
  return {
    tile: { id: 't1', dashboardId: 'd1', agentManifestId: '', cloud: CLOUD, component: 'deals', skill: null, title: 'Deals', size: 'wide', position: 0, params: {}, refreshOverride: null },
    displayTitle: 'Deals',
    state: over.state ?? 'ok',
    component,
    agentName: 'Cloud Sales',
    schedule: null
  }
}

let result: TileResultDto
const ensureFresh = vi.fn()
const openFrame = vi.fn()
const removeTile = vi.fn()

function withMark(code: CloudTileMarkCode, message: string, data: unknown = { items: [{ title: 'Call Bob' }] }): TileResultDto {
  return { ...result, data, fetchedAt: data === null ? null : result.fetchedAt, error: message, cloud: { mark: { code, message }, paramsResolved: {}, missingCredentials: [] } }
}

let client: QueryClient

function show(view: TileView) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Tile view={view} dashboardName="Sales" span={{ cols: 6, rows: 2 }} editMode={false} dragging={false} onHandlePointerDown={() => {}} onVisibilityChange={() => {}} />
    </QueryClientProvider>
  )
}

const markOf = (container: HTMLElement): HTMLElement => container.querySelector('[data-cloud-mark]') as HTMLElement

beforeEach(() => {
  result = { tileId: 't1', data: { items: [{ title: 'Call Bob' }] }, fetchedAt: Date.now(), error: null, refreshing: false, stale: false, tooLarge: false, notice: null }
  ensureFresh.mockReset().mockResolvedValue({ ok: true })
  openFrame.mockReset().mockResolvedValue({ ok: true, token: 'tok', url: 'cinna-preview://dash-h/t1/index.html' })
  removeTile.mockReset().mockResolvedValue({ ok: true })
  window.api = {
    dashboards: {
      tileResult: async () => ({ ok: true, result }),
      onTileChanged: () => () => {},
      highlight: async () => [],
      onTileHighlight: () => () => {},
      clearHighlight: async () => true,
      highlightReady: async () => true,
      ensureFresh,
      openFrame,
      releaseFrame: async () => {},
      removeTile
    }
  } as never
})

describe('a cloud tile’s marks', () => {
  it('unreachable on a native tile: the data stays, the mark says why once, Retry refreshes', async () => {
    result = withMark('unreachable', 'Can’t reach cinna.example.com.')
    const { container } = show(tileView())
    expect(await screen.findByText('Call Bob')).toBeTruthy()
    const mark = markOf(container)
    expect(mark.dataset.cloudMark).toBe('unreachable')
    expect(mark.textContent).toContain('Can’t reach cinna.example.com.')
    // The same sentence is not drawn again as the generic failure mark.
    expect(screen.queryByLabelText(/Last refresh failed/)).toBeNull()
    fireEvent.click(within(mark).getByRole('button', { name: 'Retry' }))
    expect(ensureFresh).toHaveBeenCalledWith('t1', 'manual')
  })

  it('unreachable on an html tile: the sentence and Retry in place of the frame; Retry re-opens the frame', async () => {
    // Mutation: drop `frameBlocked` from `markFills` and the frame opens on first draw.
    result = withMark('unreachable', 'Can’t reach cinna.example.com.')
    const { container } = show(tileView({ view: 'html' }))
    await waitFor(() => expect(markOf(container)?.textContent).toContain('Can’t reach cinna.example.com.'))
    expect(screen.queryByTestId('dashboard-frame')).toBeNull()
    expect(openFrame).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(within(markOf(container)).getByRole('button', { name: 'Retry' })))
    expect(ensureFresh).toHaveBeenCalledWith('t1', 'manual')
    await waitFor(() => expect(openFrame).toHaveBeenCalledWith({ tileId: 't1' }))
  })

  it('reauth_required links to the Cinna settings', async () => {
    result = withMark('reauth_required', 'Sign in to cinna.example.com again.')
    const { container } = show(tileView())
    await screen.findByText('Call Bob')
    fireEvent.click(within(markOf(container)).getByRole('button', { name: 'Open settings' }))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'settings', settingsTab: 'profile-agents' })
  })

  it('waking: the cached data stays under “Waking…”, with no action', async () => {
    result = withMark('waking', 'Waking Cloud Sales…')
    const { container } = show(tileView())
    expect(await screen.findByText('Call Bob')).toBeTruthy()
    expect(markOf(container).textContent).toBe('Waking Cloud Sales…')
    expect(within(markOf(container)).queryByRole('button')).toBeNull()
  })

  it('needs_credentials links to the cloud agent’s page', async () => {
    result = withMark('needs_credentials', 'Needs the gmail credential')
    const { container } = show(tileView())
    await screen.findByText('Call Bob')
    fireEvent.click(within(markOf(container)).getByRole('button', { name: 'Open agent' }))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'external-agent', activeExternalAgentId: 'remote-row-1', agentPageMode: 'settings' })
  })

  it.each([
    ['env_unavailable', 'Cloud Sales’s environment isn’t running.'],
    ['adapter_unsupported', 'Rebuild the environment to run components.'],
    ['rate_limited', 'Refreshed too often; try again in a minute.']
  ] as const)('%s: the sentence, no action', async (code, message) => {
    result = withMark(code, message)
    const { container } = show(tileView())
    await screen.findByText('Call Bob')
    expect(markOf(container).textContent).toBe(message)
    expect(within(markOf(container)).queryByRole('button')).toBeNull()
  })

  it('with no data to keep, the mark fills the tile instead of a skeleton', async () => {
    result = withMark('env_unavailable', 'Cloud Sales’s environment isn’t running.', null)
    const { container } = show(tileView())
    await waitFor(() => expect(markOf(container)?.textContent).toContain('environment isn’t running'))
    expect(screen.queryByLabelText('Loading')).toBeNull()
  })

  it('agent_gone as a mark offers Remove, which confirms', async () => {
    result = withMark('agent_gone', 'Cloud Sales is no longer available.')
    const { container } = show(tileView())
    await screen.findByText('Call Bob')
    fireEvent.click(within(markOf(container)).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('dialog', { name: 'Remove Deals' })).toBeTruthy()
  })
})

describe('a cloud tile that cannot run', () => {
  it('wrong_server: “Not on this server.” with Remove, no Refresh and nothing run', async () => {
    show(tileView({ state: 'wrong_server' }))
    expect(await screen.findByText('Not on this server.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh Deals' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Deals' })
    // Nothing to add again from here: the confirm says so (ux rule 5).
    expect(dialog.textContent).toContain('It was made on another Cinna server, so its data goes with the tile.')
    expect(dialog.textContent).not.toContain('you can add it again')
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' })))
    await waitFor(() => expect(removeTile).toHaveBeenCalledWith('t1'))
    expect(ensureFresh).not.toHaveBeenCalled()
  })

  it('agent_missing: “<agent> is no longer available.” named even without a component, with Remove', async () => {
    show(tileView({ state: 'agent_missing', component: null }))
    expect(await screen.findByText('Cloud Sales is no longer available.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Deals' })
    expect(dialog.textContent).toContain('Remove Deals from Sales? Cloud Sales is no longer available, so its data goes with the tile.')
  })

  it('a reachable cloud tile’s Remove still says the component stays with its agent', async () => {
    show(tileView())
    await screen.findByText('Call Bob')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Deals' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Deals' })
    expect(dialog.textContent).toContain('The component stays with Cloud Sales; you can add it again.')
  })

  it('agent_gone as a mark: its filters and Refresh stay in place, disabled; nothing runs', async () => {
    result = withMark('agent_gone', 'Cloud Sales is no longer available.')
    show(tileView({ component: { ...COMPONENT, params: { stage: { type: 'enum', values: ['open', 'won'], label: 'Stage' } } } }))
    await screen.findByText('Call Bob')
    const refresh = screen.getByRole('button', { name: 'Refresh Deals' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
    fireEvent.click(refresh)
    expect(ensureFresh).not.toHaveBeenCalledWith('t1', 'manual')
    // Disabled by the row's fieldset: `:disabled` matches, the element's own attribute is not set.
    expect(screen.getByLabelText('Stage').matches(':disabled')).toBe(true)
  })

  it('a missing credential does not blank a cloud tile: its data stays', async () => {
    show(tileView({ component: { ...COMPONENT, missingCredentials: ['gmail'] } }))
    expect(await screen.findByText('Call Bob')).toBeTruthy()
  })
})

describe('a cloud tile’s page that does not open', () => {
  /** The clock moves past CLOUD_FRAME_REOPEN_GAP_MS from the last open, so an automatic reopen runs at once. */
  let clock: { mockRestore: () => void } | null = null
  const pastReopenGap = (): void => {
    const base = Date.now()
    clock = vi.spyOn(Date, 'now').mockReturnValue(base + CLOUD_FRAME_REOPEN_GAP_MS + 1)
  }
  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  it('env_unavailable (the environment is starting): the cloud sentence and Retry, and the next result opens it once', async () => {
    // Mutation: drop the reopen effect in WebView and the frame never comes back without a click.
    openFrame.mockResolvedValueOnce({ ok: false, code: 'env_unavailable', message: 'The environment is starting; try again in a moment.' })
    const { container } = show(tileView({ view: 'html' }))
    const refusal = await waitFor(() => {
      const el = container.querySelector('[data-refusal="env_unavailable"]') as HTMLElement
      expect(el).toBeTruthy()
      return el
    })
    expect(refusal.textContent).toContain('Cloud Sales’s environment isn’t running.')
    expect(within(refusal).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(openFrame).toHaveBeenCalledTimes(1)
    // The tile's data changed (main's push invalidates its result) after the reopen gap: the page is asked for once more, and opens.
    pastReopenGap()
    result = { ...result, fetchedAt: Date.now() + 1000 }
    await act(async () => client.invalidateQueries({ queryKey: tileResultKey('t1') }))
    await waitFor(() => expect(openFrame).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(container.querySelector('[data-refusal]')).toBeNull())
  })

  it('a page that fails again waits for the next result: one open per result, never a loop', async () => {
    openFrame.mockResolvedValue({ ok: false, code: 'env_unavailable', message: 'starting' })
    const { container } = show(tileView({ view: 'html' }))
    await waitFor(() => expect(container.querySelector('[data-refusal="env_unavailable"]')).toBeTruthy())
    pastReopenGap()
    result = { ...result, fetchedAt: Date.now() + 1000 }
    await act(async () => client.invalidateQueries({ queryKey: tileResultKey('t1') }))
    await waitFor(() => expect(openFrame).toHaveBeenCalledTimes(2))
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(openFrame).toHaveBeenCalledTimes(2)
  })

  it('a result change inside the reopen gap waits for it: each cloud mint wakes the environment', async () => {
    // Mutation: drop the gap in WebView and the second open happens at once.
    openFrame.mockResolvedValue({ ok: false, code: 'env_unavailable', message: 'starting' })
    const { container } = show(tileView({ view: 'html' }))
    await waitFor(() => expect(container.querySelector('[data-refusal="env_unavailable"]')).toBeTruthy())
    result = { ...result, fetchedAt: Date.now() + 1000 }
    await act(async () => client.invalidateQueries({ queryKey: tileResultKey('t1') }))
    await act(async () => new Promise((r) => setTimeout(r, 100)))
    expect(openFrame).toHaveBeenCalledTimes(1)
  })

  it('unreachable reads as the cloud sentence, never the transport’s text; Retry opens it again', async () => {
    openFrame.mockResolvedValueOnce({ ok: false, code: 'unreachable', message: 'fetch failed' })
    const { container } = show(tileView({ view: 'html' }))
    const refusal = await waitFor(() => {
      const el = container.querySelector('[data-refusal="unreachable"]') as HTMLElement
      expect(el).toBeTruthy()
      return el
    })
    expect(refusal.textContent).toContain('Can’t reach cinna.example.com.')
    expect(refusal.textContent).not.toContain('fetch failed')
    await act(async () => fireEvent.click(within(refusal).getByRole('button', { name: 'Retry' })))
    await waitFor(() => expect(openFrame).toHaveBeenCalledTimes(2))
  })

  it('reauth_required offers Open settings', async () => {
    openFrame.mockResolvedValueOnce({ ok: false, code: 'reauth_required', message: 'Cinna 401' })
    const { container } = show(tileView({ view: 'html' }))
    const refusal = await waitFor(() => {
      const el = container.querySelector('[data-refusal="reauth_required"]') as HTMLElement
      expect(el).toBeTruthy()
      return el
    })
    expect(refusal.textContent).toContain('Sign in to cinna.example.com again.')
    fireEvent.click(within(refusal).getByRole('button', { name: 'Open settings' }))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'settings', settingsTab: 'profile-agents' })
  })
})

describe('a cloud tile’s mark and filters, as drawn', () => {
  it('the pill wraps to two lines rather than cutting its reason off', async () => {
    result = withMark('env_unavailable', 'Cloud Sales’s environment isn’t running.')
    const { container } = show(tileView())
    await waitFor(() => expect(markOf(container)).toBeTruthy())
    const text = markOf(container).querySelector('[data-cloud-mark-text]') as HTMLElement
    expect(text.className).toContain('line-clamp-2')
    expect(text.className).not.toContain('truncate')
    expect(markOf(container).textContent).toContain('Cloud Sales’s environment isn’t running.')
  })

  it('the Retry in place of a page is the same accent link as the pill’s', async () => {
    result = withMark('unreachable', 'Can’t reach cinna.example.com.')
    const { container } = show(tileView({ view: 'html' }))
    await waitFor(() => expect(markOf(container)?.getAttribute('data-cloud-mark')).toBe('unreachable'))
    const retry = within(markOf(container)).getByRole('button', { name: 'Retry' })
    expect(retry.className).toContain('text-[var(--color-accent)]')
    expect(retry.className).not.toContain('border')
  })

  it('a filter set to `current` shows the month core resolved it to', async () => {
    result = { ...result, cloud: { mark: null, paramsResolved: { month: '2031-01' }, missingCredentials: [] } }
    show(tileView({ component: { ...COMPONENT, params: { month: { type: 'month', label: 'Month', default: 'current' } } } }))
    await screen.findByText('Call Bob')
    await waitFor(() => expect((screen.getByLabelText('Month') as HTMLInputElement).value).toBe('2031-01'))
  })
})

describe('a cloud tile’s Retry', () => {
  it('runs one refresh at a time and keeps its label while it runs', async () => {
    // Mutation: drop `disabled={busy}` on the pill's button and the second click refreshes again.
    let settle: (value: { ok: true }) => void = () => {}
    ensureFresh.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    result = withMark('unreachable', 'Can’t reach cinna.example.com.')
    const { container } = show(tileView())
    await screen.findByText('Call Bob')
    const retry = within(markOf(container)).getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(ensureFresh).toHaveBeenCalledTimes(1)
    const busy = within(markOf(container)).getByRole('button', { name: 'Retry' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.textContent).toBe('Retry')
    await act(async () => settle({ ok: true }))
    await waitFor(() => expect((within(markOf(container)).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false))
  })
})
