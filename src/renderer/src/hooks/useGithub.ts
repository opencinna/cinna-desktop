import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { unwrapIpcError } from '../utils/ipcError'
import type { GithubDeviceFlowDto, GithubResult, GithubStatusDto, GithubUrlTarget } from '../../../shared/github'

/** Every GitHub query, for one invalidation on `github:changed`. */
export const GITHUB_KEY = ['github'] as const

/** A {@link GithubResult}'s value, or a throw carrying main's sentence (the renderer's side of the boundary). */
export function githubValue<T>(result: GithubResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/**
 * The active profile's GitHub sign-in, coverage, device flow and needs, re-read whenever main
 * publishes `github:changed` (for any profile: the query is the active one's anyway).
 */
export function useGithubStatus() {
  const userId = useAuthStore((s) => s.currentUser?.id)
  const queryClient = useQueryClient()
  useEffect(() => window.api.github.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: GITHUB_KEY })
  }), [queryClient])
  return useQuery({
    queryKey: [...GITHUB_KEY, 'status', userId],
    enabled: !!userId,
    queryFn: async (): Promise<GithubStatusDto> => githubValue(await window.api.github.status())
  })
}

/** Where a profile's device flow stands, the same on the composer row and in Settings. */
export type GithubSignInPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'pending'; userCode: string }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'error'; error: string }

/** The phase from main's device flow, with this surface's own failed start (no flow to show it) last. */
export function githubSignInPhase(device: GithubDeviceFlowDto | null | undefined, starting: boolean, startError: string | null): GithubSignInPhase {
  if (starting) return { kind: 'starting' }
  if (device?.state === 'pending') return { kind: 'pending', userCode: device.userCode }
  if (startError) return { kind: 'error', error: startError }
  if (device?.state === 'expired') return { kind: 'expired' }
  if (device?.state === 'denied') return { kind: 'denied' }
  if (device?.state === 'error') return { kind: 'error', error: device.error ?? 'The GitHub sign-in failed. Try again.' }
  return { kind: 'idle' }
}

/**
 * Copies through main's clipboard: `navigator.clipboard` rejects once the browser main just opened
 * has taken the focus. Resolves whether it landed.
 */
export async function copyGithubCode(code: string): Promise<boolean> {
  try {
    return (await window.api.clipboard.writeText(code)).success
  } catch {
    return false
  }
}

export interface GithubSignIn {
  phase: GithubSignInPhase
  /** Start (or rejoin) the device flow; the code goes to the clipboard and main opens the browser. */
  start: () => void
  cancel: () => void
  /** Whether the code went to the clipboard on the last start (null before any). */
  copied: boolean | null
}

/**
 * Sign in to GitHub for the active profile: the device flow is main's (one per profile, shown on
 * every surface), the start and its failure are this surface's. Owned by the component that draws
 * the row, which outlives the click.
 */
export function useGithubSignIn(status: GithubStatusDto | undefined): GithubSignIn {
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState<boolean | null>(null)
  const start = useMutation({
    mutationFn: async () => githubValue(await window.api.github.signIn()),
    onSuccess: async (device) => {
      setCopied(await copyGithubCode(device.userCode))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: GITHUB_KEY })
  })
  const cancel = useMutation({
    mutationFn: async () => githubValue(await window.api.github.cancelSignIn()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: GITHUB_KEY })
  })
  const startError = start.error ? unwrapIpcError(start.error, 'The GitHub sign-in couldn’t start. Try again.') : null
  // A failed start stands until the next one; a flow main reports since (from another surface) wins.
  const device = status?.device ?? null
  return {
    phase: githubSignInPhase(device, start.isPending, device?.state === 'pending' ? null : startError),
    start: () => { if (!start.isPending) { start.reset(); start.mutate() } },
    cancel: () => cancel.mutate(),
    copied
  }
}

/** Opens one of the two fixed github.com pages; resolves main's refusal as a sentence, or null. */
export async function openGithubUrl(target: GithubUrlTarget): Promise<string | null> {
  try {
    const result = await window.api.github.openUrl(target)
    return result.ok ? null : result.error
  } catch (error) {
    return unwrapIpcError(error, 'Couldn’t open GitHub.')
  }
}

/** Owned by the section, which outlives its confirm: `onSuccess` here closes it (a `mutate`-level one would be dropped). */
export function useGithubSignOut(onSuccess?: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => githubValue(await window.api.github.signOut()),
    onSuccess,
    onSettled: () => queryClient.invalidateQueries({ queryKey: GITHUB_KEY })
  })
}

/** How often a window regaining focus may ask main to read the installations again. */
export const GITHUB_FOCUS_CHECK_MS = 10_000
let lastFocusCheck = -Infinity

/**
 * While `active` (an install row is on screen), read the installations again when the window
 * regains focus: the user is back from github.com. At most once per 10 s from this renderer.
 */
export function useGithubCheckOnFocus(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const onFocus = (): void => {
      const now = Date.now()
      if (now - lastFocusCheck < GITHUB_FOCUS_CHECK_MS) return
      lastFocusCheck = now
      void window.api.github.checkAgain().catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active])
}

/** For tests: forget the last focus check. */
export function resetGithubFocusCheck(): void { lastFocusCheck = -Infinity }
