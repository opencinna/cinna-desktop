// cinna-speech: Cinna Desktop's bridge to macOS speech recognition.
//
//   cinna-speech probe [--locale <id>]
//     {"available":bool,"onDevice":bool,"authorization":"…","locale":"en-US","backend":"analyzer|sfspeech","model":"…"}
//     Never prompts: it reads SFSpeechRecognizer.authorizationStatus().
//
//   cinna-speech transcribe --file <wav> [--locale <id>]
//     {"ok":true,"text":"…","backend":"…"} or {"ok":false,"code":"denied|unavailable|no-speech|failed","message":"…"}
//     Either may carry "installModel":true: the macOS 26 model for the language
//     is missing, and the caller should run `install` in the background.
//     Asks for authorization when it is not determined yet (the system prompt).
//
//   cinna-speech install [--locale <id>]
//     {"ok":true} once the macOS 26 speech model for the language is installed.
//
//   cinna-speech stream [--locale <id>]
//     Live dictation. stdin: raw 16-bit little-endian PCM, 16 kHz, mono, until
//     EOF. stdout: one JSON object per line —
//       {"type":"start","backend":"analyzer|sfspeech"} (may carry "installModel":true, as above)
//       {"type":"partial","text":"…"}   the whole unconfirmed segment so far; replaces the last one
//       {"type":"final","text":"…"}     a confirmed segment, never revised
//       {"type":"engine-change","backend":"sfspeech","reason":"…"}  SpeechAnalyzer failed to set up
//       {"type":"error","code":"denied|unavailable|failed","message":"…"}  ends the run
//       {"type":"done"}                  every final has been printed; ends the run
//     Exits 0 after `done` or `error`. SIGTERM is cancel: the process just dies.
//     Authorization and backend choice as for `transcribe`.
//
// Two backends. On macOS 26 and later, SpeechAnalyzer with SpeechTranscriber,
// once its per-language model is installed. Elsewhere, and while that model is
// missing or when SpeechAnalyzer fails, SFSpeechRecognizer. Recognition never leaves the Mac: the
// SFSpeechRecognizer path refuses a language that has no on-device model rather
// than fall back to Apple's servers.
//
// Every handled case of the one-shot commands prints one JSON line and exits 0
// (`stream` prints a line per event and ends on `done` or `error`); a non-zero exit means
// the helper itself broke. Built by scripts/build-speech-helper.sh, which embeds
// Info.plist (the Speech framework aborts a process whose main bundle has no
// NSSpeechRecognitionUsageDescription). The SpeechAnalyzer code needs the
// macOS 26 SDK (Swift 6.2); an older toolchain builds the SFSpeechRecognizer
// path alone.

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
     let line = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  } else {
    FileHandle.standardOutput.write("{\"ok\":false,\"code\":\"failed\",\"message\":\"Could not encode the result\"}\n".data(using: .utf8)!)
  }
  exit(0)
}

func fail(_ code: String, _ message: String, _ extra: [String: Any] = [:]) -> Never {
  emit(["ok": false, "code": code, "message": message].merging(extra) { _, new in new })
}

func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "granted"
  case .notDetermined: return "not-determined"
  case .denied: return "denied"
  case .restricted: return "restricted"
  @unknown default: return "unknown"
  }
}

func option(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

/** The requested locale, or the user's own. */
func requestedLocale() -> Locale {
  if let locale = option("--locale"), !locale.isEmpty { return Locale(identifier: locale) }
  return Locale.current
}

func makeRecognizer() -> SFSpeechRecognizer? {
  if let locale = option("--locale"), !locale.isEmpty {
    return SFSpeechRecognizer(locale: Locale(identifier: locale))
  }
  return SFSpeechRecognizer()
}

func bcp47(_ locale: Locale) -> String {
  return locale.identifier.replacingOccurrences(of: "_", with: "-")
}

func languageName(_ locale: Locale) -> String {
  return Locale.current.localizedString(forIdentifier: locale.identifier) ?? bcp47(locale)
}

// MARK: - SpeechAnalyzer (macOS 26+)

/** Where the macOS 26 engine stands for a language. */
enum AnalyzerState {
  /** Not built with the macOS 26 SDK, older macOS, no SpeechTranscriber on this Mac, or not this language. */
  case unusable
  /** Supported, but its model is not installed yet (or is downloading). */
  case needsModel(locale: Locale, downloading: Bool)
  case ready(locale: Locale)
}

#if compiler(>=6.2)
@available(macOS 26, *)
func analyzerState(for requested: Locale) async -> AnalyzerState {
  guard SpeechTranscriber.isAvailable,
        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else { return .unusable }
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  switch await AssetInventory.status(forModules: [transcriber]) {
  case .installed: return .ready(locale: locale)
  case .downloading: return .needsModel(locale: locale, downloading: true)
  case .supported: return .needsModel(locale: locale, downloading: false)
  case .unsupported: return .unusable
  @unknown default: return .unusable
  }
}

@available(macOS 26, *)
func analyzeFile(_ path: String, locale: Locale) async throws -> String {
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  async let collected = transcriber.results.reduce(into: (text: "", count: 0)) { acc, result in
    acc.text += String(result.text.characters)
    acc.count += 1
  }
  var reachedEnd = false
  do {
    if let end = try await analyzer.analyzeSequence(from: file) {
      reachedEnd = true
      try await analyzer.finalizeAndFinish(through: end)
    } else {
      await analyzer.cancelAndFinishNow()
    }
  } catch {
    // Ends the results stream, which `collected` is still reading.
    await analyzer.cancelAndFinishNow()
    throw error
  }
  let (text, count) = try await collected
  // Tells "the analyzer read no audio" apart from "it heard nothing in it".
  diagnose("analyzer \(reachedEnd ? "read to the end" : "found no audio to read"), \(count) result(s)")
  return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

@available(macOS 26, *)
func installModel(for locale: Locale) async throws {
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
}
#endif

/** The macOS 26 engine's state, or `.unusable` where it cannot exist. Blocks the caller. */
func currentAnalyzerState() -> AnalyzerState {
  #if compiler(>=6.2)
  if #available(macOS 26, *) {
    let requested = requestedLocale()
    return blocking { await analyzerState(for: requested) }
  }
  #endif
  return .unusable
}

/**
 * Runs async work from synchronous code. Never called on the main thread,
 * which every command leaves parked in dispatchMain() for the frameworks.
 */
final class Box<T>: @unchecked Sendable { var value: T? }

func blocking<T>(_ work: @escaping @Sendable () async -> T) -> T {
  let box = Box<T>()
  let done = DispatchSemaphore(value: 0)
  Task.detached {
    box.value = await work()
    done.signal()
  }
  done.wait()
  return box.value!
}

// MARK: - Commands

func probe() -> Never {
  let authorization = authorizationName(SFSpeechRecognizer.authorizationStatus())
  switch currentAnalyzerState() {
  case .ready(let locale):
    emit(["available": true, "onDevice": true, "authorization": authorization, "locale": bcp47(locale), "backend": "analyzer", "model": "installed"])
  case .needsModel(let locale, let downloading):
    // Until the model lands, transcriptions run on SFSpeechRecognizer.
    let recognizer = makeRecognizer()
    emit([
      "available": true,
      "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
      "authorization": authorization,
      "locale": bcp47(locale),
      "backend": "sfspeech",
      "model": downloading ? "downloading" : "missing"
    ])
  case .unusable:
    guard let recognizer = makeRecognizer() else {
      emit(["available": false, "onDevice": false, "authorization": authorization, "locale": bcp47(requestedLocale()), "backend": "sfspeech"])
    }
    emit([
      "available": recognizer.isAvailable,
      "onDevice": recognizer.supportsOnDeviceRecognition,
      "authorization": authorization,
      "locale": bcp47(recognizer.locale),
      "backend": "sfspeech"
    ])
  }
}

// kAFAssistantErrorDomain 1110: "No speech detected".
let noSpeechCodes: Set<Int> = [1110]

/** SFSpeechRecognizer, on-device only. `extra` rides along on every answer. */
func recognize(_ path: String, extra: [String: Any]) {
  let tagged = extra.merging(["backend": "sfspeech"]) { _, new in new }
  guard let recognizer = makeRecognizer() else {
    fail("unavailable", "Speech recognition does not support this language on this Mac.", tagged)
  }
  guard recognizer.supportsOnDeviceRecognition else {
    if extra["installModel"] != nil {
      fail("unavailable", "Apple's speech model for \(languageName(recognizer.locale)) is downloading. Try again in a minute.", tagged)
    }
    fail("unavailable", "Speech recognition for \(languageName(recognizer.locale)) isn't available on this Mac without sending audio to Apple.", tagged)
  }
  guard recognizer.isAvailable else {
    fail("unavailable", "Speech recognition is not available right now.", tagged)
  }
  // Callbacks run off the main thread, which stays parked in dispatchMain().
  recognizer.queue = OperationQueue()
  let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  request.shouldReportPartialResults = false
  request.requiresOnDeviceRecognition = true
  if #available(macOS 13, *) { request.addsPunctuation = true }
  // Held in a global until a callback exits the process.
  activeTask = recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
      let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { fail("no-speech", "No speech was detected.", tagged) }
      emit(["ok": true, "text": text].merging(tagged) { _, new in new })
    }
    if let error = error as NSError? {
      if noSpeechCodes.contains(error.code) { fail("no-speech", "No speech was detected.", tagged) }
      fail("failed", error.localizedDescription, tagged)
    }
  }
}

var activeTask: SFSpeechRecognitionTask?

/** One diagnostic line on stderr, which the app copies into its log. */
func diagnose(_ line: String) {
  FileHandle.standardError.write("cinna-speech: \(line)\n".data(using: .utf8)!)
}

/** The input's format as the frameworks read it, e.g. "16000 Hz, 1 ch, 2.40 s". */
func describeFile(_ path: String) -> String {
  guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { return "unreadable audio file" }
  let format = file.processingFormat
  let seconds = format.sampleRate > 0 ? Double(file.length) / format.sampleRate : 0
  return String(format: "%.0f Hz, %u ch, %.2f s", format.sampleRate, format.channelCount, seconds)
}

/** Authorized: picks the backend and runs it. */
func run(_ path: String) {
  let state = currentAnalyzerState()
  switch state {
  case .ready(let locale): diagnose("backend analyzer, locale \(bcp47(locale)), \(describeFile(path))")
  case .needsModel(let locale, let downloading): diagnose("backend sfspeech, analyzer model for \(bcp47(locale)) \(downloading ? "downloading" : "missing"), \(describeFile(path))")
  case .unusable: diagnose("backend sfspeech, \(describeFile(path))")
  }
  switch state {
  case .ready(let locale):
    #if compiler(>=6.2)
    if #available(macOS 26, *) {
      Task.detached {
        do {
          let text = try await analyzeFile(path, locale: locale)
          if text.isEmpty { fail("no-speech", "No speech was detected.", ["backend": "analyzer"]) }
          emit(["ok": true, "text": text, "backend": "analyzer"])
        } catch {
          // A new API on a new OS: when it fails, the older recognizer still can.
          diagnose("SpeechAnalyzer failed, using SFSpeechRecognizer: \(error.localizedDescription)")
          recognize(path, extra: ["analyzerError": error.localizedDescription])
        }
      }
      return
    }
    #endif
    recognize(path, extra: [:])
  case .needsModel(_, let downloading):
    // Already downloading: no second install request.
    recognize(path, extra: downloading ? [:] : ["installModel": true])
  case .unusable:
    recognize(path, extra: [:])
  }
}

func transcribe() {
  guard let path = option("--file") else { fail("failed", "Missing --file") }
  guard FileManager.default.fileExists(atPath: path) else { fail("failed", "Audio file not found") }
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized:
    run(path)
  case .denied:
    fail("denied", "Speech recognition is turned off for Cinna in System Settings.")
  case .restricted:
    fail("denied", "Speech recognition is restricted on this Mac.")
  case .notDetermined:
    SFSpeechRecognizer.requestAuthorization { status in
      if status == .authorized { run(path) }
      else { fail("denied", "Speech recognition was not allowed for Cinna.") }
    }
  @unknown default:
    fail("failed", "Unknown speech recognition authorization state.")
  }
}

func install() -> Never {
  #if compiler(>=6.2)
  if #available(macOS 26, *) {
    switch currentAnalyzerState() {
    case .ready:
      emit(["ok": true])
    case .needsModel(let locale, _):
      let error: String? = blocking {
        do { try await installModel(for: locale); return nil } catch { return error.localizedDescription }
      }
      if let error { fail("failed", error) }
      emit(["ok": true])
    case .unusable:
      fail("unavailable", "This Mac has no speech model for that language.")
    }
  }
  #endif
  fail("unavailable", "Speech models need macOS 26.")
}

// MARK: - stream (live dictation)

/** Serializes stream lines: the recognizer, the stdin reader and Tasks all print. */
let streamOutput = NSLock()

func writeStreamLine(_ object: [String: Any]) {
  let line: String
  if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
     let encoded = String(data: data, encoding: .utf8) {
    line = encoded
  } else {
    line = "{\"type\":\"error\",\"code\":\"failed\",\"message\":\"Could not encode an event\"}"
  }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

/** One stream event. Blocks forever once the run has ended (see `streamEnd`). */
func streamEvent(_ object: [String: Any]) {
  streamOutput.lock()
  writeStreamLine(object)
  streamOutput.unlock()
}

/** The run's last line, then exit. Holds the lock so nothing can print after it. */
func streamEnd(_ object: [String: Any]) -> Never {
  streamOutput.lock()
  writeStreamLine(object)
  exit(0)
}

func streamFail(_ code: String, _ message: String, _ extra: [String: Any] = [:]) -> Never {
  streamEnd(["type": "error", "code": code, "message": message].merging(extra) { _, new in new })
}

/** The PCM the caller writes on stdin, as AVAudio sees it. */
let streamInputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

/**
 * Reads stdin on its own thread (never the recognizer's) and hands each read
 * to `onBuffer` as Float32; a read can end mid-sample, so an odd byte waits for
 * the next one. `onEnd` runs once at EOF.
 */
func pumpStdin(onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onEnd: @escaping (_ seconds: Double) -> Void) {
  Thread.detachNewThread {
    var carry = Data()
    var bytesIn = 0
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty { break }
      bytesIn += chunk.count
      carry.append(chunk)
      let frames = carry.count / 2
      if frames == 0 { continue }
      guard let buffer = AVAudioPCMBuffer(pcmFormat: streamInputFormat, frameCapacity: AVAudioFrameCount(frames)) else { continue }
      buffer.frameLength = AVAudioFrameCount(frames)
      let samples = buffer.floatChannelData![0]
      carry.withUnsafeBytes { raw in
        let source = raw.bindMemory(to: Int16.self)
        for i in 0..<frames { samples[i] = Float(Int16(littleEndian: source[i])) / 32768 }
      }
      carry.removeFirst(frames * 2)
      onBuffer(buffer)
    }
    onEnd(Double(bytesIn) / 32000)
  }
}

/**
 * SFSpeechRecognizer on a live buffer. On-device recognition resets its
 * cumulative text after a pause of ~3 s and about every 60 s; the result just
 * before each reset is the only one with `speechRecognitionMetadata` (and is
 * not final), and it carries the whole segment. So: a metadata result is a
 * `final`, the next results start a new segment as `partial`s, and the
 * `isFinal` result after `endAudio()` is the last segment's `final`.
 */
func streamSFSpeech(extra: [String: Any], announce: Bool) {
  guard let recognizer = makeRecognizer() else {
    streamFail("unavailable", "Speech recognition does not support this language on this Mac.", extra)
  }
  guard recognizer.supportsOnDeviceRecognition else {
    if extra["installModel"] != nil {
      streamFail("unavailable", "Apple's speech model for \(languageName(recognizer.locale)) is downloading. Try again in a minute.", extra)
    }
    streamFail("unavailable", "Speech recognition for \(languageName(recognizer.locale)) isn't available on this Mac without sending audio to Apple.", extra)
  }
  guard recognizer.isAvailable else {
    streamFail("unavailable", "Speech recognition is not available right now.", extra)
  }
  if announce { streamEvent(["type": "start", "backend": "sfspeech"].merging(extra) { _, new in new }) }
  // One callback at a time, in order, off the main thread.
  let queue = OperationQueue()
  queue.maxConcurrentOperationCount = 1
  recognizer.queue = queue
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  request.requiresOnDeviceRecognition = true
  if #available(macOS 13, *) { request.addsPunctuation = true }
  // The segment a metadata result just confirmed: the `isFinal` result can
  // repeat it when no new speech followed.
  var confirmed: String?
  activeTask = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
      if result.isFinal {
        if !text.isEmpty && text != confirmed { streamEvent(["type": "final", "text": text]) }
        streamEnd(["type": "done"])
      }
      if result.speechRecognitionMetadata != nil {
        if !text.isEmpty && text != confirmed { streamEvent(["type": "final", "text": text]) }
        confirmed = text
        return
      }
      if !text.isEmpty {
        confirmed = nil
        streamEvent(["type": "partial", "text": text])
      }
      return
    }
    if let error = error as NSError? {
      if noSpeechCodes.contains(error.code) { streamEnd(["type": "done"]) }
      streamFail("failed", error.localizedDescription)
    }
  }
  pumpStdin(onBuffer: { request.append($0) }, onEnd: { seconds in
    diagnose(String(format: "stream: end of audio after %.2f s", seconds))
    request.endAudio()
  })
}

#if compiler(>=6.2)
/** Why SpeechAnalyzer could not be set up; the caller falls back to SFSpeechRecognizer. */
struct AnalyzerSetupError: Error, LocalizedError {
  let reason: String
  var errorDescription: String? { reason }
}

/**
 * SpeechAnalyzer on a live buffer: volatile results are `partial`s, final ones
 * `final`s. Throws `AnalyzerSetupError` only before any audio was read; once
 * audio flows, a failure ends the run with `error`.
 */
@available(macOS 26, *)
func streamAnalyzer(locale: Locale) async throws {
  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    throw AnalyzerSetupError(reason: "no audio format for SpeechTranscriber")
  }
  guard let converter = AVAudioConverter(from: streamInputFormat, to: format) else {
    throw AnalyzerSetupError(reason: "cannot convert 16 kHz audio to \(format)")
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
  do {
    try await analyzer.start(inputSequence: input)
  } catch {
    throw AnalyzerSetupError(reason: error.localizedDescription)
  }
  let reader = Task {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if result.isFinal {
          if !text.isEmpty { streamEvent(["type": "final", "text": text]) }
        } else {
          streamEvent(["type": "partial", "text": text])
        }
      }
    } catch {
      streamFail("failed", error.localizedDescription)
    }
  }
  let ended = DispatchSemaphore(value: 0)
  pumpStdin(onBuffer: { buffer in
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / streamInputFormat.sampleRate) + 16
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      streamFail("failed", "Could not allocate an audio buffer.")
    }
    var given = false
    var conversionError: NSError?
    let status = converter.convert(to: converted, error: &conversionError) { _, state in
      if given { state.pointee = .noDataNow; return nil }
      given = true
      state.pointee = .haveData
      return buffer
    }
    if status == .error { streamFail("failed", conversionError?.localizedDescription ?? "Audio conversion failed.") }
    if converted.frameLength > 0 { feed.yield(AnalyzerInput(buffer: converted)) }
  }, onEnd: { seconds in
    diagnose(String(format: "stream: end of audio after %.2f s", seconds))
    feed.finish()
    ended.signal()
  })
  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    DispatchQueue.global().async { ended.wait(); done.resume() }
  }
  do {
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    streamFail("failed", error.localizedDescription)
  }
  _ = await reader.result
  streamEnd(["type": "done"])
}
#endif

/** Authorized: picks the backend like `run` and streams. */
func runStream() {
  let state = currentAnalyzerState()
  switch state {
  case .ready(let locale):
    diagnose("stream: backend analyzer, locale \(bcp47(locale))")
    #if compiler(>=6.2)
    if #available(macOS 26, *) {
      streamEvent(["type": "start", "backend": "analyzer"])
      Task.detached {
        do {
          try await streamAnalyzer(locale: locale)
        } catch {
          // Only setup failures get here, before any audio was read.
          let reason = error.localizedDescription
          diagnose("stream: SpeechAnalyzer setup failed, using SFSpeechRecognizer: \(reason)")
          streamEvent(["type": "engine-change", "backend": "sfspeech", "reason": reason])
          streamSFSpeech(extra: [:], announce: false)
        }
      }
      return
    }
    #endif
    streamSFSpeech(extra: [:], announce: true)
  case .needsModel(let locale, let downloading):
    diagnose("stream: backend sfspeech, analyzer model for \(bcp47(locale)) \(downloading ? "downloading" : "missing")")
    streamSFSpeech(extra: downloading ? [:] : ["installModel": true], announce: true)
  case .unusable:
    diagnose("stream: backend sfspeech")
    streamSFSpeech(extra: [:], announce: true)
  }
}

func stream() {
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized:
    runStream()
  case .denied:
    streamFail("denied", "Speech recognition is turned off for Cinna in System Settings.")
  case .restricted:
    streamFail("denied", "Speech recognition is restricted on this Mac.")
  case .notDetermined:
    SFSpeechRecognizer.requestAuthorization { status in
      if status == .authorized { DispatchQueue.global().async { runStream() } }
      else { streamFail("denied", "Speech recognition was not allowed for Cinna.") }
    }
  @unknown default:
    streamFail("failed", "Unknown speech recognition authorization state.")
  }
}

// Each command runs on a background queue and exits the process when it has
// answered; the main thread stays free for any framework callback that needs it.
let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let commands: [String: () -> Void] = ["probe": { probe() }, "transcribe": transcribe, "install": { install() }, "stream": stream]
guard let body = commands[command] else {
  FileHandle.standardError.write("usage: cinna-speech probe [--locale <id>] | transcribe --file <wav> [--locale <id>] | install [--locale <id>] | stream [--locale <id>]\n".data(using: .utf8)!)
  exit(2)
}
DispatchQueue.global().async(execute: body)
dispatchMain()
