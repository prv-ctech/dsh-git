// dsh-git — sealing primitives.
//
// The token is sealed with AES-256-GCM before it reaches any storage, and the
// key never enters the stored document. One key source exists: a 32-byte random
// key in a 0600 file. No KDF, because a random key is not guessable and
// stretching it buys nothing.
//
// The AAD binds a ciphertext to the record it belongs to, so a payload lifted
// from one record cannot be replayed into another.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Authenticated-encryption algorithm. */
export const ALGORITHM = 'aes-256-gcm'
/** Key length in bytes (AES-256). */
export const KEY_BYTES = 32
/** GCM nonce length in bytes. */
export const IV_BYTES = 12
/** Additional authenticated data every payload is bound to. */
export const AAD = 'dsh-git/github'
/** Payload schema version. */
export const PAYLOAD_VERSION = 1

/** A fresh 32-byte key. */
export function randomKey() {
  return randomBytes(KEY_BYTES)
}

/**
 * Seal one plaintext into a JSON-safe payload.
 * @param key - 32-byte key.
 * @param plaintext - the secret to seal.
 * @param aad - additional authenticated data; defaults to {@link AAD}.
 * @returns the payload, safe to store as an opaque credential record.
 */
export function seal(key, plaintext, aad = AAD) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()])
  return {
    v: PAYLOAD_VERSION,
    alg: ALGORITHM,
    aad,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
}

/**
 * Open a payload sealed by {@link seal}.
 * @param key - the same 32-byte key.
 * @param payload - the stored payload.
 * @param aad - the AAD the payload must carry.
 * @returns the plaintext.
 * @throws when the payload is foreign, truncated, tampered with, or sealed
 *   under another key.
 */
export function open(key, payload, aad = AAD) {
  assertPayload(payload, aad)
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'))
  decipher.setAAD(Buffer.from(payload.aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(payload.ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('dsh-git: ciphertext failed authentication — wrong key or passphrase, or a modified record')
  }
}

/**
 * Refuse a payload this record could not have produced, before touching the
 * cipher: a foreign version, algorithm, or AAD is a wiring error, not a
 * decryption failure, and the two deserve different messages.
 */
export function assertPayload(payload, aad = AAD) {
  const problem = (message) => {
    throw new Error('dsh-git: stored record is not a ' + AAD + ' payload (' + message + ')')
  }
  if (payload === null || typeof payload !== 'object') problem('not an object')
  if (payload.v !== PAYLOAD_VERSION) problem('version ' + String(payload.v))
  if (payload.alg !== ALGORITHM) problem('algorithm ' + String(payload.alg))
  if (payload.aad !== aad) problem('aad ' + String(payload.aad))
  for (const field of ['iv', 'tag', 'ct']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) problem('missing ' + field)
  }
  return payload
}

/** Display one permission mode the way `stat` does, e.g. `600`. */
export function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

/**
 * Presence, size, and permissions of a key file. Never throws: a missing file
 * is a normal state (it is created on first use).
 * @param path - the key file.
 * @returns the facts a configuration surface may show.
 */
export function keyFileState(path) {
  try {
    const stat = statSync(path)
    const mode = stat.mode & 0o777
    return { path, exists: true, mode: modeString(mode), safe: (mode & 0o077) === 0, bytes: stat.size }
  } catch {
    return { path, exists: false, mode: null, safe: false, bytes: 0 }
  }
}

/**
 * Read the key file, creating it with 0600 on first use.
 *
 * The permission check mirrors the credential provider's own rule: a key
 * readable beyond its owner is refused rather than used, because a key other
 * accounts can read is not a key.
 * @param path - the key file.
 * @param options - `create: false` refuses to generate a missing file.
 * @returns the 32-byte key.
 */
export function loadKeyFile(path, options = {}) {
  const create = options.create !== false
  if (!existsSync(path)) {
    if (!create) throw new Error('dsh-git: no key file at ' + path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // `wx` so two racing processes cannot clobber one another's key.
    writeFileSync(path, randomKey(), { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
  }
  const state = keyFileState(path)
  if (!state.safe) {
    throw new Error('dsh-git: ' + path + ' is readable beyond its owner (mode ' + state.mode + '); run "chmod 600 ' + path + '"')
  }
  const key = readFileSync(path)
  if (key.length !== KEY_BYTES) {
    throw new Error('dsh-git: ' + path + ' must hold exactly ' + KEY_BYTES + ' bytes (found ' + key.length + ')')
  }
  return key
}
