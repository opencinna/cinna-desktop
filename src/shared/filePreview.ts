/**
 * In-app file preview for a small set of text-based attachment types
 * (`txt`, `csv`, `md`, `json`, `yaml`/`yml`, `py`, `xml` and its dialects)
 * and the common image formats (`png`, `jpg`, `gif`, `webp`, `bmp`, `svg`). Clicking a previewable
 * attachment badge opens a modal showing the decoded content instead of
 * going straight to a save dialog; non-previewable types still download.
 *
 * The preview is a read-only convenience — the modal always offers a
 * Download button that routes through the existing `files:download` path.
 */

/** How the preview modal should render a previewable file's text. */
export type PreviewRenderKind = 'markdown' | 'json' | 'csv' | 'python' | 'xml' | 'text' | 'html' | 'image'

/**
 * Max bytes the main process reads for a preview. Preview is for quick
 * inspection, not full-file viewing — anything larger is truncated (the
 * modal shows a notice and the Download button gets the complete file).
 */
export const MAX_PREVIEW_BYTES = 512 * 1024 // 512 KB

/**
 * Max bytes of an image main hands the renderer as a `data:` URL, for the
 * preview and the inline thumbnails. An image is never cut: a larger one is
 * refused with {@link IMAGE_TOO_LARGE_ERROR} and the badge downloads it.
 */
export const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024 // 20 MB

/** The longest side of an inline thumbnail main returns, in px (2× the 64 px box, and some). */
export const THUMBNAIL_MAX_SIDE = 160

/**
 * An image the host cannot scale (SVG, or a format it does not decode) is sent
 * as it is for a thumbnail only up to this size; a larger one has none.
 */
export const THUMBNAIL_ORIGINAL_MAX_BYTES = 256 * 1024

/** The refusal for an image over {@link MAX_IMAGE_PREVIEW_BYTES}. */
export const IMAGE_TOO_LARGE_ERROR = 'Image too large to preview.'

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
  yml: 'text',
  py: 'python',
  pyi: 'python',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
  rss: 'xml',
  atom: 'xml',
  kml: 'xml',
  gpx: 'xml',
  csproj: 'xml',
  xaml: 'xml',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image'
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
  'text/yaml': 'text',
  'text/x-python': 'python',
  'text/x-script.python': 'python',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/svg+xml': 'image'
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

/**
 * Decode preview bytes as UTF-8 for the modal. When the read was truncated,
 * decode with `stream: true` and skip the final flush so a multi-byte sequence
 * severed by the byte cap is dropped rather than surfacing a trailing
 * replacement char. A complete buffer decodes normally — genuinely-invalid
 * bytes still become � (intended).
 */
export function decodePreviewText(bytes: Uint8Array, truncated: boolean): string {
  const decoder = new TextDecoder('utf-8')
  return truncated ? decoder.decode(bytes, { stream: true }) : decoder.decode(bytes)
}

/** Convenience predicate for badge click-routing. */
export function isPreviewable(filename: string, mimeType?: string): boolean {
  return previewKindFor(filename, mimeType) !== null
}

/**
 * `files:read-image`: an attachment by id and store, or a file the user
 * surfaced in this session (a composer file not yet sent) by its path.
 */
export type FilesReadImageInput =
  | { fileId: string; source?: 'cinna' | 'local' }
  | { path: string }

export type FilesReadImageResult =
  | { success: true; dataUrl: string; mimeType: string }
  | { success: false; error: string; code?: string }

/** `files:read-preview-path`: the text of a composer file not yet sent. */
export type FilesReadPreviewPathResult =
  | { success: true; text: string; truncated: boolean }
  | { success: false; error: string; code?: string }

/** `files:paste-from-clipboard`: the files a paste attaches; empty when none. */
export type FilesPasteFromClipboardResult =
  | { success: true; paths: string[] }
  | { success: false; error: string; code?: string }
