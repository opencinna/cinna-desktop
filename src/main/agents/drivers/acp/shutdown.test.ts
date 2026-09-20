import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one thing that must be wired for an ACP process not to outlive the app,
 * asserted the only way it can be: by reading the entry point.
 *
 * Every folder agent runs in a child of its own, in **its own process group**
 * (`acpConnection` spawns `detached` so the whole tree can be signalled). That
 * is what makes a leak unrecoverable: once the app is gone, nothing else on the
 * machine knows those groups exist. A quit with a live turn would leave an
 * `opencode acp` — or the Claude adapter and the ~260 MB `claude` under it —
 * running with nobody left to stop them.
 *
 * The pool's `shutdown()` is what prevents that, and it had **no caller at
 * all** when the driver first landed: the defect was invisible because nothing
 * fails, no test breaks, and the only symptom is a process list a user has to
 * think to look at. `src/main/index.ts` is Electron's own entry — it opens
 * windows and registers app events, so it has no unit test of its own and
 * cannot easily grow one.
 *
 * So this reads the file, like `ipc/registration.test.ts` reads the IPC
 * modules for the same class of bug: a registrar that exists and is never
 * called. Crude on purpose. The alternative is nothing.
 */
const mainEntry = join(dirname(fileURLToPath(import.meta.url)), '../../../index.ts')

describe('the ACP process pool at quit', () => {
  const source = readFileSync(mainEntry, 'utf8')
  /** Comments blanked, so a doc comment naming the call cannot satisfy this. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  const core = readFileSync(join(dirname(mainEntry), 'hub/core.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const shutdown = core.slice(core.indexOf('export async function shutdownHubCore'))

  it('is shut down from a quit handler in the main entry point', () => {
    expect(code).toContain('shutdownHubCore')
    expect(shutdown).toMatch(/acpProcessPool\.shutdown\(\)/)
    const quit = code.indexOf("app.on('will-quit'")
    expect(quit, "a 'will-quit' handler in src/main/index.ts").toBeGreaterThanOrEqual(0)
    expect(code.indexOf('shutdownHubCore()', quit)).toBeGreaterThan(quit)
  })

  it('does not await it, because Electron does not await the handler', () => {
    // `will-quit` handlers are not awaited by Electron, so an `await` here buys
    // nothing and risks the opposite: `shutdown` waits for every process to
    // exit, and `stopNow` → `dispose` has already reached `killTree`
    // synchronously by then. The kill is what matters; the wait is a courtesy.
    expect(code).toMatch(/void\s+shutdownHubCore\(\)/)
    expect(shutdown.indexOf('acpProcessPool.shutdown()')).toBeLessThan(shutdown.indexOf('await'))
  })

  it('is killed only after the turns it runs have saved what they streamed', () => {
    // A direct chat writes its rows when the turn returns, and a turn whose
    // process is killed never does. The flush has to be in the same handler
    // and ahead of the kill — anywhere after it, or after an await, and the
    // turn the user left parked on a question is gone from the transcript.
    const flush = shutdown.indexOf('a2aStreamingService.saveInFlight()')
    expect(flush, 'saveInFlight() inside shared shutdown').toBeGreaterThan(0)
    expect(flush).toBeLessThan(shutdown.indexOf('acpProcessPool.shutdown()'))
    expect(flush).toBeLessThan(shutdown.indexOf('await'))
  })
})
