/**
 * Parse the textarea representation of env vars (one KEY=VALUE per line) into
 * a plain object. Lines without `=` or with an empty key are dropped. Surrounding
 * whitespace on key and value is trimmed.
 */
export function parseEnvVars(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  raw.split('\n').forEach((line) => {
    const eqIdx = line.indexOf('=')
    if (eqIdx > 0) {
      env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
    }
  })
  return env
}

/** Format an env-var object back to the textarea representation. */
export function formatEnvVars(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}
