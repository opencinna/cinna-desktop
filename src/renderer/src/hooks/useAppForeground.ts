import { useEffect, useState } from 'react'

/** The window has focus and is not hidden: what the user can see is being looked at. */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(() => document.hasFocus() && document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setForeground(document.hasFocus() && document.visibilityState !== 'hidden')
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return foreground
}
