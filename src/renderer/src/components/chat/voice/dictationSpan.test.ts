import { describe, expect, it } from 'vitest'
import { commitFinal, commonPrefixLength, dictatedText, dictationGoal, displayTyped, editOntoGoal, keystrokesBetween, startSpan, typeToward } from './dictationSpan'

describe('startSpan', () => {
  it('sits at the caret, or holds a selection to replace', () => {
    expect(startSpan(3, 3, 10)).toEqual({ origin: 3, at: 3, replace: null })
    expect(startSpan(6, 2, 10)).toEqual({ origin: 2, at: 2, replace: { from: 2, to: 6 } })
    expect(startSpan(40, 40, 10)).toEqual({ origin: 10, at: 10, replace: null })
  })
})

describe('commitFinal', () => {
  it('appends to an empty draft without spaces', () => {
    expect(commitFinal('', startSpan(0, 0, 0), ' Hello there. ')).toEqual({ draft: 'Hello there.', span: { origin: 0, at: 12, replace: null } })
  })

  it('adds a space after a word and keeps growing at the same place', () => {
    let state = commitFinal('Note:', startSpan(5, 5, 5), 'first part.')
    expect(state.draft).toBe('Note: first part.')
    state = commitFinal(state.draft, state.span, 'Second part.')
    expect(state.draft).toBe('Note: first part. Second part.')
    expect(state.span.at).toBe(state.draft.length)
  })

  it('inserts mid-draft with a space on both sides of words', () => {
    const draft = 'before after'
    let state = commitFinal(draft, startSpan(6, 6, draft.length), 'middle')
    expect(state.draft).toBe('before middle after')
    state = commitFinal(state.draft, state.span, 'more')
    expect(state.draft).toBe('before middle more after')
  })

  it('needs no space before punctuation that follows', () => {
    expect(commitFinal('Say,', startSpan(3, 3, 4), 'hello').draft).toBe('Say hello,')
  })

  it('replaces a selection with the first words only', () => {
    const draft = 'keep REPLACE keep'
    let state = commitFinal(draft, startSpan(5, 12, draft.length), 'new words')
    expect(state.draft).toBe('keep new words keep')
    state = commitFinal(state.draft, state.span, 'again')
    expect(state.draft).toBe('keep new words again keep')
  })

  it('changes nothing for blank text', () => {
    const span = startSpan(1, 3, 5)
    expect(commitFinal('abcde', span, '  ')).toEqual({ draft: 'abcde', span })
  })

  it('clamps a span past a draft that shrank', () => {
    expect(commitFinal('ab', { origin: 10, at: 10, replace: null }, 'c').draft).toBe('ab c')
  })
})

describe('the confirmed text of a dictation', () => {
  it('starts after the space put before the first words and grows with each final', () => {
    let state = commitFinal('Note:', startSpan(5, 5, 5), 'first part.')
    expect(state.span.origin).toBe(6)
    state = commitFinal(state.draft, state.span, 'Second.')
    expect(dictatedText(state.draft, state.span)).toBe('first part. Second.')
  })

  it('reads the confirmed text, then the partial', () => {
    expect(dictationGoal('', ' hi ')).toBe('hi')
    expect(dictationGoal('Done.', '')).toBe('Done.')
    expect(dictationGoal('Done.', 'and more')).toBe('Done. and more')
  })
})

describe('displayTyped', () => {
  it('shows the typed text in place of the confirmed text', () => {
    const state = commitFinal('before after', startSpan(6, 6, 12), 'middle words')
    expect(state.draft).toBe('before middle words after')
    const view = displayTyped(state.draft, state.span, 'middle wo')
    expect(view.value).toBe('before middle wo after')
    expect(view.value.slice(view.start, view.end)).toBe('middle wo')
  })

  it('shows a first partial at the caret before any final', () => {
    const view = displayTyped('Hi there', startSpan(2, 2, 8), 'you')
    expect(view.value).toBe('Hi you there')
    expect(view.value.slice(view.start, view.end)).toBe('you')
  })

  it('shows the selection it will replace until typing starts, then replaces it', () => {
    const span = startSpan(5, 12, 17)
    expect(displayTyped('keep REPLACE keep', span, '').value).toBe('keep REPLACE keep')
    expect(displayTyped('keep REPLACE keep', span, 'n').value).toBe('keep n keep')
  })

  it('matches the draft once typing has caught up, so the end of a dictation changes nothing on screen', () => {
    const state = commitFinal('one two', startSpan(3, 3, 7), 'and a half')
    expect(displayTyped(state.draft, state.span, 'and a half').value).toBe(state.draft)
  })
})

describe('typing toward the recognizer', () => {
  it('types letter by letter', () => {
    expect(typeToward('', 'hello', 1)).toBe('h')
    expect(typeToward('he', 'hello', 2)).toBe('hell')
    expect(typeToward('he', 'hello', 10)).toBe('hello')
  })

  it('backspaces a revision to where it agrees, then retypes', () => {
    // "recognition be" → "recognition behaves": nothing to delete.
    expect(typeToward('recognition be', 'recognition behaves', 1)).toBe('recognition beh')
    // "how's stream" → "how stream": back to "how", then type.
    expect(typeToward("how's stream", 'how stream', 9)).toBe('how')
    expect(typeToward("how's stream", 'how stream', 10)).toBe('how ')
    expect(keystrokesBetween("how's stream", 'how stream')).toBe(9 + 7)
  })

  it('swaps a deep revision in place, then types what is new', () => {
    const shown = 'a'.repeat(40) + ' tail'
    const target = 'b' + 'a'.repeat(39) + ' tail and more'
    expect(typeToward(shown, target, 0)).toBe(target.slice(0, shown.length))
    expect(keystrokesBetween(shown, target)).toBe(' and more'.length)
  })

  it('counts the shared start', () => {
    expect(commonPrefixLength('abcd', 'abxy')).toBe(2)
    expect(commonPrefixLength('', 'a')).toBe(0)
  })
})

describe('editOntoGoal', () => {
  // "Before " + dictation + " after", the dictation confirmed in the draft.
  const draft = 'Before Hello there friend. after'
  const span = { origin: 7, at: 26, replace: null }
  const goal = 'Hello there friend.'
  const full = displayTyped(draft, span, goal)
  const shownOf = (typed: string) => displayTyped(draft, span, typed)
  const key = (typed: string, edited: string, caret: number) => editOntoGoal(shownOf(typed), edited, caret, full, typed, goal)

  it('puts a key at the end after the words still typing out', () => {
    const shown = shownOf('Hello th')
    expect(shown.value).toBe('Before Hello th after')
    expect(key('Hello th', 'Before Hello thX after', 16)).toEqual({ value: 'Before Hello there friend.X after', caret: 27 })
  })

  it('keeps the confirmed words when nothing is typed out yet', () => {
    expect(key('', 'Before X after', 8)).toEqual({ value: 'Before Hello there friend.X after', caret: 27 })
  })

  it('takes a backspace at the end from the whole text', () => {
    expect(key('Hello th', 'Before Hello t after', 14)).toEqual({ value: 'Before Hello there friend after', caret: 25 })
  })

  it('leaves an edit before the dictation where it was', () => {
    expect(key('Hello th', 'BeforeX Hello th after', 7)).toEqual({ value: 'BeforeX Hello there friend. after', caret: 7 })
  })

  it('moves an edit after the dictation with its end', () => {
    expect(key('Hello th', 'Before Hello th afterX', 22)).toEqual({ value: 'Before Hello there friend. afterX', caret: 33 })
  })

  it('keeps an edit inside the typed text in place', () => {
    expect(key('Hello th', 'Before HelXlo th after', 11)).toEqual({ value: 'Before HelXlo there friend. after', caret: 11 })
  })

  it('gives up on an edit inside text still being revised', () => {
    // "Hello txy" agrees with the goal up to "Hello t"; a key between x and y lands in the revision.
    expect(editOntoGoal(shownOf('Hello txy'), 'Before Hello txZy after', 16, full, 'Hello txy', goal)).toBeNull()
  })
})
