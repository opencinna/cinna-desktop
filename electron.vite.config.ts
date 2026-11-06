import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Main and preload externalize their dependencies by default since electron-vite 6
// (`build.externalizeDeps`, default true), so neither lists a plugin for it.
export default defineConfig({
  main: {},
  preload: {
    build: {
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].mjs'
        }
      }
    }
  },
  renderer: {
    server: {
      port: 5184
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rolldownOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          trayPanel: resolve('src/renderer/trayPanel.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
