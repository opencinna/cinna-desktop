import type { ToolStream } from '../../../shared/messageParts'

/**
 * What the compact transcript's dot preview shows for one tool step. Plain
 * data, built only for the dot being previewed: every text in it is cut to what
 * the preview draws, so hovering a dot never puts a megabyte of output into
 * the DOM.
 */
export interface ToolStepPreview {
  /** A call is part of this step; the call section is drawn. */
  hasCall: boolean
  toolName?: string
  /** The call's key input: a shell command, a path, a pattern, a URL, or compact JSON. */
  input?: string
  /** What the agent said about the call. */
  narration?: string
  /** The paired output; `undefined` when no result belongs to this step, `''` when it came back empty. */
  output?: string
  outputStream?: ToolStream
  /** Lines cut from `output`, for the "… N more lines" line. */
  outputMoreLines?: number
  /** The call has not returned yet. */
  running?: boolean
  status: 'pending' | 'done' | 'error'
  /**
   * Which section the dot itself stands for, drawn at full strength while the
   * other is dimmed. Unset for a dot that is both (a combined call + result).
   */
  focus?: 'call' | 'output'
}

/** The fields of a message part (or a live block) the pairing and the preview read. */
export interface ToolStepPart {
  kind: string
  text: string
  toolId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolStream?: ToolStream
}

export interface ToolStepPairs {
  /** Result index → the index of the call it answers. */
  callOf: Map<number, number>
  /** Call index → its result indices, in order. */
  resultsOf: Map<number, number[]>
}

/**
 * Pair each `tool_result` with its `tool` call. By `toolId`: the nearest
 * preceding call with the same id. A result with no `toolId` falls back to
 * the part immediately before it, when that is a call no other result has
 * claimed. A result whose id matches no earlier call stays unpaired —
 * adjacency is not evidence against an id that says otherwise.
 */
export function pairToolSteps(parts: ReadonlyArray<{ kind: string; toolId?: string }>): ToolStepPairs {
  const callOf = new Map<number, number>()
  const resultsOf = new Map<number, number[]>()
  const lastCallById = new Map<string, number>()
  parts.forEach((part, index) => {
    if (part.kind === 'tool') {
      if (part.toolId) lastCallById.set(part.toolId, index)
      return
    }
    if (part.kind !== 'tool_result') return
    let call: number | undefined
    if (part.toolId) {
      call = lastCallById.get(part.toolId)
    } else if (index > 0 && parts[index - 1].kind === 'tool' && !resultsOf.has(index - 1)) {
      call = index - 1
    }
    if (call === undefined) return
    callOf.set(index, call)
    const results = resultsOf.get(call)
    if (results) results.push(index)
    else resultsOf.set(call, [index])
  })
  return { callOf, resultsOf }
}

const OUTPUT_MAX_LINES = 15
const OUTPUT_MAX_CHARS = 2000
const INPUT_MAX_LINES = 8
const INPUT_MAX_CHARS = 600
const NARRATION_MAX_CHARS = 400

/** Newlines in `text` from `from` on, counted without splitting the string. */
function countLines(text: string, from: number): number {
  if (from >= text.length) return 0
  let lines = 1
  let at = text.indexOf('\n', from)
  while (at !== -1 && at < text.length - 1) {
    lines++
    at = text.indexOf('\n', at + 1)
  }
  return lines
}

/**
 * Where `text` ends once trailing whitespace is dropped. A loop, not
 * `/\s+$/`: that regex retries from every whitespace run in the string and is
 * quadratic on a long blank stretch in the middle of an output.
 */
function trimmedEnd(text: string): number {
  let end = text.length
  while (end > 0 && /\s/.test(text[end - 1])) end--
  return end
}

/**
 * The head of `text`: at most `maxLines` lines and `maxChars` characters, and
 * how many lines were left out. A single line longer than the budget is cut
 * and ends in an ellipsis.
 */
export function clipText(text: string, maxLines: number, maxChars: number): { text: string; moreLines: number } {
  let end = 0
  let lines = 0
  while (lines < maxLines) {
    const nl = text.indexOf('\n', end)
    if (nl === -1) {
      end = text.length
      lines++
      break
    }
    end = nl + 1
    lines++
  }
  if (end >= text.length && text.length <= maxChars) return { text, moreLines: 0 }
  let head = text.slice(0, Math.min(end, maxChars))
  const cutMidLine = end > maxChars
  if (head.endsWith('\n')) head = head.slice(0, -1)
  const moreLines = countLines(text, cutMidLine ? text.indexOf('\n', maxChars) + 1 || text.length : end)
  return { text: cutMidLine ? `${head}…` : head, moreLines }
}

const INPUT_KEYS = ['file_path', 'path', 'pattern', 'url'] as const

/** The one input that says what a call did, rather than every argument. */
export function keyToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined
  let value: string | undefined
  const command = input.command ?? input.cmd
  if (typeof command === 'string') value = command
  else if (Array.isArray(command) && command.every((c) => typeof c === 'string')) value = command.join(' ')
  else {
    const key = INPUT_KEYS.find((k) => typeof input[k] === 'string')
    if (key) value = input[key] as string
    else if (Object.keys(input).length > 0) {
      try {
        value = JSON.stringify(input)
      } catch {
        value = undefined
      }
    }
  }
  if (!value) return undefined
  return clipText(value.trim(), INPUT_MAX_LINES, INPUT_MAX_CHARS).text
}

function clipNarration(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > NARRATION_MAX_CHARS ? `${trimmed.slice(0, NARRATION_MAX_CHARS)}…` : trimmed
}

interface CallFields {
  toolName?: string
  toolInput?: Record<string, unknown>
  /** The call's own text: the agent's narration of it. */
  narration?: string
  /** Shown as the input verbatim instead of the key input (a Cinna CLI command). */
  input?: string
}

/**
 * A preview from its pieces: a call (or none), the outputs that answer it (or
 * none), and whether it is still running. Used directly for the steps that
 * are one dot already — a Cinna CLI call with its results, a chat-level tool
 * call — and by {@link toolStepPreview} for a call and result pair.
 */
export function buildToolStepPreview(args: {
  call?: CallFields
  outputs?: ReadonlyArray<{ text: string; toolStream?: ToolStream }>
  running?: boolean
  focus?: 'call' | 'output'
}): ToolStepPreview {
  const { call, outputs, running, focus } = args
  const preview: ToolStepPreview = { hasCall: !!call, status: 'done', focus }
  if (call) {
    preview.toolName = call.toolName
    preview.input = call.input !== undefined
      ? clipText(call.input, INPUT_MAX_LINES, INPUT_MAX_CHARS).text
      : keyToolInput(call.toolInput)
    const narration = call.narration ? clipNarration(call.narration) : undefined
    // A narration that only restates the input ("Bash: ls -la", an ACP title)
    // says nothing the input does not.
    if (narration && !(preview.input && narration.includes(preview.input))) preview.narration = narration
  }
  if (outputs && outputs.length > 0) {
    const joined = outputs.map((o) => o.text).join(outputs.length > 1 ? '\n' : '')
    const clipped = clipText(joined.slice(0, trimmedEnd(joined)), OUTPUT_MAX_LINES, OUTPUT_MAX_CHARS)
    preview.output = clipped.text
    if (clipped.moreLines > 0) preview.outputMoreLines = clipped.moreLines
    const stderr = outputs.some((o) => o.toolStream === 'stderr')
    preview.outputStream = stderr ? 'stderr' : 'stdout'
    if (stderr) preview.status = 'error'
  }
  if (running && !(outputs && outputs.length > 0)) {
    preview.running = true
    preview.status = 'pending'
  }
  return preview
}

/**
 * The preview for the dot at `parts[index]` — a call or a result — with its
 * pair's half filled in, so either dot previews the whole step. `pairKey` is
 * shared by a call and its results (`keyPrefix` keeps it unique across the
 * messages a dots group may span); an unpaired part gets none.
 */
export function toolStepPreview(
  parts: ReadonlyArray<ToolStepPart>,
  index: number,
  pairs: ToolStepPairs,
  opts: { keyPrefix: string; running?: boolean }
): { pairKey?: string; preview: () => ToolStepPreview } {
  const part = parts[index]
  const isCall = part.kind === 'tool'
  const callIndex = isCall ? index : pairs.callOf.get(index)
  const call = callIndex !== undefined ? parts[callIndex] : undefined
  const resultIndices = isCall
    ? pairs.resultsOf.get(index) ?? []
    : callIndex !== undefined ? pairs.resultsOf.get(callIndex) ?? [index] : [index]
  // Built only when its dot is hovered: the transcript makes these items on
  // every streaming chunk, and an output may be megabytes long.
  const preview = (): ToolStepPreview => buildToolStepPreview({
    call: call ? { toolName: call.toolName, toolInput: call.toolInput, narration: call.text } : undefined,
    outputs: resultIndices.map((i) => parts[i]),
    // Only a call can be waiting on its output.
    running: isCall && opts.running,
    focus: isCall ? 'call' : 'output'
  })
  const paired = callIndex !== undefined && (isCall ? resultIndices.length > 0 : true)
  return paired ? { pairKey: `${opts.keyPrefix}:${callIndex}`, preview } : { preview }
}
