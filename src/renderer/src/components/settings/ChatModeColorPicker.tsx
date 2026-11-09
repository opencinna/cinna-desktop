import { Check } from 'lucide-react'
import { COLOR_PRESETS, THEME_COLOR_PRESET } from '../../constants/chatModeColors'

/**
 * A chat mode's colour: Theme Default, labelled because it names no colour of
 * its own, then the swatches. The chip is as tall as a swatch and its check sits
 * inside the dot, so choosing it moves nothing (ux_rules rule 1).
 */
export function ChatModeColorPicker({ value, onChange }: {
  value: string
  onChange: (presetId: string) => void
}): React.JSX.Element {
  const themeSelected = value === THEME_COLOR_PRESET.id
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        aria-pressed={themeSelected}
        onClick={() => onChange(THEME_COLOR_PRESET.id)}
        className={`h-6 pl-1 pr-2 rounded-full border inline-flex items-center gap-1 text-[12px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ${
          themeSelected ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'
        }`}
      >
        <span className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center bg-[var(--color-accent)] text-[var(--color-on-accent)]">
          {themeSelected && <Check size={10} />}
        </span>
        {THEME_COLOR_PRESET.name}
      </button>
      {COLOR_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          aria-pressed={value === preset.id}
          onClick={() => onChange(preset.id)}
          className="w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110"
          style={{ backgroundColor: preset.border }}
          title={preset.name}
        >
          {value === preset.id && <Check size={12} className="text-white" />}
        </button>
      ))}
    </div>
  )
}
