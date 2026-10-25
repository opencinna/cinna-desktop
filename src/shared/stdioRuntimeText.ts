/**
 * The sentences a local (stdio) MCP server is held back with, as main records
 * them on its connection and the renderer compares them: one copy, so a card
 * can tell a policy refusal (nothing to retry) from a missing runtime (Check
 * again / Reconnect works once it is installed).
 */
export const STDIO_RUNTIME_TEXT = {
  node: 'Needs Node.js — install it from nodejs.org',
  docker: 'Needs Docker — install it from docker.com',
  policy: 'Blocked by your admin',
  uvFailed: 'Python could not be set up on this computer.'
} as const
