import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { repoRoot } from '../playwright.config'
import { test, expect, launch, makeSandbox, type Sandbox } from '../fixtures/app'
import { liveCinnaConfig, preflight, signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'
import { mintDesktopTokens, type SharingPerson, type TeamFixtureBase } from '../fixtures/liveTeamSharing'

/**
 * Phase 2d timed due dates across two devices, through a **real** cinna-core's
 * end-to-end-encrypted app sync.
 *
 * ```
 * npx electron-vite build
 * set -a; source <file holding the local admin credentials>; set +a
 * CINNA_E2E_INTEGRATION=1 CINNA_E2E_SERVER_URL=http://localhost:8000 \
 *   CINNA_E2E_EMAIL="$CINNA_LOCAL_ADMIN_EMAIL" CINNA_E2E_PASSWORD="$CINNA_LOCAL_ADMIN_PASSWORD" \
 *   npx playwright test -c e2e/playwright.config.ts e2e/specs/cinna-integration-notes-timed.spec.ts
 * ```
 * or `make e2e-integration-notes` with the same three `CINNA_E2E_*` variables
 * exported. Skips unless `CINNA_E2E_INTEGRATION=1` and all three are set.
 *
 * ## The account
 *
 * The `CINNA_E2E_*` credentials must be a **superuser** and are used for one
 * thing only: creating a throwaway user (`POST /users/`, email
 * `e2e-phase2d-<time>-<hex>@example.com`, full name `E2E fixture phase2d
 * (delete me)`) and deleting exactly that id afterwards (`DELETE /users/{id}`,
 * then `GET /users/{id}` must answer 404). Sync encryption is initialized on
 * the throwaway account, never on the admin's.
 *
 * ## What is real
 *
 * Two apps, each in its own sandbox (`HOME` + `userData`), signed in to the
 * throwaway account with desktop tokens minted through core's real desktop
 * OAuth (only the consent click is done over the API, `mintDesktopTokens`).
 *
 * - **A (writer)**, `TZ=Europe/Berlin`, en-GB, 24-hour: initializes sync over
 *   `sync.init()` (arrange; the recovery phrase it returns is what the user
 *   would copy from the backup screen) and creates the note over `notes.create`
 *   with mobile's three writer forms (floating, offset-pinned, zone-pinned).
 *   It is pushed encrypted; core holds only ciphertext.
 * - **B (reader)**, `TZ=America/New_York`, en-US, `CINNA_E2E_HOUR_CYCLE=h12`:
 *   a fresh device on an initialized account, so the login-time Cloud Sync
 *   modal offers restore; the test drives it through the UI — **Use recovery
 *   key**, the phrase, **Restore** — then opens the pulled note and checks
 *   the three chips, computed here from a fixed table (not the app's
 *   formatter). B then edits the body in its textarea (appends one line), and
 *   blurs; its own debounced cycle pushes.
 * - A pulls (`sync.syncNow`) until its stored body equals the original bytes
 *   plus the appended line exactly.
 * - A trashes and permanently deletes the note; core's record turns into a
 *   tombstone and B's pull drops the note.
 *
 * What it does not prove: the mobile app itself (the note is written by a
 * desktop with mobile's token forms, so the wire and the crypto are the
 * desktop's on both ends), pairing (restore uses the recovery phrase), and the
 * browser consent page.
 *
 * B's chip screenshot is written to the test's output dir and copied to
 * `drafts/phase2d/integration/` (gitignored).
 */

const config = liveCinnaConfig()
const ENABLED = process.env.CINNA_E2E_INTEGRATION === '1' && config !== null

const BODY = [
  '- [ ] Call mom due:2026-11-16T18:00',
  '- [ ] Call with London due:2026-11-20T15:00+00:00',
  '- [ ] Standup with Berlin due:2026-11-21T09:00+01:00[Europe/Berlin]'
].join('\n')
const APPENDED = '\n- [ ] Added on B'
const TITLE = 'Phase 2d from mobile'

const B_ZONE = 'America/New_York'
const B_ENV = { TZ: B_ZONE, CINNA_E2E_HOUR_CYCLE: 'h12' }
const B_ARGS = ['--lang=en-US']
const A_ENV = { TZ: 'Europe/Berlin', CINNA_E2E_HOUR_CYCLE: 'h23' }
const A_ARGS = ['--lang=en-GB']

// ---- expected labels, from fixed tables ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')

function wallIn(instant: number, zone: string): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}

const dayMs = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))

function dayLabel(day: string, today: string): string {
  const d = Math.round((dayMs(day) - dayMs(today)) / 86_400_000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d === -1) return 'Yesterday'
  const label = `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`
  return day.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${day.slice(0, 4)}`
}

/** en-US 12-hour, as B's clock shows a time. */
const clock12 = (hour: number, minute: number): string => `${hour % 12 === 0 ? 12 : hour % 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`

function floating(date: string, hour: number, minute: number, today: string): { label: string; day: string } {
  return { label: `${dayLabel(date, today)} ${clock12(hour, minute)}`, day: date }
}

function pinned(date: string, hour: number, minute: number, offsetMinutes: number, origin: string, today: string): { label: string; day: string } {
  const instant = dayMs(date) + (hour * 60 + minute - offsetMinutes) * 60_000
  const shown = wallIn(instant, B_ZONE)
  const shownOffset = Math.round((dayMs(shown.day) + (shown.hour * 60 + shown.minute) * 60_000 - instant) / 60_000)
  let label = `${dayLabel(shown.day, today)} ${clock12(shown.hour, shown.minute)}`
  if (shownOffset !== offsetMinutes) {
    const weekday = date === shown.day ? '' : `${WEEKDAYS[new Date(dayMs(date)).getUTCDay()]} `
    label += ` (${weekday}${clock12(hour, minute)} ${origin})`
  }
  return { label, day: shown.day }
}

// ---- core, as the admin and as the throwaway user ----

interface Throwaway extends SharingPerson {
  password: string
}

async function api(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const live = config as LiveCinnaConfig
  const response = await fetch(`${live.serverUrl}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** Every `note` record core holds for the user, as the pull answers them. */
async function serverNotes(token: string): Promise<Array<{ client_entity_id: string; deleted: boolean; payload_ciphertext: string | null }>> {
  const out: Array<{ client_entity_id: string; deleted: boolean; payload_ciphertext: string | null }> = []
  let cursor = 0
  for (;;) {
    const page = await api(token, '/app-sync/pull', { method: 'POST', body: { cursor, collections: ['note'], limit: 500 } })
    if (page.status !== 200) throw new Error(`app-sync pull answered HTTP ${page.status}`)
    out.push(...page.body.changes)
    cursor = page.body.next_cursor
    if (!page.body.has_more) return out
  }
}

let user: Throwaway | null = null
let deletion: { deleteStatus: number; afterStatus: number } | null = null

// ---- one device: sandbox, process, Cinna profile ----

class Device {
  private current: { electronApp: ElectronApplication; page: Page } | null = null
  readonly sandbox: Sandbox = makeSandbox()

  constructor(
    readonly label: 'A' | 'B',
    private readonly args: readonly string[],
    private readonly env: Readonly<Record<string, string>>
  ) {}

  get page(): Page {
    if (!this.current) throw new Error(`${this.label} is not running`)
    return this.current.page
  }

  get electronApp(): ElectronApplication {
    if (!this.current) throw new Error(`${this.label} is not running`)
    return this.current.electronApp
  }

  async close(): Promise<void> {
    if (this.current) await this.current.electronApp.close()
    this.current = null
  }

  private async start(): Promise<void> {
    this.current = await launch(this.sandbox, this.args, this.env)
    const skip = this.page.getByRole('button', { name: 'Skip for now' })
    const shell = this.page.getByRole('button', { name: 'Chats', exact: true })
    await skip.or(shell).first().waitFor({ timeout: 60_000 })
    if (await skip.isVisible()) await skip.click()
    await shell.waitFor()
  }

  /** A fresh desktop pair sealed into this profile with the app's own safeStorage. */
  private async writeTokens(person: Throwaway): Promise<void> {
    const tokens = await mintDesktopTokens({ server: (config as LiveCinnaConfig).serverUrl } as TeamFixtureBase, person)
    const userId = await this.page.evaluate(async (email) => (await window.api.auth.listUsers()).find((u) => u.username === email)?.id ?? null, person.email)
    if (!userId) throw new Error(`${this.label} has no profile for the throwaway user`)
    await this.electronApp.evaluate(
      async ({ app, safeStorage }, input) => {
        if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
        const accessEnc = await safeStorage.encryptStringAsync(input.accessToken)
        const refreshEnc = await safeStorage.encryptStringAsync(input.refreshToken)
        const req = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
        try {
          db.prepare(
            `UPDATE users SET type = 'cinna_user', cinna_server_url = ?, cinna_client_id = ?, cinna_full_name = ?,
             cinna_hosting_type = 'self_hosted', cinna_access_token_enc = ?, cinna_refresh_token_enc = ?,
             cinna_token_expires_at = ? WHERE id = ?`
          ).run(input.server, input.clientId, input.name, accessEnc, refreshEnc, Date.now() + (input.expiresIn - 60) * 1000, input.userId)
        } finally {
          db.close()
        }
      },
      { ...tokens, userId, server: (config as LiveCinnaConfig).serverUrl, name: person.name, userData: this.sandbox.userData }
    )
  }

  /** First launch: a profile linked to the throwaway account, Notes on, then a restart. */
  async setUp(person: Throwaway): Promise<void> {
    await this.start()
    const registered = await this.page.evaluate(
      (p) => window.api.auth.register({ accountType: 'local', username: p.email, displayName: p.name }),
      { email: person.email, name: person.name }
    )
    if (!registered.success || !registered.user) throw new Error(`could not register ${this.label}'s profile`)
    await this.writeTokens(person)
    const logged = await this.page.evaluate((id) => window.api.auth.login({ userId: id }), registered.user.id)
    if (!logged.success) throw new Error(`could not activate ${this.label}'s profile`)
    await this.page.evaluate(async () => {
      await window.api.settings.set('localAgentsDefaultEngine', 'opencode')
      await window.api.settings.set('notesCapability', 'on')
    })
    await this.writeTokens(person)
    await this.close()
    await this.start()
    const current = await this.page.evaluate(() => window.api.auth.getCurrent())
    expect(current?.type).toBe('cinna_user')
  }

  async dispose(failed: boolean, outputPath: (name: string) => string): Promise<string | null> {
    if (failed && this.current) {
      try {
        writeFileSync(outputPath(`${this.label}-screen.yaml`), await this.page.locator('body').ariaSnapshot())
        await this.page.screenshot({ path: outputPath(`${this.label}-screen.png`) })
      } catch {
        // the app may be gone already
      }
    }
    await this.close().catch(() => {})
    if (failed) return this.sandbox.root
    try {
      execFileSync('chmod', ['-R', 'u+w', this.sandbox.root], { stdio: 'ignore' })
    } catch {
      // nothing read-only
    }
    rmSync(this.sandbox.root, { recursive: true, force: true })
    return null
  }
}

test.describe('Phase 2d timed dues across two devices (real cinna-core)', () => {
  test.skip(!ENABLED, 'set CINNA_E2E_INTEGRATION=1 and CINNA_E2E_SERVER_URL / _EMAIL / _PASSWORD (a superuser on a local cinna-core)')

  test.beforeAll(async () => {
    const live = config as LiveCinnaConfig
    const ready = await preflight(live)
    if (!ready.ok) throw new Error(`live cinna-core not usable: ${ready.reason}`)
    const admin = await signIn(live)
    const email = `e2e-phase2d-${Date.now()}-${randomBytes(3).toString('hex')}@example.com`
    const password = `${randomBytes(18).toString('base64url')}Aa1!`
    const created = await api(admin, '/users/', {
      method: 'POST',
      body: { email, password, full_name: 'E2E fixture phase2d (delete me)', is_active: true, is_superuser: false }
    })
    if (created.status !== 200) throw new Error(`could not create the throwaway user: HTTP ${created.status} ${JSON.stringify(created.body?.detail ?? '')}`)
    const token = await signIn({ ...live, email, password })
    user = { id: created.body.id, email, name: 'E2E fixture phase2d (delete me)', token, password }
  })

  test.afterAll(async () => {
    if (!user) return
    const live = config as LiveCinnaConfig
    const admin = await signIn(live)
    // Exactly the id this run created, and nothing else.
    const del = await api(admin, `/users/${user.id}`, { method: 'DELETE' })
    const after = await api(admin, `/users/${user.id}`)
    deletion = { deleteStatus: del.status, afterStatus: after.status }
    console.log(`throwaway user cleanup: DELETE /users/<id> → ${del.status}, GET after → ${after.status}`)
    user = null
    expect(deletion).toEqual({ deleteStatus: 200, afterStatus: 404 })
  })

  test('a mobile-form note reads as chips on B, B edits keep the tokens, A pulls the exact bytes', async ({}, testInfo) => {
    test.setTimeout(6 * 60_000)
    const person = user as Throwaway
    const a = new Device('A', A_ARGS, A_ENV)
    const b = new Device('B', B_ARGS, B_ENV)
    let noteId = ''
    let finished = false
    try {
      let mnemonic = ''
      await test.step('A signs in, initializes sync and writes the note', async () => {
        await a.setUp(person)
        const init = await a.page.evaluate(() => window.api.sync.init())
        mnemonic = init.recoveryMnemonic
        expect(mnemonic.split(/\s+/)).toHaveLength(24)
        const state = await a.page.evaluate(() => window.api.sync.getState())
        expect({ initialized: state.initialized, locked: state.locked }).toEqual({ initialized: true, locked: false })
        const note = await a.page.evaluate((input) => window.api.notes.create(input), { title: TITLE, body: BODY })
        noteId = note.id
        expect(note.body).toBe(BODY)
        await expect
          .poll(async () => {
            await a.page.evaluate(() => window.api.sync.syncNow())
            return (await serverNotes(person.token)).filter((r) => r.client_entity_id === noteId && !r.deleted).length
          }, { timeout: 60_000, message: 'A pushes the note to core' })
          .toBe(1)
        // Zero-knowledge: core holds the record, not the text.
        const record = (await serverNotes(person.token)).find((r) => r.client_entity_id === noteId)
        expect(record?.payload_ciphertext ?? '').not.toContain('due:')
      })

      await test.step('B signs in and restores with the recovery key through the Cloud Sync prompt', async () => {
        await b.setUp(person)
        const seen = await b.page.evaluate(() => ({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language }))
        expect(seen).toEqual({ zone: B_ZONE, language: 'en-US' })
        await b.page.getByRole('button', { name: 'Use recovery key', exact: true }).click({ timeout: 30_000 })
        await b.page.getByPlaceholder('Enter your 24-word recovery phrase', { exact: true }).fill(mnemonic)
        await b.page.getByRole('button', { name: 'Restore', exact: true }).click()
        await expect(b.page.getByPlaceholder('Enter your 24-word recovery phrase', { exact: true })).toBeHidden({ timeout: 30_000 })
        const state = await b.page.evaluate(() => window.api.sync.getState())
        expect({ initialized: state.initialized, locked: state.locked }).toEqual({ initialized: true, locked: false })
      })

      const today = wallIn(Date.now(), B_ZONE).day
      const expected = [
        floating('2026-11-16', 18, 0, today),
        pinned('2026-11-20', 15, 0, 0, 'UTC', today),
        pinned('2026-11-21', 9, 0, 60, 'Berlin', today)
      ]
      const readView = b.page.locator('.markdown-body')

      await test.step('B opens the pulled note: three chips in its zone and clock, no raw token', async () => {
        await b.page.getByRole('button', { name: 'Notes', exact: true }).click()
        await b.page.getByText(TITLE, { exact: true }).click({ timeout: 60_000 })
        const chips = readView.locator('[data-note-due]')
        await expect(chips).toHaveCount(3)
        const labels = (await chips.allTextContents()).map((t) => t.replace(/\s/g, ' '))
        expect(labels).toEqual(expected.map((e) => e.label))
        for (const [i, e] of expected.entries()) {
          await expect(chips.nth(i)).toHaveAttribute('data-note-due', e.day)
          await expect(chips.nth(i)).toHaveAttribute('data-tone', e.day < today ? 'overdue' : 'upcoming')
        }
        await expect(readView).not.toContainText('due:')
        await expect(readView).toContainText('Call with London')
        const shot = testInfo.outputPath('B-chips.png')
        await readView.screenshot({ path: shot })
        const drafts = join(repoRoot, 'drafts', 'phase2d', 'integration')
        mkdirSync(drafts, { recursive: true })
        copyFileSync(shot, join(drafts, 'B-chips.png'))
      })

      await test.step('B appends a line in the textarea and blurs; its own cycle pushes', async () => {
        const box = await readView.boundingBox()
        if (!box) throw new Error('no read view')
        // The empty space under the list: not a chip, a checkbox or a link.
        await readView.click({ position: { x: 8, y: box.height - 8 } })
        const textarea = b.page.getByPlaceholder(/^Write in markdown\./)
        await expect(textarea).toBeFocused()
        await expect(textarea).toHaveValue(BODY)
        await b.page.keyboard.type(APPENDED)
        await textarea.blur()
        await expect(readView.locator('[data-note-due]')).toHaveCount(3)
        await expect(readView).toContainText('Added on B')
        await expect
          .poll(() => b.page.evaluate((id) => window.api.notes.get(id).then((n) => n.body), noteId))
          .toBe(BODY + APPENDED)
      })

      await test.step('A pulls the exact bytes: original token lines plus the appended one', async () => {
        await expect
          .poll(async () => {
            await a.page.evaluate(() => window.api.sync.syncNow())
            return a.page.evaluate((id) => window.api.notes.get(id).then((n) => n.body), noteId)
          }, { timeout: 90_000, message: 'A pulls B’s edit' })
          .toBe(BODY + APPENDED)
      })

      await test.step('A deletes the note; core keeps a tombstone and B drops it', async () => {
        await a.page.evaluate(async (id) => {
          await window.api.notes.delete(id)
          await window.api.notes.permanentDelete(id)
        }, noteId)
        await expect
          .poll(async () => {
            await a.page.evaluate(() => window.api.sync.syncNow())
            return (await serverNotes(person.token)).filter((r) => r.client_entity_id === noteId).map((r) => r.deleted)
          }, { timeout: 60_000, message: 'core holds only a tombstone for the note' })
          .toEqual([true])
        await expect
          .poll(async () => {
            await b.page.evaluate(() => window.api.sync.syncNow())
            return b.page.evaluate(async (id) => {
              const live = await window.api.notes.list()
              const trash = await window.api.notes.trashList()
              return [...live, ...trash].some((n) => n.id === id)
            }, noteId)
          }, { timeout: 60_000, message: 'B drops the deleted note' })
          .toBe(false)
      })
      finished = true
    } finally {
      const failed = !finished
      for (const device of [a, b]) {
        const kept = await device.dispose(failed, (name) => testInfo.outputPath(name))
        if (kept) testInfo.annotations.push({ type: `sandbox ${device.label}`, description: kept })
      }
    }
  })
})
