import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * Setup for the `renderer` vitest project (see `vitest.config.ts`).
 *
 * Testing Library only registers its own afterEach cleanup when vitest's
 * globals are on, and they are not — so unmounting is ours to do. Without it a
 * hook under test keeps its effects (and its autosave timer) alive into the
 * next test in the file.
 */
afterEach(() => {
  cleanup()
})
