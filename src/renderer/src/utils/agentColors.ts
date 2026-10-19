import { createContext, useCallback, useContext } from 'react'
import { COLOR_PRESETS } from '../constants/chatModeColors'
import { agentColorPreset, type AgentColorDto } from '../../../shared/agentColors'

export interface AgentChipColors {
  border: string
  bg: string
}

/**
 * Stable per-agent color derived from its id — hashes the id into the chat
 * mode color palette so the same agent surfaces in the same color wherever
 * it appears (message-bubble label, switch-back banner, etc.). The fallback
 * for an agent the user has not given a color preset; see {@link useAgentColor}.
 */
export function presetForAgentId(agentId: string, avoid?: AgentChipColors): AgentChipColors {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0
  }
  let idx = Math.abs(hash) % COLOR_PRESETS.length
  // `avoid` (the enclosing thread's color): the next preset instead, so a
  // thread drawn inside another never shares its border with it.
  if (avoid && COLOR_PRESETS[idx].border === avoid.border) idx = (idx + 1) % COLOR_PRESETS.length
  const preset = COLOR_PRESETS[idx]
  return { border: preset.border, bg: preset.bg }
}

/**
 * A chosen preset as text (`text`) or an icon (`glyph`): as-is on the dark
 * theme, darkened on the light one by `--agent-ink-strength` /
 * `--agent-glyph-strength` (main.css), where the mid-tones are too pale
 * against white. A fill with nothing on it (the chat-row dot) takes the hex.
 */
export function agentInk(hex: string, use: 'text' | 'glyph' = 'text'): string {
  const strength = use === 'text' ? '--agent-ink-strength' : '--agent-glyph-strength'
  return `color-mix(in oklab, ${hex} var(${strength}, 100%), black)`
}

/** Chip colors for a chosen preset's `#RRGGBB`: its ink, and a 10% tint of the color. */
export function chipColorsFor(hex: string): AgentChipColors {
  const n = parseInt(hex.slice(1), 16)
  return { border: agentInk(hex), bg: `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.10)` }
}

/**
 * The active profile's chosen colors, agent id → `#RRGGBB`. Filled once at the
 * app root by `AgentColorsProvider` from the `agent:list-colors` query, so the
 * transcript's presentational blocks read it without a query of their own;
 * outside the provider it is empty and every agent takes its hash color.
 */
export const AgentColorsContext = createContext<ReadonlyMap<string, string>>(new Map())

/** The context value for a list of chosen colors; unknown preset ids are dropped. */
export function agentColorMap(rows: readonly AgentColorDto[] | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const row of rows ?? []) {
    const preset = agentColorPreset(row.preset)
    if (preset) map.set(row.agentId, preset.color)
  }
  return map
}

/**
 * `(agentId) => color` of the agent's chosen preset, or `null` when it is left
 * at None. For surfaces that are plain unless the user chose a color (the
 * sidebar icons and the chat-row dot).
 */
export function useChosenAgentColor(use: 'glyph' | 'fill' = 'glyph'): (agentId: string | null | undefined) => string | null {
  const byAgent = useContext(AgentColorsContext)
  return useCallback((agentId) => {
    const hex = agentId ? byAgent.get(agentId) : undefined
    if (!hex) return null
    return use === 'fill' ? hex : agentInk(hex, 'glyph')
  }, [byAgent, use])
}

/**
 * `(agentId) => chip colors`: the agent's chosen preset, else the hash color of
 * {@link presetForAgentId}. Every per-agent chip and label goes through this so
 * a chosen color shows everywhere the agent is drawn.
 */
export function useAgentColor(): (agentId: string) => AgentChipColors {
  const byAgent = useContext(AgentColorsContext)
  return useCallback(
    (agentId) => {
      const hex = byAgent.get(agentId)
      return hex ? chipColorsFor(hex) : presetForAgentId(agentId)
    },
    [byAgent]
  )
}
