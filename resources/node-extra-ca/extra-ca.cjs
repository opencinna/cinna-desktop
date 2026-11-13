'use strict'

// NODE_EXTRA_CA_CERTS by hand. The packaged app turns the
// enableNodeOptionsEnvironmentVariable fuse off (electron-builder.yml), and
// with it Electron ignores NODE_EXTRA_CA_CERTS and deletes it from
// process.env, in the main process and in ELECTRON_RUN_AS_NODE children.
// Behind a TLS-inspecting proxy every Node fetch would then fail on the
// proxy's certificate. The main process recovers the value from the OS
// (extraCaRecovery.ts) and calls this at startup; Electron children get it as
// CINNA_EXTRA_CA_CERTS, a name Electron leaves alone, through
// `--require preload.cjs` (runtimeHost.nodeRuntime).
//
// Self-contained CommonJS: it runs as a preload before any app code, unpacked
// from app.asar. It must never throw (a throwing preload kills every child) and
// never print certificate contents; the file path is fine.

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

/** The PEM certificate blocks in `text`, with line endings normalised to LF. */
function splitPemCertificates(text) {
  if (typeof text !== 'string') return []
  return (text.match(PEM_BLOCK) || []).map((block) => block.replace(/\r\n?/g, '\n'))
}

function reason(error) {
  if (error && typeof error.code === 'string') return error.code
  return 'error'
}

/** The certificate file named by `env`: CINNA_EXTRA_CA_CERTS first, then NODE_EXTRA_CA_CERTS. */
function extraCaFile(env) {
  return (env && (env.CINNA_EXTRA_CA_CERTS || env.NODE_EXTRA_CA_CERTS)) || undefined
}

/**
 * Adds the certificates in the file `extraCaFile(env)` names to Node's default CA set.
 * Unset: does nothing and says nothing. Unreadable, empty or unusable: one
 * call to `warn`, worded like Node's own warning, and carries on. Returns how
 * many certificates were added.
 */
function applyExtraCaCertificates(env, warn, deps) {
  let file
  const say = (message) => {
    try { warn(message) } catch { /* a warning must not throw either */ }
  }
  try {
    file = extraCaFile(env)
    if (!file) return 0
    const fs = (deps && deps.fs) || require('node:fs')
    const tls = (deps && deps.tls) || require('node:tls')
    const X509Certificate = (deps && deps.X509Certificate) || require('node:crypto').X509Certificate
    if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') {
      say(`Ignoring extra certs from ${file}, load failed: this runtime cannot add CA certificates`)
      return 0
    }
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      say(`Ignoring extra certs from ${file}, load failed: ${reason(error)}`)
      return 0
    }
    const blocks = splitPemCertificates(text)
    const certs = blocks.filter((pem) => {
      try { new X509Certificate(pem); return true } catch { return false }
    })
    if (certs.length === 0) {
      say(`Ignoring extra certs from ${file}, load failed: no PEM certificates found`)
      return 0
    }
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...certs])
    if (certs.length < blocks.length) {
      say(`Some extra certs from ${file} were ignored: ${blocks.length - certs.length} of ${blocks.length} could not be parsed`)
    }
    return certs.length
  } catch (error) {
    say(`Ignoring extra certs from ${file}, load failed: ${reason(error)}`)
    return 0
  }
}

module.exports = { splitPemCertificates, applyExtraCaCertificates, extraCaFile }
