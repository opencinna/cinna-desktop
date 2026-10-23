import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserCommandOutputFrame } from '../../../../shared/userCommands'
import { COMMAND_REVIEW_REASONS } from '../../../../shared/userCommands'
import { useAuthStore } from '../../stores/auth.store'

/**
 * The Run Script window: the terminal is xterm (faked), the output port is
 * faked per run, and the store drives it as the message, the menu and the
 * Commands badge do.
 */

const terminal = vi.hoisted(() => ({ writes: [] as string[], options: null as null | Record<string, unknown>, disposed: 0, resets: 0, themeSets: 0 }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    cols = 97
    constructor(options: Record<string, unknown>) {
      terminal.options = options
      this.options = new Proxy(options, {
        set(target, key, value) {
          if (key === 'theme') terminal.themeSets++
          target[key as string] = value
          return true
        }
      })
    }
    loadAddon(): void {}
    open(): void {}
    reset(): void { terminal.resets++; terminal.writes = [] }
    write(data: string): void { terminal.writes.push(data) }
    dispose(): void { terminal.disposed++ }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

const activity = vi.hoisted(() => ({ items: [] as unknown[] }))
const ports = vi.hoisted(() => ({ open: new Map<string, (frame: UserCommandOutputFrame) => void>(), closed: [] as string[] }))
const run = vi.fn()
const stop = vi.fn()

beforeEach(() => {
  terminal.writes = []
  terminal.options = null
  terminal.disposed = 0
  terminal.resets = 0
  terminal.themeSets = 0
  activity.items = []
  ports.open.clear()
  ports.closed = []
  run.mockReset().mockResolvedValue({ ok: true, itemId: 'cmd-1', folder: '~/agents/a' })
  stop.mockReset().mockResolvedValue({ ok: true })
  window.api = {
    sessionActivity: {
      get: async () => ({ ok: true, snapshot: { chatId: 'chat-1', items: activity.items } }),
      onChanged: () => () => undefined,
      stop
    },
    userCommands: {
      run,
      output: (_chatId: string, itemId: string, onFrame: (frame: UserCommandOutputFrame) => void) => {
        ports.open.set(itemId, onFrame)
        return () => { ports.open.delete(itemId); ports.closed.push(itemId) }
      },
      outputFile: vi.fn(),
      home: async () => '/Users/me'
    },
    agentFiles: { open: vi.fn(async () => ({ success: true })) },
    localAgents: { openPath: vi.fn(async () => ({ success: true })) }
  } as never
})
afterEach(() => {
  act(() => useRunScriptStore.setState({ window: null, pending: null, error: null, runSources: {} }))
})

const { RunScriptModal } = await import('./RunScriptModal')
const { useRunScriptStore } = await import('../../stores/runScript.store')
const { commandLineRows } = await import('./RunScriptCommandLine')

const useQueryClientRef: { current: QueryClient | null } = { current: null }

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useQueryClientRef.current = client
  client.setQueryData(['agents'], [{ id: 'folder:a', localPath: '/Users/me/agents/a' }])
  client.setQueryData(['chat', 'chat-1'], { id: 'chat-1', agentId: 'folder:a', messages: [{ id: 'msg-1', role: 'assistant', sourceAgentId: null }] })
  return render(<QueryClientProvider client={client}><RunScriptModal /></QueryClientProvider>)
}

const source = { chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', folder: '/Users/me/agents/a', origin: null }
const openOn = (command: string): void => act(() => useRunScriptStore.getState().openFromCode({ ...source, command }))
const line = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Command' }) as HTMLTextAreaElement
const runningItem = (id: string, title = 'uv run scripts/check.py italy') =>
  ({ id, kind: 'command', agentId: 'folder:a', title, detail: '~/agents/a', state: 'running', startedAt: new Date(), endedAt: null, outputPath: '/x.log', canStop: true })

describe('the Run Script window', () => {
  it('opens on a command with nothing running: the script\'s name, its path and folder, the command on the line', async () => {
    mount()
    openOn('uv run scripts/check.py italy')
    const dialog = screen.getByRole('dialog', { name: 'Run check.py' })
    expect(dialog.textContent).toContain('scripts/check.py')
    await waitFor(() => expect(dialog.textContent).toContain('~/agents/a'))
    expect(line().value).toBe('uv run scripts/check.py italy')
    expect(line().rows).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(ports.open.size).toBe(0)
    // A safe command carries no guard sentence.
    expect(dialog.textContent).not.toContain(COMMAND_REVIEW_REASONS.not_read_only)
    expect(dialog.textContent).not.toContain(COMMAND_REVIEW_REASONS.several_commands)
    // Before the first run the terminal says how to start it.
    expect(terminal.writes.join('')).toContain('Press Run (↩) to start.')
  })

  it('says the guard\'s sentence for a command that does not look safe, and runs it reviewed', async () => {
    mount()
    openOn('rm -rf build')
    expect(screen.getByRole('dialog').textContent).toContain(COMMAND_REVIEW_REASONS.not_read_only)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-1', command: 'rm -rf build', reviewed: true, columns: 97 }))
  })

  it('runs on Enter for a one-line command, and streams the run into the terminal', async () => {
    mount()
    openOn('ls -la')
    fireEvent.change(line(), { target: { value: 'ls -l' } })
    fireEvent.keyDown(line(), { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'ls -l', reviewed: true })))
    await waitFor(() => expect(ports.open.has('cmd-1')).toBe(true))
    act(() => ports.open.get('cmd-1')!({ type: 'start', command: 'ls -l', folder: '~/agents/a', startedAt: Date.now(), backlog: 'one\n' }))
    act(() => ports.open.get('cmd-1')!({ type: 'chunk', data: 'two\n' }))
    // The idle hint went with the first run's output.
    expect(terminal.writes).toEqual(['one\n', 'two\n'])
    expect(terminal.options).toMatchObject({ disableStdin: true })
    expect(useRunScriptStore.getState().window?.runs).toEqual(['cmd-1'])
  })

  it('takes Enter as a new line in a multi-line command, and runs it on ⌘↩', async () => {
    mount()
    openOn('cd scripts\nls')
    expect(line().rows).toBe(2)
    expect(screen.getByRole('dialog').textContent).toContain(COMMAND_REVIEW_REASONS.several_commands)
    expect(terminal.writes.join('')).toMatch(/Press Run \((⌘|Ctrl\+?)↩\) to start\./)
    fireEvent.keyDown(line(), { key: 'Enter' })
    expect(run).not.toHaveBeenCalled()
    fireEvent.keyDown(line(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'cd scripts\nls' })))
  })

  it('runs nothing on a held Enter\'s repeats or an Enter that commits a composition', async () => {
    mount()
    openOn('ls -la')
    const repeat = fireEvent.keyDown(line(), { key: 'Enter', repeat: true })
    // Swallowed, so it adds no new line either.
    expect(repeat).toBe(false)
    fireEvent.keyDown(line(), { key: 'Enter', metaKey: true, repeat: true })
    fireEvent.keyDown(line(), { key: 'Enter', isComposing: true })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(run).not.toHaveBeenCalled()
    fireEvent.keyDown(line(), { key: 'Enter' })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  })

  it('opens fresh when reopened during the previous window\'s exit', async () => {
    mount()
    openOn('ls first')
    fireEvent.change(line(), { target: { value: 'ls typed' } })
    act(() => {
      useRunScriptStore.getState().close('close')
      useRunScriptStore.getState().openFromCode({ ...source, command: 'ls second' })
    })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(line().value).toBe('ls second')
  })

  it('counts a long line\'s soft wraps in its rows, measured at open', () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const rect = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.tagName === 'TEXTAREA' ? 400 : 0 } })
    // A probe of 40 cells, 10px each: 40 cells across the field.
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: this.tagName === 'SPAN' ? 400 : 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    try {
      mount()
      openOn(`uv run scripts/check.py ${'x'.repeat(30)} ${'y'.repeat(30)}`)
      expect(line().rows).toBe(3)
      // Rows never follow typing.
      fireEvent.change(line(), { target: { value: 'ls' } })
      expect(line().rows).toBe(3)
      // Wrapping a one-line command does not make Enter a new line.
      fireEvent.keyDown(line(), { key: 'Enter' })
      expect(run).toHaveBeenCalled()
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
      HTMLElement.prototype.getBoundingClientRect = rect
    }
  })

  it('closes on a profile switch even while a start is in flight', async () => {
    act(() => useAuthStore.setState({ currentUser: { id: 'alice' } as never }))
    run.mockReturnValue(new Promise(() => {}))
    try {
      mount()
      openOn('ls -la')
      fireEvent.click(screen.getByRole('button', { name: 'Run' }))
      await waitFor(() => expect(useRunScriptStore.getState().pending).toBe('run'))
      act(() => useAuthStore.setState({ currentUser: { id: 'bob' } as never }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } finally {
      act(() => useAuthStore.setState({ currentUser: null }))
    }
  })

  it('ignores a pointer press on Stop just after it took Run\'s place, never the keyboard', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mount()
      openOn('ls -la')
      fireEvent.click(screen.getByRole('button', { name: 'Run' }), { detail: 1 })
      await waitFor(() => expect(useRunScriptStore.getState().window?.runs).toEqual(['cmd-1']))
      activity.items = [runningItem('cmd-1', 'ls -la')]
      // The activity push lists the run, and Stop takes Run's slot.
      await act(async () => { await useQueryClientRef.current!.invalidateQueries() })
      const stopButton = await screen.findByRole('button', { name: 'Stop' })
      // The second press of a double-click on Run.
      now += 150
      fireEvent.click(stopButton, { detail: 2 })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(stop).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Stop' })).toBe(stopButton)
      // The keyboard is not held back.
      fireEvent.click(stopButton, { detail: 0 })
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    } finally {
      clock.mockRestore()
    }
  })

  it('takes a pointer press on Stop once it has been up a moment', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mount()
      openOn('ls -la')
      fireEvent.click(screen.getByRole('button', { name: 'Run' }), { detail: 1 })
      await waitFor(() => expect(useRunScriptStore.getState().window?.runs).toEqual(['cmd-1']))
      activity.items = [runningItem('cmd-1', 'ls -la')]
      await act(async () => { await useQueryClientRef.current!.invalidateQueries() })
      const stopButton = await screen.findByRole('button', { name: 'Stop' })
      now += 450
      fireEvent.click(stopButton, { detail: 1 })
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    } finally {
      clock.mockRestore()
    }
  })

  it('runs in the background on ⇧⌘↩ and closes, leaving the run to the badge', async () => {
    mount()
    openOn('ls -la')
    fireEvent.keyDown(line(), { key: 'Enter', metaKey: true, shiftKey: true })
    await waitFor(() => expect(useRunScriptStore.getState().window).toBeNull())
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'ls -la', reviewed: true }))
    expect(useRunScriptStore.getState().runSources['cmd-1']).toMatchObject({ messageId: 'msg-1' })
  })

  it('shows a refusal above the command line and closes nothing', async () => {
    run.mockResolvedValue({ ok: false, code: 'spawn_failed', reason: 'The command could not be started: nope' })
    mount()
    openOn('ls -la')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The command could not be started: nope')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(line().value).toBe('ls -la')
  })

  it('swaps Run for Stop in the same slot while it runs, and the line is read-only', async () => {
    activity.items = [runningItem('cmd-1', 'ls -la')]
    mount()
    act(() => useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-1', title: 'ls -la', agentId: 'folder:a', detail: '~/agents/a' }))
    const stopButton = await screen.findByRole('button', { name: 'Stop' })
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    expect(line().readOnly).toBe(true)
    // Run in background keeps its place, hidden.
    expect(screen.getByText('Run in background').closest('span')?.className).toContain('invisible')
    fireEvent.click(stopButton)
    await waitFor(() => expect(stop).toHaveBeenCalled())
  })

  it('closes on Close and Escape without stopping the run, and lets go of the output', async () => {
    activity.items = [runningItem('cmd-1')]
    mount()
    act(() => useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-1', title: 'uv run scripts/check.py italy', agentId: 'folder:a', detail: null }))
    await waitFor(() => expect(ports.open.has('cmd-1')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ports.closed).toEqual(['cmd-1'])
    expect(terminal.disposed).toBe(1)
    expect(stop).not.toHaveBeenCalled()

    act(() => useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-1', title: 'uv run scripts/check.py italy', agentId: 'folder:a', detail: null }))
    await waitFor(() => expect(ports.open.has('cmd-1')).toBe(true))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(stop).not.toHaveBeenCalled()
  })

  it('reopens from the badge on the run, replaying its output, and can run it again from its message', async () => {
    useRunScriptStore.setState({ runSources: { 'cmd-1': { chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', folder: '~/agents/a' } } })
    activity.items = [{ ...runningItem('cmd-1', 'ls -la'), state: 'completed', endedAt: new Date() }]
    mount()
    act(() => useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-1', title: 'ls -la', agentId: 'folder:a', detail: '~/agents/a' }))
    await waitFor(() => expect(ports.open.has('cmd-1')).toBe(true))
    act(() => ports.open.get('cmd-1')!({ type: 'start', command: 'ls -la', folder: '~/agents/a', startedAt: Date.now() - 4000, backlog: 'earlier\n' }))
    act(() => ports.open.get('cmd-1')!({ type: 'end', end: { state: 'completed', exitCode: 0, signal: null }, endedAt: Date.now() }))
    expect(terminal.writes).toEqual(['earlier\n'])
    expect(screen.getByRole('dialog').textContent).toContain('Completed')

    run.mockResolvedValue({ ok: true, itemId: 'cmd-2', folder: '~/agents/a' })
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1', command: 'ls -la', reviewed: true })))
    await waitFor(() => expect(ports.open.has('cmd-2')).toBe(true))
    // A rerun clears the terminal and says so, rather than clearing silently.
    expect(terminal.resets).toBe(1)
    expect(terminal.writes.join('')).toContain('── run 2 ──')
    expect(ports.closed).toContain('cmd-1')
  })

  it('names a reply of the run\'s agent for a run this renderer did not start', async () => {
    activity.items = [{ ...runningItem('cmd-9', 'ls'), state: 'completed', endedAt: new Date() }]
    mount()
    act(() => useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-9', title: 'ls', agentId: 'folder:a', detail: '~/agents/a' }))
    act(() => ports.open.get('cmd-9')?.({ type: 'end', end: { state: 'completed', exitCode: 0, signal: null }, endedAt: Date.now() }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-1', command: 'ls' })))
  })

  it('walks the chat\'s earlier commands with ↑ and ↓ on a one-line command', async () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s))
    activity.items = [
      { ...runningItem('c1', 'ls one'), state: 'completed', startedAt: at(1), endedAt: at(2) },
      { ...runningItem('c2', 'ls two'), state: 'completed', startedAt: at(3), endedAt: at(4) }
    ]
    mount()
    openOn('ls now')
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    // The activity query lands asynchronously.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    fireEvent.keyDown(line(), { key: 'ArrowUp' })
    expect(line().value).toBe('ls two')
    fireEvent.keyDown(line(), { key: 'ArrowUp' })
    expect(line().value).toBe('ls one')
    fireEvent.keyDown(line(), { key: 'ArrowDown' })
    fireEvent.keyDown(line(), { key: 'ArrowDown' })
    expect(line().value).toBe('ls now')
  })

  it('collapses into its chat\'s Commands badge, and fades when the badge is not on screen', async () => {
    const animate = vi.fn(() => ({ cancel: () => {} }) as unknown as Animation)
    const original = HTMLElement.prototype.animate
    HTMLElement.prototype.animate = animate as never
    try {
      const badge = document.createElement('button')
      badge.dataset.badge = 'command'
      badge.dataset.chatId = 'chat-1'
      badge.getBoundingClientRect = () => ({ left: 900, top: 700, width: 30, height: 20, right: 930, bottom: 720, x: 900, y: 700, toJSON: () => ({}) })
      document.body.appendChild(badge)
      mount()
      openOn('ls -la')
      animate.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
      const frames = (animate.mock.calls as unknown as Array<[Keyframe[]]>).map(([keyframes]) => keyframes)
      expect(frames.some((keyframes) => String(keyframes[1]?.transform ?? '').includes('translate('))).toBe(true)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      badge.remove()

      openOn('ls -la')
      animate.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
      const fallback = (animate.mock.calls as unknown as Array<[Keyframe[]]>).map(([keyframes]) => keyframes)
      expect(fallback.some((keyframes) => String(keyframes[1]?.transform ?? '') === 'scale(0.92)')).toBe(true)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } finally {
      HTMLElement.prototype.animate = original
    }
  })
})

describe('commandLineRows', () => {
  it('gives a line per line without a measure, capped at six', () => {
    expect(commandLineRows('ls')).toBe(1)
    expect(commandLineRows('a\nb\nc')).toBe(3)
    expect(commandLineRows(Array(9).fill('ls').join('\n'))).toBe(6)
  })

  it('counts soft wraps at word breaks, and a word longer than the field', () => {
    expect(commandLineRows('x'.repeat(40), 40)).toBe(1)
    expect(commandLineRows(`${'a'.repeat(20)} ${'b'.repeat(25)}`, 40)).toBe(2)
    expect(commandLineRows('z'.repeat(100), 40)).toBe(3)
    expect(commandLineRows(`ls\n${'w '.repeat(60)}`, 40)).toBe(4)
    expect(commandLineRows('q '.repeat(400), 40)).toBe(6)
  })
})
