import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { ImprovementRequestDialog } from './ImprovementRequestDialog'
import { useCreateImprovementRequest } from '../../hooks/useImprovementRequests'
import { useToastStore } from '../../stores/toast.store'
import type { ImprovementContext, ImprovementTarget } from '../../../../shared/improvementRequests'

const ALPHA: ImprovementTarget = { agentId: 'remote:a', agentName: 'Alpha', lastActivityAt: null, bound: true }
const BRAVO: ImprovementTarget = { agentId: 'remote:b', agentName: 'Bravo', lastActivityAt: null, bound: false }

const ctx = (over: Partial<ImprovementContext> = {}): ImprovementContext => ({
  eligible: true, reason: null, reasonText: null, isSharedExternally: true, recipientDisplay: 'Pub Co', recipientEmail: null,
  targetAgentName: 'Alpha', bundleId: 'com.pub.alpha', installedVersion: '1.2.0', messageCount: 7, existingRequestCount: 0,
  ...over
})

const context = vi.fn()
const create = vi.fn()

function wrapper(): (props: { children: ReactNode }) => React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

type Fn = ReturnType<typeof vi.fn>
function renderDialog(targets: ImprovementTarget[], onSubmit = vi.fn(), onTargetChange = vi.fn(), onClose = vi.fn()): { onSubmit: Fn; onTargetChange: Fn; onClose: Fn } {
  const Wrapper = wrapper()
  render(<Wrapper><ImprovementRequestDialog chatId="chat-1" targets={targets} pending={false} error={null} onSubmit={onSubmit} onTargetChange={onTargetChange} onClose={onClose} /></Wrapper>)
  return { onSubmit, onTargetChange, onClose }
}

const send = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send request' }) as HTMLButtonElement
const message = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

beforeEach(() => {
  context.mockReset().mockResolvedValue({ ok: true, context: ctx() })
  create.mockReset()
  window.api = { improvementRequests: { context, create } } as never
  useToastStore.setState({ toast: null })
})

describe('ImprovementRequestDialog', () => {
  it('names a single target without a picker, and asks core about it', async () => {
    renderDialog([ALPHA])
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
    await screen.findByText(/who publishes the bundle this agent was installed from/)
    expect(document.querySelector('[data-improvement-recipient]')?.textContent).toBe('Pub Co')
    expect(screen.queryByText('Can’t be sent')).toBeNull()
    expect(context).toHaveBeenCalledWith('chat-1', 'remote:a')
    expect(screen.getByText(/7 messages will be captured as they are right now/)).toBeTruthy()
    expect(screen.queryByText(/This cannot be undone/)).toBeNull()
    expect(screen.queryByText('Agent session')).toBeNull()
  })

  it('names the recipient in bold with their email when core sends one', async () => {
    context.mockResolvedValue({ ok: true, context: ctx({ recipientEmail: 'pub@example.com' }) })
    renderDialog([ALPHA])
    await screen.findByText(/who publishes the bundle this agent was installed from/)
    const recipient = document.querySelector('[data-improvement-recipient]')
    expect(recipient?.tagName).toBe('STRONG')
    expect(recipient?.textContent).toBe('Pub Co <pub@example.com>')
  })

  it('says one message in the singular, and the own-agent copy with the agent as a badge', async () => {
    context.mockResolvedValue({ ok: true, context: ctx({ isSharedExternally: false, recipientDisplay: null, messageCount: 1 }) })
    renderDialog([ALPHA])
    await screen.findByText(/1 message will be captured as it is right now\./)
    expect(screen.getByText(/as a note for later improvements\. Nothing leaves your account\./)).toBeTruthy()
    expect(screen.queryByText(/This cannot be undone/)).toBeNull()
  })

  it('shows one line while the pre-flight runs', async () => {
    context.mockReturnValue(new Promise(() => {}))
    renderDialog([ALPHA])
    expect(screen.getByText('Checking who receives it…')).toBeTruthy()
  })

  it('explains MEMORY behind a (?) whose press does not close the dialog', async () => {
    const { onClose } = renderDialog([ALPHA])
    await screen.findByText(/Goes to/)
    fireEvent.click(screen.getByRole('button', { name: 'About MEMORY files' }))
    const tip = await screen.findByText(/system prompt/)
    fireEvent.mouseDown(tip)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers a picker with two targets, defaulting to the first, and re-asks core for the pick, clearing the old refusal', async () => {
    const { onTargetChange } = renderDialog([ALPHA, BRAVO])
    const picker = screen.getByRole('combobox') as HTMLSelectElement
    expect(picker.value).toBe('remote:a')
    await screen.findByText(/Goes to/)
    expect(onTargetChange).not.toHaveBeenCalled()
    fireEvent.change(picker, { target: { value: 'remote:b' } })
    expect(onTargetChange).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(context).toHaveBeenCalledWith('chat-1', 'remote:b'))
  })

  it('keeps Send disabled until the message has more than whitespace', async () => {
    renderDialog([ALPHA])
    await screen.findByText(/Goes to/)
    expect(send().disabled).toBe(true)
    fireEvent.change(message(), { target: { value: '   \n  ' } })
    expect(send().disabled).toBe(true)
    fireEvent.change(message(), { target: { value: 'Fix it' } })
    expect(send().disabled).toBe(false)
    expect(message().maxLength).toBe(4000)
  })

  it('includes memory by default and passes the choice through, with the trimmed message and a confirmation naming the recipient', async () => {
    const { onSubmit } = renderDialog([ALPHA])
    await screen.findByText(/Goes to/)
    const memory = screen.getByRole('checkbox', { name: 'Include MEMORY files of this agent' }) as HTMLInputElement
    expect(memory.checked).toBe(true)
    fireEvent.change(message(), { target: { value: '  Fix it  ' } })
    fireEvent.click(send())
    expect(onSubmit).toHaveBeenLastCalledWith(
      { chatId: 'chat-1', agentId: 'remote:a', comment: 'Fix it', includeMemory: true },
      'Improvement request sent to Pub Co.'
    )
    fireEvent.click(memory)
    fireEvent.click(send())
    expect(onSubmit.mock.lastCall?.[0].includeMemory).toBe(false)
  })

  it('shows why an ineligible session cannot be sent, and keeps Send disabled', async () => {
    context.mockResolvedValue({ ok: true, context: ctx({ eligible: false, reason: 'rate_limited', reasonText: 'You have reached the limit.' }) })
    renderDialog([ALPHA])
    await screen.findByText('You have reached the limit.')
    fireEvent.change(message(), { target: { value: 'Fix it' } })
    expect(send().disabled).toBe(true)
    expect(screen.getByText('Can’t be sent')).toBeTruthy()
  })

  it('says a refused pre-flight in core’s words', async () => {
    context.mockResolvedValue({ ok: false, code: 'refused', message: 'Session not found' })
    renderDialog([ALPHA])
    await screen.findByText('Session not found')
  })
})

describe('useCreateImprovementRequest', () => {
  it('raises the confirmation and closes on success, and turns a refusal into the error', async () => {
    const onSent = vi.fn()
    const { result } = renderHook(() => useCreateImprovementRequest(onSent), { wrapper: wrapper() })
    create.mockResolvedValueOnce({ ok: true, request: { id: 'r1' } })
    await act(async () => { await result.current.mutateAsync({ input: { chatId: 'c', agentId: 'a', comment: 'x', includeMemory: true }, confirmation: 'Sent to Pub Co.' }) })
    expect(onSent).toHaveBeenCalledWith('c')
    expect(useToastStore.getState().toast?.message).toBe('Sent to Pub Co.')

    create.mockResolvedValueOnce({ ok: false, code: 'refused', message: 'Only the owner of this session can share it.' })
    await act(async () => { await result.current.mutateAsync({ input: { chatId: 'c', agentId: 'a', comment: 'x', includeMemory: true }, confirmation: 'no' }).catch(() => {}) })
    await waitFor(() => expect(result.current.error?.message).toBe('Only the owner of this session can share it.'))
    expect(onSent).toHaveBeenCalledTimes(1)
  })
})
