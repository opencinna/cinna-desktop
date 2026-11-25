import { useCallback, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLogin, useUsers } from '../../hooks/useAuth'
import { unwrapIpcError } from '../../utils/ipcError'
import { LoginPrompt } from './LoginPrompt'

export interface SwitchProfile {
  /**
   * Switch to the profile. A passwordless one switches at once; one with a password is tried
   * without it first (main remembers an unlock for the app session) and, when main asks for it,
   * the password prompt opens. `onSwitched` runs once the profile is the current one, by either
   * path (the composer carries its draft there); never when the switch is refused or cancelled.
   */
  switchTo: (userId: string, hasPassword: boolean, onSwitched?: (userId: string) => void) => Promise<void>
  /** A switch is under way (the try without a password, or a passwordless switch). */
  pending: boolean
  /** Why the last switch did not happen, when main said so; null otherwise. */
  error: string | null
  /** The password prompt, portaled; render it wherever the hook is owned. Null when closed. */
  prompt: ReactNode
  /** Close the password prompt without switching. */
  cancelPrompt: () => void
}

/**
 * The one way to switch profiles, shared by the profile menu and the composer's account rows
 * (Switch to <name>): `login({ userId })`, and the password prompt when main refuses without one.
 * Owned by a component that outlives the click, so the prompt and the answer are not dropped with
 * the button.
 */
export function useSwitchProfile(options: { onSwitched?: () => void } = {}): SwitchProfile {
  const login = useLogin()
  const { data: users } = useUsers()
  const [promptUserId, setPromptUserId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { onSwitched } = options
  const { mutateAsync } = login
  /** The running switch's own `onSwitched`, for the password prompt's success. */
  const pendingSwitched = useRef<((userId: string) => void) | null>(null)

  const switchTo = useCallback(async (userId: string, hasPassword: boolean, switched?: (userId: string) => void): Promise<void> => {
    setError(null)
    pendingSwitched.current = null
    // Main tracks whether the profile was unlocked this session: a password profile is tried
    // without one first, and the prompt opens when main says one is required.
    const result = await mutateAsync({ userId }).catch((err: unknown) => {
      setError(unwrapIpcError(err, 'The profile could not be opened'))
      return null
    })
    if (!result) return
    if (result.success) {
      switched?.(userId)
      return
    }
    if (hasPassword) {
      pendingSwitched.current = switched ?? null
      setPromptUserId(userId)
    } else setError(result.error ?? 'The profile could not be opened')
  }, [mutateAsync])

  const cancelPrompt = useCallback(() => {
    pendingSwitched.current = null
    setPromptUserId(null)
  }, [])

  const prompt = promptUserId
    ? createPortal(
        <LoginPrompt
          userId={promptUserId}
          userName={users?.find((u) => u.id === promptUserId)?.displayName ?? ''}
          onSuccess={() => {
            const switched = pendingSwitched.current
            pendingSwitched.current = null
            setPromptUserId(null)
            switched?.(promptUserId)
            onSwitched?.()
          }}
          onCancel={cancelPrompt}
        />,
        document.body
      )
    : null

  return { switchTo, pending: login.isPending, error, prompt, cancelPrompt }
}
