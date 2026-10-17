import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { useAuthStore } from '../stores/auth.store'
import type { ArtifactApprovalSummary, ArtifactCardDto, ArtifactsSupport } from '../../../shared/artifacts'

/** Every artifacts query; an `artifacts:changed` event reads them all again. */
export const ARTIFACTS_KEY = ['artifacts'] as const

const UNSUPPORTED: ArtifactsSupport = { supported: false, limits: { maxRevisionBytes: 0, maxRevisionFiles: 0, maxFileBytes: 0 } }

interface SupportState {
  /** The profile the answer is for; an answer for another profile is no answer. */
  profileId: string | null
  support: ArtifactsSupport
  set: (profileId: string, support: ArtifactsSupport) => void
}

/**
 * Main's answer to "can this profile publish?", loaded by {@link useArtifactsSupportLoader}
 * (mounted once, in the artifacts host). A store rather than a query so the
 * surfaces that read it — the transcript menu, the file preview, a link in
 * agent text — need no query client of their own.
 */
export const useArtifactsSupportStore = create<SupportState>((set) => ({
  profileId: null,
  support: UNSUPPORTED,
  set: (profileId, support) => set({ profileId, support })
}))

/**
 * Whether the active profile can publish artifacts (a signed-in Cinna account
 * whose instance keeps them). False until main has answered for this
 * profile, and on any failure — every artifact surface stays hidden then (A14).
 */
export function useArtifactsSupport(): ArtifactsSupport {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const answered = useArtifactsSupportStore((s) => s.profileId)
  const support = useArtifactsSupportStore((s) => s.support)
  return profileId !== null && answered === profileId ? support : UNSUPPORTED
}

/**
 * Asks main for the profile's support when the profile changes, when the
 * window regains focus, and after an artifact changed (a publish may have
 * taught main the frontend origin its links use); and takes the answer main
 * pushes on its own whenever it changes (core reachable at last after a
 * launch, or core dropped artifacts) — so no focus or reload is needed.
 * A menu already open keeps the items it opened with.
 */
export function useArtifactsSupportLoader(): void {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  useEffect(() => {
    if (profileId === null) return
    let cancelled = false
    // A pushed answer is newer than a reply to a question asked before it.
    let pushes = 0
    const load = (): void => {
      const asked = pushes
      window.api.artifacts
        .support()
        .then((support) => {
          if (!cancelled && pushes === asked) useArtifactsSupportStore.getState().set(profileId, support)
        })
        .catch(() => {
          if (!cancelled && pushes === asked) useArtifactsSupportStore.getState().set(profileId, UNSUPPORTED)
        })
    }
    load()
    window.addEventListener('focus', load)
    const unsubscribe = window.api.artifacts.onChanged?.(load)
    const unsubscribePush = window.api.artifacts.onSupportChanged?.((payload) => {
      if (cancelled || payload.profileId !== profileId) return
      pushes += 1
      useArtifactsSupportStore.getState().set(profileId, payload.support)
    })
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      unsubscribe?.()
      unsubscribePush?.()
    }
  }, [profileId])
}

/** One empty list, so a consumer that reports cards upward sees no change while there are none. */
const NO_CARDS: ArtifactCardDto[] = []

/** A chat's artifact cards, from the local memory; none while unsupported. */
export function useArtifactCards(chatId: string | null): ArtifactCardDto[] {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const { supported } = useArtifactsSupport()
  const { data } = useQuery({
    queryKey: [...ARTIFACTS_KEY, 'cards', profileId, chatId],
    queryFn: () => window.api.artifacts.cards(chatId as string),
    enabled: supported && chatId !== null && profileId !== null
  })
  return supported ? data ?? NO_CARDS : NO_CARDS
}

/**
 * Reads a chat's cards and reports them upward. A sibling of the transcript
 * mounted only while artifacts are supported, so a transcript without them
 * asks nothing (the `FileRefResolver` pattern).
 */
export function ArtifactCardsSource({ chatId, onChange }: { chatId: string; onChange: (cards: ArtifactCardDto[]) => void }): null {
  const cards = useArtifactCards(chatId)
  useEffect(() => {
    onChange(cards)
  }, [cards, onChange])
  useEffect(() => () => onChange([]), [onChange])
  return null
}

/** Core's current state of one artifact, for the active profile. */
export function useArtifactDetail(artifactId: string | null, enabled = true) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  return useQuery({
    queryKey: [...ARTIFACTS_KEY, 'detail', profileId, artifactId],
    queryFn: () => window.api.artifacts.detail(artifactId as string),
    enabled: enabled && artifactId !== null && profileId !== null,
    retry: false,
    staleTime: 30_000
  })
}

/** Reads cards and details again when main says an artifact changed. Mounted once. */
export function useArtifactEvents(): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      window.api.artifacts.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: [...ARTIFACTS_KEY, 'cards'] })
        void queryClient.invalidateQueries({ queryKey: [...ARTIFACTS_KEY, 'detail'] })
        void queryClient.invalidateQueries({ queryKey: [...ARTIFACTS_KEY, 'local'] })
      }),
    [queryClient]
  )
  useEffect(
    () =>
      window.api.artifacts.onApprovalsChanged(() => {
        void queryClient.invalidateQueries({ queryKey: [...ARTIFACTS_KEY, 'approvals'] })
      }),
    [queryClient]
  )
}

/** A chat's pending agent publishes (approval cards). */
export function useArtifactApprovals(chatId: string | null): ArtifactApprovalSummary[] {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const { data } = useQuery({
    queryKey: [...ARTIFACTS_KEY, 'approvals', profileId, chatId],
    queryFn: () => window.api.artifacts.approvals(chatId as string),
    enabled: chatId !== null && profileId !== null
  })
  return data ?? NO_APPROVALS
}

const NO_APPROVALS: ArtifactApprovalSummary[] = []

/** One artifact from the local memory (an agent's published tool call). */
export function useLocalArtifact(artifactId: string | null) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  return useQuery({
    queryKey: [...ARTIFACTS_KEY, 'local', profileId, artifactId],
    queryFn: () => window.api.artifacts.local(artifactId as string),
    enabled: artifactId !== null && profileId !== null
  })
}
