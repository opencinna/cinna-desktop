'use strict'

// Loaded with `--require` into every ELECTRON_RUN_AS_NODE child
// (runtimeHost.nodeRuntime): honours the extra CA file, which the packaged
// app's NodeOptions fuse makes Electron ignore and delete from process.env.
// The path arrives as CINNA_EXTRA_CA_CERTS. See extra-ca.cjs. Never throws.
try {
  const { applyExtraCaCertificates, extraCaFile } = require('./extra-ca.cjs')
  applyExtraCaCertificates(process.env, (message) => {
    process.stderr.write(`Warning: ${message}\n`)
  })
  // Put the real name back for what this child spawns (the Claude and Codex
  // CLIs, MCP servers), which are not Electron and read it themselves.
  const file = extraCaFile(process.env)
  if (file && !process.env.NODE_EXTRA_CA_CERTS) process.env.NODE_EXTRA_CA_CERTS = file
} catch {
  // Nothing here may stop the child from starting.
}
