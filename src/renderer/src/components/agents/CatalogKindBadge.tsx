import { Cloud, Monitor, Puzzle, type LucideIcon } from 'lucide-react'
import { CATALOG_KIND_TEXT, type CatalogItemKind } from '../../utils/catalogItems'

/** The icon each kind of catalog item wears, on a tile, a detail and an Inbox card. */
export const CATALOG_KIND_ICON: Record<CatalogItemKind, LucideIcon> = {
  cloud_agent: Cloud,
  desktop_agent: Monitor,
  skill: Puzzle
}

/**
 * *Runs in Cinna*, *Runs on your computer* or *Skill*: the one badge that
 * tells the three kinds apart wherever a catalog item is listed — the catalog
 * dialog's tiles and detail, and the Inbox's "Update available" cards.
 */
export function CatalogKindBadge({ kind }: { kind: CatalogItemKind }): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px text-[10px] font-medium text-[var(--color-text-secondary)]">
      {CATALOG_KIND_TEXT[kind]}
    </span>
  )
}
