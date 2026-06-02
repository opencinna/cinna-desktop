import { defineConfig } from 'vitest/config'

/**
 * Unit tests run in a plain Node environment over the pure (Electron- and
 * SQLite-free) modules — sync identity normalizers, the canonical-JSON
 * serializer, and the byte-stability of a job's portable dependency manifest
 * across a sync round trip. Anything that touches `getDb()` / Electron is left
 * to manual/integration testing.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
