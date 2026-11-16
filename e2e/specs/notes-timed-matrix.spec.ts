import { test, expect } from '../fixtures/app'

/**
 * Timed due chips (Phase 2d) across device time zones, locales and the
 * 12/24-hour override: `make e2e-notes-matrix`.
 *
 * ## What is real and what is not
 *
 * Each case is its own app launch with `TZ=<zone>` in the environment and
 * `--lang=<locale>` on the command line (repeated on the relaunch that reads
 * the seeded note). The note is created over `note:create`; the read view's
 * remark plugin draws the chips. The 12/24-hour override comes from
 * `CINNA_E2E_HOUR_CYCLE` — the sandbox's stand-in for macOS's "24-hour time"
 * switch, which the sandbox never reads.
 *
 * ## What it proves, per case
 *
 * - The renderer runs in the zone and locale it was given:
 *   `navigator.language`, `Intl`'s default locale and its zone (`--lang=de-DE`
 *   reads `de`: Chromium falls back to its UI locale, still 24-hour).
 * - Chip labels for a floating today, a floating yesterday, a pinned
 *   Kiritimati item and a pinned Honolulu item. Expected labels are computed
 *   here: the wall clock with Node's `Intl` in an explicit zone, the clock form
 *   from a fixed table per locale (`3:00 PM` / `15:00`) — never from the app's
 *   own formatter.
 * - The origin `(… Kiritimati)` appears only when the device's offset differs
 *   (none in Pacific/Kiritimati), with the origin's English weekday when its day
 *   differs from the shown day.
 * - The day bucket (Today / Yesterday / Tomorrow) and the tone (`data-tone`:
 *   `overdue` for a day before today, else `upcoming`).
 *
 * One screenshot per case goes to the test's output dir.
 */

type Clock = 'h12' | 'h23'

interface Case {
  zone: string
  locale: string
  /** What the renderer reports for `--lang=<locale>`: Chromium maps `de-DE` to its `de` UI locale. */
  appLocale: string
  /** The clock form the locale (or override) must show. */
  clock: Clock
  /** `CINNA_E2E_HOUR_CYCLE`, when the case forces one. */
  override?: Clock
}

const ZONES = ['Europe/Berlin', 'America/New_York', 'Pacific/Kiritimati']
const LOCALES: Array<{ locale: string; appLocale: string; clock: Clock }> = [
  { locale: 'en-US', appLocale: 'en-US', clock: 'h12' },
  { locale: 'en-GB', appLocale: 'en-GB', clock: 'h23' },
  { locale: 'de-DE', appLocale: 'de', clock: 'h23' }
]
const CASES: Case[] = [
  ...ZONES.flatMap((zone) => LOCALES.map((l) => ({ zone, ...l }))),
  { zone: 'Europe/Berlin', locale: 'en-US', appLocale: 'en-US', clock: 'h23', override: 'h23' },
  { zone: 'America/New_York', locale: 'en-GB', appLocale: 'en-GB', clock: 'h12', override: 'h12' }
]

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')

/** The wall clock of `instant` in `zone`: date and hour/minute as numbers. */
function wallIn(instant: number, zone: string): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}

/** `day` (YYYY-MM-DD) moved by `delta` days. */
function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/** A time as the case's clock shows it, from a fixed table, not `Intl`. */
function clockText(hour: number, minute: number, c: Case): string {
  if (c.clock === 'h23') return `${pad(hour)}:${pad(minute)}`
  const h = hour % 12 === 0 ? 12 : hour % 12
  const period = hour < 12 ? 'AM' : 'PM'
  return `${h}:${pad(minute)} ${c.locale === 'en-GB' ? period.toLowerCase() : period}`
}

function bucket(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === shiftDay(today, -1)) return 'Yesterday'
  if (day === shiftDay(today, 1)) return 'Tomorrow'
  throw new Error(`unexpected day ${day} for today ${today}`)
}

/** A pinned item: written at `time` on `date` with `offset` minutes in `zone`. */
function pinnedExpectation(c: Case, today: string, date: string, time: string, offsetMinutes: number, city: string): { label: string; day: string } {
  const instant = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(time.slice(0, 2)), Number(time.slice(3, 5))) - offsetMinutes * 60_000
  const shown = wallIn(instant, c.zone)
  const shownOffset = Math.round((Date.UTC(Number(shown.day.slice(0, 4)), Number(shown.day.slice(5, 7)) - 1, Number(shown.day.slice(8, 10)), shown.hour, shown.minute) - instant) / 60_000)
  let label = `${bucket(shown.day, today)} ${clockText(shown.hour, shown.minute, c)}`
  if (shownOffset !== offsetMinutes) {
    const weekday = date === shown.day ? '' : `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} `
    label += ` (${weekday}${clockText(Number(time.slice(0, 2)), Number(time.slice(3, 5)), c)} ${city})`
  }
  return { label, day: shown.day }
}

for (const c of CASES) {
  test.describe(`${c.zone} × ${c.locale}${c.override ? ` + ${c.override}` : ''}`, () => {
    const env: Record<string, string> = { TZ: c.zone }
    if (c.override) env.CINNA_E2E_HOUR_CYCLE = c.override
    const lang = `--lang=${c.locale}`
    test.use({ env, launchArgs: [lang] })

    test('timed due chips', async ({ cinna }, testInfo) => {
      // Today in the case's zone, not the test machine's.
      const today = wallIn(Date.now(), c.zone).day
      const yesterday = shiftDay(today, -1)
      // Kiritimati is +14:00 all year, Honolulu −10:00 all year.
      const body = [
        `- [ ] standup due:${today}T09:00`,
        `- [ ] retro due:${yesterday}T16:30`,
        `- [ ] call Kiri due:${today}T09:00+14:00[Pacific/Kiritimati]`,
        `- [ ] call Hono due:${today}T22:00-10:00[Pacific/Honolulu]`
      ].join('\n')

      await cinna.skipOnboarding()
      await cinna.page.evaluate((note) => window.api.notes.create(note), { title: 'Timed matrix', body })
      await cinna.relaunch([lang])
      await cinna.skipOnboarding()

      // The renderer really runs in the zone and locale the case launched with.
      const seen = await cinna.page.evaluate(() => ({
        language: navigator.language,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }))
      expect(seen).toEqual({ language: c.appLocale, locale: c.appLocale, zone: c.zone })

      const kiri = pinnedExpectation(c, today, today, '09:00', 14 * 60, 'Kiritimati')
      const hono = pinnedExpectation(c, today, today, '22:00', -10 * 60, 'Honolulu')
      const expected = [
        { label: `Today ${clockText(9, 0, c)}`, day: today },
        { label: `Yesterday ${clockText(16, 30, c)}`, day: yesterday },
        kiri,
        hono
      ]

      await cinna.page.getByRole('button', { name: 'Notes', exact: true }).click()
      await cinna.page.getByText('Timed matrix', { exact: true }).click()
      const readView = cinna.page.locator('.markdown-body')
      const chips = readView.locator('[data-note-due]')
      await expect(chips).toHaveCount(4)
      // Intl's 12-hour form puts a narrow no-break space before AM/PM.
      const labels = (await chips.allTextContents()).map((t) => t.replace(/\s/g, ' '))
      // The expectations were computed for `today`; a run that crossed midnight
      // in the case's zone would compare against yesterday's labels. Rare
      // (the run takes seconds), and a rerun settles it, so it is skipped.
      test.skip(wallIn(Date.now(), c.zone).day !== today, `midnight passed in ${c.zone} during the run; rerun`)
      expect(labels).toEqual(expected.map((e) => e.label))
      for (const [i, e] of expected.entries()) {
        await expect(chips.nth(i)).toHaveAttribute('data-note-due', e.day)
        await expect(chips.nth(i)).toHaveAttribute('data-tone', e.day < today ? 'overdue' : 'upcoming')
      }
      // The +14:00 origin is shown exactly when the device is not at +14:00.
      if (c.zone === 'Pacific/Kiritimati') expect(labels[2]).not.toContain('Kiritimati')
      else expect(labels[2]).toContain('Kiritimati)')
      await expect(readView).not.toContainText('due:')

      await readView.screenshot({ path: testInfo.outputPath(`matrix-${c.zone.replace('/', '-')}-${c.locale}${c.override ? `-${c.override}` : ''}.png`) })
    })
  })
}
