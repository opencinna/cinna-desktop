/** Read a terminal marker from the actual assistant answer, never fallback parts. */
export function readHandbackNote(answer: string): string | null {
  const lines = answer.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const last = lines.pop()
  if (!last || !last.startsWith('/handback ')) return null
  const note = last.slice('/handback '.length).trim()
  if (!note || note.length > 4000) return null
  let fence: { character: string; length: number } | null = null
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!marker) continue
    if (!fence) {
      if (marker[1][0] === '`' && marker[2].includes('`')) continue
      fence = { character: marker[1][0], length: marker[1].length }
    } else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) {
      fence = null
    }
  }
  return fence ? null : note
}
