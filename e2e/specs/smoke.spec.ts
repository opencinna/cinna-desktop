import { test, expect, answerAgentsFolder } from '../fixtures/app'

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
  // A fresh profile waits for the user's folder choice before creating a root.
  expect(await page.evaluate(() => window.api.localAgents.rootsList())).toEqual([])
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
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


test('Inbox remains reachable with the sidebar collapsed and from Settings', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const page = cinna.page
  const inbox = page.getByRole('button', { name: 'Inbox', exact: true })
  await expect(inbox).toBeVisible()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible()
  await inbox.click()
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(inbox).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'MCP Providers', exact: true })).toBeVisible()
  await expect(inbox).toHaveAttribute('aria-pressed', 'false')
  await inbox.click()
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(inbox).toHaveAttribute('aria-pressed', 'true')
})
