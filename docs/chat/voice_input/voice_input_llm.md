# Voice Input — LLM Reference

Working on composer dictation. Behaviour: [voice_input.md](voice_input.md); files and methods: [voice_input_tech.md](voice_input_tech.md).

## Placement

- `src/main/speech/` imports no Electron: paths through `host/runtimeHost.ts` (`isPackaged`, `resourcesPath`, `getAppPath`), logging through `logger`. It still is a **desktop-only feature** — it exists for the composer, needs a Mac and a GUI app for TCC, and has no Hub-core caller. Do not wire it into `hub/core.ts`; startup kicks it from `src/main/index.ts`.
- Renderer code lives in `src/renderer/src/components/chat/voice/`; `ChatInput.tsx` only appends, toasts and sends.
- A new engine (OpenAI transcription, a remote service) implements `SpeechEngine` and joins the list passed to `createSpeechService` in preference order. Do not branch on engine id elsewhere.
- A new Apple recognizer goes into `native/speech/cinna-speech.swift` as another backend, not a second helper or engine; extend `SpeechBackend`.

## Rules that are easy to break

- Failures are data (`TranscribeResult.success: false` + `code`), never a throw across IPC: a thrown DomainError's code never reaches the renderer.
- The helper prints exactly one JSON line and exits 0 for every handled case; main reads the **last** `{`-line because frameworks log to stdout first. A non-zero exit is "helper broke".
- `requiresOnDeviceRecognition` stays true. Falling back to Apple's servers would break the settings row's promise; the user chose an error toast instead.
- Keep `transcribeTimeoutMs` proportional to the recording; a flat limit kills long dictations.
- `VoiceInputButton` is keyed by `draftKey` in `ChatInput`. Removing the key lets a dictation from one chat be sent in another.
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
- **The macOS 26 SpeechAnalyzer path has never been executed**: it compiles and main's side is unit-tested, but the only hands-on runs were on macOS 15.6. Do not describe it as verified. Options: a macOS 26 machine, or a Tart VM ([Bare-Mac Tests](../../development/bare_mac/bare_mac.md)), where the TCC prompt needs GUI interaction.
- Real recording and TCC cannot run in E2E. A scripted spec can cover hidden-when-unsupported, the menu, the Show audio input switch and its toast, and an error toast from a faked transcribe result.
- Unit tests: `npx vitest run src/main/speech src/renderer/src/components/chat/voice src/renderer/src/components/chat/ChatInput.voice.test.tsx`; the packaging guard runs in `npm run test:packaging`.
