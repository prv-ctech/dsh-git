// The credential protocol, the socket, and the helper git actually runs.
//
// Nothing here needs the harness: `lib/socket.js` is pure node:net plus the
// protocol, and the helper is spawned as the child process git spawns it as.
//
//   node test/socket-check.cjs
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, statSync, rmSync, existsSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { connect } = require('node:net')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const HOME = mkdtempSync(join(tmpdir(), 'dsh-git-socket-'))
const HELPER = join(__dirname, '..', 'lib', 'credhelper.cjs')
const TOKEN = 'ghp_socket_check_0123456789abcdef'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (label, fn) => {
  try {
    const result = fn()
    if (result && typeof result.then === 'function')
      throw new Error('a check returned a promise; await it outside')
    checks.push([label, true, ''])
  } catch (error) {
    checks.push([label, false, error.message])
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    checks.push([label, true, ''])
  } catch (error) {
    checks.push([label, false, error.message])
  }
}

/** One client connection: write the request, read until the host closes. */
const ask = (socketPath, request) =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let answer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      answer += chunk
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(answer))
  })

/**
 * The helper, spawned exactly as git spawns it.
 *
 * Asynchronous on purpose: the socket server in this process has to keep
 * serving while the child talks to it, and `spawnSync` would block this event
 * loop — the child would wait for an answer nobody could send.
 */
const helper = (args, input, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [HELPER, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.on('error', (error) => resolve({ status: null, stdout, stderr: stderr + error.message }))
    child.stdin.end(input)
  })

;(async () => {
  const { parseCredentialRequest, answerCredentialRequest, createCredentialSocket } =
    await import('../lib/socket.js')

  // ---- the protocol --------------------------------------------------------
  check('a request splits into its fields', () => {
    const fields = parseCredentialRequest('protocol=https\nhost=github.com\n\n')
    assert.deepEqual(fields, { protocol: 'https', host: 'github.com' })
  })
  check('the first value of a repeated key wins', () => {
    assert.deepEqual(parseCredentialRequest('host=one\nhost=two\n'), { host: 'one' })
  })
  check('lines that are not assignments are ignored', () => {
    const fields = parseCredentialRequest('protocol=https\nnothing here\n=leading\n\n')
    assert.deepEqual(fields, { protocol: 'https' })
  })
  check('a value may contain an equals sign', () => {
    assert.deepEqual(parseCredentialRequest('password=a=b\n'), { password: 'a=b' })
  })

  const secret = () => TOKEN
  check('a matching host is answered with the credential', () => {
    assert.equal(
      answerCredentialRequest('protocol=https\nhost=github.com\n\n', {
        host: 'github.com',
        username: 'x-access-token',
        secret,
      }),
      'username=x-access-token\npassword=' + TOKEN + '\n\n',
    )
  })
  check('host matching ignores case', () => {
    const answer = answerCredentialRequest('host=GitHub.COM\n', {
      host: 'github.com',
      username: 'x-access-token',
      secret,
    })
    assert.equal(answer, 'username=x-access-token\npassword=' + TOKEN + '\n\n')
  })
  check('another host is answered with nothing', () => {
    assert.equal(
      answerCredentialRequest('host=gist.github.com\n', {
        host: 'github.com',
        username: 'x-access-token',
        secret,
      }),
      '',
    )
  })
  check('a request with no host is answered with nothing', () => {
    assert.equal(answerCredentialRequest('protocol=https\n', { host: 'github.com', secret }), '')
  })
  check('a request carrying its own username keeps it', () => {
    const answer = answerCredentialRequest('host=github.com\nusername=octocat\n', {
      host: 'github.com',
      username: 'x-access-token',
      secret,
    })
    assert.equal(answer, 'username=octocat\npassword=' + TOKEN + '\n\n')
  })
  check('with no secret there is no answer', () => {
    assert.equal(
      answerCredentialRequest('host=github.com\n', { host: 'github.com', secret: () => null }),
      '',
    )
    assert.equal(
      answerCredentialRequest('host=github.com\n', { host: 'github.com', secret: () => '' }),
      '',
    )
  })

  // ---- the socket ----------------------------------------------------------
  let current = null
  const socketPath = join(HOME, 'dsh-git.sock')
  const server = createCredentialSocket({
    socketPath,
    host: 'github.com',
    username: 'x-access-token',
    secret: () => current,
  })

  check('the socket path is not there before start', () => {
    assert.equal(existsSync(socketPath), false)
  })
  server.start()
  await sleep(120)
  check('start binds the socket with mode 600', () => {
    const stat = statSync(socketPath)
    assert.equal(stat.isSocket(), true, 'not a socket')
    assert.equal((stat.mode & 0o777).toString(8), '600')
  })
  await checkAsync(
    'a locked vault answers with nothing, then a token is felt at once',
    async () => {
      assert.equal(await ask(socketPath, 'protocol=https\nhost=github.com\n\n'), '')
      current = TOKEN
      assert.equal(
        await ask(socketPath, 'protocol=https\nhost=github.com\n\n'),
        'username=x-access-token\npassword=' + TOKEN + '\n\n',
      )
    },
  )
  await checkAsync('an oversized request is dropped rather than buffered', async () => {
    assert.equal(await ask(socketPath, 'a'.repeat(5000)), '')
  })
  check('the exposed handler is the same protocol, without a socket', () => {
    assert.equal(
      server.handle('host=github.com\n\n'),
      'username=x-access-token\npassword=' + TOKEN + '\n\n',
    )
  })
  server.stop()
  check('stop removes the socket and a second stop is safe', () => {
    assert.equal(existsSync(socketPath), false)
    server.stop()
  })

  const stalePath = join(HOME, 'stale.sock')
  writeFileSync(stalePath, 'not a socket')
  const second = createCredentialSocket({
    socketPath: stalePath,
    host: 'github.com',
    secret: () => TOKEN,
  })
  second.start()
  await sleep(120)
  check('a stale file at the path does not stop the bind', () => {
    assert.equal(statSync(stalePath).isSocket(), true)
  })
  second.stop()

  // A reload mounts the successor before the predecessor finishes disposing.
  // The predecessor's stop must not unlink a socket it no longer owns: the path
  // is shared, and an unlinked one is a live listener git can never reach.
  const predecessor = createCredentialSocket({
    socketPath,
    host: 'github.com',
    username: 'x-access-token',
    secret: () => TOKEN,
  })
  predecessor.start()
  await sleep(120)
  const successor = createCredentialSocket({
    socketPath,
    host: 'github.com',
    username: 'x-access-token',
    secret: () => TOKEN,
  })
  successor.start()
  await sleep(120)
  predecessor.stop()
  check('a predecessor stop leaves the successor socket in place', () => {
    assert.equal(existsSync(socketPath), true, 'the successor socket path was removed')
  })
  await checkAsync('the successor still serves after the predecessor stops', async () => {
    assert.equal(
      await ask(socketPath, 'protocol=https\nhost=github.com\n\n'),
      'username=x-access-token\npassword=' + TOKEN + '\n\n',
    )
  })
  successor.stop()
  check('the successor own stop removes its socket', () => {
    assert.equal(existsSync(socketPath), false)
  })

  // ---- the helper git runs -------------------------------------------------
  const third = createCredentialSocket({
    socketPath,
    host: 'github.com',
    username: 'x-access-token',
    secret: () => TOKEN,
  })
  third.start()
  await sleep(120)
  await checkAsync('the helper relays get to the socket and exits 0', async () => {
    const result = await helper(
      ['--socket', socketPath, 'get'],
      'protocol=https\nhost=github.com\n\n',
    )
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'username=x-access-token\npassword=' + TOKEN + '\n\n')
  })
  await checkAsync('the helper answers nothing for a host this socket does not serve', async () => {
    const result = await helper(
      ['--socket', socketPath, 'get'],
      'protocol=https\nhost=gist.github.com\n\n',
    )
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })
  await checkAsync('store and erase are silent no-ops that never connect', async () => {
    for (const operation of ['store', 'erase']) {
      const result = await helper(
        ['--socket', join(HOME, 'never.sock'), operation],
        'protocol=https\nhost=github.com\npassword=x\n\n',
      )
      assert.equal(result.status, 0, operation + ' exited ' + result.status)
      assert.equal(result.stdout, '', operation + ' wrote ' + JSON.stringify(result.stdout))
      assert.equal(result.stderr, '', operation + ' complained: ' + JSON.stringify(result.stderr))
    }
  })
  await checkAsync('a missing socket exits 0 with the reason on stderr', async () => {
    const result = await helper(
      ['--socket', join(HOME, 'never.sock'), 'get'],
      'protocol=https\nhost=github.com\n\n',
    )
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /is the harness running\?/)
  })
  await checkAsync(
    'with no --socket the helper prints the usage line and says nothing',
    async () => {
      const result = await helper(['get'], 'protocol=https\nhost=github.com\n\n')
      assert.equal(result.status, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /no socket configured/)
    },
  )
  await checkAsync('an unknown operation is refused quietly', async () => {
    const result = await helper(
      ['--socket', socketPath, 'wat'],
      'protocol=https\nhost=github.com\n\n',
    )
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })
  await checkAsync('the socket path has exactly one source: --socket', async () => {
    const result = await helper(['get'], 'protocol=https\nhost=github.com\n\n', {
      DSH_GIT_SOCKET: socketPath,
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '', 'the environment variable was honoured')
    assert.match(result.stderr, /no socket configured/)
  })
  third.stop()

  rmSync(HOME, { recursive: true, force: true })

  let failed = 0
  for (const [label, ok, message] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
  }
  console.log('\nchecks:', checks.length, '| throwaway dir removed:', HOME)
  process.exit(failed === 0 ? 0 : 1)
})()
