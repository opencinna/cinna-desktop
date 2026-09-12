import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { A2AAgentForm } from './A2AAgentForm'

const upsert = vi.fn()

beforeEach(() => {
  upsert.mockReset()
  Object.assign(window, { api: { agents: { upsert } } })
})

function openForm(): ReturnType<typeof vi.fn> {
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <A2AAgentForm onClose={onClose} />
    </QueryClientProvider>
  )
  return onClose
}

it('opens a named dialog and saves the entered A2A connection', async () => {
  upsert.mockResolvedValue({ success: true, id: 'a2a-1' })
  const onClose = openForm()
  expect(screen.getByRole('dialog', { name: 'Add A2A Agent' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Agent Card URL'), { target: { value: 'https://agent.example.com' } })
  fireEvent.change(screen.getByLabelText(/Access Token/), { target: { value: 'test-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Agent' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
    protocol: 'a2a', cardUrl: 'https://agent.example.com', accessToken: 'test-token', enabled: true
  }))
})

it('keeps the dialog and entered URL when saving returns an error', async () => {
  upsert.mockResolvedValue({ success: false, error: 'Invalid agent URL' })
  const onClose = openForm()
  fireEvent.change(screen.getByLabelText('Agent Card URL'), { target: { value: 'invalid-url' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Agent' }))
  expect(await screen.findByText('Invalid agent URL')).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Agent Card URL') as HTMLInputElement).value).toBe('invalid-url')
})

it('closes the dialog with Escape', () => {
  const onClose = openForm()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})
