/** Recognize shell calls from structured arguments, never from assistant prose. */
export function cinnaCliCommand(name?: string, input?: Record<string, unknown>): string | null {
  if (!name || !/^(bash|shell|shell_command|exec_command|run_shell_command)$/i.test(name)) return null
  const command = input?.command ?? input?.cmd
  return typeof command === 'string' && /^\s*cinna(?:\s|$)/.test(command)
    ? command.trim()
    : null
}

interface CliPart {
  kind: string
  toolId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  commandInvocation?: string
}

/** IDs own results, including separate stdout/stderr; adjacency is not evidence. */
export function pairCinnaCliTools(items: CliPart[]): {
  calls: Map<number, { command: string; resultIndices: number[] }>
  consumed: Set<number>
} {
  const calls = new Map<number, { command: string; resultIndices: number[] }>()
  const owners = new Map<string, number>()
  const consumed = new Set<number>()
  items.forEach((item, index) => {
    if (item.kind === 'tool') {
      if (item.toolId) owners.delete(item.toolId)
      const command = !item.commandInvocation && cinnaCliCommand(item.toolName, item.toolInput)
      if (!command) return
      calls.set(index, { command, resultIndices: [] })
      if (item.toolId) owners.set(item.toolId, index)
    } else if (item.kind === 'tool_result' && item.toolId) {
      const owner = owners.get(item.toolId)
      if (owner === undefined) return
      calls.get(owner)!.resultIndices.push(index)
      consumed.add(index)
    }
  })
  return { calls, consumed }
}
