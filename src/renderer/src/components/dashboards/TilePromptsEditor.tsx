import { useState } from 'react'
import { ChevronRight, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { MAX_TILE_OWN_PROMPTS, tilePromptRows, type ComponentPrompt, type TilePromptOverride, type TilePromptRow } from '../../../../shared/dashboards'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { SwitchTrack } from '../ui/SwitchTrack'
import { DIALOG_INPUT, DIALOG_LABEL } from './DashboardDialog'

/** The override without its empty parts; null when nothing is left, so the tile follows the component again. */
function compact(override: TilePromptOverride): TilePromptOverride | null {
  const out: TilePromptOverride = {}
  if (override.hidden?.length) out.hidden = override.hidden
  if (override.edited && Object.keys(override.edited).length > 0) out.edited = override.edited
  if (override.added?.length) out.added = override.added
  return Object.keys(out).length > 0 ? out : null
}

/** A row turned on or off. */
export function withEnabled(value: TilePromptOverride | null, row: TilePromptRow, enabled: boolean): TilePromptOverride | null {
  const current = value ?? {}
  if (row.agentLabel !== null) {
    const hidden = (current.hidden ?? []).filter((label) => label !== row.agentLabel)
    return compact({ ...current, hidden: enabled ? hidden : [...hidden, row.agentLabel] })
  }
  return compact({
    ...current,
    added: (current.added ?? []).map((entry, index) => {
      if (index !== row.addedIndex) return entry
      const { label, prompt } = entry
      return enabled ? { label, prompt } : { label, prompt, hidden: true }
    })
  })
}

/** A row reworded. The agent's own wording again is no change, so it follows the component. */
export function withText(value: TilePromptOverride | null, row: TilePromptRow, agentPrompt: ComponentPrompt | null, text: ComponentPrompt): TilePromptOverride | null {
  const current = value ?? {}
  if (row.agentLabel !== null) {
    const { [row.agentLabel]: _previous, ...edited } = current.edited ?? {}
    const same = agentPrompt && agentPrompt.label === text.label && agentPrompt.prompt === text.prompt
    return compact({ ...current, edited: same ? edited : { ...edited, [row.agentLabel]: text } })
  }
  return compact({ ...current, added: (current.added ?? []).map((entry, index) => (index === row.addedIndex ? { ...entry, ...text } : entry)) })
}

/** The user's own question removed, or the agent's reworded one put back. */
export function withoutChange(value: TilePromptOverride | null, row: TilePromptRow): TilePromptOverride | null {
  const current = value ?? {}
  if (row.agentLabel !== null) {
    const { [row.agentLabel]: _previous, ...edited } = current.edited ?? {}
    return compact({ ...current, edited })
  }
  return compact({ ...current, added: (current.added ?? []).filter((_, index) => index !== row.addedIndex) })
}

/** Add question pressed and left empty: not a question, so it does not stop the rest being saved. A half-filled one is refused, with the dialog open. */
export function withoutBlankQuestions(value: TilePromptOverride | null): TilePromptOverride | null {
  if (!value?.added) return value
  return compact({ ...value, added: value.added.filter((entry) => entry.label.trim() !== '' || entry.prompt.trim() !== '') })
}

const ROW_ICON =
  'shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
const ROW_ICON_DANGER =
  'shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]'

/**
 * A tile's suggested questions in Edit tile: the agent's and the user's own, each
 * a card with a switch whose header opens its inline form, a dashed Add closing
 * the list (ux rule 13). Changes stay in the dialog until Save; main refuses a
 * question without a label or text, and the dialog stays open saying so.
 */
export function TilePromptsEditor({
  prompts,
  value,
  onChange
}: {
  /** The component's own questions. */
  prompts: ComponentPrompt[]
  value: TilePromptOverride | null
  onChange: (next: TilePromptOverride | null) => void
}): React.JSX.Element {
  const rows = tilePromptRows(prompts, value)
  const [open, setOpen] = useState<string | null>(null)
  const keyOf = (row: TilePromptRow): string => (row.agentLabel !== null ? `agent:${row.agentLabel}` : `added:${row.addedIndex}`)
  return (
    <fieldset aria-label="Suggested questions">
      <div className={DIALOG_LABEL}>Suggested questions</div>
      <div className="mt-1 space-y-1">
        {rows.map((row) => {
          const key = keyOf(row)
          const expanded = open === key
          const name = row.label || 'New question'
          const agentPrompt = row.agentLabel !== null ? (prompts.find((p) => p.label === row.agentLabel) ?? null) : null
          return (
            <div key={key} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
              {/* One height, icon or none: the reset icon coming with the first keystroke moves nothing (ux rule 1). */}
              <div className="flex h-7 items-center gap-1.5 px-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={row.enabled}
                  aria-label={`Offer ${name}`}
                  title={row.enabled ? 'Offered on the tile' : 'Not offered on the tile'}
                  className="flex shrink-0"
                  onClick={() => onChange(withEnabled(value, row, !row.enabled))}
                >
                  <SwitchTrack checked={row.enabled} size="sm" />
                </button>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={`Edit ${name}`}
                  title={row.prompt}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-[var(--color-text)]"
                  onClick={() => setOpen(expanded ? null : key)}
                >
                  <ChevronRight size={12} className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`} />
                  <span className={`truncate ${row.enabled ? '' : 'text-[var(--color-text-muted)]'}`}>{name}</span>
                </button>
                {row.edited && (
                  <button type="button" className={ROW_ICON} aria-label={`Use the agent’s wording for ${name}`} title="Use the agent’s wording" onClick={() => { onChange(withoutChange(value, row)); setOpen(null) }}>
                    <RotateCcw size={12} />
                  </button>
                )}
                {row.addedIndex !== null && (
                  <button type="button" className={ROW_ICON_DANGER} aria-label={`Remove ${name}`} title="Remove" onClick={() => { onChange(withoutChange(value, row)); setOpen(null) }}>
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <AnimatedCollapse open={expanded}>
                <div className="space-y-2 border-t border-[var(--color-border)] p-2">
                  <div>
                    <label htmlFor={`${key}-label`} className={DIALOG_LABEL}>Label</label>
                    <input id={`${key}-label`} autoFocus={row.addedIndex !== null && row.label === ''} className={`${DIALOG_INPUT} mt-1`} value={row.label} onChange={(e) => onChange(withText(value, row, agentPrompt, { label: e.target.value, prompt: row.prompt }))} />
                  </div>
                  <div>
                    <label htmlFor={`${key}-prompt`} className={DIALOG_LABEL}>Question sent to the agent</label>
                    <textarea id={`${key}-prompt`} rows={2} className={`${DIALOG_INPUT} mt-1 resize-none`} value={row.prompt} onChange={(e) => onChange(withText(value, row, agentPrompt, { label: row.label, prompt: e.target.value }))} />
                  </div>
                </div>
              </AnimatedCollapse>
            </div>
          )
        })}
        <button
          type="button"
          disabled={(value?.added?.length ?? 0) >= MAX_TILE_OWN_PROMPTS}
          title={(value?.added?.length ?? 0) >= MAX_TILE_OWN_PROMPTS ? `A tile holds ${MAX_TILE_OWN_PROMPTS} questions of your own` : undefined}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            const added = value?.added ?? []
            onChange({ ...(value ?? {}), added: [...added, { label: '', prompt: '' }] })
            setOpen(`added:${added.length}`)
          }}
        >
          <Plus size={12} />
          Add question
        </button>
      </div>
    </fieldset>
  )
}
