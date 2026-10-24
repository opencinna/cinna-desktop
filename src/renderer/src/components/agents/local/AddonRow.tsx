import { ChevronDown, Package, Plug, Sparkles, type LucideIcon } from 'lucide-react'
import type { AddonKind } from '../../../../../shared/addons/directory'

/** Each kind's icon and its one word, wherever an addon is listed: a row of the Addons tab, a picker tile, a detail. */
export const ADDON_KIND: Record<AddonKind, { icon: LucideIcon; label: string; plural: string }> = {
  skill: { icon: Sparkles, label: 'Skill', plural: 'Skills' },
  plugin: { icon: Package, label: 'Plugin', plural: 'Plugins' },
  mcp: { icon: Plug, label: 'Connector', plural: 'Connectors' }
}

/** The kind's icon and word, muted, in front of an addon's title. */
export function AddonKindLabel({ kind, className = 'text-[12px]' }: { kind: AddonKind; className?: string }): React.JSX.Element {
  const { icon: Icon, label } = ADDON_KIND[kind]
  return (
    <span data-addon-kind={kind} className={`flex shrink-0 items-center gap-1 text-[var(--color-text-muted)] ${className}`}>
      <Icon size={14} aria-hidden className="shrink-0 text-[var(--color-accent)]" />
      {label}
    </span>
  )
}

/**
 * The one shell every row of an agent's Addons tab is drawn in (ux_rules
 * rule 13): a skill, a connector and — from U3 — a plugin share the card,
 * the title line's height and the place of their actions. The title line is
 * the kind (icon and word), the title, a muted version, the source badge and
 * the status glyph, then the row's icon actions on the right; whatever the
 * kind has below that line (a description, credential slots, issues, an edit
 * form) is the children.
 *
 * `expandable` makes the title line the row's expand toggle (a connector's
 * edit form): a `button` with `aria-expanded` wraps the title, so the
 * keyboard reaches it, and the chevron ends the line — as a credential row's
 * header does. The actions box stops its clicks from toggling the row.
 */
export function AddonRow({
  kind,
  title,
  titleTooltip,
  version,
  source,
  status,
  actions,
  expandable,
  dataAttributes,
  children
}: {
  kind: AddonKind
  title: string
  titleTooltip?: string
  version?: string | null
  /** The source badge(s). */
  source?: React.ReactNode
  /** The status glyph. */
  status?: React.ReactNode
  /** Icon buttons on the right of the title line. */
  actions?: React.ReactNode
  expandable?: { expanded: boolean; onToggle: () => void }
  dataAttributes?: Record<string, string>
  children?: React.ReactNode
}): React.JSX.Element {
  const line = (
    <>
      <AddonKindLabel kind={kind} />
      <span title={titleTooltip ?? title} className="min-w-0 shrink truncate text-[14px] font-medium">
        {title}
      </span>
      {version && (
        <span title={version} className="min-w-0 max-w-[10rem] shrink-[6] truncate text-[12px] text-[var(--color-text-muted)]">
          {version}
        </span>
      )}
      {/* In a narrow row the version and the badge give way first; the title keeps its room. */}
      {source && <span className="flex min-w-[3rem] shrink-[6] overflow-hidden [&>*]:min-w-0 [&>*]:shrink [&>*]:truncate">{source}</span>}
      {status}
    </>
  )
  return (
    <div
      className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
      data-addon-row={kind}
      {...dataAttributes}
    >
      <div
        className={`flex min-h-12 items-center gap-2 px-4 py-2.5${
          expandable ? ' cursor-pointer transition-colors hover:bg-[var(--color-bg-hover)]' : ''
        }`}
        onClick={expandable?.onToggle}
      >
        {expandable ? (
          // No onClick of its own: its click (and Enter / Space) bubbles to the header.
          <button
            type="button"
            aria-expanded={expandable.expanded}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            {line}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{line}</div>
        )}
        {actions && (
          <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
        {expandable && (
          <ChevronDown
            size={14}
            aria-hidden
            className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-200 ${expandable.expanded ? 'rotate-180' : ''}`}
          />
        )}
      </div>
      {children}
    </div>
  )
}
