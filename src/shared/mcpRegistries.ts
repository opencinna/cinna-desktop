/**
 * Types for built-in MCP server registries. Registries are public catalogs of
 * MCP servers that users can browse and add to their setup. The set of
 * registries is hardcoded by the app developer — users do not configure them
 * because every registry has a different API shape, so adding a new one
 * requires a new adapter.
 */

export interface McpRegistryInfo {
  /** Stable identifier used in IPC and as a badge key in the UI. */
  id: string
  /** Short display label shown as a badge on each entry. */
  label: string
  /** Longer name shown in headers / tooltips. */
  name: string
  /** Optional homepage. */
  homepage?: string
}

/**
 * A single MCP server returned from a registry search. Only the bits we need
 * to display and import are kept — the source registry's raw payload is
 * normalized here.
 */
export interface McpRegistryEntry {
  /** Registry id (matches McpRegistryInfo.id). */
  registryId: string
  /** Stable id within the registry (typically the server's canonical name). */
  id: string
  /** Display name. */
  name: string
  /** Optional shorter title from the registry (falls back to name). */
  title?: string
  /** Brief description. */
  description?: string
  /** Latest version string. */
  version?: string
  /** Homepage / repo URL, if any. */
  websiteUrl?: string
  /** Remote transport endpoints the user can connect to. */
  remotes: Array<{
    type: 'streamable-http' | 'sse'
    url: string
    /** True if the server requires headers (auth). */
    requiresAuth: boolean
  }>
}

export interface McpRegistrySearchResult {
  entries: McpRegistryEntry[]
}

/**
 * Aggregated result from searching every built-in registry at once. Entries
 * from all registries are merged in registry insertion order. Per-registry
 * failures are surfaced inline so the picker can show partial results plus a
 * warning for the registries that errored.
 */
export interface McpRegistrySearchAllResult {
  entries: McpRegistryEntry[]
  errors: Array<{
    registryId: string
    code: string
    error: string
  }>
}
