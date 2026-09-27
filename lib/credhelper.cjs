#!/usr/bin/env node
'use strict'
// dsh-git — the git credential helper.
//
// Git invokes this as `!node <this file> --socket <path> <operation>`, where
// the operation is `get`, `store`, or `erase`. Only `get` is served, and it is
// served by relaying to the host plugin's socket, so the token is read from the
// sealed record inside the running harness and never lands in a file git can
// read, in an argument list, or in this process's environment.
//
// `store` and `erase` deliberately do nothing: honouring them would let git
// write the token to its own storage, which is exactly what this design avoids.
//
// Nothing available means exit 0 with an empty stdout — the protocol-correct
// way to say "this helper has no credential for that host", which lets git try
// its next helper or fall back to prompting. The reason is written to stderr.
const { connect } = require('node:net')

const USAGE = 'dsh-git helper: no socket configured — reinstall the helper from Settings'
/** Read `--flag value` from argv. */
function flag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] || null
}

// The socket path has exactly one source: the `--socket` argument the plugin
// wrote into git config beside this file's own path. No environment fallback --
// a second source would be a second thing to keep secret and in sync.
const socketPath = flag('--socket')
const operation = process.argv[process.argv.length - 1]

if (operation === 'store' || operation === 'erase') process.exit(0)
if (operation !== 'get') process.exit(0)
if (socketPath === null) {
  process.stderr.write(USAGE + '\n')
  process.exit(0)
}

let request = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { request += chunk })
process.stdin.on('error', () => process.exit(0))
process.stdin.on('end', () => {
  const payload = request.trim() === '' ? request : request.replace(/\n*$/, '\n')
  const answer = []
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(payload + '\n'))
  socket.on('data', (chunk) => answer.push(chunk))
  socket.on('error', (error) => {
    process.stderr.write('dsh-git helper: ' + error.message + ' (is the harness running?)\n')
    process.exit(0)
  })
  socket.on('end', () => {
    const text = answer.join('')
    if (text.trim() === '') {
      process.stderr.write('dsh-git helper: no credential available (vault locked, or the host is not served)\n')
      process.exit(0)
    }
    process.stdout.write(text.replace(/\n*$/, '\n\n'))
    process.exit(0)
  })
})
