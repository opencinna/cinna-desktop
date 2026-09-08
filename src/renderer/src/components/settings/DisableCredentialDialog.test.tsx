import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { describeDependents, DisableCredentialDialog } from './DisableCredentialDialog'

/**
 * The confirm in front of a credential's off switch.
 *
 * Switching a credential off deletes nothing, so what earns the interruption is
 * that the *consequence lands somewhere else*: the engine stops being given the
 * credential, so folder agents resolved to it stop running and chat modes
 * pinned to it stop starting chats — on screens the user is not looking at. The
 * dialog's whole job is therefore to **name** those things, so the assertions
 * below are about the naming and its agreement, not about the layout.
 */

const props = (over: Partial<Parameters<typeof DisableCredentialDialog>[0]> = {}) => ({
  credentialName: 'Work Anthropic',
  chatModes: [] as string[],
  agents: [] as string[],
  pending: false,
  errorMessage: null as string | null,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  ...over
})

describe('DisableCredentialDialog', () => {
  it('names the credential and promises the recoverable half first', () => {
    render(<DisableCredentialDialog {...props({ chatModes: ['Research'] })} />)

    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy()
    // The heading names the credential; the body does not repeat it (rule 7).
    expect(screen.getByText(/Turning it back on/)).toBeTruthy()
    // "and nothing is re-pointed at another credential" is the load-bearing
    // half: silently running an agent on a different key is precisely what this
    // feature refuses to do, and a user who assumed otherwise would switch a
    // credential off expecting their agents to carry on somewhere else.
    expect(screen.getByText(/nothing is re-pointed at another credential/)).toBeTruthy()
  })

  it('is named by its visible heading, not by a hardcoded string', () => {
    // Rule 10. `aria-labelledby` makes it true by construction, and this fails
    // if it is ever swapped for a literal that drifts from the heading.
    render(<DisableCredentialDialog {...props({ agents: ['invoices'] })} />)
    expect(screen.getByRole('dialog', { name: 'Switch off Work Anthropic' })).toBeTruthy()
  })

  it('agrees noun and verb with a single dependent of each kind', () => {
    render(
      <DisableCredentialDialog {...props({ chatModes: ['Research'], agents: ['invoices'] })} />
    )
    // "Chat modes Research are marked inactive" is the failure this asserts
    // against — the shape that ships when only the noun branches.
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toMatch(/Chat mode Research is marked inactive and stops starting chats/)
    expect(text).toMatch(/Agent invoices has no credential to run on/)
  })

  it('agrees them with several, and lists the names rather than counting them', () => {
    render(
      <DisableCredentialDialog
        {...props({ chatModes: ['Research', 'Writing', 'Ops'], agents: ['invoices', 'triage'] })}
      />
    )
    // A count alone ("3 chat modes") is a number the user has to go and decode.
    // The names are the entire reason to interrupt them.
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toMatch(/Chat modes Research, Writing and Ops are marked inactive and stop starting chats/)
    expect(text).toMatch(/Agents invoices and triage have no credential to run on/)
  })

  it('says nothing about a kind that has no dependents', () => {
    render(<DisableCredentialDialog {...props({ agents: ['invoices'] })} />)
    expect(screen.queryByText(/Chat mode/)).toBeNull()
  })

  it('stays open on a refused write and shows the reason', () => {
    // Rule 6: a dialog closes on success only. The card owns the mutation, so
    // the failure arrives here as a prop rather than closing anything.
    render(<DisableCredentialDialog {...props({ errorMessage: 'The keychain refused.' })} />)
    expect(screen.getByRole('alert').textContent).toBe('The keychain refused.')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('is undismissable while the write runs, and says what it is doing', () => {
    // Rule 5. Escape would cancel nothing and only hide what is happening.
    const onCancel = vi.fn()
    render(<DisableCredentialDialog {...props({ agents: ['invoices'], pending: true, onCancel })} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Switching off…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true)
  })

  it('opens with focus on the recoverable choice, so Enter on arrival cancels', () => {
    const onCancel = vi.fn()
    render(<DisableCredentialDialog {...props({ agents: ['invoices'], onCancel })} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  describe('describeDependents — the same fact, counted, for the credential card', () => {
    it('agrees the verb with the total, not with either list', () => {
      // "1 chat mode and 1 agent is inactive" is the shape that ships when the
      // verb is agreed per-list. The card renders this straight into a
      // sentence, so the agreement has to be right here.
      expect(describeDependents(['a'], [])).toEqual({ subject: '1 chat mode', verb: 'is' })
      expect(describeDependents([], ['x'])).toEqual({ subject: '1 agent', verb: 'is' })
      expect(describeDependents(['a'], ['x'])).toEqual({
        subject: '1 chat mode and 1 agent',
        verb: 'are'
      })
      expect(describeDependents(['a', 'b'], [])).toEqual({ subject: '2 chat modes', verb: 'are' })
      expect(describeDependents(['a', 'b'], ['x'])).toEqual({
        subject: '2 chat modes and 1 agent',
        verb: 'are'
      })
    })

    it('names only the kinds that have any', () => {
      expect(describeDependents(['a'], []).subject).not.toMatch(/agent/)
      expect(describeDependents([], ['x']).subject).not.toMatch(/chat mode/)
    })
  })
})
