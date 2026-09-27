// Uninstall check for dsh-git: what an unload deletes, and — more important —
// what it must not.
//
// A dispose is not an uninstall. The same disposer runs on a configuration
// reload, on an upgrade, and on a shutdown, so the cleanup is gated on the
// package actually leaving the profile. This check drives both branches against
// the real host half with a stub context: first the reload, where the token must
// survive, then the uninstall, where nothing may be left behind.
//
//   node test/uninstall-check.cjs
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const checks = []
const checkAsync = async (label, fn) => {
  try {
    await fn()
    checks.push([label, true, ''])
  } catch (error) {
    checks.push([label, false, error.message])
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Wait for a condition, so a poll that fires late is not a flake. */
async function until(describe, predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error('timed out waiting for ' + describe)
}

const FOREIGN = '!node /opt/other-tool/helper.cjs'
/**
 * Every fixture's home, removed only once the whole check is done.
 *
 * A disposer's watch outlives its own fixture: it keeps polling for the rest of
 * its window, and deleting a fixture's home early would make that watch fire
 * against whatever global git config the next fixture had installed. Keeping the
 * homes until the end is what makes the cases independent.
 */
const HOMES = []
const helperEntries = () => {
  try {
    return execFileSync(
      'git',
      ['config', '--global', '--get-all', 'credential.https://github.com.helper'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return [] // the key is simply absent
  }
}

let fixtureCount = 0
/**
 * One isolated install: its own DSH home, its own profile, its own global git
 * config, and the real plugin applied to a stub host.
 * @param options - `installed` keeps a package directory in the profile;
 *   `managed` supplies the `profileContext` a managed profile provides.
 */
async function fixture({ installed = true, managed = true } = {}) {
  const mod = await import('../lib/index.js')
  fixtureCount += 1
  const HOME = mkdtempSync(join(tmpdir(), 'dsh-git-uninstall-' + fixtureCount + '-'))
  HOMES.push(HOME)
  const profile = join(HOME, 'profile')
  const packageDir = join(profile, 'node_modules', 'dsh-git')
  if (installed) mkdirSync(packageDir, { recursive: true })
  const gitconfig = join(HOME, 'gitconfig')
  const previous = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_SYSTEM,
    home: process.env.DSH_HOME,
  }
  process.env.GIT_CONFIG_GLOBAL = gitconfig
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.DSH_HOME = HOME
  // Another tool's helper for the same host: cleanup must leave it standing.
  execFileSync(
    'git',
    ['config', '--global', '--add', 'credential.https://github.com.helper', FOREIGN],
    { encoding: 'utf8' },
  )

  const log = []
  const records = new Map()
  const disposers = []
  const routes = []
  const logger = {
    info: (...args) => log.push(['info', args.join(' ')]),
    warn: (...args) => log.push(['warn', args.join(' ')]),
    error: (...args) => log.push(['error', args.join(' ')]),
  }
  const services = {
    credentials: {
      readRecord: async (key) => records.get(key),
      modifyRecord: async (key, mutate) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
      deleteRecord: async (key) => {
        records.delete(key)
      },
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  const ctx = {
    logger,
    inject: (deps, callback) => {
      for (const _dep of deps) callback({ ...services, logger })
    },
    on: () => {},
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    // What the harness provides in a managed profile; absent in a bare one.
    get: (name) => (managed && name === 'profileContext' ? { dir: profile } : undefined),
  }

  const config = mod.Config({
    keyFile: join(HOME, 'dsh-git.key'),
    socketPath: join(HOME, 'dsh-git.sock'),
    manageGitConfig: true,
  })
  mod.apply(ctx, config)
  await sleep(120)

  const post = async (path, body) => {
    const definition = routes.find((entry) => entry.path === path)
    if (definition === undefined) throw new Error('no route registered at ' + path)
    const response = await definition.fetch(
      new Request('http://127.0.0.1' + path, {
        method: 'POST',
        body: JSON.stringify(body || {}),
        headers: { 'content-type': 'application/json' },
      }),
    )
    return { status: response.status, body: await response.json() }
  }

  return {
    HOME,
    profile,
    packageDir,
    keyFile: config.keyFile.get(),
    log,
    records,
    post,
    helperEntries,
    installedHelper: () => helperEntries().filter((entry) => entry.includes('credhelper.cjs')),
    uninstall: () => rmSync(packageDir, { recursive: true, force: true }),
    /** What the Loader does on unload: every effect's disposer, in order. */
    dispose: () => {
      for (const disposer of disposers) disposer()
    },
    /** Hand the process back to the next fixture; the home stays until the end. */
    cleanup: () => {
      process.env.GIT_CONFIG_GLOBAL = previous.global
      process.env.GIT_CONFIG_SYSTEM = previous.system
      process.env.DSH_HOME = previous.home
    },
  }
}

;(async () => {
  const TOKEN = 'ghp_uninstall_check_0123456789abcdef'

  // ---- the reload: a dispose that is not an uninstall ----------------------
  const reload = await fixture()
  await checkAsync('a saved token is a record, a key file, and one helper entry', async () => {
    const stored = await reload.post('/api/dsh-git.token', { token: TOKEN })
    assert.equal(stored.status, 200)
    assert.equal(reload.records.has('dsh-git/github'), true)
    assert.equal(existsSync(reload.keyFile), true)
    assert.equal(reload.installedHelper().length, 1, 'the helper entry was not written')
    assert.equal(reload.helperEntries().includes(FOREIGN), true)
  })
  await checkAsync('a reload deletes nothing: the package is still installed', async () => {
    reload.dispose()
    // Longer than one poll, so a cleanup that fired would be seen here.
    await sleep(1_600)
    assert.equal(reload.records.has('dsh-git/github'), true, 'the record was deleted by a reload')
    assert.equal(existsSync(reload.keyFile), true, 'the key file was deleted by a reload')
    assert.equal(reload.installedHelper().length, 1, 'the helper entry was removed by a reload')
  })
  await checkAsync('the socket is released on unload either way', () => {
    assert.equal(existsSync(join(reload.HOME, 'dsh-git.sock')), false)
  })
  reload.cleanup()

  // ---- the uninstall: the package leaves the profile -----------------------
  const gone = await fixture()
  await checkAsync('the token is stored before the uninstall', async () => {
    const stored = await gone.post('/api/dsh-git.token', { token: TOKEN })
    assert.equal(stored.status, 200)
    assert.equal(statSync(gone.keyFile).mode & 0o777, 0o600)
    assert.equal(gone.installedHelper().length, 1, 'the helper entry was not written')
    assert.deepEqual(
      gone.helperEntries().length,
      2,
      'the seeded entry and this plugin’s were expected',
    )
  })
  await checkAsync(
    'an uninstall removes the record, the key file, and our helper entry',
    async () => {
      gone.uninstall()
      gone.dispose()
      await until('the uninstall cleanup', () => gone.records.has('dsh-git/github') === false)
      await until('the helper entry to go', () => gone.installedHelper().length === 0)
      assert.equal(existsSync(gone.keyFile), false, 'the key file survived the uninstall')
      assert.equal(
        gone.records.has('dsh-git/github'),
        false,
        'the credential record survived the uninstall',
      )
    },
  )
  await checkAsync('another tool’s helper entry for the same host survives', () => {
    assert.deepEqual(gone.helperEntries(), [FOREIGN])
  })
  await checkAsync('the uninstall is reported in the log', () => {
    const line = gone.log
      .filter(([level, text]) => level === 'info' && text.includes('uninstalled'))
      .pop()
    assert.ok(line, 'no uninstall line was logged')
    assert.match(line[1], /git helper entry/, JSON.stringify(gone.log, null, 1))
    assert.match(line[1], /key file/)
    assert.match(line[1], /credential record/)
  })
  await checkAsync('the record is really gone from the credential document', () => {
    // The stub's map stands in for the seam's document; the seam is asked to
    // delete, and it answers a no-op for a key that is not there.
    assert.equal(gone.records.size, 0)
  })
  gone.cleanup()

  // ---- a profile that cannot identify its install --------------------------
  // The honest boundary: with no `profileContext` there is no profile install to
  // watch, so nothing is deleted — and nothing throws either.
  const bare = await fixture({ managed: false })
  await checkAsync('without a profile context nothing is deleted, and nothing throws', async () => {
    const stored = await bare.post('/api/dsh-git.token', { token: TOKEN })
    assert.equal(stored.status, 200)
    bare.uninstall()
    bare.dispose()
    await sleep(1_600)
    assert.equal(
      bare.records.has('dsh-git/github'),
      true,
      'a composition without a profile cleaned up anyway',
    )
    assert.equal(existsSync(bare.keyFile), true)
    assert.equal(bare.installedHelper().length, 1)
  })
  bare.cleanup()

  // ---- report --------------------------------------------------------------
  for (const home of HOMES) rmSync(home, { recursive: true, force: true })
  let failed = 0
  for (const [label, ok, message] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
  }
  console.log('\nchecks:', checks.length, '| fixtures removed:', HOMES.join(' '))
  process.exit(failed === 0 ? 0 : 1)
})()
