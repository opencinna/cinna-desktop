import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build as esbuild } from 'esbuild'
import type { Plugin } from 'vite'
import { ADAPTER_TAR_PATH, CODEX_ADAPTER_TAR_PATH, ensureClaudeAdapterTar, ensureCodexAdapterTar } from './src/main/vault/adapterTar'
import { RUNTIME_PINS } from './src/shared/runtimePins'

/**
 * cinna-vaultd, the Agent Vault guest daemon, bundled to one self-contained
 * out/main/vaultd.js. A separate esbuild pass after the main bundle rather
 * than an extra main input: an extra input shares chunks with main (both
 * import src/shared/vault/protocol.ts), and the guest needs a single file
 * with Node builtins only. ESM, like the rest of out/main (package.json has
 * `"type": "module"`); in the guest, without a package.json, Node 22 detects
 * the module syntax — the rootfs may also install it as `vaultd.mjs`.
 */
function vaultdBundle(): Plugin {
  return {
    name: 'cinna-vaultd-bundle',
    apply: 'build',
    async closeBundle() {
      await esbuild({
        entryPoints: [resolve('native/vault/guest/vaultd/src/main.ts')],
        outfile: resolve('out/main/vaultd.js'),
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        // Node builtins stay imports (platform node); the source imports nothing else but protocol.ts.
        legalComments: 'none',
        logLevel: 'warning'
      })
    }
  }
}

/**
 * The Agent Vault adapter tars (src/main/vault/adapterTar.ts), written once
 * from this checkout's node_modules to out/vault/claude-adapter.tar and
 * out/vault/codex-adapter.tar. The
 * packaged app ships it inside app.asar and streams that file into a vault,
 * rather than re-tarring its own app.asar.unpacked tree, which electron-builder
 * re-hoists and whose package.json files it rewrites. Its sha256 must equal
 * RUNTIME_PINS.claude.vaultAdapterTarSha256 / RUNTIME_PINS.codex.vaultAdapterTarSha256
 * (runtimeInstall.test.ts).
 */
function vaultAdapterTar(): Plugin {
  return {
    name: 'cinna-vault-adapter-tar',
    apply: 'build',
    async closeBundle() {
      // Skipped when out/ already holds the pinned tar for this closure.
      await ensureClaudeAdapterTar(resolve('.'), resolve(ADAPTER_TAR_PATH), RUNTIME_PINS.claude.vaultAdapterTarSha256)
      await ensureCodexAdapterTar(resolve('.'), resolve(CODEX_ADAPTER_TAR_PATH), RUNTIME_PINS.codex.vaultAdapterTarSha256)
    }
  }
}

// Main and preload externalize their dependencies by default since electron-vite 6
// (`build.externalizeDeps`, default true), so neither lists a plugin for it.
export default defineConfig({
  main: {
    plugins: [vaultdBundle(), vaultAdapterTar()]
  },
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
