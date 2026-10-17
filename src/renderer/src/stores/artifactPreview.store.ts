import { create } from 'zustand'
import type { PublishedArtifact } from '../../../shared/artifacts'

/** Where the preview grows from: the click that opened it; null for a keyboard open. */
export interface ArtifactPreviewOrigin {
  x: number
  y: number
}

interface ArtifactPreviewState {
  artifact: PublishedArtifact | null
  instanceName: string | undefined
  origin: ArtifactPreviewOrigin | null
  /** Bumped on every open, so the modal reads core again. */
  openSeq: number
  open: (artifact: PublishedArtifact, instanceName: string | undefined, origin: ArtifactPreviewOrigin | null) => void
  close: () => void
}

/** The in-app preview of a published artifact: which one is open. The modal is mounted once, in the artifacts host. */
export const useArtifactPreviewStore = create<ArtifactPreviewState>((set) => ({
  artifact: null,
  instanceName: undefined,
  origin: null,
  openSeq: 0,
  open: (artifact, instanceName, origin) => set((state) => ({ artifact, instanceName, origin, openSeq: state.openSeq + 1 })),
  close: () => set({ artifact: null, origin: null })
}))
