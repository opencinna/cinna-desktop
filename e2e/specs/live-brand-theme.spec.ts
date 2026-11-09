import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { repoRoot } from '../playwright.config'
import { coreCall, makeTeamTest, expect, PersonApp, refreshLibrary, type SharingPerson, type TeamFixtureBase } from '../fixtures/liveTeamSharing'
import { addSkillToAgent, buildAgent, cachedSkillDir, catalogPins, chatStartedWith, skillDto, skillItem, skillsPluginDir, startAgentChat, type CatalogFixture } from '../fixtures/liveCatalog'
import { LIVE_ENGINE } from '../fixtures/liveEngine'
import { LIVE_REQUESTED } from '../fixtures/live'
import { CLAUDE_API_AUTH } from '../fixtures/claudeApiAuth'
import { beginRealLogin, endRealLogin, makeRealLoginDirs, pinRealLoginProfile, type RealLogin } from '../fixtures/realLogin'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'
import { BRAND_ROLE_MAP } from '../../src/shared/brandTheme/roleMap'

/**
 * Brand themes against the **real** local cinna-core: a theme core validated,
 * stored and serves reaches a profile signed in to it, in every place the
 * desktop shows a brand, and a new revision and an unpublish reach an app that
 * is already running.
 *
 * ## Running it
 *
 * The core state is made outside the suite by `e2e/fixtures/live-brand-theme.py`
 * (two people and the admin's token, run inside the backend container; its
 * docstring has the commands). `CINNA_BRAND_LIVE_FIXTURE` points at the JSON it
 * printed; without it every test skips. `create` refuses while a theme it did not
 * make is published: the spec publishes and unpublishes the server's one theme.
 * The tests share that one theme, so they run in order, and the last thing each
 * does is unpublish (cleanup also does, by name).
 *
 * Tests 1–4 run no agent turn: nothing there is billed. Test 5 is billed: one
 * real Claude Code turn (see its own comment; `LIVE_ENGINE=claude`).
 *
 * ## What is real
 *
 * cinna-core: the package validator (the spec's accents were picked to pass its
 * contrast rules), the SVG sanitiser (the dark logo the app shows is core's
 * rewritten bytes, so the desktop's `checkSvg` is tested against real output,
 * not a copied fixture), publish/unpublish, `GET /api/v1/brand-theme` with its
 * ETag and 204, the content-addressed assets, `/.well-known/cinna-desktop`'s
 * `brand_theme`, the admin page's upload dialog and preview Publish, and the
 * desktop consent page's brand. The desktop: everything from the fetch on
 * activation to the sheet, the five-minute refresh timer (test 2 waits for it),
 * the cache in `brand_themes`, the tray popup, the password lock's override.
 *
 * Faked: the consent *click* for the app's own tokens (`mintDesktopTokens`,
 * the same PKCE flow over the API), so the app is not signed in through its
 * Add Account dialog. The theme does not depend on the token: the endpoint is
 * public and keyed by the profile's server.
 *
 * ## What it does not prove
 *
 * Dashboard frames, the 304 path on a relaunch (indistinguishable on screen
 * from a 200 of the same revision), and a theme core accepts but the desktop
 * refuses (core never serves one; `brand-theme.spec.ts` and the unit tests feed
 * those from fixtures).
 */

interface BrandFixture extends TeamFixtureBase {
  web: string
}

const fixturePath = (process.env.CINNA_BRAND_LIVE_FIXTURE ?? '').trim()
function brandFixture(): BrandFixture | null {
  if (!fixturePath || !existsSync(fixturePath)) return null
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as BrandFixture
}

const test = makeTeamTest(
  brandFixture,
  'Set CINNA_BRAND_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-brand-theme.py create (a running local cinna-core)'
)
test.describe.configure({ mode: 'serial' })

type Mode = 'dark' | 'light'
const MODES: Mode[] = ['dark', 'light']
const STOCK_ACCENT = { dark: '#d97a4a', light: '#2e88b8' } as const
const STOCK_HEADING = 'What can I help with?'
const FIXTURES = join(repoRoot, 'src/shared/brandTheme/fixtures/valid')

interface AssetRef { url: string; type: string; bytes: number; sha256: string }
interface Served {
  schema: string
  revision: number
  theme: {
    name: string
    modes: Record<Mode, Record<string, string>>
    logo?: Record<Mode, AssetRef | null> | null
    background?: Record<Mode, AssetRef | null> | null
    copy?: { newChatHeading?: string | null } | null
  }
}

// ---------------------------------------------------------------------------
// Theme packages, from core's own fixtures with off-stock accents (the
// fixtures' accents are stock's, which would prove nothing).

interface Package { name: string; theme: Buffer; files: { name: string; buffer: Buffer; mimeType: string }[] }

const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' }

function readPackage(fixture: string, edit: (theme: any) => void): Package {
  const theme = JSON.parse(readFileSync(join(FIXTURES, fixture, 'theme.json'), 'utf8'))
  edit(theme)
  const paths = new Set<string>()
  for (const group of [theme.logo, theme.background]) for (const p of Object.values(group ?? {})) if (typeof p === 'string') paths.add(p)
  const files = [...paths].map((p) => ({
    name: p.split('/').pop()!,
    buffer: readFileSync(join(FIXTURES, fixture, p)),
    mimeType: MIME[p.split('.').pop()!] ?? 'application/octet-stream'
  }))
  return { name: theme.name, theme: Buffer.from(JSON.stringify(theme)), files }
}

/** Unique per call (a rerun on the same fixture must not find an older draft of the same name); cleanup matches the shape. */
const themeName = (fixture: BrandFixture, variant: string): string => `E2E Brand ${fixture.tag} ${variant}${randomBytes(2).toString('hex')}`

/** `valid/full` (SVG dark logo, PNG light logo, both backgrounds) with accents and heading of its own. */
function fullPackage(fixture: BrandFixture, variant: string, accents: { dark: string; light: string; lightHover: string }, heading: string): Package {
  return readPackage('full', (t) => {
    t.name = themeName(fixture, variant)
    t.modes.dark.accent = accents.dark
    t.modes.light.accent = accents.light
    // White text on the light accents; core requires 4.5:1 on accent and on accent.hover.
    t.modes.light['accent.on'] = '#ffffff'
    t.modes.light['accent.hover'] = accents.lightHover
    t.copy = { newChatHeading: heading }
  })
}

/** `valid/full` without a logo or a heading: the new-chat screen goes back to the stock mark and heading. */
function plainPackage(fixture: BrandFixture, variant: string, accents: { dark: string; light: string; lightHover: string }): Package {
  return readPackage('full', (t) => {
    t.name = themeName(fixture, variant)
    t.modes.dark.accent = accents.dark
    t.modes.light.accent = accents.light
    t.modes.light['accent.on'] = '#ffffff'
    t.modes.light['accent.hover'] = accents.lightHover
    delete t.logo
    delete t.copy
  })
}

const BLUE = { dark: '#5b8def', light: '#6d4bd8', lightHover: '#5a3bc0' }
const TEAL = { dark: '#2f9e8f', light: '#0f766e', lightHover: '#0b5f58' }

// ---------------------------------------------------------------------------
// Core.

async function uploadDraft(fixture: BrandFixture, pkg: Package): Promise<string> {
  const form = new FormData()
  form.append('theme', new Blob([new Uint8Array(pkg.theme)], { type: 'application/json' }), 'theme.json')
  for (const f of pkg.files) form.append('files', new Blob([new Uint8Array(f.buffer)], { type: f.mimeType }), f.name)
  const response = await fetch(`${fixture.server}/api/v1/admin/brand-theme/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.admin.token}` },
    body: form
  })
  const body = (await response.json()) as { id: string | null; errors: unknown[] }
  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(body.errors, `core refused ${pkg.name}`).toEqual([])
  return body.id!
}

async function publish(fixture: BrandFixture, id: string): Promise<number> {
  const r = await coreCall(fixture, fixture.admin.token, `/admin/brand-theme/drafts/${id}/publish`, { method: 'POST' })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.revision as number
}

async function unpublish(fixture: BrandFixture): Promise<void> {
  const r = await coreCall(fixture, fixture.admin.token, '/admin/brand-theme/unpublish', { method: 'POST' })
  expect(r.status).toBe(204)
}

/** What core serves now: the document, or null on 204. */
async function served(fixture: BrandFixture): Promise<{ status: number; etag: string | null; doc: Served | null }> {
  const r = await fetch(`${fixture.server}/api/v1/brand-theme`)
  return { status: r.status, etag: r.headers.get('etag'), doc: r.status === 200 ? ((await r.json()) as Served) : null }
}

/** An asset's bytes as core serves them, as the data URL the app writes. */
async function assetDataUrl(fixture: BrandFixture, ref: AssetRef): Promise<string> {
  const r = await fetch(`${fixture.server}/api/v1/brand-theme/assets/${ref.sha256}`)
  expect(r.status).toBe(200)
  const bytes = Buffer.from(await r.arrayBuffer())
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256)
  return `data:${ref.type};base64,${bytes.toString('base64')}`
}

async function publishPackage(fixture: BrandFixture, pkg: Package): Promise<Served> {
  const revision = await publish(fixture, await uploadDraft(fixture, pkg))
  const now = await served(fixture)
  expect(now.status).toBe(200)
  expect(now.etag).toBe(`"${revision}"`)
  expect(now.doc!.theme.name).toBe(pkg.name)
  return now.doc!
}

// ---------------------------------------------------------------------------
// The app.

/** The person's app, signed in to core, in `mode`, with the brand applied. */
async function openBranded(team: { open(label: 'a' | 'b'): Promise<PersonApp> }, label: 'a' | 'b', mode: Mode): Promise<PersonApp> {
  const app = await team.open(label)
  await useTheme(app.page, mode)
  await expect(app.page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 30_000 })
  return app
}

/** Footer `Interface` menu → `Switch to dark` / `Switch to light`. */
async function useTheme(page: Page, theme: Mode): Promise<void> {
  const html = page.locator('html')
  if ((await html.getAttribute('data-theme')) === theme) return
  const trigger = page.getByRole('button', { name: 'Interface', exact: true })
  await trigger.click()
  await page.getByRole('button', { name: `Switch to ${theme}`, exact: true }).click()
  await expect(html).toHaveAttribute('data-theme', theme)
  await trigger.click()
  await expect(page.getByRole('button', { name: /^Switch to (light|dark)$/ })).toHaveCount(0)
}

const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
const accent = (page: Page) => cssVar(page, '--color-accent')

/** Every `--color-*` a role maps to, against what core serves for `mode`; `[]` when all match. */
async function roleMismatches(page: Page, doc: Served, mode: Mode): Promise<string[]> {
  const want: Record<string, string> = {}
  for (const [role, vars] of Object.entries(BRAND_ROLE_MAP)) for (const v of vars) want[`--color-${v}`] = doc.theme.modes[mode][role]
  const got = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement)
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]))
  }, Object.keys(want))
  return Object.keys(want).filter((n) => got[n] !== want[n]).map((n) => `${n}: ${got[n]} ≠ ${want[n]}`)
}

/** `none`, `brand` when it is exactly `url("<expected>")`, or a short description of what it is instead. */
const bodyBackground = (page: Page, expected: string | null) =>
  page.evaluate((want) => {
    const image = getComputedStyle(document.body).backgroundImage
    if (image === 'none') return 'none'
    if (want && image === `url("${want}")`) return 'brand'
    if (image.startsWith('url("data:')) return `other ${image.slice(0, 40)}`
    return image.replace(/^url\("(?:.*\/)?([^/"]+)"\)$/, '$1')
  }, expected)

const brandLogo = (page: Page) => page.getByTestId('brand-logo')
const heading = (page: Page) => page.getByRole('heading', { level: 1 })

/** The whole look for `mode` matches the served document: roles, logo, heading, background. */
async function expectBrand(fixture: BrandFixture, page: Page, doc: Served, mode: Mode): Promise<void> {
  await useTheme(page, mode)
  await expect.poll(() => accent(page)).toBe(doc.theme.modes[mode].accent)
  expect(await roleMismatches(page, doc, mode)).toEqual([])
  const logo = doc.theme.logo?.[mode] ?? null
  if (logo) await expect(brandLogo(page)).toHaveAttribute('src', await assetDataUrl(fixture, logo))
  else await expect(brandLogo(page)).toHaveCount(0)
  await expect(heading(page)).toHaveText(doc.theme.copy?.newChatHeading ?? STOCK_HEADING)
  const bg = doc.theme.background?.[mode] ?? null
  const bgUrl = bg ? await assetDataUrl(fixture, bg) : null
  await expect.poll(() => bodyBackground(page, bgUrl)).toBe(bgUrl ? 'brand' : 'none')
}

async function expectStock(page: Page, mode: Mode): Promise<void> {
  await useTheme(page, mode)
  await expect(page.locator('html')).not.toHaveAttribute('data-brand')
  await expect(page.locator('style#brand-theme')).toHaveCount(0)
  await expect.poll(() => accent(page)).toBe(STOCK_ACCENT[mode])
  await expect(brandLogo(page)).toHaveCount(0)
  await expect(heading(page)).toHaveText(STOCK_HEADING)
  await expect.poll(() => bodyBackground(page, null)).toMatch(new RegExp(`^${mode}-background-gradient-mesh-1.*\\.png$`))
}

const userMenuTrigger = (page: Page, name: string) => page.getByTitle(name, { exact: true })
/** A Profiles row: `<name> Guest`, or `<initial> <name>` (a Cinna row then repeats the account's full name). */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const profileRow = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^(?:${escapeRe(name.charAt(0).toUpperCase())} )?${escapeRe(name)}(?: |$)`) })

async function currentName(page: Page): Promise<string> {
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  return user?.displayName ?? ''
}

async function guestName(page: Page): Promise<string> {
  const users = await page.evaluate(() => window.api.auth.listUsers())
  return users.find((u) => u.id === '__default__')!.displayName
}

async function openUserMenu(page: Page, shown: string): Promise<void> {
  await userMenuTrigger(page, shown).click()
  await expect(page.getByRole('button', { name: 'Add Account', exact: true })).toBeVisible()
}

/** Footer user menu → Profiles row. A switch is an activation: the app fetches the theme again. */
async function switchTo(page: Page, from: string, to: string): Promise<void> {
  await openUserMenu(page, from)
  await profileRow(page, to).click()
  await expect(userMenuTrigger(page, to)).toBeVisible()
  await expect.poll(() => currentName(page)).toBe(to)
}

/** Rows in the app's brand cache. */
const cachedThemes = (app: PersonApp) =>
  app.electronApp.evaluate(({ app: electronApp }, userData) => {
    if (electronApp.getPath('userData') !== userData) throw new Error('Not the isolated test profile')
    const req = process.getBuiltinModule('node:module').createRequire(`${electronApp.getAppPath()}/package.json`)
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${userData}/cinna.db`, { readonly: true, fileMustExist: true })
    try {
      return db.prepare('SELECT origin, revision FROM brand_themes').all() as { origin: string; revision: number }[]
    } finally {
      db.close()
    }
  }, app.sandbox.userData)

/** The menu-bar popup window: it exists from startup, hidden. */
function trayPage(app: PersonApp): Page {
  const tray = app.electronApp.windows().find((w) => w.url().endsWith('trayPanel.html'))
  if (!tray) throw new Error('no tray panel window')
  return tray
}

// ---------------------------------------------------------------------------

test.afterAll(async () => {
  const fixture = brandFixture()
  if (!fixture) return
  // The server's one theme goes back to stock however a test ended.
  await coreCall(fixture, fixture.admin.token, '/admin/brand-theme/unpublish', { method: 'POST' }).catch(() => {})
})

test('1. a profile on the local core wears the theme core serves, in every role, in both modes, and in the tray', async ({ team }) => {
  test.setTimeout(240_000)
  const fixture = team.fixture as BrandFixture
  const heading1 = 'What can Blue E2E help with?'
  let doc: Served

  await test.step('the admin publishes valid/full with blue accents; core advertises and serves it', async () => {
    doc = await publishPackage(fixture, fullPackage(fixture, 'Blue', BLUE, heading1))
    const discovery = await (await fetch(`${fixture.server}/.well-known/cinna-desktop`)).json()
    expect(discovery.brand_theme?.url).toBe(`${fixture.server}/api/v1/brand-theme`)
    expect(doc.theme.logo?.dark?.type).toBe('image/svg+xml')
    expect(doc.theme.logo?.light?.type).toBe('image/png')
  })

  const app = await openBranded(team, 'a', 'dark')
  const page = app.page

  await test.step('dark: all 35 roles, core\'s sanitised SVG logo, the heading, the dark background', async () => {
    await expectBrand(fixture, page, doc, 'dark')
    expect(await cachedThemes(app)).toEqual([{ origin: fixture.server, revision: doc.revision }])
  })

  await test.step('light: all 35 roles, the PNG logo, the light background', async () => {
    await expectBrand(fixture, page, doc, 'light')
  })

  await test.step('the tray popup takes the colours, never the background', async () => {
    const tray = trayPage(app)
    await expect(tray.locator('html')).toHaveAttribute('data-brand', '')
    await expect.poll(() => accent(tray)).toBe(doc.theme.modes.light.accent)
    expect(await roleMismatches(tray, doc, 'light')).toEqual([])
    expect(await tray.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe('none')
    await useTheme(page, 'dark')
    await expect.poll(() => accent(tray)).toBe(doc.theme.modes.dark.accent)
  })

  await test.step('the guest is stock; back on the Cinna profile the brand returns', async () => {
    const guest = await guestName(page)
    const me = await currentName(page)
    await switchTo(page, me, guest)
    await expectStock(page, 'dark')
    await expectStock(page, 'light')
    await switchTo(page, guest, me)
    await expectBrand(fixture, page, doc, 'light')
  })

  await test.step('a restart with core up shows the same brand', async () => {
    await app.relaunch()
    await expect(app.page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 30_000 })
    await expectBrand(fixture, app.page, doc, 'dark')
  })

  await unpublish(fixture)
})

test('2. a new revision reaches a running app on the five-minute refresh, and an unpublish returns it to stock and empties the cache', async ({ team }) => {
  test.setTimeout(600_000)
  const fixture = team.fixture as BrandFixture
  const first = await publishPackage(fixture, fullPackage(fixture, 'Blue2', BLUE, 'What can Blue2 E2E help with?'))
  const app = await openBranded(team, 'a', 'dark')
  const page = app.page
  await expectBrand(fixture, page, first, 'dark')

  let second: Served
  await test.step('the admin publishes a teal revision with no logo and no heading', async () => {
    second = await publishPackage(fixture, plainPackage(fixture, 'Teal', TEAL))
    expect(second.revision).toBeGreaterThan(first.revision)
  })

  await test.step('without any action in the app, the next refresh (≤ 5 min) applies it everywhere', async () => {
    const started = Date.now()
    await expect.poll(() => accent(page), { timeout: 330_000, intervals: [5_000] }).toBe(second.theme.modes.dark.accent)
    const waited = Math.round((Date.now() - started) / 1000)
    test.info().annotations.push({ type: 'refresh', description: `new revision applied ${waited}s after publish` })
    console.log(`live-brand-theme: new revision applied ${waited}s after publish`)
    await expectBrand(fixture, page, second, 'dark')
    await expect.poll(() => accent(trayPage(app))).toBe(second.theme.modes.dark.accent)
    expect(await cachedThemes(app)).toEqual([{ origin: fixture.server, revision: second.revision }])
  })

  await test.step('unpublish; the next activation sees 204: stock, and the cache row is gone', async () => {
    await unpublish(fixture)
    expect((await served(fixture)).status).toBe(204)
    const guest = await guestName(page)
    const me = await currentName(page)
    await switchTo(page, me, guest)
    await switchTo(page, guest, me)
    await expect(page.locator('html')).not.toHaveAttribute('data-brand', { timeout: 30_000 })
    await expectStock(page, 'dark')
    await expect.poll(() => cachedThemes(app)).toEqual([])
    await expect.poll(() => accent(trayPage(app))).toBe(STOCK_ACCENT.dark)
  })

  await test.step('a restart stays stock', async () => {
    await app.relaunch()
    await expectStock(app.page, 'dark')
  })
})

test('3. a password-locked profile\'s lock wears its server\'s brand over a stock guest; Cancel returns to stock, Unlock keeps the brand', async ({ team }) => {
  test.setTimeout(240_000)
  const fixture = team.fixture as BrandFixture
  const doc = await publishPackage(fixture, fullPackage(fixture, 'Lock', BLUE, 'What can Lock E2E help with?'))
  const app = await openBranded(team, 'a', 'dark')
  const page = app.page
  await expectBrand(fixture, page, doc, 'dark')

  const password = `lock-${randomBytes(6).toString('hex')}`
  const me = await currentName(page)
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  const set = await page.evaluate((input) => window.api.auth.updateUser(input), { userId: user!.id, password })
  expect(set.success, set.error).toBe(true)
  const guest = await guestName(page)
  await switchTo(page, me, guest)
  await expectStock(page, 'dark')

  const unlock = page.getByRole('button', { name: 'Unlock', exact: true })
  await test.step('the lock shows the brand accent and accent.on from the cache', async () => {
    await openUserMenu(page, guest)
    await profileRow(page, me).click()
    await expect(unlock).toBeVisible()
    await expect.poll(() => accent(page)).toBe(doc.theme.modes.dark.accent)
    const look = await unlock.evaluate((b) => ({ bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(b).color }))
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
    expect(look).toEqual({ bg: rgb(doc.theme.modes.dark.accent), fg: rgb(doc.theme.modes.dark['accent.on']) })
  })

  await test.step('Cancel: the guest is stock again', async () => {
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(unlock).toHaveCount(0)
    await expectStock(page, 'dark')
  })

  await test.step('Unlock: the profile is active and keeps the brand', async () => {
    await openUserMenu(page, guest)
    await profileRow(page, me).click()
    await page.getByPlaceholder('Enter password').fill(password)
    await unlock.click()
    await expect.poll(() => currentName(page)).toBe(me)
    await expectBrand(fixture, page, doc, 'dark')
  })

  await unpublish(fixture)
})

test('4. the admin publishes from the Brand theme card in core\'s Admin → Server Configuration → Interface; the desktop consent page and a new sign-in wear it; unpublishing there returns the app to stock', async ({ team }) => {
  test.setTimeout(300_000)
  const fixture = team.fixture as BrandFixture
  const pkg = fullPackage(fixture, 'Web', TEAL, 'What can Web E2E help with?')
  const browser = await chromium.launch()
  try {
    const adminContext = await browser.newContext()
    await adminContext.addInitScript((token) => window.localStorage.setItem('access_token', token), fixture.admin.token)
    const admin = await adminContext.newPage()
    const row = admin.getByRole('button', { name: `Actions for the brand theme ${pkg.name}` })

    await test.step('upload theme.json and its files in the dialog, then Publish from the preview it opens', async () => {
      await admin.goto(`${fixture.web}/admin/server-configuration#interface`)
      // The Brand theme card, beside the disclaimer on the Interface tab, holds the only Upload there.
      await admin.getByRole('button', { name: 'Upload', exact: true }).click()
      const dialog = admin.getByRole('dialog', { name: 'Upload theme package' })
      await dialog.getByTestId('upload-source-files').setInputFiles([
        { name: 'theme.json', mimeType: 'application/json', buffer: pkg.theme },
        ...pkg.files
      ])
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
      // A successful upload opens the new draft's preview, which is where Publish lives.
      const preview = admin.getByRole('dialog', { name: pkg.name })
      await expect(preview.getByRole('img', { name: `Dark mode preview of ${pkg.name}` })).toBeVisible()
      await preview.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(preview).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(async () => (await served(fixture)).doc?.theme.name ?? null, { timeout: 30_000 }).toBe(pkg.name)
    })
    const doc = (await served(fixture)).doc!

    await test.step('the desktop consent page a sign-in opens shows the brand logo', async () => {
      const b64 = (bytes: Buffer): string => bytes.toString('base64url')
      const query = new URLSearchParams({
        redirect_uri: 'http://127.0.0.1:45678/oauth/callback',
        code_challenge: b64(createHash('sha256').update(b64(randomBytes(32))).digest()),
        code_challenge_method: 'S256',
        state: b64(randomBytes(8)),
        device_name: 'cinna-e2e',
        platform: process.platform,
        app_version: '0.0.0-e2e'
      })
      const authorize = await fetch(`${fixture.server}/api/v1/desktop-auth/authorize?${query}`, { redirect: 'manual' })
      const location = authorize.headers.get('location')
      expect(location, `authorize answered HTTP ${authorize.status} without a redirect`).toBeTruthy()
      const personContext = await browser.newContext()
      await personContext.addInitScript((token) => window.localStorage.setItem('access_token', token), fixture.people.b.token)
      const consent = await personContext.newPage()
      await consent.goto(new URL(location!, fixture.web).toString())
      await expect(consent.getByRole('img', { name: pkg.name })).toBeVisible({ timeout: 30_000 })
      await personContext.close()
    })

    const app = await openBranded(team, 'b', 'light')
    await test.step('the newly signed-in profile wears the web-published theme', async () => {
      await expectBrand(fixture, app.page, doc, 'light')
      await expectBrand(fixture, app.page, doc, 'dark')
    })

    await test.step('Unpublish from the card; the next activation is stock', async () => {
      await row.click()
      await admin.getByRole('menuitem', { name: 'Unpublish', exact: true }).click()
      await admin.getByRole('button', { name: 'Unpublish theme', exact: true }).click()
      await expect.poll(async () => (await served(fixture)).status, { timeout: 30_000 }).toBe(204)
      const page = app.page
      const guest = await guestName(page)
      const me = await currentName(page)
      await switchTo(page, me, guest)
      await switchTo(page, guest, me)
      await expectStock(page, 'dark')
    })
  } finally {
    await browser.close()
  }
})

// ---------------------------------------------------------------------------
// Test 5: assisted generation on real Claude Code.

/** Core's checkout, for the `brand-theme` skill source and its archive builder. */
const CORE_PATH = (process.env.CINNA_CORE_PATH ?? '').trim() || join(repoRoot, '..', 'workflow-runner-core')
const SKILL_BUILDER = join(CORE_PATH, 'backend/app/scripts/build_brand_theme_skill.py')

/** The catalog name test 5 publishes the skill under; `live-brand-theme.py cleanup` matches exactly this shape. */
const brandSkillName = (fixture: BrandFixture): string => `brand-theme-e2e-${fixture.tag}-${randomBytes(2).toString('hex')}`

/** A small brandbook (the one the manual probe used): palette, two outlined SVG logos, the greeting. */
const BRANDBOOK: Record<string, string> = {
  'BRANDBOOK.md': `# Northwind Robotics — Brand Guidelines (v2)

## Name
Northwind (short form). Tagline: "Automation you can steer."

## Primary palette
- Northwind Teal — #0E8C86 (primary; buttons, links, highlights)
- Deep Harbor — #10232E (dark backgrounds, headlines on light)
- Fog — #F3F6F7 (light backgrounds)

## Secondary palette
- Signal Amber — #F2A93B
- Coral — #E8665A (alerts only)
- Slate Blue — #4A6FA5
- Kelp — #3E8E41
- Lilac — #8C7AE6

## Typography
Inter for UI. Headlines in Deep Harbor on light, Fog on dark.

## Logo
\`logo.svg\` (the wordmark, outlined). On dark surfaces use the reversed version \`logo-reversed.svg\`.

## Voice
The assistant greets with: "What should Northwind build today?"
`,
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60" width="240" height="60"><path d="M10 50 L10 10 L22 10 L40 36 L40 10 L50 10 L50 50 L38 50 L20 24 L20 50 Z" fill="#10232E"/><circle cx="80" cy="30" r="18" fill="#0E8C86"/><rect x="110" y="22" width="120" height="16" rx="8" fill="#10232E"/></svg>\n',
  'logo-reversed.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60" width="240" height="60"><path d="M10 50 L10 10 L22 10 L40 36 L40 10 L50 10 L50 50 L38 50 L20 24 L20 50 Z" fill="#F3F6F7"/><circle cx="80" cy="30" r="18" fill="#0E8C86"/><rect x="110" y="22" width="120" height="16" rx="8" fill="#F3F6F7"/></svg>\n'
}

/**
 * Core's own `brand-theme` skill archive (its builder, unchanged sources),
 * repacked under `name`: the top folder renamed and SKILL.md's `name:` line
 * rewritten, so the admin's package is this run's alone and cleanup can match it.
 */
function brandSkillArchive(name: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'cinna-e2e-brand-skill-'))
  try {
    execFileSync('python3', [SKILL_BUILDER, join(dir, 'built.tgz')], { stdio: 'pipe' })
    mkdirSync(join(dir, 'x'))
    execFileSync('tar', ['-xzf', join(dir, 'built.tgz'), '-C', join(dir, 'x')])
    execFileSync('mv', [join(dir, 'x', 'brand-theme'), join(dir, 'x', name)])
    const skillMd = join(dir, 'x', name, 'SKILL.md')
    const text = readFileSync(skillMd, 'utf8')
    expect(text.startsWith('---\nname: brand-theme\n'), 'core\'s SKILL.md opens with name: brand-theme').toBe(true)
    writeFileSync(skillMd, text.replace(/^name: brand-theme$/m, `name: ${name}`))
    // No AppleDouble `._*` entries from macOS tar.
    execFileSync('tar', ['-C', join(dir, 'x'), '-czf', join(dir, 'skill.tgz'), name], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    return readFileSync(join(dir, 'skill.tgz'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The admin publishes the archive over the catalog's upload path, `users` visibility with a `use` grant for `person`. */
async function publishBrandSkill(fixture: BrandFixture, name: string, person: SharingPerson): Promise<{ packageId: string; revision: number }> {
  const form = new FormData()
  form.append('archive', new Blob([new Uint8Array(brandSkillArchive(name))], { type: 'application/gzip' }), `${name}.tgz`)
  form.append('meta', JSON.stringify({ visibility: 'users', grants: [{ principal: { user_id: person.id }, access: 'use' }], release_notes: 'live-brand-theme test 5' }))
  const response = await fetch(`${fixture.server}/api/v1/skills/packages/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.admin.token}` },
    body: form
  })
  const body = (await response.json()) as { package_id: string; revision_number: number }
  expect(response.status, JSON.stringify(body).slice(0, 600)).toBe(200)
  return { packageId: body.package_id, revision: body.revision_number }
}

/** Upload a zip as `package`, the way the skill hands it to the admin; answers the draft id. */
async function uploadZipDraft(fixture: BrandFixture, zip: Buffer, fileName: string): Promise<string> {
  const form = new FormData()
  form.append('package', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), fileName)
  const response = await fetch(`${fixture.server}/api/v1/admin/brand-theme/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.admin.token}` },
    body: form
  })
  const body = (await response.json()) as { id: string | null; errors: unknown[]; warnings?: unknown[] }
  expect(response.status, JSON.stringify(body).slice(0, 1500)).toBe(200)
  expect(body.errors, 'core accepts the generated package').toEqual([])
  test.info().annotations.push({ type: 'core warnings', description: JSON.stringify(body.warnings ?? []) })
  return body.id!
}

/** Files under `dir` (agent folder) the agent may have written, skipping the app's own and the brandbook. */
function agentFiles(dir: string, depth = 4): string[] {
  const out: string[] = []
  const walk = (current: string, level: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (level < depth && !['.cinna', '.git', 'node_modules', 'brandbook', '.claude'].includes(entry.name)) walk(path, level + 1)
      } else if (entry.isFile()) out.push(path)
    }
  }
  walk(dir, 0)
  return out
}

/**
 * A on the developer's real `HOME` for the Claude login (`realLogin.ts`): the
 * agents home is pinned into the throwaway `~/.cinna-e2e-claude-*` folder
 * **before** `homeGrant`, so the real `~/CinnaAgents` is never created.
 */
class RealLoginPerson extends PersonApp {
  constructor(person: SharingPerson, readonly login: RealLogin, fixture: BrandFixture) {
    super('a', person, makeRealLoginDirs(login), fixture)
  }

  override async setUp(): Promise<void> {
    await this.start()
    await this.waitForShell()
    const registered = await this.page.evaluate(
      (p) => window.api.auth.register({ accountType: 'local', username: p.email, displayName: p.name }),
      this.person
    )
    if (!registered.success || !registered.user) throw new Error('could not register A’s profile')
    await this.writeTokens()
    const logged = await this.page.evaluate((userId) => window.api.auth.login({ userId }), registered.user.id)
    if (!logged.success) throw new Error('could not activate A’s profile')
    // Engine, throwaway agents home (checked, not guarded) and the binary; throws on the real home.
    await pinRealLoginProfile(this.page, this.sandbox.home, this.login)
    await this.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    await this.page.evaluate(() => window.api.localAgents.homeGrant())
    const agentsHome = join(this.sandbox.home, 'Documents', 'CinnaAgents')
    const roots = await this.page.evaluate(() => window.api.localAgents.rootsList())
    const root = roots.find((r) => r.isDefault)
    if (!root || !root.path.startsWith(`${agentsHome}`)) throw new Error(`A’s agents home is ${root?.path}, not inside ${agentsHome}`)
    this.rootPath = root.path
    await this.relaunch()
    const current = await this.page.evaluate(() => window.api.auth.getCurrent())
    expect(current?.username).toBe(this.person.email)
    expect(current?.type).toBe('cinna_user')
  }
}

/** Until the turn ends: every ask gets `Allow once` (recorded), at most `maxAsks`; one prompt only. */
async function runTurn(app: PersonApp, agentName: string, prompt: string, maxAsks = 12): Promise<string[]> {
  await startAgentChat(app, agentName, prompt)
  const asks: string[] = []
  await expect
    .poll(
      async () => {
        const block = app.page.getByText(/^The agent is asking to /)
        if ((await block.count()) > 0) {
          if (asks.length >= maxAsks) return 'too many asks'
          asks.push(await block.first().innerText())
          await app.page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
          return 'answered an ask'
        }
        const chat = await chatStartedWith(app, prompt)
        const error = chat?.messages.find((message: any) => message.role === 'error')
        if (error) return `error: ${String(error.content).slice(0, 300)}`
        const answered = chat?.messages.some((message: any) => message.role === 'assistant')
        return chat && !chat.activeRunId && answered ? 'done' : 'running'
      },
      { message: 'the agent’s turn ends', timeout: 600_000, intervals: [2000] }
    )
    .toBe('done')
  return asks
}

/**
 * Test 5 — assisted generation. Billed: **one** real Claude Code turn
 * (`LIVE_ENGINE=claude`; the Medium tier, `sonnet`, unless
 * `CINNA_E2E_LIVE_MODEL` names another; about $0.2–0.5) on the developer's own
 * login, through the real-`HOME` exception of `realLogin.ts` (A only; its
 * `~/.cinna-e2e-claude-*` folder and the `~/.claude/projects` records of its
 * sessions are removed afterwards, pass or fail).
 *
 * Real: core's `brand-theme` skill (its sources and archive builder, repacked
 * under this run's name `brand-theme-e2e-<tag>-<hex>`), the admin's publish
 * over `POST /skills/packages/publish`, A adding it from the catalog to a kit
 * agent, Claude running the skill's `uv run --script` entry points with the
 * app's environment, core's validator on the zip, publish, and the app taking
 * the generated look on activation. The agent is told the theme's exact name
 * (`E2E Brand <tag> Gen<hex>`), which cleanup matches; the test checks it.
 *
 * Not proven: a machine without the Command Line Tools (the uv-shim CLT
 * dialog is `make bare-mac`'s), the theme's taste, or that the prose reply is
 * right — the assertions are on the files.
 */
test('5. assisted generation: A’s Claude agent turns a brandbook into a theme with the catalog brand-theme skill; core accepts it and A’s app wears it', async ({ team }) => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  test.skip(LIVE_ENGINE.name !== 'claude', 'Billed Claude Code turn: run with LIVE_ENGINE=claude (CINNA_E2E_LIVE_ENGINE=claude)')
  test.skip(CLAUDE_API_AUTH, 'Test 5 runs on the real Claude login only, not CINNA_E2E_CLAUDE_AUTH=api_key')
  test.skip(LIVE_ENGINE.skipReason !== null || LIVE_ENGINE.realLogin === null, LIVE_ENGINE.skipReason ?? 'no Claude Code binary')
  test.skip(spawnSync('uv', ['--version'], { stdio: 'ignore' }).status !== 0, 'uv is not on PATH: the skill runs its scripts with uv run --script')
  test.skip(!existsSync(SKILL_BUILDER), `core's brand-theme skill builder is not at ${SKILL_BUILDER} (set CINNA_CORE_PATH)`)
  test.setTimeout(1_200_000)
  const fixture = team.fixture as BrandFixture
  const skill = brandSkillName(fixture)
  const themeName = `E2E Brand ${fixture.tag} Gen${randomBytes(2).toString('hex')}`
  const agentName = `Brand maker ${fixture.tag} ${randomBytes(2).toString('hex')}`
  let packageUuid: string | null = null

  let published: { packageId: string; revision: number }
  await test.step('the admin publishes core\'s brand-theme skill to the catalog; A may use it', async () => {
    published = await publishBrandSkill(fixture, skill, fixture.people.a)
    const item = await skillItem(fixture, fixture.people.a.token, skill)
    expect(item?.access).toBe('use')
    packageUuid = item.uuid
  })

  const login = LIVE_ENGINE.realLogin!
  const realRun = beginRealLogin()
  const a = new RealLoginPerson(fixture.people.a, login, fixture)
  let passed = false
  try {
    await a.setUp()
    const agent = await buildAgent(a, fixture as unknown as CatalogFixture, { name: agentName })
    expect(agent.path.startsWith(`${a.sandbox.home}/`), 'the agent lives in the throwaway folder').toBe(true)
    // A second agent of A's, never given the skill: the skill is on demand, never installed everywhere.
    const other = await buildAgent(a, fixture as unknown as CatalogFixture, { name: `Other ${agentName}` })
    /** Every place the skill could be linked to an agent: manifest pin, main's skill list, the plugin folder. */
    const linked = async (id: string, path: string) => ({
      pinned: catalogPins(path).some((pin) => pin.name === skill),
      listed: (await skillDto(a, id, skill, 'catalog')) !== undefined,
      plugin: existsSync(join(skillsPluginDir(a, id), 'skills', skill))
    })
    const NOT_LINKED = { pinned: false, listed: false, plugin: false }

    await test.step('after the admin\'s publish and a catalog refresh, none of A\'s agents has the skill', async () => {
      await refreshLibrary(a)
      expect(await linked(agent.id, agent.path), 'the branding agent before Add').toEqual(NOT_LINKED)
      expect(await linked(other.id, other.path), 'the other agent before Add').toEqual(NOT_LINKED)
    })

    await test.step(`the agent runs on ${LIVE_ENGINE.label}; the skill is added from the catalog`, async () => {
      const current = await a.page.evaluate((id) => window.api.localAgents.get(id), agent.id)
      if (!current.ok) throw new Error(current.message)
      const saved = await a.page.evaluate(
        (input) => window.api.localAgents.updateField({ agentId: input.id, expectedStamp: input.stamp, update: { field: 'runtime', value: input.value } }),
        { id: agent.id, stamp: current.value.stamps[MANIFEST_FILE]!, value: LIVE_ENGINE.runtime! }
      )
      expect(saved.ok).toBe(true)
      await a.relaunch()
      await addSkillToAgent(a, skill, agentName)
      await expect.poll(() => cachedSkillDir(a, packageUuid!, published.revision, skill)).not.toBeNull()
      expect((await linked(agent.id, agent.path)).pinned, 'the branding agent holds the pin it was given').toBe(true)
      // Only the agent it was added to: not the other one, nor after a catalog refresh and a restart.
      expect(await linked(other.id, other.path), 'the other agent after Add').toEqual(NOT_LINKED)
      await refreshLibrary(a)
      await a.relaunch()
      expect(await linked(other.id, other.path), 'the other agent after a refresh and a restart').toEqual(NOT_LINKED)
      mkdirSync(join(agent.path, 'brandbook'))
      for (const [name, text] of Object.entries(BRANDBOOK)) writeFileSync(join(agent.path, 'brandbook', name), text)
    })

    const prompt = `Make a Cinna brand theme from our brandbook in ./brandbook, using your brand theme skill. Name the theme exactly "${themeName}". Hand me the zip and the preview when the package is valid.`
    const startedAt = Date.now()
    const asks = await runTurn(a, agentName, prompt)

    const chat = await chatStartedWith(a, prompt)
    const assistant = chat.messages.filter((message: any) => message.role === 'assistant')
    const parts = assistant.flatMap((message: any) => message.parts ?? [])
    const tools = parts.filter((part: any) => part.kind === 'tool')
    const models = assistant.map((message: any) => message.telemetry?.model).filter(Boolean) as string[]
    const costUsd = assistant.reduce((sum: number, message: any) => sum + (message.telemetry?.costUsd ?? 0), 0)
    const commands: string[] = tools.map((part: any) => JSON.stringify(part.toolInput ?? {}))
    test.info().annotations.push(
      { type: 'model', description: JSON.stringify([...new Set(models)]) },
      { type: 'cost', description: `$${costUsd.toFixed(3)} in ${Math.round((Date.now() - startedAt) / 1000)} s` },
      { type: 'asks', description: JSON.stringify(asks) },
      { type: 'tool calls', description: JSON.stringify(tools.map((part: any) => ({ name: part.toolName, input: part.toolInput }))).slice(0, 4000) }
    )
    console.log(`live-brand-theme 5: ${[...new Set(models)].join(', ')}, $${costUsd.toFixed(3)}, ${tools.length} tool calls, ${asks.length} asks`)
    // The record outlives the sandbox (removed below, pass or fail): calls, outputs, the reply.
    const results = parts.filter((part: any) => part.kind === 'tool_result')
    writeFileSync(test.info().outputPath('a-turn.json'), JSON.stringify({
      models, costUsd, asks,
      tools: tools.map((part: any) => ({ id: part.toolId, name: part.toolName, input: part.toolInput })),
      results: results.map((part: any) => ({ id: part.toolId, text: String(part.text ?? '').slice(0, 1500) })),
      reply: assistant.map((message: any) => String(message.content ?? '').slice(0, 3000)),
      errors: chat.messages.filter((message: any) => message.role === 'error').map((message: any) => String(message.content).slice(0, 1000))
    }, null, 2))

    let zip: Buffer
    let zipName: string
    await test.step('the agent ran the catalog skill\'s scripts and left a zip and preview.html in its folder', async () => {
      expect(models.length, 'the turn reports its model').toBeGreaterThan(0)
      const tier = LIVE_ENGINE.label.split(' ')[1]
      for (const model of models) expect(model).toMatch(new RegExp(tier, 'i'))
      // `uv run --script <skill>/scripts/package|validate` on the catalog copy the app linked in
      // (`<userData>/cinna-plugins/agents/<id>/skills/<skill>`), run by the app's Claude. Sonnet sets
      // `S="<that folder>"` and runs `"$S/scripts/validate"`, so the path and the script are matched apart.
      const ran = (script: string): boolean =>
        commands.some((c) => c.includes('uv run') && c.includes(`scripts/${script}`) && c.includes(`cinna-plugins/agents/`) && c.includes(`skills/${skill}`))
      expect(ran('validate') || ran('package'), 'a command runs the skill\'s validate or package script').toBe(true)
      const written = agentFiles(agent.path).filter((path) => statSync(path).mtimeMs >= startedAt)
      test.info().annotations.push({ type: 'files written', description: written.map((p) => relative(agent.path, p)).join('\n').slice(0, 2000) })
      const zips = written.filter((path) => path.endsWith('.zip'))
      expect(zips, 'the agent wrote one theme zip').toHaveLength(1)
      expect(written.some((path) => path.endsWith('/preview.html')), 'the skill\'s preview script wrote preview.html').toBe(true)
      zip = readFileSync(zips[0])
      zipName = zips[0].split('/').pop()!
      const theme = JSON.parse(execFileSync('unzip', ['-p', zips[0], 'theme.json'], { encoding: 'utf8' }))
      expect(theme.schema).toBe('cinna.brand-theme/1')
      expect(theme.name, 'the agent used the theme name it was given').toBe(themeName)
      // A turn with the skill on the branding agent links it nowhere else.
      expect(await linked(other.id, other.path), 'the other agent after the turn').toEqual(NOT_LINKED)
    })

    let doc: Served
    await test.step('the admin uploads the zip as package (no errors) and publishes it', async () => {
      const revision = await publish(fixture, await uploadZipDraft(fixture, zip, zipName))
      const now = await served(fixture)
      expect(now.etag).toBe(`"${revision}"`)
      doc = now.doc!
      expect(doc.theme.name).toBe(themeName)
      expect(doc.theme.logo?.dark?.type, 'a dark logo from the brandbook, as an SVG').toBe('image/svg+xml')
      expect(doc.theme.logo?.light?.type, 'a light logo from the brandbook, as an SVG').toBe('image/svg+xml')
      for (const mode of MODES) expect(doc.theme.modes[mode].accent).not.toBe(STOCK_ACCENT[mode])
      test.info().annotations.push({ type: 'generated theme', description: JSON.stringify({ accents: { dark: doc.theme.modes.dark.accent, light: doc.theme.modes.light.accent }, heading: doc.theme.copy?.newChatHeading ?? null, background: Object.fromEntries(MODES.map((m) => [m, doc.theme.background?.[m]?.type ?? null])) }) })
    })

    await test.step('a switch away and back (an activation) puts the generated look on A\'s app, in both modes', async () => {
      const page = a.page
      const guest = await guestName(page)
      const me = await currentName(page)
      await switchTo(page, me, guest)
      await switchTo(page, guest, me)
      await expect(page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 30_000 })
      // Off the agent's page: the new-chat screen shows the brand logo and heading.
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      await expectBrand(fixture, page, doc, 'dark')
      await expectBrand(fixture, page, doc, 'light')
    })

    await unpublish(fixture)
    passed = true
  } finally {
    if (!passed) {
      try {
        writeFileSync(test.info().outputPath('a-screen.yaml'), await a.page.locator('body').ariaSnapshot())
        await a.page.screenshot({ path: test.info().outputPath('a-screen.png') })
      } catch {
        // the app may be gone already
      }
    }
    await a.close().catch(() => {})
    const { removed, realAgentsHomeUnchanged } = endRealLogin(login, a.sandbox.home, realRun)
    test.info().annotations.push({ type: 'real-login cleanup', description: removed.join('\n') })
    try {
      execFileSync('chmod', ['-R', 'u+w', a.sandbox.root], { stdio: 'ignore' })
    } catch {
      // already gone
    }
    rmSync(a.sandbox.root, { recursive: true, force: true })
    if (packageUuid) {
      // A's reported local install may hold it (409); `live-brand-theme.py cleanup` removes it after the people.
      const r = await coreCall(fixture, fixture.admin.token, `/catalog/items/${packageUuid}`, { method: 'DELETE' }).catch((error) => ({ status: 0, body: String(error) }))
      test.info().annotations.push({ type: 'skill delete', description: `${skill}: HTTP ${r.status}` })
    }
    expect(realAgentsHomeUnchanged, 'the real ~/CinnaAgents and ~/Documents/CinnaAgents are untouched').toBe(true)
  }
})
