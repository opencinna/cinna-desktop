import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { RotateCcw } from 'lucide-react'
import { useDialogChrome } from './SettingsLayout'
import { EFFORT_OPTIONS } from './ChatModeRuntimeFields'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { runtimeModeResetFields, type ChatToolPolicy } from '../../../../shared/chatModeRuntime'
import type { AgentEngine } from '../../../../shared/engine'

const TOOLS_LABEL: Record<ChatToolPolicy, string> = { workspace: 'Workspace', connectors: 'Connected tools', none: 'No tools' }

/** "a", "a and b", "a, b and c". */
function joined(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * What a reset would change on this mode, in the card's own field names:
 * what is cleared, then what goes back to its default. Empty when the mode is
 * already at its defaults — the card then offers no reset at all.
 */
export function runtimeModeResetChanges(mode: ChatModeData): { cleared: string[]; restored: string[] } {
  const defaults = runtimeModeResetFields(mode.builtinEngine as AgentEngine, mode)
  const cleared: string[] = []
  if ((mode.systemPrompt ?? '').trim() !== '') cleared.push('its instructions')
  if (mode.modelId) cleared.push('its model override')
  if (mode.providerId) cleared.push('its AI credential')
  const mcps = (mode.mcpProviderIds ?? []).length
  if (mcps > 0) cleared.push(mcps === 1 ? 'its MCP provider' : `its ${mcps} MCP providers`)
  const restored: string[] = []
  if ((mode.complexity ?? null) !== defaults.complexity) {
    restored.push(`Effort to ${EFFORT_OPTIONS.find((option) => option.value === defaults.complexity)?.label ?? defaults.complexity}`)
  }
  if ((mode.toolPolicy ?? 'connectors') !== defaults.toolPolicy) restored.push(`Tools to ${TOOLS_LABEL[defaults.toolPolicy]}`)
  if (mode.colorPreset !== defaults.colorPreset) restored.push(`Color to ${getPreset(defaults.colorPreset).name}`)
  return { cleared, restored }
}

/**
 * The confirm in front of Reset to defaults (ux_rules rule 5): it names what
 * the reset takes away from this mode, and what it keeps (the star). The
 * mutation is the card's, which outlives this dialog; the dialog closes on
 * success only, and a failure stays here, beside the button that failed.
 */
export function ResetRuntimeModeDialog({ mode, pending, error, onConfirm, onCancel }: {
  mode: ChatModeData
  pending: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useDialogChrome({ modalRef, initialFocusRef: cancelRef, pending, onDismiss: onCancel })
  const { cleared, restored } = runtimeModeResetChanges(mode)
  // "It loses its instructions, and sets Effort to Medium."
  const sentence = cleared.length && restored.length ? `It loses ${joined(cleared)}, and sets ${joined(restored)}`
    : cleared.length ? `It loses ${joined(cleared)}` : restored.length ? `It sets ${joined(restored)}` : ''

  return createPortal(
    // Clicks inside the portal still bubble up the React tree to the card's header.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" onClick={(event) => event.stopPropagation()}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-runtime-mode-title"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div id="reset-runtime-mode-title" className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-text)]">
          <RotateCcw size={16} />
          Reset to defaults
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          Reset <strong className="text-[var(--color-text)]">{mode.name}</strong> to its defaults?
          {sentence ? ` ${sentence}.` : ''} {mode.isDefault ? 'It stays your default mode. ' : ''}{cleared.length > 0 ? 'This cannot be undone.' : ''}
        </p>

        {error && (
          <div role="alert" className="text-[13px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium
              text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="min-w-[7.5rem] rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-[13px]
              font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Resetting…' : 'Reset'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
