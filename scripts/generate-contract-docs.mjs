// Generate the interface-contract docs from their registries.
//
//   npm run contract:docs            write the docs
//   npm run contract:docs -- --check exit 1 if a doc is stale (what the ratchet in `npm test` also checks)
//
// The registry is the source; the doc is a view of it. Rendering lives in
// src/main/agents/drivers/acp/contracts/contractDocs.ts so the ratchet compares
// against exactly what this would write.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../src/shared/runtimePins.ts'
import { CODEX_CONTRACT, CODEX_CONTRACT_AREAS } from '../src/main/agents/drivers/acp/contracts/codex.contract.ts'
import { CODEX_INTERFACE_DOC, codexContractDocInput, renderContractDoc } from '../src/main/agents/drivers/acp/contracts/contractDocs.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const docs = [[CODEX_INTERFACE_DOC, renderContractDoc(codexContractDocInput(RUNTIME_PINS, CODEX_CONTRACT, CODEX_CONTRACT_AREAS))]]

let stale = false
for (const [path, content] of docs) {
  const file = join(repo, path)
  let current = null
  try { current = readFileSync(file, 'utf8') } catch { /* not generated yet */ }
  if (current === content) { console.log(`up to date: ${path}`); continue }
  if (check) { console.error(`STALE: ${path} — run \`npm run contract:docs\``); stale = true; continue }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  console.log(`wrote: ${path}`)
}
if (stale) process.exit(1)
