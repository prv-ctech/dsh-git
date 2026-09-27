// dsh-git — the boot-reuse check.
//
//   node test/boot-reuse-check.cjs [port]
//
// The path the live-surface check never touches: a harness that boots over an
// ALREADY stored record and key file. Every other check stores the token first,
// which refreshes the cache on the write path; this check proves the socket is
// served after a plain restart, with no write in between.
//
// What it proves, in order:
//
//   1. boot one: the token route stores, and the helper answers it;
//   2. boot two over the same home: the state route still reports the vault
//      configured and readable, and the helper must answer the same token —
//      a restart may not empty the credential the socket serves.
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')

const REPO = join(__dirname, '..')
const SOURCE = process.env.DSH_HOME || join(homedir(), '.dsh')
const HOME = join(tmpdir(), 'dsh-git-reboot')
const PROFILE = join(HOME, 'profiles', 'web')
const PORT = Number(process.argv[2] ?? 3123)
const BASE = 'http://127.0.0.1:' + PORT
const TOKEN = 'ghp_reboot_do_not_use_0123456789abcdef'
const HELPER = join(REPO, 'lib', 'credhelper.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (path) => fs.readFileSync(path, 'utf8')

const checks = []
const record = (label, ok, detail = '') => checks.push([label, ok, detail])

/** One `dsh web` boot over the throwaway home; resolves once it prints its token. */
const boot = async () => {
  const child = spawn('dsh', ['web', '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: HOME, HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })
  let token = null
  const deadline = Date.now() + 120000
  while (token === null && Date.now() < deadline) {
    await sleep(1000)
    const m = /token=([A-Za-z0-9_-]+)/.exec(out)
    if (m) token = m[1]
  }
  if (token === null) throw new Error('verification instance never printed a token:\n' + out)
  const cookie = (
    await fetch(BASE + '/?token=' + encodeURIComponent(token), { redirect: 'manual' })
  ).headers
    .getSetCookie()[0]
    .split(';')[0]
  const call = async (path, init) => {
    const response = await fetch(BASE + path, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...init?.headers },
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  return {
    child,
    out,
    state: () => call('/api/dsh-git.state'),
    store: () =>
      call('/api/dsh-git.token', { method: 'POST', body: JSON.stringify({ token: TOKEN }) }),
    stop: async () => {
      child.kill('SIGTERM')
      await sleep(1500)
    },
  }
}

/** Ask the helper, without printing the answer's secret. */
const helper = (socketPath) =>
  spawnSync(process.execPath, [HELPER, '--socket', socketPath, 'get'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })

;(async () => {
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(HOME, { recursive: true })
  fs.cpSync(join(SOURCE, 'profiles'), join(HOME, 'profiles'), {
    recursive: true,
    dereference: false,
  })
  try {
    fs.copyFileSync(join(SOURCE, '.credentials.yaml'), join(HOME, '.credentials.yaml'))
  } catch {
    /* the instance mints its own */
  }

  const manifestPath = join(PROFILE, 'package.json')
  const manifest = JSON.parse(read(manifestPath))
  manifest.dependencies = { ...manifest.dependencies, 'dsh-git': 'link:' + REPO }
  const bundles = manifest.dsh.profile.bundles
  if (!bundles.includes('dsh-git')) bundles.push('dsh-git')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  fs.mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
  fs.rmSync(join(PROFILE, 'node_modules', 'dsh-git'), { recursive: true, force: true })
  fs.symlinkSync(REPO, join(PROFILE, 'node_modules', 'dsh-git'), 'dir')

  try {
    // ---- boot one: store, then the helper answers -------------------------
    const one = await boot()
    const stored = await one.store()
    const stateOne = await one.state()
    const answerOne = helper(stateOne.body.socketPath)
    record(
      'boot one stores the token and the helper answers it',
      stored.status === 200 &&
        stateOne.body.readable === true &&
        answerOne.stdout.includes('password=' + TOKEN),
      stored.status + ' ' + JSON.stringify(answerOne.stdout.slice(0, 60)),
    )
    await one.stop()

    // ---- boot two: same home, same record, no write in between ------------
    const two = await boot()
    const stateTwo = await two.state()
    const answerTwo = helper(stateTwo.body.socketPath)
    record(
      'boot two still reports the vault configured and readable',
      stateTwo.body.configured === true && stateTwo.body.readable === true,
      JSON.stringify(stateTwo.body).slice(0, 200),
    )
    record(
      'boot two serves the same credential over the socket',
      answerTwo.stdout.includes('password=' + TOKEN),
      JSON.stringify(answerTwo.stdout.slice(0, 60)) + ' stderr:' + JSON.stringify(answerTwo.stderr),
    )
    await two.stop()
  } catch (error) {
    record(
      'the run itself finished without throwing',
      false,
      (error && error.message) || String(error),
    )
  }

  let failed = 0
  for (const [label, ok, detail] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || !detail ? '' : '  <- ' + detail))
  }
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' boot-reuse checks passed')
  if (failed === 0) fs.rmSync(HOME, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
})().catch((error) => {
  console.error('boot-reuse check could not run:', error && error.message)
  process.exit(1)
})
