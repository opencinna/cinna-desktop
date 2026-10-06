/**
 * The wire-only turn context `runExecutionService` puts in front of a prompt to
 * an agent that runs in a folder (`threadContextService.buildTurnHeader`): the
 * Cinna Task Protocol's context block.
 * Splits it off the prompt so a spec can compare the prompt itself exactly;
 * throws when the header is missing or has a different shape, so a spec using
 * this also fails when the header regresses.
 */
const TURN_HEADER = new RegExp(
  '^Cinna task context \\(not part of the conversation\\):\\n' +
    '- here: Cinna Desktop, folder agent `([^`\\n]+)` · chat `([^`\\n]+)`\\n' +
    '- current task: (?:`([^`\\n]+)` "(?:[^"\\\\\\n]|\\\\.)*" \\(report required: (?:yes|no)\\)|none)\\n' +
    // The counts line, present only while one of them is nonzero, in this order.
    '(?:- (?=[a-z])(?:chain depth: (\\d+))?(?:(?: · )?open delegations: \\d+(?: \\(\\d+ waiting on the user\\))?)?(?:(?: · )?ready tasks: \\d+)?\\n)?' +
    '(?:- tasks skill: [^\\n]+\\n)?' +
    '\\n'
)

export interface TurnWire {
  agentId: string
  chatId: string
  taskId: string | null
  /** The chain depth; 0 when the header has no `chain depth` (it is left out at 0). */
  depth: number
  /** Everything after the header, byte for byte. */
  prompt: string
}

export function splitTurnHeader(wire: string): TurnWire {
  const match = TURN_HEADER.exec(wire)
  if (!match) throw new Error(`Expected a turn-context header in front of the prompt, got: ${JSON.stringify(wire.slice(0, 200))}`)
  return { agentId: match[1], chatId: match[2], taskId: match[3] ?? null, depth: Number(match[4] ?? 0), prompt: wire.slice(match[0].length) }
}
