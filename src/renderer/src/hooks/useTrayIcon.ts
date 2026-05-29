import { useEffect } from 'react'
import { useAgentStatus } from './useAgentStatus'
import { useUIStore } from '../stores/ui.store'
import { SEVERITY_HEX, worstSeverity, type Severity } from '../constants/agentSeverity'

// Logical icon is 16pt; the menu bar is retina, so render the buffer at 2x and
// tell the main process the scale factor when building the NativeImage.
const SIZE = 32
// lucide-react "Activity" path in its 24-unit viewBox — matches the sidebar footer icon.
const ACTIVITY_PATH = 'M22 12h-4l-3 9L9 3l-3 9H2'

function renderTrayIcon(worst: Severity | null, systemDark: boolean): string {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  // The menu bar follows the OS appearance: light glyph on a dark bar, dark on light.
  const glyph = systemDark ? '#f5f5f5' : '#1a1a1a'

  // Draw the activity glyph centered in a 24px box (4px margin) at 2x scale.
  ctx.save()
  ctx.translate(4, 5)
  ctx.scale((SIZE - 8) / 24, (SIZE - 8) / 24)
  ctx.strokeStyle = glyph
  ctx.lineWidth = 2.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke(new Path2D(ACTIVITY_PATH))
  ctx.restore()

  if (worst) {
    const cx = SIZE - 7
    const cy = 7
    // Halo gap in the glyph color so the dot reads even when it touches a stroke.
    ctx.beginPath()
    ctx.arc(cx, cy, 6.5, 0, Math.PI * 2)
    ctx.fillStyle = systemDark ? '#000000' : '#ffffff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fillStyle = SEVERITY_HEX[worst]
    ctx.fill()
  }

  return canvas.toDataURL('image/png')
}

/**
 * Drives the menu-bar tray icon from the main window. Renders a glyph + a
 * severity-colored dot (worst severity across the user's agents) to a canvas
 * and pushes it to the main process, which owns the `Tray`. Also wires the tray
 * popup's "Start Chat" action back into the in-app preselect flow.
 *
 * Mount once, in the main window only.
 */
export function useTrayIcon(): void {
  const { data: statuses } = useAgentStatus()
  const worst = worstSeverity(statuses)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setPendingAgentId = useUIStore((s) => s.setPendingAgentId)
  const setAgentStatusOpen = useUIStore((s) => s.setAgentStatusOpen)
  const setAgentStatusDetailId = useUIStore((s) => s.setAgentStatusDetailId)
  const setLogsOpen = useUIStore((s) => s.setLogsOpen)

  const tooltip =
    statuses.length === 0
      ? 'Cinna — agent status'
      : `Cinna — ${statuses.length} agent${statuses.length === 1 ? '' : 's'}${worst ? ` · worst: ${worst}` : ''}`

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const push = (): void => {
      const dataUrl = renderTrayIcon(worst, mql.matches)
      if (dataUrl) window.api.tray.setImage(dataUrl, tooltip)
    }
    push()
    mql.addEventListener('change', push)
    return () => mql.removeEventListener('change', push)
  }, [worst, tooltip])

  useEffect(() => {
    return window.api.tray.onFocusChat(({ agentId }) => {
      // Clear any open overlay so the chat page isn't left hidden underneath.
      setLogsOpen(false)
      setAgentStatusOpen(false)
      setAgentStatusDetailId(null)
      setActiveView('chat')
      setPendingAgentId(agentId)
    })
  }, [setActiveView, setPendingAgentId, setLogsOpen, setAgentStatusOpen, setAgentStatusDetailId])

  useEffect(() => {
    return window.api.tray.onFocusStatus(({ agentId }) => {
      setAgentStatusDetailId(agentId)
      setAgentStatusOpen(true)
    })
  }, [setAgentStatusOpen, setAgentStatusDetailId])
}
