import { useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  CACHE_TTL_KNOWN,
  CACHE_WRITES_REPORTED,
  CONTEXT_CATEGORIES_KNOWN,
  type ContextMeasureCode,
  type SessionTelemetry,
  type SessionTelemetryMeasureResult
} from '../../../../shared/sessionTelemetry'
import {
  cacheHitRatio,
  cacheState,
  contextCategoryKind,
  currentPrices,
  nextMessageEstimate
} from '../../../../shared/sessionTelemetryDerived'
import { AI_SPENDING_LEVEL_LABEL, contextHealth } from '../../../../shared/aiSpendingLevel'
import { useAppSettings } from '../../hooks/useAppSettings'
import { useSessionTelemetry } from '../../hooks/useSessionTelemetry'
import { useUIStore } from '../../stores/ui.store'
import {
  formatAgo,
  formatAuth,
  formatContextPercent,
  formatCountdown,
  formatPrice,
  formatRatio,
  formatTokens,
  formatTtl,
  formatUsd
} from '../../utils/telemetryFormat'

/**
 * The chat's session inside the mode badge's popover (`RouterBadge`): one
 * `Context` row — how full the context is — and behind it what the session
 * has spent, the prompt cache, what the next message will cost and the prices
 * it is charged at.
 *
 * The popover hangs above the pill and grows upward, so the toggle row is its
 * last row and the details open above it: the row under the pointer never
 * moves (`ux_rules.md` §1).
 */

const HOUR_MS = 60 * 60_000
const DEFAULT_TTL_MS = 5 * 60_000

/** The details list's own cap; the popover's cap (below) may cut it further. */
export const DETAILS_MAX_HEIGHT = 'min(70vh, 36rem)'

/**
 * The popover's height cap. It hangs from the pill's top edge and grows up, so
 * it may only reach 8px below the window's top: the pill's top, less that.
 * Border-box, so its own padding and border are inside the figure. Undefined
 * until the pill has been measured.
 */
const WINDOW_EDGE_PX = 8
export function popoverMaxHeight(anchorTop: number | undefined): string | undefined {
  if (anchorTop === undefined || anchorTop <= WINDOW_EDGE_PX) return undefined
  return `${anchorTop - WINDOW_EDGE_PX}px`
}

/** The row's value: used tokens, then the fill — `27K – 3%`; just `27K` with no window size. */
export function contextRowValue(t: SessionTelemetry): string {
  const used = formatTokens(t.context.used)
  const percent = formatContextPercent(t.context.used, t.context.size)
  return percent ? `${used} – ${percent}` : used
}

/** The row's accessible name: what it shows, said as words (§10). */
export function contextRowLabel(t: SessionTelemetry): string {
  const used = formatTokens(t.context.used)
  const percent = formatContextPercent(t.context.used, t.context.size)
  return percent ? `Context ${used}, ${percent} full` : `Context ${used}`
}

export interface SessionTelemetryBlockModel {
  chatId: string
  telemetry: SessionTelemetry
  /** A `get` is in flight: `telemetry` may be a cached reading from before this view mounted. */
  fetching: boolean
  measureContext: () => Promise<SessionTelemetryMeasureResult>
  expanded: boolean
  toggle: () => void
  measureUnsupported: boolean
  onUnsupported: () => void
}

/**
 * The block's state, held by the badge rather than the popover: the popover
 * unmounts on every close, and the open/closed choice and an `unsupported`
 * answer both outlive it while the chat stays open. Both belong to one chat
 * and reset when it changes. Null while the chat has no telemetry.
 */
export function useSessionTelemetryBlock(chatId: string): SessionTelemetryBlockModel | null {
  const { query, measureContext } = useSessionTelemetry(chatId)
  const telemetry = query.data ?? null
  const [expanded, setExpanded] = useState(false)
  // Collapsed again on a chat change, back to that chat included.
  const [expandedFor, setExpandedFor] = useState(chatId)
  if (expandedFor !== chatId) {
    setExpandedFor(chatId)
    setExpanded(false)
  }
  // The agent session whose runtime answered `unsupported`: Measure stays
  // hidden for it, across popover closes, until the session changes.
  const [unsupportedIn, setUnsupportedIn] = useState<string | null>(null)
  if (!telemetry) return null
  const sessionKey = `${chatId}:${telemetry.context.sessionId ?? ''}`
  return {
    chatId,
    telemetry,
    fetching: query.isFetching,
    measureContext,
    expanded: expanded && expandedFor === chatId,
    toggle: () => setExpanded((value) => !value),
    measureUnsupported: unsupportedIn === sessionKey,
    onUnsupported: () => setUnsupportedIn(sessionKey)
  }
}

/**
 * The block, mounted only while the popover is open. A flex column that may
 * shrink: under the popover's cap the details scroll, the row stays.
 */
export function SessionTelemetryBlock({ model }: { model: SessionTelemetryBlockModel }): React.JSX.Element {
  const { chatId, telemetry, expanded } = model
  const detailsId = useId()
  const Chevron = expanded ? ChevronDown : ChevronUp
  return (
    <div className="mt-2 pt-1.5 border-t border-[var(--color-border)] min-h-0 flex flex-col leading-4">
      {expanded && (
        // Keyed by chat: a measurement or refusal never carries into another chat.
        <SessionDetails
          key={chatId}
          id={detailsId}
          telemetry={telemetry}
          measureContext={model.measureContext}
          measureUnsupported={model.measureUnsupported}
          onUnsupported={model.onUnsupported}
        />
      )}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        aria-label={contextRowLabel(telemetry)}
        onClick={model.toggle}
        className={`shrink-0 w-full flex items-center gap-1.5 rounded py-0.5 text-left
          hover:text-[var(--color-text)] transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`}
      >
        <span className="font-medium text-[var(--color-text)]">Context</span>
        <span className="ml-auto tabular-nums text-[var(--color-text)]">{contextRowValue(telemetry)}</span>
        <Chevron size={12} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" />
      </button>
    </div>
  )
}

const REFUSAL: Partial<Record<ContextMeasureCode, string>> = {
  busy: 'The agent is working — measure when the turn ends.',
  not_ready: "Available after the agent's first reply in this session.",
  not_running: "The agent's process isn't running — send a message first.",
  failed: "The agent didn't answer the measurement."
}
const REFUSAL_OTHER = "The context couldn't be measured."
const UNSUPPORTED = "This agent can't report a breakdown."

/** A refusal that is only "not now" reads as information; a failure in the danger tone. */
const REFUSAL_EXPECTED: ReadonlySet<string> = new Set(['busy', 'not_ready', 'not_running'])

interface MeasureState {
  pending: boolean
  refusal: { code: string; text: string } | null
}

/**
 * The expanded details. Mounted only while they are shown — expanded, in an
 * open popover — so their one-second clock (the cache countdown) and a measure
 * refusal both end with them. Sections keep their order and rows update in
 * place (§1).
 */
function SessionDetails({
  id,
  telemetry: t,
  measureContext,
  measureUnsupported,
  onUnsupported
}: {
  id: string
  telemetry: SessionTelemetry
  measureContext: () => Promise<SessionTelemetryMeasureResult>
  measureUnsupported: boolean
  onUnsupported: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const [measure, setMeasure] = useState<MeasureState>({ pending: false, refusal: null })
  const verbose = useUIStore((s) => s.verboseMode)

  const runMeasure = (): void => {
    if (measure.pending) return
    setMeasure({ pending: true, refusal: null })
    measureContext()
      .then((result) => {
        if (!result.ok && result.code === 'unsupported') {
          // Not a failure to retry: the answer stands for the session.
          onUnsupported()
          setMeasure({ pending: false, refusal: null })
          return
        }
        setMeasure({
          pending: false,
          refusal: result.ok ? null : { code: result.code, text: REFUSAL[result.code as ContextMeasureCode] ?? REFUSAL_OTHER }
        })
      })
      .catch(() => setMeasure({ pending: false, refusal: { code: 'error', text: REFUSAL_OTHER } }))
  }

  const model = t.model.resolved ?? t.model.selected
  const auth = formatAuth(t.auth)

  return (
    <div
      id={id}
      tabIndex={0}
      aria-label="Session details list"
      // A stable gutter: a scrollbar that appears as a section grows shifts nothing (§1).
      // Edge to edge of the popover (`-mx-3`), so the gutter sits at its border.
      style={{ maxHeight: DETAILS_MAX_HEIGHT }}
      className="-mx-3 min-h-0 pb-2 overflow-y-auto [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
    >
      <p className="px-3 pb-0.5 flex items-baseline gap-2">
        {model ? (
          // Wrapped, not truncated: the whole name is on screen, with no hover title.
          <code className="min-w-0 break-all font-mono text-[11px] font-semibold text-[var(--color-text)]">
            {model}
          </code>
        ) : (
          <span className="text-[var(--color-text-muted)]">Model not reported yet</span>
        )}
        {auth && <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">{auth}</span>}
      </p>
      <ContextSection t={t} now={now} measure={measure} unsupported={measureUnsupported} onMeasure={runMeasure} />
      <SpentSection t={t} />
      <CacheSection t={t} now={now} />
      <NextMessageSection t={t} now={now} />
      <PricesSection t={t} />
      {verbose && <RuntimeBlock t={t} />}
    </div>
  )
}

function Section({
  title,
  aside,
  action,
  children
}: {
  title: string
  aside?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="px-3 pt-2">
      <div className="flex items-baseline gap-1.5 pb-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</p>
        {aside && <span className="min-w-0 truncate text-[10px] text-[var(--color-text-muted)]">{aside}</span>}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 text-right tabular-nums text-[var(--color-text)]">{children}</span>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[10px] text-[var(--color-text-muted)]">{children}</p>
}

/** A value, then at most one muted qualifier after it (§13): `$0.0412 estimated, at least`. */
function Qualified({ value, qualifier }: { value: React.ReactNode; qualifier?: string }): React.JSX.Element {
  return (
    <>
      {value}
      {qualifier && <span className="text-[var(--color-text-muted)]"> {qualifier}</span>}
    </>
  )
}

/** Accent text, the `Open Inbox` shape: an action, not one more word of the section (§11). */
const actionClass = `grid text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]
  aria-disabled:cursor-default aria-disabled:hover:text-[var(--color-accent)] transition-colors
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded`

function MeasureButton({ pending, onClick }: { pending: boolean; onClick: () => void }): React.JSX.Element {
  // Both labels share one grid cell, so Measure → Measuring… keeps the width (§1).
  // Not `disabled` while pending: that would drop focus out of the popover.
  return (
    <button
      type="button"
      aria-disabled={pending || undefined}
      onClick={onClick}
      className={actionClass}
    >
      <span aria-hidden={pending || undefined} className={`[grid-area:1/1] text-right ${pending ? 'invisible' : ''}`}>
        Measure
      </span>
      <span aria-hidden={!pending || undefined} className={`[grid-area:1/1] text-right ${pending ? '' : 'invisible'}`}>
        Measuring…
      </span>
    </button>
  )
}

function ContextSection({
  t,
  now,
  measure,
  unsupported,
  onMeasure
}: {
  t: SessionTelemetry
  now: number
  measure: MeasureState
  unsupported: boolean
  onMeasure: () => void
}): React.JSX.Element {
  const { used, size, sizeAuthoritative, categories, categoriesMeasuredAt, breakdown } = t.context
  const percent = formatContextPercent(used, size)
  const level = useAppSettings().data?.aiSpendingLevel ?? 'mid'
  const health = contextHealth(level, t.context)
  const measurable = CONTEXT_CATEGORIES_KNOWN[t.engine] && !unsupported
  // What is in the window: its free room and the compaction reserve are not (the CLI's own `/context`).
  const rows = categories
    ? categories.categories
        .filter((c) => c.tokens > 0 && !c.isDeferred && contextCategoryKind(c.name) === 'content')
        .sort((a, b) => b.tokens - a.tokens)
    : []
  const free = categories?.categories.find((c) => contextCategoryKind(c.name) === 'free')
  return (
    <Section
      title="Context"
      aside={
        categories && categoriesMeasuredAt !== undefined
          ? `counted by the provider ${formatAgo(categoriesMeasuredAt, now)}`
          : undefined
      }
      action={measurable ? <MeasureButton pending={measure.pending} onClick={onMeasure} /> : undefined}
    >
      <p className="tabular-nums text-[var(--color-text)]">
        <Qualified
          value={percent !== undefined ? `${formatTokens(used)} of ${formatTokens(size)} (${percent})` : `${formatTokens(used)} used`}
          qualifier={percent !== undefined && !sizeAuthoritative ? 'size not confirmed yet' : undefined}
        />
      </p>
      {health && (
        <Row label={`${AI_SPENDING_LEVEL_LABEL[level]} budget`}>
          {/* A value, then one muted qualifier (§13): no ` · `-joined prose. */}
          <Qualified value={formatTokens(health.budget)} qualifier={`${formatContextPercent(used, health.budget)} used`} />
        </Row>
      )}
      {categories ? (
        <>
          {rows.map((c) => (
            <Row key={c.name} label={c.name}>{formatTokens(c.tokens)}</Row>
          ))}
          {free && free.tokens > 0 && <Note>Free: {formatTokens(free.tokens)}</Note>}
        </>
      ) : breakdown ? (
        <>
          <Row label="Setup (system prompt, tools, memory, first message)">{formatTokens(breakdown.baseline)}</Row>
          <Row label="Conversation">{formatTokens(breakdown.conversation)}</Row>
        </>
      ) : null}
      {/* The runtime cannot measure at all: said once, in place of the action it replaces. */}
      {unsupported && <p role="status" className="text-[var(--color-text-muted)]">{UNSUPPORTED}</p>}
      {/* Only when a measurement was refused, last in the section: it moves nothing above it (§1). */}
      {measure.refusal && (
        <p
          role="status"
          className={REFUSAL_EXPECTED.has(measure.refusal.code) ? 'text-[var(--color-text)]' : 'text-[var(--color-danger)]'}
        >
          {measure.refusal.text}
        </p>
      )}
    </Section>
  )
}

/**
 * The one qualifier after a cost: how it was arrived at, whether it is a
 * floor, and what it is a price of. The only place the popover says
 * "API-equivalent".
 */
export function costQualifier(t: SessionTelemetry): string | undefined {
  const out: string[] = []
  if (t.totals.costSource === 'estimated') out.push('estimated')
  if (t.totals.tokenScope === 'last_request') out.push('at least')
  if (t.auth.kind === 'subscription') out.push('API-equivalent')
  return out.length > 0 ? out.join(', ') : undefined
}

function SpentSection({ t }: { t: SessionTelemetry }): React.JSX.Element {
  const { tokens, costUsd, turns } = t.totals
  const hit = cacheHitRatio(t).session
  return (
    <Section title="Spent in this chat">
      <Row label="Input">{formatTokens(tokens.input)}</Row>
      <Row label="Output">{formatTokens(tokens.output)}</Row>
      <Row label="Cache read">{formatTokens(tokens.cacheRead)}</Row>
      {CACHE_WRITES_REPORTED[t.engine] && <Row label="Cache write">{formatTokens(tokens.cacheWrite)}</Row>}
      <Row label="Turns">{turns}</Row>
      <Row label="Cache hit">{hit !== undefined ? formatRatio(hit) : '—'}</Row>
      <Row label="Cost">
        {costUsd !== undefined ? (
          <Qualified value={formatUsd(costUsd)} qualifier={costQualifier(t)} />
        ) : (
          <span className="text-[var(--color-text-muted)]">no cost reported</span>
        )}
      </Row>
    </Section>
  )
}

/** Only where the engine reports a TTL: no heading over nothing (§2). */
function CacheSection({ t, now }: { t: SessionTelemetry; now: number }): React.JSX.Element | null {
  if (!CACHE_TTL_KNOWN[t.engine]) return null
  const reading = cacheState(t, now)
  const ttl = t.cache.ttlMs ?? DEFAULT_TTL_MS
  return (
    <Section title="Cache">
      <Row label="State">
        {reading.state === 'warm' ? (
          <Qualified
            value={<span className="text-[var(--color-success)]">Warm</span>}
            qualifier={reading.flipsAt !== undefined ? `cold in ${formatCountdown(reading.flipsAt - now)}` : undefined}
          />
        ) : reading.state === 'cold' ? (
          'Cold'
        ) : (
          <span className="text-[var(--color-text-muted)]">Unknown</span>
        )}
      </Row>
      <Row label="TTL">
        <Qualified value={formatTtl(ttl)} qualifier={ttl >= HOUR_MS ? undefined : t.cache.ttlSource} />
      </Row>
    </Section>
  )
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function NextMessageSection({ t, now }: { t: SessionTelemetry; now: number }): React.JSX.Element {
  const estimate = nextMessageEstimate(t, now)
  const prices = currentPrices(t)
  const model = t.model.resolved ?? t.model.selected
  const figures = estimate.warmUsd !== undefined || estimate.coldUsd !== undefined
  let empty: string | null = null
  if (!figures) {
    if (t.auth.kind === 'cloud') empty = estimate.note
    else if (!prices) empty = `price unknown for ${model ?? 'this model'}`
    else if (prices.fastPriceUnknown) empty = 'price unknown in fast mode'
    else empty = estimate.note
  }
  return (
    <Section title="Next message">
      {figures ? (
        estimate.warmUsd !== undefined ? (
          <>
            <Row label="Cache warm">{formatUsd(estimate.warmUsd)}</Row>
            {estimate.coldUsd !== undefined && <Row label="Cache cold">{formatUsd(estimate.coldUsd)}</Row>}
            {estimate.flipsAt !== undefined && <Row label="Warm price until">{timeOfDay(estimate.flipsAt)}</Row>}
          </>
        ) : (
          // Codex: the whole context at the uncached price, a ceiling its own caching undercuts.
          <Row label="Uncached">
            <Qualified value={formatUsd(estimate.coldUsd!)} qualifier="at most" />
          </Row>
        )
      ) : (
        <Note>{empty}</Note>
      )}
    </Section>
  )
}

function PricesSection({ t }: { t: SessionTelemetry }): React.JSX.Element | null {
  const current = currentPrices(t)
  if (!current) return null
  const { prices } = current
  const fast = current.fast ? (current.fastPriceUnknown ? 'fast-mode rate not listed' : 'fast mode') : null
  const flags = [fast, current.longContext ? 'long-context rate' : null].filter((f): f is string => f !== null)
  return (
    <Section title="Prices" aside="per MTok">
      <Row label="Input">{formatPrice(prices.input)}</Row>
      <Row label="Output">{formatPrice(prices.output)}</Row>
      <Row label="Cache read">{formatPrice(prices.cacheRead)}</Row>
      {/* No cache writes reported (OpenAI: the table charges a write as input): no price for them. */}
      {CACHE_WRITES_REPORTED[t.engine] && (
        <Row label="Cache write">
          <Qualified value={formatPrice(prices.cacheWrite5m)} qualifier={`1 h ${formatPrice(prices.cacheWrite1h)}`} />
        </Row>
      )}
      {flags.length > 0 && <Note>{flags.join(', ')}</Note>}
      <Note>checked {current.checkedAt}</Note>
    </Section>
  )
}

/** Verbose mode: what the runtime said about itself, raw. */
function RuntimeBlock({ t }: { t: SessionTelemetry }): React.JSX.Element | null {
  const lines: string[] = []
  const runtime = t.runtime
  if (runtime?.cliVersion) lines.push(`cli: ${runtime.cliVersion}`)
  if (runtime && runtime.effort !== undefined) lines.push(`effort: ${runtime.effort ?? 'none'}`)
  if (runtime?.fastMode) lines.push(`fast mode: ${runtime.fastMode}`)
  if (runtime?.betas && runtime.betas.length > 0) lines.push(`betas: ${runtime.betas.join(', ')}`)
  if (t.rateLimit !== undefined && t.rateLimit !== null) lines.push(`rate limit: ${JSON.stringify(t.rateLimit, null, 2)}`)
  if (lines.length === 0) return null
  return (
    <pre
      aria-label="Runtime details"
      className="mx-3 mt-2 mb-0 p-2 rounded bg-[var(--color-bg-secondary)] font-mono text-[10px] leading-4 text-[var(--color-text-secondary)] whitespace-pre-wrap break-all"
    >
      {lines.join('\n')}
    </pre>
  )
}
