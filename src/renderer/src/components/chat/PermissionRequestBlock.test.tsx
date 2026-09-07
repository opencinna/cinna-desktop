/**
 * The permission block, rendered.
 *
 * This is the surface the phase's brief singled out as the one where a silent
 * failure means the user approves something the app then mishandles — so it is
 * tested by rendering and clicking, not by reading. Three of the four
 * behaviours below are invisible to a type-check and were never going to be
 * caught by the build: which button is offered, which reply value reaches the
 * IPC layer, and whether a failed delivery still tells the user it worked.
 *
 * Every mutation named in a comment was **run**; the table at the bottom
 * records the outcome of each.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PermissionRequestBlock } from './PermissionRequestBlock'
import type { LocalPermissionRequest } from '../../../../shared/localAgentRequests'

const request = (over: Partial<LocalPermissionRequest> = {}): LocalPermissionRequest => ({
  action: 'bash',
  resources: ['rm -rf build'],
  savable: ['bash:rm *'],
  ...over
})

describe('PermissionRequestBlock', () => {
  it('offers Allow once and Deny while the request is live', () => {
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={async () => {}}
      />
    )
    expect(screen.getByText('Allow once')).toBeTruthy()
    expect(screen.getByText('Deny')).toBeTruthy()
    expect(screen.getByText('rm -rf build')).toBeTruthy()
  })

  it('offers Always allow even for an ask the engine calls unsavable', () => {
    // `savable` is OpenCode's `save[]` — what *its* store would keep, only ever
    // `["*"]`, for every agent on the machine. This button does not write
    // there: the runner records the grant in this agent's folder and replies
    // `once`. So an empty `savable` is not a reason to withhold the button, and
    // gating on it (as this component used to) would hide the one answer that
    // stops the same question being asked every turn.
    //
    // Mutation: restore `request.savable.length > 0 &&` on the button fails
    // this.
    render(
      <PermissionRequestBlock
        request={request({ savable: [] })}
        requestId="per_1"
        interactive
        onAnswer={async () => {}}
      />
    )
    expect(screen.getByText('Always allow')).toBeTruthy()
  })

  it('names the scope Always allow would remember, below the buttons', () => {
    // The button has to say what it grants, because a grant is wider than the
    // ask exactly once: a URL becomes its origin. The line sits *below* the
    // buttons — a line above them would move the control the user is reaching
    // for as it renders (ux_rules §1).
    //
    // Mutation: pass `request.resources` instead of `permissionGrantPatterns`
    // fails this — the text would promise the exact URL while the main process
    // stored the origin.
    render(
      <PermissionRequestBlock
        request={request({ action: 'webfetch', resources: ['https://docs.example.com/a?v=2'] })}
        requestId="per_1"
        interactive
        onAnswer={async () => {}}
      />
    )
    expect(
      screen.getByText(/remembers https:\/\/docs\.example\.com\/\* for this agent only/)
    ).toBeTruthy()
  })

  it('does not claim a rule was remembered when the store refused it', async () => {
    // Main writes the grant while the user waits and reports whether it landed.
    // A folder that has gone read-only still gets the action it was allowed —
    // the user said yes — but the block must not tell them a rule exists.
    //
    // Mutation: render "Allowed, and remembered for this agent" whenever the
    // reply was `always` fails this.
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={async () => ({ remembered: false })}
      />
    )
    fireEvent.click(screen.getByText('Always allow'))
    expect(await screen.findByText('Allowed once — the rule could not be saved.')).toBeTruthy()
  })

  it('says the rule was remembered when main says it was stored', async () => {
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={async () => ({ remembered: true })}
      />
    )
    fireEvent.click(screen.getByText('Always allow'))
    expect(await screen.findByText('Allowed, and remembered for this agent.')).toBeTruthy()
  })

  it('names a blanket grant in words when the ask names no resource', () => {
    // `external_directory` with no resources is the one ask whose *Always
    // allow* stores a `*` grant. It has to read as broad, and not in the
    // engine's vocabulary. Mutation: interpolate the raw action fails this.
    render(
      <PermissionRequestBlock
        request={request({ action: 'external_directory', resources: [] })}
        requestId="per_1"
        interactive
        onAnswer={async () => {}}
      />
    )
    expect(
      screen.getByText(/remembers any request to use a folder outside its own for this agent only/)
    ).toBeTruthy()
  })

  it('does not restate the resource it is sitting under', () => {
    // For a path or a command the grant pattern *is* the resource listed above,
    // so the line was a prose copy of the mono line two rows up, unquoted and
    // with no way to see where the pattern ended (ux_rules §7). Mutation:
    // render the line unconditionally fails this.
    render(
      <PermissionRequestBlock
        request={request({ action: 'bash', resources: ['git push --force origin main'] })}
        requestId="per_1"
        interactive
        onAnswer={async () => {}}
      />
    )
    expect(screen.queryByText(/Always allow remembers/)).toBeNull()
  })

  it('names which answer is in flight, in the button that was pressed', async () => {
    // Three buttons dropping to 50% opacity together says an answer is going
    // out and nothing about *which* — on the one widget in the app where that
    // is a permission decision (ux_rules §1). Mutation: a single `busy` boolean
    // fails this.
    let release = (): void => {}
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={() => new Promise<void>((resolve) => (release = resolve))}
      />
    )
    fireEvent.click(screen.getByText('Always allow'))
    expect(await screen.findByText('Remembering…')).toBeTruthy()
    expect(screen.getByText('Allow once')).toBeTruthy()
    expect(screen.getByText('Deny')).toBeTruthy()
    release()
  })

  it('sends always as the reply, and leaves the conversion to main', () => {
    // The renderer does not know about the grant store and must not: it sends
    // OpenCode's own enum value, and the runner is where `always` becomes a
    // stored rule plus a `once` reply. Mutation: send `'once'` from this button
    // fails this, and *Always allow* would silently mean *Allow once*.
    const answers: string[] = []
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={async (_id, reply) => void answers.push(reply)}
      />
    )
    fireEvent.click(screen.getByText('Always allow'))
    return waitFor(() => expect(answers).toEqual(['always']))
  })

  it('shows the recorded decision when replayed from history', () => {
    // The persisted transcript has to say what was decided. A permission prompt
    // re-rendered with no record of the answer is an approval nobody can later
    // account for, which is the worst shape this particular widget can take.
    //
    // The text comes from the `tool_result` the runner emits on settle, paired
    // to the ask on `cinna.tool_id`. Mutation: drop `decision` from the props
    // (falling back to local `answered` state, which is empty on a reload)
    // fails this.
    render(
      <PermissionRequestBlock
        request={request()}
        interactive={false}
        decision="Allowed once."
        onAnswer={async () => {}}
      />
    )
    expect(screen.getByText('Allowed once.')).toBeTruthy()
    expect(screen.queryByText('Allow once')).toBeNull()
  })

  it("sends the engine's own reply value, not a desktop synonym", async () => {
    const onAnswer = vi.fn(async () => {})
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={onAnswer}
      />
    )

    fireEvent.click(screen.getByText('Allow once'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalled())

    // `once | always | reject` is OpenCode's `PermissionV2Reply` enum, and the
    // desktop must not invent a synonym for it. Mutation: the Allow button
    // passing `'allow'` (the word the button uses) fails this, and in
    // production would be a 400 the user reads as the agent hanging.
    expect(onAnswer).toHaveBeenCalledWith('per_1', 'once')
  })

  it('maps Deny to reject rather than to a missing answer', async () => {
    const onAnswer = vi.fn(async () => {})
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={onAnswer}
      />
    )
    fireEvent.click(screen.getByText('Deny'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('per_1', 'reject'))

    // Denying is an *answer*, not an abstention: the agent loop is parked and
    // stays parked until something is posted. Mutation: the Deny button
    // closing the block without calling `onAnswer` fails this, and would wedge
    // the session — the turn never goes idle and every later turn on that chat
    // queues behind it.
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it('does not claim the decision landed when delivery failed', async () => {
    const onAnswer = vi.fn(async () => {
      throw new Error('This request is no longer waiting for an answer.')
    })
    render(
      <PermissionRequestBlock
        request={request()}
        requestId="per_1"
        interactive
        onAnswer={onAnswer}
      />
    )
    fireEvent.click(screen.getByText('Allow once'))

    await waitFor(() =>
      expect(screen.getByText('This request is no longer waiting for an answer.')).toBeTruthy()
    )
    // The dangerous failure for this particular widget: telling the user their
    // choice was recorded when it was not. Mutation: `setAnswered(reply)`
    // moved outside the try (or before the await) fails this — "Allowed once"
    // appears next to an error saying it did not happen, and the buttons
    // disappear so the user cannot retry.
    expect(screen.queryByText('Allowed once.')).toBeNull()
    expect(screen.getByText('Allow once')).toBeTruthy()
  })

  it('renders read-only with no buttons once the request is no longer pending', () => {
    render(
      <PermissionRequestBlock request={request()} interactive={false} onAnswer={async () => {}} />
    )
    // A persisted block re-rendered from history has no live request id. Offering
    // buttons there would post an answer to a request the engine has long since
    // resolved. Mutation: `const live = interactive && !!requestId && !answered`
    // → `const live = true` fails this.
    expect(screen.queryByText('Allow once')).toBeNull()
    expect(screen.getByText('Permission to run a command')).toBeTruthy()
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | `savable.length > 0 &&` restored on the Always button | offers Always allow even for an ask the engine calls unsavable |
 * | Always button sends `'once'` | sends always as the reply, and leaves the conversion to main |
 * | scope line built from `resources` rather than the grant patterns | names the scope Always allow would remember… |
 * | Allow button sends `'allow'` | sends the engine's own reply value… |
 * | drop the `decision` prop | shows the recorded decision when replayed from history |
 * | Deny closes the block without calling `onAnswer` | maps Deny to reject rather than to a missing answer |
 * | `setAnswered(reply)` moved before/outside the `await` | does not claim the decision landed when delivery failed |
 * | `live` → `true` | renders read-only with no buttons… |
 */
