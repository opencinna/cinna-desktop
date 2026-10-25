/**
 * A marketplace plugin's slash command, expanded by Cinna into the prompt the
 * command stands for, for an engine that does not run it itself the way Claude
 * does (OpenCode, Codex, Antigravity — `acpDriver` decides which).
 *
 * OpenCode does take commands as config, but runs one detached: its turn ends
 * at once and nothing of the work is streamed. Codex and Antigravity take none.
 * Sending the expanded template as a plain prompt makes the turn an ordinary
 * one on all three: it streams, shows its tool calls and asks, and ends when
 * the agent is done.
 *
 * Claude Code's template rules, except shell lines:
 * - `$ARGUMENTS` is the whole argument string; `$1`…`$9` its whitespace-split
 *   words, empty when missing. A template with neither gets the arguments
 *   appended as `ARGUMENTS: <args>`.
 * - `` !`cmd` `` is **not run here**. It becomes a marker telling the model to
 *   run that command first and use its output in its place, so the command
 *   runs as a visible, permissioned tool call of the engine.
 * - `@file` references stay as written; frontmatter (`allowed-tools`,
 *   `model`, `argument-hint`) is already gone (`readPluginCommand`).
 *
 * Pure: no file, no Electron.
 */

/** A plugin command as the engine config lists it: `<plugin>:<command>` (nested `sub:stem`) and its template. */
export interface PluginCommandTemplate {
  name: string
  template: string
}

/** The leading slash token and what follows it. */
const SLASH = /^\/(\S+)(?:\s+([\s\S]*))?$/

/** Placeholders, and shell lines, in one pass so arguments are never read as either. */
const TEMPLATE_TOKEN = /!`([^`\n]+)`|\$ARGUMENTS|\$([1-9])(?!\d)/g
const HAS_PLACEHOLDER = /\$ARGUMENTS|\$[1-9](?!\d)/
const HAS_SHELL = /!`[^`\n]+`/

/** The marker a `` !`cmd` `` becomes. */
export function shellMarker(command: string): string {
  return `[run \`${command}\` and use its output here]`
}

/** Said once, before the template, when it has shell markers. */
export const SHELL_LEAD_IN =
  'Some of its context is not filled in yet: each [run `…` and use its output here] marks a shell command. ' +
  'Run each of those commands first, in the current folder, and read its output in place of its marker.'

/**
 * The prompt `text` stands for when its leading token names one of `commands`
 * — `/<plugin>:<command>`, or, given `agentKey`, OpenCode's
 * `/<agentKey>/<plugin>:<command>` — else null.
 */
export function expandPluginCommand(
  text: string,
  commands: readonly PluginCommandTemplate[],
  options: { agentKey?: string } = {}
): string | null {
  const match = SLASH.exec(text.trim())
  if (!match) return null
  let name = match[1]
  if (options.agentKey && name.startsWith(`${options.agentKey}/`)) name = name.slice(options.agentKey.length + 1)
  if (!name.includes(':')) return null
  const command = commands.find((candidate) => candidate.name === name)
  if (!command) return null
  const args = (match[2] ?? '').trim()
  const words = args === '' ? [] : args.split(/\s+/)
  // Inside a shell marker a backtick in the arguments would end the marker's own code span.
  const substitute = (part: string): string =>
    part.replace(/\$ARGUMENTS|\$([1-9])(?!\d)/g, (_token, n: string | undefined) => (n ? (words[Number(n) - 1] ?? '') : args).replaceAll('`', "'"))
  let body = command.template.replace(TEMPLATE_TOKEN, (_token, shell: string | undefined, n: string | undefined) => {
    if (shell !== undefined) return shellMarker(substitute(shell))
    return n ? (words[Number(n) - 1] ?? '') : args
  })
  if (args !== '' && !HAS_PLACEHOLDER.test(command.template)) body = `${body.trimEnd()}\n\nARGUMENTS: ${args}`
  const head = `The user ran the command /${command.name}. Follow its instructions:`
  const lead = HAS_SHELL.test(command.template) ? `\n\n${SHELL_LEAD_IN}` : ''
  return `${head}${lead}\n\n${body.trim()}`
}
