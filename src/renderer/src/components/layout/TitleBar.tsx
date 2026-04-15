import { PanelLeft } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'

export function TitleBar(): React.JSX.Element {
  const { toggleSidebar } = useUIStore()

  return (
    <div className="titlebar h-10 flex items-center justify-between px-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] shrink-0">
      <div className="flex items-center gap-1.5">
        <div className="w-[68px]" />
        <button
          onClick={toggleSidebar}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <span className="text-xs font-medium text-[var(--color-text-muted)]">Cinna</span>

      <div className="w-[100px]" />
    </div>
  )
}
