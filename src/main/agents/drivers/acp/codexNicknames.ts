/**
 * Names for Codex subagents. Codex gives each subagent a nickname of its own,
 * but no role or nickname reaches the ACP wire (codex-acp 2.2.2), so Cinna
 * makes one up in the same spirit: "[Adjective] [Colour] [Animal]".
 *
 * The name is derived from the child's thread id alone, never from chance, so
 * the same subagent has the same name live, on every later run, in the saved
 * transcript and after a restart. Two siblings sharing all three words is
 * possible but unlikely (30³ names).
 */

const ADJECTIVES = [
  'Brave', 'Calm', 'Clever', 'Swift', 'Gentle', 'Bold', 'Bright', 'Quiet', 'Eager', 'Keen',
  'Nimble', 'Steady', 'Witty', 'Jolly', 'Lucky', 'Merry', 'Noble', 'Patient', 'Proud', 'Quick',
  'Sunny', 'Tidy', 'Wise', 'Zesty', 'Cheerful', 'Curious', 'Daring', 'Fearless', 'Lively', 'Polite'
] as const

const COLOURS = [
  'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Brown', 'Gray', 'Teal',
  'Navy', 'Olive', 'Maroon', 'Coral', 'Gold', 'Silver', 'Indigo', 'Violet', 'Lime', 'Cyan',
  'Amber', 'Beige', 'Crimson', 'Turquoise', 'Lavender', 'Magenta', 'Ivory', 'Peach', 'Tan', 'Plum'
] as const

const ANIMALS = [
  'Otter', 'Fox', 'Badger', 'Heron', 'Falcon', 'Owl', 'Beaver', 'Rabbit', 'Deer', 'Lynx',
  'Panda', 'Koala', 'Dolphin', 'Seal', 'Penguin', 'Turtle', 'Sparrow', 'Robin', 'Finch', 'Wolf',
  'Bear', 'Hare', 'Moose', 'Bison', 'Crane', 'Gecko', 'Salmon', 'Walrus', 'Lemur', 'Yak'
] as const

/** FNV-1a, 32 bit: stable across runs and platforms. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** A Codex subagent's name, from its thread id: e.g. "Brave Teal Otter". */
export function codexNickname(threadId: string): string {
  let h = hash(threadId)
  const adjective = ADJECTIVES[h % ADJECTIVES.length]
  h = Math.floor(h / ADJECTIVES.length)
  const colour = COLOURS[h % COLOURS.length]
  h = Math.floor(h / COLOURS.length)
  const animal = ANIMALS[h % ANIMALS.length]
  return `${adjective} ${colour} ${animal}`
}
