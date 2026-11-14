import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { vaultOtherChatNotice } from './VaultOtherChatNotice'

/**
 * An old chat of an agent that has since moved into its vault (main's
 * `vault_other_chat`, per chat): the composer says why it cannot send there
 * and offers a new chat with the agent. Any other answer is not this row.
 */

const TEXT = 'This chat started before Alpha moved into its vault. Start a new chat to talk to it.'

describe('vaultOtherChatNotice', () => {
  it('says main’s sentence and starts a new chat with the agent', () => {
    const onStart = vi.fn()
    const notice = vaultOtherChatNotice({ state: 'vault_other_chat', reason: TEXT }, onStart, 'reason')!
    expect(notice.text).toBe(TEXT)
    expect(notice.textId).toBe('reason')
    render(createElement('div', null, notice.action))
    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('is no row for any other answer, or none', () => {
    expect(vaultOtherChatNotice({ state: 'vault_locked', reason: 'Vault locked.' }, vi.fn(), 'r')).toBeNull()
    expect(vaultOtherChatNotice(null, vi.fn(), 'r')).toBeNull()
    expect(vaultOtherChatNotice(undefined, vi.fn(), 'r')).toBeNull()
  })
})
