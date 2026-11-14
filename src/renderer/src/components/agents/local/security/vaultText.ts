import type { VaultAvailability, VaultState } from '../../../../../../shared/vault/types'
import type { VaultUnavailableReason } from '../../../../../../shared/vault/protocol'

/** Why this Mac cannot hold a vault, in the user's words (README "Security tab"). */
export const UNAVAILABLE_TEXT: Record<VaultUnavailableReason, string> = {
  'unsupported-os': 'Needs macOS 15 or later on Apple silicon.',
  'unsupported-hardware': 'Needs a Mac with Apple silicon.',
  nested: 'Not available inside a virtual machine.',
  'no-virtualization': 'This Mac does not allow virtual machines.',
  'helper-missing': 'The vault helper is missing from this build.',
  'helper-untrusted': 'The vault helper in this build is not signed by Cinna, so it is not used.',
  'image-missing': 'The guest image isn’t installed.'
}

export function unavailableText(availability: VaultAvailability): string | null {
  return availability.ok ? null : UNAVAILABLE_TEXT[availability.reason] ?? 'Agent Vault is not available on this Mac.'
}

/** The state as a word; `unlocked` gets its countdown from {@link unlockedLabel}. */
export const STATE_LABEL: Record<VaultState, string> = {
  locked: 'Locked',
  booting: 'Unlocking…',
  unlocked: 'Unlocked',
  locking: 'Locking…',
  stopped: 'Locked',
  error: 'Needs attention',
  tampered: 'Tampered'
}

/**
 * "Unlocked · locks in 42s", or "Running" while a turn holds the window open
 * (`until` null, D13).
 */
export function unlockedLabel(until: number | null, now: number): string {
  if (until === null) return 'Running'
  const seconds = Math.max(0, Math.ceil((until - now) / 1000))
  return `Unlocked · locks in ${seconds}s`
}

export const GB = 1024 ** 3

/** Whole gigabytes when it is one, else one decimal: "10 GB", "2.4 GB", "512 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) {
    const gb = bytes / GB
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
  }
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${Math.round(mb)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The size limit typed in GB, checked before anything is asked of the helper.
 * Null is fine; a string is the reason it is refused. Lowering below what the
 * vault already uses is refused with the usage named (README).
 */
export function sizeLimitProblem(gbText: string, usedBytes: number | null): string | null {
  const gb = Number(gbText.trim())
  if (!gbText.trim() || !Number.isFinite(gb)) return 'Enter the limit in GB.'
  if (gb < 1) return 'The limit is at least 1 GB.'
  if (gb > 2048) return 'The limit is at most 2048 GB.'
  if (usedBytes !== null && gb * GB < usedBytes) {
    return `The vault already uses ${formatBytes(usedBytes)}; the limit can’t go below that.`
  }
  return null
}

/** "*.example.com" or a host name: letters, digits, dots, dashes, at least one dot. */
export function isHostPattern(text: string): boolean {
  return /^(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(text.trim())
}

/** An environment-variable name for a secret. */
export function isSecretName(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
}
