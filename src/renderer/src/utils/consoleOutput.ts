/** Peel transport fences only when they enclose the entire terminal payload. */
export function unwrapConsoleOutput(content: string, streaming = false): string {
  let value = content
  for (let depth = 0; depth < 8; depth++) {
    const lines = value.trim().split(/\r?\n/)
    const opening = /^(`{3,}|~{3,})[ \t]*(?:console|text|plaintext|output)?[ \t]*$/i.exec(lines[0])
    if (!opening) break
    const fence = opening[1]
    const closing = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`)
    const closeIndex = lines.findIndex((line, index) => index > 0 && closing.test(line))
    if (closeIndex === lines.length - 1 && closeIndex > 0) {
      value = lines.slice(1, -1).join('\n')
    } else if (streaming && closeIndex === -1) {
      value = lines.slice(1).join('\n')
    } else break
  }
  return value
}
