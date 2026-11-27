import { describe, expect, it } from 'vitest'
import { catalogShownVersion, catalogVersionLabel } from './catalogItems'

describe('catalogShownVersion', () => {
  it('shows the publisher label alone as vX, never doubling a leading v', () => {
    expect(catalogShownVersion(7, '1.6')).toBe('v1.6')
    expect(catalogShownVersion(7, ' v1.6 ')).toBe('v1.6')
    expect(catalogShownVersion(7, 'V2.0')).toBe('v2.0')
    expect(catalogShownVersion(7, 'beta')).toBe('beta')
  })

  it('falls back to Version N without a label', () => {
    expect(catalogShownVersion(7, null)).toBe('Version 7')
    expect(catalogShownVersion(7, '  ')).toBe('Version 7')
  })

  it('leaves catalogVersionLabel, which skills and the Inbox use, as it was', () => {
    expect(catalogVersionLabel(7, '1.6')).toBe('Version 7 (1.6)')
  })
})
