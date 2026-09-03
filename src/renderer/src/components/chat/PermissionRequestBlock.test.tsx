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
import {
  ALWAYS_GRANTS_ENABLED,
  type LocalPermissionRequest
} from '../../../../shared/localAgentRequests'

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

  it('withholds Always, because the cross-agent grant leak is proven', () => {
    // Observed against the real binary: replying `always` in folder A wrote
    // `{projectID: "global", action: "edit", resource: "*"}` — no directory, no
    // agent — into `~/.local/share/opencode/opencode.db`, a user-global store
    // shared with the user's own OpenCode. Folder B, never granted anything,
    // then wrote a file with no permission prompt at all. The engine's only
    // savable pattern is `["*"]`, so a user allowing "edit notes.txt" is
    // allowing "edit anything". Allow once and Deny both still work.
    //
    // This is a **gate, not a preference**, and it is not waiting on evidence:
    // the observation has been done and its result is that shipping Always
    // this way is wrong. The fix is to make the desktop authoritative and
    // reply `once` only (`once` persists nothing — verified). Delete this test
    // in the change that builds *that*, never to enable the current path.
    expect(ALWAYS_GRANTS_ENABLED).toBe(false)

    render(
      <PermissionRequestBlock
        request={request({ savable: ['bash:rm *'] })}
        requestId="per_1"
        interactive
        onAnswer={async () => {}}
      />
    )
    expect(screen.queryByText('Always for this agent')).toBeNull()
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

  it('sends the engine\'s own reply value, not a desktop synonym', async () => {
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
    expect(screen.queryByText('Allowed once')).toBeNull()
    expect(screen.getByText('Allow once')).toBeTruthy()
  })

  it('renders read-only with no buttons once the request is no longer pending', () => {
    render(
      <PermissionRequestBlock
        request={request()}
        interactive={false}
        onAnswer={async () => {}}
      />
    )
    // A persisted block re-rendered from history has no live request id. Offering
    // buttons there would post an answer to a request the engine has long since
    // resolved. Mutation: `const live = interactive && !!requestId && !answered`
    // → `const live = true` fails this.
    expect(screen.queryByText('Allow once')).toBeNull()
    expect(screen.getByText('Permission for bash')).toBeTruthy()
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | `ALWAYS_GRANTS_ENABLED` flipped to `true` | withholds Always until the shared-grant question is settled |
 * | Allow button sends `'allow'` | sends the engine's own reply value… |
 * | drop the `decision` prop | shows the recorded decision when replayed from history |
 * | Deny closes the block without calling `onAnswer` | maps Deny to reject rather than to a missing answer |
 * | `setAnswered(reply)` moved before/outside the `await` | does not claim the decision landed when delivery failed |
 * | `live` → `true` | renders read-only with no buttons… |
 */
