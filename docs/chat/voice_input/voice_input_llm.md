# Voice Input — LLM Reference

Working on composer dictation. Behaviour: [voice_input.md](voice_input.md); files and methods: [voice_input_tech.md](voice_input_tech.md).

## Placement

- `src/main/speech/` imports no Electron: paths through `host/runtimeHost.ts` (`isPackaged`, `resourcesPath`, `getAppPath`), logging through `logger`. It still is a **desktop-only feature** — it exists for the composer, needs a Mac and a GUI app for TCC, and has no Hub-core caller. Do not wire it into `hub/core.ts`; startup kicks it from `src/main/index.ts`.
- Renderer code lives in `src/renderer/src/components/chat/voice/`; `ChatInput.tsx` only appends, toasts and sends.
- A new engine (OpenAI transcription, a remote service) implements `SpeechEngine` and joins the list passed to `createSpeechService` in preference order. Do not branch on engine id elsewhere.
- A new Apple recognizer goes into `native/speech/cinna-speech.swift` as another backend, not a second helper or engine; extend `SpeechBackend`.

## Rules that are easy to break

- Failures are data (`TranscribeResult.success: false` + `code`), never a throw across IPC: a thrown DomainError's code never reaches the renderer.
- `probe`, `transcribe` and `install` print exactly one JSON line and exit 0 for every handled case; main reads the **last** `{`-line because frameworks log to stdout first. A non-zero exit is "helper broke". `stream` is the exception: NDJSON, one event per line (`start`, `partial`, `final`, `engine-change`, `error`, `done`), parsed line by line with `parseStreamLine`, unknown lines skipped; `error` and `done` end the run.
- `requiresOnDeviceRecognition` stays true. Falling back to Apple's servers would break the settings row's promise; the user chose an error toast instead.
- Keep `transcribeTimeoutMs` proportional to the recording; a flat limit kills long dictations.
- `VoiceInputButton` is keyed by `draftKey` in `ChatInput`. Removing the key lets a dictation from one chat be sent in another.
- Live dictation: only **finals** go into the draft; the partial lives in `liveDictation.store` and is drawn by `DictationMirror`. Writing a partial into the draft would leave guesses behind on cancel or crash. `partial` is the whole current segment and replaces the last one; `final` is never revised.
- SFSpeechRecognizer's running text resets after ~3 s of pause and ~60 s; the result carrying `speechRecognitionMetadata` just before a reset is the segment's `final` (it is not `isFinal`). Dropping that rule loses everything before the first pause.
- Stream contract is `speech:stream` via `ipcMain.on` + `ipcRenderer.postMessage` (port on `event.ports[0]`, options as the second argument), not `ipcHandle`. Types `SpeechStreamEvent` / `SpeechStreamCommand` / `SpeechStreamHandle` live in `src/shared/speech.ts`; every frame is validated on both sides. Exactly one terminal event, then the port closes; errors are frames.
- A stream and a batch transcription share the engine's single `busy` slot (`speechService`). The batch path stays for a preload without `speech.stream` (`useVoiceRecorder` checks `typeof api.stream === 'function'`); do not remove it, and do not make live mode fall back to batch silently without changing the docs.
- Keystroke, paste and drop call `freezeDictation`, which keeps the whole dictation (confirmed + partial), including words the display has not typed out yet. A keystroke's event value holds only the typed-out display, so `onChange` moves the key onto the whole text with `editOntoGoal` (`dictationSpan.ts`) before `handleInput`; without that, a key during the typing animation overwrote confirmed words; Esc cancels (confirmed only); Enter and the Send button go through `controls.send()`, never `handleSend` directly while a dictation is live, or the last words miss the send.
- Typing animation constants live in `useTypedText.ts` / `dictationSpan.ts` (`MAX_BACKSPACES` 24); reduced motion bypasses it entirely.
- `appendDictation` writes the draft store, not component state, so a transcription that finishes after unmount still lands. The headphone send must stay behind the `landed` effect so `onSend` sees the new draft.
- The button keeps one box in every state, and the status is prefetched in `App.tsx`; do not make the button or the Features row appear after an async read (ux_rules §1).
- Voice errors are `kind: 'error'` toasts via `useVoiceErrorToast`; it dismisses only its own toast by id (`toast.store` `show()` returns a unique id).
- `recorderWorklet.js` and `silence.wav` load by URL (`?url&no-inline`, `?no-inline`): the CSP blocks `blob:`/`data:` modules.
- WAV, not WebM: AVFoundation cannot read WebM, and every engine takes WAV.

## Build and packaging

- `resources/speech/` is gitignored and built by `scripts/build-speech-helper.sh`; it ships through **mac-only** `extraResources` and is excluded from `files` (an executable must sit outside the asar). `afterPack` fails a darwin package without an executable helper; Linux and Windows never look for it.
- SpeechAnalyzer compiles only with the macOS 26 SDK (Xcode 26, `#if compiler(>=6.2)`). With Command Line Tools (SDK ≤ 15.x) the script warns and the helper is SFSpeechRecognizer-only — a release built that way silently loses the macOS 26 backend. Deployment target stays 12.
- Usage strings in `electron-builder.yml` `mac.extendInfo` must be a **map**; a list writes keys `"0"`, `"1"`, … and macOS shows none of them.

## Testing

- Dev mode cannot transcribe: the terminal is the TCC responsible process and the helper dies with SIGABRT. Test with a packaged build launched by `open` (`npx electron-vite build && make speech-helper && npx electron-builder --mac dir --arm64 -c.mac.notarize=false`, then `open` the `.app` under `dist/`). It uses the real profile: quit any other Cinna first.
- Diagnose TCC with `~/Library/Logs/DiagnosticReports/cinna-speech-*.ips` → `responsibleProc`.
- Diagnose "No speech was detected." from the in-app log (scopes `voice` and `speech-macos`; [tech doc](voice_input_tech.md#diagnostic-log-lines)): 0 chunks or peak 0 is the mic, a non-zero peak with `backend analyzer` and 0 results is SpeechAnalyzer. Never log transcript text — a character count at most.
- **The macOS 26 SpeechAnalyzer path has never been executed, for batch or streaming**: it compiles and main's side is unit-tested, but the only hands-on runs were on macOS 15.6. Do not describe it as verified. Options: a macOS 26 machine, or a Tart VM ([Bare-Mac Tests](../../development/bare_mac/bare_mac.md)), where the TCC prompt needs GUI interaction.
- Known gaps in live mode: SFSpeechRecognizer error 1110 in long silence ends the stream as `done`; returning to a chat while its dictation finishes loses the pending Enter and a new mic click gets `busy`; a fatal error has no batch fallback (the unconfirmed tail is lost).
- Real recording and TCC cannot run in E2E. A scripted spec can cover hidden-when-unsupported, the menu, the Show audio input switch and its toast, and an error toast from a faked transcribe result.
- Unit tests: `npx vitest run src/main/speech src/renderer/src/components/chat/voice src/renderer/src/components/chat/ChatInput.voice.test.tsx src/renderer/src/components/chat/ChatInput.dictation.test.tsx src/main/ipc/speech.ipc.test.ts`; the packaging guard runs in `npm run test:packaging`.
