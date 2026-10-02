/**
 * The color presets a user can give an agent on its Interface tab, so it stands
 * out in the sidebar and on its chips. Per profile, and `null` (None) by
 * default.
 *
 * Shared because main validates the id before storing it, and the renderer
 * draws the swatch. Mid-tone and slightly desaturated so each reads on both the
 * dark and the light theme. The id is what is stored, so never rename one.
 */
export interface AgentColorPreset {
  id: string
  name: string
  /** `#RRGGBB` — the renderer derives the chip's tinted background from it. */
  color: string
}

export const AGENT_COLOR_PRESETS: readonly AgentColorPreset[] = [
  { id: 'rose', name: 'Rose', color: '#E07A93' },
  { id: 'coral', name: 'Coral', color: '#E8866A' },
  { id: 'peach', name: 'Peach', color: '#E59A5C' },
  { id: 'honey', name: 'Honey', color: '#D4A84A' },
  { id: 'lime', name: 'Lime', color: '#9DB85A' },
  { id: 'sage', name: 'Sage', color: '#77B07A' },
  { id: 'mint', name: 'Mint', color: '#4FB393' },
  { id: 'teal', name: 'Teal', color: '#44AFB0' },
  { id: 'sky', name: 'Sky', color: '#55A3D9' },
  { id: 'blue', name: 'Blue', color: '#6B8FE8' },
  { id: 'iris', name: 'Iris', color: '#8A7FE3' },
  { id: 'lavender', name: 'Lavender', color: '#A77FD9' },
  { id: 'orchid', name: 'Orchid', color: '#C97BC4' },
  { id: 'sand', name: 'Sand', color: '#B89C7A' },
  { id: 'slate', name: 'Slate', color: '#8A9AB0' }
]

export function isAgentColorPreset(value: unknown): value is string {
  return typeof value === 'string' && AGENT_COLOR_PRESETS.some((p) => p.id === value)
}

/** The preset with this id, or `undefined` for an unknown (or retired) id. */
export function agentColorPreset(id: string | null | undefined): AgentColorPreset | undefined {
  return id ? AGENT_COLOR_PRESETS.find((p) => p.id === id) : undefined
}

/** One agent's chosen color, per profile. Agents without one are absent. */
export interface AgentColorDto {
  agentId: string
  preset: string
}
