// Host-half check for dsh-git against the 0.1.7 plugin surfaces.
//
// It imports the real `lib/index.js`, builds the config through the exported
// schemastery `Config` — so the schema and the volatile references under test
// are the ones the Loader builds — and drives `apply()` with a stub context that
// records every registration and stands in for the credentials service. Nothing
// here touches a live Harness.
//
//   node test/host-apply-check.cjs
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const HOME = mkdtempSync(join(tmpdir(), 'dsh-git-test-'))
process.env.DSH_HOME = HOME
// The plugin writes git config; keep that off the operator's own file.
process.env.GIT_CONFIG_GLOBAL = join(HOME, 'gitconfig')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

const checks = []
const check = (label, fn) => {
  try {
    fn()
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let bootCount = 0
/**
 * One stub host: a logger, an injectable service bag with an in-memory
 * credentials provider, and an effect collector. `apply()` runs for real.
 */
async function boot(overrides = {}) {
  const mod = await import('../lib/index.js')
  bootCount += 1
  const dir = join(HOME, 'boot' + bootCount)
  const log = []
  const records = new Map()
  const registered = { routes: [], effects: [], services: [] }

  const config = mod.Config({
    keyFile: join(dir, 'dsh-git.key'),
    socketPath: join(dir, 'dsh-git.sock'),
    manageGitConfig: false,
    ...overrides,
  })

  const credentials = {
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    deleteRecord: async (key) => {
      records.delete(key)
    },
  }

  const childFor = (service) => {
    registered.services.push(service)
    if (service === 'credentials') return { credentials, logger: rootCtx.logger }
    if (service === 'connection') {
      return {
        connection: {
          fetch: {
            register: (route) => {
              registered.routes.push(route)
              return () => {}
            },
          },
        },
        logger: rootCtx.logger,
      }
    }
    return { logger: rootCtx.logger }
  }

  const rootCtx = {
    logger: {
      info: (...args) => log.push(['info', args.join(' ')]),
      warn: (...args) => log.push(['warn', args.join(' ')]),
      error: (...args) => log.push(['error', args.join(' ')]),
    },
    inject: (deps, callback) => {
      for (const dep of deps) callback(childFor(dep))
    },
    on: () => {},
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') registered.effects.push(disposer)
    },
  }

  mod.apply(rootCtx, config)
  await sleep(120)

  const route = (path) => registered.routes.find((entry) => entry.path === path)
  const call = async (path, init) => {
    const definition = route(path)
    if (definition === undefined) throw new Error('no route registered at ' + path)
    const response = await definition.fetch(new Request('http://127.0.0.1:3080' + path, init))
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* the refusal paths still answer JSON */
    }
    return { status: response.status, body, text }
  }
  const post = (path, body) =>
    call(path, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  return {
    mod,
    config,
    log,
    records,
    registered,
    route,
    call,
    post,
    state: async () => (await call('/api/dsh-git.state')).body,
    dispose: () => {
      for (const disposer of registered.effects) disposer()
    },
  }
}

;(async () => {
  const mod = await import('../lib/index.js')
  const { Config, CREDENTIAL_KEY, CREDENTIAL_ID, name } = mod
  const crypto = await import('../lib/crypto.js')
  const answers = []

  // ---- the schema ----------------------------------------------------------
  const plain = Config({})
  check('Config declares the six documented fields', () => {
    assert.deepEqual(
      Object.keys(plain).sort(),
      ['host', 'keyFile', 'manageGitConfig', 'scanRoot', 'socketPath', 'username'].sort(),
    )
  })
  check('the declared defaults are the documented ones', () => {
    assert.equal(plain.keyFile.get(), '')
    assert.equal(plain.socketPath, '')
    assert.equal(plain.host.get(), 'github.com')
    assert.equal(plain.username.get(), 'x-access-token')
    assert.equal(plain.manageGitConfig, true)
    assert.equal(plain.scanRoot, '')
  })
  check('exactly the per-operation fields are volatile', () => {
    const volatile = Object.entries(plain)
      .filter(
        ([, value]) =>
          value !== null && typeof value === 'object' && typeof value.get === 'function',
      )
      .map(([key]) => key)
      .sort()
    assert.deepEqual(volatile, ['host', 'keyFile', 'username'])
  })
  check('Config tolerates a field it no longer declares, and refuses a bad type', () => {
    // A profile patch that still carries `unlockMode` must not break the plugin.
    assert.doesNotThrow(() => Config({ unlockMode: 'ask' }))
    assert.throws(() => Config({ scanRoot: 42 }))
  })
  check('the credential address is the plugin name plus the record id', () => {
    assert.equal(name, 'dsh-git')
    assert.equal(CREDENTIAL_ID, 'github')
    assert.equal(CREDENTIAL_KEY, 'dsh-git/github')
  })

  // ---- apply ---------------------------------------------------------------
  const first = await boot()
  check('apply() registers without a warning', () => {
    assert.deepEqual(
      first.log.filter(([level]) => level === 'warn'),
      [],
    )
  })
  check('it registers exactly the three documented routes', () => {
    assert.deepEqual(
      first.registered.routes.map((entry) => [entry.path, entry.methods.join(',')]).sort(),
      [
        ['/api/dsh-git.forget', 'POST'],
        ['/api/dsh-git.state', 'GET'],
        ['/api/dsh-git.token', 'POST'],
      ],
    )
    for (const entry of first.registered.routes) assert.equal(entry.requestBody, 'buffered')
  })
  check('the socket is bound with mode 600 and disposed with the effect', () => {
    const path = first.config.socketPath
    const stat = statSync(path)
    assert.equal(stat.isSocket(), true, 'not a socket')
    assert.equal((stat.mode & 0o777).toString(8), '600')
    first.dispose()
    assert.equal(existsSync(path), false, 'the socket survived disposal')
  })
  check('the credentials service was injected, and only it', () => {
    assert.deepEqual(first.registered.services, ['credentials', 'connection'])
  })

  const second = await boot()
  await checkAsync('an empty vault is reported, not hidden', async () => {
    const state = await second.state()
    assert.equal(state.ok, true)
    assert.equal(state.credentialKey, 'dsh-git/github')
    assert.equal(state.credentials, true)
    assert.equal(state.configured, false)
    assert.equal(state.readable, false)
    assert.equal(state.error, null)
    assert.equal(state.host, 'github.com')
    assert.equal(state.username, 'x-access-token')
    assert.equal(state.manageGitConfig, false)
    assert.equal(state.socketPath, second.config.socketPath)
    assert.equal(state.helper.path.endsWith('credhelper.cjs'), true)
    assert.match(state.helper.command, /--socket/)
    assert.ok(state.helper.command.includes(second.config.socketPath))
    assert.equal(typeof state.helper.installed, 'boolean')
  })
  await checkAsync('the state carries the ownership report, and no unlock mode', async () => {
    const state = await second.state()
    assert.equal('unlockMode' in state, false)
    assert.equal('locked' in state, false)
    assert.equal('trust' in state, false)
    assert.equal(state.ownership.root, '/workspace')
    assert.equal(state.ownership.exists, existsSync('/workspace'))
    assert.equal(state.ownership.user, process.getuid() + ':' + process.getgid())
    assert.deepEqual(state.ownership.misowned, [])
  })
  await checkAsync('reading the state does not create a key file', async () => {
    const state = await second.state()
    assert.equal(state.keyFile.exists, false)
    assert.equal(existsSync(second.config.keyFile.get()), false)
  })

  const TOKEN = 'ghp_host_check_0123456789abcdef'
  await checkAsync('the token route seals one grant record', async () => {
    const stored = await second.post('/api/dsh-git.token', { token: TOKEN })
    answers.push(stored.text)
    assert.equal(stored.status, 200)
    assert.equal(stored.body.ok, true)
    const record = second.records.get('dsh-git/github')
    assert.ok(record, 'no record was written')
    assert.equal(record.kind, 'grant')
    assert.equal(record.payload.v, 1)
    assert.equal(record.payload.alg, 'aes-256-gcm')
    assert.equal(record.payload.aad, 'dsh-git/github')
    assert.deepEqual(Object.keys(record.payload).sort(), ['aad', 'alg', 'ct', 'iv', 'tag', 'v'])
    assert.equal(
      JSON.stringify(record.payload).includes(TOKEN),
      false,
      'the plaintext is in the payload',
    )
  })
  await checkAsync('the key file appears with mode 600, and opens that record', async () => {
    const path = second.config.keyFile.get()
    const stat = statSync(path)
    assert.equal((stat.mode & 0o777).toString(8), '600')
    const record = second.records.get('dsh-git/github')
    assert.equal(
      crypto.open(crypto.loadKeyFile(path, { create: false }), record.payload, crypto.AAD),
      TOKEN,
    )
  })
  await checkAsync('the vault then reports configured and readable', async () => {
    const state = await second.state()
    assert.equal(state.configured, true)
    assert.equal(state.readable, true)
    assert.equal(state.error, null)
    assert.equal(state.keyFile.exists, true)
    const tokenRoute = await second.post('/api/dsh-git.token', { token: TOKEN })
    answers.push(tokenRoute.text)
    assert.equal(tokenRoute.status, 200)
  })
  await checkAsync('bad input is refused rather than absorbed', async () => {
    const missing = await second.post('/api/dsh-git.token', {})
    const empty = await second.post('/api/dsh-git.token', { token: '' })
    const spaced = await second.post('/api/dsh-git.token', { token: 'has space' })
    const broken = await second.post('/api/dsh-git.token', '{not json')
    for (const answer of [missing, empty, spaced, broken]) {
      answers.push(answer.text)
      assert.equal(
        answer.status,
        400,
        'answered ' + answer.status + ' ' + answer.text.slice(0, 120),
      )
      assert.equal(answer.body.ok, false)
    }
  })
  await checkAsync('a record that is not a sealed payload is refused', async () => {
    second.records.set('dsh-git/github', { kind: 'api-key', key: 'x' })
    const state = await second.state()
    answers.push(JSON.stringify(state))
    assert.equal(state.readable, false)
    assert.match(state.error, /holds a api-key record/)
    await second.post('/api/dsh-git.token', { token: TOKEN })
    assert.equal((await second.state()).readable, true)
  })
  await checkAsync('forget deletes the record and the vault reads empty again', async () => {
    const forgotten = await second.post('/api/dsh-git.forget', {})
    answers.push(forgotten.text)
    assert.equal(forgotten.status, 200)
    assert.equal(forgotten.body.configured, false)
    assert.equal(second.records.has('dsh-git/github'), false)
    assert.equal((await second.state()).configured, false)
  })
  second.dispose()

  // ---- git configuration ---------------------------------------------------
  const gitconfig = () =>
    existsSync(process.env.GIT_CONFIG_GLOBAL)
      ? readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')
      : ''
  /** Ask git itself: `safe.directory=x` renders as a `[safe] directory` section, so a text search would miss it. */
  const safeDirectories = () => {
    try {
      return execFileSync('git', ['config', '--global', '--get-all', 'safe.directory'], {
        encoding: 'utf8',
      })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return [] // the key is simply absent
    }
  }
  const configured = await boot({ manageGitConfig: true })
  check('the helper is registered once, for the configured host', () => {
    const text = gitconfig()
    assert.equal(
      text.includes('credential "https://github.com"'),
      true,
      'no helper entry was written',
    )
    assert.equal(text.includes('credhelper.cjs'), true)
    assert.equal(text.split('helper = ').length - 1, 1, 'the helper was registered more than once')
  })
  check('nothing this plugin does writes safe.directory', () => {
    assert.deepEqual(safeDirectories(), [], 'a repository trust entry was written')
  })
  configured.dispose()

  // ---- repository ownership ------------------------------------------------
  const scanRoot = join(HOME, 'workspace')
  mkdirSync(join(scanRoot, 'repo-one', '.git'), { recursive: true })
  mkdirSync(join(scanRoot, 'plain'), { recursive: true })
  const scanned = await boot({ scanRoot })
  await checkAsync('the ownership report scans the configured folder, read-only', async () => {
    const state = await scanned.state()
    assert.equal(state.ownership.root, scanRoot)
    assert.equal(state.ownership.exists, true)
    assert.equal(state.ownership.checked, 1)
    assert.deepEqual(state.ownership.misowned, [])
    assert.deepEqual(safeDirectories(), [], 'the report wrote git config')
  })
  scanned.dispose()
  await checkAsync('a scan root that does not exist is reported, not fatal', async () => {
    const absent = await boot({ scanRoot: join(HOME, 'nowhere') })
    const state = await absent.state()
    assert.equal(state.ownership.exists, false)
    assert.equal(state.ownership.checked, 0)
    absent.dispose()
  })

  check('no route ever answered with the token', () => {
    for (const text of answers) {
      assert.equal(text.includes(TOKEN), false, text.slice(0, 160))
    }
  })

  rmSync(HOME, { recursive: true, force: true })

  let failed = 0
  for (const [label, ok, message] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
  }
  console.log('\nchecks:', checks.length, '| throwaway DSH_HOME removed:', HOME)
  process.exit(failed === 0 ? 0 : 1)
})()
