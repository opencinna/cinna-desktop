import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { repoRoot } from '../playwright.config'
import { expect, test, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'

/**
 * Brand themes (plans/brand-themes/desktop.md "Tests"): a Cinna profile shows
 * its server's published theme, a local profile shows stock Cinna, and a
 * switch back to the Cinna profile with its server down shows the cached
 * brand on the first frame the profile is on screen.
 *
 * ## What is real and what is not
 *
 * Real: `brandThemeService` (the fetch with `If-None-Match`, the asset fetch
 * by sha, `parse.ts`'s safety checks, the cache in `brandThemes`, the
 * `applyForProfile` publish on activation, the resolved `data:` URLs), the
 * renderer's `brandTheme.store` and `brandThemeCss` sheet, the new-chat logo
 * and heading in `ChatWorkspace`, the footer user menu's profile switch and
 * the Interface menu's Dark/Light switch.
 * Faked: cinna-core — a loopback server answering `GET /api/v1/brand-theme`
 * (ETag `"<revision>"`, 304 on a match) and
 * `GET /api/v1/brand-theme/assets/<sha256>` from the shared fixtures in
 * `src/shared/brandTheme/fixtures/`, and 404 for everything else; and the
 * sign-in (`linkSandboxAccount` writes the server and tokens into the
 * sandbox DB).
 *
 * The theme is `valid/background-light-null` (dark background image, light
 * background null) with two edits made here, never on disk: its accents are
 * changed off the stock values (the fixture's are stock's own `#d97a4a` /
 * `#2e88b8`, which would prove nothing), and `valid/full`'s logo pair and a
 * `newChatHeading` are added so the new-chat screen has something to show.
 *
 * ## What it does not prove
 *
 * The real OAuth sign-in, a theme the server changes mid-session (revision
 * bump while the profile is active), 204/404 forgetting a theme, the tray
 * popup, dashboard frames, or the password lock's override. The no-flash check
 * samples one value per animation frame; a style that is wrong between two
 * frames and fixed before paint is invisible to it, as it is to the user.
 *
 * Theme Default: a default mode with an engine colour adopts the brand's accent
 * once, with the composer following in the running window, and a colour picked
 * afterwards survives a restart. Its row is a saved mode, so the managed row and
 * the account-config path are left to the unit tests.
 *
 * The last test is a measurement, not an assertion: it logs how long a switch
 * to a profile whose dark background is a ~3 MB PNG takes to apply.
 */

const FIXTURES = join(repoRoot, 'src/shared/brandTheme/fixtures/valid')
const STOCK_ACCENT = { dark: '#d97a4a', light: '#2e88b8' } as const
const BRAND_ACCENT = { dark: '#3d7be0', light: '#8a3ffc' } as const
const BRAND_HEADING = 'What can Brandtest help with?'
const STOCK_HEADING = 'What can I help with?'
const BRAND_USER = 'brandlocal'
const BIG_USER = 'bigbrand'

type Mode = 'dark' | 'light'
interface AssetRef { url: string; type: string; bytes: number; sha256: string; width?: number; height?: number }
type Served = { schema: string; revision: number; theme: Record<string, unknown> & { modes: Record<Mode, Record<string, string>> }; assets?: Record<string, unknown> }

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const dataUrl = (type: string, bytes: Buffer): string => `data:${type};base64,${bytes.toString('base64')}`

/** Every fixture asset by sha256: `assets/` files by their hash, then `served/assets/<sha>` (core's rewritten bytes) over them. */
function fixtureAssets(): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const name of readdirSync(FIXTURES)) {
    const raw = join(FIXTURES, name, 'assets')
    if (existsSync(raw)) for (const file of readdirSync(raw)) {
      const bytes = readFileSync(join(raw, file))
      out.set(sha256(bytes), bytes)
    }
    const served = join(FIXTURES, name, 'served', 'assets')
    if (existsSync(served)) for (const sha of readdirSync(served)) out.set(sha, readFileSync(join(served, sha)))
  }
  return out
}

const readServed = (name: string): Served => JSON.parse(readFileSync(join(FIXTURES, name, 'served', 'served.json'), 'utf8')) as Served

/** `valid/background-light-null`, accents off stock, with `valid/full`'s logo pair and a heading. */
function brandTheme(): Served {
  const served = readServed('background-light-null')
  const full = readServed('full')
  served.theme.name = 'Brandtest'
  served.theme.modes.dark.accent = BRAND_ACCENT.dark
  served.theme.modes.light.accent = BRAND_ACCENT.light
  served.theme.logo = full.theme.logo
  served.theme.copy = { newChatHeading: BRAND_HEADING }
  return served
}

// ---------------------------------------------------------------------------
// A valid PNG of random RGB pixels, for the measurement.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function randomPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height)
  let seed = 0x2545f491
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1)
    rows[at] = 0 // filter: none
    for (let i = 1; i <= width * 3; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      rows[at + i] = seed & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// The fake core.

interface FakeCore { host: string; requests: string[]; close(): Promise<void> }

/** `themeGate` holds the theme document (not 304s or assets) until it resolves. */
async function fakeBrandCore(served: Served, assets: Map<string, Buffer>, themeGate?: Promise<void>): Promise<FakeCore> {
  const requests: string[] = []
  const etag = `"${served.revision}"`
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push(`${req.method} ${path}`)
    if (req.method === 'GET' && path === '/api/v1/brand-theme') {
      if (themeGate) await themeGate
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', etag })
      res.end(JSON.stringify(served))
      return
    }
    const asset = /^\/api\/v1\/brand-theme\/assets\/([0-9a-f]{64})$/.exec(path)
    if (req.method === 'GET' && asset && assets.has(asset[1])) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(assets.get(asset[1]))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'Not Found' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closed = false
  return {
    host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

// ---------------------------------------------------------------------------
// UI helpers.

async function currentName(cinna: CinnaApp): Promise<string> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  if (!user) throw new Error('no current profile')
  return user.displayName
}

/** The guest's display name: rotated on every launch, so read after each one. */
async function guestName(cinna: CinnaApp): Promise<string> {
  const users = await cinna.page.evaluate(() => window.api.auth.listUsers())
  const guest = users.find((user) => user.id === '__default__')
  if (!guest) throw new Error('no guest profile')
  return guest.displayName
}

/** The footer avatar: named by its initial, so found by its `title` (the display name). */
const userMenuTrigger = (cinna: CinnaApp, name: string) => cinna.page.getByTitle(name, { exact: true })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * A Profiles row: the guest's reads `<name> Guest`, a named profile's `<initial> <name>`
 * (a Cinna row also holds a nested button named by its server URL).
 */
const profileRow = (cinna: CinnaApp, name: string) =>
  cinna.page.getByRole('button', { name: new RegExp(`^(?:${escapeRe(name.charAt(0).toUpperCase())} )?${escapeRe(name)}(?: Guest)?$`) })

async function openUserMenu(cinna: CinnaApp, shown: string): Promise<void> {
  await userMenuTrigger(cinna, shown).click()
  await expect(cinna.page.getByRole('button', { name: 'Add Account', exact: true })).toBeVisible()
}

async function switchTo(cinna: CinnaApp, from: string, to: string): Promise<void> {
  await openUserMenu(cinna, from)
  await profileRow(cinna, to).click()
  await expect(userMenuTrigger(cinna, to)).toBeVisible()
  await expect.poll(() => currentName(cinna)).toBe(to)
}

/** User menu → Add Account → Local Account → Username → Create; the new profile is active. */
async function createLocalProfile(cinna: CinnaApp, from: string, name: string): Promise<void> {
  await openUserMenu(cinna, from)
  await cinna.page.getByRole('button', { name: 'Add Account', exact: true }).click()
  await cinna.page.getByRole('button', { name: /^Local Account/ }).click()
  await cinna.page.getByPlaceholder('Username', { exact: true }).fill(name)
  await cinna.page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(userMenuTrigger(cinna, name)).toBeVisible()
  await expect.poll(() => currentName(cinna)).toBe(name)
}

/** Footer `Interface` menu → `Switch to dark` / `Switch to light`. */
async function useTheme(cinna: CinnaApp, theme: Mode): Promise<void> {
  const html = cinna.page.locator('html')
  if ((await html.getAttribute('data-theme')) === theme) return
  const trigger = cinna.page.getByRole('button', { name: 'Interface', exact: true })
  await trigger.click()
  await cinna.page.getByRole('button', { name: `Switch to ${theme}`, exact: true }).click()
  await expect(html).toHaveAttribute('data-theme', theme)
  // Escape does not close this menu; its trigger does.
  await trigger.click()
  await expect(cinna.page.getByRole('button', { name: /^Switch to (light|dark)$/ })).toHaveCount(0)
}

/** Computed `--color-accent` on `<html>`. */
const accent = (cinna: CinnaApp) =>
  cinna.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())

/**
 * Body's computed `background-image`, described briefly: `none`, `brand <mime>`
 * when it is exactly `url("<expected>")`, `data <prefix>` for another data URL,
 * or the URL for anything else (the stock mesh is a file in `out/`).
 */
const bodyBackground = (cinna: CinnaApp, expected: string | null) =>
  cinna.page.evaluate((want) => {
    const image = getComputedStyle(document.body).backgroundImage
    if (image === 'none') return 'none'
    if (want && image === `url("${want}")`) return `brand ${want.slice(5, want.indexOf(';'))}`
    if (image.startsWith('url("data:')) return `data ${image.slice(0, 40)}`
    return image.replace(/^url\("(?:.*\/)?([^/"]+)"\)$/, '$1')
  }, expected)

/** The sidebar card and its active tab, whose right edge is drawn over the card. */
const sidebarSurfaces = (cinna: CinnaApp) =>
  cinna.page.evaluate(() => {
    const card = getComputedStyle(document.querySelector('.app-sidebar')!)
    const tab = document.querySelector('.sidebar-tab[aria-pressed="true"]')!
    return {
      card: card.backgroundColor,
      tab: getComputedStyle(tab).backgroundColor,
      seam: getComputedStyle(tab, '::after').backgroundColor,
      cardBorder: card.borderTopColor,
      tabBorder: getComputedStyle(tab).borderTopColor
    }
  })
const brandLogo = (cinna: CinnaApp) => cinna.page.getByTestId('brand-logo')
const heading = (cinna: CinnaApp) => cinna.page.getByRole('heading', { level: 1 })

// ---------------------------------------------------------------------------

interface SwitchRecord {
  /** One sample per animation frame, from before the click until the brand held 30 frames. */
  frames: { accent: string; brand: boolean; profile: boolean }[]
  /**
   * The DOM's state after every mutation, deduplicated: `P` the footer names the
   * Cinna profile, `B` `<html data-brand>` is set (`--` neither). Synchronous,
   * so it sees a committed state whether or not a frame painted it.
   */
  order: string[]
}

/** Switch guest → the Cinna profile while recording every frame and every DOM commit. */
async function recordSwitchTo(cinna: CinnaApp, guest: string): Promise<SwitchRecord> {
  const page = cinna.page
  await page.evaluate((name) => {
    const w = window as unknown as { __rec: SwitchRecord & { done: boolean } }
    const rec: SwitchRecord & { done: boolean } = { frames: [], order: [], done: false }
    w.__rec = rec
    const profileShown = (): boolean => document.querySelector(`button[title="${name}"]`) !== null
    let held = 0
    const tick = (): void => {
      const frame = {
        accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
        brand: document.documentElement.hasAttribute('data-brand'),
        profile: profileShown()
      }
      rec.frames.push(frame)
      held = frame.profile && frame.brand ? held + 1 : 0
      if (held >= 30 || rec.frames.length > 3000) {
        rec.done = true
        observer.disconnect()
      } else requestAnimationFrame(tick)
    }
    const observer = new MutationObserver(() => {
      const label = `${profileShown() ? 'P' : '-'}${document.documentElement.hasAttribute('data-brand') ? 'B' : '-'}`
      if (rec.order[rec.order.length - 1] !== label) rec.order.push(label)
    })
    observer.observe(document, { subtree: true, childList: true, attributes: true })
    requestAnimationFrame(tick)
  }, BRAND_USER)
  await switchTo(cinna, guest, BRAND_USER)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __rec: { done: boolean } }).__rec.done), { timeout: 30_000 }).toBe(true)
  const rec = await page.evaluate(() => (window as unknown as { __rec: SwitchRecord }).__rec)
  const firstProfile = rec.frames.findIndex((f) => f.profile)
  const firstBrand = rec.frames.findIndex((f) => f.accent === BRAND_ACCENT.dark)
  const summary = `${rec.frames.length} frames; first with the Cinna profile on screen #${firstProfile}, first with the brand accent #${firstBrand}; DOM order ${rec.order.join(' → ')}`
  test.info().annotations.push({ type: 'switch record', description: summary })
  console.log(`brand-theme switch: ${summary}`)
  return rec
}

interface BrandArrange { core: FakeCore; guest: string; expectedLogo: Record<Mode, string>; expectedDarkBg: string; darkBgSha: string }

/** A local profile linked to the fake core, dark mode, relaunched into it. */
async function arrangeBrandProfile(cinna: CinnaApp): Promise<BrandArrange> {
  const served = brandTheme()
  const assets = fixtureAssets()
  const logo = served.theme.logo as Record<Mode, AssetRef>
  const darkBg = (served.theme.background as Record<Mode, AssetRef | null>).dark!
  const core = await fakeBrandCore(served, assets)
  await cinna.skipOnboarding()
  await useTheme(cinna, 'dark')
  await createLocalProfile(cinna, await currentName(cinna), BRAND_USER)
  await linkSandboxAccount(cinna, core.host)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await expect(userMenuTrigger(cinna, BRAND_USER)).toBeVisible()
  await expect.poll(() => currentName(cinna)).toBe(BRAND_USER)
  // The fetch on activation fills the cache.
  await expect(cinna.page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 30_000 })
  return {
    core,
    guest: await guestName(cinna),
    expectedLogo: { dark: dataUrl(logo.dark.type, assets.get(logo.dark.sha256)!), light: dataUrl(logo.light.type, assets.get(logo.light.sha256)!) },
    expectedDarkBg: dataUrl(darkBg.type, assets.get(darkBg.sha256)!),
    darkBgSha: darkBg.sha256
  }
}

test('a Cinna profile shows its server brand in both modes, a local profile stock, and the cached brand while the server is down', async ({ cinna }) => {
  test.setTimeout(150_000)
  let arranged: BrandArrange | null = null
  try {
    const { core, guest, expectedLogo, expectedDarkBg, darkBgSha } = (arranged = await arrangeBrandProfile(cinna))

    await test.step('1. dark: brand accent, brand logo and heading, the brand background image', async () => {
      const page = cinna.page
      expect(core.requests).toContain('GET /api/v1/brand-theme')
      expect(core.requests).toContain(`GET /api/v1/brand-theme/assets/${darkBgSha}`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect.poll(() => accent(cinna)).toBe(BRAND_ACCENT.dark)
      await expect(brandLogo(cinna)).toBeVisible()
      await expect(brandLogo(cinna)).toHaveAttribute('src', expectedLogo.dark)
      await expect(heading(cinna)).toHaveText(BRAND_HEADING)
      await expect.poll(() => bodyBackground(cinna, expectedDarkBg)).toBe('brand image/webp')
      // The active tab blends into the brand's card: no black strip over its edge.
      await expect
        .poll(async () => {
          const s = await sidebarSurfaces(cinna)
          return { tab: s.tab === s.card, seam: s.seam === s.card, border: s.tabBorder === s.cardBorder }
        })
        .toEqual({ tab: true, seam: true, border: true })
    })

    await test.step('1. light: brand accent, light logo, no background image (flat, not the stock mesh)', async () => {
      await useTheme(cinna, 'light')
      await expect.poll(() => accent(cinna)).toBe(BRAND_ACCENT.light)
      await expect(brandLogo(cinna)).toHaveAttribute('src', expectedLogo.light)
      await expect(heading(cinna)).toHaveText(BRAND_HEADING)
      await expect.poll(() => bodyBackground(cinna, null)).toBe('none')
      await useTheme(cinna, 'dark')
      await expect.poll(() => accent(cinna)).toBe(BRAND_ACCENT.dark)
    })

    await test.step('2. the guest profile is stock: no data-brand, stock accent, stock mesh, stock mark and heading', async () => {
      await switchTo(cinna, BRAND_USER, guest)
      const html = cinna.page.locator('html')
      await expect(html).not.toHaveAttribute('data-brand')
      await expect(cinna.page.locator('style#brand-theme')).toHaveCount(0)
      await expect.poll(() => accent(cinna)).toBe(STOCK_ACCENT.dark)
      await expect.poll(() => bodyBackground(cinna, expectedDarkBg)).toMatch(/^dark-background-gradient-mesh-1.*\.png$/)
      await expect(brandLogo(cinna)).toHaveCount(0)
      await expect(heading(cinna)).toHaveText(STOCK_HEADING)
      // Stock keeps its own glass: the rule applies under a brand only.
      await expect.poll(async () => (await sidebarSurfaces(cinna)).seam).toBe('rgba(0, 0, 0, 0.45)')
      await useTheme(cinna, 'light')
      await expect.poll(() => accent(cinna)).toBe(STOCK_ACCENT.light)
      await expect.poll(() => bodyBackground(cinna, null)).toMatch(/^light-background-gradient-mesh-1.*\.png$/)
      await useTheme(cinna, 'dark')
    })

    await test.step('3. server down, switch back: the cached brand, never the server, and no stock frame once it is up', async () => {
      await core.close()
      const before = core.requests.length
      const { frames } = await recordSwitchTo(cinna, guest)
      const firstBrand = frames.findIndex((f) => f.accent === BRAND_ACCENT.dark)
      expect(firstBrand).toBeGreaterThanOrEqual(0)
      // Before it only the guest's stock accent; from it on only the brand's.
      expect(new Set(frames.slice(0, firstBrand).map((f) => f.accent))).toEqual(new Set(firstBrand > 0 ? [STOCK_ACCENT.dark] : []))
      expect(frames.slice(firstBrand).filter((f) => f.accent !== BRAND_ACCENT.dark)).toEqual([])
      // From the cache: the server was never asked.
      expect(core.requests.length).toBe(before)
      await expect(brandLogo(cinna)).toHaveAttribute('src', expectedLogo.dark)
      await expect(heading(cinna)).toHaveText(BRAND_HEADING)
      await expect.poll(() => bodyBackground(cinna, expectedDarkBg)).toBe('brand image/webp')
    })
  } finally {
    await arranged?.core.close()
  }
})

test('3b. a switch to a cached Cinna profile commits that profile only together with its brand', async ({ cinna }) => {
  // The login mutation waits for the brand main announced before the reply
  // (`brandThemeSettled` in useAuth.ts), so the DOM never holds the Cinna
  // profile without its brand: no `P-` state, no frame of the stock accent.
  // Before that fix this was `-- → P- → PB` on every switch, painted in about
  // half of them.
  test.setTimeout(120_000)
  let arranged: BrandArrange | null = null
  try {
    const { core, guest } = (arranged = await arrangeBrandProfile(cinna))
    await switchTo(cinna, BRAND_USER, guest)
    await expect(cinna.page.locator('html')).not.toHaveAttribute('data-brand')
    await core.close()
    const { frames, order } = await recordSwitchTo(cinna, guest)
    expect(order, 'the Cinna profile committed without its brand').not.toContain('P-')
    expect(frames.filter((f) => f.profile && f.accent !== BRAND_ACCENT.dark), 'a frame showed the Cinna profile in stock colours').toEqual([])
  } finally {
    await arranged?.core.close()
  }
})

const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`
/** The new-chat composer's computed border colour. */
const composerBorder = (cinna: CinnaApp) =>
  cinna.page.locator('[data-ambient-card]:has(textarea)').evaluate((box) => getComputedStyle(box).borderTopColor)

test('Theme Default: a branded profile\u2019s default mode adopts the brand once, in the running window, and a later colour sticks', async ({ cinna }) => {
  test.setTimeout(120_000)
  const ORANGE = rgb('#f97316')
  let releaseTheme = (): void => {}
  const themeGate = new Promise<void>((resolve) => { releaseTheme = resolve })
  const core = await fakeBrandCore(brandTheme(), fixtureAssets(), themeGate)
  const MODE = 'Engine colour'
  const defaultMode = () => cinna.page.evaluate(async (name) => (await window.api.chatModes.list()).find((mode) => mode.name === name)!, MODE)
  try {
    await test.step('arrange: a Cinna profile whose default mode wears an engine colour, its brand held back', async () => {
      await cinna.skipOnboarding()
      await useTheme(cinna, 'dark')
      await createLocalProfile(cinna, await currentName(cinna), BRAND_USER)
      await cinna.page.evaluate((name) => window.api.chatModes.upsert({ name, colorPreset: 'orange', isDefault: true }), MODE)
      await linkSandboxAccount(cinna, core.host)
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await expect.poll(() => currentName(cinna)).toBe(BRAND_USER)
      await expect(cinna.page.locator('html')).not.toHaveAttribute('data-brand')
      await expect.poll(() => composerBorder(cinna)).toBe(ORANGE)
    })

    await test.step('the brand arrives: the composer takes its accent with no restart', async () => {
      releaseTheme()
      await expect(cinna.page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 30_000 })
      await expect.poll(() => composerBorder(cinna)).toBe(rgb(BRAND_ACCENT.dark))
      expect((await defaultMode()).colorPreset).toBe('theme')
    })

    await test.step('with no brand the same preset is simply the stock accent', async () => {
      const guest = await guestName(cinna)
      await switchTo(cinna, BRAND_USER, guest)
      await expect.poll(() => composerBorder(cinna)).toBe(rgb(STOCK_ACCENT.dark))
      await switchTo(cinna, guest, BRAND_USER)
      await expect.poll(() => composerBorder(cinna)).toBe(rgb(BRAND_ACCENT.dark))
    })

    await test.step('a colour the user picks since survives a restart and the sync that follows it', async () => {
      const row = await defaultMode()
      await cinna.page.evaluate((input) => window.api.chatModes.upsert({ ...input, colorPreset: 'orange', isDefault: true }), { id: row.id, name: MODE })
      // Saved over the raw API, which no hook refetches after: the restart below reads it.
      expect((await defaultMode()).colorPreset).toBe('orange')
      const before = core.requests.length
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await expect(cinna.page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 30_000 })
      // The activation's failed sync (this fake has no account config) reached its adoption call.
      await expect.poll(() => core.requests.slice(before).filter((request) => request.includes('account')).length).toBeGreaterThan(0)
      await expect.poll(() => composerBorder(cinna)).toBe(ORANGE)
      expect((await defaultMode()).colorPreset).toBe('orange')
    })
  } finally {
    releaseTheme()
    await core.close()
  }
})

test('measurement: switching to a profile whose dark background is a ~3 MB PNG', async ({ cinna }) => {
  test.setTimeout(240_000)
  const png = randomPng(1000, 1000)
  expect(png.length).toBeLessThanOrEqual(3 * 1024 * 1024)
  const sha = sha256(png)
  const served = brandTheme()
  const ref: AssetRef = { url: `/api/v1/brand-theme/assets/${sha}`, type: 'image/png', bytes: png.length, sha256: sha, width: 1000, height: 1000 }
  ;(served.theme.background as Record<Mode, AssetRef | null>).dark = ref
  if (served.assets) (served.assets as Record<string, unknown>)['background.dark'] = ref
  const assets = fixtureAssets()
  assets.set(sha, png)
  const expectedBg = dataUrl('image/png', png)
  const core = await fakeBrandCore(served, assets)
  const runs: { applyMs: number; brandAttrMs: number; firstFrameMs: number; longestFrameMs: number; longTasks: number[] }[] = []
  try {
    let guest = ''
    await test.step('arrange: the big-background profile cached, dark mode, on the guest', async () => {
      await cinna.skipOnboarding()
      guest = await currentName(cinna)
      await useTheme(cinna, 'dark')
      await createLocalProfile(cinna, guest, BIG_USER)
      await linkSandboxAccount(cinna, core.host)
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await expect.poll(() => currentName(cinna)).toBe(BIG_USER)
      guest = await guestName(cinna)
      await expect(cinna.page.locator('html')).toHaveAttribute('data-brand', '', { timeout: 60_000 })
      expect(core.requests).toContain(`GET /api/v1/brand-theme/assets/${sha}`)
      await expect.poll(() => bodyBackground(cinna, expectedBg)).toBe('brand image/png')
      await switchTo(cinna, BIG_USER, guest)
      await expect(cinna.page.locator('html')).not.toHaveAttribute('data-brand')
    })

    for (let run = 1; run <= 5; run++) {
      await test.step(`run ${run}: guest → ${BIG_USER}`, async () => {
        const page = cinna.page
        await openUserMenu(cinna, guest)
        // Armed with the menu open: the next click is the row's.
        await page.evaluate(() => {
          type M = { start: number | null; applied: number | null; appliedFrame: number | null; brandAttr: number | null; frames: number[]; longTasks: { start: number; duration: number }[]; done: boolean }
          const m: M = { start: null, applied: null, appliedFrame: null, brandAttr: null, frames: [], longTasks: [], done: false }
          ;(window as unknown as { __m: M }).__m = m
          document.addEventListener('click', () => { m.start ??= performance.now() }, { capture: true, once: true })
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) m.longTasks.push({ start: entry.startTime, duration: entry.duration })
          })
          observer.observe({ type: 'longtask' })
          const attr = new MutationObserver(() => {
            if (m.brandAttr === null && document.documentElement.hasAttribute('data-brand')) m.brandAttr = performance.now()
          })
          attr.observe(document.documentElement, { attributes: true, attributeFilter: ['data-brand'] })
          let after = 0
          const tick = (ts: number): void => {
            m.frames.push(ts)
            if (m.start !== null && m.applied === null && getComputedStyle(document.body).backgroundImage.startsWith('url("data:image/png')) {
              m.applied = performance.now()
              m.appliedFrame = ts
            }
            if (m.applied !== null && ++after > 10) {
              m.done = true
              observer.disconnect()
              attr.disconnect()
              return
            }
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        await profileRow(cinna, BIG_USER).click()
        await expect.poll(() => page.evaluate(() => (window as unknown as { __m: { done: boolean } }).__m.done), { timeout: 60_000 }).toBe(true)
        const m = await page.evaluate(() => (window as unknown as { __m: { start: number; applied: number; appliedFrame: number; brandAttr: number | null; frames: number[]; longTasks: { start: number; duration: number }[] } }).__m)
        const window_ = m.frames.filter((t) => t >= m.start - 50 && t <= m.appliedFrame + 50)
        let longest = 0
        for (let i = 1; i < window_.length; i++) longest = Math.max(longest, window_[i] - window_[i - 1])
        const firstFrame = m.frames.find((t) => t > m.applied) ?? m.appliedFrame
        runs.push({
          applyMs: m.applied - m.start,
          brandAttrMs: m.brandAttr === null ? NaN : m.brandAttr - m.start,
          firstFrameMs: firstFrame - m.start,
          longestFrameMs: longest,
          longTasks: m.longTasks.filter((t) => t.start + t.duration >= m.start && t.start <= m.applied).map((t) => Math.round(t.duration))
        })
        await expect(userMenuTrigger(cinna, BIG_USER)).toBeVisible()
        await expect.poll(() => bodyBackground(cinna, expectedBg)).toBe('brand image/png')
        await switchTo(cinna, BIG_USER, guest)
        await expect(cinna.page.locator('html')).not.toHaveAttribute('data-brand')
        await expect.poll(() => bodyBackground(cinna, null)).toMatch(/^dark-background-gradient-mesh-1.*\.png$/)
      })
    }
  } finally {
    await core.close()
  }
  const stats = (values: number[]): string => {
    const sorted = [...values].sort((a, b) => a - b)
    return `min ${sorted[0].toFixed(0)} / median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} / max ${sorted[sorted.length - 1].toFixed(0)} ms`
  }
  const lines = [
    `PNG ${png.length} bytes (${(png.length / 1048576).toFixed(2)} MiB), data URL ${expectedBg.length} chars`,
    `click → body background-image is the brand's: ${stats(runs.map((r) => r.applyMs))}`,
    `click → data-brand set: ${stats(runs.map((r) => r.brandAttrMs))}`,
    `click → first frame after it: ${stats(runs.map((r) => r.firstFrameMs))}`,
    `longest frame in that window: ${stats(runs.map((r) => r.longestFrameMs))}`,
    `long tasks per run (ms): ${runs.map((r) => `[${r.longTasks.join(', ')}]`).join(' ')}`,
    `raw apply ms: ${runs.map((r) => r.applyMs.toFixed(0)).join(', ')}`
  ]
  for (const line of lines) {
    test.info().annotations.push({ type: 'big background', description: line })
    console.log(`brand-theme measurement: ${line}`)
  }
})
