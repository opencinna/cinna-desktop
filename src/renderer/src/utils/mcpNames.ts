/**
 * Resolve a list of MCP provider ids to their display names. Drops ids that
 * don't match any provider — a chat mode's `mcpProviderIds` JSON array can
 * outlive the underlying provider (e.g. user deleted it), and rendering raw
 * nanoids in the UI is worse than just omitting them. The boot consistency
 * pass strips orphans at the source on next launch.
 */
export function resolveMcpNames(
  ids: string[] | null | undefined,
  providers: ReadonlyArray<{ id: string; name: string }> | null | undefined
): string[] {
  if (!ids?.length) return []
  const all = providers ?? []
  return ids.flatMap((id) => {
    const match = all.find((p) => p.id === id)
    return match ? [match.name] : []
  })
}
