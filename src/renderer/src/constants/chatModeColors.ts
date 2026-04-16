export type ChatModeData = Awaited<ReturnType<typeof window.api.chatModes.list>>[number]

export interface ColorPreset {
  id: string
  name: string
  /** Border color for the chat input */
  border: string
  /** Subtle background tint for the chat input */
  bg: string
  /** Card/badge background */
  card: string
  /** Card/badge text color */
  text: string
}

export const COLOR_PRESETS: ColorPreset[] = [
  { id: 'slate', name: 'Slate', border: '#64748b', bg: 'rgba(100,116,139,0.08)', card: '#334155', text: '#cbd5e1' },
  { id: 'indigo', name: 'Indigo', border: '#6366f1', bg: 'rgba(99,102,241,0.08)', card: '#3730a3', text: '#c7d2fe' },
  { id: 'violet', name: 'Violet', border: '#8b5cf6', bg: 'rgba(139,92,246,0.08)', card: '#5b21b6', text: '#ddd6fe' },
  { id: 'rose', name: 'Rose', border: '#f43f5e', bg: 'rgba(244,63,94,0.08)', card: '#9f1239', text: '#fecdd3' },
  { id: 'amber', name: 'Amber', border: '#f59e0b', bg: 'rgba(245,158,11,0.08)', card: '#92400e', text: '#fde68a' },
  { id: 'emerald', name: 'Emerald', border: '#10b981', bg: 'rgba(16,185,129,0.08)', card: '#065f46', text: '#a7f3d0' },
  { id: 'cyan', name: 'Cyan', border: '#06b6d4', bg: 'rgba(6,182,212,0.08)', card: '#155e75', text: '#a5f3fc' },
  { id: 'sky', name: 'Sky', border: '#0ea5e9', bg: 'rgba(14,165,233,0.08)', card: '#075985', text: '#bae6fd' },
  { id: 'orange', name: 'Orange', border: '#f97316', bg: 'rgba(249,115,22,0.08)', card: '#9a3412', text: '#fed7aa' },
  { id: 'fuchsia', name: 'Fuchsia', border: '#d946ef', bg: 'rgba(217,70,239,0.08)', card: '#86198f', text: '#f5d0fe' }
]

export function getPreset(id: string): ColorPreset {
  return COLOR_PRESETS.find((p) => p.id === id) ?? COLOR_PRESETS[0]
}
