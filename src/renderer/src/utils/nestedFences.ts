/**
 * Folder agents often answer with a markdown snippet that itself holds a fenced
 * code block, and get the nesting wrong in one of two ways:
 *  - they nest a ```` ```bash ```` block inside a ```` ``` ```` block unescaped,
 *    so the inner closer ends the outer block, the rest of the snippet escapes
 *    into prose, and the intended closer opens a new block that swallows the
 *    rest of the message;
 *  - they "escape" the inner fence lines with a zero-width space, which renders
 *    as meant but puts U+200B into whatever the user pastes the code into.
 *
 * Where a code block starts and ends is left to the markdown parser the bubble
 * renders with. Guessing it from the lines drifts from the parser on list items,
 * on indented fence-looking lines and on closer lengths, and a repair built on
 * that guess breaks replies that never nested anything. So the pass only acts on
 * the two shapes it can see in the parse tree, by giving the outer fence more
 * backticks than any fence inside it; every other text comes back as the same
 * string.
 *
 * The zero-width shape (A) is its own proof: the model marked the inner fences.
 * It is repaired in every parse, since a block can only hold the escaped lines
 * once a premature close ahead of it is repaired.
 *
 * The premature close (B) is not. A python string or a heredoc can hold a lone
 * ```` ```json ```` line followed by a bare block exactly as a broken snippet
 * does, and closing over it swallows the prose after it. So shape B acts only
 * on evidence beside the block that closed early, never on how the whole text
 * would read: scoring the whole text let a far closer win by also mending
 * breakage further down, and two snippets merged into one block. The intended
 * outer closer opened a block of its own, the first bare block after it among
 * its siblings, past prose and closed blocks that name a language. It counts
 * only when it shows the rest of the breakage:
 *  - it closed, and holds an opener as long as its own fence, which it can only
 *    have run on through;
 *  - or it runs unclosed to the end of its container.
 * A bare block that shows neither may be an ordinary block, or an inner block of
 * the snippet, as likely as the closer, so that text stays as the parser reads
 * it. One block is repaired a round, from the last, and the text parsed again:
 * a later snippet's repair can take away the closer an earlier block would
 * wrongly close over.
 *
 * Parsing costs about as much as rendering, so a line scan runs first. An
 * ordinary reply alternates an opener that names a language with a bare closer,
 * and a correctly nested one keeps its inner fences shorter than the outer, so
 * neither reaches the parser. What does is kept for the last few texts, since a
 * streaming bubble asks again on every token with the same complete lines.
 *
 * While a reply streams, its last line can be half a fence: the ```` ``` ```` of
 * a ```` ```python ```` still arriving reads as a bare closer. Counting it would
 * flip the layout between repaired and not as tokens land, so a streaming pass
 * repairs complete lines only. An unclosed block may yet be closed and turn out
 * ordinary, so a streaming pass takes only a closer that swallowed an opener,
 * which later lines cannot change. A snippet whose outer closer is the last bare
 * fence so far repairs when the turn finalizes. The rule is local, not a proof:
 * when the closer is itself a snippet a later fence repairs, the earlier repair
 * shown while streaming gives way to that one.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

/** The parts of an mdast node the pass reads. */
interface MdPoint {
  line: number
  offset?: number
}

interface MdNode {
  type: string
  lang?: string | null
  value?: string
  position?: { start: MdPoint; end: MdPoint }
  children?: MdNode[]
}

/** A fenced code block as the parser read it, with 0-based source lines. */
interface Block {
  node: MdNode
  open: number
  /** Null when the block runs to the end of its container unclosed. */
  close: number | null
  ticks: number
  closeTicks: number
  /** The opener carries no info string. */
  bare: boolean
  valueLines: string[]
}

/** One text as the parser read it. */
interface Parsed {
  /** Backtick-fenced blocks in document order. */
  blocks: Block[]
  byNode: Map<MdNode, Block>
  /** The children list each block sits in. */
  siblings: Map<MdNode, readonly MdNode[]>
}

// The same parser `react-markdown` renders the bubble with.
const parser = unified().use(remarkParse).use(remarkGfm)

const BACKTICK = 96
const LINE_BREAK = /\r\n|\r|\n/
const ZERO_WIDTH = /[\u200B\uFEFF]/
// Blockquote markers, list markers and indentation in front of a line's content.
// Leading whitespace is spelled out: JS `\s` would also eat a U+FEFF.
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t]))*[ \t]*/
// A backtick fence line once its container prefix is gone. Group 1 is a
// zero-width "escape" in front of the backticks, group 3 the info string.
const FENCE_LINE = /^([\u200B\uFEFF]?)(`{3,})([^`]*)$/
// Lines of a code block's value, which the parser has already dedented.
const VALUE_FENCE = /^[ \t]*[\u200B\uFEFF]?(`{3,})[^`]*$/
const ZERO_WIDTH_FENCE = /^[ \t]*[\u200B\uFEFF](`{3,})([^`]*)$/
const INNER_OPENER = /^ {0,3}(`{3,})([^`]*)$/

// Several bubbles can stream at once, each asking on every token.
const CACHE_SIZE = 8
const cache = new Map<string, string>()
// Shape B repairs one block per round and parses again; a reply holding more
// broken snippets than this keeps the rest as written.
const MAX_ROUNDS = 32

export function repairNestedFences(markdown: string, options: { streaming?: boolean } = {}): string {
  if (!options.streaming) return repairComplete(markdown, false)
  const cut = markdown.lastIndexOf('\n') + 1
  const head = markdown.slice(0, cut)
  const repaired = repairComplete(head, true)
  return repaired === head ? markdown : repaired + markdown.slice(cut)
}

function repairComplete(markdown: string, streaming: boolean): string {
  if (!markdown.includes('```')) return markdown
  // Split the way the parser counts lines, so `position.line` indexes `lines`.
  const pieces = markdown.split(/(\r\n|\r|\n)/)
  const lines: string[] = []
  const breaks: string[] = []
  for (let i = 0; i < pieces.length; i += 2) {
    lines.push(pieces[i])
    breaks.push(pieces[i + 1] ?? '')
  }
  if (!mayHoldNesting(lines)) return markdown

  // The streaming pass defers blocks a complete pass repairs, so the two differ.
  const key = (streaming ? 's' : 'c') + markdown
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const repaired = repairParsed(markdown, lines, breaks, streaming)
  cache.set(key, repaired)
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return repaired
}

function repairParsed(markdown: string, lines: readonly string[], breaks: readonly string[], streaming: boolean): string {
  const join = (text: readonly string[]): string => text.map((line, i) => line + breaks[i]).join('')
  let out = lines.slice()
  let current = parse(markdown)
  for (let round = 0; ; round++) {
    // Shape A moves no block, so the parse still reads the text it rewrote, and
    // a block it repaired no longer matches in the next round. It runs on every
    // parse: a repair below can turn escaped fences it had left in prose into a
    // block's content.
    const escaped = new Set<Block>()
    for (const block of current.blocks) {
      if (repairZeroWidthEscapes(block, out)) escaped.add(block)
    }
    if (round === MAX_ROUNDS) break
    const repair = nextEarlyClose(current, escaped, streaming)
    if (!repair) break
    // A rewrite only widens backtick runs, so a line index names the same line
    // in every parse.
    out = closeAt(out, repair.block, repair.closer)
    current = parse(join(out))
  }
  return join(out)
}

/**
 * Shape B, the next block to repair and the bare block that opened on its
 * intended closer, or null. Blocks are read from the last: a later snippet's
 * repair can take away the closer an earlier block would otherwise close over,
 * as when a python string holding a lone opener line comes before a snippet
 * whose outer fence is bare.
 */
function nextEarlyClose(
  parsed: Parsed,
  escaped: ReadonlySet<Block>,
  streaming: boolean
): { block: Block; closer: Block } | null {
  for (let i = parsed.blocks.length - 1; i >= 0; i--) {
    const block = parsed.blocks[i]
    // The zero-width shape marked its own fences; nothing in it closed early.
    if (escaped.has(block) || !closesEarly(block)) continue
    const closer = outerCloser(parsed, block)
    if (!closer) continue
    // A closed closer shows the breakage only if it swallowed an opener. An
    // unclosed one may yet be closed while the reply streams.
    if (closer.close !== null ? innerOpeners(closer).length > 0 : !streaming) return { block, closer }
  }
  return null
}

/**
 * The block the intended outer closer would have opened: the first later
 * sibling that is bare or unclosed, past prose and past closed blocks that name
 * a language, which an intact snippet holds whole. Null when that block names a
 * language or there is none. A block in another container cannot have been
 * opened by this block's closer, so siblings are the only candidates.
 */
function outerCloser(parsed: Parsed, block: Block): Block | null {
  const siblings = parsed.siblings.get(block.node) ?? []
  for (const node of siblings.slice(siblings.indexOf(block.node) + 1)) {
    const next = parsed.byNode.get(node)
    if (next && (next.bare || next.close === null)) return next.bare ? next : null
  }
  return null
}

/**
 * Either shape leaves a trace in the lines: a zero-width character in front of
 * a fence, or an opener naming a language where an ordinary reply has a bare
 * closer. The scan pairs fence lines as they come, so the trace is caught
 * whether the outer fence names a language or is bare — a bare ```` ``` ````
 * wrapping a ```` ```bash ```` block is the commonest way a model nests. A run
 * shorter than the fence it is inside neither closes nor opens anything, so a
 * ```` ```` ```` fence around ```` ``` ```` blocks, nested as it should be,
 * passes.
 */
function mayHoldNesting(lines: readonly string[]): boolean {
  // The width of the fence the scan is inside, 0 outside any.
  let open = 0
  for (const line of lines) {
    if (!line.includes('```')) continue
    const fence = FENCE_LINE.exec(line.replace(CONTAINER_PREFIX, ''))
    if (!fence) continue
    if (fence[1] !== '') return true
    const ticks = fence[2].length
    if (open === 0) open = ticks
    else if (ticks < open) continue
    else if (fence[3].trim() === '') open = 0
    else return true
  }
  return false
}

function parse(markdown: string): Parsed {
  const tree: MdNode = parser.parse(markdown)
  const parsed: Parsed = { blocks: [], byNode: new Map(), siblings: new Map() }
  // Pre-order, which is document order.
  const visit = (node: MdNode, among: readonly MdNode[]): void => {
    const block = fencedBlock(node, markdown)
    if (block) {
      parsed.blocks.push(block)
      parsed.byNode.set(node, block)
      parsed.siblings.set(node, among)
    }
    const children = node.children
    children?.forEach((child) => visit(child, children))
  }
  visit(tree, [tree])
  return parsed
}

function fencedBlock(node: MdNode, markdown: string): Block | null {
  if (node.type !== 'code' || !node.position) return null
  const { start, end } = node.position
  if (start.offset === undefined || end.offset === undefined) return null
  // Indented code starts at its indentation and a tilde fence at its tildes;
  // neither can be what a model meant as a backtick fence.
  let ticks = 0
  while (markdown.charCodeAt(start.offset + ticks) === BACKTICK) ticks++
  if (ticks < 3) return null

  const valueLines = (node.value ?? '').split(LINE_BREAK)
  let at = end.offset
  while (at > start.offset && (markdown[at - 1] === ' ' || markdown[at - 1] === '\t')) at--
  let closeTicks = 0
  while (at > start.offset + ticks && markdown.charCodeAt(at - 1) === BACKTICK) {
    at--
    closeTicks++
  }
  // An unclosed block that stops at a line break reports the next line as its
  // end, so the line count alone passes it for closed; the span must also end
  // in a run long enough to close it. An empty value is one line when a blank
  // line sits between the fences and none when the closer follows the opener.
  const span = end.line - start.line
  const closed =
    closeTicks >= ticks && (span === valueLines.length + 1 || (node.value === '' && span === 1))
  return {
    node,
    open: start.line - 1,
    close: closed ? end.line - 1 : null,
    ticks,
    closeTicks: closed ? closeTicks : 0,
    bare: node.lang == null,
    valueLines
  }
}

/**
 * Opener lines in the value as long as the block's own fence. A zero-width
 * character in front of the backticks keeps a line out: that one was escaped.
 */
function innerOpeners(block: Block): { index: number; ticks: number }[] {
  return block.valueLines.flatMap((line, index) => {
    const fence = INNER_OPENER.exec(line)
    return fence && fence[1].length >= block.ticks && fence[2].trim() !== '' ? [{ index, ticks: fence[1].length }] : []
  })
}

/**
 * Shape A: a block whose value holds zero-width fence pairs. The parser read
 * them as content, which is what the model meant; they only need to become real
 * fences inside a fence long enough to hold them.
 */
function repairZeroWidthEscapes(block: Block, out: string[]): boolean {
  const openers: number[] = []
  const paired: number[] = []
  block.valueLines.forEach((line, i) => {
    const fence = ZERO_WIDTH_FENCE.exec(line)
    if (!fence) return
    if (fence[2].trim() !== '') {
      openers.push(i)
      return
    }
    const opener = openers.pop()
    if (opener !== undefined) paired.push(opener, i)
  })
  if (paired.length === 0) return false

  let longest = 0
  for (const line of block.valueLines) longest = Math.max(longest, VALUE_FENCE.exec(line)?.[1].length ?? 0)
  const width = Math.max(block.ticks, longest + 1)
  // The value starts on the line after the opener.
  for (const i of paired) out[block.open + 1 + i] = rewriteFence(out[block.open + 1 + i])
  out[block.open] = rewriteFence(out[block.open], width)
  if (block.close !== null) out[block.close] = rewriteFence(out[block.close], width)
  return true
}

/**
 * Shape B, the candidate: an inner block's own closer may have ended this block
 * early. Whether it did is left to the block after it (`nextEarlyClose`); this
 * only rules out the blocks where no later closer could mean it.
 */
function closesEarly(block: Block): boolean {
  if (block.close === null) return false
  const inner = innerOpeners(block)
  // Two inner openers before the early close leave no single reading.
  if (inner.length !== 1) return false
  // A block that merely shows a lone ```` ```python ```` line ends with it:
  // no inner block had content cut off, so nothing closed early.
  if (inner[0].index === block.valueLines.length - 1) return false
  // A closer shorter than the inner opener cannot be that block's own closer.
  return block.closeTicks >= inner[0].ticks
}

/**
 * Shape B, the rewrite: `block` and the opener of `closer` become one fence,
 * wider than every fence line between them, so the block closes there.
 */
function closeAt(lines: readonly string[], block: Block, closer: Block): string[] {
  let longest = 0
  for (let line = block.open + 1; line < closer.open; line++) {
    const fence = FENCE_LINE.exec(lines[line].replace(CONTAINER_PREFIX, ''))
    if (fence) longest = Math.max(longest, fence[2].length)
  }
  const out = lines.slice()
  out[block.open] = rewriteFence(out[block.open], longest + 1)
  out[closer.open] = rewriteFence(out[closer.open], longest + 1)
  return out
}

/**
 * The line with its first backtick run widened to `width`, and a zero-width
 * character in front of the run dropped. A container prefix holds no backticks,
 * so the first run is the fence, and the prefix and info string stay as written.
 */
function rewriteFence(line: string, width = 0): string {
  const start = line.indexOf('`')
  if (start < 0) return line
  let end = start
  while (line.charCodeAt(end) === BACKTICK) end++
  const cut = start > 0 && ZERO_WIDTH.test(line[start - 1]) ? start - 1 : start
  return line.slice(0, cut) + '`'.repeat(Math.max(width, end - start)) + line.slice(end)
}
