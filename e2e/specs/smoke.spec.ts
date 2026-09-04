import { test, expect } from '../fixtures/app'

test('launches into onboarding, then the main shell, inside the sandbox', async ({ cinna }) => {
  const { page, electronApp, sandbox } = cinna
  await expect(page).toHaveTitle('Cinna')
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible()

  await cinna.skipOnboarding()
  for (const name of ['Chats', 'Jobs', 'Notes', 'Agents', 'New chat']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }

  // Isolation is a correctness property of the suite: a test that reaches the
  // developer's real profile or agents folder is asserting against their data.
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  expect(userData).toBe(sandbox.userData)
  const roots = await page.evaluate(() => window.api.localAgents.rootsList())
  expect(roots.length).toBeGreaterThan(0)
  for (const root of roots) expect(root.path.startsWith(sandbox.home)).toBe(true)
})

test('safeStorage encrypts inside the sandbox (mock keychain)', async ({ cinna }) => {
  const roundTrip = await cinna.electronApp.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
    return safeStorage.decryptString(safeStorage.encryptString('sk-probe'))
  })
  expect(roundTrip).toBe('sk-probe')
})
