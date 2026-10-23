/**
 * The Run Script form and the command line, kept in step. Pure.
 *
 * - **Line → form** ({@link readCommand}): the line splits into words; when it
 *   still names the spec's script, the words after it fill the form's values,
 *   and what the form does not know is kept, in order, as "Other arguments".
 *   Anything else (a `$`, a pipe, another script) is null: the form is then
 *   "edited by hand" and follows the line again once it parses.
 * - **Form → line** ({@link editCommand}): only the edited parameter's words
 *   change, in place; a newly set one is added (a positional at its place,
 *   an option at the end), a cleared one loses only its words. Everything
 *   else, the user's order and quoting included, stays as typed.
 *   {@link buildCommand} writes the whole line in spec order, for when an
 *   edit in place cannot be trusted: the text up to and including the script
 *   word is kept **verbatim**, then positionals, options and the other
 *   arguments.
 */

import { ENV_ASSIGNMENT, scriptWordIndex, shellQuote, splitCommandLine, splitCommandSpans, type CommandWordSpan } from './commandRun'
import type { ScriptParam, ScriptSpec } from './scriptSpec'

/**
 * A form's values by param id: a switch is a boolean, a count its number as
 * text, anything else the value as typed (a multiple value: its words, as a
 * shell would read them). An empty value is omitted from the line.
 */
export type ScriptValues = Record<string, string | boolean>

export interface ScriptForm {
  /** The line up to and including the script word, verbatim. */
  prefix: string
  values: ScriptValues
  /** What the form does not know, as shell words. */
  other: string
}

/** The flag the form writes for a param: its first long flag, else its first. */
export function preferredFlag(param: ScriptParam): string {
  return param.flags.find((flag) => flag.startsWith('--')) ?? param.flags[0] ?? ''
}

const looksLikeOption = (word: string): boolean => word.startsWith('-') && word.length > 1 && !/^-\d/.test(word)

/**
 * The words after the script, read against the spec: the values it knows and
 * the words it does not, in order. `--x=v` and `--x v` both read; `--` ends
 * the options, and it and everything after it are kept as they are.
 */
export function parseArgs(spec: ScriptSpec, words: string[]): { values: ScriptValues; unknown: string[] } {
  const { values, unknown } = assignArgs(spec, words)
  return { values, unknown }
}

/**
 * {@link parseArgs} with each word's owner: the param id it was read into, or
 * null for a word the form does not know (an "other" argument).
 */
function assignArgs(spec: ScriptSpec, words: string[]): { values: ScriptValues; unknown: string[]; owners: (string | null)[] } {
  const values: ScriptValues = {}
  const unknown: string[] = []
  const owners: (string | null)[] = words.map(() => null)
  const lists = new Map<string, string[]>()
  const byFlag = new Map<string, ScriptParam>()
  for (const param of spec.params) for (const flag of param.flags) byFlag.set(flag, param)
  const loose: string[] = []
  const looseAt: number[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '--') { unknown.push(...words.slice(i)); break }
    if (!looksLikeOption(word)) { loose.push(word); looseAt.push(i); continue }
    const eq = word.startsWith('--') ? word.indexOf('=') : -1
    const name = eq === -1 ? word : word.slice(0, eq)
    let param = byFlag.get(name)
    if (!param && eq === -1 && /^-[A-Za-z]{2,}$/.test(word)) {
      // `-vvv`: a short count flag given several times.
      const counted = byFlag.get(word.slice(0, 2))
      if (counted?.kind === 'count' && new Set(word.slice(1)).size === 1) {
        values[counted.id] = String(Number(values[counted.id] || 0) + word.length - 1)
        owners[i] = counted.id
        continue
      }
    }
    if (!param) {
      // Kept with the word after it, which may be its value: the pair stays together.
      unknown.push(word)
      if (eq === -1 && i + 1 < words.length && !looksLikeOption(words[i + 1]) && words[i + 1] !== '--') unknown.push(words[++i])
      continue
    }
    if (param.kind === 'switch') {
      if (eq !== -1) { unknown.push(word); continue }
      values[param.id] = true
      owners[i] = param.id
      continue
    }
    if (param.kind === 'count') {
      if (eq !== -1) { unknown.push(word); continue }
      values[param.id] = String(Number(values[param.id] || 0) + 1)
      owners[i] = param.id
      continue
    }
    let taken: string[]
    owners[i] = param.id
    if (eq !== -1) taken = [word.slice(eq + 1)]
    else if (i + 1 < words.length && words[i + 1] !== '--') { taken = [words[++i]]; owners[i] = param.id }
    else { unknown.push(word); owners[i] = null; continue }
    if (param.multiple && !param.repeat && eq === -1) {
      while (i + 1 < words.length && !looksLikeOption(words[i + 1]) && words[i + 1] !== '--') { taken.push(words[++i]); owners[i] = param.id }
    }
    if (param.multiple) {
      const list = param.repeat ? [...(lists.get(param.id) ?? []), ...taken] : taken
      lists.set(param.id, list)
      values[param.id] = list.map(shellQuote).join(' ')
    } else {
      values[param.id] = taken[0]
    }
  }

  const positionals = spec.params.filter((param) => param.kind === 'positional')
  let at = 0
  positionals.forEach((param, index) => {
    if (at >= loose.length) return
    const after = positionals.slice(index + 1).filter((later) => later.required).length
    if (param.multiple) {
      const take = Math.max(param.required ? 1 : 0, loose.length - at - after)
      const list = loose.slice(at, at + take)
      for (let k = 0; k < list.length; k++) owners[looseAt[at + k]] = param.id
      at += list.length
      if (list.length > 0) values[param.id] = list.map(shellQuote).join(' ')
      return
    }
    // An optional positional gives way to a required one after it.
    if (!param.required && loose.length - at <= after) return
    owners[looseAt[at]] = param.id
    values[param.id] = loose[at++]
  })
  // Loose words the positionals did not take come first: they were before any unknown option's value.
  return { values, unknown: [...loose.slice(at), ...unknown], owners }
}

/** A value's words: a multiple value as the shell reads it, else the value as one word. */
function valueWords(param: ScriptParam, value: string): string[] {
  if (!param.multiple) return [value]
  return splitCommandLine(value) ?? [value]
}

/** The words one param's value makes, quoted; none for an empty value or an unticked switch. */
function paramArgs(param: ScriptParam, value: string | boolean | undefined): string[] {
  if (param.kind === 'positional') {
    if (typeof value !== 'string' || value === '') return []
    return valueWords(param, value).map(shellQuote)
  }
  const flag = preferredFlag(param)
  if (param.kind === 'switch') return value === true ? [flag] : []
  if (param.kind === 'count') {
    const times = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Math.min(Number(value.trim()), 20) : 0
    return Array.from({ length: times }, () => flag)
  }
  if (typeof value !== 'string' || value === '') return []
  const words = valueWords(param, value)
  if (param.multiple && param.repeat) return words.flatMap((word) => [flag, shellQuote(word)])
  return [flag, ...words.map(shellQuote)]
}

/** The arguments the form's values make, quoted: positionals, then options in spec order. */
export function buildArgs(spec: ScriptSpec, values: ScriptValues): string[] {
  return [
    ...spec.params.filter((param) => param.kind === 'positional').flatMap((param) => paramArgs(param, values[param.id])),
    ...spec.params.filter((param) => param.kind !== 'positional').flatMap((param) => paramArgs(param, values[param.id]))
  ]
}

/** Two forms' values for one param mean the same words on the line. */
function sameValue(param: ScriptParam, a: string | boolean | undefined, b: string | boolean | undefined): boolean {
  return paramArgs(param, a).join(' ') === paramArgs(param, b).join(' ')
}

/**
 * The line with the form's edit made in place: each param whose value
 * changed has its words rewritten where they stand (its first word's place;
 * any later occurrence goes), a param newly set is added — a positional
 * after the positional before it (else before the one after it, else right
 * after the script), an option at the end, before a `--` — and a cleared one
 * loses only its words. A changed "other" replaces the words the form does
 * not know with what was typed, at the end. Untouched words keep their
 * text, quoting and spacing.
 *
 * Null when the line no longer names the script, or when the edited line
 * would not read back as the form says (the caller then writes the whole
 * line with {@link buildCommand}).
 */
export function editCommand(spec: ScriptSpec, line: string, values: ScriptValues, other: string): string | null {
  const at = scriptSpanIndex(spec, line)
  if (at === null) return null
  const { spans, index } = at
  const args = spans.slice(index + 1)
  const { values: current, unknown, owners } = assignArgs(spec, args.map((span) => span.word))

  // What goes where, by the index of an existing argument word.
  const replace = new Map<number, string[]>()
  const before = new Map<number, string[]>()
  const removed = new Set<number>()
  const appended: string[] = []
  const dashAt = args.findIndex((span, i) => span.word === '--' && owners[i] === null)
  const insertBefore = (i: number, words: string[]): void => { before.set(i, [...(before.get(i) ?? []), ...words]) }
  const positionals = spec.params.filter((param) => param.kind === 'positional')
  const owned = (id: string): number[] => owners.flatMap((owner, i) => (owner === id ? [i] : []))

  for (const param of spec.params) {
    if (sameValue(param, current[param.id], values[param.id])) continue
    const words = paramArgs(param, values[param.id])
    const mine = owned(param.id)
    if (mine.length > 0) {
      replace.set(mine[0], words)
      for (const i of mine.slice(1)) removed.add(i)
      continue
    }
    if (words.length === 0) continue
    if (param.kind !== 'positional') {
      if (dashAt === -1) appended.push(...words)
      else insertBefore(dashAt, words)
      continue
    }
    // A positional: after the nearest one before it on the line, else before the nearest one after it, else first.
    const k = positionals.indexOf(param)
    const earlier = positionals.slice(0, k).reverse().map((p) => owned(p.id)).find((list) => list.length > 0)
    const later = positionals.slice(k + 1).map((p) => owned(p.id)).find((list) => list.length > 0)
    if (earlier) {
      const after = earlier[earlier.length - 1] + 1
      if (after < args.length) insertBefore(after, words)
      else appended.unshift(...words)
    } else if (later) {
      insertBefore(later[0], words)
    } else if (args.length > 0) {
      insertBefore(0, words)
    } else {
      appended.unshift(...words)
    }
  }

  let tailOther: string | null = null
  if (unknown.map(shellQuote).join(' ') !== other.trim()) {
    owners.forEach((owner, i) => { if (owner === null) removed.add(i) })
    tailOther = other.trim()
  }

  let out = line.slice(0, spans[index].end)
  let previousEnd = spans[index].end
  for (let i = 0; i < args.length; i++) {
    const span = args[i]
    const gap = line.slice(previousEnd, span.start)
    previousEnd = span.end
    for (const word of before.get(i) ?? []) out += ` ${word}`
    if (replace.has(i)) {
      for (const word of replace.get(i)!) out += ` ${word}`
      continue
    }
    if (removed.has(i)) continue
    out += gap + line.slice(span.start, span.end)
  }
  const tail = [...appended, ...(tailOther ? [tailOther] : [])]
  out += tail.length > 0 ? ` ${tail.join(' ')}` : line.slice(previousEnd)

  // Trusted only if it reads back as the form says.
  const read = readCommand(spec, out)
  if (!read) return null
  for (const param of spec.params) if (!sameValue(param, read.values[param.id], values[param.id])) return null
  // The other words may read back in another order (a loose word before an unknown option's pair): the same words will do.
  const typed = splitCommandLine(other.trim())
  if (typed === null) return null
  const back = splitCommandLine(read.other) ?? []
  if ([...typed].sort().join('\0') !== [...back].sort().join('\0')) return null
  return out
}

/** The command the form makes: the prefix verbatim, the form's arguments, then the other arguments as typed. */
export function buildCommand(prefix: string, spec: ScriptSpec, values: ScriptValues, other: string): string {
  const tail = [...buildArgs(spec, values), other.trim()].filter((part) => part !== '')
  return tail.length > 0 ? `${prefix} ${tail.join(' ')}` : prefix
}

/**
 * The form a command line fills, or null when the line no longer names the
 * spec's script as one simple command (the form is then edited by hand).
 */
export function readCommand(spec: ScriptSpec, line: string): ScriptForm | null {
  const at = scriptSpanIndex(spec, line)
  if (at === null) return null
  const { spans, index } = at
  const { values, unknown } = parseArgs(spec, spans.slice(index + 1).map((span) => span.word))
  return { prefix: line.slice(0, spans[index].end), values, other: unknown.map(shellQuote).join(' ') }
}

/** The line's words and the index of the spec's script among them, or null when it does not name it as one simple command. */
function scriptSpanIndex(spec: ScriptSpec, line: string): { spans: CommandWordSpan[]; index: number } | null {
  if (line.includes('\n')) return null
  const spans = splitCommandSpans(line)
  if (!spans) return null
  let envs = 0
  while (envs < spans.length && ENV_ASSIGNMENT.test(spans[envs].word)) envs++
  const relative = scriptWordIndex(spans.slice(envs).map((span) => span.word))
  if (relative === null) return null
  const index = envs + relative
  if (spans[index].word !== spec.script) return null
  return { spans, index }
}

/** The script a one-line command names, as written, past any env assignments; null when it names none. */
export function commandScript(command: string): string | null {
  if (command.includes('\n')) return null
  const words = splitCommandLine(command.trim())
  if (!words) return null
  let envs = 0
  while (envs < words.length && ENV_ASSIGNMENT.test(words[envs])) envs++
  const at = scriptWordIndex(words.slice(envs))
  return at === null ? null : words[envs + at]
}
