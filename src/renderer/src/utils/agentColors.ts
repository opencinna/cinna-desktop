import { COLOR_PRESETS } from '../constants/chatModeColors'

/**
 * Stable per-agent color derived from its id — hashes the id into the chat
 * mode color palette so the same agent surfaces in the same color wherever
 * it appears (message-bubble label, switch-back banner, etc.).
 */
export function presetForAgentId(agentId: string): { border: string; bg: string } {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0
  }
  const idx = Math.abs(hash) % COLOR_PRESETS.length
  const preset = COLOR_PRESETS[idx]
  return { border: preset.border, bg: preset.bg }
}
