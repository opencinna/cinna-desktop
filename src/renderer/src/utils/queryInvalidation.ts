import type { InvalidateQueryFilters, QueryClient } from '@tanstack/react-query'

const noop = (): void => {}

/**
 * `invalidateQueries` for a push from main that says its data moved, which
 * also reaches a query whose first read is still on its way. TanStack joins
 * an invalidation onto a fetch in flight when the query has no data yet
 * (only a refetch of data it already has is restarted), and the success that
 * follows clears the invalidated mark — so a push landing while that first
 * read is out would be lost, and an answer main computed before the move kept
 * until something else re-reads it. Such a query is read once more after its
 * first answer lands.
 *
 * The case it exists for: at launch the shared agents' statuses are read
 * before the first catalog listing lands, the listing's `sharing:changed`
 * arrives while that read is out, and an agent's Skills rows then offered no
 * Update or Remove to its maintainer, whose access the stale read lacked.
 */
export function invalidateAfterPush(queryClient: QueryClient, filters: InvalidateQueryFilters): void {
  const firstReads = queryClient
    .getQueryCache()
    .findAll(filters)
    .filter((query) => query.state.data === undefined && query.state.fetchStatus !== 'idle')
  void queryClient.invalidateQueries(filters)
  for (const query of firstReads) {
    const pending = query.promise
    if (!pending) continue
    void pending
      .then(noop, noop)
      .then(() => queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }))
  }
}
