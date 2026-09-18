import { describe, expect, it } from 'vitest'
import type { EngineBinaryState } from '../../../../shared/engine'
import { RUNTIME_PINS } from '../../../../shared/runtimePins'
import { CLAUDE_CLI, CODEX_CLI, cliStatusText, cliToolCell, cliVersionLabel } from './managedCliStatus'

/**
 * The sentences the Runtime row, the picker and the Developer Tools table share.
 *
 * Pure strings, asserted whole: what these guard is three surfaces agreeing, and
 * a copy that fits one line at the 800px minimum (ux_rules rules 7 and 12).
 */
const CLAUDE = RUNTIME_PINS.claude.cli
const CODEX = RUNTIME_PINS.codex.cli
const ready = (source: 'managed' | 'path-pinned' | 'configured', version: string | null): EngineBinaryState =>
  ({ state: 'ready', path: '/x', source, version })

describe('cliStatusText', () => {
  it('Claude Code: one sentence per state, in the vendor’s megabytes', () => {
    expect(cliStatusText(CLAUDE_CLI, undefined)).toBe('')
    // One number, floored once: the row said "about 215 MB" from a constant and
    // "0 of 216 MB" from the bytes a state later. Mutation: `Math.round`, or a
    // total read from `total` while the sentence reads `assetBytes`.
    expect(cliStatusText(CLAUDE_CLI, { state: 'unresolved', assetBytes: 215_643_408 }))
      .toBe(`Claude Code ${CLAUDE} installs on first use, about 215 MB.`)
    expect(cliStatusText(CLAUDE_CLI, { state: 'resolving', received: 107_821_704, total: 215_643_408, assetBytes: 215_643_408 }))
      .toBe(`Downloading Claude Code ${CLAUDE} — 107 of 215 MB.`)
    // Linux's asset is a different size, which is why main sends it.
    expect(cliStatusText(CLAUDE_CLI, { state: 'unresolved', assetBytes: 232_400_000 }))
      .toBe(`Claude Code ${CLAUDE} installs on first use, about 232 MB.`)
    // No recorded size: no size claimed, and the server's length is the total.
    expect(cliStatusText(CLAUDE_CLI, { state: 'unresolved' })).toBe(`Claude Code ${CLAUDE} installs on first use.`)
    expect(cliStatusText(CLAUDE_CLI, { state: 'resolving', received: 107_821_704, total: 215_643_408 }))
      .toBe(`Downloading Claude Code ${CLAUDE} — 107 of 215 MB.`)
    // Resolving with no byte arrived is a `--version` over the user's own
    // install as often as the start of a download: claim neither.
    expect(cliStatusText(CLAUDE_CLI, { state: 'resolving', assetBytes: 215_643_408 })).toBe('Checking Claude Code…')
    expect(cliStatusText(CLAUDE_CLI, { state: 'resolving', received: 5_000_000, total: null }))
      .toBe(`Downloading Claude Code ${CLAUDE} — 5 MB so far.`)
    expect(cliStatusText(CLAUDE_CLI, ready('managed', `${CLAUDE} (Claude Code)`)))
      .toBe(`Claude Code ${CLAUDE} (managed) — runs on your Claude login.`)
    expect(cliStatusText(CLAUDE_CLI, ready('path-pinned', `${CLAUDE} (Claude Code)`)))
      .toBe(`Claude Code ${CLAUDE} — your own install, the tested version.`)
    expect(cliStatusText(CLAUDE_CLI, ready('configured', '2.1.300 (Claude Code)'), true))
      .toBe('Unverified Claude Code 2.1.300 — your configured path.')
    expect(cliStatusText(CLAUDE_CLI, { state: 'failed', error: 'offline' })).toBe('offline')
  })

  it('Codex keeps its wording and its binary megabytes', () => {
    const bytes = 90 * 1024 * 1024 + 700_000
    expect(cliStatusText(CODEX_CLI, { state: 'unresolved', assetBytes: bytes })).toBe(`Codex ${CODEX} installs on first use, about 90 MB.`)
    expect(cliStatusText(CODEX_CLI, { state: 'resolving', received: 45 * 1024 * 1024, total: bytes, assetBytes: bytes }))
      .toBe(`Downloading Codex ${CODEX} — 45 of 90 MB.`)
    expect(cliStatusText(CODEX_CLI, { state: 'resolving' })).toBe('Checking Codex…')
    expect(cliStatusText(CODEX_CLI, ready('path-pinned', `codex-cli ${CODEX}`))).toBe(`Codex ${CODEX} — your own install, the tested version.`)
  })

  it('never promises a download over a saved path', () => {
    // A stat and a `--version`, not 215 MB (ux_rules rule 9).
    expect(cliStatusText(CLAUDE_CLI, { state: 'resolving' }, true)).toBe('Checking your configured Claude path…')
    expect(cliStatusText(CLAUDE_CLI, { state: 'unresolved' }, true)).toBe('Your configured Claude path is checked on first use.')
    expect(cliStatusText(CODEX_CLI, { state: 'unresolved' }, true)).not.toMatch(/installs on first use/)
  })

  it('every sentence it composes fits the one reserved line', () => {
    // Each tool's own `--version` line: the other's would not be stripped, and
    // the sentence measured would be one no user can ever see.
    const versionOutput = new Map([[CLAUDE_CLI, '2.1.300 (Claude Code)'], [CODEX_CLI, 'codex-cli 0.160.0']])
    // 60 characters of 13px text is what the longest line this row already
    // showed ("Claude Code … — your Claude login, no API key spent.") needed.
    for (const cli of [CLAUDE_CLI, CODEX_CLI]) {
      const states: [EngineBinaryState, boolean][] = [
        [{ state: 'unresolved', assetBytes: 232_400_000 }, false], [{ state: 'unresolved' }, true], [{ state: 'resolving' }, false], [{ state: 'resolving' }, true],
        [{ state: 'resolving', received: 215_000_000, total: 215_643_408, assetBytes: 215_643_408 }, false], [ready('managed', null), false],
        [ready('path-pinned', null), false], [ready('configured', versionOutput.get(cli) ?? null), true]
      ]
      for (const [state, configured] of states) {
        const text = cliStatusText(cli, state, configured)
        expect(text.length, text).toBeLessThanOrEqual(60)
      }
    }
  })
})

describe('cliVersionLabel', () => {
  it('says which copy runs, in two words', () => {
    expect(cliVersionLabel(CLAUDE_CLI, ready('managed', null))).toBe(`${CLAUDE} managed`)
    expect(cliVersionLabel(CLAUDE_CLI, ready('path-pinned', null))).toBe(`${CLAUDE} (your install)`)
    expect(cliVersionLabel(CLAUDE_CLI, ready('configured', '2.1.300 (Claude Code)'), true)).toBe('2.1.300 unverified')
    expect(cliVersionLabel(CODEX_CLI, ready('configured', 'codex-cli 0.160.0'), true)).toBe('0.160.0 unverified')
    expect(cliVersionLabel(CODEX_CLI, ready('configured', null), true)).toBe('unverified')
  })

  it('never reads "<pin> managed" once a path is saved — least of all after that path failed', () => {
    // The picker said `0.155.0 managed` directly above a red line about the
    // user's own file. Mutation: drop the `failed` branch, or ignore
    // `configured`, and these read `<pin> managed` again.
    for (const cli of [CLAUDE_CLI, CODEX_CLI]) {
      expect(cliVersionLabel(cli, { state: 'failed', error: 'that file will not run' }, true)).toBe('Unavailable')
      expect(cliVersionLabel(cli, { state: 'resolving' }, true)).toBe('unverified')
      expect(cliVersionLabel(cli, { state: 'unresolved' }, true)).toBe('unverified')
      expect(cliVersionLabel(cli, undefined, true)).toBe('unverified')
      // A failed *managed* install is not "managed" either: nothing is.
      expect(cliVersionLabel(cli, { state: 'failed', error: 'offline' })).toBe('Unavailable')
      // With no path saved, not-fetched-yet and downloading are both the pin.
      expect(cliVersionLabel(cli, { state: 'unresolved' })).toBe(`${cli.pin} managed`)
      expect(cliVersionLabel(cli, { state: 'resolving', received: 1, total: 2 })).toBe(`${cli.pin} managed`)
    }
  })
})

describe('cliToolCell', () => {
  it('uses the table’s vocabulary, and a version only when it has one', () => {
    expect(cliToolCell(CLAUDE_CLI, undefined)).toEqual({ text: '', mono: false })
    expect(cliToolCell(CLAUDE_CLI, ready('path-pinned', null))).toEqual({ text: `${CLAUDE} (your install)`, mono: true })
    expect(cliToolCell(CLAUDE_CLI, { state: 'failed', error: 'x' })).toEqual({ text: 'Unavailable', mono: false })
    expect(cliToolCell(CLAUDE_CLI, { state: 'resolving' })).toEqual({ text: 'Checking…', mono: false })
    expect(cliToolCell(CLAUDE_CLI, { state: 'resolving', received: 1, total: 2 })).toEqual({ text: 'Downloading…', mono: false })
    expect(cliToolCell(CLAUDE_CLI, { state: 'unresolved' })).toEqual({ text: 'Installs on first use', mono: false })
    expect(cliToolCell(CLAUDE_CLI, { state: 'unresolved' }, true)).toEqual({ text: 'Checked on first use', mono: false })
  })
})
