import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messageMenuItems, useMessageContextMenu } from './MessageContextMenu'
import { MessageBubble } from './MessageBubble'
import { MessageIdContext } from './fileRefs'
import { useAuthStore } from '../../stores/auth.store'
import { useRunScriptStore } from '../../stores/runScript.store'
import { COMMAND_REVIEW_REASONS } from '../../../../shared/userCommands'

// Main's app settings, as `useCapabilities` reads them (`'on'` only).
const capabilities = vi.hoisted(() => ({ notesEnabled: true, dashboardsEnabled: true, loaded: true }))
vi.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => capabilities }))

/**
 * The message menu's last group: Run, Run in background and Edit and Run…
 * for a command in a local agent's reply, decided once at open.
 */

vi.hoisted(() => { window.api = { app: { setTheme: async () => {} } } as never })
const run = vi.fn()

const folderAgent = { id: 'folder:a', name: 'A', source: 'folder', driver: 'acp', localPath: '/agents/a', capabilities: {} }
const remoteAgent = { id: 'remote:r', name: 'R', source: 'remote', driver: 'a2a', localPath: null, capabilities: {} }

beforeEach(() => {
  // Notes and Dashboards are optional capabilities, off until turned on.
  Object.assign(capabilities, { notesEnabled: true, dashboardsEnabled: true })
  run.mockReset().mockResolvedValue({ ok: true, itemId: 'cmd-1', folder: '~/agents/a' })
  window.api = { app: { setTheme: async () => {} }, userCommands: { run } } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useRunScriptStore.setState({ window: null, pending: null, error: null, runSources: {} })
  window.getSelection()?.removeAllRanges()
})
afterEach(() => vi.restoreAllMocks())

function Harness({ content }: { content: string }) {
  const context = useMessageContextMenu('chat-1')
  return <><div data-testid="transcript" onContextMenu={context.onContextMenu}>
    <MessageIdContext.Provider value="msg-1">
      <MessageBubble role="assistant" content={content} />
    </MessageIdContext.Provider>
  </div>{context.menu}</>
}

function mount(content: string, agent: object = folderAgent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'chat-1'], { id: 'chat-1', agentId: (agent as { id: string }).id, messages: [{ id: 'msg-1', role: 'assistant', sourceAgentId: null }] })
  client.setQueryData(['agents'], [agent])
  render(<Harness content={content} />, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}

const items = (): string[] => within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent ?? '')

describe('messageMenuItems with a command', () => {
  it('adds Run, Run in background and Edit and Run… for a safe command, Edit and Run… alone otherwise', () => {
    expect(messageMenuItems(undefined, false, { auto: true })).toEqual([['copy-text', 'save-text'], ['run', 'run-background', 'edit-run']])
    expect(messageMenuItems(undefined, false, { auto: false })).toEqual([['copy-text', 'save-text'], ['edit-run']])
    expect(messageMenuItems(undefined, true)).toEqual([['copy-text', 'save-text']])
    // Notes off: no Save to Notes anywhere, and no group left empty by it.
    expect(messageMenuItems(undefined, false, { auto: false }, false)).toEqual([['copy-text'], ['edit-run']])
  })
})

describe('the command group', () => {
  it('offers the three items for a safe inline command and runs it unreviewed, opening the window on the run', async () => {
    mount('Run `uv run scripts/x.py --live` now.')
    fireEvent.contextMenu(screen.getByText('uv run scripts/x.py --live'))
    expect(items()).toEqual(['Copy text', 'Save to Notes', 'Run', 'Run in background', 'Edit and Run…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(run).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-1', command: 'uv run scripts/x.py --live', reviewed: false, columns: expect.any(Number) })
    expect(useRunScriptStore.getState().window).toMatchObject({ chatId: 'chat-1', messageId: 'msg-1', command: 'uv run scripts/x.py --live', runs: ['cmd-1'], reason: null })
  })

  it('runs in the background without opening the window', async () => {
    mount('`ls -la`')
    fireEvent.contextMenu(screen.getByText('ls -la'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run in background' }))
    await waitFor(() => expect(run).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(useRunScriptStore.getState().window).toBeNull()
  })

  it('offers only Edit and Run… for a fenced rm, with the review line', () => {
    mount('```bash\n! rm -rf build\n```')
    fireEvent.contextMenu(screen.getByTestId('transcript').querySelector('pre code')!)
    expect(items()).toEqual(['Copy text', 'Save to Notes', 'Edit and Run…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit and Run…' }))
    expect(useRunScriptStore.getState().window).toMatchObject({
      chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', command: 'rm -rf build', folder: '/agents/a', reason: COMMAND_REVIEW_REASONS.not_read_only, runs: []
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('opens the Run Script window with main\'s reason when Run comes back needs_review', async () => {
    run.mockResolvedValue({ ok: false, code: 'needs_review', reason: 'Check it first.', folder: '~/agents/a' })
    mount('`uv run scripts/missing.py`')
    fireEvent.contextMenu(screen.getByText('uv run scripts/missing.py'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
    await waitFor(() => expect(useRunScriptStore.getState().window).toMatchObject({ command: 'uv run scripts/missing.py', reason: 'Check it first.', folder: '~/agents/a', runs: [] }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says another refusal in the menu, which stays open', async () => {
    run.mockResolvedValue({ ok: false, code: 'folder_missing', reason: 'The agent\'s folder is no longer on this computer.' })
    mount('`ls -la`')
    fireEvent.contextMenu(screen.getByText('ls -la'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
    expect((await screen.findByRole('alert')).textContent).toMatch('no longer on this computer')
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('offers nothing to run for a remote agent\'s message, or for code that is not a command', () => {
    mount('`ls -la` and `tasks_report`', remoteAgent)
    fireEvent.contextMenu(screen.getByText('ls -la'))
    expect(items()).toEqual(['Copy text', 'Save to Notes'])
  })

  it('offers nothing to run for code that is not a command', () => {
    mount('`tasks_report`')
    fireEvent.contextMenu(screen.getByText('tasks_report'))
    expect(items()).toEqual(['Copy text', 'Save to Notes'])
  })
})
