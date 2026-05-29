/**
 * Normalize an error that crossed the IPC boundary into a clean, user-facing
 * string. Electron wraps thrown handler errors as
 * `Error invoking remote method 'channel': <DomainError>: <message>`; strip
 * both the remote-method plumbing and the leading error-class name so the
 * remaining text is the domain message we authored.
 */
export function unwrapIpcError(err: unknown, fallback = 'Something went wrong'): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = (raw || fallback)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^[A-Z][A-Za-z]*Error:\s*/, '')
    .trim()
  return cleaned || fallback
}
