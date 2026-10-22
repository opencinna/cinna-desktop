import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserCommandOutputFrame } from '../../../../shared/userCommands'

/** The docked output panel: a read-only terminal fed by the output port. */

const terminal = vi.hoisted(() => ({ writes: [] as string[], options: null as null | Record<string, unknown>, disposed: 0, themeSets: 0 }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
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
    write(data: string): void { terminal.writes.push(data) }
    dispose(): void { terminal.disposed++ }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

const activity = vi.hoisted(() => ({ items: [] as unknown[] }))
const port = vi.hoisted(() => ({ onFrame: null as null | ((frame: UserCommandOutputFrame) => void), closed: 0 }))

beforeEach(() => {
  terminal.writes = []
  terminal.options = null
  terminal.disposed = 0
  terminal.themeSets = 0
  activity.items = []
  port.onFrame = null
  port.closed = 0
  window.api = {
    sessionActivity: {
      get: async () => ({ ok: true, snapshot: { chatId: 'chat-1', items: activity.items } }),
      onChanged: () => () => undefined,
      stop: vi.fn()
    },
    userCommands: {
      output: (_chatId: string, _itemId: string, onFrame: (frame: UserCommandOutputFrame) => void) => {
        port.onFrame = onFrame
        return () => { port.closed++ }
      },
      outputFile: vi.fn()
    }
  } as never
})

const { CommandOutputPanel, terminalTheme } = await import('./CommandOutputPanel')
const { useUserCommandsStore } = await import('../../stores/userCommands.store')
const { useUIStore } = await import('../../stores/ui.store')

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><CommandOutputPanel chatId="chat-1" /></QueryClientProvider>)
}

describe('the command output panel', () => {
  it('is absent until a run is opened in the chat', () => {
    useUserCommandsStore.setState({ panels: {} })
    mount()
    expect(screen.queryByRole('region', { name: 'Command output' })).toBeNull()
  })

  it('writes the backlog and the live output to a read-only terminal, then shows how it ended', () => {
    useUserCommandsStore.setState({ panels: { 'chat-1': 'cmd-1' } })
    mount()
    expect(terminal.options).toMatchObject({ disableStdin: true, convertEol: true })
    act(() => port.onFrame!({ type: 'start', command: 'ls -la', folder: '~/a', startedAt: Date.now(), backlog: 'one\n' }))
    act(() => port.onFrame!({ type: 'chunk', data: 'two\n' }))
    expect(terminal.writes).toEqual(['one\n', 'two\n'])
    expect(screen.getByText('ls -la')).toBeTruthy()
    act(() => port.onFrame!({ type: 'end', end: { state: 'failed', exitCode: 2, signal: null }, endedAt: Date.now() }))
    expect(screen.getByText('Exit 2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add output to message' })).toBeTruthy()
  })

  it('closes without stopping the run, and lets go of the output and the terminal', () => {
    useUserCommandsStore.setState({ panels: { 'chat-1': 'cmd-1' } })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Close output' }))
    expect(useUserCommandsStore.getState().panels).toEqual({})
    expect(port.closed).toBe(1)
    expect(terminal.disposed).toBe(1)
    expect((window.api.sessionActivity.stop as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('reads its colours from the app\'s variables', () => {
    const style = { getPropertyValue: (name: string) => ({ '--color-bg-secondary': ' #111 ', '--color-text': '#eee', '--color-danger': '#f00' } as Record<string, string>)[name] ?? '' }
    expect(terminalTheme(style)).toMatchObject({ background: '#111', foreground: '#eee', red: '#f00' })
  })

  it('puts how the run ended in Stop\'s slot, never a button, and Add output elsewhere', async () => {
    activity.items = [{ id: 'cmd-1', kind: 'command', agentId: 'a', title: 'sleep 9', detail: '~/a', state: 'running',
      startedAt: new Date(), endedAt: null, outputPath: '/x.log', canStop: true }]
    useUserCommandsStore.setState({ panels: { 'chat-1': 'cmd-1' } })
    const { container } = mount()
    const slot = (): Element => container.querySelector('[data-slot="stop"]')!
    act(() => port.onFrame!({ type: 'start', command: 'sleep 9', folder: '~/a', startedAt: Date.now(), backlog: '' }))
    await screen.findByRole('button', { name: 'Stop sleep 9' })
    expect(slot().querySelector('button')?.getAttribute('aria-label')).toBe('Stop sleep 9')
    act(() => port.onFrame!({ type: 'end', end: { state: 'stopped', exitCode: null, signal: 'SIGTERM' }, endedAt: Date.now() }))
    expect(slot().querySelector('button')).toBeNull()
    expect(slot().textContent).toContain('Stopped')
    const add = screen.getByRole('button', { name: 'Add output to message' })
    expect(slot().contains(add)).toBe(false)
  })

  it('re-reads its colours when the app\'s theme changes while it is open', () => {
    useUserCommandsStore.setState({ panels: { 'chat-1': 'cmd-1' } })
    mount()
    const before = terminal.themeSets
    act(() => useUIStore.setState({ theme: useUIStore.getState().theme === 'dark' ? 'light' : 'dark' }))
    expect(terminal.themeSets).toBe(before + 1)
  })
})
