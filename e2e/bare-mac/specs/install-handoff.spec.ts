import { expect, test } from '../fixtures/vm'

/**
 * Someone clicks Download on their instance's `/desktop` page, which copies
 * `cinna://connect?server=<origin>` to the clipboard, installs the app and
 * opens it from Applications.
 *
 * On macOS the app does not read the clipboard by itself. Apple's pasteboard
 * privacy, opt-in on macOS 15 and meant to be on for everyone later, raises
 * "Allow Paste?" for a program read without a user paste. This spec's first
 * version read the pasteboard at first-run onboarding with that preview on. The
 * guest showed a 260x230 window at the modal-panel layer, owned by the app. The
 * app's main thread sat in `-[NSPasteboard stringForType:]` →
 * `CFPasteboardShowApprovalDialogIfNecessaryForPasteboard` → `NSAlert runModal`,
 * frozen until someone answered. So a Mac user pastes the link into Server URL
 * instead (or clicks the page's Open button), and that paste is a user paste,
 * which the privacy check allows.
 *
 * The preview is on, as the stricter macOS. The nag watch does
 * not catch the alert: it is the app's own window. A frozen app does, because
 * the page never answers.
 */

const HOST = 'cinna.example.test'
const LINK = `cinna://connect?server=https://${HOST}`

test.use({
  // `pbcopy` over SSH writes the logged-in user's pasteboard, the one the app reads.
  beforeLaunch:
    'defaults write io.opencinna.desktop EnablePasteboardPrivacyDeveloperPreview -bool yes' +
    ` && printf %s ${JSON.stringify(LINK)} | pbcopy && test "$(pbpaste)" = ${JSON.stringify(LINK)}`
})

test('a copied connect link is not read at first launch', async ({ vm }) => {
  const { page } = vm
  await expect(page.getByText('Welcome to Cinna')).toBeVisible({ timeout: 60_000 })
  vm.step('idle on Welcome')
  await page.waitForTimeout(20_000)
  await expect(page.getByText(`Connect to ${HOST}?`)).toHaveCount(0)
  // Main still answers and holds nothing: a read stuck behind the alert would
  // leave this call hanging, and a read that got through would have buffered it.
  expect(await page.evaluate(() => window.api.connect.getPending())).toBeNull()
  const windows = await vm.pollWindows()
  expect(windows.filter((w) => w.owner === 'Cinna Desktop' && w.layer === 8)).toEqual([])
})

/*
 * Not here: Cmd+V into Server URL. Apple's check exempts a paste the user
 * makes (Cmd+V, Edit → Paste), but Playwright's `keyboard.press('Meta+V')`
 * arrives over CDP, not as an NSEvent. Chromium's paste then counts as a
 * program read: with the preview on it raised the same alert and froze the
 * app (2026-10-30). A real keystroke needs an Accessibility grant the guest
 * does not have. The paste path is covered by the sandboxed E2E suite, which
 * runs without the preview.
 */
