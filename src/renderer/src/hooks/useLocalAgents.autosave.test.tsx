import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  FileStamp,
  LocalAgentDto,
  LocalAgentOutcome,
  UpdateLocalAgentFieldInput
} from '../../../shared/localAgents'
import { useAgentFileEditor } from './useLocalAgents'

/**
 * The Phase 3 autosave race, as a regression test.
 *
 * The pure state machine in `utils/localAgents` is covered by its own suite;
 * what was never covered is the React glue in {@link useAgentFileEditor} —
 * debounce, in-flight guard, mutation, cache write — because there was no DOM
 * to render a hook into. This file is the first test in the `renderer` vitest
 * project (jsdom); see `vitest.config.ts`.
 *
 * The bug: a blur flushed a save while a debounce timer was still armed, and
 * that second request went out with the *same* stamp while the first was in
 * flight. The first landed and moved the file's stamp on; the second was then
 * refused as `manifest_modified`, and the user was told their file had changed
 * on disk — for a save that had just succeeded, with Reload (which discards
 * their text) the only way out.
 */

const AGENT_ID = 'folder:11111111-2222-3333-4444-555555555555'
const MANIFEST = 'cinna-agent.json'
const DEBOUNCE_MS = 700
/**
 * The hook's `BLOCKED_RETRY_MS`, which is module-private. Mirrored rather than
 * exported: if the real one grows, the retry will not have fired by the time
 * this test looks and the test fails loudly rather than passing on a guess.
 */
const BLOCKED_RETRY_MS = 3000

function stampOf(n: number): FileStamp {
  return { mtimeMs: 1_700_000_000_000 + n, size: 100 + n, hash: `hash-${n}` }
}

/**
 * A stand-in for main's `update-field` channel that refuses a stale stamp the
 * way the real one does.
 *
 * Two properties are load-bearing. Saves are **held** until the test releases
 * them, so a save can be in flight across a keystroke and a blur. And the
 * stamp check happens **when the save is processed**, not when it is called —
 * `manifestIo.writeIfUnchanged` re-reads the file at write time, so two
 * requests built from the same stamp are not both accepted just because they
 * were both sent before either landed. That ordering is the whole bug: without
 * it a duplicate save would look harmless here.
 */
function fakeMain(): {
  updateField: (input: UpdateLocalAgentFieldInput) => Promise<LocalAgentOutcome<LocalAgentDto>>
  calls: UpdateLocalAgentFieldInput[]
  refusals: number
  /** Answer the next `n` saves the way `turnLock` does while a turn is running. */
  blockNextSaves: (n: number) => void
  settleAll: () => void
} {
  const calls: UpdateLocalAgentFieldInput[] = []
  let blockNext = 0
  const held: { input: UpdateLocalAgentFieldInput; settle: () => void }[] = []
  let diskStamp = stampOf(1)
  let nextStamp = 2
  const api = {
    calls,
    refusals: 0,
    updateField(input: UpdateLocalAgentFieldInput): Promise<LocalAgentOutcome<LocalAgentDto>> {
      calls.push(input)
      return new Promise<LocalAgentOutcome<LocalAgentDto>>((resolve) => {
        held.push({
          input,
          settle: () => {
            if (blockNext > 0) {
              // Nothing written, so `diskStamp` does not move — the same stamp
              // is still good, which is why this one may be retried.
              blockNext -= 1
              resolve({
                ok: false,
                code: 'turn_in_progress',
                name: 'LocalAgentError',
                message: 'a turn holds the agent'
              })
              return
            }
            if (input.expectedStamp.hash !== diskStamp.hash) {
              api.refusals += 1
              resolve({
                ok: false,
                code: 'manifest_modified',
                name: 'KitError',
                message: 'cinna-agent.json changed on disk since it was read'
              })
              return
            }
            diskStamp = stampOf(nextStamp++)
            // Only the two fields this hook reads back. A wider fixture would
            // be inert here and would drift with the DTO.
            resolve({
              ok: true,
              value: { id: AGENT_ID, stamps: { [MANIFEST]: diskStamp } } as unknown as LocalAgentDto
            })
          }
        })
      })
    },
    blockNextSaves(n: number): void {
      blockNext = n
    },
    settleAll(): void {
      // FIFO — main applies writes in the order it received them.
      while (held.length > 0) held.shift()?.settle()
    }
  }
  return api
}

function installApi(main: ReturnType<typeof fakeMain>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { localAgents: { updateField: main.updateField } } as unknown as Window['api']
  })
}

function wrapper(): (props: { children: ReactNode }) => ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return ({ children }) => createElement(QueryClientProvider, { client }, children)
}

/** Let promise callbacks and React Query's zero-delay notifier run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(0)
    await Promise.resolve()
  })
}

function editor() {
  const snapshot = { text: 'one', stamp: stampOf(1) }
  return renderHook(
    () =>
      useAgentFileEditor({
        agentId: AGENT_ID,
        relPath: MANIFEST,
        snapshot,
        toUpdate: (text) => ({ field: 'description', value: text })
      }),
    { wrapper: wrapper() }
  )
}

describe('useAgentFileEditor — autosave race', () => {
  let main: ReturnType<typeof fakeMain>

  beforeEach(() => {
    vi.useFakeTimers()
    main = fakeMain()
    installApi(main)
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'api')
  })

  it('sends one save when a keystroke and a blur land on a save already in flight', async () => {
    const { result } = editor()

    // A save goes out and is held open — main has not answered yet.
    act(() => result.current.setText('one two'))
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })
    expect(main.calls).toHaveLength(1)

    // The user keeps typing (arming a fresh debounce) and then blurs.
    act(() => result.current.setText('one two three'))
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => result.current.flushNow())
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })

    // Still one request: the blur did not send a second one built from the
    // stamp the in-flight save is about to spend.
    expect(main.calls).toHaveLength(1)

    // Main answers. Nothing to refuse, so no reload prompt.
    act(() => main.settleAll())
    await settle()

    expect(main.calls).toHaveLength(1)
    expect(main.refusals).toBe(0)
    expect(result.current.conflict).toBeNull()
    expect(result.current.error).toBeNull()
    // The keystroke made during the flight is still there, unsaved.
    expect(result.current.text).toBe('one two three')
  })

  it('saves the text typed during the flight afterwards, with the stamp that save returned', async () => {
    const { result } = editor()

    act(() => result.current.setText('one two'))
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })
    act(() => result.current.setText('one two three'))
    act(() => result.current.flushNow())
    act(() => main.settleAll())
    await settle()

    // The held-back edit re-arms once the first save settles.
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })
    act(() => main.settleAll())
    await settle()

    expect(main.calls).toHaveLength(2)
    expect(main.calls[1].update).toEqual({ field: 'description', value: 'one two three' })
    // Not the stamp the first save was built from — that one is spent, and
    // reusing it is exactly what the refusal was reporting.
    expect(main.calls[1].expectedStamp.hash).toBe(stampOf(2).hash)
    expect(main.refusals).toBe(0)
    expect(result.current.conflict).toBeNull()
  })
})

/**
 * Guard 1 — the `clearTimeout` at the top of `persist` — is **not** what stops
 * the duplicate save. The two tests above still pass with that block deleted:
 * the armed timer either fires while the save is in flight (guard 2 turns it
 * away) or is torn down by the debounce effect's cleanup, which runs on every
 * settle because `saveSucceeded`/`saveBlocked`/`saveRefused` each return a
 * fresh object. The one thing guard 1 holds on its own is the comment's other
 * claim — that a flush rejected by `validate` leaves nothing armed, so it "does
 * not spin". That is what this test pins, and it is all it pins.
 */
describe('useAgentFileEditor — a flush the validator rejects', () => {
  let main: ReturnType<typeof fakeMain>

  beforeEach(() => {
    vi.useFakeTimers()
    main = fakeMain()
    installApi(main)
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'api')
  })

  it('leaves no timer armed behind it', async () => {
    const validate = vi.fn((text: string) => (text.includes('!') ? 'no bangs' : null))
    const snapshot = { text: 'one', stamp: stampOf(1) }
    const { result } = renderHook(
      () =>
        useAgentFileEditor({
          agentId: AGENT_ID,
          relPath: MANIFEST,
          snapshot,
          toUpdate: (text) => ({ field: 'description', value: text }),
          validate
        }),
      { wrapper: wrapper() }
    )

    // A keystroke arms the debounce; the blur lands before it fires.
    act(() => result.current.setText('one!'))
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    act(() => result.current.flushNow())
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    // The superseded timer did not fire afterwards.
    expect(validate).toHaveBeenCalledTimes(1)
    // And nothing the validator refused was sent.
    expect(main.calls).toHaveLength(0)
    expect(result.current.error).toBe('no bangs')
  })
})

/**
 * The turn-lock backoff.
 *
 * `turnLock` refuses a write while the agent is streaming, and that refusal is
 * a "not yet", not a conflict: nothing was written, the stamp is still good,
 * and the same request will land once the run finishes. So the editor keeps the
 * text and re-arms. The contract that makes the re-arm happen is easy to break
 * by accident — `saveBlocked` must return a **fresh object even when `blocked`
 * is already true**, because the debounce effect keys off state identity, and a
 * returned `state` means React bails out of the render, the effect never
 * re-runs, and the user's text sits with no timer and no path back until they
 * happen to type another character. Nothing else in the app would notice.
 */
describe('useAgentFileEditor — a save the turn lock refuses', () => {
  let main: ReturnType<typeof fakeMain>

  beforeEach(() => {
    vi.useFakeTimers()
    main = fakeMain()
    installApi(main)
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'api')
  })

  it('keeps the text and re-arms after each refusal, including a second in a row', async () => {
    // Two refusals in a row. The second is the one that matters: it reaches
    // `saveBlocked` with `blocked` already true, which is the case where
    // returning `state` would be silently wrong.
    main.blockNextSaves(2)
    const { result } = editor()

    act(() => result.current.setText('one two'))
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })
    act(() => main.settleAll())
    await settle()

    // Not an error and not a conflict — the card says "waiting", not "reload".
    expect(main.calls).toHaveLength(1)
    expect(result.current.blocked).toBe(true)
    expect(result.current.text).toBe('one two')
    expect(result.current.conflict).toBeNull()
    expect(result.current.error).toBeNull()

    // It backs off rather than asking again at typing speed.
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })
    expect(main.calls).toHaveLength(1)

    // The user types nothing more: every retry has to come from the armed
    // backoff alone.
    await act(async () => {
      vi.advanceTimersByTime(BLOCKED_RETRY_MS - DEBOUNCE_MS)
    })
    expect(main.calls).toHaveLength(2)
    act(() => main.settleAll())
    await settle()

    // Still blocked, and still re-arming — this is the assertion that a
    // `saveBlocked` returning an unchanged `state` fails, because React would
    // bail out of the render and the effect would never run again.
    expect(result.current.blocked).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(BLOCKED_RETRY_MS)
    })
    expect(main.calls).toHaveLength(3)
    expect(main.calls[2].update).toEqual({ field: 'description', value: 'one two' })
    // Nothing was ever written, so the stamp the first attempt used is still good.
    expect(main.calls[2].expectedStamp.hash).toBe(stampOf(1).hash)

    // The lock clears and the same request lands.
    act(() => main.settleAll())
    await settle()

    expect(result.current.blocked).toBe(false)
    expect(result.current.conflict).toBeNull()
    expect(result.current.error).toBeNull()
    expect(main.refusals).toBe(0)
  })
})
