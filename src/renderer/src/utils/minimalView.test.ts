import { describe, expect, it } from 'vitest'
import type { PendingInputRequest } from '../stores/chat.store'
import {
  cloudHasContent,
  isEditableTarget,
  minimalRefused,
  openTopLevelAskIds,
  shouldForwardKey,
  shouldRestoreMinimal,
  type CloudDraft
} from './minimalView'

const EMPTY: CloudDraft = { text: '', attachments: 0, notes: 0, pathRefs: 0, pastes: 0 }

function ask(requestId: string, extra: Partial<PendingInputRequest> = {}): PendingInputRequest {
  return { requestId, request: { kind: 'question' } as unknown as PendingInputRequest['request'], resume: 'reply', ...extra }
}

describe('cloudHasContent', () => {
  it('is hidden for an empty draft and for whitespace, as Send is disabled for it', () => {
    expect(cloudHasContent(EMPTY)).toBe(false)
    expect(cloudHasContent({ ...EMPTY, text: '  \n ' })).toBe(false)
  })

  it('shows for text, an attachment, a note, a path reference or a paste chip alone', () => {
    expect(cloudHasContent({ ...EMPTY, text: 'hi' })).toBe(true)
    expect(cloudHasContent({ ...EMPTY, attachments: 1 })).toBe(true)
    expect(cloudHasContent({ ...EMPTY, notes: 1 })).toBe(true)
    expect(cloudHasContent({ ...EMPTY, pathRefs: 1 })).toBe(true)
    expect(cloudHasContent({ ...EMPTY, pastes: 1 })).toBe(true)
  })

  it('shows for an attach error, so a refused drop is never silent, and hides once it clears', () => {
    expect(cloudHasContent({ ...EMPTY, attachError: 'Folders and unresolved files cannot be attached' })).toBe(true)
    expect(cloudHasContent({ ...EMPTY, attachError: null })).toBe(false)
  })

  it('hides again after a send clears the draft', () => {
    const before = { ...EMPTY, text: 'hello', pastes: 1 }
    expect(cloudHasContent(before)).toBe(true)
    expect(cloudHasContent({ ...before, text: '', pastes: 0 })).toBe(false)
  })
})

describe('minimal view refusal and auto-restore', () => {
  const quiet = { sendError: null, inputRequests: [], settledInputRequestIds: [] }
  const NONE = { askIds: [], handoffPending: false }

  it('refuses to start while a handoff is pending, and restores when one becomes pending', () => {
    expect(minimalRefused({ ...quiet, handoffPending: true })).toBe(true)
    expect(minimalRefused({ ...quiet, handoffPending: false })).toBe(false)
    expect(shouldRestoreMinimal({ ...quiet, handoffPending: true }, NONE)).toBe(true)
    expect(shouldRestoreMinimal({ ...quiet, handoffPending: false }, NONE)).toBe(false)
    // One already pending when minimal began does not end it.
    expect(shouldRestoreMinimal({ ...quiet, handoffPending: true }, { askIds: [], handoffPending: true })).toBe(false)
  })

  it('counts only unsettled top-level asks', () => {
    const state = {
      inputRequests: [ask('a'), ask('b', { toolCallId: 'tool-1' }), ask('c', { resume: 'next_message' }), ask('d')],
      settledInputRequestIds: ['d']
    }
    expect(openTopLevelAskIds(state)).toEqual(['a', 'c'])
  })

  it('refuses to start while a send error or an ask is open', () => {
    expect(minimalRefused(quiet)).toBe(false)
    expect(minimalRefused({ ...quiet, sendError: 'No provider' })).toBe(true)
    expect(minimalRefused({ ...quiet, inputRequests: [ask('a')] })).toBe(true)
    expect(minimalRefused({ ...quiet, inputRequests: [ask('a', { toolCallId: 't' })] })).toBe(false)
    expect(minimalRefused({ ...quiet, inputRequests: [ask('a')], settledInputRequestIds: ['a'] })).toBe(false)
  })

  it('restores on a send error', () => {
    expect(shouldRestoreMinimal(quiet, NONE)).toBe(false)
    expect(shouldRestoreMinimal({ ...quiet, sendError: 'Failed' }, NONE)).toBe(true)
  })

  it('restores on a new permission ask, agent question or A2A input request', () => {
    expect(shouldRestoreMinimal({ ...quiet, inputRequests: [ask('perm')] }, NONE)).toBe(true)
    expect(shouldRestoreMinimal({ ...quiet, inputRequests: [ask('a2a', { resume: 'next_message' })] }, NONE)).toBe(true)
  })

  it('does not restore for an ask open before minimal began, a nested ask or a settled one', () => {
    expect(shouldRestoreMinimal({ ...quiet, inputRequests: [ask('old')] }, { askIds: ['old'], handoffPending: false })).toBe(false)
    expect(shouldRestoreMinimal({ ...quiet, inputRequests: [ask('n', { toolCallId: 't' })] }, NONE)).toBe(false)
    expect(shouldRestoreMinimal({ ...quiet, inputRequests: [ask('s')], settledInputRequestIds: ['s'] }, NONE)).toBe(false)
    expect(shouldRestoreMinimal({ ...quiet, inputRequests: [ask('old'), ask('new')] }, { askIds: ['old'], handoffPending: false })).toBe(true)
  })
})

describe('key forwarding', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean }> = {}) =>
    ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods })

  it('forwards printable characters and Cmd/Ctrl+V', () => {
    expect(shouldForwardKey(key('a'))).toBe(true)
    expect(shouldForwardKey(key('A'))).toBe(true)
    expect(shouldForwardKey(key('?'))).toBe(true)
    expect(shouldForwardKey(key('å', { altKey: true }))).toBe(true)
    expect(shouldForwardKey(key('v', { metaKey: true }))).toBe(true)
    expect(shouldForwardKey(key('V', { ctrlKey: true }))).toBe(true)
  })

  it('leaves Cmd+C, other shortcuts, navigation keys, space and composition alone', () => {
    expect(shouldForwardKey(key('c', { metaKey: true }))).toBe(false)
    expect(shouldForwardKey(key('a', { metaKey: true }))).toBe(false)
    expect(shouldForwardKey(key('k', { ctrlKey: true }))).toBe(false)
    expect(shouldForwardKey(key('Enter'))).toBe(false)
    expect(shouldForwardKey(key('ArrowDown'))).toBe(false)
    expect(shouldForwardKey(key('Escape'))).toBe(false)
    expect(shouldForwardKey(key('Shift'))).toBe(false)
    expect(shouldForwardKey(key(' '))).toBe(false)
    expect(shouldForwardKey(key('a', { isComposing: true }))).toBe(false)
  })

  it('treats inputs, textareas, selects and contenteditable as editable', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editable.append(inner)
    const plain = document.createElement('div')
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(textarea)).toBe(true)
    expect(isEditableTarget(select)).toBe(true)
    expect(isEditableTarget(inner)).toBe(true)
    expect(isEditableTarget(plain)).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
