/** Test support only: nothing in `src/main` imports this at runtime. */

/**
 * The fake backend against a stand-in cinna-vaultd: a few lines of Node that
 * speak the hello line and JSON-RPC on the unix socket it is told to listen
 * on, and echo an attached stream. It is spawned exactly the way the real
 * bundle is (`nodeRuntime` + script + flags), so the spawn, the socket wait
 * and the state machine are what is tested here; vaultd itself has its own.
 */
export const STUB_VAULTD = `
const net = require('node:net')
const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
const listen = flag('--listen')
const journals = {}
net.createServer((socket) => {
  let buffered = ''
  let mode = null
  socket.on('data', (chunk) => {
    if (mode === 'attach') { socket.write(chunk); return }
    buffered += chunk.toString('utf8')
    let nl
    while ((nl = buffered.indexOf('\\n')) >= 0) {
      const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1)
      if (mode === null) {
        const hello = JSON.parse(line)
        mode = hello.type
        if (mode === 'attach') { socket.write('attached:' + hello.stream + '\\n'); if (buffered) { socket.write(buffered); buffered = '' } return }
        continue
      }
      const req = JSON.parse(line)
      let result
      if (req.method === 'hello') result = { protocol: 1, image: { version: 'fake', node: process.version, uv: '' }, layoutReady: true, fake: true, vaultId: flag('--vault-id'), key: flag('--approval-key').length }
      else if (req.method === 'transcript.append') { (journals[req.params.chatId] ||= []).push(...req.params.ops); result = {} }
      else if (req.method === 'transcript.read') result = { ops: journals[req.params.chatId] || [] }
      else { socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no such method', data: { code: 'invalid' } } }) + '\\n'); continue }
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n')
    }
  })
}).listen(listen)
`
