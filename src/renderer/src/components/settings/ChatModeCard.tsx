import { unwrapIpcError } from '../../utils/ipcError'
import { useDefaultRuntime } from '../../hooks/useEngine'
import { ChatModeRuntimeFields, type ChatModeRuntimeValue } from './ChatModeRuntimeFields'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Trash2, ChevronDown, Check, Star, RotateCcw } from 'lucide-react'
import { ChatModeGlyph } from '../chat/ChatModeGlyph'
import { useProviders } from '../../hooks/useProviders'
import { useModels } from '../../hooks/useModels'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpsertChatMode, useDeleteChatMode, useResetChatMode } from '../../hooks/useChatModes'
import { SettingsLabel } from './SettingsLayout'
import { ResetRuntimeModeDialog, runtimeModeResetChanges } from './ResetRuntimeModeDialog'
import { runtimeModeResetFields } from '../../../../shared/chatModeRuntime'
import type { AgentEngine } from '../../../../shared/engine'
import { ChatModeColorPicker } from './ChatModeColorPicker'
import type { ChatModeData } from '../../constants/chatModeColors'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { isCredentialActive } from '../../../../shared/credentials'
import { credentialOptionLabel } from '../../utils/credentialLabel'
import {
  chatModeInactiveReason,
  INACTIVE_BADGE_CLASS,
  INACTIVE_CAUSE_CLASS
} from '../../utils/chatModeStatus'

interface ChatModeCardProps {
  mode: ChatModeData
  /**
   * A runtime mode's status line and setup chip, drawn in the header. Given
   * for runtime modes only: such a card has no Name or Runtime field, and
   * Reset to defaults where a saved mode has Delete.
   */
  runtimeStatus?: ReactNode
}

export function ChatModeCard({ mode: persistedMode, runtimeStatus }: ChatModeCardProps): React.JSX.Element {
  const runtimeMode = !!persistedMode.builtinEngine
  const [mode, setMode] = useState(persistedMode)
  const latestMode = useRef(mode)
  const { data: defaultRuntime } = useDefaultRuntime()
  const effectiveEngine = mode.engine ?? defaultRuntime?.engine
  const [expanded, setExpanded] = useState(false)
  const [nameDraft, setNameDraft] = useState(mode.name)
  /**
   * Ids for `htmlFor`, and `useId` rather than literals for the reason
   * `LLMProviderCard` gives: the page renders one of these per chat mode, so a
   * literal id would make every card's label point at the first card's field.
   */
  const fieldId = useId()

  const { data: providers } = useProviders()
  const { data: allModels } = useModels()
  const { data: mcpProviders } = useMcpProviders()
  const upsert = useUpsertChatMode(persistedMode.id)
  useEffect(() => {
    // Mutation success waits for the authoritative list. Earlier responses must
    // not overwrite a later optimistic edit while its serialized save is pending.
    if (upsert.isPending || upsert.error) return
    latestMode.current = persistedMode
    setMode(persistedMode)
  }, [persistedMode, upsert.isPending, upsert.error])
  const deleteMutation = useDeleteChatMode()
  const resetMutation = useResetChatMode(persistedMode.id)
  /** Bumped by a reset: the fields keep drafts (instructions) that must start over from the defaults. */
  const [resets, setResets] = useState(0)
  const [confirmingReset, setConfirmingReset] = useState(false)
  /** Nothing to reset: the button stays (nothing moves) but does nothing. */
  const atDefaults = runtimeMode && (() => { const { cleared, restored } = runtimeModeResetChanges(mode); return cleared.length + restored.length === 0 })()
  /**
   * Queued behind any save still in flight (both share the mode's mutation
   * scope), so a blur that saved the instructions as Reset was pressed cannot
   * land after it. The fields remount from the reset's own result, never the
   * card's previous row: the list has not been refetched yet when it lands,
   * and a draft seeded from the old row would be saved back on its next blur.
   */
  const confirmReset = (): void => {
    resetMutation.mutate(undefined, {
      onSuccess: () => {
        const next = { ...latestMode.current, ...runtimeModeResetFields(persistedMode.builtinEngine as AgentEngine, latestMode.current) }
        latestMode.current = next
        setMode(next)
        setResets((n) => n + 1)
        setConfirmingReset(false)
      }
    })
  }

  const enabledProviders = (providers ?? []).filter(isCredentialActive)
  const modelsForProvider = (allModels ?? []).filter((m) => m.providerId === mode.providerId)

  /**
   * The credential this mode names, whatever state it is in.
   *
   * Separate from `enabledProviders` on purpose: that list is what the user may
   * *pick*, and a switched-off credential is not on it. Looking the bound one up
   * across the whole list is what lets the card keep saying which credential the
   * mode names — see the synthetic option below.
   *
   * `undefined` while the provider list is loading, so an empty first render
   * cannot flash "Inactive" on a mode that is fine (rule 1).
   */
  const bound = mode.providerId
    ? providers?.find((p) => p.id === mode.providerId) ?? null
    : null

  /** Why this mode cannot start a chat, or null when it can. Shared wording. */
  const inactive = effectiveEngine === 'claude' || effectiveEngine === 'codex' || effectiveEngine === 'antigravity' ? null : chatModeInactiveReason(mode.providerId, providers)
  const mcpIds = new Set(mode.mcpProviderIds ?? [])

  const save = useCallback(
    (patch: Partial<ChatModeRuntimeValue & { name: string; providerId: string | null; modelId: string | null; mcpProviderIds: string[]; colorPreset: string; isDefault: boolean }>) => {
      const next = { ...latestMode.current, ...patch }
      latestMode.current = next
      setMode(next)
      upsert.mutate({
        id: next.id, name: next.name, engine: next.engine,
        systemPrompt: next.systemPrompt ?? '', toolPolicy: next.toolPolicy ?? 'connectors', complexity: next.complexity ?? null,
        providerId: next.providerId ?? null, modelId: next.modelId ?? null,
        mcpProviderIds: next.mcpProviderIds ?? [], colorPreset: next.colorPreset, isDefault: next.isDefault
      })
    },
    [upsert]
  )

  const toggleMcp = (id: string): void => {
    const next = new Set(mcpIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save({ mcpProviderIds: Array.from(next) })
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  const colorField = (
          <div>
            <SettingsLabel>Color</SettingsLabel>
            <div className="mt-1">
              <ChatModeColorPicker value={mode.colorPreset} onChange={(colorPreset) => save({ colorPreset })} />
            </div>
          </div>
  )

  /** OpenCode's AI credential, and the model from it. */
  const credentialFields = effectiveEngine === 'opencode' ? (<>
          <div>
            <SettingsLabel htmlFor={`${fieldId}-credential`}>AI credential</SettingsLabel>
            <select
              id={`${fieldId}-credential`}
              value={mode.providerId ?? ''}
              onChange={(e) => save({ providerId: e.target.value || null, modelId: null })}
              className={`${inputClass} cursor-pointer`}
            >
              {/* A runtime card may itself be the default, so "use default" would point at itself: with none chosen it runs on the default's credential, else the first that can run. */}
              <option value="">{runtimeMode ? 'Automatic' : 'None (use default)'}</option>
              {/*
                The bound credential, when it is not one the user may pick.
                Without it the select's value matches no option and the browser
                falls back to showing the first — so a mode bound to a
                switched-off credential read as "None (use default)", which is
                both wrong and unrecoverable: changing it back was impossible
                because the card never admitted what it was set to.
              */}
              {bound && !isCredentialActive(bound) && (
                <option value={bound.id}>{credentialOptionLabel(bound)}</option>
              )}
              {/*
                And the same for a credential this machine no longer has, which
                lands in exactly the same place: `bound` is null, no option
                matches, and the select falls back to "None (use default)" while
                the line beside it says the mode names a credential. Naming it
                is not possible — the row is gone and only its id survives — so
                the option says what is true of it.
              */}
              {mode.providerId && !bound && providers !== undefined && (
                <option value={mode.providerId}>Missing credential</option>
              )}
              {enabledProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Model */}
          {mode.providerId && (
            <div>
              <SettingsLabel htmlFor={`${fieldId}-model`}>{runtimeMode ? 'Model override' : 'Model'}</SettingsLabel>
              <select
                id={`${fieldId}-model`}
                value={mode.modelId ?? ''}
                onChange={(e) => save({ modelId: e.target.value || null })}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">{mode.complexity ? 'From effort' : 'First available'}</option>
                {modelsForProvider.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          </>) : null

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {confirmingReset && (
        <ResetRuntimeModeDialog mode={mode} pending={resetMutation.isPending}
          error={resetMutation.error ? unwrapIpcError(resetMutation.error, 'Could not reset this mode.') : null}
          onConfirm={confirmReset} onCancel={() => setConfirmingReset(false)} />
      )}
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChatModeGlyph mode={mode} dot={12} />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-[14px]">{mode.name}</span>
          {inactive && (
            <>
              <span className={`ml-1.5 ${INACTIVE_BADGE_CLASS}`}>Inactive</span>
              {/*
                The cause, on the same line so the card does not change height,
                and visible rather than in the badge's `title`: this list is
                scanned collapsed, and one word for three different situations
                is only unambiguous to someone who thought to hover.
              */}
              <span className={`ml-1.5 ${INACTIVE_CAUSE_CLASS}`}>{inactive.short}</span>
            </>
          )}
        </div>

        {runtimeStatus}

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); save({ isDefault: !mode.isDefault }) }}
          className={`p-1 rounded transition-colors ${
            mode.isDefault
              ? 'text-[var(--color-warning)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-warning)]'
          }`}
          title={mode.isDefault ? 'Remove as default' : 'Set as default'}
        >
          <Star size={12} className={mode.isDefault ? 'fill-current' : ''} />
        </button>

        {runtimeMode ? (
          <button
            type="button"
            // Never disabled by a save in flight, and `aria-disabled` rather
            // than `disabled` at the defaults: pressing it blurs an edited
            // Instructions field, whose save renders before the click lands —
            // so the click is judged against the saved text, not the old row.
            aria-disabled={atDefaults || resetMutation.isPending || undefined}
            aria-label={`Reset ${mode.name} to defaults`}
            title={atDefaults ? 'Already at its defaults' : 'Reset to defaults'}
            onClick={(e) => {
              e.stopPropagation()
              if (atDefaults || resetMutation.isPending) return
              resetMutation.reset()
              setConfirmingReset(true)
            }}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-[var(--color-text-muted)]"
          >
            <RotateCcw size={12} />
          </button>
        ) : (
          <button
            type="button"
            disabled={upsert.isPending}
            aria-label="Delete chat mode"
            onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(mode.id) }}
            className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
          >
            <Trash2 size={12} />
          </button>
        )}

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
          {/* Name — a runtime mode keeps its engine's */}
          {!runtimeMode && <div>
            <SettingsLabel htmlFor={`${fieldId}-name`}>Name</SettingsLabel>
            <input
              id={`${fieldId}-name`}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { if (nameDraft.trim() && nameDraft !== mode.name) save({ name: nameDraft.trim() }) }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              className={inputClass}
              placeholder="e.g. Development, Writing, Research..."
            />
          </div>}

          {/* Color preset — last on a runtime mode, after what it runs with */}
          {!runtimeMode && colorField}

          <ChatModeRuntimeFields key={resets} value={mode} resolvedEngine={defaultRuntime?.engine} onChange={save}
            section={runtimeMode ? 'options' : 'all'} runtimeMode={runtimeMode}
            afterModel={runtimeMode ? credentialFields : undefined} />
          {!runtimeMode && credentialFields}

          {/* MCP Providers */}
          {(mcpProviders ?? []).length > 0 && (
            <div>
              <SettingsLabel>MCP Providers</SettingsLabel>
              <div className="mt-1 space-y-1">
                {(mcpProviders ?? []).map((mcp) => (
                  <button
                    key={mcp.id}
                    type="button"
                    onClick={() => toggleMcp(mcp.id)}
                    className="w-full text-left px-2.5 py-1.5 rounded-md text-[14px]
                      hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2"
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        mcpIds.has(mcp.id)
                          ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                          : 'border-[var(--color-border)]'
                      }`}
                    >
                      {mcpIds.has(mcp.id) && <Check size={9} className="text-white" />}
                    </div>
                    <span className="text-[var(--color-text)]">{mcp.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/*
            Why this mode cannot run, rendered only while that is true and
            **last** in the body: a message that exists only on failure is not
            reserved for (an empty two-line slot here was padding between two
            selects), and it never sits above a control — arriving here it
            lengthens the card and moves nothing the user is about to pick
            (ux_rules rules 1 and 12). 13px rather than 12px because this is
            status detail, which the settings scale sets at 13.
          */}
          {runtimeMode && colorField}

          {upsert.error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(upsert.error, 'Could not save chat mode')}</p>}
          {inactive?.detail && (
            <p className="text-[13px] text-[var(--color-warning)]">{inactive.detail}</p>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
