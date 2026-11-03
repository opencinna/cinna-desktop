import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
const flow = vi.hoisted(() => ({ startNewChat: vi.fn() }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: flow.startNewChat }) }))

import { BuildBriefCard } from './BuildBriefCard'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'
import { useToastStore } from '../../stores/toast.store'

const STAMP = { hash: 'h', size: 1, mtimeMs: 1 }
const input = {
  summary: 'Sorts the morning mail.',
  prompt: 'Build me an agent that sorts my Gmail inbox.',
  capabilities: [
    { id: 'credentials', state: 'used', note: 'reads your Gmail' },
    { id: 'schedules', state: 'maybe', note: 'every weekday at 8' },
    { id: 'status', state: 'not_needed', note: '' },
    { id: 'commands', state: 'not_needed', note: '' }
  ],
  skills: [{ name: 'triage', purpose: 'sorts new mail' }],
  credentials: [{ name: 'Gmail' }],
  effort: { level: 'high', reason: 'many rules' }
}

const get = vi.fn()
const markGuidedBuildDone = vi.fn()
const updateField = vi.fn()
let runtime: Record<string, unknown> | null = null
let unbuilt = true

function mount(props: Partial<React.ComponentProps<typeof BuildBriefCard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BuildBriefCard chatId="chat-1" agentId="folder:a" input={input} active {...props} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  runtime = null
  unbuilt = true
  get.mockReset().mockImplementation(async () => ({ ok: true, value: { id: 'folder:a', kind: 'kit', unbuilt, runtime, stamps: { 'cinna-agent.json': STAMP } } }))
  markGuidedBuildDone.mockReset().mockResolvedValue({ ok: true, value: { id: 'folder:a', kind: 'kit', unbuilt: false, runtime: null, stamps: {} } })
  updateField.mockReset().mockResolvedValue({ ok: true, value: { id: 'folder:a', kind: 'kit', runtime: { complexity: 'complex' }, stamps: {} } })
  flow.startNewChat.mockReset().mockResolvedValue(true)
  window.api = { localAgents: { get, markGuidedBuildDone, updateField } } as never
  useChatStore.setState({ sendError: null })
  useToastStore.setState({ toast: null })
  useUIStore.setState({ activeView: 'chat', agentPageTabRequest: null })
})

describe('the build brief card', () => {
  it('shows the brief: summary, prompt, what to set up, what is not needed, skills and access', async () => {
    mount()
    await screen.findByRole('button', { name: 'Start building' })
    const card = screen.getByRole('group', { name: 'Build brief' })
    expect(card.textContent).toContain('Sorts the morning mail.')
    expect(card.textContent).toContain('Build me an agent that sorts my Gmail inbox.')
    expect(screen.getByLabelText('Included')).toBeTruthy()
    expect(screen.getByLabelText('Your choice')).toBeTruthy()
    expect(card.textContent).toContain('Not needed now: Status on the agent, /run: commands')
    expect(card.textContent).toContain('triage — sorts new mail')
    // Named once, in the Credentials row, with its action there.
    expect(card.textContent).toContain('Credentials — GmailAdd in Credentials')
    expect(card.textContent).not.toContain('reads your Gmail')
    expect(card.textContent).not.toContain('Access it needs')
    expect(screen.getAllByRole('button', { name: 'Add in Credentials' })).toHaveLength(1)
    // A maybe defaults to Leave out.
    expect(screen.getByRole('button', { name: 'Leave out' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByRole('button').slice(-2).map((b) => b.textContent)).toEqual(['Keep talking', 'Start building'])
    expect(await screen.findByText(/Suggested effort: High/)).toBeTruthy()
  })

  it('is a read-only record when it is not the latest unanswered brief', () => {
    mount({ active: false })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('group', { name: 'Build brief' }).textContent).toContain('Sorts the morning mail.')
  })

  it('is a read-only record once its agent is no longer unbuilt, even as the latest brief', async () => {
    // Mutation: gate only on the latest brief and a started build keeps a live Start building.
    unbuilt = false
    mount()
    await waitFor(() => expect(get).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('Your choice')).toBeTruthy()
  })

  it('names the credentials on a line of their own when the brief has no Credentials row', async () => {
    mount({ input: { ...input, capabilities: input.capabilities.filter((c) => c.id !== 'credentials') } })
    await screen.findByRole('button', { name: 'Start building' })
    const card = screen.getByRole('group', { name: 'Build brief' })
    expect(card.textContent).toContain('Access it needs: Gmail')
    expect(screen.getAllByRole('button', { name: 'Add in Credentials' })).toHaveLength(1)
  })

  it('renders nothing for an input that is not a brief', () => {
    const { container } = mount({ input: { summary: 'x' } })
    expect(container.textContent).toBe('')
  })

  it('starts building with the edited prompt and the included maybes, never guided, then marks the build done', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Starting prompt' }), { target: { value: 'Sort my inbox, please.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Include' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start building' }))
    await waitFor(() => expect(markGuidedBuildDone).toHaveBeenCalledWith('folder:a'))
    const [options] = flow.startNewChat.mock.calls[0]
    expect(options).toMatchObject({ agentIds: ['folder:a'], mode: null, providerId: null, mcpIds: [] })
    expect(options).not.toHaveProperty('guidedBuild')
    expect(options.message).toBe([
      'Sort my inbox, please.',
      '',
      'Set up:',
      '- Credentials — reads your Gmail: Gmail',
      '- Schedules — every weekday at 8',
      '- Skills: triage (sorts new mail)'
    ].join('\n'))
    expect(useToastStore.getState().toast).toBeNull()
  })

  it('says so in a toast when the chat started but the done marker failed', async () => {
    // Mutation: let the marker's failure reject the mutation and it lands on an unmounted card.
    markGuidedBuildDone.mockResolvedValue({ ok: false, name: 'LocalAgentError', message: 'The folder is read-only.', code: 'invalid_input' })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Start building' }))
    await waitFor(() => expect(useToastStore.getState().toast).not.toBeNull())
    const toast = useToastStore.getState().toast!
    expect(toast.kind).toBe('error')
    expect(toast.link).toBeNull()
    expect(toast.message).toContain('The building chat started, but the guided build could not be marked done')
    expect(toast.message).toContain('The folder is read-only.')
  })

  it('says why under the buttons when the chat could not start, and marks nothing', async () => {
    flow.startNewChat.mockImplementation(async () => {
      useChatStore.getState().setSendError('No runtime is set up.')
      return false
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Start building' }))
    expect((await screen.findByRole('alert')).textContent).toBe('No runtime is set up.')
    expect(useChatStore.getState().sendError).toBeNull()
    expect(markGuidedBuildDone).not.toHaveBeenCalled()
  })

  it('applies the suggested effort as the work-complexity tier, and says Applied', async () => {
    runtime = { credential: 'work-key' }
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    const applied = await screen.findByText('Applied')
    // In the button's box: same padding and border width, so nothing moves.
    expect(applied.className).toContain('px-2.5 py-1')
    expect(applied.className).toContain('border border-transparent')
    expect(updateField).toHaveBeenCalledWith({
      agentId: 'folder:a',
      update: { field: 'runtime', value: { engine: 'keep', credential: 'work-key', modelId: null, complexity: 'complex' } },
      expectedStamp: STAMP
    })
  })

  it('hides the effort when the agent is already at that tier, or names a model', async () => {
    runtime = { complexity: 'complex' }
    const { unmount } = mount()
    await waitFor(() => expect(get).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByText(/Suggested effort/)).toBeNull()
    unmount()
    runtime = { model: 'opus' }
    mount()
    await act(async () => {})
    expect(screen.queryByText(/Suggested effort/)).toBeNull()
  })

  it('shows an Apply failure under the effort row, not under Start building', async () => {
    updateField.mockResolvedValue({ ok: false, name: 'LocalAgentError', message: 'The manifest changed on disk.', code: 'conflict' })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The manifest changed on disk.')
    const start = screen.getByRole('button', { name: 'Start building' })
    // Before the buttons in document order: the effort row's own line.
    expect(alert.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens the agent’s Credentials tab from the access line', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Add in Credentials' }))
    const ui = useUIStore.getState()
    expect(ui.agentPageTabRequest).toBe('credentials')
    expect(ui.agentPageMode).toBe('settings')
    expect(ui.activeView).toBe('local-agent')
    expect(ui.activeLocalAgentId).toBe('folder:a')
  })
})
