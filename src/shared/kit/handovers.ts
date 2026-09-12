/** Explicit pair avoids reinterpreting an existing sibling named coordinator. */
export function isCoordinatorHandover(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const handover = value as Record<string, unknown>
  return handover.target_slug === 'coordinator' && handover.target_kind === 'coordinator'
}
