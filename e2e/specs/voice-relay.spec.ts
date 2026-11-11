import { test, expect, type CinnaApp } from '../fixtures/app'
import type { SpeechRelayUsageResult, SpeechStatus, SpeechStreamEvent } from '../../src/shared/speech'

/**
 * Dictation through the Cinna server relay
 * (`docs/chat/voice_input/voice_input.md` › Offer, Cinna server relay).
 *
 * The same arrangement as `voice-input.spec.ts`: main's `speech:status`
 * handler and `speech:stream` listener are replaced in the app process, the
 * renderer reloaded so its prefetch reads the pinned status, and Chromium's
 * fake capture device feeds the recorder. The stream fake also keeps the
 * options each session was opened with, and names `core-relay` in its `start`
 * frame for a session asked for `engine: 'core-relay'`. For Settings, the
 * `speech:relay-usage` handler is replaced with a canned answer.
 *
 * What this does not prove: that main attaches the offer to an on-device
 * failure (`speechService.test.ts`), the relay engine and its WebSocket
 * protocol (`engines/coreRelay.test.ts`), the discovery read that makes the
 * relay available, or the usage request (`coreRelayAccess.test.ts`); no
 * Cinna server and no network are involved. That the replayed bytes are the
 * unconfirmed audio is asserted only as "some audio arrived before the live
 * stream", not byte for byte.
 */

const SERVER = 'Acme Cinna'
const GEMINI = { id: 'gemini-e2e', name: 'Gemini' }
const ON_DEVICE_WITH_RELAY: SpeechStatus = {
  supported: true, engine: 'macos', authorization: 'granted', backend: 'sfspeech', available: true,
  cloud: { mode: 'off', setting: '', service: 'core', usable: true, providers: [], relay: { available: true, serverName: SERVER } }
}
const RELAY_NOTE = `Transcribing on ${SERVER}: audio leaves this computer.`

async function pinSpeechStatus(cinna: CinnaApp, status: SpeechStatus): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }, pinned) => {
    ipcMain.removeHandler('speech:status')
    ipcMain.handle('speech:status', () => pinned)
  }, status)
  await cinna.page.evaluate(() => localStorage.setItem('cinna-show-voice-input', '1'))
  await cinna.page.reload()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
}

type FakeSpeech = { sessions: number; audioBytes: number; commands: string[]; options: unknown[] }

/**
 * A scripted engine: each session keeps its port on `globalThis.__speech`,
 * records its open options and counts what arrives; it answers `start` at once
 * and nothing else until `say()`.
 */
async function fakeSpeechStream(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }) => {
    type Fake = FakeSpeech & { port: Electron.MessagePortMain | null }
    const g = globalThis as { __speech?: Fake }
    g.__speech = { sessions: 0, audioBytes: 0, commands: [], options: [], port: null }
    ipcMain.removeAllListeners('speech:stream')
    ipcMain.on('speech:stream', (event, options: { engine?: string } | undefined) => {
      const port = event.ports[0]
      const fake = g.__speech!
      fake.sessions++
      fake.audioBytes = 0
      fake.commands = []
      fake.options.push(options ?? null)
      fake.port = port
      port.on('message', (message) => {
        const data = message.data as { type?: string; pcm?: Uint8Array }
        if (data?.type === 'audio') fake.audioBytes += data.pcm?.byteLength ?? 0
        else fake.commands.push(String(data?.type))
      })
      port.start()
      port.postMessage({ type: 'start', backend: options?.engine === 'core-relay' ? 'core-relay' : 'sfspeech' })
    })
  })
}

/** Post one engine event on the current session's port; a terminal one closes it, as main does. */
async function say(cinna: CinnaApp, event: SpeechStreamEvent): Promise<void> {
  await cinna.electronApp.evaluate((_electron, frame) => {
    const port = (globalThis as { __speech?: { port: Electron.MessagePortMain | null } }).__speech?.port
    if (!port) throw new Error('no speech stream is open')
    port.postMessage(frame)
    if (frame.type === 'stop' || (frame.type === 'error' && !frame.recoverable)) port.close()
  }, event)
}

const speechSeen = (cinna: CinnaApp): Promise<FakeSpeech> =>
  cinna.electronApp.evaluate(() => {
    const fake = (globalThis as { __speech?: FakeSpeech }).__speech!
    return { sessions: fake.sessions, audioBytes: fake.audioBytes, commands: [...fake.commands], options: [...fake.options] }
  })

/** Every chat's user messages, as main stored them. */
const sentMessages = (cinna: CinnaApp): Promise<string[][]> =>
  cinna.page.evaluate(async () => {
    const chats = await window.api.chat.list()
    return Promise.all(chats.map(async (chat) =>
      ((await window.api.chat.get(chat.id))?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content)))
  })

const micButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Audio input', exact: true })
const stopButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Stop recording', exact: true })
const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
const cloudMark = (cinna: CinnaApp) => cinna.page.locator('[data-testid="voice-cloud-mark"]')
const offerDialog = (cinna: CinnaApp) => cinna.page.getByRole('dialog', { name: 'Dictation stopped', exact: true })
const keepButton = (cinna: CinnaApp) => offerDialog(cinna).getByRole('button', { name: 'Keep the text', exact: true })
const errorToast = (cinna: CinnaApp, text: string) => cinna.page.getByRole('alert').filter({ hasText: text })

const FAILURE = 'On-device speech recognition stopped unexpectedly.'

/** Click the mic and wait for the recording and its stream session (the `n`th) to be open. */
async function startDictation(cinna: CinnaApp, n: number): Promise<void> {
  await micButton(cinna).click()
  await expect(stopButton(cinna)).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await speechSeen(cinna)).sessions).toBe(n)
  await expect(composer(cinna)).toBeFocused()
}

/**
 * Dictate "first words." after "Note:" with some audio across the port, then
 * fail on-device with the relay offered; returns once the dialog is up.
 */
async function failWithOffer(cinna: CinnaApp, n: number): Promise<void> {
  await startDictation(cinna, n)
  // Real audio crossed the port, so there is unconfirmed audio to replay.
  await expect.poll(async () => (await speechSeen(cinna)).audioBytes).toBeGreaterThan(2 * 8000)
  await say(cinna, { type: 'partial', text: 'first' })
  await say(cinna, { type: 'final', text: 'first words.' })
  await say(cinna, { type: 'partial', text: 'lost tail' })
  await expect(composer(cinna)).toHaveValue('Note: first words. lost tail')
  await say(cinna, { type: 'error', code: 'failed', message: FAILURE, recoverable: false, offer: { engine: 'core-relay', serverName: SERVER } })
  await expect(offerDialog(cinna)).toBeVisible()
}

test.describe('voice input, the Cinna server relay offer', () => {
  test.use({ launchArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })

  test.beforeEach(async ({ cinna }) => {
    await cinna.skipOnboarding()
    await fakeSpeechStream(cinna)
    await pinSpeechStatus(cinna, ON_DEVICE_WITH_RELAY)
    await composer(cinna).fill('Note:')
  })

  test('an on-device failure with an offer asks in a dialog; Continue resumes on the relay after the confirmed text', async ({ cinna }) => {
    await failWithOffer(cinna, 1)

    await test.step('the dialog names the server and the reason, Keep the text has focus, and there is no toast', async () => {
      const paragraphs = offerDialog(cinna).locator('p')
      await expect(offerDialog(cinna).getByRole('heading', { name: 'Dictation stopped', exact: true })).toBeVisible()
      await expect(paragraphs.nth(0)).toHaveText(FAILURE)
      await expect(paragraphs.nth(1)).toHaveText(new RegExp(
        `^Continue with ${SERVER}\\? The last (second that was|\\d+ seconds that were) not transcribed yet will be sent to ${SERVER}, and dictation continues there\\.`))
      await expect(keepButton(cinna)).toBeFocused()
      await expect(offerDialog(cinna).getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
      await expect(errorToast(cinna, FAILURE)).toHaveCount(0)
      // The partial is gone, the confirmed text stays; no second session yet.
      await expect(composer(cinna)).toHaveValue('Note: first words.')
      expect((await speechSeen(cinna)).sessions).toBe(1)
    })

    await test.step('Continue opens a relay session with the replay, wearing the cloud mark', async () => {
      await offerDialog(cinna).getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(offerDialog(cinna)).toHaveCount(0)
      await expect.poll(async () => (await speechSeen(cinna)).sessions).toBe(2)
      const seen = await speechSeen(cinna)
      const options = seen.options[1] as { engine?: string; replaySeconds?: number }
      expect(options.engine).toBe('core-relay')
      expect(options.replaySeconds).toBeGreaterThan(0)
      expect(seen.audioBytes).toBeGreaterThan(0)
      await expect(stopButton(cinna)).toHaveAttribute('aria-pressed', 'true')
      await expect(stopButton(cinna).locator('[data-testid="voice-cloud-mark"]')).toBeVisible()
      await expect(stopButton(cinna)).toHaveAccessibleDescription(RELAY_NOTE)
      await expect(stopButton(cinna)).toHaveAttribute('title', `Stop recording · ${RELAY_NOTE}`)
    })

    await test.step('the relay final lands right after the first confirmed text', async () => {
      await say(cinna, { type: 'partial', text: 'second' })
      await expect(composer(cinna)).toHaveValue('Note: first words. second')
      await say(cinna, { type: 'final', text: 'second words.' })
      await expect(composer(cinna)).toHaveValue('Note: first words. second words.')
      await stopButton(cinna).click()
      await expect.poll(async () => (await speechSeen(cinna)).commands).toEqual(['stop'])
      await say(cinna, { type: 'stop', fullText: 'second words.' })
      await expect(micButton(cinna)).toBeEnabled()
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
      await expect(cloudMark(cinna)).toHaveCount(0)
      await expect(composer(cinna)).toHaveValue('Note: first words. second words.')
      expect(await sentMessages(cinna)).toEqual([])
    })
  })

  test('Keep the text, or Escape, keeps the confirmed text and opens no relay session', async ({ cinna }) => {
    await test.step('Keep the text', async () => {
      await failWithOffer(cinna, 1)
      await keepButton(cinna).click()
      await expect(offerDialog(cinna)).toHaveCount(0)
      await expect(composer(cinna)).toHaveValue('Note: first words.')
      await expect(micButton(cinna)).toBeEnabled()
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
      await expect(errorToast(cinna, FAILURE)).toHaveCount(0)
      expect((await speechSeen(cinna)).sessions).toBe(1)
    })

    await test.step('Escape is the same answer', async () => {
      await composer(cinna).fill('Note:')
      await failWithOffer(cinna, 2)
      await expect(keepButton(cinna)).toBeFocused()
      await cinna.page.keyboard.press('Escape')
      await expect(offerDialog(cinna)).toHaveCount(0)
      await expect(composer(cinna)).toHaveValue('Note: first words.')
      await expect(micButton(cinna)).toBeEnabled()
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
      await expect(errorToast(cinna, FAILURE)).toHaveCount(0)
      const seen = await speechSeen(cinna)
      expect(seen.sessions).toBe(2)
      expect(seen.options.some((o) => (o as { engine?: string } | null)?.engine === 'core-relay')).toBe(false)
      expect(await sentMessages(cinna)).toEqual([])
    })
  })

  test('a failure without an offer is still an error toast, with no dialog', async ({ cinna }) => {
    await startDictation(cinna, 1)
    await say(cinna, { type: 'final', text: 'kept words' })
    await expect(composer(cinna)).toHaveValue('Note: kept words')
    await say(cinna, { type: 'error', code: 'failed', message: 'The speech helper stopped.', recoverable: false })
    const toast = errorToast(cinna, 'The speech helper stopped.')
    await expect(toast.locator('p')).toHaveText('The speech helper stopped.')
    await expect(toast.getByLabel('Error', { exact: true })).toBeVisible()
    await expect(offerDialog(cinna)).toHaveCount(0)
    await expect(composer(cinna)).toHaveValue('Note: kept words')
    await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
    expect((await speechSeen(cinna)).sessions).toBe(1)
  })
})

/**
 * Settings › Features with the relay available and a usable Gemini provider.
 * The pinned status reads the stored mode and service back through the real
 * `settings:get-all`, deriving `cloud.service` the way `speechService` does,
 * so the renderer's refetch after a save sees them.
 */
async function pinRelayAndGemini(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }, { provider, server }) => {
    ipcMain.removeHandler('speech:status')
    ipcMain.handle('speech:status', async (event) => {
      const settings = await event.sender.executeJavaScript('window.api.settings.getAll()') as { voiceCloudTranscription?: string; voiceCloudService?: string }
      const mode = settings.voiceCloudTranscription ?? 'off'
      const setting = settings.voiceCloudService ?? ''
      return {
        supported: true, engine: 'macos', authorization: 'granted', backend: 'sfspeech', available: true,
        cloud: { mode, setting, service: setting || 'core', usable: true, providers: [provider], relay: { available: true, serverName: server } }
      }
    })
  }, { provider: GEMINI, server: SERVER })
}

async function pinRelayUsage(cinna: CinnaApp, usage: SpeechRelayUsageResult): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }, answer) => {
    ipcMain.removeHandler('speech:relay-usage')
    ipcMain.handle('speech:relay-usage', () => answer)
  }, usage)
}

async function openFeatures(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Features', exact: true }).click()
}

const cloudSelect = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Cloud transcription', exact: true })
const serviceSelect = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Service', exact: true })
const usageRow = (cinna: CinnaApp) => cinna.page.getByTestId('feature-voice-relay-usage')

test.describe('voice input, Cinna server relay in Settings › Features', () => {
  test('the Service select, and the usage row with its warning when the month is used up', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await pinRelayAndGemini(cinna)
    await pinRelayUsage(cinna, { ok: true, enabled: true, usedSeconds: 20 * 60, capSeconds: 60 * 60, periodEnd: '2026-12-01T00:00:00Z' })
    await cinna.page.reload()
    await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
    await openFeatures(cinna)

    await test.step('Off with both services usable: the Service select shows Cinna server, no usage row', async () => {
      await expect(cloudSelect(cinna)).toHaveValue('off')
      await expect(serviceSelect(cinna)).toBeVisible()
      await expect(serviceSelect(cinna).locator('option')).toHaveText(['Cinna server', 'My Gemini key'])
      await expect(serviceSelect(cinna)).toHaveValue('core')
      await expect(usageRow(cinna)).toHaveCount(0)
    })

    await test.step('As a fallback on Cinna server: the usage row reads the server answer, neutral', async () => {
      await cloudSelect(cinna).selectOption({ label: 'As a fallback' })
      await expect(cloudSelect(cinna)).toHaveValue('fallback')
      await expect(serviceSelect(cinna)).toHaveValue('core')
      await expect(usageRow(cinna)).toHaveText(`40 of 60 min left this month on ${SERVER}`)
      await expect(usageRow(cinna).locator('svg[class*="color-warning"]')).toHaveCount(0)
      expect(await cinna.page.evaluate(() => window.api.settings.getAll().then((s) => [s.voiceCloudTranscription, s.voiceCloudService])))
        .toEqual(['fallback', 'core'])
    })

    await test.step('no minutes left: the same row in the warning tone', async () => {
      await pinRelayUsage(cinna, { ok: true, enabled: true, usedSeconds: 60 * 60, capSeconds: 60 * 60, periodEnd: '2026-12-01T00:00:00Z' })
      // The usage query is cached for a minute; a reload reads it fresh.
      await cinna.page.reload()
      await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
      await openFeatures(cinna)
      await expect(usageRow(cinna)).toHaveText(`0 of 60 min left this month on ${SERVER}`)
      await expect(usageRow(cinna).locator('svg[class*="color-warning"]')).toHaveCount(1)
    })
  })
})
