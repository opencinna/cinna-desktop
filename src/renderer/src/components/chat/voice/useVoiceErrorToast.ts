import { useCallback, useRef } from 'react'
import { useToastStore } from '../../../stores/toast.store'

/**
 * The composer's voice errors, as toasts. A message shows an error toast; null
 * (the next recording started) takes down the toast this composer showed if it
 * is still up, and never another one, such as the "hidden" info toast.
 */
export function useVoiceErrorToast(): (message: string | null) => void {
  const shownId = useRef<number | null>(null)
  return useCallback((message: string | null) => {
    const store = useToastStore.getState()
    if (message) {
      shownId.current = store.show(message, { link: null, kind: 'error' })
      return
    }
    if (shownId.current !== null && store.toast?.id === shownId.current) store.dismiss()
    shownId.current = null
  }, [])
}
