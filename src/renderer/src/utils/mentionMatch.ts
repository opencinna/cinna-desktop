/**
 * Loose name matching for composer pickers (`@` agents).
 *
 * A plain substring match fails on multi-word names: "@adcreat" never finds
 * "Ad Creatives Agent" or "Ad-Creatives Agent", because the space or dash sits
 * between what the user typed. So both sides are also compared with every
 * non-letter, non-digit character removed — the raw substring match still
 * runs first, so a query that is itself punctuation ("-") keeps working.
 */
export function compactName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function matchesMentionQuery(name: string, query: string): boolean {
  const q = query.toLowerCase()
  if (!q) return true
  if (name.toLowerCase().includes(q)) return true
  const compactQuery = compactName(q)
  return compactQuery.length > 0 && compactName(name).includes(compactQuery)
}
