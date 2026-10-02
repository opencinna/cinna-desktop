import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentColorDto } from '../../../../shared/agentColors'

/**
 * The Interface tab's Color section: swatches that save on click, show the
 * choice while it saves, and say why when it could not be saved.
 */

const colors = vi.hoisted(() => ({ rows: [] as AgentColorDto[] }))
const setColor = vi.fn()
;(window as unknown as { api: unknown }).api = {
  agents: {
    list: vi.fn().mockResolvedValue([]),
    listShortcuts: vi.fn().mockResolvedValue([]),
    setShortcut: vi.fn().mockResolvedValue({ success: true }),
    listColors: vi.fn(() => Promise.resolve(colors.rows)),
    setColor,
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { AgentInterfaceTab } = await import('./AgentInterfaceTab')

const AGENT = { id: 'folder:writer', name: 'Writer' }
let client: QueryClient

beforeEach(() => {
  colors.rows = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  setColor.mockReset().mockImplementation(async (agentId: string, preset: string | null) => {
    colors.rows = preset === null ? [] : [{ agentId, preset }]
    return { success: true }
  })
})
afterEach(() => client.clear())

async function shown() {
  render(<QueryClientProvider client={client}><AgentInterfaceTab agent={AGENT} /></QueryClientProvider>)
  const group = await screen.findByRole('group', { name: 'Color preset' })
  await waitFor(() => expect(client.getQueryData(['agents', 'colors'])).toBeTruthy())
  return group
}
const pressed = (group: HTMLElement): string[] =>
  within(group).getAllByRole('button', { pressed: true }).map((b) => b.getAttribute('aria-label') ?? '')

it('offers None and the fifteen presets, with None chosen by default', async () => {
  const group = await shown()
  const names = within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
  expect(names[0]).toBe('None')
  expect(names).toHaveLength(16)
  expect(names).toContain('Teal')
  expect(pressed(group)).toEqual(['None'])
})

it('chooses a color on click, showing it while it saves, and clears it with None', async () => {
  const group = await shown()
  let finish!: () => void
  setColor.mockImplementationOnce(
    (agentId: string, preset: string) =>
      new Promise((resolve) => {
        finish = () => {
          colors.rows = [{ agentId, preset }]
          resolve({ success: true })
        }
      })
  )
  fireEvent.click(within(group).getByRole('button', { name: 'Teal' }))
  await waitFor(() => expect(setColor).toHaveBeenCalledWith(AGENT.id, 'teal'))
  // In flight: the choice, not the None it replaces.
  await waitFor(() => expect(pressed(group)).toEqual(['Teal']))
  await act(async () => finish())
  await waitFor(() => expect(client.isMutating()).toBe(0))
  expect(pressed(group)).toEqual(['Teal'])

  fireEvent.click(within(group).getByRole('button', { name: 'None' }))
  await waitFor(() => expect(setColor).toHaveBeenLastCalledWith(AGENT.id, null))
  await waitFor(() => expect(client.isMutating()).toBe(0))
  expect(pressed(group)).toEqual(['None'])
})

it('saves nothing when the chosen swatch is clicked again', async () => {
  colors.rows = [{ agentId: AGENT.id, preset: 'rose' }]
  const group = await shown()
  await waitFor(() => expect(pressed(group)).toEqual(['Rose']))
  fireEvent.click(within(group).getByRole('button', { name: 'Rose' }))
  await act(async () => {})
  expect(setColor).not.toHaveBeenCalled()
})

it('says why a color could not be saved, and goes back to the saved one', async () => {
  const group = await shown()
  setColor.mockResolvedValueOnce({ success: false, error: 'Choose one of the listed colors' })
  fireEvent.click(within(group).getByRole('button', { name: 'Sky' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Choose one of the listed colors')
  expect(pressed(group)).toEqual(['None'])
})
