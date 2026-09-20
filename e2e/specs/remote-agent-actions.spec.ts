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
              example_prompts: [],
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
