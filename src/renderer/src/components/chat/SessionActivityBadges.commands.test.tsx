import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionActivityItem } from '../../../../shared/sessionActivity'
import { CommandsBadge, SessionActivityBadge, commandsLabel, formatRunDuration } from './SessionActivityBadges'
import { useRunScriptStore } from '../../stores/runScript.store'
import { useComposerAttachTargetStore } from '../../stores/composerAttachTarget.store'
import { useComposerDraftStore } from '../../stores/composerDraft.store'

/** The Commands badge: commands the user ran from a message, running or ended. */

const api = {
  outputFile: vi.fn(),
  dismiss: vi.fn(),
  ingestPaths: vi.fn()
}

const T0 = new Date('2026-10-22T10:00:00Z')
function command(id: string, patch: Partial<SessionActivityItem> = {}): SessionActivityItem {
  return { id, kind: 'command', agentId: 'folder:a', title: `ls ${id}`, detail: '~/agents/a', state: 'running',
    startedAt: T0, endedAt: null, outputPath: `/u/command-runs/chat-1/${id}.log`, canStop: true, ...patch }
}
const stop = { stop: vi.fn(), pending: () => false, refusal: () => null }

beforeEach(() => {
  api.outputFile.mockReset().mockResolvedValue({ ok: true, path: '/u/command-runs/chat-1/c1/output-ls.txt', filename: 'output-ls.txt' })
  api.dismiss.mockReset().mockResolvedValue({ ok: true })
  api.ingestPaths.mockReset().mockResolvedValue({ success: true, files: [{ id: 'f1', name: 'output-ls.txt' }] })
  window.api = { userCommands: { outputFile: api.outputFile, dismiss: api.dismiss }, files: { ingestPaths: api.ingestPaths } } as never
  useRunScriptStore.setState({ window: null, pending: null, error: null, runSources: {} })
  useComposerAttachTargetStore.setState({ targets: { 'chat-1': { draftKey: 'draft-chat-1', scope: 'local' } } })
  useComposerDraftStore.setState({ drafts: {} })
})

const badge = (): HTMLElement | null => document.querySelector<HTMLElement>('button[data-badge="command"]')

describe('the Commands badge', () => {
  it('is absent with no command, and counts the running ones by name', () => {
    const { rerender } = render(<CommandsBadge chatId="chat-1" items={[]} stop={stop} />)
    expect(badge()).toBeNull()
    rerender(<CommandsBadge chatId="chat-1" items={[command('c1'), command('c2')]} stop={stop} />)
    expect(badge()?.getAttribute('aria-label')).toBe('2 commands running')
    expect(badge()?.textContent).toBe('2')
  })

  it('stays once every command has ended, showing how the last one ended', () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'failed', endedAt: T0 })]} stop={stop} />)
    expect(badge()?.getAttribute('aria-label')).toBe('Commands: the last one failed')
    expect(commandsLabel([command('c2', { state: 'completed', endedAt: T0 })])).toBe('Commands: the last one completed')
  })

  it('is not counted by the collapsed Activity badge', () => {
    render(<SessionActivityBadge kind="all" items={[command('c1')]} stop={stop} />)
    expect(document.querySelector('button[data-badge="all"]')).toBeNull()
  })

  it('opens a run\'s output, and offers Stop only while it runs', () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1')]} stop={stop} />)
    fireEvent.click(badge()!)
    const list = screen.getByLabelText('Commands list')
    expect(within(list).getByRole('button', { name: 'Stop ls c1' })).toBeTruthy()
    expect(within(list).queryByRole('button', { name: /Add output/ })).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: 'Open output of ls c1' }))
    expect(useRunScriptStore.getState().window).toMatchObject({ chatId: 'chat-1', runs: ['c1'], command: 'ls c1', agentId: 'folder:a' })
    // The popover shuts behind the window, so Escape reaches the window.
    expect(screen.queryByLabelText('Commands list')).toBeNull()
  })

  it('adds an ended run\'s output to the composer\'s draft as a dropped file would be', async () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: T0 })]} stop={stop} />)
    fireEvent.click(badge()!)
    fireEvent.click(screen.getByRole('button', { name: 'Add output of ls c1 to message' }))
    await waitFor(() => expect(api.ingestPaths).toHaveBeenCalledWith({ scope: 'local', chatId: 'chat-1', paths: ['/u/command-runs/chat-1/c1/output-ls.txt'] }))
    await waitFor(() => expect(useComposerDraftStore.getState().drafts['draft-chat-1']?.files.attachments).toEqual([{ id: 'f1', name: 'output-ls.txt' }]))
    expect(api.outputFile).toHaveBeenCalledWith('chat-1', 'c1')
  })

  it('says why an output could not be added, under its row', async () => {
    api.outputFile.mockResolvedValue({ ok: false, code: 'not_found', reason: 'This run\'s output is no longer available.' })
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: T0 })]} stop={stop} />)
    fireEvent.click(badge()!)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add output of ls c1 to message' })) })
    expect((await screen.findByRole('alert')).textContent).toMatch('no longer available')
  })

  it('removes an ended run', async () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'stopped', endedAt: T0 })]} stop={stop} />)
    fireEvent.click(badge()!)
    fireEvent.click(screen.getByRole('button', { name: 'Remove ls c1' }))
    await waitFor(() => expect(api.dismiss).toHaveBeenCalledWith('chat-1', 'c1'))
  })

  it('closes the Run Script window when the run it shows is removed, and only then', async () => {
    void useRunScriptStore.getState().openForRun('chat-1', { id: 'c1', title: 'ls c1', agentId: 'folder:a', detail: '~/agents/a' })
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: T0 })]} stop={stop} />)
    fireEvent.click(badge()!)
    fireEvent.click(screen.getByRole('button', { name: 'Remove ls c1' }))
    await waitFor(() => expect(useRunScriptStore.getState().window).toBeNull())
  })

  it('keeps the window on another run of the chat when one is removed', async () => {
    void useRunScriptStore.getState().openForRun('chat-1', { id: 'c2', title: 'ls c2', agentId: 'folder:a', detail: '~/agents/a' })
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: T0 })]} stop={stop} />)
    fireEvent.click(badge()!)
    fireEvent.click(screen.getByRole('button', { name: 'Remove ls c1' }))
    await waitFor(() => expect(api.dismiss).toHaveBeenCalled())
    expect(useRunScriptStore.getState().window?.runs).toEqual(['c2'])
  })

  it('names its chat, so the window collapses into the right badge', () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1')]} stop={stop} />)
    expect(badge()?.dataset.chatId).toBe('chat-1')
  })

  it('puts the state, not a button, in Stop\'s slot once the run ends', () => {
    const { rerender } = render(<CommandsBadge chatId="chat-1" items={[command('c1')]} stop={stop} />)
    fireEvent.click(badge()!)
    const slot = (): Element => screen.getByLabelText('Commands list').querySelector('[data-slot="stop"]')!
    expect(slot().querySelector('button')?.getAttribute('aria-label')).toBe('Stop ls c1')
    rerender(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'stopped', endedAt: T0 })]} stop={stop} />)
    expect(slot().querySelector('button')).toBeNull()
    expect(slot().textContent).toBe('Stopped')
    const add = screen.getByRole('button', { name: 'Add output of ls c1 to message' })
    expect(slot().contains(add)).toBe(false)
  })

  it('offers the row actions as named icon buttons', () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: T0 })]} stop={stop} />)
    fireEvent.click(badge()!)
    expect(screen.getByRole('button', { name: 'Open output of ls c1' }).getAttribute('title')).toBe('Open output')
    expect(screen.getByRole('button', { name: 'Add output of ls c1 to message' }).getAttribute('title')).toBe('Add output to message')
    expect(screen.getByRole('button', { name: 'Remove ls c1' }).getAttribute('title')).toBe('Remove')
  })

  it('shows a run\'s duration as the Run Script window does', () => {
    render(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: new Date(T0.getTime() + 65_000) })]} stop={stop} />)
    fireEvent.click(badge()!)
    expect(screen.getByLabelText('Commands list').textContent).toContain('1m 05s')
    expect(formatRunDuration(65_000)).toBe('1m 05s')
  })

  it('keeps one fixed-height count cell for a number, a check or a crossed circle, and none after a Stop', () => {
    const cell = (): Element => badge()!.querySelector('[data-count]')!
    const { rerender } = render(<CommandsBadge chatId="chat-1" items={[command('c1')]} stop={stop} />)
    expect(cell().className).toMatch(/\bh-\[1lh\]/)
    expect(cell().textContent).toBe('1')
    rerender(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'completed', endedAt: T0 })]} stop={stop} />)
    expect(cell().querySelector('svg')?.getAttribute('class')).toMatch(/lucide-check/)
    rerender(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'failed', endedAt: T0 })]} stop={stop} />)
    expect(cell().querySelector('svg')?.getAttribute('class')).toMatch(/lucide-circle-x/)
    rerender(<CommandsBadge chatId="chat-1" items={[command('c1', { state: 'stopped', endedAt: T0 })]} stop={stop} />)
    expect(badge()!.querySelector('[data-count]')).toBeNull()
    expect(badge()!.querySelectorAll('svg')).toHaveLength(1)
  })
})
