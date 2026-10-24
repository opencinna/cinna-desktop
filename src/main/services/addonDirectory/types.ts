import type { AddonNextStep, AddonPolicy, AddonRef, DirectoryEntry } from '../../../shared/addons/directory'

/** What a provider reads in: the settings scope (folder agents and the MCP list live there). */
export interface DirectoryContext {
  settingsUserId: string
  /** Re-read what the provider caches (the picker's once-per-opening read). */
  refresh?: boolean
  /**
   * Core's own MCP directory is in this read (its unified index answered):
   * it is seeded from the Cinna-curated registry index, so that index is not
   * listed a second time. The directory sets it for the gated providers.
   */
  coreMcpDirectory?: boolean
}

/**
 * An entry as a provider hands it to the directory: the shared shape, plus
 * the facts the per-agent state is computed from. These extra fields stay in
 * main; the directory strips them.
 */
export interface ProviderEntry extends DirectoryEntry {
  /** The local MCP provider this entry is (`this-computer`). */
  mcpProviderId?: string
  /** The directory entry a local provider was created from (`mcp_providers.registry_ref`). */
  registryRef?: AddonRef | null
  /** A local provider's server, its URL or the package it runs (`serverIdentity.ts`): matched against core's MCP directory. */
  serverKey?: string | null
  /** Add works, then this step is needed: one sentence, or absent. */
  setupReason?: string
  /** A local connector's step behind {@link setupReason}. */
  setupStep?: AddonNextStep
  /** The provider that listed it; the directory sets it. */
  provider?: string
  /** A plugin that cannot be added on this computer: the sentence why (a missing runtime, the policy). The directory sets it. */
  blockReason?: string
}

/** One provider's read: its entries, a sentence when part of it failed, and core's policy when it sends one. */
export interface ProviderListing {
  entries: ProviderEntry[]
  /** Part of the source failed; the rest of `entries` still stands. */
  error?: string
  /** `reauth`: the error is an expired session. */
  errorCode?: 'reauth'
  policy?: AddonPolicy
  /** These entries are core's unified index, its MCP directory among them (`DirectoryContext.coreMcpDirectory`). */
  mcpDirectory?: boolean
}

/**
 * One source of addons. `list` is the full index, cached by the provider;
 * `search` is for sources too large to list (the official MCP registry), asked
 * after a debounce. A provider that throws is reported as that source's error
 * and the others still answer.
 */
export interface DirectoryProvider {
  id: string
  label: string
  /** Offered only while this policy flag is on (from core's policy, else the default). */
  gate?: keyof AddonPolicy
  list(ctx: DirectoryContext): Promise<ProviderListing>
  search?(ctx: DirectoryContext, query: string): Promise<ProviderListing>
  /** One entry by ref, for an add or a detail read, when `list` cannot answer it. */
  find?(ctx: DirectoryContext, ref: AddonRef): Promise<ProviderEntry | null>
  /** Whether this provider answers refs of this source. */
  owns(ref: AddonRef): boolean
}
