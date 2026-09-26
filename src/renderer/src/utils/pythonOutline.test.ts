import { describe, expect, it } from 'vitest'
import { pythonOutline } from './pythonOutline'

const SOURCE = `"""Module doc.

def not_listed():
"""
import os

LIMIT = 3


@dataclass
class Model:
    """A model.

    def also_not_listed(self): ...
    """

    size: int = 0

    def fit(self, x):
        def inner():
            pass
        return inner

    @property
    async def ready(self):
        return True

    class Config:
        def nested_method(self): ...


async def main():
    '''Run.'''
    return Model()

# class Commented:
class Empty: pass
`

describe('pythonOutline', () => {
  it('lists top-level functions and classes, and each class its own methods', () => {
    const { entries, show } = pythonOutline(SOURCE)
    expect(entries).toEqual([
      { depth: 1, text: 'Model', line: 11 },
      { depth: 2, text: 'fit()', line: 19 },
      { depth: 2, text: 'ready()', line: 25 },
      { depth: 1, text: 'main()', line: 32 },
      { depth: 1, text: 'Empty', line: 37 }
    ])
    expect(show).toBe(true)
  })

  it('offers no panel for a file with a single definition', () => {
    expect(pythonOutline('def only():\n    pass\n').show).toBe(false)
    expect(pythonOutline('print("hi")\n').entries).toEqual([])
  })
})
