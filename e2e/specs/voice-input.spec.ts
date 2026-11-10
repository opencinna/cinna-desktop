import { test, expect, type CinnaApp } from '../fixtures/app'
import type { SpeechStatus, SpeechStreamEvent } from '../../src/shared/speech'

/**
 * Voice input in the composer (`src/renderer/src/components/chat/voice/`).
 *
 * Real speech recognition cannot run here: it needs the bundled macOS helper
 * and a TCC grant charged to whichever app launched it. So main's side is
 * pinned the way `claude-logged-out`'s neighbours pin the login probe — the
 * `speech:status` handler and the `speech:stream` listener are replaced in the
 * app process — and the renderer is reloaded so its startup prefetch reads the
 * pinned status. The stream fake records what the renderer sends on the port
 * (audio bytes, `stop`, `cancel`) and answers only when the test tells it to,
 * with frames of the shared `SpeechStreamEvent` contract. Everything from the
 * renderer down to the real preload's MessagePort is real.
 *
 * What this does not prove: that the probe or the helper answer correctly
 * (`speechService.test.ts`, `macosSpeech*.test.ts`), the main-side stream
 * handler in `speech.ipc.ts` (`speech.ipc.test.ts`), the batch `speech:transcribe`
 * path (unreachable from the composer while preload offers `speech.stream`),
 * nor the headphone keys.
 */

const SUPPORTED: SpeechStatus = { supported: true, engine: 'macos', authorization: 'granted', backend: 'sfspeech' }
const UNSUPPORTED: SpeechStatus = { supported: false, engine: null, authorization: 'unknown', reason: 'pinned by the spec' }

/**
 * Replace main's speech status, then reload so the renderer's prefetch reads it.
 * `shown` turns Show audio input on first (it is off by default).
 */
async function pinSpeechStatus(cinna: CinnaApp, status: SpeechStatus, { shown = false } = {}): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }, pinned) => {
    ipcMain.removeHandler('speech:status')
    ipcMain.handle('speech:status', () => pinned)
  }, status)
  if (shown) await cinna.page.evaluate(() => localStorage.setItem('cinna-show-voice-input', '1'))
  await cinna.page.reload()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
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
  test('off by default: no mic button, and the Features switch is off', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await pinSpeechStatus(cinna, SUPPORTED)

    await expect(sendButton(cinna)).toBeVisible()
    await expect(micButton(cinna)).toHaveCount(0)

    await openFeatures(cinna)
    await expect(cinna.page.getByRole('switch', { name: 'Show audio input' })).toHaveAttribute('aria-checked', 'false')
  })

  test('menu, hide from the menu, and turn back on in Settings → Features', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await pinSpeechStatus(cinna, SUPPORTED, { shown: true })

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

/**
 * Replace main's `speech:stream` listener with a scripted engine. Each session
 * keeps its port on `globalThis.__speech` and counts what arrives: audio bytes,
 * and every other command by type. It answers `start` at once and nothing
 * else until `say()`.
 */
async function fakeSpeechStream(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ ipcMain }) => {
    type Fake = { sessions: number; audioBytes: number; commands: string[]; port: Electron.MessagePortMain | null }
    const g = globalThis as { __speech?: Fake }
    g.__speech = { sessions: 0, audioBytes: 0, commands: [], port: null }
    ipcMain.removeAllListeners('speech:stream')
    ipcMain.on('speech:stream', (event) => {
      const port = event.ports[0]
      const fake = g.__speech!
      fake.sessions++
      fake.audioBytes = 0
      fake.commands = []
      fake.port = port
      port.on('message', (message) => {
        const data = message.data as { type?: string; pcm?: Uint8Array }
        if (data?.type === 'audio') fake.audioBytes += data.pcm?.byteLength ?? 0
        else fake.commands.push(String(data?.type))
      })
      port.start()
      port.postMessage({ type: 'start', backend: 'sfspeech' })
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

type FakeSpeech = { sessions: number; audioBytes: number; commands: string[] }
const speechSeen = (cinna: CinnaApp): Promise<FakeSpeech> =>
  cinna.electronApp.evaluate(() => {
    const fake = (globalThis as { __speech?: FakeSpeech }).__speech!
    return { sessions: fake.sessions, audioBytes: fake.audioBytes, commands: [...fake.commands] }
  })

/** Every chat's user messages, as main stored them. */
const sentMessages = (cinna: CinnaApp): Promise<string[][]> =>
  cinna.page.evaluate(async () => {
    const chats = await window.api.chat.list()
    return Promise.all(chats.map(async (chat) =>
      ((await window.api.chat.get(chat.id))?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content)))
  })

const stopButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Stop recording', exact: true })
const mirror = (cinna: CinnaApp) => cinna.page.locator('[data-dictation-mirror]')
const partialSpan = (cinna: CinnaApp) => cinna.page.locator('[data-dictation-partial]')

/** Click the mic and wait for the recording and its stream session (the `n`th) to be open. */
async function startDictation(cinna: CinnaApp, n: number): Promise<void> {
  await micButton(cinna).click()
  await expect(stopButton(cinna)).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await speechSeen(cinna)).sessions).toBe(n)
  // The composer takes focus back, so typed keys reach it.
  await expect(composer(cinna)).toBeFocused()
}

test.describe('voice input, live dictation from a fake microphone', () => {
  // Chromium's fake capture device (a beep) and auto-accepted media prompt: no
  // real microphone is opened and no system permission is asked for.
  test.use({ launchArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })

  test.beforeEach(async ({ cinna }) => {
    await cinna.skipOnboarding()
    await fakeSpeechStream(cinna)
    await pinSpeechStatus(cinna, SUPPORTED, { shown: true })
  })

  test('words land at the caret, the partial is lighter, Esc keeps the confirmed text and a key keeps what is shown', async ({ cinna }) => {
    await test.step('a partial appears at the caret, between the text before and after it', async () => {
      await composer(cinna).fill('Before after')
      // The caret between "Before" and " after".
      for (let i = 0; i < ' after'.length; i++) await composer(cinna).press('ArrowLeft')
      await startDictation(cinna, 1)
      await say(cinna, { type: 'partial', text: 'hello there' })
      // Typed out letter by letter (useTypedText), so this polls until it lands.
      await expect(composer(cinna)).toHaveValue('Before hello there after')
      await expect(composer(cinna)).toHaveAttribute('data-dictating', '')
      await expect(mirror(cinna)).toHaveText('Before hello there after')
      await expect(partialSpan(cinna)).toHaveText('hello there')
    })

    await test.step('the partial is drawn lighter than the text around it', async () => {
      const colors = await cinna.page.evaluate(() => {
        const textarea = document.querySelector('[data-dictating]') as HTMLElement
        const mirrorEl = document.querySelector('[data-dictation-mirror]') as HTMLElement
        const partialEl = document.querySelector('[data-dictation-partial]') as HTMLElement
        return {
          textarea: getComputedStyle(textarea).color,
          mirror: getComputedStyle(mirrorEl).color,
          partial: getComputedStyle(partialEl).color
        }
      })
      // The textarea's own text is hidden; the mirror draws it, the partial in another colour.
      expect(colors.textarea).toBe('rgba(0, 0, 0, 0)')
      expect(colors.partial).not.toBe(colors.mirror)
    })

    await test.step('a final confirms the words: the lighter partial is gone', async () => {
      await say(cinna, { type: 'final', text: 'Hello there.' })
      await expect(composer(cinna)).toHaveValue('Before Hello there. after')
      await expect(partialSpan(cinna)).toHaveCount(0)
      await expect(mirror(cinna)).toHaveText('Before Hello there. after')
      await expect(stopButton(cinna)).toBeVisible()
    })

    await test.step('Esc drops the partial, keeps the confirmed text and stops listening', async () => {
      await say(cinna, { type: 'partial', text: 'how are' })
      await expect(composer(cinna)).toHaveValue('Before Hello there. how are after')
      await expect(partialSpan(cinna)).toHaveText('how are')
      await composer(cinna).press('Escape')
      await expect(composer(cinna)).toHaveValue('Before Hello there. after')
      await expect(micButton(cinna)).toBeEnabled()
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
      await expect(mirror(cinna)).toHaveCount(0)
      await expect(composer(cinna)).not.toHaveAttribute('data-dictating', '')
      await expect.poll(async () => (await speechSeen(cinna)).commands).toEqual(['cancel'])
    })

    await test.step('typing a key mid-dictation keeps what is shown, plus the key, and stops listening', async () => {
      await composer(cinna).press('End')
      await expect(composer(cinna)).toHaveJSProperty('selectionStart', 'Before Hello there. after'.length)
      await startDictation(cinna, 2)
      await say(cinna, { type: 'partial', text: 'see you' })
      await expect(composer(cinna)).toHaveValue('Before Hello there. after see you')
      await expect(partialSpan(cinna)).toHaveText('see you')
      await cinna.page.keyboard.type('!')
      await expect(composer(cinna)).toHaveValue('Before Hello there. after see you!')
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
      await expect(mirror(cinna)).toHaveCount(0)
      await expect.poll(async () => (await speechSeen(cinna)).commands).toEqual(['cancel'])
      // The frozen text is the draft's own now, not a display: a further key extends it.
      await cinna.page.keyboard.type('!')
      await expect(composer(cinna)).toHaveValue('Before Hello there. after see you!!')
      // Nothing was sent along the way.
      expect(await sentMessages(cinna)).toEqual([])
    })
  })

  test('Enter while dictating stops recording and sends once the last words land', async ({ cinna }) => {
    await composer(cinna).fill('Note:')
    await startDictation(cinna, 1)
    // A real recording crossed the port: twice the recorder's 4000-sample
    // minimum, as 16-bit PCM, so the stop is not refused as "Nothing was recorded."
    await expect.poll(async () => (await speechSeen(cinna)).audioBytes).toBeGreaterThan(2 * 8000)
    await say(cinna, { type: 'partial', text: 'buy milk' })
    await expect(composer(cinna)).toHaveValue('Note: buy milk')

    await composer(cinna).press('Enter')
    await test.step('Enter stops the recording; nothing is sent while the last words are pending', async () => {
      await expect.poll(async () => (await speechSeen(cinna)).commands).toEqual(['stop'])
      await expect(micButton(cinna)).toBeDisabled()
      await expect(micButton(cinna)).toHaveAttribute('title', 'Finishing…')
      await expect(composer(cinna)).toHaveValue('Note: buy milk')
      expect(await sentMessages(cinna)).toEqual([])
    })

    await test.step('the engine finalizes; the message goes out once, with the final text', async () => {
      await say(cinna, { type: 'final', text: 'buy oat milk.' })
      await say(cinna, { type: 'stop', fullText: 'buy oat milk.' })
      await expect.poll(() => sentMessages(cinna)).toEqual([['Note: buy oat milk.']])
      // The new chat opens with the message as its one user bubble.
      await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^Note: buy oat milk\.$/ })).toHaveCount(1)
      // Still one message once the turn has settled (it fails: no model), and the composer is empty.
      await expect(cinna.page.getByText('The engine skipped this agent because its credential is not available to it.').first()).toBeVisible()
      await expect(composer(cinna)).toHaveValue('')
      await expect(micButton(cinna)).toBeEnabled()
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
      expect(await sentMessages(cinna)).toEqual([['Note: buy oat milk.']])
    })
  })

  // The display is still typing the final out (useTypedText) when the key
  // lands; the key goes after the whole text, the confirmed words kept.
  test('a key pressed while a final is still typing out keeps the confirmed words', async ({ cinna }) => {
    await startDictation(cinna, 1)
    // Long enough that typing it out takes most of a second even at full catch-up speed.
    const confirmed = 'This confirmed sentence is long. '.repeat(9).trim()
    await say(cinna, { type: 'final', text: confirmed })
    await cinna.page.keyboard.type('X')
    await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
    await expect(composer(cinna)).toHaveValue(`${confirmed}X`, { timeout: 3000 })
  })

  test('an engine error is an error toast and keeps the confirmed text', async ({ cinna }) => {
    await composer(cinna).fill('Draft:')
    await startDictation(cinna, 1)
    await say(cinna, { type: 'final', text: 'kept words' })
    await say(cinna, { type: 'partial', text: 'lost words' })
    await expect(composer(cinna)).toHaveValue('Draft: kept words lost words')

    await test.step('a recoverable error is only logged: the dictation carries on', async () => {
      await say(cinna, { type: 'error', code: 'failed', message: 'A recoverable hiccup.', recoverable: true })
      await say(cinna, { type: 'partial', text: 'lost words again' })
      await expect(composer(cinna)).toHaveValue('Draft: kept words lost words again')
      await expect(stopButton(cinna)).toBeVisible()
      await expect(cinna.page.getByRole('alert').filter({ hasText: 'A recoverable hiccup.' })).toHaveCount(0)
    })

    await test.step('a fatal error is a toast; the partial goes, the confirmed text stays', async () => {
      await say(cinna, { type: 'error', code: 'no-speech', message: 'No speech was detected.', recoverable: false })
      const toast = cinna.page.getByRole('alert').filter({ hasText: 'No speech was detected.' })
      await expect(toast.locator('p')).toHaveText('No speech was detected.')
      await expect(toast.getByLabel('Error', { exact: true })).toBeVisible()
      await expect(composer(cinna)).toHaveValue('Draft: kept words')
      await expect(mirror(cinna)).toHaveCount(0)
      await expect(micButton(cinna)).toBeEnabled()
      await expect(micButton(cinna)).toHaveAttribute('aria-pressed', 'false')
    })

    await test.step('the next recording takes the toast down', async () => {
      await startDictation(cinna, 2)
      await expect(cinna.page.getByRole('alert').filter({ hasText: 'No speech was detected.' })).toHaveCount(0)
      await composer(cinna).press('Escape')
      await expect(composer(cinna)).toHaveValue('Draft: kept words')
      expect(await sentMessages(cinna)).toEqual([])
    })
  })
})
