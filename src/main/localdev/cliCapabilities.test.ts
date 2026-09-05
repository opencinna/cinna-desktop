import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { clearCliCapabilityCache, probeCliCapabilities } from './cliCapabilities'

/**
 * Probed against a real executable, because the thing under test is a spawn and
 * a text match, and a mocked spawn would leave the half that has actually gone
 * wrong before — "which arguments does it ask with" — untested.
 *
 * The two help texts below are copied from the two binaries that exist:
 * cinna-cli as this desktop prefers it, and cinna-cli 0.3.0 from PyPI, which a
 * real cinna-core pins today and which has neither `--json` nor
 * `cinna account set-token`. Help text written from imagination would only
 * prove the probe agrees with itself.
 */

const MODERN_SETUP_HELP = `Usage: cinna account setup [OPTIONS] SETUP_INPUT...

Options:
  --name TEXT  Machine name for this account session
  --dir TEXT   Directory to create the account workspace in.
  --no-input   Never prompt; take every default.
  --json       Machine-readable output: one JSON object per line on stdout
  --help       Show this message and exit.
`

const MODERN_ACCOUNT_HELP = `Commands:
  agents           List the agents this account can access.
  refresh-context  Re-download the context package
  set-token        Refresh the account token in place from a new setup token.
  setup            Set up an account workspace from an account setup token.
  status           Show account workspace info and account token validity.
`

/** cinna-cli 0.3.0, verbatim from \`cinna account setup --help\`. */
const LEGACY_SETUP_HELP = `Usage: cinna account setup [OPTIONS] SETUP_INPUT...

Options:
  --name TEXT  Machine name for this account session
  --dir TEXT   Directory to create the account workspace in (default: the
  --help       Show this message and exit.
`

/** cinna-cli 0.3.0: no \`set-token\` under \`account\`. */
const LEGACY_ACCOUNT_HELP = `Commands:
  agents           List the agents this account can access.
  refresh-context  Re-download the context package
  setup            Set up an account workspace from an account setup token.
  status           Show account workspace info and account token validity.
`

const root = mkdtempSync(join(tmpdir(), 'cinna-caps-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/**
 * A stand-in `cinna` that answers only the two questions the probe is supposed
 * to ask, and **exits non-zero on anything else** — so a probe that changed
 * what it asks would fail here rather than quietly reporting `legacy`.
 */
function fakeCli(name: string, setupHelp: string, accountHelp: string): string {
  const path = join(root, name)
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
  "account setup --help") cat <<'HELP'
${setupHelp}HELP
  ;;
  "account --help") cat <<'HELP'
${accountHelp}HELP
  ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`,
    'utf8'
  )
  chmodSync(path, 0o755)
  return path
}

beforeEach(() => clearCliCapabilityCache())

describe('probeCliCapabilities', () => {
  it('reports the full surface for a cinna-cli that has it', async () => {
    const bin = fakeCli('cinna-modern', MODERN_SETUP_HELP, MODERN_ACCOUNT_HELP)
    expect(await probeCliCapabilities(bin, '0.4.0', process.env)).toEqual({
      json: true,
      accountSetToken: true
    })
  })

  it('reports the reduced surface for cinna-cli 0.3.0', async () => {
    // The case that matters: a server pinning 0.3.0 hands the desktop a binary
    // for which `--json` is a usage error, not a no-op.
    const bin = fakeCli('cinna-legacy', LEGACY_SETUP_HELP, LEGACY_ACCOUNT_HELP)
    expect(await probeCliCapabilities(bin, '0.3.0', process.env)).toEqual({
      json: false,
      accountSetToken: false
    })
  })

  it('reads the two capabilities independently', async () => {
    // They ship together today, and encoding "0.4 or later has both" would be a
    // version floor wearing a probe's clothes.
    const bin = fakeCli('cinna-mixed', MODERN_SETUP_HELP, LEGACY_ACCOUNT_HELP)
    expect(await probeCliCapabilities(bin, '9.9.9', process.env)).toEqual({
      json: true,
      accountSetToken: false
    })
  })

  it('does not mistake prose mentioning set-token for the subcommand', async () => {
    const accountHelp = `Commands:
  setup            Set up a workspace, then run set-token to refresh it.
  status           Show account workspace info.
`
    const bin = fakeCli('cinna-prose', MODERN_SETUP_HELP, accountHelp)
    const caps = await probeCliCapabilities(bin, '1.2.3', process.env)
    expect(caps.accountSetToken).toBe(false)
  })

  it('assumes the older surface when the binary will not run', async () => {
    // The safe direction. A reduced install still works; assuming `--json` on a
    // cinna-cli without it fails every command before it starts.
    expect(await probeCliCapabilities(join(root, 'absent'), '0.0.0', process.env)).toEqual({
      json: false,
      accountSetToken: false
    })
  })

  it('caches per binary and version, and re-asks when the version changes', async () => {
    const bin = fakeCli('cinna-cached', MODERN_SETUP_HELP, MODERN_ACCOUNT_HELP)
    const first = await probeCliCapabilities(bin, '1.0.0', process.env)
    expect(await probeCliCapabilities(bin, '1.0.0', process.env)).toBe(first)
    // `<localdev>/bin/cinna` is rewritten in place by an upgrade, so the path
    // alone would hand the new binary the old answer.
    expect(await probeCliCapabilities(bin, '2.0.0', process.env)).not.toBe(first)
  })

  it('forgets everything when the cache is cleared', async () => {
    const bin = fakeCli('cinna-clear', MODERN_SETUP_HELP, MODERN_ACCOUNT_HELP)
    const first = await probeCliCapabilities(bin, '1.0.0', process.env)
    clearCliCapabilityCache()
    expect(await probeCliCapabilities(bin, '1.0.0', process.env)).not.toBe(first)
  })
})
