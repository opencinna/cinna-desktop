import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * "Open credentials/.env": the file itself, not its folder, from the header's
 * Open-in menu and from the Folder tab — and only for a kit agent.
 *
 * Main's `openCredentials` seeds the file (0600, declared names commented out),
 * then tries `shell.openPath`, then on macOS `open -t`, then falls back to
 * `shell.showItemInFolder` and reports `revealed: true`, which the page turns
 * into a muted note. The fallback is the one outcome a user cannot tell from a
 * failure, so it is the path this spec forces — deterministically:
 *
 * - `shell.openPath` is replaced in the app process to resolve to an error
 *   string (what Electron answers where nothing is registered for `.env`).
 * - `open -t` is `execFile('open', …)` with main's own `process.env`, so a
 *   failing `open` shim prepended to that `PATH` makes the step reject; the
 *   shim logs its argv, which is the witness that main really tried it.
 * - `shell.showItemInFolder` is recorded instead of opening Finder.
 *
 * The success path (`openPath` resolving to `''`) is used for the Folder tab,
 * where the assertion is that the same IPC is reached with the `.env` path and
 * that a plain success writes no line anywhere.
 *
 * Every stub lives in the app process, so all are installed after the last
 * `relaunch()`. The `.env` written is the sandbox agent's own; nothing outside
 * the sandbox is touched.
 */

const AGENT = 'Ledger Sync'
const ENV_ITEM = 'Open credentials/.env'
const ENV_TITLE = "Open credentials/.env in your text editor, creating it if it isn't there yet"
const REVEAL_NOTE = 'Nothing here opens .env, so credentials/.env was shown in the file manager.'
const COPY_ITEM = 'Copy prompt for another tool'

interface ShellCalls {
  opened: string[]
  revealed: string[]
}

/**
 * Record `shell.openPath` and `shell.showItemInFolder` instead of asking the
 * OS. `openPath` resolves to `answer`: Electron's contract is an empty string
 * on success and a human-readable reason otherwise.
 */
async function stubShell(cinna: CinnaApp, answer: string): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }, openPathAnswer) => {
    const store = globalThis as unknown as { __e2eShell: ShellCalls }
    store.__e2eShell = { opened: [], revealed: [] }
    shell.openPath = (async (path: string): Promise<string> => {
      store.__e2eShell.opened.push(path)
      return openPathAnswer
    }) as typeof shell.openPath
    shell.showItemInFolder = (path: string): void => {
      store.__e2eShell.revealed.push(path)
    }
  }, answer)
}

function shellCalls(cinna: CinnaApp): Promise<ShellCalls> {
  return cinna.electronApp.evaluate(
    () => (globalThis as unknown as { __e2eShell: ShellCalls }).__e2eShell
  )
}

/**
 * Put an `open` that always fails first on main's `PATH`, so the macOS
 * `open -t` step rejects without an editor ever appearing. Its argv is
 * appended to `open.log` beside it.
 */
async function installFailingOpen(cinna: CinnaApp): Promise<string> {
  const dir = homeDir(cinna, 'open-shim')
  const log = join(dir, 'open.log')
  writeFileSync(
    join(dir, 'open'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 1\n`
  )
  chmodSync(join(dir, 'open'), 0o755)
  await cinna.electronApp.evaluate((_electron, shimDir) => {
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
  }, dir)
  return log
}

/** The Open-in trigger: the split button's chevron with a default tool, the whole button without. */
function openInTrigger(cinna: CinnaApp) {
  const page = cinna.page
  return page
    .getByRole('button', { name: 'More ways to open this folder' })
    .or(page.getByRole('button', { name: 'Open in…' }))
}

/** The fixed-height line under the page header: `alert` when red, `status` otherwise. */
function headerLine(cinna: CinnaApp) {
  const page = cinna.page
  return page
    .locator('header')
    .filter({ has: page.getByRole('heading', { level: 1 }) })
    .locator('xpath=following-sibling::div[1]')
}

test('Open credentials/.env seeds the file, falls back to the file manager, and the Folder tab reaches the same call', async ({
  cinna
}) => {
  test.setTimeout(90_000)
  await cinna.skipOnboarding()

  let agentId = ''
  let folder = ''
  await test.step('a kit agent declaring one credential slot', async () => {
    const root = await addAgentRoot(cinna)
    const created = await createFolderAgent(cinna, root, AGENT, AGENT)
    agentId = created.id
    folder = created.path
    // The scaffold declares no credentials, and a seed for none says only
    // "declares no credentials yet". Two expected names make the seed's
    // promise — declared names, commented out — something the file can prove.
    const manifestPath = join(folder, 'cinna-agent.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.credentials = [
      {
        name: 'Vendor portal',
        type: 'api_token',
        env_prefix: 'VENDOR_PORTAL_',
        fields: ['token', 'account_id']
      }
    ]
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    expect(existsSync(join(folder, 'credentials', '.env'))).toBe(false)
  })

  await cinna.relaunch()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const got = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agentId)
  expect(got.ok, 'the re-indexed agent is readable').toBe(true)
  if (!got.ok) return
  expect(got.value.credentials.map((slot) => slot.expectedKeys)).toEqual([
    ['VENDOR_PORTAL_TOKEN', 'VENDOR_PORTAL_ACCOUNT_ID']
  ])

  const envPath = join(folder, 'credentials', '.env')
  const openLog = await installFailingOpen(cinna)
  await stubShell(cinna, 'No application knows how to open this file.')

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Agent details' })).toBeVisible()

  const menu = page.getByRole('menu', { name: 'Open this folder in' })

  await test.step('the item sits between Reveal folder and Copy prompt', async () => {
    await openInTrigger(cinna).click()
    await expect(menu.getByRole('menuitem', { name: ENV_ITEM })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: ENV_ITEM })).toHaveAttribute('title', ENV_TITLE)
    // The tool items above vary by machine; the position is relative.
    const items = await menu.getByRole('menuitem').allTextContents()
    const at = items.indexOf(ENV_ITEM)
    expect(items[at - 1], `items were ${JSON.stringify(items)}`).toBe('Reveal folder')
    expect(items[at + 1], `items were ${JSON.stringify(items)}`).toBe(COPY_ITEM)
  })

  await test.step('the click closes the menu and creates the file', async () => {
    await menu.getByRole('menuitem', { name: ENV_ITEM }).click()
    await expect(menu).toBeHidden()
    await expect.poll(() => existsSync(envPath), 'credentials/.env is created').toBe(true)
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(envPath, 'utf8')).toBe(
      [
        `# Credentials for ${AGENT}.`,
        '#',
        '# This file stays on this machine. Cinna reads which variable names are set',
        '# here and never their values.',
        '#',
        '# Fill a value in and remove the leading "#" from its line.',
        '',
        '# VENDOR_PORTAL_TOKEN=',
        '# VENDOR_PORTAL_ACCOUNT_ID=',
        ''
      ].join('\n')
    )
  })

  await test.step('with nothing to open it, the file is revealed and the header says so', async () => {
    const line = headerLine(cinna)
    await expect(line).toHaveText(REVEAL_NOTE)
    await expect(line).toHaveAttribute('role', 'status')
    await expect(line).toHaveAttribute('title', REVEAL_NOTE)
    await expect(page.getByRole('alert')).toHaveCount(0)

    const calls = await shellCalls(cinna)
    expect(calls.opened).toEqual([envPath])
    expect(calls.revealed).toEqual([envPath])
    if (process.platform === 'darwin') {
      // The middle step really ran: main asked `open -t <file>` and was refused.
      expect(readFileSync(openLog, 'utf8')).toBe(`-t\n${envPath}\n`)
    }
  })

  await test.step('Folder tab: both links carry the tooltip and reach the same call', async () => {
    await page.getByRole('tab', { name: /^Folder/ }).click()
    const credentials = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: 'Credentials', exact: true }) })
    const files = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: 'Files', exact: true }) })
    await expect(credentials).toBeVisible()
    await expect(credentials).toContainText('VENDOR_PORTAL_TOKEN')
    const headerLink = credentials.getByRole('button', { name: 'credentials/.env', exact: true })
    const fileRow = files.getByRole('button', { name: 'credentials/.env', exact: true })
    await expect(headerLink).toHaveAttribute('title', ENV_TITLE)
    await expect(fileRow).toHaveAttribute('title', ENV_TITLE)

    // Now the OS opens it: the same IPC with the file's path, no reveal, and a
    // plain success writes no line under either card.
    await stubShell(cinna, '')
    await headerLink.click()
    await expect.poll(() => shellCalls(cinna).then((c) => c.opened)).toEqual([envPath])
    expect((await shellCalls(cinna)).revealed).toEqual([])
    await expect(headerLink).toBeEnabled()
    await expect(credentials.getByRole('status')).toHaveCount(0)
    await expect(credentials.getByRole('alert')).toHaveCount(0)
    await expect(files.getByRole('status')).toHaveCount(0)
    await expect(files.getByRole('alert')).toHaveCount(0)
    // The file was already there, so nothing was rewritten.
    expect(readFileSync(envPath, 'utf8')).toContain('# VENDOR_PORTAL_TOKEN=')
  })
})

/**
 * A bare agent — a folder adopted for its `AGENT.md` — has no manifest and so
 * no credential slots; the desktop never seeds a `.env` there, and the menu
 * must not offer to.
 */
test('a bare agent’s Open-in menu has no Open credentials/.env item', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const page = cinna.page

  const dir = homeDir(cinna, 'repos', 'ledger-notes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENT.md'), '# Ledger Notes\n\nYou answer questions about ledgers.\n')

  await cinna.stubDirectoryPicker(dir)
  const pick = await page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await page.evaluate(
    (input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) }
  )
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)

  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Ledger Notes', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ledger Notes')

  const menu = page.getByRole('menu', { name: 'Open this folder in' })
  await openInTrigger(cinna).click()
  await expect(menu.getByRole('menuitem', { name: 'Reveal folder' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: COPY_ITEM })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: ENV_ITEM })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /credentials/ })).toHaveCount(0)
})
