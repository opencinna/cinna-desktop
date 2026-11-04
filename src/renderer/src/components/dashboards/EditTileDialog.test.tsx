import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, ComponentRefreshRule, TileRefreshOverride, TileView } from '../../../../shared/dashboards'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { EditTileDialog } from './EditTileDialog'

/** Edit tile's refresh override (D4): each field starts at the component's value, and only a change is stored. */

function view(rule: Partial<ComponentRefreshRule> = {}, override: TileRefreshOverride | null = null): TileView {
  const refresh: ComponentRefreshRule = { maxAge: '15m', whileOpenEvery: '5m', afterTurn: true, onAppStart: false, command: null, schedule: null, ...rule }
  const component: ComponentInfo = {
    agentId: 'folder:sales', manifestId: 'sales', agentName: 'Sales Agent', name: 'deals', skill: null, title: 'Deals',
    description: '', view: 'list', size: 'wide', source: { endpoint: 'e' }, maxAge: refresh.maxAge, refreshCommand: null,
    refresh, params: {}, prompts: [], valid: true, findings: [], missingCredentials: []
  }
  return {
    tile: { id: 't1', dashboardId: 'd1', agentManifestId: 'sales', component: 'deals', skill: null, title: null, size: 'wide', position: 0, params: {}, refreshOverride: override },
    displayTitle: 'Deals',
    state: 'ok',
    component,
    schedule: null
  }
}

const updateTile = vi.fn()
const onClose = vi.fn()

function show(v: TileView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <EditTileDialog view={v} onClose={onClose} />
    </QueryClientProvider>
  )
}

const selectText = (label: string) => {
  const select = screen.getByLabelText(label) as HTMLSelectElement
  return select.options[select.selectedIndex].textContent
}

beforeEach(() => {
  updateTile.mockReset().mockImplementation(async (input: { tileId: string }) => ({ ok: true, tile: { id: input.tileId } }))
  onClose.mockReset()
  window.api = { dashboards: { updateTile } } as never
})

describe('Edit tile', () => {
  it('shows the component’s own rule as each field’s default', () => {
    show(view())
    expect(selectText('Recompute when older than')).toBe('Component: 15 minutes')
    expect(selectText('While on screen, every')).toBe('Component: every 5 minutes')
    expect(selectText('After a chat turn of its agent')).toBe('Component: recompute')
    expect(selectText('When Cinna starts')).toBe('Component: off')
    expect((screen.getByLabelText('Only when I press Refresh') as HTMLInputElement).checked).toBe(false)
  })

  it('saves no override when nothing changed', async () => {
    show(view())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: null }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('saves each changed field, with Off as null for while-open and false for the switches', async () => {
    show(view())
    fireEvent.change(screen.getByLabelText('Recompute when older than'), { target: { value: '1h' } })
    fireEvent.change(screen.getByLabelText('While on screen, every'), { target: { value: 'off' } })
    fireEvent.change(screen.getByLabelText('After a chat turn of its agent'), { target: { value: 'off' } })
    fireEvent.change(screen.getByLabelText('When Cinna starts'), { target: { value: 'on' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(updateTile).toHaveBeenCalledWith({
        tileId: 't1',
        title: null,
        refreshOverride: { maxAge: '1h', whileOpenEvery: null, afterTurn: false, onAppStart: true }
      })
    )
  })

  it('opens on the stored override, and going back to the component’s value drops that field', async () => {
    show(view({}, { whileOpenEvery: '1m', afterTurn: false }))
    expect(selectText('While on screen, every')).toBe('Every 1 minute')
    expect(selectText('After a chat turn of its agent')).toBe('Off')
    fireEvent.change(screen.getByLabelText('While on screen, every'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: { afterTurn: false } }))
  })

  it('Manual greys the rest out (nothing moves) and is saved with them kept', async () => {
    show(view())
    fireEvent.change(screen.getByLabelText('Recompute when older than'), { target: { value: '1d' } })
    fireEvent.click(screen.getByLabelText('Only when I press Refresh'))
    for (const label of ['Recompute when older than', 'While on screen, every', 'After a chat turn of its agent', 'When Cinna starts']) {
      expect((screen.getByLabelText(label) as HTMLSelectElement).disabled).toBe(true)
      // Greyed: a disabled select looks off, not just refuses the click.
      expect(screen.getByLabelText(label).className).toContain('disabled:opacity-50')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: { maxAge: '1d', manual: true } }))
  })

  it('Manual ticked and unticked again leaves no override', async () => {
    show(view())
    fireEvent.click(screen.getByLabelText('Only when I press Refresh'))
    fireEvent.click(screen.getByLabelText('Only when I press Refresh'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: null }))
  })

  it('a refused save says why and closes nothing', async () => {
    updateTile.mockResolvedValue({ ok: false, code: 'invalid_input', message: 'while_open_every must be at least 1m.' })
    show(view())
    fireEvent.change(screen.getByLabelText('While on screen, every'), { target: { value: '1m' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('while_open_every must be at least 1m.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a cloud tile has no When Cinna starts; Manual, max age, while open and after a turn stay', async () => {
    // Mutation: drop the `cloud` gate in RefreshOverrideFields and the first assertion fails.
    const cloudView = view()
    cloudView.tile = { ...cloudView.tile, agentManifestId: '', cloud: { remoteAgentId: 'core-1', server: 'cinna.example.com' } }
    show(cloudView)
    expect(screen.queryByLabelText('When Cinna starts')).toBeNull()
    for (const label of ['Recompute when older than', 'While on screen, every', 'After a chat turn of its agent', 'Only when I press Refresh']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    fireEvent.click(screen.getByLabelText('Only when I press Refresh'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: { manual: true } }))
  })
})
