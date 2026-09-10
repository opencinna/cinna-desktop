import { test, expect } from '../fixtures/app'
import type { RunEvent } from '../../src/shared/runEvents'

/**
 * Section A of `plans/manual-test-session2.md`: the IPC wire format.
 *
 * Eleven-plus unit fixtures encode the string Electron produces when an
 * `ipcMain.handle` handler throws. They were derived from source, never
 * observed, and they all pass together whether or not the derivation is right.
 * This is the one place the real string is read from a real process.
 */

test('A1 a raw error keeps the Electron prefix, channel and class name', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const message = await cinna.page.evaluate(() =>
    window.api.localAgents.rootRemove('does-not-exist').then(
      () => 'resolved',
      (err: Error) => err.message
    )
  )
  expect(message).toBe(
    "Error invoking remote method 'local-agent:root-remove': LocalAgentError: That agents folder is not registered."
  )
})

test('A1 the renderer receives a plain Error: no code, a one-line stack', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const shape = await cinna.page.evaluate(() =>
    window.api.localAgents.rootRemove('does-not-exist').then(
      () => null,
      (err: Error & { code?: unknown }) => ({
        name: err.name,
        code: err.code,
        stackLines: String(err.stack).split('\n').length
      })
    )
  )
  expect(shape).toEqual({ name: 'Error', code: undefined, stackLines: 1 })
})

test('A2 a fixed site shows a plain sentence with no channel or class name', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const { page } = cinna
  await page.evaluate(() =>
    window.api.jobs.create({ type: 'local', title: 'Editable', prompt: 'Do the thing.' })
  )
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await page.getByText('Editable', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit job' }).click()
  const title = page.getByRole('textbox').first()
  await title.fill('')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('Title is required')
  await expect(alert).not.toContainText('Error invoking remote method')
  await expect(alert).not.toContainText('JobError')
})

/**
 * The single stream guard: every turn's `MessagePort` carries one `RunEvent`
 * union, and `src/preload/index.ts` filters it with `isRunEvent` on both send
 * paths before the renderer sees anything.
 *
 * ## What is real and what is stubbed
 *
 * The **sender** is replaced: the channel's `ipcMain.on` listener is swapped for
 * one that posts a fixed wire onto the port the renderer handed over. That is
 * the only way to put an off-contract message on a real port — no product
 * sender produces one, which is exactly the point of the guard. Everything the
 * guard is made of is real: the `MessageChannel` built in preload, the
 * structured clone across the process boundary, the `contextBridge` clone into
 * the page, and `console.warn` in the preload world.
 *
 * ## What it proves
 *
 * - Every one of the eleven `RunEvent` types reaches `onEvent`, in order and
 *   deep-equal — including a nested `child` with its inner event intact.
 * - The guard reads the **discriminator only**: a `delta` with no `kind` or
 *   `text` still passes, as `isRunEvent`'s own comment says it must.
 * - Off-contract messages are dropped and each one is warned about: primitives,
 *   an array, a bare part with no envelope, the retired `tool_subevent`
 *   nesting, a non-string `type`, and `toString` — a key every object inherits,
 *   so a guard written with `in` instead of an own-property check lets it by.
 * - `llm.sendMessage` and `agents.sendMessage` behave identically.
 *
 * ## What it does not
 *
 * Whether the renderer's `useChatStream` does the right thing with an event is
 * `useChatStream.events.test.tsx`; this callback is the spec's own. Whether a
 * real sender posts on-contract events is the runners' golden tests and, for a
 * folder agent's asks end to end, `run-events.spec.ts`.
 */

const PRELOAD_DROP = '[preload] dropped off-contract run event'

const ON_CONTRACT: RunEvent[] = [
  { type: 'request-id', requestId: 'req_e2e' },
  { type: 'status', state: 'working', taskId: 'task_e2e' },
  { type: 'delta', kind: 'text', text: 'Hello' },
  { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'invoices' } },
  { type: 'tool_result', id: 'call_1', result: { rows: 2 } },
  { type: 'tool_error', id: 'call_2', error: 'nope' },
  {
    type: 'needs_input',
    requestId: 'per_e2e',
    request: { kind: 'permission', action: 'bash', resources: ['ls'] },
    resume: 'reply'
  },
  { type: 'input_resolved', requestId: 'per_e2e', resolution: { kind: 'permission', reply: 'once' } },
  {
    type: 'child',
    toolCallId: 'call_1',
    agentId: 'folder:e2e',
    event: { type: 'delta', kind: 'text', text: 'nested' }
  },
  // A recognised type with the wrong payload: passes, by design.
  { type: 'delta' } as unknown as RunEvent,
  { type: 'error', error: 'boom' },
  { type: 'done', stopReason: 'end_turn' }
]

const OFF_CONTRACT: unknown[] = [
  'done',
  null,
  42,
  { kind: 'text', text: 'a part posted without its envelope' },
  ['delta'],
  { type: 'tool_subevent', toolCallId: 'call_1', event: { type: 'delta', kind: 'text', text: 'x' } },
  { type: 'toString' },
  { type: 7 }
]

/** One dropped message ahead of each of the first eight events; `done` last. */
const WIRE: unknown[] = ON_CONTRACT.flatMap((event, i) =>
  i < OFF_CONTRACT.length ? [OFF_CONTRACT[i], event] : [event]
)

// `run.send` is the channel; the other two are the forwards it replaced, kept
// for one phase (see `src/main/ipc/run.ipc.ts`). All three carry the same
// vocabulary and the same preload guard, so all three are driven.
for (const path of [
  { api: 'run.send', channel: 'run:send' },
  { api: 'llm.sendMessage', channel: 'llm:send-message' },
  { api: 'agents.sendMessage', channel: 'agent:send-message' }
] as const) {
  test(`${path.api} delivers every RunEvent type and drops what is off contract`, async ({
    cinna
  }) => {
    await cinna.skipOnboarding()
    // The preload world's console reaches the page's console listener, with the
    // dropped payload as its second argument.
    const warnings: string[] = []
    cinna.page.on('console', (message) => {
      if (message.text().startsWith(PRELOAD_DROP)) warnings.push(message.text())
    })

    await cinna.electronApp.evaluate(
      ({ ipcMain }, { channel, wire }) => {
        ipcMain.removeAllListeners(channel)
        ipcMain.on(channel, (event) => {
          const port = event.ports[0]
          port.start()
          for (const message of wire) port.postMessage(message)
        })
      },
      { channel: path.channel, wire: WIRE }
    )

    const delivered = await cinna.page.evaluate(
      (channel) =>
        new Promise<unknown[]>((resolve, reject) => {
          const got: unknown[] = []
          // A hang guard, not a wait: `done` is the last thing on the wire, so a
          // guard that dropped it would otherwise hold the test to its timeout
          // with nothing said about why.
          const guard = setTimeout(
            () => reject(new Error(`no done arrived; ${got.length} events delivered`)),
            10_000
          )
          const onEvent = (event: RunEvent): void => {
            got.push(event)
            if (event.type === 'done') {
              clearTimeout(guard)
              resolve(got)
            }
          }
          if (channel === 'run:send') window.api.run.send('e2e-chat', 'hello', onEvent)
          else if (channel === 'llm:send-message')
            window.api.llm.sendMessage('e2e-chat', 'hello', onEvent)
          else window.api.agents.sendMessage('folder:e2e', 'e2e-chat', 'hello', onEvent)
        }),
      path.channel
    )

    expect(delivered).toEqual(ON_CONTRACT)
    await expect.poll(() => warnings.length).toBe(OFF_CONTRACT.length)
    expect(warnings.some((line) => line.includes('tool_subevent'))).toBe(true)
    expect(warnings.some((line) => line.includes('toString'))).toBe(true)
  })
}
