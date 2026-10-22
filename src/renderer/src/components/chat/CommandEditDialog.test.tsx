import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandEditDialog } from './CommandEditDialog'
import { useUserCommandsStore } from '../../stores/userCommands.store'
import { resetHomeDirForTests } from '../../utils/userCommands'

const run = vi.fn()

beforeEach(() => {
  run.mockReset().mockResolvedValue({ ok: true, itemId: 'cmd-9', folder: '~/a' })
  window.api = { userCommands: { run, home: async () => '/Users/me' } } as never
  resetHomeDirForTests()
  useUserCommandsStore.setState({ panels: {}, edit: null, editPending: null, editError: null })
})

function open(reason: string | null = 'This command can change or delete files, so it runs after you check it.', command = 'rm -rf build', folder = '~/agents/a') {
  act(() => useUserCommandsStore.getState().openEdit({ chatId: 'chat-1', messageId: 'msg-1', command, folder, reason }))
  render(<CommandEditDialog />)
}

const field = (): HTMLTextAreaElement => screen.getByLabelText('Command') as HTMLTextAreaElement

describe('Edit and Run…', () => {
  it('shows the command, the folder and the reason, and keeps a fixed-size field', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Edit and Run' })).toBeTruthy()
    expect(field().value).toBe('rm -rf build')
    expect(field().rows).toBe(3)
    expect(field().className).toMatch(/\bresize-none\b/)
    expect(screen.getByText('~/agents/a')).toBeTruthy()
    expect(screen.getByText(/can change or delete files/)).toBeTruthy()
  })

  it('sizes the field once, at open, to the command\'s lines, and never while typing', () => {
    open(null, Array.from({ length: 7 }, (_, i) => `make step${i}`).join('\n'))
    expect(field().rows).toBe(7)
    expect(screen.queryByText(/ lines$/)).toBeNull()
    fireEvent.change(field(), { target: { value: Array.from({ length: 30 }, () => 'x').join('\n') } })
    expect(field().rows).toBe(7)
    expect(screen.queryByText(/ lines$/)).toBeNull()
  })

  it('caps the field at 12 rows and says how many lines scroll in it, counted at open', () => {
    open(null, Array.from({ length: 20 }, (_, i) => `make step${i}`).join('\n'))
    expect(field().rows).toBe(12)
    expect(screen.getByText('20 lines')).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'ls' } })
    expect(field().rows).toBe(12)
    expect(screen.getByText('20 lines')).toBeTruthy()
  })

  it('refuses an empty command in the dialog without asking main', async () => {
    open(null)
    fireEvent.change(field(), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Type a command to run.')
    expect(run).not.toHaveBeenCalled()
  })

  it('shows the menu\'s raw folder as main does, under ~', async () => {
    open(null, 'ls', '/Users/me/agents/a')
    expect(await screen.findByText('~/agents/a')).toBeTruthy()
    expect(screen.queryByText('/Users/me/agents/a')).toBeNull()
  })

  it('runs the edited command as reviewed with ⌘↩, opens its panel and closes', async () => {
    open(null)
    fireEvent.change(field(), { target: { value: 'rm -rf build/tmp' } })
    fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(run).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-1', command: 'rm -rf build/tmp', reviewed: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useUserCommandsStore.getState().panels['chat-1']).toBe('cmd-9')
  })

  it('runs in the background without opening the panel', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Run in background' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useUserCommandsStore.getState().panels).toEqual({})
  })

  it('shows a spawn error inside the dialog and stays open', async () => {
    run.mockResolvedValue({ ok: false, code: 'spawn_failed', reason: 'The command could not be started: spawn /bin/zsh ENOENT' })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect((await screen.findByRole('alert')).textContent).toMatch('ENOENT')
    expect(screen.getByRole('dialog', { name: 'Edit and Run' })).toBeTruthy()
    expect(field().value).toBe('rm -rf build')
  })

  it('closes on Cancel without running', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})
