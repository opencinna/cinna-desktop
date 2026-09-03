import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Two projects, split by where the file lives rather than by what it is named.
 *
 * `main` is the original suite: plain Node over the pure (Electron- and
 * SQLite-free) modules — sync identity normalizers, the canonical-JSON
 * serializer, the byte-stability of a job's portable dependency manifest.
 * Anything that touches `getDb()` / Electron is left to manual/integration
 * testing. It is the default: a test file anywhere outside `src/renderer` runs
 * here, under `node`, and pays nothing for the DOM.
 *
 * `renderer` is the carve-out — `src/renderer/**` — and is the only project
 * that loads jsdom, so React hooks and components can be rendered. `.tsx` is in
 * its include; the root config's `src/**\/*.test.ts` never was, so before this
 * split a renderer component test was not even collected.
 *
 * `test.projects` rather than the older `environmentMatchGlobs`: the latter is
 * deprecated in vitest 3 and only switches the environment, while a project
 * carries its own plugins and setup files — the renderer needs the React plugin
 * for JSX and a setup file to unmount between tests, and neither belongs in the
 * main-process runs.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Replaces vitest's default exclude list, hence node_modules here.
          exclude: ['**/node_modules/**', 'src/renderer/**']
        }
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@renderer': resolve('src/renderer/src')
          }
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/renderer/src/test/setup.ts']
        }
      }
    ]
  }
})
