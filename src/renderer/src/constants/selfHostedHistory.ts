export const SELFHOSTED_HISTORY_KEY = 'cinna-selfhosted-history'
export const SELFHOSTED_HISTORY_LIMIT = 8

export function readSelfHostedHistory(): string[] {
  try {
    const raw = localStorage.getItem(SELFHOSTED_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

export function writeSelfHostedHistory(urls: string[]): void {
  localStorage.setItem(SELFHOSTED_HISTORY_KEY, JSON.stringify(urls))
}

/** Move `url` to the front, dedupe, and cap to SELFHOSTED_HISTORY_LIMIT. */
export function prependSelfHostedHistory(existing: string[], url: string): string[] {
  return [url, ...existing.filter((u) => u !== url)].slice(0, SELFHOSTED_HISTORY_LIMIT)
}
