# Voice Input — Technical Details

## File Locations

**Shared**
- `src/shared/speech.ts` — `SpeechEngineId`, `SpeechBackend` (`analyzer` | `sfspeech`), `SpeechAuthorization`, `SpeechProbe`, `SpeechStatus`, `TranscribeRequest`, `TranscribeResult`, `TranscribeFailureCode` (`denied` | `unavailable` | `no-speech` | `busy` | `failed`).

**Main**
- `src/main/speech/speechEngine.ts` — the `SpeechEngine` interface: `probe()` and `transcribe({ wav, locale })`; neither throws for an expected failure.
- `src/main/speech/speechService.ts` — `createSpeechService(engines)` and the `speechService` singleton (engines in preference order; only the macOS one today).
- `src/main/speech/engines/macosSpeech.ts` — `createMacosSpeechEngine(overrides)`, the helper runner, and the pure parsers `parseProbeOutput`, `parseTranscribeOutput`, `wantsModelInstall`, `transcribeTimeoutMs`.
- `src/main/ipc/speech.ipc.ts` — `registerSpeechHandlers()`, registered from `src/main/ipc/index.ts`.
- `src/main/index.ts:startup()` — `void speechService.startProbe()` right after `createWindow()` and `initAutoUpdater()`, off the startup path.

**Native helper**
- `native/speech/cinna-speech.swift` — the helper: `probe`, `transcribe --file <wav>`, `install`, each with an optional `--locale`.
- `native/speech/Info.plist` — embedded into the binary's `__TEXT,__info_plist` section; carries `CFBundleIdentifier` `io.opencinna.desktop.speech` and `NSSpeechRecognitionUsageDescription`.
- `scripts/build-speech-helper.sh` — builds `resources/speech/cinna-speech` (gitignored); `make speech-helper` runs it.

**Preload**
- `src/preload/index.ts` — `window.api.speech.status()` and `window.api.speech.transcribe(request)`.

**Renderer** (`src/renderer/src/components/chat/voice/`)
- `VoiceInputButton.tsx` — the button, its right-click menu (`ContextMenu` with `MicrophoneItem` radio rows and a `MenuSwitch` checkbox row), the blocked hint, the hide-and-toast action, the headphone registration and the send-after-text logic.
- `useVoiceRecorder.ts` — `useVoiceRecorder({ deviceId, onText, onError })`: `getUserMedia`, a 16 kHz `AudioContext`, the worklet, WAV encoding and the `speech.transcribe` call. Exposes `state`, `current()` (the live state, ahead of the render) and `toggle()`.
- `recorderWorklet.js` — the `cinna-recorder` AudioWorklet; imported with `?url&no-inline` because the renderer CSP blocks `blob:` and `data:` modules.
- `wav.ts` — `encodeWav(samples, rate)` (16-bit PCM mono) and `concatSamples(chunks)`.
- `useSpeechStatus.ts` — `useSpeechStatus()`, `fetchSpeechStatus()`, `SPEECH_STATUS_QUERY_KEY`, `speechBlocked(status)`, `SPEECH_BLOCKED_HINT`.
- `useVoiceErrorToast.ts` — `useVoiceErrorToast()`: error toasts owned by one composer.
- `mediaKeys.ts` + `silence.wav` — `registerMediaToggle(handlers)`: the headphone button through the Media Session API.
- `src/renderer/src/components/chat/ChatInput.tsx` — `appendDictation`, `showVoiceError`, `sendDisabled` (shared by Send and the headphone send), `sendFromHeadphones`; mounts `VoiceInputButton key={draftKey}` left of Send.
- `src/renderer/src/App.tsx` — prefetches `SPEECH_STATUS_QUERY_KEY` at module load.
- `src/renderer/src/stores/ui.store.ts` — `voiceInputDeviceId` / `setVoiceInputDeviceId`, `showVoiceInput` / `setShowVoiceInput`.
- `src/renderer/src/components/settings/FeaturesSettingsSection.tsx` — the `feature-show-voice-input` row.

**Tests**
- `src/main/speech/speechService.test.ts`, `src/main/speech/engines/macosSpeech.test.ts` — probe caching, backend pass-through, busy, authorization re-read, output parsing, timeout, temp-file deletion, one background install.
- `src/renderer/src/components/chat/voice/*.test.ts(x)` — recorder (short recording, denied mic, unmount mid-open and mid-transcription), WAV, media keys (top entry, promote, unregister, blur/focus), button (menu, blocked, one box, headphone sends), error toast ownership.
- `src/renderer/src/components/chat/ChatInput.voice.test.tsx` — a chat switch remounts the button and a late transcription lands in the original chat's draft.
- `scripts/packaged-dependencies.test.cjs` — `afterPack` refuses a mac package without an executable helper.

## Database Schema

None. Both preferences are renderer localStorage: `cinna-voice-input-device` (absent means system default) and `cinna-show-voice-input` (`'0'` hides; anything else, including absent, shows). `showVoiceInput` is synced across windows through the store's `storage` listener; the device is not.

## IPC Channels

- `speech:status` → `SpeechStatus`. No activation check: it says nothing user-scoped.
- `speech:transcribe` (`TranscribeRequest { wav: Uint8Array; locale? }`) → `TranscribeResult`. Calls `userActivation.requireActivated()`; rejects an empty WAV and one over 32 MB as `failed` data. Every failure is returned as `{ success: false, code, message }`, never thrown, because a thrown error's code does not survive IPC.

## Services & Key Methods

- `speechService.startProbe()` — probes the engines once in order and caches the first supported one; an engine that throws counts as unsupported with its reason.
- `speechService.status()` — the cached status. While authorization is not `granted`, each read asks the engine's `probe()` again (single-flight) and updates only `authorization`, so returning from System Settings enables the button without a restart. `backend` is the probe-time value and is not refreshed after a model install.
- `speechService.transcribe()` — `unavailable` with no engine, `busy` while that engine already runs one; afterwards a success records `granted` and a `denied` result records `denied`.
- `macosSpeech.probe()` — unsupported off darwin or when the helper file is missing, without spawning; otherwise `cinna-speech probe` with a 10 s timeout.
- `macosSpeech.transcribe()` — writes the WAV to `tmpdir()/cinna-speech-<uuid>.wav`, runs `cinna-speech transcribe --file` with `transcribeTimeoutMs(wav)` (60 s + 2 × duration from the WAV header's byte rate), and always deletes the file. A timeout reads "took too long"; a SIGABRT reads "no usage description" (see Security); output with `installModel: true` starts `installModel()`.
- `installModel()` — one background `cinna-speech install` at a time, 15-minute timeout, result only logged.
- `lastJsonLine()` — the helper prints one JSON line, possibly after framework log noise; the last line starting with `{` that parses wins. Malformed output is unsupported (probe) or `failed` (transcribe).

### The helper's contract
- Every handled case prints one JSON line and exits 0; a non-zero exit means the helper itself broke.
- `probe` never prompts (it reads `SFSpeechRecognizer.authorizationStatus()`) and returns `available`, `onDevice`, `authorization`, `locale`, `backend`, and on macOS 26 `model` (`installed` | `missing` | `downloading`).
- `transcribe` requests authorization when not determined (the system prompt), then picks the backend: `.ready` → SpeechAnalyzer over the file, falling back to SFSpeechRecognizer on any error (with `analyzerError` in the answer); `.needsModel` → SFSpeechRecognizer, plus `installModel: true` unless a download is already running; `.unusable` → SFSpeechRecognizer.
- SFSpeechRecognizer runs with `requiresOnDeviceRecognition = true` and `addsPunctuation` on macOS 13+; without `supportsOnDeviceRecognition` it answers `unavailable` ("downloading, try again in a minute" while the macOS 26 model installs, otherwise "isn't available on this Mac without sending audio to Apple"). Error 1110 maps to `no-speech`.
- The SpeechAnalyzer code is compiled only under `#if compiler(>=6.2)` and runs only under `#available(macOS 26, *)`; a helper built with an older SDK is SFSpeechRecognizer-only.
- `probe` reports `available` from `SFSpeechRecognizer.isAvailable` and does not require an on-device model, so the button can show for a language whose every transcription will then be refused.

## Renderer Components

- **`VoiceInputButton`** returns null unless `status.supported && showVoiceInput`; otherwise `VoiceInputControl`. Classes: idle muted, blocked dimmed (`speechBlocked`: denied or restricted), recording `--color-danger` with `motion-safe:animate-pulse`, transcribing a spinner with `disabled`.
- **Send after text.** A headphone double click sets `sendAfterText`; `handleText` consumes it and bumps `landed`; an effect on `landed` calls the latest `onSend`, so Send runs after the commit that put the dictation in the draft. Any error clears the flag, and so does the recorder returning to idle, so a stale double click cannot make the next dictation send itself. `send()` reads `current()`, not the rendered state.
- **Hide.** `hide()` sets `showVoiceInput` false, focuses the composer, and shows an `info` toast linking to `features`, mentioning a discarded recording when one was running.
- **`useVoiceRecorder`.** idle → recording → transcribing → idle. Stop waits 50 ms for the worklet's queued blocks, releases the mic and context, and refuses under 4000 samples (a quarter second) with "Nothing was recorded." A remembered device that is gone, or vanishes between check and open, falls back to the default. Unmount releases everything and discards a recording; a transcription in flight still calls `onText`.
- **`mediaKeys`.** A stack of registrations; the top one (most recently mounted, focused composer, or clicked button) receives `play`/`pause`/`stop` → toggle and `nexttrack` → send. While at least one is registered and the window is focused, `silence.wav` (7 s of zeros; Chromium wants ≥5 s to treat it as media) loops and `playbackState` is `playing`; blur or the last unregister pauses it and clears the handlers. No `globalShortcut`, which would need the Accessibility permission.
- **`useSpeechStatus`.** TanStack query, `staleTime: Infinity`, `refetchOnWindowFocus: 'always'`, `retry: false`. A missing `window.api.speech` or a malformed answer is unsupported, which keeps tests and older preloads working.
- **`useVoiceErrorToast`.** Shows `kind: 'error'`, `link: null`; `null` dismisses only if the store's current toast id is the one it showed.

## Configuration

- Build: `scripts/build-speech-helper.sh` (also `make speech-helper`), run by `build:mac`, `build:mac:unsigned`, `release:mac`, `release:all` and `scripts/bare-mac/package-app.sh`. Universal arm64 + x86_64, deployment target macOS 12, ad-hoc signed with identifier `io.opencinna.desktop.speech` (electron-builder re-signs it). No-op off macOS. The macOS 26 path needs the macOS 26 SDK from Xcode 26; with an older SDK (the Command Line Tools stop at 15.x) the script warns and builds SFSpeechRecognizer only. Packaging rules: [Release & Distribution](../../development/distribution/release.md#voice-input-helper).
- Helper location: `Resources/speech/cinna-speech` when packaged, `<appPath>/resources/speech/cinna-speech` in development, both through `runtimeHost`.
- Timeouts: probe 10 s, transcription 60 s + 2 × recording, model install 15 min. IPC cap 32 MB.

## Security

- Recognition is on the device only (see the business rules); the temp WAV is deleted after every run, success or not.
- **TCC charges speech recognition to the responsible process, not the helper.** The packaged app declares `NSSpeechRecognitionUsageDescription` and is responsible for the helper it launches. A development build started from a terminal (`npm run dev`) makes the terminal app responsible; it has no such string, so macOS kills the helper with SIGABRT and the toast says "no usage description". Dev mode therefore cannot transcribe — test with a packaged build launched by `open`. Crash reports land in `~/Library/Logs/DiagnosticReports/cinna-speech-*.ips`; their `responsibleProc` names the app TCC charged. A private macOS call could make the helper its own responsible process; it was deliberately not used.
- The hardened runtime blocks the microphone without `com.apple.security.device.audio-input`, whatever the user answers in the prompt.
- Microphone labels are empty until the Microphone permission is granted, which is why the menu numbers unlabelled inputs and shows only System default at first.
