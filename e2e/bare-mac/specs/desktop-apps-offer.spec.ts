import { expect, q, test, type BareVm } from '../fixtures/vm'

/**
 * Claude Desktop and ChatGPT in the real `/Applications` of a bare Mac: the
 * new-chat screen offers both, and finding them raises no system dialog.
 *
 * The bundles are stubs — `Contents/Info.plist` carrying the vendor's bundle
 * id, the one file detection opens. They are planted over SSH while the app
 * sits on Welcome: detection is lazy (the first `local-tools:desktop-apps`
 * call, made when the banner mounts after onboarding) and memoized per
 * launch, so the app has not looked yet and sees them on its first look —
 * with no `CINNA_DESKTOP_APP_ROOTS` override, the production roots.
 *
 * "Use Claude" is never pressed: with no Claude Code login it would open a real
 * browser sign-in. "Use ChatGPT" is, after a dummy API-key `~/.codex/auth.json`
 * — the pinned `codex login status` reads that file with no network (checked
 * against codex 0.155.0 behind a dead proxy: "Logged in using an API key",
 * exit 0), so the connect downloads the pinned Codex and adopts it without a
 * sign-in.
 */

const BOTH_SENTENCE =
  "Claude Desktop and ChatGPT are installed — use either subscription as Cinna's default for chats and agents."

async function plantApps(vm: BareVm): Promise<void> {
  const plant = (bundle: string, bundleId: string): string => {
    const contents = `/Applications/${bundle}/Contents`
    const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`
    return `mkdir -p ${q(contents)} && printf '%s\\n' ${q(plist)} > ${q(`${contents}/Info.plist`)}`
  }
  await vm.sh(`${plant('Claude.app', 'com.anthropic.claudefordesktop')} && ${plant('ChatGPT.app', 'com.openai.codex')}`)
}

async function skipOnboarding(vm: BareVm): Promise<void> {
  const { page } = vm
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible({ timeout: 60_000 })
  // Planted before the shell exists, so before the app's one detection pass.
  vm.step('plant Claude.app and ChatGPT.app')
  await plantApps(vm)
  vm.step('skip onboarding')
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
}

test('both desktop apps in /Applications are offered, with no system dialog', async ({ vm }) => {
  const { page } = vm
  await skipOnboarding(vm)
  const banner = page.getByRole('region', { name: 'Detected apps' })
  await expect(banner.getByText(BOTH_SENTENCE, { exact: true })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Use Claude' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Use ChatGPT' })).toBeVisible()
  expect(await page.evaluate(() => window.api.localTools.desktopApps())).toEqual([
    { id: 'claude-desktop', label: 'Claude Desktop', engine: 'claude' },
    { id: 'chatgpt', label: 'ChatGPT', engine: 'codex' }
  ])
  // A privacy prompt raised by reading the bundles would arrive in this window.
  vm.step('idle on the new-chat screen')
  await page.waitForTimeout(20_000)
})

test('Use ChatGPT with a signed-in Codex downloads the pinned CLI and makes it the Default runtime', async ({ vm }) => {
  const { page } = vm
  await vm.sh(`mkdir -p ~/.codex && printf '%s\\n' ${q('{"OPENAI_API_KEY":"sk-dummy-not-a-key"}')} > ~/.codex/auth.json`)
  await skipOnboarding(vm)
  const banner = page.getByRole('region', { name: 'Detected apps' })
  await expect(banner.getByText(BOTH_SENTENCE, { exact: true })).toBeVisible()

  vm.step('Use ChatGPT: Codex download and login check')
  await banner.getByRole('button', { name: 'Use ChatGPT' }).click()
  // The pinned Codex is ~90 MB; the banner leaves only on `enabled`.
  await expect(banner).toHaveCount(0, { timeout: 10 * 60_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => window.api.settings.getAll().then((s) => s.localAgentsDefaultEngine))).toBe('codex')
  expect(await page.evaluate(() => window.api.engine.defaultRuntime().then((d) => d.engine))).toBe('codex')
  expect(await page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_in', method: 'api_key' })
})
