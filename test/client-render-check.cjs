// The browser half, checked statically: it is a registration + a factory, and
// everything the card does has to line up with the host half and with the
// profile patch it is addressed through.
//
//   node test/client-render-check.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const index = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const checks = []
const check = (label, fn) => {
  try {
    fn()
    checks.push([label, true, ''])
  } catch (error) {
    checks.push([label, false, error.message])
  }
}

/** Everything before the factory runs at load; everything after is the bundle. */
const factoryAt = client.indexOf('factory:')
const head = client.slice(0, factoryAt)
const body = client.slice(factoryAt)
/** The bundle's code with the stylesheet stripped: CSS is not a class reference. */
const code = (() => {
  const start = body.indexOf('const STYLES = `')
  const end = body.indexOf('`;', start)
  return start === -1 ? body : body.slice(0, start) + body.slice(end)
})()
const keysOf = (text) => [...text.matchAll(/"([^"]+)":/g)].map(match => match[1]).sort()
const blockOf = (name) => {
  const start = body.indexOf('const ' + name + ' = {')
  const end = body.indexOf('};', start)
  return body.slice(start, end)
}
/** Translation calls, excluding method names that merely end in `t(`. */
const requestedKeys = () => [...code.matchAll(/(?<![A-Za-z0-9_$.])t\("([^"]+)"\)/g)].map(match => match[1])
/** Every dgg- class the code mentions, including concatenated state suffixes. */
const referencedClasses = () => new Set(
  [...code.matchAll(/"([^"]*\bdgg-[^"]*)"/g)]
    .flatMap(match => match[1].split(/\s+/))
    .filter(token => token.length > 0)
    .map(token => token.replace(/^\./, '')),
)
/** Every dgg- class the stylesheet declares. */
const declaredClasses = () => new Set([...body.matchAll(/\.(dgg-[a-z0-9-]+)/g)].map(match => match[1]))

// ---- registration ----------------------------------------------------------
check('the bundle registers itself under the package name', () => {
  assert.match(head, /__ModuleLoader__\.load\(\{/)
  assert.match(head, /id:\s*"dsh-git"/)
  assert.equal(manifest.name, 'dsh-git')
})
check('the registration only registers: React is required inside the factory', () => {
  assert.match(client, /factory:\s*\(require\)\s*=>/)
  assert.equal(/require\("react"\)/.test(head), false, 'react is required at load time')
  assert.match(body, /require\("react"\)/)
})
check('the factory exports apply and inject', () => {
  assert.match(body, /exports\.apply\s*=/)
  assert.match(body, /exports\.inject\s*=/)
  assert.match(body, /return module\.exports/)
})
check('inject names the four services the card needs, and no more', () => {
  const match = /const inject = \[([^\]]*)\]/.exec(body)
  assert.ok(match, 'no inject array')
  const services = match[1].split(',').map(entry => entry.trim().replace(/^"|"$/g, '')).filter(Boolean).sort()
  assert.deepEqual(services, ['configForms', 'locale', 'remote', 'slots'])
})

// ---- the namespace it speaks to -------------------------------------------
check('the entry id equals the row id in the bundle patch', () => {
  assert.match(body, /const ENTRY_ID = "git"/)
  assert.match(patch, /- insert:\s*\n\s*- id: git\s*\n\s*name: dsh-git/)
  assert.equal((patch.match(/^\s*- id:/gm) || []).length, 1, 'the patch inserts more than one row')
})
check('the patch declares no config block, so defaults and the user layer cannot duplicate', () => {
  assert.equal(/^\s*config:/m.test(patch), false)
  assert.equal(/^\s*name:\s*\S+\s*$/m.test(patch), true)
})

// ---- dictionaries ---------------------------------------------------------
check('both dictionaries declare the same keys', () => {
  assert.deepEqual(keysOf(blockOf('zh')), keysOf(blockOf('en')))
})
check('every requested key is declared', () => {
  const declared = new Set([...keysOf(blockOf('zh')), ...keysOf(blockOf('en'))])
  const requested = requestedKeys()
  assert.ok(requested.length > 0, 'no key is requested at all')
  for (const key of requested) assert.ok(declared.has(key), 'undeclared key: ' + key)
})
check('every declared key is requested', () => {
  const declared = new Set(keysOf(blockOf('zh')))
  const requested = new Set(requestedKeys())
  for (const key of declared) assert.ok(requested.has(key), 'unused key: ' + key)
})

// ---- styles ---------------------------------------------------------------
check('every referenced CSS class is declared', () => {
  const declared = declaredClasses()
  for (const token of referencedClasses()) assert.ok(declared.has(token), 'undeclared class: ' + token)
})
check('every declared CSS class is referenced', () => {
  const referenced = referencedClasses()
  for (const token of declaredClasses()) assert.ok(referenced.has(token), 'unreferenced class: ' + token)
})
check('the stylesheet is injected as an effect scoped to this plugin', () => {
  assert.match(body, /ctx\.effect\(/)
  assert.match(body, /tag\.dataset\.plugin = PLUGIN_ID/)
  assert.match(body, /tag\.remove\(\)/)
})

// ---- the page --------------------------------------------------------------
check('the page is registered as its own settings.section tab', () => {
  assert.match(body, /ctx\.slots\.inject\("settings\.section"/)
  assert.match(body, /name:\s*"settings\.section"/)
  assert.match(body, /id:\s*ENTRY_ID/)
  assert.match(body, /label:\s*\(\) => t\("nav"\)/)
  assert.match(body, /order:\s*\d+/)
  assert.match(body, /locale:\s*LOCALE_NS/)
  assert.equal(body.includes('settings.general.item'), false, 'a General row registration is left over')
})
check('the card writes through the one 0.1.7 settings transport', () => {
  assert.match(body, /ctx\.configForms\.get\(ENTRY_ID\)/)
  assert.match(body, /hooks:\s*\{\s*form\s*\}/)
  assert.match(body, /form\.set\("unlockMode", mode\)/)
})
check('the unlock pills offer exactly the host half\'s two modes', () => {
  const offered = [...body.matchAll(/modePill\("([^"]+)"/g)].map(match => match[1]).sort()
  const declared = JSON.parse(
    '[' + /UNLOCK_MODES = \[([^\]]+)\]/.exec(index)[1].split(',').map(part => part.trim().replace(/'/g, '"')).join(',') + ']',
  ).sort()
  assert.deepEqual(offered, declared)
  assert.deepEqual(declared, ['ask', 'keyfile'])
})
check('there is no environment mode left anywhere in the browser half', () => {
  assert.equal(client.includes('env'), false, 'the string "env" appears in the bundle')
})

// ---- nothing here can read a secret back ----------------------------------
check('every host field the card reads is one the state route actually answers', () => {
  const start = index.indexOf('const state = async () => {')
  const end = index.indexOf('\n  }', start)
  const answered = new Set([...index.slice(start, end).matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]))
  assert.ok(answered.size >= 10, 'the state route answers too little to compare: ' + [...answered].join(','))
  const reads = new Set([...body.matchAll(/\bstate\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1]))
  assert.ok(reads.size > 0, 'the card reads no state at all')
  for (const field of reads) assert.ok(answered.has(field), 'the card reads an unanswered field: ' + field)
})
check('none of those fields can carry a secret', () => {
  const reads = [...body.matchAll(/\bstate\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1])
  for (const field of reads) assert.equal(/token|passphrase|secret|password/i.test(field), false, 'secret-bearing field: ' + field)
  assert.equal(/\bstate\.token\b|\bstate\.passphrase\b/.test(body), false)
})
check('a secret is only ever sent, never rendered or kept', () => {
  assert.match(body, /JSON\.stringify\(body \|\| \{\}\)/)
  assert.match(body, /post\(API\.token, \{ token \}\)/)
  assert.match(body, /post\(API\.unlock, \{ passphrase \}\)/)
  assert.match(body, /setToken\(""\)/)
  assert.match(body, /setPassphrase\(""\)/)
})
check('the two secret inputs are write-only password fields', () => {
  const inputs = [...body.matchAll(/type:\s*"password"/g)]
  assert.equal(inputs.length, 2, 'expected two password inputs, found ' + inputs.length)
  assert.equal(/value:\s*state\./.test(body), false, 'a state value is rendered into an input')
})
check('every request goes to this plugin\'s own routes, with the cookie', () => {
  const paths = [...body.matchAll(/["'](\/api\/[^"']+)["']/g)].map(match => match[1])
  assert.deepEqual([...new Set(paths)].sort(),
    ['/api/dsh-git.forget', '/api/dsh-git.lock', '/api/dsh-git.state', '/api/dsh-git.token', '/api/dsh-git.unlock'])
  for (const path of paths) assert.ok(index.includes("path: '" + path + "'"), 'no such host route: ' + path)
  assert.equal((body.match(/credentials:\s*"include"/g) || []).length, 2, 'the state and POST helpers must both send the cookie')
})

let failed = 0
for (const [label, ok, message] of checks) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
}
console.log('\nchecks:', checks.length, '| css classes:', declaredClasses().size, '| dictionary keys:', keysOf(blockOf('zh')).length)
process.exit(failed === 0 ? 0 : 1)
