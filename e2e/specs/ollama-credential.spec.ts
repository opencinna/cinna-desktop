import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { OLLAMA_DEFAULT_HOST } from '../../src/shared/credentials'

/**
 * Ollama as a **keyless** AI credential: a host where every other credential
 * has a key.
 *
 * ## What this spec is for, and what it deliberately leaves to unit tests
 *
 * Three things about this feature can only break where the processes meet, and
 * they are the whole of what is asserted here:
 *
 * 1. **`baseUrl` survives the round trip.** It is the one per-credential detail
 *    that crosses to the renderer, and it *is* the credential — a keyless row
 *    with the wrong host is a credential pointing at nothing. `toDto` returning
 *    the column proves nothing about `ipcMain` → `contextBridge` → the card's
 *    Host field, which is where a renamed field silently deletes the feature.
 * 2. **Both renderer surfaces agree that a keyless credential is usable.** The
 *    predicate now lives in `shared/credentials`, but every screen still
 *    decides for itself whether to call it: `LocalAgentsSettingsSection` had
 *    `hasApiKey && !unsupported` written out by hand and so offered no Ollama
 *    at all, while the engine would have run agents on it perfectly well. Two
 *    renderer predicates disagreeing is invisible to every unit test, so the
 *    same credential is looked for on *both* pickers.
 * 3. **The offer row's mutation invalidates the detection cache.** Whether the
 *    offer is on screen is `running && !alreadyConfigured` and nothing else,
 *    and both terms come from a probe cached for fifteen seconds — so the row
 *    leaving after its own button is pressed *is* the cache assertion, and the
 *    Add form refusing a second credential for the same host a moment later is
 *    the same fact read through a second observer. Deleting the
 *    `['ollama-detection']` invalidation from `useUpsertProvider` fails this
 *    spec at that step (checked by mutation).
 *
 * Not here, on purpose: host normalisation (`shared/credentials.test.ts` has
 * the whole table and each E2E case costs a minute), the engine config shape
 * (`configGenerator.test.ts` is pure and better at it), the security guards on
 * `baseUrl` (`providerService.test.ts` — the UI cannot express the attack), and
 * any real model turn.
 *
 * ## Why only the "running" path
 *
 * `candidateHosts()` probes `OLLAMA_HOST` and then falls back to
 * `127.0.0.1:11434` **regardless** — deliberately, because a packaged macOS app
 * does not see the user's shell. A sandboxed `HOME` does not change loopback,
 * so "nothing is running" cannot be arranged: the fallback finds whatever real
 * Ollama the developer's machine has. The running path *can* be, because
 * `detect()` returns on the first candidate that answers — point `OLLAMA_HOST`
 * at the server below and the machine's own Ollama is never reached. The
 * not-running path is covered in both directions by
 * `src/main/services/ollamaService.test.ts` and belongs there.
 */

/** Ollama's own version string, as `/api/version` reports it. */
const OLLAMA_VERSION = '0.6.2'

/**
 * Real tags, not placeholders: `parameter_size` is what Work Complexity
 * classifies a local model by, and an id matching `embed` is dropped by the
 * adapter — so these are two ids that survive the filter and carry a size.
 * Listed here in the order `fetchOllamaTags` sorts them (alphabetical, which is
 * what `ollama list` prints).
 */
const MODELS = [
  { id: 'llama3.2:3b', family: 'llama', parameter_size: '3.2B' },
  { id: 'qwen3:8b', family: 'qwen3', parameter_size: '8.2B' }
] as const

/** The credential the offer row creates. Both the row's name and its type label. */
const OLLAMA = 'Ollama'

/**
 * An Ollama that is running, on a port this spec owns.
 *
 * Both endpoints, because `detect()` needs them both: `/api/version` decides
 * "running", and `/api/tags` is where the models come from — for the probe, and
 * again for `OllamaAdapter.listModels()` behind `provider:list-models`, which is
 * what fills the chat-mode Model picker.
 */
function fakeOllama(): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: OLLAMA_VERSION }))
      return
    }
    if (req.url === '/api/tags') {
      res.end(
        JSON.stringify({
          models: MODELS.map((model) => ({
            name: model.id,
            model: model.id,
            details: {
              family: model.family,
              parameter_size: model.parameter_size,
              quantization_level: 'Q4_K_M'
            }
          }))
        })
      )
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
}

let server: Server
/** The origin the fake answers on. Known only once it has bound a port. */
let host = ''

/**
 * Filled in `beforeAll` and read by the fixture at launch, which happens later.
 * Nothing goes into this process's `process.env`, so the variable cannot reach
 * the app any other spec in this worker launches.
 */
const OLLAMA_ENV: Record<string, string> = {}
test.use({ env: OLLAMA_ENV })

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  host = `http://127.0.0.1:${port}`
  // The port is never 11434, which is what makes the Host assertion below mean
  // something: the value in the field cannot be the default the card would show
  // for a row whose `baseUrl` never arrived.
  expect(host, 'the fake is not on the default port').not.toBe(OLLAMA_DEFAULT_HOST)
  OLLAMA_ENV.OLLAMA_HOST = host
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * Footer user menu → Settings → `tab`. The menu trigger is the profile's
 * generated display name.
 *
 * The menu item **toggles** (`activeView === 'settings' ? 'chat' : 'settings'`),
 * so pressing it again from inside Settings walks back out to the chat view —
 * where `Chats` is the sidebar tab rather than the Chat Modes settings tab, and
 * the next assertion fails somewhere unrelated. So the shell is opened only
 * when a settings-only sidebar item says it is not open already.
 */
async function openSettings(cinna: CinnaApp, tab: string): Promise<void> {
  const page = cinna.page
  const settingsOnly = page.getByRole('button', { name: 'MCP Providers', exact: true })
  if (!(await settingsOnly.isVisible())) {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(settingsOnly).toBeVisible()
  }
  await page.getByRole('button', { name: tab, exact: true }).click()
}

test('a detected Ollama is added in one click, keeps its host across the boundary, and is offered everywhere a credential is', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const page = cinna.page

  const offer = page.getByText('Ollama is running on this machine')

  await test.step('the credentials section offers the Ollama it found', async () => {
    await openSettings(cinna, 'AI Credentials')
    await expect(page.getByRole('heading', { name: 'AI Credentials' })).toBeVisible()
    await expect(offer).toBeVisible()
    // The count and the host, which is the probe's answer rather than the
    // default — the app is reading the environment it was launched with.
    await expect(page.getByText(`${MODELS.length} local models at ${host}`)).toBeVisible()
  })

  const cardHeader = page.getByText(OLLAMA, { exact: true })

  await test.step('Add Ollama makes the card, and takes the offer away', async () => {
    await page.getByRole('button', { name: 'Add Ollama' }).click()
    // Exactly one: the credential's name. The type label that sits beside it is
    // suppressed when it would only repeat the name, which for a credential the
    // picker named after its provider it always does.
    await expect(cardHeader).toHaveCount(1)
    // The offer is suppressed by the probe's `alreadyConfigured` alone, so this
    // is the detection cache being invalidated by the write, not a list check.
    await expect(offer).toHaveCount(0)
  })

  await test.step('the card shows a Host, not an API Key, and the host is the one that answered', async () => {
    // The header row is a div with an onClick, not a button; clicking the name
    // expands the card.
    await cardHeader.click()
    // By its label, which is also the only `Host` on screen while the Add form
    // is closed. The field is named rather than merely captioned (ux_rules rule
    // 10), so the spec can say what it is looking at.
    const hostField = page.getByLabel('Host', { exact: true })
    await expect(hostField).toBeVisible()
    // The assertion this spec exists for: `base_url` → `toDto` → `ipcMain` →
    // `contextBridge` → `provider.baseUrl` → this field.
    await expect(hostField).toHaveValue(host)
    // What the field would read instead if `baseUrl` never arrived: the card
    // falls back to the default host, and that default is also the placeholder.
    await expect(hostField).toHaveAttribute('placeholder', OLLAMA_DEFAULT_HOST)
    // A keyless credential has no key to save, replace or reveal.
    await expect(page.getByText('API Key')).toHaveCount(0)
  })

  await test.step('the Add form now refuses a second credential for the same host', async () => {
    // Straight after the add, and that timing is the point: the probe is cached
    // for 15 seconds, so an uninvalidated cache would still be answering
    // `alreadyConfigured: false` here and the form would happily make a second
    // row named Ollama for the same server.
    await page.getByRole('button', { name: 'Add AI Credentials' }).click()
    await page
      .getByRole('button', { name: 'Ollama Models running on this machine — no API key' })
      .click()
    await expect(page.getByText('This host already has a credential')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save Credentials' })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  await test.step('the chat-mode form offers it, with the models the server listed', async () => {
    await openSettings(cinna, 'Chats')
    await expect(page.getByRole('heading', { name: 'Chat Modes' })).toBeVisible()
    await page.getByRole('button', { name: 'Add Chat Mode' }).click()
    const form = modeForm(page)
    const credential = form.getByLabel('AI Credentials')
    await expect(credential.locator('option')).toHaveText(['None (use default)', OLLAMA])

    await credential.selectOption({ label: OLLAMA })
    const model = form.getByLabel('Model')
    // The tags verbatim, which is what the user typed into `ollama pull`, and
    // in the order `/api/tags` was read in.
    await expect(model.locator('option')).toHaveText([
      'First available',
      ...MODELS.map((entry) => entry.id)
    ])
  })

  await test.step('Local Agents offers it as the default credential for folder agents', async () => {
    await openSettings(cinna, 'Local Agents')
    const credential = page.getByLabel('Default AI credential')
    // The whole option list: a keyless credential is offered beside the "follow
    // my chats" default, and there is nothing else on this profile to confuse
    // it with. This is the picker that hand-wrote `hasApiKey` and left Ollama
    // out of a list the engine was willing to run agents from.
    await expect(credential.locator('option')).toHaveText(['Default chat mode', OLLAMA])
  })
})

/**
 * The New Chat Mode card: the innermost element holding both its title and its
 * submit button, which is the form's own root.
 */
function modeForm(page: CinnaApp['page']): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText('New Chat Mode', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Create Mode' }) })
    .last()
}
