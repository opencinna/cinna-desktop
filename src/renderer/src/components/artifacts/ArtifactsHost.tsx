import { useArtifactEvents, useArtifactsSupportLoader } from '../../hooks/useArtifacts'
import { useArtifactProgress } from './ArtifactCard'
import { PublishArtifactDialog } from './PublishArtifactDialog'
import { ArtifactPreviewModal } from './ArtifactPreviewModal'

/**
 * Artifacts, app-wide: the one Publish dialog, its progress from main, and
 * re-reading cards when an artifact changes. Mounted once, beside the file
 * preview, so a publish outlives whatever surface opened it.
 */
export function ArtifactsHost(): React.JSX.Element {
  useArtifactsSupportLoader()
  useArtifactEvents()
  useArtifactProgress()
  return (
    <>
      <PublishArtifactDialog />
      <ArtifactPreviewModal />
    </>
  )
}
