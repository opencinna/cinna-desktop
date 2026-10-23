import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnswerQuestionsModal } from './AnswerQuestionsModal'
import type { AskQuestion } from '../../utils/askUserQuestion'

const Q1: AskQuestion = { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }
const Q2: AskQuestion = { question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }] }

function setup(questions: AskQuestion[], pending = false): ReturnType<typeof vi.fn> {
  const onSubmit = vi.fn()
  render(
    <AnswerQuestionsModal questions={questions} onSubmit={onSubmit} onClose={() => {}} pending={pending} />
  )
  return onSubmit
}

/** Picks "Other" on the first question and types `text` into its field. */
function typeCustom(text: string): HTMLElement {
  fireEvent.click(screen.getAllByText('Other (enter custom answer)')[0])
  const input = screen.getByPlaceholderText('Type your answer…')
  fireEvent.change(input, { target: { value: text } })
  return input
}

describe('AnswerQuestionsModal — Enter in the custom answer', () => {
  it('sends when the custom answer completes the last open question', () => {
    const onSubmit = setup([Q1])
    fireEvent.keyDown(typeCustom('Green'), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toContain('Green')
  })

  it('sends when the other questions were answered first', () => {
    const onSubmit = setup([Q1, Q2])
    fireEvent.click(screen.getByText('L'))
    fireEvent.keyDown(typeCustom('Green'), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does nothing while another question is unanswered', () => {
    const onSubmit = setup([Q1, Q2])
    fireEvent.keyDown(typeCustom('Green'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does nothing on blank text', () => {
    const onSubmit = setup([Q1])
    fireEvent.keyDown(typeCustom('   '), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['Shift', { shiftKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['a key repeat', { repeat: true }],
    ['an IME composition', { isComposing: true }],
    ['an IME keyCode 229', { keyCode: 229 }]
  ])('ignores Enter with %s', (_, init) => {
    const onSubmit = setup([Q1])
    fireEvent.keyDown(typeCustom('Green'), { key: 'Enter', ...init })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not send while a send is pending', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(
      <AnswerQuestionsModal questions={[Q1]} onSubmit={onSubmit} onClose={() => {}} />
    )
    const input = typeCustom('Green')
    rerender(<AnswerQuestionsModal questions={[Q1]} onSubmit={onSubmit} onClose={() => {}} pending />)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
