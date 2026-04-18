import { useEffect, useRef } from 'react'

interface MetaPopupProps {
  meta: Record<string, unknown>
  align?: 'left' | 'right'
  onClose: () => void
}

export function MetaPopup({ meta, align = 'right', onClose }: MetaPopupProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className={`absolute bottom-full mb-1 ${align === 'right' ? 'right-0' : 'left-0'} w-72 max-h-56 overflow-y-auto
        bg-[var(--color-bg-secondary)] border border-[var(--color-border)]
        rounded-lg shadow-xl z-50 p-2.5 text-[11px] text-[var(--color-text-secondary)]
        font-mono leading-relaxed`}
    >
      {Object.entries(meta).map(([key, value]) => (
        <div key={key} className="mb-1 last:mb-0">
          <span className="text-[var(--color-text-muted)]">{key}: </span>
          <span className="text-[var(--color-text)] break-all whitespace-pre-wrap">
            {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
          </span>
        </div>
      ))}
    </div>
  )
}
