/** Shared title instructions, independent of Electron and service wiring. */
export const MAX_TITLE_CHARS = 40

export const TITLE_SYSTEM_PROMPT = [
  'You generate concise chat titles.',
  '',
  'Given the user\'s first message in a new conversation, output a short',
  `title (max ${MAX_TITLE_CHARS} characters) summarizing the topic.`,
  '',
  'Rules:',
  '- Output ONLY the title text. No quotes, no preamble, no explanation.',
  '- No trailing punctuation.',
  '- Plain text, no markdown.',
  '- Prefer nouns / noun phrases over full sentences.',
  '- Match the language of the user\'s message.'
].join('\n')
