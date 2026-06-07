/**
 * In-app file preview for a small set of text-based attachment types
 * (`txt`, `csv`, `md`, `json`, `yaml`/`yml`). Clicking a previewable
 * attachment badge opens a modal showing the decoded content instead of
 * going straight to a save dialog; non-previewable types still download.
 *
 * The preview is a read-only convenience — the modal always offers a
 * Download button that routes through the existing `files:download` path.
 */

/** How the preview modal should render a previewable file's text. */
export type PreviewRenderKind = 'markdown' | 'json' | 'csv' | 'text'

/**
 * Max bytes the main process reads for a preview. Preview is for quick
 * inspection, not full-file viewing — anything larger is truncated (the
 * modal shows a notice and the Download button gets the complete file).
 */
export const MAX_PREVIEW_BYTES = 512 * 1024 // 512 KB

/** Extensions → how the modal renders them. */
const PREVIEW_KIND_BY_EXT: Record<string, PreviewRenderKind> = {
  txt: 'text',
  log: 'text',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  csv: 'csv',
  tsv: 'csv',
  yaml: 'text',
  yml: 'text'
}

/** MIME types → how the modal renders them (fallback when the extension
 *  is missing or unrecognised). */
const PREVIEW_KIND_BY_MIME: Record<string, PreviewRenderKind> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/x-yaml': 'text',
  'application/yaml': 'text',
  'text/yaml': 'text'
}

/**
 * Decide whether a file can be previewed and, if so, how its text should be
 * rendered. Extension wins over MIME (filenames are more reliable than the
 * best-effort MIME guesses the stores attach); MIME is the fallback.
 * Returns `null` for anything not previewable — the caller downloads instead.
 */
export function previewKindFor(filename: string, mimeType?: string): PreviewRenderKind | null {
  // Inline extension parse — this module is imported by the sandboxed
  // renderer, so it can't depend on Node's `path`.
  const dot = filename.lastIndexOf('.')
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
  if (ext && ext in PREVIEW_KIND_BY_EXT) return PREVIEW_KIND_BY_EXT[ext]
  if (mimeType && mimeType in PREVIEW_KIND_BY_MIME) return PREVIEW_KIND_BY_MIME[mimeType]
  return null
}

/** Convenience predicate for badge click-routing. */
export function isPreviewable(filename: string, mimeType?: string): boolean {
  return previewKindFor(filename, mimeType) !== null
}
