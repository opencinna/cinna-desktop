import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseScriptSpec } from '../../../../shared/scriptSpec'
import { editCommand, readCommand, type ScriptValues } from '../../../../shared/scriptArgs'
import { RunScriptForm } from './RunScriptForm'

/**
 * The form's switch for a `--x/--no-x` option (click, typer): one switch
 * showing the effective value, its default included, toggled to the value
 * the window writes back to the line.
 */

const TYPER_PY = `import typer


def main(scope: str, cache: bool = True, apply: bool = False):
    pass


typer.run(main)
`

function mount(line: string): { onChange: ReturnType<typeof vi.fn> } {
  const spec = parseScriptSpec(TYPER_PY, { script: 'sync.py' })!
  const form = readCommand(spec, line)!
  const onChange = vi.fn()
  render(
    <RunScriptForm spec={spec} values={form.values} other={form.other} readOnly={false} handEdited={false}
      scriptName="sync.py" onChange={onChange} onChoosePath={async () => null} />
  )
  return { onChange }
}

describe('RunScriptForm: a --x/--no-x switch', () => {
  it('shows a switch declared on as on while the line names neither flag, and off once it says --no-x', () => {
    mount('python3 sync.py it')
    expect(screen.getByRole('switch', { name: 'Cache' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Apply' }).getAttribute('aria-checked')).toBe('false')
  })

  it('reads --no-x off the line', () => {
    mount('python3 sync.py it --no-cache')
    expect(screen.getByRole('switch', { name: 'Cache' }).getAttribute('aria-checked')).toBe('false')
  })

  it('toggles to the opposite of the effective value, which the window writes as --no-x', () => {
    const { onChange } = mount('python3 sync.py it')
    fireEvent.click(screen.getByRole('switch', { name: 'Cache' }))
    const [values] = onChange.mock.calls[0] as [ScriptValues, string]
    expect(values.cache).toBe(false)
    const spec = parseScriptSpec(TYPER_PY, { script: 'sync.py' })!
    expect(editCommand(spec, 'python3 sync.py it', values, '')).toBe('python3 sync.py it --no-cache')
  })

  it('gives a switch with no help a tip saying its default, so one already on is explained', () => {
    mount('python3 sync.py it')
    expect(screen.getByRole('button', { name: 'About Cache' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'About Apply' })).toBeTruthy()
  })
})
