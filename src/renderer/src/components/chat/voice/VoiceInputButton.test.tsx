import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SpeechStatus } from '../../../../../shared/speech'

type RecorderOptions = { onText: (text: string) => void; onError: (message: string | null) => void; dictation?: import('./useVoiceRecorder').DictationCallbacks }
const recorder = vi.hoisted(() => ({
  state: 'idle' as 'idle' | 'recording' | 'transcribing',
  /** The recorder's live state when it runs ahead of the rendered one. */
  live: null as 'idle' | 'recording' | 'transcribing' | null,
  current: () => recorder.live ?? recorder.state,
  toggle: vi.fn(),
  continueOnRelay: vi.fn(),
  options: null as RecorderOptions | null
}))
vi.mock('./useVoiceRecorder', () => ({
  useVoiceRecorder: (options: RecorderOptions) => {
    recorder.options = options
    return recorder
  }
}))
// The headphone button: the handlers the last mounted control registered.
const media = vi.hoisted(() => ({ handlers: null as { toggle: () => void; send: () => void } | null }))
vi.mock('./mediaKeys', () => ({
  registerMediaToggle: (handlers: { toggle: () => void; send: () => void }) => {
    media.handlers = handlers
    return { promote: () => {}, unregister: () => {} }
  }
}))

const status = vi.fn<() => Promise<SpeechStatus>>()
;(window as unknown as { api: Record<string, unknown> }).api = { speech: { status } }

const devices = [
  { kind: 'audioinput', deviceId: 'default', label: '' },
  { kind: 'audioinput', deviceId: 'mic-a', label: '' },
  { kind: 'audioinput', deviceId: 'mic-b', label: '' },
  { kind: 'videoinput', deviceId: 'cam', label: '' }
]
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { enumerateDevices: async () => devices, addEventListener: vi.fn(), removeEventListener: vi.fn() }
})

const { VoiceInputButton } = await import('./VoiceInputButton')
const { useUIStore } = await import('../../../stores/ui.store')
const { useToastStore } = await import('../../../stores/toast.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

const NO_CLOUD: SpeechStatus['cloud'] = { mode: 'off', setting: '', service: 'gemini', usable: false, providers: [], relay: { available: false } }
const supported: SpeechStatus = { supported: true, engine: 'macos', authorization: 'granted', available: true, cloud: NO_CLOUD }
const GEMINI_ONLY: SpeechStatus = {
  supported: false, engine: null, authorization: 'unknown', reason: 'Speech recognition needs macOS.', available: true,
  cloud: { mode: 'fallback', setting: '', service: 'gemini', usable: true, providers: [{ id: 'g1', name: 'Gemini' }], relay: { available: false } }
}

beforeEach(() => {
  recorder.state = 'idle'
  recorder.live = null
  recorder.toggle.mockReset()
  recorder.continueOnRelay.mockReset()
  status.mockReset()
  localStorage.removeItem('cinna-voice-input-device')
  useUIStore.setState({ voiceInputDeviceId: null, showVoiceInput: true })
  useToastStore.setState({ toast: null })
  recorder.options = null
  media.handlers = null
})

describe('VoiceInputButton', () => {
  it('renders nothing when speech is unsupported, or the API answers nonsense', async () => {
    status.mockResolvedValue({ supported: false, engine: null, authorization: 'unknown', available: false, cloud: NO_CLOUD })
    const { container, unmount } = render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    unmount()
    status.mockResolvedValue([] as never)
    const second = render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(second.container.innerHTML).toBe('')
  })

  it('shows where only Gemini can transcribe (no on-device engine), and stays hidden when that is not usable', async () => {
    status.mockResolvedValue(GEMINI_ONLY)
    const { unmount } = render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    const button = await screen.findByRole('button', { name: 'Audio input' })
    fireEvent.click(button)
    expect(recorder.toggle).toHaveBeenCalledTimes(1)
    unmount()
    status.mockResolvedValue({ ...GEMINI_ONLY, available: false, cloud: { mode: 'fallback', setting: '', service: 'gemini', usable: false, providers: [], relay: { available: false } } })
    const second = render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(second.container.innerHTML).toBe('')
  })

  it('is not blocked by a denied on-device permission while cloud transcription is on Always', async () => {
    status.mockResolvedValue({ ...supported, authorization: 'denied', cloud: { mode: 'always', setting: '', service: 'gemini', usable: true, providers: [{ id: 'g1', name: 'Gemini' }], relay: { available: false } } })
    const onError = vi.fn()
    render(createElement(VoiceInputButton, { onText: vi.fn(), onError, onSend: vi.fn() }), { wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Audio input' }))
    expect(recorder.toggle).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('Speech Recognition'))
  })

  it('marks the button with a cloud only while the session runs on gemini-live, without resizing it', async () => {
    status.mockResolvedValue(GEMINI_ONLY)
    const props = { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn(), dictation: { draftKey: 'chat-1', setDraft: vi.fn() } }
    const view = render(createElement(VoiceInputButton, props), { wrapper })
    await screen.findByRole('button', { name: 'Audio input' })
    recorder.state = 'recording'
    act(() => { recorder.options?.dictation?.onSessionStart() })
    act(() => { recorder.options?.dictation?.onBackend?.('sfspeech') })
    view.rerender(createElement(VoiceInputButton, props))
    let button = screen.getByRole('button', { name: 'Stop recording' })
    expect(screen.queryByTestId('voice-cloud-mark')).toBeNull()
    expect(button.getAttribute('title')).toBe('Stop recording')
    const classes = button.className

    act(() => { recorder.options?.dictation?.onBackend?.('gemini-live') })
    button = screen.getByRole('button', { name: 'Stop recording' })
    expect(screen.getByTestId('voice-cloud-mark')).toBeTruthy()
    expect(button.getAttribute('title')).toBe('Stop recording · Transcribing with Gemini — audio is sent to Google')
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Transcribing with Gemini — audio is sent to Google')
    // Same box: the mark is absolutely placed inside the padding.
    expect(button.className).toBe(classes)

    recorder.state = 'idle'
    act(() => { recorder.options?.dictation?.onSessionEnd(true) })
    view.rerender(createElement(VoiceInputButton, props))
    expect(screen.queryByTestId('voice-cloud-mark')).toBeNull()
    expect(screen.getByRole('button', { name: 'Audio input' }).getAttribute('aria-describedby')).toBeNull()
  })

  it('names the Cinna server in the cloud mark while the relay transcribes', async () => {
    status.mockResolvedValue({ ...supported, cloud: { ...NO_CLOUD, relay: { available: true, serverName: 'Acme' } } })
    const props = { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn(), dictation: { draftKey: 'chat-1', setDraft: vi.fn() } }
    const view = render(createElement(VoiceInputButton, props), { wrapper })
    await screen.findByRole('button', { name: 'Audio input' })
    recorder.state = 'recording'
    act(() => { recorder.options?.dictation?.onSessionStart() })
    act(() => { recorder.options?.dictation?.onBackend?.('core-relay') })
    view.rerender(createElement(VoiceInputButton, props))
    const button = screen.getByRole('button', { name: 'Stop recording' })
    expect(screen.getByTestId('voice-cloud-mark')).toBeTruthy()
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Transcribing on Acme: audio leaves this computer.')
    expect(button.getAttribute('title')).not.toContain('Google')
  })

  describe('the offer to continue on the Cinna server', () => {
    const OFFER = { message: 'Speech recognition stopped unexpectedly.', serverName: 'Acme', replay: [new Uint8Array(32_000), new Uint8Array(32_000)], replaySeconds: 2, stopped: false }

    /** A composer whose draft the dictation writes, with the caret where the test puts it. */
    async function mountComposer(initial: string) {
      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      onTestFinished(() => composer.remove())
      composer.value = initial
      const draft = { text: initial }
      const setDraft = vi.fn((update: (current: string) => string) => {
        draft.text = update(draft.text)
        composer.value = draft.text
      })
      const onError = vi.fn()
      const props = { onText: vi.fn(), onError, onSend: vi.fn(), composerRef: { current: composer }, dictation: { draftKey: 'chat-1', setDraft } }
      status.mockResolvedValue(supported)
      const view = render(createElement(VoiceInputButton, props), { wrapper })
      await screen.findByRole('button', { name: 'Audio input' })
      return { composer, draft, onError, view, props }
    }

    function failWithOffer(): void {
      act(() => { recorder.options?.dictation?.onSessionEnd(false) })
      act(() => { recorder.options?.dictation?.onOffer?.(OFFER) })
    }

    it('asks in a dialog instead of a toast; Keep closes it and sends nothing', async () => {
      const { onError } = await mountComposer('')
      act(() => { recorder.options?.dictation?.onSessionStart() })
      failWithOffer()
      const dialog = screen.getByRole('dialog', { name: 'Dictation stopped' })
      expect(dialog.textContent).toContain('Speech recognition stopped unexpectedly.')
      expect(dialog.textContent).toContain('Continue with Acme? The last 2 seconds that were not transcribed yet will be sent to Acme, and dictation continues there. If you keep the text, the 2 seconds not yet transcribed are discarded.')
      expect(onError).not.toHaveBeenCalledWith(expect.any(String))
      // The safe choice has focus: Enter on arrival sends nothing.
      expect(document.activeElement?.textContent).toBe('Keep the text')
      fireEvent.click(screen.getByRole('button', { name: 'Keep the text' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(recorder.continueOnRelay).not.toHaveBeenCalled()
    })

    it('Escape is Keep', async () => {
      await mountComposer('')
      act(() => { recorder.options?.dictation?.onSessionStart() })
      failWithOffer()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(recorder.continueOnRelay).not.toHaveBeenCalled()
    })

    it('Continue starts the relay session with the saved audio, and its text lands right after the failed dictation', async () => {
      const { composer, draft } = await mountComposer('Start. End')
      // Dictating at the caret after "Start.".
      composer.setSelectionRange(6, 6)
      act(() => { recorder.options?.dictation?.onSessionStart() })
      act(() => { recorder.options?.dictation?.onFinal('one') })
      expect(draft.text).toBe('Start. one End')
      failWithOffer()
      // The caret moved meanwhile; the continuation must not follow it.
      composer.setSelectionRange(0, 0)
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(recorder.continueOnRelay).toHaveBeenCalledWith({ replay: OFFER.replay, replaySeconds: 2, stopped: false })
      act(() => { recorder.options?.dictation?.onSessionStart() })
      act(() => { recorder.options?.dictation?.onFinal('two') })
      expect(draft.text).toBe('Start. one two End')
    })

    it('names the verb Finish after a stop, and says nothing is discarded when nothing waits', async () => {
      await mountComposer('')
      act(() => { recorder.options?.dictation?.onSessionStart() })
      act(() => { recorder.options?.dictation?.onSessionEnd(false) })
      act(() => { recorder.options?.dictation?.onOffer?.({ ...OFFER, replay: [], replaySeconds: 0, stopped: true }) })
      const dialog = screen.getByRole('dialog', { name: 'Dictation stopped' })
      expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
      expect(dialog.textContent).not.toContain('discarded')
    })

    it('the headphone button neither starts a dictation nor sends while the offer is asked', async () => {
      const { props } = await mountComposer('')
      act(() => { recorder.options?.dictation?.onSessionStart() })
      failWithOffer()
      act(() => { media.handlers?.toggle() })
      act(() => { media.handlers?.send() })
      expect(recorder.toggle).not.toHaveBeenCalled()
      expect(props.onSend).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      expect(recorder.continueOnRelay).toHaveBeenCalledTimes(1)
      // Answered: the headphone button works again.
      act(() => { media.handlers?.toggle() })
      expect(recorder.toggle).toHaveBeenCalledTimes(1)
    })

    it('a pending headphone send from the failed session is dropped', async () => {
      const { props } = await mountComposer('')
      recorder.state = 'recording'
      recorder.live = 'recording'
      act(() => { recorder.options?.dictation?.onSessionStart() })
      act(() => { media.handlers?.send() })
      recorder.state = 'idle'
      recorder.live = null
      failWithOffer()
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      act(() => { recorder.options?.dictation?.onSessionStart() })
      act(() => { recorder.options?.dictation?.onSessionEnd(true) })
      expect(props.onSend).not.toHaveBeenCalled()
    })
  })

  it('toggles recording on click', async () => {
    status.mockResolvedValue(supported)
    render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Audio input' }))
    expect(recorder.toggle).toHaveBeenCalledTimes(1)
  })

  it('explains instead of recording when speech recognition is denied', async () => {
    status.mockResolvedValue({ ...supported, authorization: 'denied' })
    const onError = vi.fn()
    render(createElement(VoiceInputButton, { onText: vi.fn(), onError, onSend: vi.fn() }), { wrapper })
    const button = await screen.findByRole('button', { name: 'Audio input' })
    expect(button.getAttribute('title')).toContain('Privacy & Security › Speech Recognition')
    fireEvent.click(button)
    expect(recorder.toggle).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Speech Recognition'))
  })

  it('picks the microphone from a right-click menu, numbering unlabelled ones', async () => {
    status.mockResolvedValue(supported)
    render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Audio input' }))
    const menu = screen.getByRole('menu', { name: 'Audio input' })
    expect(menu).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'System default' }).getAttribute('aria-checked')).toBe('true')
    const second = await screen.findByRole('menuitemradio', { name: 'Microphone 2' })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(3)
    await act(async () => { fireEvent.click(second) })
    expect(useUIStore.getState().voiceInputDeviceId).toBe('mic-b')
    expect(localStorage.getItem('cinna-voice-input-device')).toBe('mic-b')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Audio input' }))
    expect(screen.getByRole('menuitemradio', { name: 'Microphone 2' }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows a remembered microphone that is gone as the system default', async () => {
    useUIStore.setState({ voiceInputDeviceId: 'unplugged' })
    status.mockResolvedValue(supported)
    render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Audio input' }))
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'System default' }).getAttribute('aria-checked')).toBe('true'))
  })

  it('keeps one box through recording and transcribing', async () => {
    status.mockResolvedValue(supported)
    recorder.state = 'recording'
    const { rerender } = render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    const stop = await screen.findByRole('button', { name: 'Stop recording' })
    expect(stop.className).toContain('p-1.5')
    expect(stop.className).toContain('--color-danger')
    recorder.state = 'transcribing'
    rerender(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }))
    const busy = screen.getByRole('button', { name: 'Audio input' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(busy.className).toContain('p-1.5')
  })

  describe('headphone double click', () => {
    async function mount(state: 'idle' | 'recording' | 'transcribing') {
      status.mockResolvedValue(supported)
      recorder.state = state
      const onText = vi.fn()
      const onSend = vi.fn()
      const onError = vi.fn()
      const view = render(createElement(VoiceInputButton, { onText, onError, onSend }), { wrapper })
      await screen.findByRole('button', { name: state === 'recording' ? 'Stop recording' : 'Audio input' })
      const rerender = (next: 'idle' | 'recording' | 'transcribing'): void => {
        recorder.state = next
        view.rerender(createElement(VoiceInputButton, { onText, onError, onSend }))
      }
      return { onText, onSend, onError, rerender }
    }

    it('while recording, stops and sends exactly once, after the text is in the draft', async () => {
      const { onText, onSend, rerender } = await mount('recording')
      act(() => media.handlers!.send())
      expect(recorder.toggle).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
      rerender('transcribing')
      act(() => recorder.options!.onText('hello'))
      rerender('idle')
      expect(onText).toHaveBeenCalledWith('hello')
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onText.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0])
      // The next dictation is only appended.
      rerender('transcribing')
      act(() => recorder.options!.onText('again'))
      rerender('idle')
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('drops the send when the transcription fails', async () => {
      const { onSend, onError, rerender } = await mount('recording')
      act(() => media.handlers!.send())
      rerender('transcribing')
      act(() => recorder.options!.onError('Transcription failed'))
      expect(onError).toHaveBeenCalledWith('Transcription failed')
      // A later dictation, before the idle render, must not carry the old send.
      act(() => recorder.options!.onText('late'))
      rerender('idle')
      expect(onSend).not.toHaveBeenCalled()
    })

    it('goes by the live state, so a lagging render neither restarts nor leaves a send behind', async () => {
      // The recorder already went idle; the control still shows recording.
      const { onSend, rerender } = await mount('recording')
      recorder.live = 'idle'
      act(() => media.handlers!.send())
      expect(recorder.toggle).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
      recorder.live = null
      rerender('idle')
      // The next dictation, started by a click, lands without a send.
      rerender('recording')
      rerender('transcribing')
      act(() => recorder.options!.onText('next'))
      rerender('idle')
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('drops a pending send when the recorder goes idle with neither text nor an error', async () => {
      const { onSend, rerender } = await mount('transcribing')
      act(() => media.handlers!.send())
      expect(onSend).not.toHaveBeenCalled()
      rerender('idle')
      rerender('recording')
      rerender('transcribing')
      act(() => recorder.options!.onText('next'))
      rerender('idle')
      expect(onSend).not.toHaveBeenCalled()
    })

    it('while idle, sends the draft at once', async () => {
      const { onSend } = await mount('idle')
      act(() => media.handlers!.send())
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(recorder.toggle).not.toHaveBeenCalled()
    })
  })

  describe('hiding from the menu', () => {
    function hideFromMenu(name: string): void {
      fireEvent.contextMenu(screen.getByRole('button', { name }))
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Show audio input/ }))
    }

    it('says the recording was discarded, and hands focus to the composer', async () => {
      status.mockResolvedValue(supported)
      recorder.state = 'recording'
      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn(), composerRef: { current: composer } }), { wrapper })
      await screen.findByRole('button', { name: 'Stop recording' })
      hideFromMenu('Stop recording')
      expect(useUIStore.getState().showVoiceInput).toBe(false)
      expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull()
      expect(useToastStore.getState().toast?.message).toBe(
        'Audio input is hidden, and the recording was discarded. Turn it back on in Settings → Features → Interface → Show audio input.'
      )
      expect(document.activeElement).toBe(composer)
      composer.remove()
    })

    it('says nothing about a recording when there was none', async () => {
      status.mockResolvedValue(supported)
      render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
      await screen.findByRole('button', { name: 'Audio input' })
      hideFromMenu('Audio input')
      expect(useToastStore.getState().toast?.message).toBe(
        'Audio input is hidden. Turn it back on in Settings → Features → Interface → Show audio input.'
      )
      expect(useToastStore.getState().toast?.link).toEqual({ label: 'Open Settings → Features', settingsMenu: 'features' })
    })
  })

  it('opens its menu by right-click only', async () => {
    status.mockResolvedValue(supported)
    render(createElement(VoiceInputButton, { onText: vi.fn(), onError: vi.fn(), onSend: vi.fn() }), { wrapper })
    const button = await screen.findByRole('button', { name: 'Audio input' })
    expect(button.hasAttribute('aria-haspopup')).toBe(false)
    expect(button.getAttribute('title')).toBe('Audio input · right-click to choose the microphone')
  })
})
