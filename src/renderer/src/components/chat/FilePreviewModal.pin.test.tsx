import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../stores/fileDownload.store', () => ({
  useFileDownloadStore: (select: (s: { download: () => void; downloadingIds: Set<string> }) => unknown) =>
    select({ download: () => {}, downloadingIds: new Set() })
}))

import { FilePreviewModal } from './FilePreviewModal'
import { useFilePreviewStore } from '../../stores/filePreview.store'

/**
 * Pin file / Unpin file in the preview's ⋯ menu: offered for a file of a
 * folder agent, keyed to the agent the preview was opened for, and a refusal
 * said in the action row.
 */

const fileRef: AgentFileRef = { text: 'plan.md', path: '/agent/plan.md', displayPath: 'plan.md', kind: 'file', inside: true }
const listPins = vi.fn()
const setPin = vi.fn()

beforeEach(() => {
  listPins.mockReset().mockResolvedValue({ success: true, pins: [] })
  setPin.mockReset().mockResolvedValue({ success: true, pinned: true })
  window.api = { agentFiles: { listPins, setPin } } as never
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true, writable: true, value: () => ({ cancel: () => {} })
  })
  act(() => useFilePreviewStore.getState().close())
})

afterEach(() => {
  act(() => useFilePreviewStore.getState().close())
})

function show(cwd: boolean): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], [{ id: 'folder:a', name: 'A', enabled: true, capabilities: { cwd } }])
  render(<QueryClientProvider client={client}><FilePreviewModal /></QueryClientProvider>)
  act(() => {
    useFilePreviewStore.setState({
      target: { type: 'agentFile', agentId: 'folder:a', ref: fileRef, messageId: null },
      kind: 'text',
      text: '# plan\n',
      isLoading: false,
      openSeq: useFilePreviewStore.getState().openSeq + 1
    })
  })
  return client
}

const openMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'More file actions' }))
}

describe('Pin file in the preview', () => {
  it('pins the file for the agent the preview was opened for', async () => {
    show(true)
    openMenu()
    const item = screen.getAllByRole('menuitem')[0]
    expect(item.textContent).toBe('Pin file')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Pin file' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin file' }))
    await waitFor(() => expect(setPin).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/plan.md', pinned: true }))
  })

  it("says main's refusal in the action row", async () => {
    setPin.mockResolvedValue({ success: false, code: 'not_found', error: 'That file is no longer there.' })
    show(true)
    openMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Pin file' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin file' }))
    await waitFor(() => expect(useFilePreviewStore.getState().actionError).toEqual({ action: 'pin', code: 'not_found', reason: 'That file is no longer there.' }))
    expect(await screen.findByText('That file is no longer there.')).toBeTruthy()
  })

  it('offers no Pin file for an agent that is not a folder agent', () => {
    show(false)
    openMenu()
    expect(screen.queryByRole('menuitem', { name: /Pin file/ })).toBeNull()
    expect(listPins).not.toHaveBeenCalled()
  })
})

describe('a file the preview finds gone', () => {
  it('has the agent’s pinned files stat-ed again, and only on not_found', () => {
    const client = show(true)
    client.setQueryData(['agent-pinned-files', 'folder:a'], [])
    client.setQueryData(['agent-pinned-files', 'folder:b'], [])
    act(() => {
      useFilePreviewStore.setState({ text: '', error: 'Could not read it.', errorCode: 'read_failed' as never, failedStep: 'preview' })
    })
    expect(client.getQueryState(['agent-pinned-files', 'folder:a'])?.isInvalidated).toBe(false)
    act(() => {
      useFilePreviewStore.setState({ error: 'That file is no longer there.', errorCode: 'not_found' })
    })
    expect(client.getQueryState(['agent-pinned-files', 'folder:a'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['agent-pinned-files', 'folder:b'])?.isInvalidated).toBe(false)
  })
})
