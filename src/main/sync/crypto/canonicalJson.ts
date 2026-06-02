/**
 * Stable canonical JSON serialization.
 *
 * The encoder (what we encrypt) and the fingerprint (HMAC over plaintext) MUST
 * agree byte-for-byte, otherwise a re-encrypt with a fresh nonce would change
 * the fingerprint and defeat the server's `unchanged` short-circuit. This is
 * the single pinned canonicalizer for both paths — see plan §4, §12.
 *
 * Rules:
 *  - Object keys sorted lexicographically (UTF-16 code-unit order, JS default).
 *  - Arrays keep their order.
 *  - `undefined` object values are dropped; `undefined` array elements become null
 *    (matching `JSON.stringify`).
 *  - Numbers: only finite numbers allowed; serialized via the JS shortest-round-trip
 *    representation (`JSON.stringify`). Non-finite numbers throw.
 *  - No whitespace.
 */
export function canonicalJson(value: unknown): string {
  return encode(value)
}

function encode(value: unknown): string {
  if (value === null) return 'null'

  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('canonicalJson: non-finite number')
    }
    return JSON.stringify(value)
  }
  if (t === 'bigint') {
    throw new Error('canonicalJson: bigint not supported')
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    // Only reachable for top-level undefined; mirror JSON.stringify(undefined).
    return 'null'
  }

  if (Array.isArray(value)) {
    const items = value.map((v) => {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return 'null'
      return encode(v)
    })
    return `[${items.join(',')}]`
  }

  // Plain object: sort keys, drop undefined/function/symbol values.
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const v = obj[key]
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
    parts.push(`${JSON.stringify(key)}:${encode(v)}`)
  }
  return `{${parts.join(',')}}`
}

const textEncoder = new TextEncoder()

/** Canonical JSON as UTF-8 bytes — the exact input to encryption and fingerprinting. */
export function canonicalBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalJson(value))
}
