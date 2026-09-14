import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileRef } from '../../../shared/agentFiles'
import type { MessageAttachment } from '../../../shared/attachments'

const api = vi.hoisted(() => {
  const agentFiles = {
    authorize: vi.fn(),
    readPreview: vi.fn(),
    open: vi.fn(),
    reveal: vi.fn()
  }
  const files = { readPreview: vi.fn() }
  Object.assign(window, { api: { agentFiles, files } })
  return { agentFiles, files }
})

vi.mock('./logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  actionErrorRepeatsBody,
  actionErrorText,
  agentFileErrorText,
  useFilePreviewStore
} from './filePreview.store'

const ref = (over: Partial<AgentFileRef> = {}): AgentFileRef => ({
  text: 'data/omp.csv',
  path: '/agent/data/omp.csv',
  displayPath: 'data/omp.csv',
  kind: 'file',
  inside: true,
  ...over
})
const outside = (over: Partial<AgentFileRef> = {}): AgentFileRef =>
  ref({ path: '/elsewhere/notes.md', displayPath: '/elsewhere/notes.md', text: '/elsewhere/notes.md', inside: false, ...over })
const folder = (over: Partial<AgentFileRef> = {}): AgentFileRef =>
  ref({ kind: 'dir', path: '/agent/data', displayPath: 'data', text: 'data', ...over })

const store = () => useFilePreviewStore.getState()

beforeEach(() => {
  for (const fn of Object.values(api.agentFiles)) fn.mockReset()
  api.files.readPreview.mockReset()
  // Main approves by default; tests that deny or fail say so.
  api.agentFiles.authorize.mockResolvedValue({ success: true, approved: true })
  store().close()
})

describe('openAgentFile', () => {
  it('opens nothing when the user denies an outside file', async () => {
    api.agentFiles.authorize.mockResolvedValue({ success: true, approved: false })
    await store().openAgentFile('folder:a', outside())
    expect(api.agentFiles.authorize).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/elsewhere/notes.md' })
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
    expect(api.agentFiles.reveal).not.toHaveBeenCalled()
    expect(store().target).toBeNull()
    expect(store().error).toBeNull()
  })

  it('asks main for an inside file too, and opens nothing when main now refuses it', async () => {
    // `inside` was true at resolve time; the file has since become a symlink out.
    api.agentFiles.authorize.mockResolvedValue({ success: true, approved: false })
    await store().openAgentFile('folder:a', ref())
    expect(api.agentFiles.authorize).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/data/omp.csv' })
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
    expect(store().target).toBeNull()
  })

  it('opens the modal in an error state, from the click, when authorizing fails', async () => {
    api.agentFiles.authorize.mockResolvedValue({ success: false, code: 'not_found', error: 'That file is no longer there.' })
    const seq = store().openSeq
    await store().openAgentFile('folder:a', outside(), { x: 5, y: 6 })
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
    expect(store()).toMatchObject({
      target: { type: 'agentFile', agentId: 'folder:a', ref: outside() },
      error: 'That file is no longer there.',
      errorCode: 'not_found',
      failedStep: 'authorize',
      isLoading: false,
      kind: null,
      origin: { x: 5, y: 6 },
      openSeq: seq + 1
    })
  })

  it('opens the modal in an error state when the authorize call throws', async () => {
    api.agentFiles.authorize.mockRejectedValue(new Error("Error invoking remote method 'agent-files:authorize': Error: boom"))
    await store().openAgentFile('folder:a', ref())
    expect(store()).toMatchObject({ error: 'boom', errorCode: null, failedStep: 'authorize' })
    expect(store().target).not.toBeNull()
  })

  it('reveals a folder instead of previewing it, asking main every time', async () => {
    api.agentFiles.reveal.mockResolvedValue({ success: true })
    await store().openAgentFile('folder:a', folder())
    expect(api.agentFiles.authorize).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/data' })
    expect(api.agentFiles.reveal).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/data' })

    await store().openAgentFile('folder:a', outside({ kind: 'dir', path: '/elsewhere' }))
    expect(api.agentFiles.authorize).toHaveBeenCalledTimes(2)
    expect(api.agentFiles.reveal).toHaveBeenLastCalledWith({ agentId: 'folder:a', path: '/elsewhere' })
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
    expect(store().target).toBeNull()
  })

  it('keeps an attachment opened while an agent file waits on consent', async () => {
    let answer: (value: unknown) => void = () => {}
    api.agentFiles.authorize.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    api.files.readPreview.mockResolvedValue({ success: true, text: 'attached', truncated: false })
    const pending = store().openAgentFile('folder:a', outside())
    const attachment = { id: 'att-1', filename: 'a.txt', size: 1, mimeType: 'text/plain', source: 'local' } as MessageAttachment
    await store().openPreview(attachment, 'text')
    answer({ success: true, approved: true })
    await pending
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
    expect(store().target).toMatchObject({ type: 'attachment' })
    expect(store().text).toBe('attached')
  })

  it('opens the modal for a folder that has gone', async () => {
    api.agentFiles.authorize.mockResolvedValue({ success: false, code: 'not_found', error: 'That file is no longer there.' })
    await store().openAgentFile('folder:a', folder(), { x: 1, y: 2 })
    expect(api.agentFiles.reveal).not.toHaveBeenCalled()
    const s = store()
    expect(s).toMatchObject({ target: { type: 'agentFile', ref: folder() }, errorCode: 'not_found', origin: { x: 1, y: 2 } })
    expect(agentFileErrorText(folder(), s.failedStep, s.errorCode, s.error!)).toBe('That folder is no longer there.')
  })

  it('opens the modal when revealing a folder fails', async () => {
    api.agentFiles.reveal.mockResolvedValue({ success: false, code: 'launch_failed', error: 'Could not open the file.' })
    await store().openAgentFile('folder:a', folder())
    expect(store()).toMatchObject({ error: 'Could not open the file.', errorCode: 'launch_failed', failedStep: 'reveal' })

    store().close()
    api.agentFiles.reveal.mockRejectedValue(new Error('gone away'))
    await store().openAgentFile('folder:a', folder())
    expect(store()).toMatchObject({ error: 'gone away', errorCode: null, failedStep: 'reveal' })
  })

  it('previews a file inside the folder, from the click point', async () => {
    api.agentFiles.readPreview.mockResolvedValue({ success: true, text: 'a,b', truncated: true })
    const seq = store().openSeq
    await store().openAgentFile('folder:a', ref(), { x: 3, y: 4 })
    expect(store()).toMatchObject({
      target: { type: 'agentFile', agentId: 'folder:a', ref: ref() },
      attachment: null,
      kind: 'csv',
      text: 'a,b',
      truncated: true,
      isLoading: false,
      error: null,
      origin: { x: 3, y: 4 },
      openSeq: seq + 1
    })
  })

  it('previews an outside file once approved', async () => {
    api.agentFiles.readPreview.mockResolvedValue({ success: true, text: '# notes', truncated: false })
    await store().openAgentFile('folder:a', outside())
    expect(store()).toMatchObject({ kind: 'markdown', text: '# notes' })
  })

  it('keeps the failed read as the preview step', async () => {
    api.agentFiles.readPreview.mockResolvedValue({ success: false, code: 'read_failed', error: 'Could not read the file.' })
    await store().openAgentFile('folder:a', ref())
    expect(store()).toMatchObject({ error: 'Could not read the file.', errorCode: 'read_failed', failedStep: 'preview', isLoading: false })
  })

  it('shows the credential notice when main refuses the read', async () => {
    api.agentFiles.readPreview.mockResolvedValue({ success: false, code: 'credential_file', error: 'x' })
    await store().openAgentFile('folder:a', ref({ path: '/agent/data/secret.json', text: 'data/secret.json', displayPath: 'data/secret.json' }))
    expect(api.agentFiles.readPreview).toHaveBeenCalledTimes(1)
    expect(store()).toMatchObject({ notice: 'credential', error: null, isLoading: false })
    expect(store().target).not.toBeNull()
  })

  it('shows the credential notice for a plainly named credential file without asking for it', async () => {
    await store().openAgentFile('folder:a', ref({ path: '/agent/.env', text: '.env', displayPath: '.env' }))
    expect(store()).toMatchObject({ notice: 'credential', isLoading: false })
    await store().openAgentFile(
      'folder:a',
      ref({ path: '/agent/credentials/token.json', text: 'credentials/token.json', displayPath: 'credentials/token.json' })
    )
    expect(store()).toMatchObject({ notice: 'credential', isLoading: false })
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
  })

  it('opens a type it cannot preview without reading it', async () => {
    await store().openAgentFile('folder:a', ref({ path: '/agent/dump.gz', text: 'dump.gz' }))
    expect(api.agentFiles.readPreview).not.toHaveBeenCalled()
    expect(store()).toMatchObject({ notice: 'unsupported', kind: null, isLoading: false })
    expect(store().target).not.toBeNull()
  })
})

describe('header actions', () => {
  it('keep the modal open and say which action failed', async () => {
    api.agentFiles.readPreview.mockResolvedValue({ success: true, text: 'a', truncated: false })
    await store().openAgentFile('folder:a', ref())
    api.agentFiles.open.mockResolvedValue({ success: false, code: 'launch_failed', error: 'No app could open this file.' })
    await store().openAgentFileExternally()
    expect(store()).toMatchObject({
      actionError: { action: 'open', code: 'launch_failed', reason: 'No app could open this file.' },
      pendingAction: null
    })
    expect(store().target).not.toBeNull()

    api.agentFiles.reveal.mockResolvedValue({ success: true })
    await store().revealAgentFile()
    expect(api.agentFiles.reveal).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/data/omp.csv' })
    expect(store().actionError).toBeNull()
  })

  it('ask main before acting on an inside file, and report its failure', async () => {
    api.agentFiles.readPreview.mockResolvedValue({ success: true, text: 'a', truncated: false })
    await store().openAgentFile('folder:a', ref())
    api.agentFiles.authorize.mockReset()
    api.agentFiles.authorize.mockResolvedValue({ success: false, code: 'not_found', error: 'That file is no longer there.' })
    await store().revealAgentFile()
    expect(api.agentFiles.authorize).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/agent/data/omp.csv' })
    expect(api.agentFiles.reveal).not.toHaveBeenCalled()
    expect(store()).toMatchObject({
      actionError: { action: 'reveal', code: 'not_found', reason: 'That file is no longer there.' },
      pendingAction: null
    })
  })

  it('launch nothing for a file the user now denies', async () => {
    api.agentFiles.authorize.mockResolvedValueOnce({ success: true, approved: true })
    api.agentFiles.readPreview.mockResolvedValue({ success: true, text: 'a', truncated: false })
    await store().openAgentFile('folder:a', outside())
    api.agentFiles.authorize.mockResolvedValueOnce({ success: true, approved: false })
    await store().openAgentFileExternally()
    expect(api.agentFiles.open).not.toHaveBeenCalled()
    expect(store()).toMatchObject({ actionError: null, pendingAction: null })
  })

  it('do nothing for a folder shown in its error state', async () => {
    api.agentFiles.authorize.mockResolvedValue({ success: false, code: 'not_found', error: 'gone' })
    await store().openAgentFile('folder:a', folder())
    api.agentFiles.authorize.mockClear()
    await store().openAgentFileExternally()
    await store().revealAgentFile()
    expect(api.agentFiles.authorize).not.toHaveBeenCalled()
    expect(store().actionError).toBeNull()
  })
})

describe('error copy', () => {
  it('words the body by what failed', () => {
    expect(agentFileErrorText(folder(), 'authorize', 'not_found', 'That file is no longer there.')).toBe(
      'That folder is no longer there.'
    )
    expect(agentFileErrorText(folder(), 'reveal', 'not_found', 'x')).toBe('That folder is no longer there.')
    expect(agentFileErrorText(ref(), 'authorize', 'not_found', 'That file is no longer there.')).toBe(
      'That file is no longer there.'
    )
    expect(agentFileErrorText(ref(), 'preview', 'read_failed', 'Could not read the file.')).toBe(
      "Couldn't load preview: Could not read the file."
    )
    // Main's launch_failed reason already names the action; it is not prefixed again.
    expect(agentFileErrorText(folder(), 'reveal', 'launch_failed', 'Could not show the file in its folder.')).toBe(
      'Could not show the file in its folder.'
    )
    expect(agentFileErrorText(folder(), 'reveal', null, 'boom')).toBe("Couldn't show it in its folder: boom")
    expect(agentFileErrorText(ref(), 'authorize', null, 'boom')).toBe('boom')
  })

  it('names the action in the action row', () => {
    expect(actionErrorText({ action: 'open', code: 'launch_failed', reason: 'No app could open this file.' })).toBe(
      'No app could open this file.'
    )
    expect(actionErrorText({ action: 'open', code: null, reason: 'boom' })).toBe("Couldn't open it: boom")
    expect(actionErrorText({ action: 'reveal', code: null, reason: 'boom' })).toBe("Couldn't show it in its folder: boom")
  })

  it('does not repeat in the action row what the body already says', () => {
    const gone = { action: 'open' as const, code: 'not_found' as const, reason: 'That file is no longer there.' }
    expect(actionErrorRepeatsBody({ actionError: gone, error: 'That file is no longer there.', errorCode: 'not_found', isLoading: false })).toBe(true)
    expect(actionErrorRepeatsBody({ actionError: { ...gone, code: null }, error: 'That file is no longer there.', errorCode: null, isLoading: false })).toBe(true)
    expect(actionErrorRepeatsBody({ actionError: gone, error: null, errorCode: null, isLoading: false })).toBe(false)
    expect(
      actionErrorRepeatsBody({ actionError: { action: 'open', code: 'launch_failed', reason: 'No app.' }, error: 'Could not read the file.', errorCode: 'read_failed', isLoading: false })
    ).toBe(false)
  })
})

describe('openPreview (attachments)', () => {
  it('still previews an attachment', async () => {
    api.files.readPreview.mockResolvedValue({ success: true, text: 'hello', truncated: false })
    const attachment = { id: 'f1', filename: 'a.txt', size: 5, mimeType: 'text/plain', source: 'local' as const }
    await store().openPreview(attachment, 'text')
    expect(api.files.readPreview).toHaveBeenCalledWith({ fileId: 'f1', source: 'local' })
    expect(store()).toMatchObject({ target: { type: 'attachment', attachment }, attachment, kind: 'text', text: 'hello', failedStep: null })
  })
})
