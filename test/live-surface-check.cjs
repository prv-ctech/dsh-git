// Live surface check for dsh-git: boots one throwaway `dsh web` over a copy of
// $DSH_HOME with this repo linked into the copied profile, and drives the whole
// design end to end. The operator's home and profile are never written to.
//
//   node test/live-surface-check.cjs [port]
//
// What it proves, in order:
//
//   1. the plugin loads with nothing but this repo and the harness: every
//      `@deepseek-ai/*` import is a declared peer the loader routes to its own
//      installation, so a fresh container needs no install of any kind;
//   2. a volatile write is live — the Settings card's transport round-trips
//      through the profile patch and the value is felt without a restart, and
//      the patch document is byte-identical once the value is unset again;
//   3. repository ownership is reported and never written: the report names the
//      configured folder and what it holds, and a `safe.directory` entry the
//      operator wrote by hand is still exactly what the global config carries;
//   4. the token is sealed into the harness's own credential record, the key
//      file appears with mode 600, and neither the record nor any response
//      carries the plaintext;
//   5. git itself can authenticate: the helper git was configured with answers
//      over the socket, and `git credential fill` prints the token — while
//      `approve`/`reject` stay no-ops, which is what keeps the token out of
//      git's own storage;
//   6. an uninstall — the package leaving the profile, as `pnpm remove` leaves
//      it — takes the record, the key file, and the helper entry with it, and
//      leaves another tool's `safe.directory` entry standing.
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')

const REPO = join(__dirname, '..')
const SOURCE = process.env.DSH_HOME || join(homedir(), '.dsh')
const HOME = join(tmpdir(), 'dsh-git-e2e')
const PROFILE = join(HOME, 'profiles', 'web')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const MANIFEST = join(PROFILE, 'package.json')
const CREDENTIALS = join(HOME, '.credentials.yaml')
const KEY_FILE = join(HOME, 'dsh-git.key')
const GITCONFIG = join(HOME, '.gitconfig')
const PORT = Number(process.argv[2] ?? 3100)
const BASE = 'http://127.0.0.1:' + PORT
const TOKEN = 'ghp_e2e_do_not_use_0123456789abcdef'
const HELPER = join(REPO, 'lib', 'credhelper.cjs')
/** The one foreign entry this check seeds, to prove the plugin never edits the key. */
const FOREIGN_SAFE_DIRECTORY = '/srv/other-tool/repo'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (path) => fs.readFileSync(path, 'utf8')
const gitGlobal = (args) =>
  spawnSync('git', ['config', '--global', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME },
  })

/** The client artifact revision the plugin host serves, as dsh-client-hmr computes it. */
const artifactRevision = (file) => {
  const stat = fs.statSync(file)
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const part of [
    String(stat.mtimeMS ?? stat.mtimeMs),
    String(stat.ctimeMS ?? stat.ctimeMs),
    String(stat.size),
  ]) {
    hash.update(String(Buffer.byteLength(part)) + ':').update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

const checks = []
const record = (label, ok, detail = '') => checks.push([label, ok, detail])

;(async () => {
  // ---- throwaway home, with this repo installed into the copied profile -----
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(HOME, { recursive: true })
  fs.cpSync(join(SOURCE, 'profiles'), join(HOME, 'profiles'), {
    recursive: true,
    dereference: false,
  })
  // The source is the operator's real home, so it may carry what real usage
  // wrote: a user-layer `git` row in the profile patch, and a live record in
  // the credentials document. This check asserts the behaviour from a clean
  // state, so it scrubs the row and never copies the document — the instance
  // mints its own on the first sealed write.
  const patchText = read(PATCH)
  const scrubbed = patchText.replace(/^- id: git\r?\n(?:^[ \t]+.*\r?\n?)*/gm, '')
  if (scrubbed !== patchText) fs.writeFileSync(PATCH, scrubbed)

  // The ownership report scans one folder, so this check configures it the way
  // an operator would: a user-layer row for the entry, applied at boot. The row
  // also carries a key this version no longer declares — an operator's patch
  // written against an earlier build — because a boot must tolerate that rather
  // than refuse the profile.
  const scanRoot = join(HOME, 'workspace')
  const ownedRepo = join(scanRoot, 'repo-one')
  fs.mkdirSync(join(ownedRepo, '.git'), { recursive: true })
  // A scaffolded profile patch ends in an empty `[]` placeholder, and a block
  // item appended to that is not YAML — a fresh home must not fail the boot. So
  // the placeholder is replaced when it is the whole body, and only a patch that
  // already holds rows gets an append.
  const row =
    '- id: git\n  name: dsh-git\n  config:\n    scanRoot: ' +
    scanRoot +
    '\n    unlockMode: keyfile\n'
  const current = read(PATCH)
  fs.writeFileSync(
    PATCH,
    /^\s*\[\s*\]\s*$/m.test(current)
      ? current.replace(/^\s*\[\s*\]\s*$/m, row)
      : current + (current.endsWith('\n') ? '' : '\n') + row,
  )
  // A `safe.directory` entry this plugin must never touch, written before it boots.
  gitGlobal(['--add', 'safe.directory', FOREIGN_SAFE_DIRECTORY])

  const manifest = JSON.parse(read(MANIFEST))
  manifest.dependencies = { ...manifest.dependencies, 'dsh-git': 'link:' + REPO }
  const bundles = manifest.dsh.profile.bundles
  if (!bundles.includes('dsh-git')) bundles.push('dsh-git')
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  fs.writeFileSync(MANIFEST, manifestText)
  fs.mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
  fs.rmSync(join(PROFILE, 'node_modules', 'dsh-git'), { recursive: true, force: true })
  fs.symlinkSync(REPO, join(PROFILE, 'node_modules', 'dsh-git'), 'dir')

  // The whole run keeps HOME isolated too: the plugin registers its git
  // credential helper with `git config --global`, and that must land in the
  // throwaway home, never in the operator's ~/.gitconfig.
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
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* a non-JSON answer stays inspectable as text */
    }
    // The settings service answers in the Remote envelope; the plugin's own
    // routes answer bare JSON. Unwrap the former so both read the same way.
    if (body !== null && body.type === 'server-response') body = body.result
    return { status: response.status, body, text }
  }
  const state = async () => (await call('/api/dsh-git.state')).body
  // One Remote call: the Settings card's own transport, in the client-request envelope.
  const mutate = (ops) =>
    call('/api/settings/mutate', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'git-e2e-' + Date.now(),
        method: 'settings/mutate',
        payload: { args: { ns: 'git', ops } },
      }),
    })
  const helper = (socketPath, request, env = {}) =>
    spawnSync(
      process.execPath,
      socketPath === null ? [HELPER, 'get'] : [HELPER, '--socket', socketPath, 'get'],
      { input: request, encoding: 'utf8', env: { ...process.env, ...env } },
    )
  const gitCredential = (operation, config) =>
    spawnSync(
      'git',
      ['-c', 'credential.https://github.com.helper=' + config, 'credential', operation],
      {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        env: { ...process.env, HOME, GIT_TERMINAL_PROMPT: '0' },
      },
    )
  /** Wait for the harness to settle something the plugin does asynchronously. */
  const until = async (predicate, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await predicate()) return true
      await sleep(500)
    }
    return false
  }

  const answers = []
  try {
    // ---- 1. the plugin loaded with no dependency of its own ----------------
    const initial = await state()
    record(
      'the host half loaded and answers its state route',
      initial !== null && initial.ok === true && initial.credentials === true,
      JSON.stringify(initial).slice(0, 200),
    )
    record(
      'the state route names the record and the defaults',
      initial !== null &&
        initial.credentialKey === 'dsh-git/github' &&
        initial.host === 'github.com' &&
        initial.username === 'x-access-token' &&
        initial.manageGitConfig === true,
      JSON.stringify(initial).slice(0, 200),
    )
    record(
      'an unconfigured vault is reported, not hidden',
      initial !== null &&
        initial.configured === false &&
        initial.readable === false &&
        initial.error === null,
    )
    record(
      'reading the state does not create a key file',
      initial !== null &&
        initial.keyFile.exists === false &&
        fs.existsSync(initial.keyFile.path) === false,
      initial === null ? 'no state' : initial.keyFile.path,
    )
    record(
      'the credential socket is bound under the throwaway home',
      initial !== null && initial.socketPath.startsWith(HOME) && fs.existsSync(initial.socketPath),
      initial === null ? 'no state' : initial.socketPath,
    )
    record(
      'the helper is what git was configured with, socket included',
      initial !== null &&
        initial.helper.path === HELPER &&
        initial.helper.command.includes(HELPER) &&
        initial.helper.command.includes(initial.socketPath) &&
        initial.helper.installed === true,
      initial === null ? 'no state' : initial.helper.command,
    )

    const configured = gitGlobal(['--get-all', 'credential.https://github.com.helper'])
    record(
      'git config in the throwaway home carries exactly that command',
      configured.status === 0 && configured.stdout.trim() === initial.helper.command.trim(),
      JSON.stringify(configured.stdout),
    )

    // ---- 2. a volatile write is live, and the patch is left byte-identical --
    const reference = read(PATCH)
    const set = await mutate([{ op: 'set', path: ['username'], value: 'x-access-oauth' }])
    const afterSet = read(PATCH)
    const live = await state()
    record(
      'the settings transport accepts the volatile write',
      set.status === 200 && set.body && set.body.ok === true,
      set.status + ' ' + set.text.slice(0, 160),
    )
    record(
      "the value lands in the entry's own user-layer row",
      afterSet.includes('username: x-access-oauth') &&
        (afterSet.match(/^- id: git$/gm) || []).length === 1,
      JSON.stringify(afterSet.slice(reference.length)),
    )
    record(
      'the written value is live, without a restart',
      live !== null && live.username === 'x-access-oauth',
      live === null ? 'no state' : live.username,
    )

    const unset = await mutate([{ op: 'unset', path: ['username'] }])
    record(
      'unset restores the document byte-for-byte',
      unset.status === 200 && read(PATCH) === reference,
      unset.status + ' ' + JSON.stringify(read(PATCH).slice(reference.length)),
    )

    // ---- 2b. ownership is reported, never written --------------------------
    // Git's exception list lives in the *global* `safe.directory`, and an entry
    // this plugin wrote there could not be told apart from one an operator wrote
    // by hand. So the report says what git would refuse, and the key is never
    // touched — the seeded entry is the proof.
    const ownership = ((await state()) || {}).ownership
    record(
      'the ownership report names the configured folder and what it holds',
      ownership !== undefined &&
        ownership.root === scanRoot &&
        ownership.exists === true &&
        ownership.checked === 1 &&
        ownership.misowned.length === 0,
      JSON.stringify(ownership),
    )
    record(
      "the expected owner is this process's user",
      ownership !== undefined && ownership.user === process.getuid() + ':' + process.getgid(),
      ownership === undefined ? 'no report' : ownership.user,
    )
    const safe = gitGlobal(['--get-all', 'safe.directory'])
    record(
      'safe.directory still carries exactly the entry the operator wrote',
      safe.status === 0 &&
        safe.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join(',') === FOREIGN_SAFE_DIRECTORY,
      JSON.stringify(safe.stdout),
    )

    // ---- 3. the token is sealed into the harness's own record --------------
    const stored = await call('/api/dsh-git.token', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    })
    answers.push(['token', stored.text])
    const afterStore = await state()
    record(
      'the token route seals and stores',
      stored.status === 200 && stored.body && stored.body.ok === true,
      stored.status + ' ' + stored.text.slice(0, 160),
    )
    record(
      'the vault reports configured and readable',
      afterStore !== null &&
        afterStore.configured === true &&
        afterStore.readable === true &&
        afterStore.error === null,
      JSON.stringify(afterStore).slice(0, 200),
    )
    record(
      'the key file now exists with mode 600',
      afterStore !== null &&
        afterStore.keyFile.exists === true &&
        afterStore.keyFile.mode === '600' &&
        afterStore.keyFile.safe === true,
      JSON.stringify(afterStore && afterStore.keyFile),
    )
    record(
      'the key file defaults into the harness home, not a shared path',
      afterStore !== null && afterStore.keyFile.path === KEY_FILE,
      afterStore === null ? 'no state' : afterStore.keyFile.path,
    )
    record(
      'the sealed record is in the harness credential document',
      fs.existsSync(CREDENTIALS) && read(CREDENTIALS).includes('dsh-git/github'),
      CREDENTIALS,
    )
    record(
      'the plaintext is nowhere in the credential document',
      !read(CREDENTIALS).includes(TOKEN),
    )
    record(
      'the plaintext is nowhere on disk under the throwaway home',
      (() => {
        // Bounded on purpose: the home also carries a copy of the profile's
        // node_modules, which is not what this claim is about.
        const candidates = [CREDENTIALS, PATCH, KEY_FILE, GITCONFIG, join(HOME, 'plugin-state')]
        return candidates.every((candidate) => {
          if (!fs.existsSync(candidate)) return true
          const stat = fs.statSync(candidate)
          if (stat.isDirectory()) {
            return fs
              .readdirSync(candidate)
              .every((entry) => !read(join(candidate, entry)).includes(TOKEN))
          }
          return !read(candidate).includes(TOKEN)
        })
      })(),
    )

    // ---- 4. git itself can authenticate ------------------------------------
    const socketPath = afterStore.socketPath
    const direct = helper(socketPath, 'protocol=https\nhost=github.com\n\n')
    record(
      'the helper answers the credential over the socket',
      direct.status === 0 &&
        direct.stdout === 'username=x-access-token\npassword=' + TOKEN + '\n\n',
      direct.status + ' ' + JSON.stringify(direct.stdout),
    )
    const foreign = helper(socketPath, 'protocol=https\nhost=gist.github.com\n\n')
    record(
      'another host is answered with nothing',
      foreign.status === 0 && foreign.stdout === '',
      JSON.stringify(foreign.stdout),
    )
    const envOnly = helper(null, 'protocol=https\nhost=github.com\n\n', {
      DSH_GIT_SOCKET: socketPath,
    })
    record(
      'the helper has exactly one source for the socket path',
      envOnly.status === 0 &&
        envOnly.stdout === '' &&
        envOnly.stderr.includes('no socket configured'),
      JSON.stringify(envOnly.stdout) + ' ' + JSON.stringify(envOnly.stderr),
    )

    const fill = gitCredential('fill', afterStore.helper.command)
    record(
      'git credential fill prints the sealed token',
      fill.status === 0 &&
        fill.stdout.includes('password=' + TOKEN) &&
        fill.stdout.includes('username=x-access-token'),
      fill.status + ' ' + JSON.stringify(fill.stdout.slice(0, 120)),
    )
    const approve = gitCredential('approve', afterStore.helper.command)
    const reject = gitCredential('reject', afterStore.helper.command)
    record(
      'approve and reject stay protocol-correct no-ops',
      approve.status === 0 && reject.status === 0 && !read(CREDENTIALS).includes(TOKEN),
      approve.status + ',' + reject.status,
    )

    // ---- 5. refusals, forgetting, and containment --------------------------
    const badToken = await call('/api/dsh-git.token', {
      method: 'POST',
      body: JSON.stringify({ token: 'has space' }),
    })
    answers.push(['bad token', badToken.text])
    const notJson = await call('/api/dsh-git.token', { method: 'POST', body: '{not json' })
    answers.push(['malformed', notJson.text])
    record(
      'a whitespace token and a malformed body are refused',
      badToken.status === 400 && notJson.status === 400,
      [badToken.status, notJson.status].join(','),
    )

    const forgotten = await call('/api/dsh-git.forget', { method: 'POST', body: '{}' })
    answers.push(['forget', forgotten.text])
    const afterForget = await state()
    record(
      'forgetting deletes the record',
      forgotten.status === 200 &&
        forgotten.body.ok === true &&
        afterForget.configured === false &&
        !read(CREDENTIALS).includes('dsh-git/github'),
    )
    const emptyAgain = helper(afterForget.socketPath, 'protocol=https\nhost=github.com\n\n')
    record(
      'the helper then answers nothing at all',
      emptyAgain.status === 0 && emptyAgain.stdout === '',
    )
    // Stored again, because the uninstall below has something to take with it.
    const restored = await call('/api/dsh-git.token', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    })
    answers.push(['restore', restored.text])
    record(
      'the token can be stored again after a forget',
      restored.status === 200 && (await state()).configured === true,
    )

    // ---- 6. the browser half, and the untouched operator documents ---------
    const bundlePath = join(REPO, 'lib', 'client.js')
    const bundle = await fetch(
      BASE + '/plugins/??dsh-git/client.js&rev=' + artifactRevision(bundlePath),
    )
    const bundleText = bundle.status === 200 ? await bundle.text() : ''
    record(
      'the browser half is served',
      bundle.status === 200 &&
        bundleText.includes('dgg-page') &&
        bundleText.includes('/api/dsh-git.state'),
      bundle.status + ' ' + bundleText.length + ' bytes',
    )
    record(
      "the served bundle is the one using the harness's own settings components",
      bundleText.includes('@deepseek-ai/dsh-client-ui-primitives') &&
        bundleText.includes('SettingsSecretField') &&
        bundleText.includes('SettingsFormModel') &&
        bundleText.includes('/api/dsh-git.trust') === false &&
        bundleText.includes('unlockMode') === false,
      bundle.status + ' ' + bundleText.length + ' bytes',
    )
    record(
      'neither the settings write nor the API touched the patch document',
      read(PATCH) === reference,
    )

    // ---- 7. the uninstall, over the harness's own reload path --------------
    // This is what `dsh plugin remove` does: the profile manifest drops the
    // dependency and the package leaves node_modules. HMR watches that manifest,
    // so the composition recomposes, the plugin unloads, sees its install gone,
    // and removes everything it owns.
    const withoutGit = JSON.parse(read(MANIFEST))
    delete withoutGit.dependencies['dsh-git']
    withoutGit.dsh.profile.bundles = withoutGit.dsh.profile.bundles.filter(
      (name) => name !== 'dsh-git',
    )
    fs.writeFileSync(MANIFEST, JSON.stringify(withoutGit, null, 2) + '\n')
    fs.rmSync(join(PROFILE, 'node_modules', 'dsh-git'), { recursive: true, force: true })
    record(
      'the uninstall removes the sealed record',
      await until(
        () => !fs.existsSync(CREDENTIALS) || !read(CREDENTIALS).includes('dsh-git/github'),
      ),
      fs.existsSync(CREDENTIALS) ? read(CREDENTIALS).slice(0, 200) : 'no document',
    )
    record(
      'the uninstall removes the key file',
      await until(() => !fs.existsSync(KEY_FILE)),
      KEY_FILE,
    )
    record(
      'the uninstall removes the helper entry it registered',
      await until(() => {
        const readback = gitGlobal(['--get-all', 'credential.https://github.com.helper'])
        return readback.status !== 0 || readback.stdout.includes(HELPER) === false
      }),
      JSON.stringify(gitGlobal(['--get-all', 'credential.https://github.com.helper']).stdout),
    )
    record(
      "the uninstall leaves the operator's safe.directory entry standing",
      gitGlobal(['--get-all', 'safe.directory'])
        .stdout.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(',') === FOREIGN_SAFE_DIRECTORY,
      JSON.stringify(gitGlobal(['--get-all', 'safe.directory']).stdout),
    )
    record(
      'the plugin is gone from the composition, so its routes are too',
      await until(async () => (await call('/api/dsh-git.state')).status !== 200),
      'the state route still answered after the bundle was removed',
    )
    record(
      'no route ever answered with the token',
      !answers.some(([, text]) => text.includes(TOKEN)) &&
        !JSON.stringify(initial).includes(TOKEN) &&
        !JSON.stringify(afterStore).includes(TOKEN),
    )
  } catch (error) {
    // Reported as a check rather than thrown, so the report below still runs and
    // the harness's own output is visible next to it.
    record(
      'the run itself finished without throwing',
      false,
      (error && error.message) || String(error),
    )
  } finally {
    child.kill('SIGTERM')
    await sleep(1500)
  }

  let failed = 0
  for (const [label, ok, detail] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || !detail ? '' : '  <- ' + detail))
  }
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' live checks passed')
  if (failed === 0) {
    fs.rmSync(HOME, { recursive: true, force: true })
    console.log('port', PORT, '| throwaway home removed')
  } else {
    const lines = out.split('\n').filter((line) => line.trim().length > 0)
    console.log('\n--- the throwaway harness said, last 40 lines ---')
    console.log(lines.slice(-40).join('\n'))
    console.log('\nport', PORT, '| failing home kept for inspection:', HOME)
  }
  process.exit(failed === 0 ? 0 : 1)
})().catch((error) => {
  console.error('live check could not run:', error && error.message)
  process.exit(1)
})
