import { test, expect, type CinnaApp } from '../fixtures/app'
import type { SpeechStatus, TranscribeResult } from '../../src/shared/speech'

/**
 * Voice input in the composer (`src/renderer/src/components/chat/voice/`).
 *
 * Real speech recognition cannot run here: it needs the bundled macOS helper
 * and a TCC grant charged to whichever app launched it. So main's answer is
 * pinned the way `claude-logged-out`'s neighbours pin the login probe — the
 * `speech:status` / `speech:transcribe` handlers are replaced in the app
 * process — and the renderer is reloaded so its startup prefetch reads the
 * pinned status. Everything from the renderer down to the IPC call is real.
 *
 * What this does not prove: that the probe or the helper answer correctly
 * (`speechService.test.ts`, `macosSpeech.test.ts`), nor the headphone keys.
 */

const SUPPORTED: SpeechStatus = { supported: true, engine: 'macos', authorization: 'granted', backend: 'sfspeech' }
const UNSUPPORTED: SpeechStatus = { supported: false, engine: null, authorization: 'unknown', reason: 'pinned by the spec' }

/** Replace main's speech status, then reload so the renderer's prefetch reads it. */
async function pinSpeechStatus(cinna: CinnaApp, status: SpeechStatus): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }, pinned) => {
    ipcMain.removeHandler('speech:status')
    ipcMain.handle('speech:status', () => pinned)
  }, status)
  await cinna.page.reload()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
}

/**
 * Replace main's transcription with scripted answers, one per call, and record
 * the size of every WAV that arrives (`globalThis.__speechWavBytes`).
 */
async function scriptTranscribe(cinna: CinnaApp, answers: TranscribeResult[]): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }, scripted) => {
    const g = globalThis as { __speechWavBytes?: number[] }
    g.__speechWavBytes = []
    ipcMain.removeHandler('speech:transcribe')
    ipcMain.handle('speech:transcribe', (_event, request: { wav?: { byteLength?: number } }) => {
      g.__speechWavBytes!.push(request?.wav?.byteLength ?? 0)
      return scripted[g.__speechWavBytes!.length - 1] ?? scripted[scripted.length - 1]
    })
  }, answers)
}

async function openFeatures(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Features', exact: true }).click()
}

const micButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Audio input', exact: true })
const sendButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Send', exact: true })
const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

test.describe('voice input, speech unsupported', () => {
  test('no mic button beside Send and no Show audio input row', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await pinSpeechStatus(cinna, UNSUPPORTED)

    // The composer is up — Send is the control the mic would sit beside.
    await expect(sendButton(cinna)).toBeVisible()
    await expect(micButton(cinna)).toHaveCount(0)

    await openFeatures(cinna)
    // The neighbouring Interface row renders, so the absence below is real.
    await expect(cinna.page.getByRole('switch', { name: 'Tasks button' })).toBeVisible()
    await expect(cinna.page.getByRole('switch', { name: 'Show audio input' })).toHaveCount(0)
    await expect(cinna.page.getByText('Show audio input', { exact: true })).toHaveCount(0)
  })
})

test.describe('voice input, speech supported', () => {
  test('menu, hide from the menu, and turn back on in Settings → Features', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await pinSpeechStatus(cinna, SUPPORTED)

    await test.step('the mic button sits immediately before Send', async () => {
      await expect(micButton(cinna)).toBeVisible()
      await expect(micButton(cinna)).toHaveAttribute('title', 'Audio input · right-click to choose the microphone')
      await expect(micButton(cinna).locator('xpath=following-sibling::button[1]')).toHaveAccessibleName('Send')
    })

    await test.step('right-click opens the microphone menu', async () => {
      await micButton(cinna).click({ button: 'right' })
      const menu = cinna.page.getByRole('menu', { name: 'Audio input', exact: true })
      await expect(menu).toBeVisible()
      await expect(menu.getByText('Microphone', { exact: true })).toBeVisible()
      await expect(menu.getByText('Microphone', { exact: true })).toHaveCSS('text-transform', 'uppercase')
      const systemDefault = menu.getByRole('menuitemradio', { name: 'System default', exact: true })
      await expect(systemDefault).toHaveAttribute('aria-checked', 'true')
      const show = menu.getByRole('menuitemcheckbox', { name: 'Show audio input', exact: true })
      await expect(show).toHaveAttribute('aria-checked', 'true')
      // Heading first, the switch last.
      await expect(menu.locator('[role="menuitemcheckbox"]')).toHaveCount(1)
      await expect(menu.locator('[role^="menuitem"]').last()).toHaveAccessibleName('Show audio input')
    })

    await test.step('turning it off hides the button and says where it comes back', async () => {
      await cinna.page.getByRole('menuitemcheckbox', { name: 'Show audio input', exact: true }).click()
      await expect(cinna.page.getByRole('menu', { name: 'Audio input' })).toHaveCount(0)
      await expect(micButton(cinna)).toHaveCount(0)
      await expect(sendButton(cinna)).toBeVisible()
      const toast = cinna.page.getByRole('status').filter({ hasText: 'Audio input is hidden.' })
      await expect(toast.locator('p')).toHaveText(
        'Audio input is hidden. Turn it back on in Settings → Features → Interface → Show audio input.'
      )
      await expect(toast.getByLabel('Info', { exact: true })).toBeVisible()
      await toast.getByRole('button', { name: 'Open Settings → Features', exact: true }).click()
    })

    await test.step('the toast link lands on Features, where the switch brings it back', async () => {
      const toggle = cinna.page.getByRole('switch', { name: 'Show audio input' })
      await expect(toggle).toBeVisible()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(cinna.page.getByRole('switch', { name: 'Tasks button' })).toBeVisible()
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(micButton(cinna)).toBeVisible()
      await expect(sendButton(cinna)).toBeVisible()
    })
  })
})

test.describe('voice input, a recording from a fake microphone', () => {
  // Chromium's fake capture device (a beep) and auto-accepted media prompt: no
  // real microphone is opened and no system permission is asked for.
  test.use({ launchArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })

  test('a failed transcription is an error toast; a good one lands in the draft', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await pinSpeechStatus(cinna, SUPPORTED)
    await scriptTranscribe(cinna, [
      { success: false, code: 'no-speech', message: 'No speech was detected.' },
      { success: true, text: 'dictated by the fake microphone' }
    ])
    // Count the samples the recorder's worklet hands over, so a stop waits for
    // a real recording (the recorder drops anything under 0.25 s) instead of
    // sleeping. Observation only: the app's own handler still gets every block.
    await cinna.page.evaluate(() => {
      const w = window as unknown as { __voiceSamples: number; AudioWorkletNode: typeof AudioWorkletNode }
      w.__voiceSamples = 0
      const Original = w.AudioWorkletNode
      w.AudioWorkletNode = class extends Original {
        constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
          super(...args)
          this.port.addEventListener('message', (event: MessageEvent<Float32Array>) => {
            w.__voiceSamples += event.data.length
          })
        }
      }
    })
    const recordOnce = async (): Promise<void> => {
      await cinna.page.evaluate(() => { (window as unknown as { __voiceSamples: number }).__voiceSamples = 0 })
      await micButton(cinna).click()
      const stop = cinna.page.getByRole('button', { name: 'Stop recording', exact: true })
      await expect(stop).toHaveAttribute('aria-pressed', 'true')
      // Half a second of 16 kHz audio, twice the recorder's minimum.
      await expect
        .poll(() => cinna.page.evaluate(() => (window as unknown as { __voiceSamples: number }).__voiceSamples))
        .toBeGreaterThan(8000)
      await stop.click()
    }

    await test.step('the failure is an error toast, and the draft is untouched', async () => {
      await composer(cinna).fill('Draft:')
      await recordOnce()
      const toast = cinna.page.getByRole('alert').filter({ hasText: 'No speech was detected.' })
      await expect(toast.locator('p')).toHaveText('No speech was detected.')
      await expect(toast.getByLabel('Error', { exact: true })).toBeVisible()
      await expect(composer(cinna)).toHaveValue('Draft:')
      await expect(micButton(cinna)).toBeEnabled()
      // A real WAV crossed the wire: a 44-byte header plus 16-bit samples.
      const sizes = await cinna.electronApp.evaluate(() => (globalThis as { __speechWavBytes?: number[] }).__speechWavBytes)
      expect(sizes).toHaveLength(1)
      expect(sizes![0]).toBeGreaterThan(44 + 2 * 4000)
    })

    await test.step('the next recording takes the toast down and appends its text after a space', async () => {
      await recordOnce()
      await expect(composer(cinna)).toHaveValue('Draft: dictated by the fake microphone')
      await expect(cinna.page.getByRole('alert').filter({ hasText: 'No speech was detected.' })).toHaveCount(0)
      // Appended, never sent.
      await expect(sendButton(cinna)).toBeEnabled()
    })
  })
})
