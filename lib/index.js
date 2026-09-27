// dsh-git — host half.
//
// What this plugin owns:
//
//   * the sealed GitHub token, stored as an opaque `grant` payload in the
//     harness credential record `dsh-git/github` (native seam, 0600 storage,
//     persistent dataset) — never as plaintext anywhere;
//   * the key that opens it: a 0600 random-key file, created on the first save;
//   * a 0600 unix socket speaking git's credential protocol, so a child
//     process can authenticate git without the plaintext ever entering a tool
//     result;
//   * the Settings card's token routes, inside the browser-auth fence;
//   * repository ownership, reported but never written: it does not touch
//     `safe.directory`, so the only fix for a foreign-owned repository is a
//     `chown` on the host.
//
// Uninstalling removes all of that. A dispose is also an ordinary reload, so the
// cleanup waits for the package to actually leave the profile before deleting
// anything (see `watchForRemoval`).
//
// What it deliberately does not own: no route, command, or log line ever
// returns the token, so it cannot reach a model context through this plugin.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { AAD, keyFileState, loadKeyFile, open, seal } from './crypto.js'
import { createCredentialSocket } from './socket.js'
import { DEFAULT_SCAN_ROOT, ownershipReport } from './trust.js'

/** Cordis plugin name. The credential record scope is this name. */
export const name = 'dsh-git'

/** The record's id segment; the address is `dsh-git/github`. */
export const CREDENTIAL_ID = 'github'

/** The full record address, as the seam joins it. */
export const CREDENTIAL_KEY = credentialKey(name, CREDENTIAL_ID)

/** How often, and for how long, an unload watches for the package being removed. */
const REMOVAL_POLL_MS = 1_000
const REMOVAL_WINDOW_MS = 120_000

/**
 * Plugin configuration. In 0.1.7 a settings namespace is the profile entry id
 * (`git`) — not this plugin name — and the settings service projects the
 * fields marked `.volatile()` into an editable form, which the browser half
 * addresses with `ctx.configForms.get('git')`.
 *
 * The invariant this file keeps: a `.volatile()` field is read on every
 * operation, so a live write is felt at once. 0.1.7 hands a volatile field to
 * `apply()` as a reference (`config.field.get()`) and a plain field as its
 * bare value — so `socketPath` and `manageGitConfig`, which are bound once per
 * process (the socket is bound once, the helper is registered once), are
 * deliberately plain: configuration a patch sets and a restart applies.
 *
 * Empty string means "resolve it": the key file and the socket path both
 * default into `$DSH_HOME`.
 */
export const Config = z.object({
  /** Key file path; empty resolves `$DSH_HOME/dsh-git.key`, beside the record it opens. */
  keyFile: z.string().default('').volatile(),
  /** Socket path; empty resolves `$DSH_HOME/dsh-git.sock`. Read once, at load. */
  socketPath: z.string().default(''),
  /** The one host this plugin serves. Read per request. */
  host: z.string().default('github.com').volatile(),
  /** Username reported to git; GitHub accepts any value beside a token. */
  username: z.string().default('x-access-token').volatile(),
  /** Keep `credential.https://<host>.helper` pointing at the bundled helper. Read once, at load. */
  manageGitConfig: z.boolean().default(true),
  /** The folder the ownership report scans. Empty means {@link DEFAULT_SCAN_ROOT}. */
  scanRoot: z.string().default(''),
})

/** A JSON response with no caching, the shape the browser half reads. */
const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

/** The usable part of a token: a non-empty string with no whitespace. */
function normalizeToken(value) {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (token.length === 0) return null
  if (/\s/.test(token)) return null
  return token
}

/**
 * Attach the host half.
 * @param ctx - host plugin context.
 * @param config - validated configuration whose fields are live volatile refs.
 */
export function apply(ctx, config) {
  /**
   * Run one registration, reporting a refusal instead of failing the plugin.
   * A duplicate route from an earlier incarnation of this plugin is the case
   * this exists for: the warning names it instead of killing the whole plugin.
   */
  const guard = (what, register) => {
    try {
      register()
    } catch (error) {
      ctx.logger.warn('%s registration refused (%s); restart dsh to clear a stale registration', what, error && error.message)
    }
  }

  const homePath = (segment) => {
    try {
      return dshHomePath(segment)
    } catch (error) {
      ctx.logger.warn('dshHomePath unavailable (%s)', error && error.message)
      return null
    }
  }

  const configured = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

  /** Key file path: configured, else `$DSH_HOME/dsh-git.key`.
   *
   * One rule, deliberately: the key lives in the same harness home as the
   * record it opens, so a home that is recreated takes both with it and a home
   * that is kept keeps both. A deployment that wants the key on another volume
   * (because it persists the credentials document there too) sets `keyFile`.
   */
  const keyFilePath = () => {
    const explicit = configured(config.keyFile.get())
    if (explicit !== null) return explicit
    const fallback = homePath('dsh-git.key')
    return fallback === null ? join(process.cwd(), '.dsh-git.key') : fallback
  }

  /** Socket path: configured, else `$DSH_HOME/dsh-git.sock`. */
  const socketPath = () => {
    const explicit = configured(config.socketPath)
    if (explicit !== null) return explicit
    const fallback = homePath('dsh-git.sock')
    return fallback === null ? join(process.cwd(), '.dsh-git.sock') : fallback
  }

  const helperPath = fileURLToPath(new URL('./credhelper.cjs', import.meta.url))
  const host = () => configured(config.host.get()) || 'github.com'
  const username = () => configured(config.username.get()) || 'x-access-token'

  /** The exact helper command written into git config, socket path included. */
  const helperCommand = () => (
    '!node ' + JSON.stringify(helperPath) + ' --socket ' + JSON.stringify(socketPath())
  )

  // ---- the credential seam ------------------------------------------------
  // The record half of `ctx.credentials` is the only storage this plugin uses:
  // it is 0600, its mode is checked at every load, and its payload is opaque to
  // the seam, which is what makes it a legal home for sealed bytes.
  let credentials = null
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentials = credentialsCtx.credentials
    // The boot-time refresh in the socket effect has already run against a
    // null service and cached nothing, so this is the refresh that makes a
    // restart over an already-stored record serve git again. Deferred to a
    // microtask because `refreshTokenCache` is assigned later in apply() and
    // an injection may fire before apply() has returned.
    queueMicrotask(() => { void refreshTokenCache() })
  })

  const requireCredentials = () => {
    if (credentials === null) throw new Error('dsh-git: the credentials service is not mounted in this composition')
    return credentials
  }

  const readPayload = async () => {
    if (credentials === null) return null
    const record = await credentials.readRecord(CREDENTIAL_KEY)
    if (record === undefined || record === null) return null
    if (record.kind !== 'grant') {
      throw new Error('dsh-git: record ' + CREDENTIAL_KEY + ' holds a ' + String(record.kind) + ' record, not a sealed payload')
    }
    return record.payload
  }

  const writePayload = async (payload) => {
    await requireCredentials().modifyRecord(CREDENTIAL_KEY, () => ({ kind: 'grant', payload }))
  }

  const deletePayload = async () => {
    await requireCredentials().deleteRecord(CREDENTIAL_KEY)
  }

  // ---- the key ------------------------------------------------------------
  // One path, both ways. A read never mints a key (`create: false`), because an
  // absent key file means the record cannot be opened right now and saying so is
  // the honest answer — it also keeps a status read from writing to disk at all.
  // The one write path, {@link storeToken}, creates the file.
  const currentKey = () => loadKeyFile(keyFilePath(), { create: false })

  /** Whether the stored payload can be opened right now, and why not when it cannot. */
  const probe = async () => {
    let payload
    try {
      payload = await readPayload()
    } catch (error) {
      // A record this plugin did not write is a state worth showing, not a
      // failure of the status route.
      return { configured: true, readable: false, error: error && error.message }
    }
    if (payload === null) return { configured: false, readable: false, error: null }
    try {
      open(currentKey(), payload, AAD)
      return { configured: true, readable: true, error: null }
    } catch (error) {
      return { configured: true, readable: false, error: error && error.message }
    }
  }

  /** Seal one token under the key file and store it. */
  const storeToken = async (token) => {
    const payload = seal(loadKeyFile(keyFilePath()), token, AAD)
    await writePayload(payload)
    return payload
  }

  /** The token a `get` should answer with, or null while nothing is available. */
  const readToken = async () => {
    try {
      const payload = await readPayload()
      if (payload === null) return null
      const key = currentKey()
      if (key === null) return null
      return open(key, payload, AAD)
    } catch (error) {
      // A locked or unreadable vault answers "no credential"; the reason stays
      // on the host side, where the Settings card can show it.
      ctx.logger.warn('credential unavailable: %s', error && error.message)
      return null
    }
  }

  // ---- git configuration --------------------------------------------------
  /** Every helper git is configured with for this host. */
  const configuredHelpers = () => {
    try {
      return execFileSync('git', ['config', '--global', '--get-all', 'credential.https://' + host() + '.helper'], {
        encoding: 'utf8',
        timeout: 10_000,
      }).split('\n').map(line => line.trim()).filter(line => line.length > 0)
    } catch {
      // `git config --get-all` exits 1 when the key is simply absent.
      return []
    }
  }

  const helperInstalled = () => configuredHelpers().some(entry => entry.includes(helperPath))

  /** Point git at the bundled helper once, without touching any other helper. */
  const ensureGitConfig = () => {
    if (config.manageGitConfig !== true) return
    if (helperInstalled()) return
    try {
      execFileSync('git', ['config', '--global', '--add', 'credential.https://' + host() + '.helper', helperCommand()], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      ctx.logger.info('registered the git credential helper for %s', host())
    } catch (error) {
      ctx.logger.warn('could not register the git credential helper (%s)', error && error.message)
    }
  }

  // ---- repository ownership ----------------------------------------------
  // Read-only, deliberately: git reads its exception list from the *global*
  // `safe.directory`, and an entry this plugin wrote there could not be told
  // apart from one an operator wrote by hand. The report names the repositories
  // git will refuse, so the fix is a `chown` on the host.
  const ownership = () => ownershipReport(configured(config.scanRoot) ?? DEFAULT_SCAN_ROOT)

  // ---- the credential socket ---------------------------------------------
  // The socket handler is synchronous and the record read is not, so `get`
  // answers from one decrypted copy that is refreshed on every write, lock, and
  // start. The copy lives in this process's memory only.
  let tokenCache = null

  const socket = createCredentialSocket({
    socketPath: socketPath(),
    // Read per request rather than captured here: this is what makes `host` and
    // `username` honestly volatile, since the socket itself binds only once.
    get host() { return host() },
    get username() { return username() },
    secret: () => tokenCache,
    logger: ctx.logger,
  })

  const refreshTokenCache = async () => {
    tokenCache = await readToken()
    return tokenCache
  }

  guard('credential socket', () => {
    ctx.effect(() => {
      socket.start()
      void refreshTokenCache()
      return () => socket.stop()
    }, 'dsh-git: credential socket')
  })

  guard('git credential helper', () => ensureGitConfig())

  // ---- uninstall cleanup --------------------------------------------------
  // A dispose is not an uninstall: it is also a configuration reload, an
  // upgrade, and a shutdown, and deleting the token on any of those would be
  // silent credential loss. So the disposer only starts watching, and the
  // cleanup happens once the package has really left the profile — which is what
  // `pnpm remove` does a moment later, from the Plugin Manager or from
  // `dsh plugin remove`, whose manifest write the harness reloads on.
  /** Remove every helper entry this plugin wrote, leaving other tools' entries alone. */
  const removeHelperEntries = () => {
    const key = 'credential.https://' + host() + '.helper'
    const values = configuredHelpers()
    const mine = values.filter(entry => entry.includes(helperPath))
    if (mine.length === 0) return 0
    const run = (args) => execFileSync('git', ['config', '--global', ...args], { encoding: 'utf8', timeout: 10_000 })
    run(['--unset-all', key])
    for (const entry of values.filter(value => !value.includes(helperPath))) run(['--add', key, entry])
    return mine.length
  }

  /** Everything this plugin left on the machine: the record, the key, the helper entry. */
  const removeInstalledState = async () => {
    const removed = []
    try {
      if (removeHelperEntries() > 0) removed.push('git helper entry')
    } catch (error) {
      ctx.logger.warn('uninstall: could not remove the git helper entry (%s)', error && error.message)
    }
    try {
      const file = keyFilePath()
      if (existsSync(file)) {
        rmSync(file, { force: true })
        removed.push('key file')
      }
    } catch (error) {
      ctx.logger.warn('uninstall: could not remove the key file (%s)', error && error.message)
    }
    try {
      // Idempotent: deleting an absent record is a no-op in the seam, and an
      // absent one is not reported as removed.
      if (await readPayload() !== null) {
        await deletePayload()
        removed.push('credential record')
      }
    } catch (error) {
      ctx.logger.warn('uninstall: could not remove the credential record (%s)', error && error.message)
    }
    ctx.logger.info('dsh-git uninstalled: removed %s, so a reinstall starts from a clean machine', removed.length > 0 ? removed.join(', ') : 'nothing (already clean)')
  }

  /**
   * Watch for this package leaving the profile, then clean up.
   *
   * Bounded and unref'd: a shutdown must not be held open by it, and a plugin
   * that is merely reloaded keeps its installed path and removes nothing. The
   * profile's own install is the path to watch — a linked checkout stays behind
   * either way, so it is the symlink in `node_modules` that goes away.
   */
  const watchForRemoval = () => {
    let profile = null
    try {
      profile = ctx.get('profileContext')
    } catch {
      return
    }
    const dir = profile && typeof profile.dir === 'string' ? profile.dir : null
    if (dir === null) return
    const installed = join(dir, 'node_modules', name)
    const deadline = Date.now() + REMOVAL_WINDOW_MS
    const timer = setInterval(() => {
      const gone = !existsSync(installed)
      if (!gone && Date.now() < deadline) return
      clearInterval(timer)
      if (gone) void removeInstalledState()
    }, REMOVAL_POLL_MS)
    timer.unref()
  }

  guard('uninstall cleanup', () => ctx.effect(() => () => { watchForRemoval() }, 'dsh-git: uninstall cleanup'))

  // ---- browser routes (inside the auth fence) -----------------------------
  const readJsonBody = async (request) => {
    try {
      return await request.json()
    } catch {
      return null
    }
  }

  const state = async () => {
    const status = await probe()
    const file = keyFileState(keyFilePath())
    return {
      ok: true,
      credentialKey: name + '/' + CREDENTIAL_ID,
      configured: status.configured,
      readable: status.readable,
      error: status.error,
      credentials: credentials !== null,
      keyFile: file,
      socketPath: socketPath(),
      host: host(),
      username: username(),
      helper: { path: helperPath, command: helperCommand(), installed: helperInstalled() },
      manageGitConfig: config.manageGitConfig === true,
      ownership: ownership(),
    }
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const route = (definition) => guard(definition.path + ' route', () => {
      connectionCtx.connection.fetch.register(definition)
    })

    route({
      path: '/api/dsh-git.state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json(200, await state())
        } catch (error) {
          return json(500, { ok: false, error: error && error.message })
        }
      },
    })

    route({
      path: '/api/dsh-git.token',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request)
        const token = normalizeToken(body && body.token)
        if (token === null) {
          return json(400, { ok: false, error: 'token must be a non-empty string without whitespace' })
        }
        try {
          await storeToken(token)
          await refreshTokenCache()
          return json(200, { ok: true, configured: true })
        } catch (error) {
          return json(400, { ok: false, error: error && error.message })
        }
      },
    })

    route({
      path: '/api/dsh-git.forget',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          await deletePayload()
          await refreshTokenCache()
          return json(200, { ok: true, configured: false })
        } catch (error) {
          return json(500, { ok: false, error: error && error.message })
        }
      },
    })
  })

  ctx.logger.info('dsh-git host active (sealed credential record, credential socket, Settings card, /api routes)')
}
