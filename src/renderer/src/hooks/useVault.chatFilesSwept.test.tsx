import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageAttachment } from '../../../shared/attachments'
import type { VaultChatFilesSweptEvent } from '../../../shared/vault/types'
import { composerDraftKey, EMPTY_COMPOSER_DRAFT, useComposerDraftStore } from '../stores/composerDraft.store'
import { useVaultWatch } from './useVault'

/**
 * A vault lock deletes its chats' not-yet-sent attachment copies (D23): the
 * drafts holding them drop those chips and say why, whether or not the chat's
 * composer is on screen, and keep the typed text.
 */

let swept: ((event: VaultChatFilesSweptEvent) => void) | null = null
let unsubscribed = 0

function file(id: string): MessageAttachment {
  return { id, filename: `${id}.txt`, size: 1, mimeType: 'text/plain', source: 'local' }
}

function seed(key: string, ids: string[], text = 'half a thought'): void {
  useComposerDraftStore.getState().update(key, () => ({
    text,
    files: { ...EMPTY_COMPOSER_DRAFT.files, attachments: ids.map(file) }
  }))
}

const draft = (key: string) => useComposerDraftStore.getState().drafts[key]!

beforeEach(() => {
  useComposerDraftStore.setState({ drafts: {} })
  swept = null
  unsubscribed = 0
  ;(window as unknown as { api: unknown }).api = {
    vault: {
      onState: () => () => {},
      onChatFilesSwept: (cb: (event: VaultChatFilesSweptEvent) => void) => {
        swept = cb
        return () => { unsubscribed++ }
      }
    }
  }
})
afterEach(() => cleanup())

function mountWatch(): () => void {
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useVaultWatch(), { wrapper }).unmount
}

describe('a lock sweeping draft attachments', () => {
  it('drops the swept chips from that chat\'s draft, says why, and keeps the text and the other chips', () => {
    const chatKey = composerDraftKey('user-1', 'chat:c1')
    const otherChat = composerDraftKey('user-1', 'chat:c2')
    seed(chatKey, ['a1', 'keep'])
    seed(otherChat, ['a1-elsewhere'])
    const unmount = mountWatch()
    act(() => swept!({ vaultId: 'v1', chats: [{ chatId: 'c1', attachmentIds: ['a1'] }] }))
    expect(draft(chatKey).files.attachments.map((a) => a.id)).toEqual(['keep'])
    expect(draft(chatKey).files.error).toBe('Vault locked: attach the file again')
    expect(draft(chatKey).text).toBe('half a thought')
    // Another chat's draft is untouched.
    expect(draft(otherChat).files.attachments.map((a) => a.id)).toEqual(['a1-elsewhere'])
    expect(draft(otherChat).files.error).toBeNull()
    unmount()
    expect(unsubscribed).toBe(1)
  })

  it('says "files … them" when several went, in every profile\'s draft of that chat', () => {
    const mine = composerDraftKey('user-1', 'chat:c1')
    const theirs = composerDraftKey(undefined, 'chat:c1')
    seed(mine, ['a1', 'a2'])
    seed(theirs, ['a3'])
    mountWatch()
    act(() => swept!({ vaultId: 'v1', chats: [{ chatId: 'c1', attachmentIds: ['a1', 'a2', 'a3'] }] }))
    expect(draft(mine).files.attachments).toEqual([])
    expect(draft(mine).files.error).toBe('Vault locked: attach the files again')
    expect(draft(theirs).files.error).toBe('Vault locked: attach the file again')
  })

  it('changes nothing in a draft that held none of the ids', () => {
    const key = composerDraftKey('user-1', 'chat:c1')
    seed(key, ['other'])
    useComposerDraftStore.getState().update(key, (d) => ({ files: { ...d.files, error: 'an earlier error' } }))
    const before = draft(key)
    mountWatch()
    act(() => swept!({ vaultId: 'v1', chats: [{ chatId: 'c1', attachmentIds: ['gone'] }] }))
    expect(draft(key)).toBe(before)
  })
})
