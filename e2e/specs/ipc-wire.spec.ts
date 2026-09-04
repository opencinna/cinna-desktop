import { test, expect } from '../fixtures/app'

/**
 * Section A of `plans/manual-test-session2.md`: the IPC wire format.
 *
 * Eleven-plus unit fixtures encode the string Electron produces when an
 * `ipcMain.handle` handler throws. They were derived from source, never
 * observed, and they all pass together whether or not the derivation is right.
 * This is the one place the real string is read from a real process.
 */

test('A1 a raw error keeps the Electron prefix, channel and class name', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const message = await cinna.page.evaluate(() =>
    window.api.localAgents.rootRemove('does-not-exist').then(
      () => 'resolved',
      (err: Error) => err.message
    )
  )
  expect(message).toBe(
    "Error invoking remote method 'local-agent:root-remove': LocalAgentError: That agents folder is not registered."
  )
})

test('A1 the renderer receives a plain Error: no code, a one-line stack', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const shape = await cinna.page.evaluate(() =>
    window.api.localAgents.rootRemove('does-not-exist').then(
      () => null,
      (err: Error & { code?: unknown }) => ({
        name: err.name,
        code: err.code,
        stackLines: String(err.stack).split('\n').length
      })
    )
  )
  expect(shape).toEqual({ name: 'Error', code: undefined, stackLines: 1 })
})

test('A2 a fixed site shows a plain sentence with no channel or class name', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const { page } = cinna
  await page.evaluate(() =>
    window.api.jobs.create({ type: 'local', title: 'Editable', prompt: 'Do the thing.' })
  )
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await page.getByText('Editable', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit job' }).click()
  const title = page.getByRole('textbox').first()
  await title.fill('')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('Title is required')
  await expect(alert).not.toContainText('Error invoking remote method')
  await expect(alert).not.toContainText('JobError')
})
