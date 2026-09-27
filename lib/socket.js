// dsh-git — the credential socket.
//
// Git's credential-helper protocol is line-oriented and ends a request with a
// blank line:
//
//   protocol=https
//   host=github.com
//   <blank>
//
// The answer carries `username` and `password` and ends with a blank line. An
// empty answer means "this helper holds no credential for that host", which is
// how git is told to fall through to the next helper or prompt.
//
// The socket is the point of the whole plugin: a child process the model does
// not read (`git`, or the helper below) can obtain the token without the
// plaintext ever entering a tool result. It is bound to one owner-only path,
// answers for one host, and answers nothing while the vault is locked.
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

/** Maximum size of one request; anything larger is dropped rather than buffered. */
const MAX_REQUEST_BYTES = 4096

/**
 * Parse a credential-protocol request into its fields. Repeated keys keep the
 * first value, which is what git sends for the fields that matter here.
 * @param text - the raw request.
 * @returns the field map.
 */
export function parseCredentialRequest(text) {
  const fields = {}
  for (const line of String(text).split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    if (key.length > 0 && !Object.prototype.hasOwnProperty.call(fields, key)) fields[key] = value
  }
  return fields
}

/**
 * Build the answer for one request.
 * @param text - the raw request.
 * @param options - `host` to serve, `username` to report, `secret` to read the
 *   token (called per request, so a changed or locked vault is felt at once).
 * @returns the answer text, or `''` when this helper has nothing to say.
 */
export function answerCredentialRequest(text, options) {
  const fields = parseCredentialRequest(text)
  const host = String(options.host || 'github.com').toLowerCase()
  if (typeof fields.host !== 'string' || fields.host.toLowerCase() !== host) return ''
  const secret = options.secret()
  if (typeof secret !== 'string' || secret.length === 0) return ''
  const username =
    typeof fields.username === 'string' && fields.username.length > 0
      ? fields.username
      : String(options.username || 'x-access-token')
  return 'username=' + username + '\npassword=' + secret + '\n\n'
}

/**
 * Serve the credential protocol on a unix socket.
 * @param options - `socketPath` to bind, plus the {@link answerCredentialRequest}
 *   options and an optional `logger`.
 * @returns `{ start, stop, handle }`, where `handle` is the pure request
 *   handler, exposed so a test can drive the protocol without a socket.
 */
export function createCredentialSocket(options) {
  const { socketPath, logger } = options
  const handle = (text) => answerCredentialRequest(text, options)

  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let request = ''
    let answered = false
    const reply = (text) => {
      if (answered) return
      answered = true
      socket.end(text)
    }
    socket.on('data', (chunk) => {
      request += chunk
      if (request.length > MAX_REQUEST_BYTES) return reply('')
      // A request is complete at the first blank line.
      if (/\n\s*\n/.test(request) || /^\s*$/.test(request)) return reply(handle(request))
      return undefined
    })
    socket.on('end', () => reply(''))
    socket.on('error', () => {
      /* a client that hangs up is not an error here */
    })
  })

  const start = () => {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
    // A stale socket from a killed process would make listen() fail with
    // EADDRINUSE; removing it is safe because the path is ours.
    rmSync(socketPath, { force: true })
    server.on('error', (error) => {
      if (logger) logger.warn('credential socket error: %s', error && error.message)
    })
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600)
      } catch (error) {
        if (logger) logger.warn('could not tighten the socket mode: %s', error && error.message)
      }
    })
    return start
  }

  const stop = () => {
    try {
      server.close()
    } catch {
      /* already closed */
    }
    rmSync(socketPath, { force: true })
  }

  return { start, stop, handle }
}
