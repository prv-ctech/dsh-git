// dsh-git — host half.
//
// What this plugin owns:
//
//   * the sealed GitHub token, stored as an opaque `grant` payload in the
//     harness credential record `dsh-git/github` (native seam, 0600 storage,
//     persistent dataset) — never as plaintext anywhere;
//   * the key that opens it, either a 0600 random-key file (default) or a
//     passphrase that lives only in this process's memory;
//   * a 0600 unix socket speaking git's credential protocol, so a child
//     process can authenticate git without the plaintext ever entering a tool
//     result;
//   * the Settings card's three transport routes, inside the browser-auth
//     fence: state, token, unlock.
//
// What it deliberately does not own: no route, command, or log line ever
// returns the token or the passphrase, so neither can reach a model context
// through this plugin.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { AAD, KDF, deriveKey, keyFileState, loadKeyFile, open, randomSalt, seal } from './crypto.js'
import { createCredentialSocket } from './socket.js'

/** Cordis plugin name. The credential record scope is this name. */
export const name = 'dsh-git'

/** The record's id segment; the address is `dsh-git/github`. */
export const CREDENTIAL_ID = 'github'

/** The full record address, as the seam joins it. */
export const CREDENTIAL_KEY = credentialKey(name, CREDENTIAL_ID)

/** Unlock sources. `env` was considered and dropped: it would mean editing the container. */
export const UNLOCK_MODES = ['keyfile', 'ask']

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
 * Empty string means "resolve it": the key file prefers a dataset beside
 * `$DSH_HOME` and falls back inside it, the socket path defaults into
 * `$DSH_HOME`.
 */
export const Config = z.object({
  /** How the token is unsealed: a 0600 key file, or a passphrase held in memory. */
  unlockMode: z.union(UNLOCK_MODES.map(mode => z.const(mode))).default('keyfile').volatile(),
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
  const unlockMode = () => (config.unlockMode.get() === 'ask' ? 'ask' : 'keyfile')

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

  // ---- unlocking ----------------------------------------------------------
  // `keyfile` reads a 0600 key on every operation, so a rotated key is felt at
  // once and nothing is cached. `ask` holds one derived key for the lifetime of
  // this process, and nothing on disk can open the record without the
  // passphrase being typed again after a restart.
  let sessionKey = null
  let sessionSalt = null

  /**
   * The key that opens the stored payload, or null while locked.
   *
   * This is a read path, so it never mints a key: an absent key file means the
   * record cannot be opened right now, and saying so is the honest answer.
   * (`create: false` also keeps a GET of the status from writing to disk at
   * all.) The one write path, {@link storeToken}, creates the file.
   */
  const currentKey = () => (unlockMode() === 'ask' ? sessionKey : loadKeyFile(keyFilePath(), { create: false }))

  /** The KDF block stored beside a passphrase-sealed payload. */
  const kdfBlock = (salt) => ({ kind: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') })

  /** Derive and remember the key for a passphrase, against the stored or a fresh salt. */
  const unlockWithPassphrase = async (passphrase) => {
    const payload = await readPayload()
    // Only a payload sealed by the passphrase carries scrypt parameters; a
    // keyfile payload (or none at all) means a fresh salt and the defaults.
    // Reusing a keyfile payload's block here would hand scrypt `undefined`.
    const stored = payload && payload.kdf && payload.kdf.kind === 'scrypt' ? payload.kdf : null
    const salt = stored === null ? randomSalt() : Buffer.from(stored.salt, 'base64')
    const key = deriveKey(passphrase, salt, stored === null ? KDF : stored)
    if (payload !== null) {
      // A successful open is the only proof the passphrase is the right one.
      open(key, payload, AAD)
    }
    sessionKey = key
    sessionSalt = salt
    return payload === null ? 'created' : 'unlocked'
  }

  /** Whether the stored payload can be opened right now, and why not when it cannot. */
  const probe = async () => {
    const payload = await readPayload()
    if (payload === null) return { configured: false, readable: false, locked: false, error: null }
    if (unlockMode() === 'ask' && sessionKey === null) {
      return { configured: true, readable: false, locked: true, error: null }
    }
    try {
      open(currentKey(), payload, AAD)
      return { configured: true, readable: true, locked: false, error: null }
    } catch (error) {
      return { configured: true, readable: false, locked: false, error: error && error.message }
    }
  }

  /** Seal one token under the current unlock mode and store it. */
  const storeToken = async (token) => {
    let key
    let kdf = null
    if (unlockMode() === 'ask') {
      if (sessionKey === null) {
        // A first write with no passphrase yet: derive one now so the record it
        // creates is openable by the same passphrase later.
        throw new Error('dsh-git: unlock the vault with your passphrase before storing a token')
      }
      key = sessionKey
      kdf = kdfBlock(sessionSalt)
    } else {
      key = loadKeyFile(keyFilePath())
      kdf = { kind: 'keyfile' }
    }
    const payload = { ...seal(key, token, AAD), kdf }
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
      unlockMode: unlockMode(),
      configured: status.configured,
      readable: status.readable,
      locked: status.locked,
      error: status.error,
      credentials: credentials !== null,
      keyFile: file,
      socketPath: socketPath(),
      host: host(),
      username: username(),
      helper: { path: helperPath, command: helperCommand(), installed: helperInstalled() },
      manageGitConfig: config.manageGitConfig === true,
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

    route({
      path: '/api/dsh-git.unlock',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request)
        const passphrase = typeof (body && body.passphrase) === 'string' ? body.passphrase : ''
        if (passphrase.length === 0) return json(400, { ok: false, error: 'passphrase must not be empty' })
        try {
          const outcome = await unlockWithPassphrase(passphrase)
          await refreshTokenCache()
          return json(200, { ok: true, outcome })
        } catch (error) {
          sessionKey = null
          sessionSalt = null
          return json(403, { ok: false, error: error && error.message })
        }
      },
    })

    route({
      path: '/api/dsh-git.lock',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        sessionKey = null
        sessionSalt = null
        await refreshTokenCache()
        return json(200, { ok: true, locked: unlockMode() === 'ask' })
      },
    })
  })

  ctx.logger.info('dsh-git host active (sealed credential record, credential socket, Settings card, /api routes)')
}
