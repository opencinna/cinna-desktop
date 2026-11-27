import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'

/**
 * The ⋯ menu on a **Cinna-hosted** agent's page
 * (`ExternalAgentActionsMenu.tsx`).
 *
 * ## The rule being pinned
 *
 * An agent that lives on a Cinna server is the server's to delete. The desktop
 * keeps only the decision that is actually the desktop's — whether this machine
 * shows the agent at all — so the menu is exactly **Open on the server**, then
 * **Disable in Desktop App**, and nothing destructive. The regression this
 * guards is the menu that used to offer both `Delete agent…` and
 * `Uninstall agent…`, the second of them even for an agent the user created on
 * the server themselves (cinna-server stamps a non-null `bundle_id` on every
 * remote agent, so "has a bundle" never meant "is somebody's catalog install").
 *
 * The other half of the same rule is asserted in the same profile: a hand-added
 * A2A connection — a row this app really does own — still offers `Delete
 * agent…` and no `Open on the server`. Because that profile *is* linked to a
 * Cinna server, the absent link proves the menu branches on `source ===
 * 'remote'`, not merely on the presence of a server URL.
 *
 * ## What is real, and what is seeded
 *
 * There is no live Cinna server offline, so the spec stands one up on loopback:
 * a single route, `GET /api/v1/external/agents`, answering with one
 * `target_type: 'agent'` target whose `target_id` is a real UUID (`UUID_RE` in
 * `agentService.syncRemoteAgents` drops anything else) and whose metadata
 * carries the `bundle_id` a server-created agent really has. The profile is
 * linked to it with `linkSandboxAccount` (`jobRemoteService.ts`), and the row
 * itself is written by the **product's own sync** — `window.api.agents
 * .syncRemote()` → `agentService.syncRemoteAgents` → `agentRepo.syncRemote` —
 * so `source`, `remoteTargetType` and `remoteTargetId` are the app's values,
 * not the test's.
 *
 * ## How the external open is observed
 *
 * The app opens links through `system.openExternal` → `app:open-external` →
 * `shell.openExternal` in main. Playwright cannot watch a real browser, so
 * `shell.openExternal` is replaced in the main process and records its
 * argument — the same technique `cinna-integration.spec.ts` uses for the OAuth
 * authorization URL, and it works for the same reason: `app.ipc.ts` holds the
 * `electron` module object, not the function, so the call site sees the
 * replacement. The assertion is therefore the URL the app **asks** the OS to
 * open, which is the whole of what the desktop decides here.
 *
 * ## What it does not prove
 *
 * That a browser actually opens, that the URL resolves to an agent page on a
 * real cinna-server, or anything about `Disable in Desktop App` beyond its
 * presence and its position (its effect is unit-tested in
 * `ExternalAgentActionsMenu.test.tsx`).
 */

const REMOTE_AGENT = 'Quarterly Reporter'
const A2A_AGENT = 'Ledger Endpoint'
const TARGET_ID = randomUUID()
/**
 * What sync turns into the page's Example prompts (`synthesizeRemoteSkills`):
 * each prompt becomes a row named by the prompt cut to 50 characters and
 * described by the whole prompt. The short one's name and description are
 * therefore equal, the long one's are not.
 */
const SHORT_PROMPT = 'Draft the Q3 summary'
const LONG_PROMPT = 'Compare this quarter’s revenue with the same quarter last year, by region'
const EXAMPLE_PROMPTS = [SHORT_PROMPT, LONG_PROMPT]

/** One route: the listing `syncRemoteAgents` reads. Everything else is a 404. */
async function remoteAgentsService(): Promise<{ host: string; server: Server; paths: string[] }> {
  let host = ''
  const paths: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    paths.push(`${req.method} ${url.pathname}`)
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && url.pathname === '/api/v1/external/agents') {
      res.end(
        JSON.stringify({
          targets: [
            {
              target_type: 'agent',
              target_id: TARGET_ID,
              name: REMOTE_AGENT,
              description: 'Writes the quarterly report on the Cinna server.',
              entrypoint_prompt: null,
              example_prompts: EXAMPLE_PROMPTS,
              session_mode: null,
              ui_color_preset: null,
              agent_card_url: `${host}/agents/${TARGET_ID}/.well-known/agent-card.json`,
              protocol_versions: ['0.3.0'],
              // What a server-created agent really carries: a bundle id with no
              // bundle uuid and no publisher install. The menu must still offer
              // nothing destructive.
              metadata: { bundle_id: 'com.acme.quarterly', bundle_uuid: null, is_publisher_install: false }
            }
          ]
        })
      )
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ detail: 'No fixture route for this request' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { host, server, paths }
}

async function restart(cinna: CinnaApp): Promise<void> {
  await cinna.relaunch()
  await cinna.skipOnboarding()
}

test('a Cinna-hosted agent offers its page on the server and nothing destructive', async ({ cinna }, testInfo) => {
  test.setTimeout(120_000)
  const fake = await remoteAgentsService()
  try {
    await cinna.skipOnboarding()

    await test.step('a hand-added A2A connection and a profile linked to the fixture server', async () => {
      const made = await cinna.page.evaluate(
        (input) =>
          window.api.agents.upsert({
            name: input.name,
            protocol: 'a2a',
            // A closed loopback port: this spec never sends the agent anything.
            cardUrl: 'http://127.0.0.1:1/.well-known/agent-card.json',
            endpointUrl: 'http://127.0.0.1:1/a2a'
          }),
        { name: A2A_AGENT }
      )
      expect(made).toMatchObject({ success: true })
      await linkSandboxAccount(cinna, fake.host)
    })

    await test.step('the product’s own sync writes the remote row', async () => {
      await restart(cinna)
      const synced = await cinna.page.evaluate(() => window.api.agents.syncRemote())
      expect(synced).toMatchObject({ success: true, synced: 1, removed: 0 })
      const agents = await cinna.page.evaluate(() => window.api.agents.list())
      expect(agents.find((agent) => agent.name === REMOTE_AGENT)).toMatchObject({
        source: 'remote',
        enabled: true,
        remoteTargetType: 'agent',
        remoteTargetId: TARGET_ID
      })
      expect(agents.find((agent) => agent.name === A2A_AGENT)).toMatchObject({ source: 'local' })
      // The renderer reads `cinnaServerUrl` from the profile it loaded at
      // startup, and the agents query is refreshed by the sync broadcast — a
      // restart makes both unambiguous before anything is clicked.
      await restart(cinna)
    })

    await test.step('the browser is asked, not opened', async () => {
      await cinna.electronApp.evaluate(({ shell }) => {
        const globals = globalThis as unknown as { __openedUrl?: string }
        globals.__openedUrl = undefined
        shell.openExternal = async (url: string): Promise<void> => {
          globals.__openedUrl = url
        }
      })
    })

    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()

    await test.step('the menu is Open on the server, then Disable in Desktop App — and nothing else', async () => {
      await page.getByRole('button', { name: REMOTE_AGENT, exact: true }).click()
      await expect(page.getByRole('heading', { name: REMOTE_AGENT, level: 1 })).toBeVisible()
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const menu = page.getByRole('menu', { name: 'Agent actions', exact: true })
      await expect(menu.getByRole('menuitem')).toHaveText(['Open on the server', 'Disable in Desktop App'])
      await expect(menu.getByRole('menuitem', { name: 'Delete agent…' })).toHaveCount(0)
      await expect(menu.getByRole('menuitem', { name: /Uninstall/ })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('remote-agent-actions.png') })
    })

    await test.step('Open on the server asks the OS for this agent’s page', async () => {
      const menu = page.getByRole('menu', { name: 'Agent actions', exact: true })
      await menu.getByRole('menuitem', { name: 'Open on the server' }).click()
      await expect
        .poll(
          () =>
            cinna.electronApp.evaluate(
              () => (globalThis as unknown as { __openedUrl?: string }).__openedUrl ?? ''
            ),
          { timeout: 10_000, message: 'the app never asked to open the agent’s page' }
        )
        .toBe(`${fake.host}/agent/${TARGET_ID}`)
      await expect(menu).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      // Nothing was destroyed, and the agent is still shown on this machine.
      const agents = await page.evaluate(() => window.api.agents.list())
      expect(agents.find((agent) => agent.name === REMOTE_AGENT)).toMatchObject({
        source: 'remote',
        enabled: true
      })
    })

    await test.step('a hand-added A2A connection, in the same linked profile, is still the desktop’s to delete', async () => {
      await page.getByRole('button', { name: A2A_AGENT, exact: true }).click()
      await expect(page.getByRole('heading', { name: A2A_AGENT, level: 1 })).toBeVisible()
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const menu = page.getByRole('menu', { name: 'Agent actions', exact: true })
      await expect(menu.getByRole('menuitem')).toHaveText(['Delete agent…'])
      await expect(menu.getByRole('menuitem', { name: 'Open on the server' })).toHaveCount(0)
    })

    expect(fake.paths).toContain('GET /api/v1/external/agents')
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})

/**
 * **Develop** on an agent the profile owns, and the Overview's Example prompts.
 *
 * Develop is offered only while local development is `ready`, which offline is
 * out of reach: `localDevService.reconcile` downloads uv, Mutagen and the
 * server-pinned cinna-cli and runs `cinna account setup` against a real core
 * (`cinna-integration.spec.ts` is the spec that does). So, once main's own
 * reconcile has settled on what the fixture server really gives it (not
 * ready), the spec pins the three things the renderer reads —
 * `localdev:get-state` and every `localdev:state` push → `ready`, and
 * `localdev:session-context` → a context with no blocker — and reloads. Everything from there is the product: the
 * menu's `canDevelopAgent` gate, the navigation, the draft and the composer's
 * focus effect. Not proven: that main reaches `ready` for this account, or what
 * pressing Start building does with the message.
 */
test('Develop sits in the ⋯ menu of an owned agent and opens Agents Development with a prefilled, focused message', async ({ cinna }, testInfo) => {
  test.setTimeout(120_000)
  const fake = await remoteAgentsService()
  try {
    await cinna.skipOnboarding()
    await linkSandboxAccount(cinna, fake.host)
    await restart(cinna)
    expect(await cinna.page.evaluate(() => window.api.agents.syncRemote())).toMatchObject({ success: true, synced: 1 })
    await restart(cinna)
    const agentId = `remote:agent:${TARGET_ID}`

    await test.step('Settings → Overview: Example prompts, one line for a prompt whose description is its name', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: REMOTE_AGENT, exact: true }).click()
      await expect(page.getByRole('heading', { name: REMOTE_AGENT, level: 1 })).toBeVisible()
      // Not ready yet: the menu has no Develop, and the header never has one.
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      await expect(page.getByRole('menu', { name: 'Agent actions', exact: true }).getByRole('menuitem'))
        .toHaveText(['Open on the server', 'Disable in Desktop App'])
      // The menu does not close on Escape; its own button toggles it.
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      await expect(page.getByRole('menu', { name: 'Agent actions', exact: true })).toHaveCount(0)

      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toHaveCount(0)
      const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Example prompts', exact: true, level: 2 }) })
      await expect(section.getByRole('heading', { level: 3 })).toHaveText([SHORT_PROMPT, `${LONG_PROMPT.slice(0, 47)}...`])
      const shortRow = section.locator('div').filter({ has: page.getByRole('heading', { name: SHORT_PROMPT, exact: true, level: 3 }) }).last()
      await expect(shortRow.locator('p')).toHaveCount(0)
      const longRow = section.locator('div').filter({ has: page.getByRole('heading', { name: `${LONG_PROMPT.slice(0, 47)}...`, exact: true, level: 3 }) }).last()
      await expect(longRow.locator('p')).toHaveText([LONG_PROMPT])
      await page.screenshot({ path: testInfo.outputPath('example-prompts.png') })
    })

    await test.step('main’s own reconcile settles, then the renderer is told local development is ready', async () => {
      await expect
        .poll(() => cinna.page.evaluate(() => window.api.localDev.getState().then((state) => state.phase)), { timeout: 30_000 })
        .not.toMatch(/^(idle|installing)$/)
      const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
      await cinna.electronApp.evaluate(({ BrowserWindow, ipcMain }, input) => {
        const ready = { phase: 'ready', workspacePath: input.workspace, cliVersion: '0.0.0-e2e', cinnaBinPath: '/nonexistent/cinna', protocol: 'json' }
        const context = {
          profileId: input.profileId, serverUrl: input.host, accountName: 'e2e', workspacePath: input.workspace, cliVersion: '0.0.0-e2e',
          runtime: { source: 'default', launcher: 'opencode', credentialRef: null, credentialId: null, credentialName: null, credentialType: null, modelId: null, modelSource: 'default', replacedModelId: null, reason: null },
          complexity: 'complex', documents: [], instructions: '', blocker: null
        }
        ipcMain.removeHandler('localdev:get-state')
        ipcMain.handle('localdev:get-state', () => ready)
        ipcMain.removeHandler('localdev:session-context')
        ipcMain.handle('localdev:session-context', () => context)
        // The renderer's reload makes main reconcile again, and that run pushes
        // its own (attention) state; every push this window gets says ready.
        for (const window of BrowserWindow.getAllWindows()) {
          const send = window.webContents.send.bind(window.webContents)
          window.webContents.send = (channel: string, ...args: unknown[]): void => {
            send(channel, ...(channel === 'localdev:state' ? [ready] : args))
          }
        }
      }, { profileId: user!.id, host: fake.host, workspace: `${cinna.sandbox.home}/cinna-e2e-workspace` })
      await cinna.page.reload()
      await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
      await expect.poll(() => cinna.page.evaluate(() => window.api.localDev.getState().then((state) => state.phase))).toBe('ready')
    })

    await test.step('the header has no Develop; the ⋯ menu does, and it lands on a focused, prefilled composer', async () => {
      const page = cinna.page
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: REMOTE_AGENT, exact: true }).click()
      await expect(page.getByRole('heading', { name: REMOTE_AGENT, level: 1 })).toBeVisible()
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const menu = page.getByRole('menu', { name: 'Agent actions', exact: true })
      await expect(menu.getByRole('menuitem')).toHaveText(['Open on the server', 'Develop', 'Disable in Desktop App'])
      await expect(page.getByRole('button', { name: 'Develop', exact: true })).toHaveCount(0)
      await menu.getByRole('menuitem', { name: 'Develop', exact: true }).click()

      await expect(menu).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'What would you like to build?', level: 1 })).toBeVisible()
      await expect(page.getByText('Agents Development on ', { exact: false })).toBeVisible()
      const composer = page.getByRole('textbox', { name: 'Describe the agent you want to build', exact: true })
      const expected = `I have an agent ${REMOTE_AGENT} (id: ${TARGET_ID}), I would like to `
      await expect(composer).toHaveValue(expected)
      await expect(composer).toBeEnabled()
      await expect(composer).toBeFocused()
      expect(await composer.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd, input.value.length]))
        .toEqual([expected.length, expected.length, expected.length])
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('develop-composer.png') })
      // Nothing was created: Develop only navigates and prefills.
      const agents = await page.evaluate(() => window.api.agents.list())
      expect(agents.map((agent) => agent.id)).toEqual([agentId])
    })
  } finally {
    fake.server.closeAllConnections()
    await new Promise<void>((resolve) => fake.server.close(() => resolve()))
  }
})
