import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
const mutateAsync = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useMcp', () => ({
  useMcpRegistries: () => ({ data: [{ id: 'official', label: 'MCP Official' }] }),
  useMcpRegistrySearchAll: () => ({
    isLoading: false,
    data: {
      errors: [],
      entries: [
        { registryId: 'official', id: 'ledger', name: 'ledger', title: 'Ledger', remotes: [{ type: 'streamable-http', url: 'https://ledger.example/mcp' }] },
        { registryId: 'official', id: 'notes', name: 'notes', title: 'Notes', remotes: [{ type: 'streamable-http', url: 'https://notes.example/mcp' }] }
      ]
    }
  }),
  useUpsertMcpProvider: () => ({ mutateAsync, isPending: false })
}))
import { MCPRegistryPicker } from './MCPRegistryPicker'
import { addonPolicyKey } from '../../hooks/useAddonDirectory'

const ALLOWED = { externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true }
const policy = vi.fn(async () => ALLOWED)
let client: QueryClient
beforeEach(() => {
  mutateAsync.mockReset()
  policy.mockReset()
  policy.mockResolvedValue(ALLOWED)
  window.api = { addons: { policy } } as never
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
const mount = (props: Partial<Parameters<typeof MCPRegistryPicker>[0]> = {}): void => {
  render(
    <QueryClientProvider client={client}>
      <MCPRegistryPicker onClose={vi.fn()} {...props} />
    </QueryClientProvider>
  )
}
const connect = (index: number): HTMLButtonElement => screen.getAllByRole('button', { name: 'Connect' })[index] as HTMLButtonElement

it('keeps the picker open and says why on the row when main refuses the add', async () => {
  mutateAsync.mockRejectedValueOnce(new Error('Your admin turned off public MCP directories.'))
  const onClose = vi.fn()
  const onCreated = vi.fn()
  mount({ onClose, onCreated })
  await act(async () => { fireEvent.click(connect(0)) })
  expect(screen.getByRole('alert').textContent).toBe('Your admin turned off public MCP directories.')
  expect(onClose).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})

it('keeps the policy’s sentence on its row, offers no Connect while the policy forbids public directories, and both come back once it allows', async () => {
  const sentence = 'Your admin does not allow connectors from public MCP registries.'
  mutateAsync.mockRejectedValueOnce(Object.assign(new Error(sentence), { code: 'policy' }))
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  mount()
  await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))
  // The read after the refusal is held: another row tried meanwhile fails on its own, and the refused one keeps its sentence.
  let answer: (value: typeof ALLOWED) => void = () => {}
  policy.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  await act(async () => { fireEvent.click(connect(0)) })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: addonPolicyKey(null) })
  expect(screen.getByRole('alert').textContent).toBe(sentence)
  mutateAsync.mockRejectedValueOnce(new Error('That connector could not be saved.'))
  await act(async () => { fireEvent.click(connect(1)) })
  expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([sentence, 'That connector could not be saved.'])
  // The stored policy forbids them: no row's Connect is offered, the sentence stays.
  await act(async () => { answer({ ...ALLOWED, externalDirectories: false }) })
  await waitFor(() => expect(connect(0).disabled).toBe(true))
  expect(connect(1).disabled).toBe(true)
  expect(screen.getAllByRole('alert')[0].textContent).toBe(sentence)
  // The admin allows them again: Connect is back on every row and the refusal is gone.
  await act(async () => { client.setQueryData(addonPolicyKey(null), ALLOWED) })
  expect(connect(0).disabled).toBe(false)
  expect(connect(1).disabled).toBe(false)
  expect(screen.queryByText(sentence)).toBeNull()
})

it('leaves Connect on for a retry after a failure that is not the policy', async () => {
  mutateAsync.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: undefined }))
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  mount()
  await act(async () => { fireEvent.click(connect(0)) })
  expect(screen.getByRole('alert').textContent).toBe('fetch failed')
  expect(connect(0).disabled).toBe(false)
  expect(invalidate).not.toHaveBeenCalled()
})
