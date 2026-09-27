// Sealing check for dsh-git: the primitives that keep the token unreadable at
// rest, and the key file that opens it. Nothing here touches a live Harness.
//
//   node test/crypto-check.cjs
const assert = require('node:assert/strict')
const { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const checks = []
const check = (label, fn) => {
  try {
    fn()
    checks.push([label, true, ''])
  } catch (error) {
    checks.push([label, false, error && error.message])
  }
}
const throws = (fn, pattern) => {
  try {
    fn()
  } catch (error) {
    assert.match(error.message, pattern)
    return
  }
  throw new Error('expected a throw matching ' + pattern)
}

;(async () => {
  const crypto = await import('../lib/crypto.js')
  const { AAD, KEY_BYTES, deriveKey, keyFileState, loadKeyFile, modeString, open, randomKey, randomSalt, seal } = crypto

  const HOME = mkdtempSync(join(tmpdir(), 'dsh-git-crypto-'))
  const keyPath = join(HOME, 'test.key')

  // ---- sealing -------------------------------------------------------------
  check('a sealed payload round-trips', () => {
    const key = randomKey()
    const payload = seal(key, 'github_pat_example')
    assert.equal(payload.v, 1)
    assert.equal(payload.alg, 'aes-256-gcm')
    assert.equal(payload.aad, AAD)
    assert.equal(open(key, payload), 'github_pat_example')
  })
  check('the plaintext never appears in the payload', () => {
    const payload = seal(randomKey(), 'github_pat_example')
    assert.equal(JSON.stringify(payload).includes('github_pat_example'), false)
  })
  check('two seals of one plaintext differ (fresh IV)', () => {
    const key = randomKey()
    assert.notEqual(seal(key, 'same').iv, seal(key, 'same').iv)
    assert.notEqual(seal(key, 'same').ct, seal(key, 'same').ct)
  })
  check('a wrong key fails on the tag, not with garbage', () => {
    const payload = seal(randomKey(), 'github_pat_example')
    throws(() => open(randomKey(), payload), /failed authentication/)
  })
  check('a tampered ciphertext fails', () => {
    const key = randomKey()
    const payload = seal(key, 'github_pat_example')
    const bytes = Buffer.from(payload.ct, 'base64')
    bytes[0] = bytes[0] ^ 0x01
    throws(() => open(key, { ...payload, ct: bytes.toString('base64') }), /failed authentication/)
  })
  check('a tampered tag fails', () => {
    const key = randomKey()
    const payload = seal(key, 'github_pat_example')
    const bytes = Buffer.from(payload.tag, 'base64')
    bytes[0] = bytes[0] ^ 0x01
    throws(() => open(key, { ...payload, tag: bytes.toString('base64') }), /failed authentication/)
  })
  check('a payload bound to another record is refused before decryption', () => {
    const payload = seal(randomKey(), 'github_pat_example', 'dsh-git/other')
    throws(() => open(randomKey(), payload), /not a dsh-git\/github payload \(aad/)
  })
  check('a payload from a future version is refused', () => {
    const payload = { ...seal(randomKey(), 'x'), v: 2 }
    throws(() => open(randomKey(), payload), /version 2/)
  })
  check('a record with a missing field is refused', () => {
    const payload = { ...seal(randomKey(), 'x'), tag: '' }
    throws(() => open(randomKey(), payload), /missing tag/)
  })

  // ---- passphrase KDF ------------------------------------------------------
  check('the KDF is deterministic and salt-dependent', () => {
    const salt = randomSalt()
    assert.equal(deriveKey('pw', salt).toString('hex'), deriveKey('pw', salt).toString('hex'))
    assert.notEqual(deriveKey('pw', salt).toString('hex'), deriveKey('pw', randomSalt()).toString('hex'))
    assert.equal(deriveKey('pw', salt).length, KEY_BYTES)
  })
  check('the KDF works at the declared parameters (maxmem is raised)', () => {
    const key = deriveKey('correct horse battery staple', randomSalt())
    assert.equal(key.length, KEY_BYTES)
  })
  check('a passphrase-sealed payload opens only with that passphrase', () => {
    const salt = randomSalt()
    const payload = seal(deriveKey('right', salt), 'github_pat_example')
    assert.equal(open(deriveKey('right', salt), payload), 'github_pat_example')
    throws(() => open(deriveKey('wrong', salt), payload), /failed authentication/)
  })

  // ---- key file ------------------------------------------------------------
  check('a missing key file is created with mode 600', () => {
    const key = loadKeyFile(keyPath)
    assert.equal(key.length, KEY_BYTES)
    assert.equal(modeString(statSync(keyPath).mode), '600')
    assert.equal(keyFileState(keyPath).safe, true)
  })
  check('the same key file yields the same key', () => {
    assert.equal(loadKeyFile(keyPath).toString('hex'), loadKeyFile(keyPath).toString('hex'))
  })
  check('a key file readable beyond its owner is refused, with the fix in the message', () => {
    chmodSync(keyPath, 0o644)
    assert.equal(keyFileState(keyPath).safe, false)
    throws(() => loadKeyFile(keyPath), /readable beyond its owner \(mode 644\); run "chmod 600 /)
  })
  check('a short key file is refused', () => {
    const shortPath = join(HOME, 'short.key')
    writeFileSync(shortPath, Buffer.alloc(16), { mode: 0o600 })
    throws(() => loadKeyFile(shortPath), /must hold exactly 32 bytes \(found 16\)/)
  })
  check('create:false refuses to generate a key', () => {
    throws(() => loadKeyFile(join(HOME, 'absent.key'), { create: false }), /no key file at/)
  })
  check('modeString renders a permission the way stat does', () => {
    assert.equal(modeString(0o600), '600')
    assert.equal(modeString(0o644), '644')
    assert.equal(modeString(0o100600), '600')
  })

  // ---- report --------------------------------------------------------------
  let failed = 0
  for (const [label, ok, message] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
  }
  rmSync(HOME, { recursive: true, force: true })
  console.log('\nchecks:', checks.length, '| throwaway dir removed:', HOME)
  process.exit(failed === 0 ? 0 : 1)
})()
