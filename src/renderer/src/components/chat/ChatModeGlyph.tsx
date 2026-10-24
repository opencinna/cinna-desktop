import { SquareTerminal } from 'lucide-react'
import { getPreset } from '../../constants/chatModeColors'

/**
 * A chat mode's one glyph, wherever it is listed (ux_rules rule 13): a runtime
 * mode is a terminal in its colour, a saved or account mode a dot. `dot` is
 * the dot's diameter; the terminal is drawn two pixels larger so the two read
 * at the same weight beside the same text.
 */
export function ChatModeGlyph({ mode, dot }: {
  mode: { builtinEngine?: string | null; colorPreset: string }
  dot: number
}): React.JSX.Element {
  const color = getPreset(mode.colorPreset).border
  if (mode.builtinEngine) {
    return <SquareTerminal size={dot + 2} aria-hidden="true" className="shrink-0" style={{ color }} data-mode-glyph="runtime" />
  }
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={{ width: dot, height: dot, backgroundColor: color }} data-mode-glyph="dot" />
}
