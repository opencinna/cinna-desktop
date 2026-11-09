import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInfo, ComponentRefreshRule, TilePromptOverride, TileRefreshOverride, TileView } from '../../../../shared/dashboards'

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
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: null, promptOverride: null, showBorder: true, showTitle: true }))
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
        refreshOverride: { maxAge: '1h', whileOpenEvery: null, afterTurn: false, onAppStart: true },
        promptOverride: null,
        showBorder: true,
        showTitle: true
      })
    )
  })

  it('opens on the stored override, and going back to the component’s value drops that field', async () => {
    show(view({}, { whileOpenEvery: '1m', afterTurn: false }))
    expect(selectText('While on screen, every')).toBe('Every 1 minute')
    expect(selectText('After a chat turn of its agent')).toBe('Off')
    fireEvent.change(screen.getByLabelText('While on screen, every'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: { afterTurn: false }, promptOverride: null, showBorder: true, showTitle: true }))
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
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: { maxAge: '1d', manual: true }, promptOverride: null, showBorder: true, showTitle: true }))
  })

  it('Manual ticked and unticked again leaves no override', async () => {
    show(view())
    fireEvent.click(screen.getByLabelText('Only when I press Refresh'))
    fireEvent.click(screen.getByLabelText('Only when I press Refresh'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: null, promptOverride: null, showBorder: true, showTitle: true }))
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
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith({ tileId: 't1', title: null, refreshOverride: { manual: true }, promptOverride: null, showBorder: true, showTitle: true }))
  })

  it('Interface holds the border and title switches, on unless the tile turned them off', async () => {
    const v = view()
    show({ ...v, tile: { ...v.tile, showBorder: false } })
    expect(screen.getByRole('switch', { name: 'Show border' }).getAttribute('aria-checked')).toBe('false')
    const title = screen.getByRole('switch', { name: 'Show title' })
    expect(title.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(title)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateTile).toHaveBeenCalledWith(expect.objectContaining({ showBorder: false, showTitle: false })))
  })

  describe('suggested questions', () => {
    const withPrompts = (override: TilePromptOverride | null = null): TileView => {
      const v = view()
      return { ...v, tile: { ...v.tile, promptOverride: override }, component: { ...v.component!, prompts: [{ label: 'Most urgent?', prompt: 'Which is the most urgent?' }, { label: 'Stalled?', prompt: 'What stalled?' }] } }
    }
    const saved = async (): Promise<unknown> => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(updateTile).toHaveBeenCalled())
      return updateTile.mock.calls[0][0].promptOverride
    }

    it('turning the agent’s question off stores only that; on again stores nothing', async () => {
      show(withPrompts())
      const toggle = screen.getByRole('switch', { name: 'Offer Stalled?' })
      expect(toggle.getAttribute('aria-checked')).toBe('true')
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-checked')).toBe('false')
      fireEvent.click(toggle)
      fireEvent.click(toggle)
      expect(await saved()).toEqual({ hidden: ['Stalled?'] })
    })

    it('a reworded question is stored under the agent’s label; the reset icon or the agent’s own words drop it', async () => {
      show(withPrompts())
      fireEvent.click(screen.getByRole('button', { name: 'Edit Stalled?' }))
      fireEvent.change(screen.getByLabelText('Question sent to the agent'), { target: { value: 'Which deal stalled?' } })
      expect(screen.getByRole('button', { name: 'Use the agent’s wording for Stalled?' })).toBeTruthy()
      fireEvent.change(screen.getByLabelText('Question sent to the agent'), { target: { value: 'What stalled?' } })
      expect(screen.queryByRole('button', { name: 'Use the agent’s wording for Stalled?' })).toBeNull()
      fireEvent.change(screen.getByLabelText('Question sent to the agent'), { target: { value: 'Which deal stalled?' } })
      expect(await saved()).toEqual({ edited: { 'Stalled?': { label: 'Stalled?', prompt: 'Which deal stalled?' } } })
    })

    it('Add question opens an empty form, and its own question can be removed', async () => {
      show(withPrompts())
      fireEvent.click(screen.getByRole('button', { name: 'Add question' }))
      fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Mine' } })
      fireEvent.change(screen.getByLabelText('Question sent to the agent'), { target: { value: 'My question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Remove Mine' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add question' }))
      fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Other' } })
      fireEvent.change(screen.getByLabelText('Question sent to the agent'), { target: { value: 'Other question' } })
      expect(await saved()).toEqual({ added: [{ label: 'Other', prompt: 'Other question' }] })
    })

    it('a question left wholly empty is dropped on Save and blocks nothing', async () => {
      show(withPrompts())
      fireEvent.click(screen.getByRole('button', { name: 'Add question' }))
      expect(await saved()).toBeNull()
    })

    it('a refused question keeps the dialog open and says why', async () => {
      updateTile.mockResolvedValue({ ok: false, code: 'invalid_input', message: 'A suggested question needs a label.' })
      show(withPrompts())
      fireEvent.click(screen.getByRole('button', { name: 'Add question' }))
      fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Half' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect((await screen.findByRole('alert')).textContent).toContain('A suggested question needs a label.')
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})
