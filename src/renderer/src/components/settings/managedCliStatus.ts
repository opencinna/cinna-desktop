import { PINNED_CLAUDE_VERSION, PINNED_CODEX_VERSION, type EngineBinaryState } from '../../../../shared/engine'

/**
 * One pinned CLI that Cinna verifies for itself, as the sentences need it.
 *
 * Codex grew these three functions first (`codexStatus.ts`); Claude Code got
 * the same managed install, and a second copy would have been a second place
 * for the picker, the Developer Tools table and the status line to disagree
 * about a configured path — the defect the first copy was written to end.
 */
export interface ManagedCli {
  /** `Codex`, `Claude Code` — the noun in every sentence. */
  name: string
  pin: string
  /**
   * Bytes per displayed megabyte. Codex's line was written in binary megabytes
   * and is left alone; Claude's 215,643,408 bytes is "215 MB" to its vendor and
   * to Finder, and "206 MB" in binary.
   */
  bytesPerMb: number
  /** The CLI's `--version` line reduced to the number. */
  bareVersion(version: string): string
  /** `Codex`, `Claude` — whose login the sessions run on. */
  login: string
  /** `Codex path`, `Claude path`. */
  pathNoun: string
}

export const CODEX_CLI: ManagedCli = {
  name: 'Codex',
  pin: PINNED_CODEX_VERSION,
  bytesPerMb: 1024 * 1024,
  bareVersion: (version) => version.replace(/^codex-cli\s+/i, '').trim(),
  login: 'Codex',
  pathNoun: 'Codex path'
}

export const CLAUDE_CLI: ManagedCli = {
  name: 'Claude Code',
  pin: PINNED_CLAUDE_VERSION,
  bytesPerMb: 1_000_000,
  bareVersion: (version) => version.replace(/\s*\(Claude Code\)\s*$/i, '').trim(),
  login: 'Claude',
  pathNoun: 'Claude path'
}

/**
 * One size, said one way. **Floored**, and from the state's `assetBytes` — this
 * platform's pinned asset, which is also the download's `total`: the row said
 * "about 215 MB" from a constant and "0 of 216 MB" from the bytes a state later,
 * two roundings of one number.
 */
const mb = (cli: ManagedCli, bytes: number): number => Math.floor(bytes / cli.bytesPerMb)

/** ", about N MB" — or nothing, for a tool whose pin row records no size. */
const aboutSize = (cli: ManagedCli, bytes: number | undefined): string =>
  bytes === undefined ? '' : `, about ${mb(cli, bytes)} MB`

const bare = (cli: ManagedCli, version: string | null): string | null =>
  version === null ? null : cli.bareVersion(version) || null

/**
 * The Runtime row's one line about a managed CLI.
 *
 * Pure, so every state can be asserted without rendering the section. Every
 * sentence fits one line at the 800px minimum, because the row reserves exactly
 * one (ux_rules rules 1 and 12) — the only text that may run longer is a
 * failure main composed, and the row truncates that with the whole sentence in
 * `title`.
 *
 * `undefined` — the query still in flight — says nothing. Not "not installed":
 * a claim made and replaced half a second later is the jump rule 1 is about.
 */
export function cliStatusText(
  cli: ManagedCli,
  binary: EngineBinaryState | undefined,
  /** A path is saved: a resolution then checks that file and downloads nothing. */
  configured = false
): string {
  if (binary === undefined) return ''
  switch (binary.state) {
    case 'ready': {
      if (binary.source === 'configured') {
        // Labelled, not refused: the explicit path is the user's escape hatch,
        // and what it costs them is that nobody checked this version.
        const version = bare(cli, binary.version)
        return `Unverified ${cli.name}${version ? ` ${version}` : ''} — your configured path.`
      }
      // The user's own install at exactly the pinned version: as verified as a
      // managed copy, and they should know nothing was downloaded beside it.
      // Only the version string was compared — no checksum — so it says that
      // and no more, in the 60 characters the row's one line holds at 800px.
      if (binary.source === 'path-pinned') return `${cli.name} ${cli.pin} — your own install, the tested version.`
      return `${cli.name} ${cli.pin} (managed) — runs on your ${cli.login} login.`
    }
    case 'resolving': {
      // Saving a path re-resolves at once, and that is a stat and a
      // `--version`, not a download: "Installing… about 215 MB" over the user's
      // own binary would be a false claim, however briefly (ux_rules rule 9).
      if (configured) return `Checking your configured ${cli.pathNoun}…`
      // No byte has arrived, and none may: the user's own install at the pinned
      // version resolves on a `--version` alone. "Installing… about 215 MB" is
      // only true once a download has started, and then `received` says so.
      if (binary.received === undefined) return `Checking ${cli.name}…`
      // The pin row's size when there is one, so the total is the number the
      // row promised before the download; the server's length otherwise.
      const total = binary.assetBytes ?? binary.total
      return total
        ? `Downloading ${cli.name} ${cli.pin} — ${mb(cli, binary.received)} of ${mb(cli, total)} MB.`
        : `Downloading ${cli.name} ${cli.pin} — ${mb(cli, binary.received)} MB so far.`
    }
    case 'failed':
      return binary.error
    default:
      // With a path saved nothing "installs": the next check runs that file.
      return configured
        ? `Your configured ${cli.pathNoun} is checked on first use.`
        : `${cli.name} ${cli.pin} installs on first use${aboutSize(cli, binary.assetBytes)}.`
  }
}

/**
 * The **short** form, for a picker button's sub-line and a table cell: which
 * copy runs, in two words. One function so the picker, the Developer Tools
 * table and the status sentence above cannot disagree.
 *
 * `configured` is whether a path is saved, and it decides every state that is
 * not `ready`: with a path saved the managed pin is **not** what will run, so
 * the label must never read `<pin> managed` — not while that path is being
 * checked, and above all not after it **failed**, where the button used to say
 * `0.155.0 managed` directly above a red line about the user's own file.
 */
export function cliVersionLabel(cli: ManagedCli, binary: EngineBinaryState | undefined, configured = false): string {
  if (binary?.state === 'failed') return 'Unavailable'
  if (binary?.state === 'ready') {
    if (binary.source === 'configured') {
      const version = bare(cli, binary.version)
      return version ? `${version} unverified` : 'unverified'
    }
    if (binary.source === 'path-pinned') return `${cli.pin} (your install)`
    return `${cli.pin} managed`
  }
  return configured ? 'unverified' : `${cli.pin} managed`
}

/**
 * The Developer Tools table's cell — the OpenCode row's vocabulary
 * (`Unavailable`, `Checking…`), with the managed/unverified distinction that
 * row does not need. `mono` is whether the text is a version.
 */
export function cliToolCell(cli: ManagedCli, binary: EngineBinaryState | undefined, configured = false): { text: string; mono: boolean } {
  if (binary === undefined) return { text: '', mono: false }
  switch (binary.state) {
    case 'ready':
      return { text: cliVersionLabel(cli, binary, configured), mono: true }
    case 'failed':
      return { text: 'Unavailable', mono: false }
    case 'resolving':
      return { text: binary.received === undefined ? 'Checking…' : 'Downloading…', mono: false }
    default:
      return { text: configured ? 'Checked on first use' : 'Installs on first use', mono: false }
  }
}
