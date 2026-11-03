import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledContractDir } from '../../kit/contractStore'
import { DASHBOARDS_BRIDGE_KIT_PATH } from '../../kit/dashboardsProtocol'

let bridge: string | null = null

/**
 * `window.cinna`, injected into every HTML page a dashboard frame serves, as
 * an inline script right after `<head>`, before the page's own scripts. It is
 * the bundled kit's `protocols/dashboards-bridge.js`, byte for byte: every
 * host injects that file unchanged and keeps no fork (`x-web-view.bridge` in
 * the dashboards schema). Always this build's bundle, never a workshop kit,
 * since the host side of its wire (`renderer/…/dashboards/componentBridge.ts`)
 * ships with the build. Read once; a missing bundle throws `contract_missing`.
 */
export function dashboardHelperScript(): string {
  bridge ??= readFileSync(join(getBundledContractDir(), DASHBOARDS_BRIDGE_KIT_PATH), 'utf8')
  return bridge
}

/** The helper inside a served HTML document: after `<head …>`, else `<html …>`, else after a doctype, else first. */
export function injectDashboardHelper(bytes: Buffer): Buffer {
  if (bytes.length >= 2) {
    const [a, b] = [bytes[0], bytes[1]]
    // A UTF-16 page is returned as it is: the helper would corrupt it.
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return bytes
  }
  const text = bytes.toString('latin1')
  const tag = `<script>${dashboardHelperScript()}</script>`
  let at = 0
  for (const pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i]) {
    const match = pattern.exec(text)
    if (match) {
      at = match.index + match[0].length
      break
    }
  }
  if (at === 0) {
    const prolog = /^(?:\xef\xbb\xbf)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!doctype[^>]*>)?/i.exec(text)
    at = prolog ? prolog[0].length : 0
  }
  // The page's own bytes untouched either side (latin1 maps one byte to one
  // character, so `at` is a byte offset); the bridge goes in as UTF-8, unchanged.
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(tag, 'utf8'), bytes.subarray(at)])
}
