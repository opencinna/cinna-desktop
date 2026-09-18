import { PINNED_CODEX_VERSION, type EngineBinaryState } from '../../../../shared/engine'

/** Whole megabytes, for a progress line nobody needs decimals in. */
const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))

/** `codex-cli 0.155.0` → `0.155.0`. The prefix is the CLI's, not the user's. */
const bareVersion = (version: string | null): string | null =>
  version === null ? null : version.replace(/^codex-cli\s+/i, '').trim() || null

/**
 * The Runtime row's one line about the **managed Codex CLI**.
 *
 * Pure, so every state can be asserted without rendering the section. Every
 * sentence fits one line at the 800px minimum, because the row reserves
 * exactly one (ux_rules rules 1 and 12) — the only text that may run longer is
 * a failure main composed, and the row truncates that with the whole sentence
 * in `title`.
 *
 * `undefined` — the query still in flight — says nothing. Not "not installed":
 * a claim made and replaced half a second later is the jump rule 1 is about.
 */
export function codexStatusText(
  binary: EngineBinaryState | undefined,
  /** A Codex Path is saved: a resolution then checks that file and downloads nothing. */
  configured = false
): string {
  if (binary === undefined) return ''
  switch (binary.state) {
    case 'ready': {
      if (binary.source === 'configured') {
        // Labelled, not refused: the explicit path is the user's escape hatch,
        // and what it costs them is that nobody checked this version.
        const version = bareVersion(binary.version)
        return `Unverified Codex${version ? ` ${version}` : ''} — your configured path.`
      }
      return `Codex ${PINNED_CODEX_VERSION} (managed) — runs on your Codex login.`
    }
    case 'resolving': {
      // Saving a Codex Path re-resolves at once, and that is a stat and a
      // `--version`, not a download: "Installing… about 90 MB" over the user's
      // own binary would be a false claim, however briefly (ux_rules rule 9).
      if (configured) return 'Checking your configured Codex path…'
      if (binary.received === undefined) {
        return `Installing Codex ${PINNED_CODEX_VERSION} — once only, about 90 MB.`
      }
      return binary.total
        ? `Downloading Codex ${PINNED_CODEX_VERSION} — ${mb(binary.received)} of ${mb(binary.total)} MB.`
        : `Downloading Codex ${PINNED_CODEX_VERSION} — ${mb(binary.received)} MB so far.`
    }
    case 'failed':
      return binary.error
    default:
      return `Codex ${PINNED_CODEX_VERSION} installs on first use, about 90 MB.`
  }
}

/**
 * The **short** form, for a picker button's sub-line and a table cell: which
 * Codex runs, in two words. One function so the picker, the Developer Tools
 * table and the status sentence above cannot disagree about a configured path —
 * the picker said `0.155.0 managed` directly above a line reading "Unverified
 * Codex 0.160.0 — your configured path".
 *
 * Every state but a resolved configured path reads as the managed pin, because
 * that is what will run: not fetched yet and downloading are both "managed".
 */
export function codexVersionLabel(binary: EngineBinaryState | undefined): string {
  if (binary?.state === 'ready' && binary.source === 'configured') {
    const version = bareVersion(binary.version)
    return version ? `${version} unverified` : 'unverified'
  }
  return `${PINNED_CODEX_VERSION} managed`
}

/**
 * The Developer Tools table's Codex cell — the OpenCode row's vocabulary
 * (`Unavailable`, `Checking…`), with the managed/unverified distinction that
 * row does not need. `mono` is whether the text is a version.
 */
export function codexToolCell(binary: EngineBinaryState | undefined): { text: string; mono: boolean } {
  if (binary === undefined) return { text: '', mono: false }
  switch (binary.state) {
    case 'ready':
      return { text: codexVersionLabel(binary), mono: true }
    case 'failed':
      return { text: 'Unavailable', mono: false }
    case 'resolving':
      return { text: binary.received === undefined ? 'Checking…' : 'Downloading…', mono: false }
    default:
      return { text: 'Installs on first use', mono: false }
  }
}
