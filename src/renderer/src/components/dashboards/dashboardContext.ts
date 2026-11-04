import {
  DASHBOARD_CONTEXT_MAX_CHARS,
  type CollectedPageContext,
  resolveParamWords,
  type DashboardContext,
  type DashboardViewKind,
  type TileResultDto,
  type TileView
} from '../../../../shared/dashboards'

/**
 * The dashboard context (README D7, §5.6) as the renderer assembles it: what
 * the user sees on the focused tile, summarised as short text, plus the other
 * tiles by title. Pure, so each view's summary and the chip's words can be
 * tested without a dashboard on screen.
 */

/**
 * What a web tile's page last told the host: its `setContext`, or what the
 * kit's bridge collected from its microdata (`cinna/collect-context`), plus
 * the text the owner selected there. Page content: data, never instructions.
 */
export interface WebTileContext {
  summary: string
  selection: string[]
  /** Text selected in the page, at most 2,000 chars; absent or '' when none. */
  selectedText?: string
}

/** How many rows/items a summary lists before saying how many more there are. */
const SUMMARY_ROWS = 40
/** A markdown tile contributes its first part, not the whole document. */
const MARKDOWN_PART = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** One line of text: newlines folded, so a cell cannot forge another row. */
function oneLine(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').trim()
}

/** Cut at the cap, marking the cut. */
export function capSummary(summary: string, max = DASHBOARD_CONTEXT_MAX_CHARS): string {
  return summary.length <= max ? summary : `${summary.slice(0, max - 1)}…`
}

/**
 * A native view's selection key: a list item's `id`, a table row's `id`
 * field, else the row's index as a string.
 */
export function selectionKeyOf(item: unknown, index: number): string {
  if (isRecord(item) && (typeof item.id === 'string' || typeof item.id === 'number') && String(item.id) !== '') return String(item.id)
  return String(index)
}

function lines(header: string | null, rows: string[], selectedRows: string[], total: number): string {
  const out: string[] = []
  if (selectedRows.length > 0) out.push('Selected:', ...selectedRows, '')
  if (header) out.push(header)
  out.push(...rows.slice(0, SUMMARY_ROWS))
  if (total > SUMMARY_ROWS) out.push(`(${SUMMARY_ROWS} of ${total} shown)`)
  return out.join('\n')
}

function summarizeTable(data: unknown, selection: string[]): string {
  if (isRecord(data) && typeof data.csv === 'string') {
    const all = data.csv.split(/\r?\n/).filter((line) => line.trim() !== '')
    const header = all[0] ?? null
    const body = all.slice(1)
    const selected = selection.map((key) => body[Number(key)]).filter((row): row is string => typeof row === 'string')
    return lines(header, body, selected, body.length)
  }
  if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return ''
  const columns = data.columns.filter(isRecord).filter((c) => typeof c.key === 'string')
  const header = columns.map((c) => oneLine(c.label ?? c.key)).join(' | ')
  const rows = data.rows.filter(isRecord)
  const asLine = (row: Record<string, unknown>): string => columns.map((c) => oneLine(row[c.key as string])).join(' | ')
  const chosen = new Set(selection)
  const selected = rows.filter((row, index) => chosen.has(selectionKeyOf(row, index))).map(asLine)
  return lines(header, rows.map(asLine), selected, rows.length)
}

function summarizeList(data: unknown, selection: string[]): string {
  if (!isRecord(data) || !Array.isArray(data.items)) return ''
  const items = data.items.filter(isRecord)
  const asLine = (item: Record<string, unknown>): string =>
    `- ${[item.title, item.subtitle, item.meta, item.badge, item.time, item.priority ? `${oneLine(item.priority)} priority` : undefined]
      .filter((v) => v !== undefined && v !== null && v !== '')
      .map(oneLine)
      .join(' · ')}`
  const chosen = new Set(selection)
  const selected = items.filter((item, index) => chosen.has(selectionKeyOf(item, index))).map(asLine)
  return lines(null, items.map(asLine), selected, items.length)
}

function summarizeMetrics(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.items)) return ''
  return data.items
    .filter(isRecord)
    .map((item) => {
      const value = [oneLine(item.value), item.unit !== undefined ? oneLine(item.unit) : ''].filter(Boolean).join(' ')
      const delta = typeof item.delta === 'number' ? ` (${item.delta > 0 ? '+' : ''}${item.delta})` : ''
      const status = typeof item.status === 'string' && item.status !== 'ok' ? ` [${item.status}]` : ''
      return `${oneLine(item.label)}: ${value}${delta}${status}`
    })
    .join('\n')
}

function summarizeMarkdown(data: unknown): string {
  const body = typeof data === 'string' ? data : isRecord(data) && typeof data.markdown === 'string' ? data.markdown : ''
  if (body.length <= MARKDOWN_PART) return body.trim()
  // The first part: up to the last paragraph break inside the budget.
  const head = body.slice(0, MARKDOWN_PART)
  const cut = head.lastIndexOf('\n\n')
  return `${(cut > MARKDOWN_PART / 2 ? head.slice(0, cut) : head).trim()}\n…`
}

/** "https://schema.org/Order" → "Order": an item type, as a word. */
function shortType(type: string): string {
  const word = type.replace(/[/#]+$/, '').split(/[/#]/).pop() ?? ''
  return oneLine(word || type)
}

/** One microdata item as a line: `Order o-17: status=stalled, owner=Ana`. */
function microdataLine(item: CollectedPageContext['microdata'][number]): string {
  const head = [item.type ? shortType(item.type) : '', item.id ? oneLine(item.id) : ''].filter(Boolean).join(' ')
  const props = Object.entries(item.properties)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => `${oneLine(name)}=${oneLine(value)}`)
    .join(', ')
  return head && props ? `${head}: ${props}` : head || props
}

/**
 * A page that never called `setContext`, from what its bridge collected: the
 * document's title, then one compact line per microdata item (the selected
 * ones first), capped like every summary.
 */
export function summarizeCollected(collected: CollectedPageContext): string {
  const items = collected.microdata.map((item) => ({ id: item.id, line: microdataLine(item) })).filter((item) => item.line !== '')
  const chosen = new Set(collected.selection)
  const selected = items.filter((item) => item.id !== undefined && chosen.has(item.id)).map((item) => item.line)
  const title = oneLine(collected.summary)
  return capSummary(lines(title || null, items.map((item) => item.line), selected, items.length).trim())
}

/**
 * A `cinna/collect-context` answer as the tile's web context. `collected`:
 * the summary from microdata and the ids the text selection touches.
 * `set_context`: the page's own setContext values as the host last kept them
 * (`previous`), else as the answer repeats them. Either way the selected text.
 */
export function webContextFromCollected(collected: CollectedPageContext, previous: WebTileContext | null): WebTileContext {
  // Nothing selected now: the text an earlier answer quoted is gone from the chip and the next send.
  const selectedText = collected.selected_text.trim()
  const quoted = selectedText ? { selectedText } : {}
  if (collected.source === 'set_context') {
    return {
      summary: previous?.summary ?? collected.summary,
      selection: previous?.selection ?? collected.selection,
      ...quoted
    }
  }
  return { summary: summarizeCollected(collected), selection: collected.selection, ...quoted }
}

/**
 * What the focused tile shows, as short text: a table's or list's first rows
 * (selected ones first), the metrics, a markdown document's first part, or a
 * web page's own `setContext` summary. Capped at 8,000 chars.
 */
export function summarizeTile(view: DashboardViewKind | null, data: unknown, selection: string[], web: WebTileContext | null): string {
  if (view === 'html') return capSummary(web?.summary ?? '')
  if (data === null || data === undefined) return ''
  switch (view) {
    case 'table':
      return capSummary(summarizeTable(data, selection))
    case 'list':
      return capSummary(summarizeList(data, selection))
    case 'metrics':
      return capSummary(summarizeMetrics(data))
    case 'markdown':
      return capSummary(summarizeMarkdown(data))
    default:
      return ''
  }
}

/** "12 min", "just now", "3 h": a result's age, for the agent. */
export function dataAgeText(fetchedAt: number | null, now = Date.now()): string | null {
  if (fetchedAt === null) return null
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

/**
 * The context for one focused tile on a dashboard. A web tile's selection is
 * the page's own; a native tile's is the rows or items the user picked.
 */
export function buildDashboardContext(input: {
  dashboardId: string
  dashboardName: string
  focused: TileView
  tiles: TileView[]
  result: TileResultDto | null
  selection: string[]
  web: WebTileContext | null
  now?: number
}): DashboardContext {
  const { focused, tiles } = input
  const view = focused.component?.view ?? null
  const selection = view === 'html' ? (input.web?.selection ?? []) : input.selection
  const agentId = focused.component?.agentId ?? null
  const others = tiles.filter((t) => t.tile.id !== focused.tile.id)
  return {
    dashboardId: input.dashboardId,
    dashboard: input.dashboardName,
    focused: {
      tileId: focused.tile.id,
      component: focused.tile.component,
      skill: focused.tile.skill,
      title: focused.displayTitle,
      params: focused.component ? resolveParamWords(focused.tile.params, focused.component.params) : focused.tile.params,
      selection,
      dataAge: dataAgeText(input.result?.fetchedAt ?? null, input.now),
      summary: summarizeTile(view, input.result?.data ?? null, selection, input.web),
      ...(view === 'html' && input.web?.selectedText ? { selectedText: input.web.selectedText } : {})
    },
    alsoYours: others.filter((t) => agentId !== null && t.component?.agentId === agentId).map((t) => t.displayTitle),
    otherTiles: others
      .filter((t) => agentId === null || t.component?.agentId !== agentId)
      .map((t) => `${t.displayTitle} (${t.component?.agentName ?? 'unknown agent'})`)
  }
}

/** Scalar param values the chip can show: "Sep 2026" (a `2026-09` month), "open". */
function paramWords(params: Record<string, unknown>): string[] {
  return Object.values(params)
    .filter((v): v is string | number => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number')
    .map((v) => {
      const month = typeof v === 'string' ? /^(\d{4})-(\d{2})$/.exec(v) : null
      if (!month) return String(v)
      return new Date(Number(month[1]), Number(month[2]) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    })
}

/**
 * The chip's words in two parts: the title, which may be cut short, and what
 * follows it (" · Sep 2026 · 3 selected · quoted text"), which changes as the user picks
 * rows and so is never cut.
 */
export function contextChipParts(context: DashboardContext): { title: string; rest: string } {
  const parts = [...paramWords(context.focused.params)]
  if (context.focused.selection.length > 0) parts.push(`${context.focused.selection.length} selected`)
  // What is sent: the owner's text selection in a page goes too.
  if (context.focused.selectedText) parts.push('quoted text')
  return { title: context.focused.title, rest: parts.map((part) => ` · ${part}`).join('') }
}

/** How much of the quoted text the chip's tooltip shows. */
export const CHIP_QUOTE_CHARS = 200

/** The chip's tooltip: what goes with the message, and the quoted text itself, cut to about 200 characters. */
export function contextChipTitle(context: DashboardContext): string {
  const base = 'Sent with your message: what this tile shows'
  const text = context.focused.selectedText?.replace(/\s+/g, ' ').trim()
  if (!text) return base
  const quote = text.length > CHIP_QUOTE_CHARS ? `${text.slice(0, CHIP_QUOTE_CHARS).trimEnd()}…` : text
  return `${base}, and the text you selected:\n“${quote}”`
}

/** The chip's words: "Deals pipeline · Sep 2026 · 3 selected". */
export function contextChipLabel(context: DashboardContext): string {
  const { title, rest } = contextChipParts(context)
  return title + rest
}

/**
 * What a removed chip is remembered by: the tile and its selection. A new
 * focus or selection brings the context back (README D7: nothing is sent the
 * user cannot see, and nothing they removed comes back unasked).
 */
export function contextIdentity(tileId: string, selection: string[]): string {
  return `${tileId}\u0000${selection.join('\u0001')}`
}

/** How often a tile's `setContext` reaches the dashboard at most, ms. */
export const CONTEXT_FLUSH_MS = 250

/**
 * Per-key throttle for `setContext`: the first value for a key goes at once,
 * later ones within `ms` are coalesced to the latest and flushed when the
 * window ends. A page posting on every pointer move re-renders the dashboard
 * a few times a second, not on every message. With `merge`, a waiting value
 * is folded into by the next one instead of replaced (a page's setParams
 * names only what it changed, so each partial must survive the window).
 */
export function coalescePerKey<T>(flush: (key: string, value: T) => void, ms = CONTEXT_FLUSH_MS, merge?: (waiting: T, next: T) => T) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const waiting = new Map<string, T>()
  const open = (key: string): void => {
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        if (!waiting.has(key)) return
        const value = waiting.get(key) as T
        waiting.delete(key)
        flush(key, value)
        open(key)
      }, ms)
    )
  }
  return {
    push(key: string, value: T): void {
      if (timers.has(key)) {
        waiting.set(key, merge && waiting.has(key) ? merge(waiting.get(key) as T, value) : value)
        return
      }
      flush(key, value)
      open(key)
    },
    /** Drops what is waiting (the dashboard changed or closed). */
    cancel(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      waiting.clear()
    }
  }
}
