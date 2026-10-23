import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_REVIEW_REASONS } from '../../../shared/userCommands'
import { INSPECT_WAIT_MS, useRunScriptStore } from './runScript.store'
import type { ScriptSpec } from '../../../shared/scriptSpec'

/**
 * The Run Script window's store: which window is up, and where a start's
 * answer lands when the window changed while it was in flight.
 */

const run = vi.fn()
const inspect = vi.fn()

beforeEach(() => {
  run.mockReset().mockResolvedValue({ ok: true, itemId: 'cmd-1', folder: '~/agents/a' })
  inspect.mockReset().mockResolvedValue({ ok: true, spec: null, folder: '~/agents/a' })
  window.api = { userCommands: { run, inspect } } as never
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

describe('reading the script\'s parameters as the window opens', () => {
  const SPEC: ScriptSpec = { script: 'scripts/check.py', language: 'python', summary: 'Check.', description: null, usage: null, params: [] }
  const SCRIPT = 'uv run scripts/check.py italy'

  afterEach(() => vi.useRealTimers())

  it('asks main for a script command and opens with the spec it answers', async () => {
    inspect.mockResolvedValue({ ok: true, spec: SPEC, folder: '~/agents/a' })
    const opened = useRunScriptStore.getState().openFromCode({ ...source, command: SCRIPT })
    // Not shown until main answers.
    expect(useRunScriptStore.getState().window).toBeNull()
    await opened
    expect(inspect).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-1', command: SCRIPT })
    expect(useRunScriptStore.getState().window).toMatchObject({ command: SCRIPT, spec: SPEC })
  })

  it('opens at once, with no spec and no question, for a command that names no script', () => {
    void useRunScriptStore.getState().openFromCode({ ...source, command: 'ls -la' })
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'ls -la', spec: null })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('opens without a spec when main is slow, and drops the late answer', async () => {
    vi.useFakeTimers()
    let answer: (value: unknown) => void = () => {}
    inspect.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const opened = useRunScriptStore.getState().openFromCode({ ...source, command: SCRIPT })
    await vi.advanceTimersByTimeAsync(INSPECT_WAIT_MS - 1)
    expect(useRunScriptStore.getState().window).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await opened
    const shown = useRunScriptStore.getState().window!
    expect(shown).toMatchObject({ command: SCRIPT, spec: null })
    answer({ ok: true, spec: SPEC, folder: '~/agents/a' })
    await vi.advanceTimersByTimeAsync(0)
    expect(useRunScriptStore.getState().window).toBe(shown)
  })

  it('opens no spec for a refusal or an error', async () => {
    inspect.mockResolvedValueOnce({ ok: false, code: 'not_local', reason: 'x' })
    await useRunScriptStore.getState().openFromCode({ ...source, command: SCRIPT })
    expect(useRunScriptStore.getState().window).toMatchObject({ spec: null })
    inspect.mockRejectedValueOnce(new Error('boom'))
    await useRunScriptStore.getState().openFromCode({ ...source, command: SCRIPT })
    expect(useRunScriptStore.getState().window).toMatchObject({ spec: null })
  })

  it('lets a later open, or a dismiss, win over one still waiting for its spec', async () => {
    let answer: (value: unknown) => void = () => {}
    inspect.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const waiting = useRunScriptStore.getState().openFromCode({ ...source, command: SCRIPT })
    void useRunScriptStore.getState().openFromCode({ ...source, command: 'ls later' })
    answer({ ok: true, spec: SPEC, folder: '~/agents/a' })
    await waiting
    expect(useRunScriptStore.getState().window).toMatchObject({ command: 'ls later' })

    useRunScriptStore.getState().dismiss()
    inspect.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const dismissed = useRunScriptStore.getState().openFromCode({ ...source, command: SCRIPT })
    useRunScriptStore.getState().dismiss()
    answer({ ok: true, spec: SPEC, folder: '~/agents/a' })
    await dismissed
    expect(useRunScriptStore.getState().window).toBeNull()
  })

  it('reads the spec alongside the menu\'s run, and not for a background run', async () => {
    inspect.mockResolvedValue({ ok: true, spec: SPEC, folder: '~/agents/a' })
    await useRunScriptStore.getState().runFromMenu({ ...menu, command: SCRIPT }, false)
    expect(useRunScriptStore.getState().window).toMatchObject({ runs: ['cmd-1'], spec: SPEC })
    inspect.mockClear()
    useRunScriptStore.getState().dismiss()
    await useRunScriptStore.getState().runFromMenu({ ...menu, command: SCRIPT }, true)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('reads the spec of a run reopened from the badge when its message is known', async () => {
    inspect.mockResolvedValue({ ok: true, spec: SPEC, folder: '~/agents/a' })
    useRunScriptStore.setState({ runSources: { 'cmd-7': { chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', folder: '~/agents/a' } } })
    await useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-7', title: SCRIPT, agentId: 'folder:a', detail: null })
    expect(useRunScriptStore.getState().window).toMatchObject({ runs: ['cmd-7'], spec: SPEC, messageId: 'msg-1' })
    // Unknown message: nothing to resolve the agent by, so no question.
    inspect.mockClear()
    await useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-8', title: SCRIPT, agentId: 'folder:a', detail: null })
    expect(inspect).not.toHaveBeenCalled()
    expect(useRunScriptStore.getState().window).toMatchObject({ runs: ['cmd-8'], spec: null })
  })
})

describe('a window opened from the file preview, with no message', () => {
  const fromFile = { chatId: 'chat-1', messageId: null, agentId: 'folder:a', viaChatAgent: true, folder: '~/agents/a', origin: null }

  it('asks for the spec, runs, and reopens from the badge through the chat\'s agent', async () => {
    await useRunScriptStore.getState().openFromCode({ ...fromFile, command: 'python3 scripts/x.py' })
    expect(inspect).toHaveBeenCalledWith({ chatId: 'chat-1', agentId: 'folder:a', command: 'python3 scripts/x.py' })
    await useRunScriptStore.getState().start('python3 scripts/x.py', false, 100, 'msg-other')
    // The chat's agent, not a reply found for it.
    expect(run).toHaveBeenCalledWith({ chatId: 'chat-1', agentId: 'folder:a', command: 'python3 scripts/x.py', reviewed: true, columns: 100 })
    expect(useRunScriptStore.getState().runSources['cmd-1']).toMatchObject({ messageId: null, viaChatAgent: true })
    useRunScriptStore.getState().close('close')
    inspect.mockClear()
    await useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-1', title: 'python3 scripts/x.py', agentId: 'folder:a', detail: null })
    expect(inspect).toHaveBeenCalledWith({ chatId: 'chat-1', agentId: 'folder:a', command: 'python3 scripts/x.py' })
    expect(useRunScriptStore.getState().window).toMatchObject({ viaChatAgent: true, messageId: null })
  })

  it('never sends the agent for a window that came from a message', async () => {
    await useRunScriptStore.getState().openForRun('chat-1', { id: 'cmd-7', title: 'python3 scripts/x.py', agentId: 'folder:a', detail: null })
    // A run this renderer did not start: no message, no chat-agent source, so no question.
    expect(inspect).not.toHaveBeenCalled()
    await useRunScriptStore.getState().start('python3 scripts/x.py', false, 100, null)
    expect(run).not.toHaveBeenCalled()
    expect(useRunScriptStore.getState().error).toBe('The message this command came from is no longer in the chat.')
  })
})
