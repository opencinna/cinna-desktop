/**
 * Where the user last left a file's preview. Reopening the file goes back
 * there. In memory only: it lasts until the app restarts, and holds nothing but
 * numbers under the preview's key.
 *
 * The pixel offset is exact at the width it was taken at. At another (the
 * preview now fills the window, or the window was resized) the text has
 * rewrapped, and the share of the way down is the closer answer.
 */
export interface PreviewView {
  scrollTop: number
  /** `scrollTop` over the scrollable range, 0–1. */
  share: number
  /** The body's width when it was taken. */
  width: number
}

/** Past this many files the least recently touched is forgotten. */
const MAX_REMEMBERED = 200

const views = new Map<string, PreviewView>()

export function rememberedPreviewView(key: string): PreviewView | undefined {
  return views.get(key)
}

export function rememberPreviewView(key: string, view: PreviewView): void {
  // Re-inserted so a Map's insertion order is the order they were last touched.
  views.delete(key)
  views.set(key, view)
  if (views.size > MAX_REMEMBERED) {
    const oldest = views.keys().next().value
    if (oldest !== undefined) views.delete(oldest)
  }
}

/** For tests. */
export function forgetPreviewViews(): void {
  views.clear()
}
