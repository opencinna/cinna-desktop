import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_REVIEW_REASONS } from '../../../shared/userCommands'
import { useRunScriptStore } from './runScript.store'

/**
 * The Run Script window's store: which window is up, and where a start's
 * answer lands when the window changed while it was in flight.
 */

const run = vi.fn()

beforeEach(() => {
  run.mockReset().mockResolvedValue({ ok: true, itemId: 'cmd-1', folder: '~/agents/a' })
  window.api = { userCommands: { run } } as never
  useRunScriptStore.setState({ window: null, pending: null, error: null, runSources: {} })
})
afterEach(() => useRunScriptStore.setState({ window: null, pending: null, error: null, runSources: {} }))

const source = { chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', folder: '/agents/a', origin: null }
const menu = { ...source, columns: 120 }

/** A run whose answer the test releases. */
function heldRun(): (value: unknown) => void {
  let release: (value: unknown) => void = () => {}
  run.mockReturnValue(new Promise((resolve) => { release = resolve }))
  return release
}

describe('the Run Script store', () => {
  it('gives every open a new seq, even after a close, so a reopen never reuses the closing card', () => {
    const { openFromCode, close, openForRun } = useRunScriptStore.getState()
    openFromCode({ ...source, command: 'ls a' })
    const first = useRunScriptStore.getState().window!.seq
    close('close')
    openFromCode({ ...source, command: 'ls b' })
    const second = useRunScriptStore.getState().window!.seq
    expect(second).not.toBe(first)
    close('close')
    openForRun('chat-1', { id: 'cmd-9', title: 'ls', agentId: 'folder:a', detail: null })
    expect([first, second]).not.toContain(useRunScriptStore.getState().window!.seq)
  })

  it('says why it holds a command: several commands, or one not known to be read-only', () => {
    const { openFromCode } = useRunScriptStore.getState()
    openFromCode({ ...source, command: 'echo one\necho two' })
    expect(useRunScriptStore.getState().window!.reason).toBe(COMMAND_REVIEW_REASONS.several_commands)
    openFromCode({ ...source, command: 'rm -rf build' })
    expect(useRunScriptStore.getState().window!.reason).toBe(COMMAND_REVIEW_REASONS.not_read_only)
    openFromCode({ ...source, command: 'ls -la' })
    expect(useRunScriptStore.getState().window!.reason).toBeNull()
  })

  it('opens the menu\'s run when no window is up, or the one that was up is still there', async () => {
    await useRunScriptStore.getState().runFromMenu({ ...menu, command: 'ls -la' }, false)
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'ls -la', runs: ['cmd-1'] })

    run.mockResolvedValue({ ok: true, itemId: 'cmd-2', folder: '~/agents/a' })
    await useRunScriptStore.getState().runFromMenu({ ...menu, command: 'ls -l' }, false)
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'ls -l', runs: ['cmd-2'] })
  })

  it('does not replace a window opened while the menu\'s run was starting; the run is still kept', async () => {
    const release = heldRun()
    const answer = useRunScriptStore.getState().runFromMenu({ ...menu, command: 'ls -la' }, false)
    useRunScriptStore.getState().openFromCode({ ...source, command: 'rm -rf build' })
    release({ ok: true, itemId: 'cmd-1', folder: '~/agents/a' })
    expect(await answer).toBeNull()
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'rm -rf build', runs: [] })
    expect(useRunScriptStore.getState().runSources['cmd-1']).toMatchObject({ messageId: 'msg-1' })
  })

  it('answers main\'s review reason to the menu rather than replace a window opened meanwhile', async () => {
    const release = heldRun()
    const answer = useRunScriptStore.getState().runFromMenu({ ...menu, command: 'uv run scripts/x.py' }, false)
    useRunScriptStore.getState().openFromCode({ ...source, command: 'ls b' })
    release({ ok: false, code: 'needs_review', reason: 'Check it first.', folder: '~/agents/a' })
    expect(await answer).toBe('Check it first.')
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'ls b' })
  })

  it('dismisses the window even while a start is in flight, and the start\'s answer opens nothing', async () => {
    useRunScriptStore.getState().openFromCode({ ...source, command: 'ls -la' })
    const release = heldRun()
    const started = useRunScriptStore.getState().start('ls -la', false, 120)
    useRunScriptStore.getState().close('close')
    expect(useRunScriptStore.getState().window).not.toBeNull()
    useRunScriptStore.getState().dismiss()
    expect(useRunScriptStore.getState().window).toBeNull()
    release({ ok: true, itemId: 'cmd-1', folder: '~/agents/a' })
    await started
    expect(useRunScriptStore.getState()).toMatchObject({ window: null, pending: null })
  })
})
