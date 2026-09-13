const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, relative, resolve, sep } = require('node:path')

// These are the app-owned entry points executed with ELECTRON_RUN_AS_NODE.
const CHILD_PACKAGES = [
  '@agentclientprotocol/claude-agent-acp',
  '@agentclientprotocol/codex-acp'
]

// Both launchers require the user's CLI. Keep these aligned with the files
// exclusions in electron-builder.yml; never unpack bundled CLI binaries.
function isExternalCli(name) {
  return name.startsWith('@anthropic-ai/claude-agent-sdk-') || name.startsWith('@openai/codex')
}

function findPackage(root, from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root) return null
    if (dirname(dir) === dir) throw new Error(`Package lookup escaped ${root}`)
  }
}

// Follow the installed layout, including nested versions and peers. Reading
// manifests directly also works for packages that hide package.json in exports.
// Resolution stops at the app root: global/developer packages cannot satisfy it.
function runtimePackages(appDir, roots = CHILD_PACKAGES) {
  const root = resolve(appDir)
  const visited = new Set()
  function visit(name, from, optional = false) {
    if (isExternalCli(name)) return
    const directory = findPackage(root, from, name)
    if (!directory) {
      if (optional) return
      throw new Error(`Missing runtime dependency ${name}, required from ${from}`)
    }
    if (visited.has(directory)) return
    visited.add(directory)
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const deps = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const dependency of Object.keys(deps)) {
      const optionalDependency = Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)
      const optionalPeer = !Object.hasOwn(pkg.dependencies ?? {}, dependency) &&
        pkg.peerDependenciesMeta?.[dependency]?.optional === true
      visit(dependency, directory, optionalDependency || optionalPeer)
    }
  }
  roots.forEach((name) => visit(name, root))
  return [...visited].map((directory) => relative(root, directory).split(sep).join('/')).sort()
}

function beforePack({ packager }) {
  // electron-builder may hoist a nested dependency while collecting production
  // packages. Match package names at every depth, not only npm's source paths.
  const patterns = runtimePackages(packager.info.appDir).map((directory) => {
    const name = directory.slice(directory.lastIndexOf('node_modules/') + 'node_modules/'.length)
    return `**/node_modules/${name}/**`
  })
  const existing = packager.config.asarUnpack ?? []
  packager.config.asarUnpack = [...new Set([
    ...(Array.isArray(existing) ? existing : [existing]), ...patterns
  ])]
}

function afterPack({ packager, appOutDir }) {
  // Runs for every target, including cross-builds, before signing/publishing.
  // Fail the build if file filtering or dependency collection lost a package.
  const unpacked = join(packager.getResourcesDir(appOutDir), 'app.asar.unpacked')
  const packages = runtimePackages(unpacked)
  console.log(`Verified ${packages.length} unpacked ACP runtime packages`)
}

module.exports = { runtimePackages, beforePack, afterPack }
