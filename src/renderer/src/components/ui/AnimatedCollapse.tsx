import { useRef, useEffect, useState, useCallback } from 'react'

interface AnimatedCollapseProps {
  open: boolean
  children: React.ReactNode
  className?: string
}

export function AnimatedCollapse({ open, children, className = '' }: AnimatedCollapseProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const isInitialRender = useRef(true)
  const [height, setHeight] = useState<number | undefined>(open ? undefined : 0)
  const [isVisible, setIsVisible] = useState(open)

  useEffect(() => {
    // Skip the effect on initial mount — the initial state is already correct
    if (isInitialRender.current) {
      isInitialRender.current = false
      return
    }

    const el = contentRef.current
    if (!el) return

    if (open) {
      // Make children render first, then measure and animate
      setIsVisible(true)
    } else {
      // Animate from current height to 0
      const measured = el.scrollHeight
      setHeight(measured)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setHeight(0)
        })
      })
    }
  }, [open])

  // When children become visible after open, measure and animate in the next frame
  useEffect(() => {
    if (!open || !isVisible) return
    const el = contentRef.current
    if (!el) return

    // Height is already auto when starting open — only animate when transitioning
    if (height === undefined) return

    requestAnimationFrame(() => {
      const measured = el.scrollHeight
      setHeight(measured)
    })
  }, [isVisible, open, height])

  const handleTransitionEnd = useCallback((): void => {
    if (open) {
      setHeight(undefined)
    } else {
      setIsVisible(false)
    }
  }, [open])

  return (
    <div
      ref={contentRef}
      className={className}
      style={{
        height: height === undefined ? 'auto' : height,
        overflow: 'hidden',
        transition: 'height 200ms ease-out, opacity 200ms ease-out',
        opacity: height === 0 ? 0 : 1
      }}
      onTransitionEnd={handleTransitionEnd}
    >
      {isVisible && children}
    </div>
  )
}
