import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../../shared/agentFiles'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../stores/fileDownload.store', () => ({
  useFileDownloadStore: (select: (s: { download: () => void; downloadingIds: Set<string> }) => unknown) =>
    select({ download: () => {}, downloadingIds: new Set() })
}))

import { FilePreviewModal } from './FilePreviewModal'
import { isRunnableScriptRef, previewRunSource, useFilePreviewStore } from '../../stores/filePreview.store'
import { useRunScriptStore } from '../../stores/runScript.store'
import { useChatStore } from '../../stores/chat.store'

/**
 * The file preview's Run…: shown for a script inside the agent's folder when
 * there is a chat to run it in, and it opens the Run Script window on the
 * command main built — running nothing.
 */

const ref = (path: string, more: Partial<AgentFileRef> = {}): AgentFileRef => ({
  text: path, path: `/agent/${path}`, displayPath: path, kind: 'file', inside: true, ...more
})

const commandForFile = vi.fn()
const inspect = vi.fn()
const run = vi.fn()

beforeEach(() => {
  commandForFile.mockReset().mockResolvedValue({ ok: true, command: 'python3 scripts/report.py', folder: '~/agent' })
  inspect.mockReset().mockResolvedValue({ ok: true, spec: null, folder: '~/agent' })
  run.mockReset()
  window.api = { userCommands: { commandForFile, inspect, run } } as never
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true, writable: true, value: () => ({ cancel: () => {} })
  })
  act(() => {
    useFilePreviewStore.getState().close()
    useRunScriptStore.setState({ window: null, pending: null, error: null })
    useChatStore.setState({ activeChatId: 'chat-1' })
  })
})

afterEach(() => {
  act(() => {
    useFilePreviewStore.getState().close()
    useRunScriptStore.setState({ window: null, pending: null, error: null })
  })
})

/** The preview on an agent file, loaded with `text`, under a query client holding the active chat. */
function show(fileRef: AgentFileRef, options: { messageId?: string; text?: string; chatAgentId?: string | null } = {}): void {
  const client = new QueryClient()
  if (options.chatAgentId !== undefined) client.setQueryData(['chat', 'chat-1'], { id: 'chat-1', agentId: options.chatAgentId, messages: [] })
  render(<QueryClientProvider client={client}><FilePreviewModal /></QueryClientProvider>)
  act(() => {
    useFilePreviewStore.setState({
      target: { type: 'agentFile', agentId: 'folder:a', ref: fileRef, messageId: options.messageId ?? null },
      kind: 'text',
      text: options.text ?? 'print(1)\n',
      isLoading: false,
      openSeq: useFilePreviewStore.getState().openSeq + 1
    })
  })
}

const runButton = (): HTMLElement | null => screen.queryByRole('button', { name: /Run…/ })

describe('which files offer Run…', () => {
  it.each([
    ['a .py', ref('scripts/report.py'), '', true],
    ['a .sh', ref('run.sh'), '', true],
    ['a file with a shebang', ref('bin/tool.cli'), '#!/usr/bin/env bash\necho', true],
    ['a shebang file with no extension', ref('bin/tool'), '#!/usr/bin/env bash\necho', false],
    ['a dotfile with a shebang', ref('bin/.tool'), '#!/bin/sh', false],
    ['a text file', ref('notes.txt'), 'hello', false],
    ['a bare .py name', ref('.py'), '', false],
    ['a file outside the folder', ref('x.py', { inside: false, path: '/elsewhere/x.py', displayPath: '/elsewhere/x.py' }), '', false],
    ['a credential file', ref('credentials/rotate.sh'), '', false],
    ['a folder', ref('scripts', { kind: 'dir' }), '', false]
  ])('%s → %s', (_name, fileRef, text, expected) => {
    expect(isRunnableScriptRef(fileRef, text)).toBe(expected)
  })

  it('takes the message in the active chat, else the active chat when its agent is the file\'s', () => {
    const target = { type: 'agentFile' as const, agentId: 'folder:a', ref: ref('x.py') }
    expect(previewRunSource({ ...target, messageId: 'm1' }, 'chat-1', 'folder:b')).toEqual({ chatId: 'chat-1', messageId: 'm1' })
    expect(previewRunSource(target, 'chat-1', 'folder:a')).toEqual({ chatId: 'chat-1', agentId: 'folder:a' })
    expect(previewRunSource(target, 'chat-1', 'folder:b')).toBeNull()
    expect(previewRunSource(target, 'chat-1', undefined)).toBeNull()
    expect(previewRunSource({ ...target, messageId: 'm1' }, null, 'folder:a')).toBeNull()
  })
})

describe('Run… in the preview header', () => {
  it('opens the Run Script window on the command main built for the message\'s file; nothing runs', async () => {
    show(ref('scripts/report.py'), { messageId: 'msg-1' })
    const button = runButton()
    expect(button).not.toBeNull()
    await act(async () => { fireEvent.click(button!, { detail: 1, clientX: 40, clientY: 50 }) })
    expect(commandForFile).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-1', path: '/agent/scripts/report.py' })
    // The preview stepped aside; the window is up on the command, from the click.
    expect(useFilePreviewStore.getState().target).toBeNull()
    expect(useRunScriptStore.getState().window).toMatchObject({
      chatId: 'chat-1', messageId: 'msg-1', agentId: 'folder:a', command: 'python3 scripts/report.py',
      folder: '~/agent', origin: { x: 40, y: 50 }, runs: []
    })
    expect(inspect).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-1', command: 'python3 scripts/report.py' })
    expect(run).not.toHaveBeenCalled()
  })

  it('without a message, runs through the active chat when its agent is the file\'s', async () => {
    commandForFile.mockResolvedValueOnce({ ok: true, command: 'uv run scripts/report.py', folder: '~/agent' })
    show(ref('scripts/report.py'), { chatAgentId: 'folder:a' })
    await act(async () => { fireEvent.click(runButton()!) })
    expect(commandForFile).toHaveBeenCalledWith({ chatId: 'chat-1', agentId: 'folder:a', path: '/agent/scripts/report.py' })
    expect(useRunScriptStore.getState().window).toMatchObject({
      messageId: null, agentId: 'folder:a', viaChatAgent: true, command: 'uv run scripts/report.py', origin: null
    })
    // The form is asked for through the same source.
    expect(inspect).toHaveBeenCalledWith({ chatId: 'chat-1', agentId: 'folder:a', command: 'uv run scripts/report.py' })
  })

  it.each([
    ['the active chat is another agent\'s', { chatAgentId: 'folder:b' }],
    ['the active chat has not loaded', {}]
  ])('is not offered without a message when %s', (_name, options) => {
    show(ref('scripts/report.py'), options)
    expect(runButton()).toBeNull()
  })

  it('is not offered with no active chat, even for a message\'s file', () => {
    act(() => useChatStore.setState({ activeChatId: null }))
    show(ref('scripts/report.py'), { messageId: 'msg-1' })
    expect(runButton()).toBeNull()
  })

  it('is offered for a shebang file once its text is loaded, and not for plain text', () => {
    show(ref('bin/tool.cli'), { messageId: 'msg-1', text: '#!/bin/sh\necho hi\n' })
    expect(runButton()).not.toBeNull()
    act(() => useFilePreviewStore.setState({ text: 'echo hi\n' }))
    expect(runButton()).toBeNull()
  })

  it('keeps the preview open and says why when main refuses', async () => {
    commandForFile.mockResolvedValueOnce({ ok: false, code: 'not_runnable', reason: 'Cinna doesn\'t know how to run this file as a script.' })
    show(ref('scripts/report.py'), { messageId: 'msg-1' })
    await act(async () => { fireEvent.click(runButton()!) })
    expect(useFilePreviewStore.getState().target).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Cinna doesn\'t know how to run this file as a script.')
    expect(useRunScriptStore.getState().window).toBeNull()
  })
})
