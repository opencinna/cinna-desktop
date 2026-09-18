// The newest published version of a runtime CLI, beside the pin — the first half
// of the weekly manual compatibility check
// (docs/development/runtime_pins/runtime_pins_llm.md). Changes nothing.
//
//   node --experimental-strip-types scripts/runtime-compat.mjs latest <codex|claude>
//     Prints `pin=<x>`, `latest=<y>` and `changed=true|false`. Codex: the highest
//     non-prerelease `rust-v<x.y.z>` release of openai/codex (GITHUB_TOKEN, when
//     set, only lifts the API rate limit). Claude: the `latest` file of the
//     release bucket the pinned asset URLs name.
//
// When `changed=true`: make contract-next ENGINE=<engine> VERSION=<latest>
import { RUNTIME_PINS } from '../src/shared/runtimePins.ts'

const [command, engine] = process.argv.slice(2)
const usage = () => {
  console.error('usage: runtime-compat.mjs latest <codex|claude>')
  process.exit(2)
}
if (engine !== 'codex' && engine !== 'claude') usage()
const pin = RUNTIME_PINS[engine]

const numeric = (version) => version.split('.').map(Number)
const newer = (a, b) => { const x = numeric(a), y = numeric(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }

async function latestCodex() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cinna-desktop-runtime-compat' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch('https://api.github.com/repos/openai/codex/releases?per_page=100', { headers })
  if (!response.ok) throw new Error(`GitHub releases: HTTP ${response.status}`)
  // Sorted here, not trusted from the API's order: alphas of the next version are published between stables.
  const versions = (await response.json())
    .filter((release) => !release.prerelease && !release.draft)
    .map((release) => /^rust-v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1])
    .filter(Boolean)
    .sort(newer)
  if (versions.length === 0) throw new Error('no stable rust-v release among the newest 100')
  return versions.at(-1)
}

async function latestClaude() {
  const url = Object.values(pin.assets)[0].url
  const at = url.indexOf(`/${pin.cli}/`)
  if (at < 0) throw new Error('the pinned Claude asset URL no longer contains its version; update latestClaude')
  const response = await fetch(`${url.slice(0, at)}/latest`)
  if (!response.ok) throw new Error(`release bucket latest: HTTP ${response.status}`)
  const version = (await response.text()).trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`release bucket latest is not a version: ${version.slice(0, 40)}`)
  return version
}

if (command === 'latest') {
  const latest = engine === 'codex' ? await latestCodex() : await latestClaude()
  console.log(`pin=${pin.cli}\nlatest=${latest}\nchanged=${latest !== pin.cli}`)
} else usage()
