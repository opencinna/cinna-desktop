/**
 * The wire-only turn context `runExecutionService` puts in front of a prompt to
 * an agent that runs in a folder (`threadContextService.buildTurnHeader`).
 * Splits it off the prompt so a spec can compare the prompt itself exactly;
 * throws when the header is missing or has a different shape, so a spec using
 * this also fails when the header regresses.
 */
const TURN_HEADER = new RegExp(
  '^Turn context from Cinna Desktop, not part of the conversation:\\n' +
    '- chat id: `([^`\\n]+)`\\n' +
    '- task id: (?:`([^`\\n]+)`|none)\\n' +
    '- handover depth: (\\d+)\\n\\n'
)

export interface TurnWire {
  chatId: string
  taskId: string | null
  depth: number
  /** Everything after the header, byte for byte. */
  prompt: string
}

export function splitTurnHeader(wire: string): TurnWire {
  const match = TURN_HEADER.exec(wire)
  if (!match) throw new Error(`Expected a turn-context header in front of the prompt, got: ${JSON.stringify(wire.slice(0, 200))}`)
  return { chatId: match[1], taskId: match[2] ?? null, depth: Number(match[3]), prompt: wire.slice(match[0].length) }
}
