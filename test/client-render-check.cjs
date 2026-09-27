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
/** Every dgg- class the code mentions. */
const referencedClasses = () => new Set(
  [...code.matchAll(/"([^"]*\bdgg-[^"]*)"/g)]
    .flatMap(match => match[1].split(/\s+/))
    .filter(token => token.length > 0)
    .map(token => token.replace(/^\./, '')),
)
/** Every dgg- class the stylesheet declares. */
const declaredClasses = () => new Set([...body.matchAll(/\.(dgg-[a-z0-9-]+)/g)].map(match => match[1]))
/** Fields the host state route answers, read off the route itself. */
const stateFields = () => {
  const start = index.indexOf('const state = async () => {')
  const end = index.indexOf('\n  }', start)
  return new Set([...index.slice(start, end).matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]))
}

// ---- registration ----------------------------------------------------------
check('the bundle registers itself under the package name', () => {
  assert.match(head, /__ModuleLoader__\.load\(\{/)
  assert.match(head, /id:\s*"dsh-git"/)
  assert.equal(manifest.name, 'dsh-git')
})
check('the registration only registers: react and the primitives load in the factory', () => {
  assert.match(client, /factory:\s*\(require\)\s*=>/)
  assert.equal(/require\("react"\)/.test(head), false, 'react is required at load time')
  assert.match(body, /require\("react"\)/)
  assert.equal(/require\(["']dsh-client-ui-primitives/.test(head), false, 'the primitives are required at load time')
  assert.match(body, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/)
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
check('the primitives are the shell\'s seeded module, not a dependency to install', () => {
  // The web shell seeds this module beside react; every first-party settings
  // page requires it the same way and none of them declares it.
  const declared = [...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.peerDependencies || {})]
  assert.equal(declared.includes('@deepseek-ai/dsh-client-ui-primitives'), false,
    'the primitives must not be declared: the shell seeds them')
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
check('the card is built from the harness\'s own settings components', () => {
  for (const component of ['SettingsForm', 'SettingsFormModel', 'SettingsSecretField', 'StateDot', 'Button', 'DisclosureRow']) {
    assert.ok(body.includes(component), 'the native ' + component + ' is not used')
  }
  assert.equal(/h\(\s*"input"/.test(body), false, 'the page still hand-rolls an input')
  assert.equal(/h\(\s*"style"/.test(body), false, 'the page still hand-rolls chrome')
})
check('the token is staged by the native form model, and saved by its save', () => {
  assert.match(body, /new SettingsFormModel\(scope, \[\]/)
  assert.match(body, /field:\s*TOKEN_FIELD,\s*write:\s*\(text\) => this\.writeToken\(text\)/)
  assert.match(body, /props\.edit\(TOKEN_FIELD, text\)/)
  assert.match(body, /hooks:\s*\{\s*gitCard:\s*this\.store\s*\}/)
  assert.match(body, /props\.useGitCard\(/)
  assert.match(body, /\.\.\.this\.form\.actions\(\)/)
})
check('the token draft reaches the native write-only control and nothing else', () => {
  assert.match(body, /text:\s*state\.token\.text/)
  assert.equal(/type:\s*"password"/.test(body), false, 'a hand-rolled password input is left over')
  assert.equal((body.match(/React\.useState\(/g) || []).length, 1, 'React state must hold the disclosure toggle only')
  assert.match(body, /post\(API\.token, \{ token: text \}\)/)
})
check('the details are folded away in the native disclosure row', () => {
  assert.match(body, /h\(\s*DisclosureRow/)
  assert.match(body, /title:\s*t\("details\.title"\)/)
  assert.match(body, /expandOnRowClick:\s*true/)
})
check('the ownership block offers the host command, not a git-config write', () => {
  assert.match(body, /status\.ownership/)
  assert.match(body, /"chown -R " \+ ownership\.user/)
  assert.match(body, /misowned\.map\(\(row\) => row\.path\)/)
})
check('there is no unlock mode, passphrase or safe.directory left in the browser half', () => {
  assert.equal(/unlock|passphrase|safe\.directory|TRUST_ALL/u.test(body), false, 'a removed feature is still referenced')
})

// ---- nothing here can read a secret back ----------------------------------
check('every host field the card reads is one the state route actually answers', () => {
  const answered = stateFields()
  assert.ok(answered.size >= 10, 'the state route answers too little to compare: ' + [...answered].join(','))
  // A quoted `"status.ready"` is a dictionary key, not a host field read.
  const reads = new Set([...body.matchAll(/(?<!["'\w.])status\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1]))
  assert.ok(reads.size > 0, 'the card reads no host state at all')
  for (const field of reads) assert.ok(answered.has(field), 'the card reads an unanswered field: ' + field)
})
check('no host field the card reads can carry a secret', () => {
  const reads = [...body.matchAll(/(?<!["'\w.])status\.([A-Za-z][A-Za-z0-9]*)/g)].map(match => match[1])
  for (const field of reads) assert.equal(/token|passphrase|secret|password/i.test(field), false, 'secret-bearing field: ' + field)
})
check('every request goes to this plugin\'s own routes, with the cookie', () => {
  const paths = [...body.matchAll(/["'](\/api\/[^"']+)["']/g)].map(match => match[1])
  assert.deepEqual([...new Set(paths)].sort(),
    ['/api/dsh-git.forget', '/api/dsh-git.state', '/api/dsh-git.token'])
  for (const path of paths) assert.ok(index.includes("path: '" + path + "'"), 'no such host route: ' + path)
  assert.equal((body.match(/credentials:\s*"include"/g) || []).length, 2, 'the state and POST helpers must both send the cookie')
})

// ---- the page, executed ----------------------------------------------------
// The checks above prove the bundle says the right things. These run it: the
// registration is loaded with stand-ins for react and for the primitives, and
// the page the slot registers is rendered against host states that must take
// different branches.
function loadPage() {
  let registration = null
  new Function('window', client)({ __ModuleLoader__: { load: (spec) => { registration = spec } } })
  assert.equal(registration.id, 'dsh-git')
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [initial, () => {}],
  }
  const primitives = {
    SettingsForm: 'SettingsForm',
    SettingsSecretField: 'SettingsSecretField',
    StateDot: 'StateDot',
    Button: 'Button',
    DisclosureRow: 'DisclosureRow',
    IconInfoOutlineRegular: 'IconInfo',
    SettingsFormModel: class {
      bind(project) {
        this.projection = project
        return { set: () => {} }
      }
      shell() {
        return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
      }
      field() {
        return { text: '', overridden: false, invalid: false }
      }
      actions() {
        return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
      }
      dispose() {}
    },
  }
  const module = registration.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('unexpected require: ' + id)
  })
  let tab = null
  module.apply({
    effect: (fn) => { fn() },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => { tab = { spec, component } },
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true, value: {}, revision: 1 }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
    },
  })
  return tab
}

const page = loadPage()
/** Every node of one type in a rendered tree. */
const findAll = (node, type, found = []) => {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (node.type === type) found.push(node)
  for (const child of node.children || []) findAll(child, type, found)
  return found
}
/** Every string in a rendered tree, which is how copy is asserted. */
const texts = (node, found = []) => {
  if (Array.isArray(node)) {
    for (const child of node) texts(child, found)
    return found
  }
  if (typeof node === 'string') {
    found.push(node)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  for (const child of node.children || []) texts(child, found)
  return found
}
const status = (overrides = {}) => ({
  ok: true,
  credentialKey: 'dsh-git/github',
  configured: true,
  readable: true,
  error: null,
  keyFile: { path: '/home/.dsh/dsh-git.key', exists: true, mode: '600', safe: true },
  socketPath: '/home/.dsh/dsh-git.sock',
  host: 'github.com',
  username: 'x-access-token',
  helper: { path: '/repo/lib/credhelper.cjs', installed: true },
  ownership: { root: '/workspace', exists: true, user: '99:100', checked: 3, misowned: [] },
  ...overrides,
})
const projection = (hostStatus, extra = {}) => ({
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
  token: { text: '', overridden: false, invalid: false },
  status: hostStatus,
  error: null,
  ...extra,
})
const render = (state, handlers = {}) => page.component({
  t: (key) => key,
  useGitCard: (select) => select(state),
  save: handlers.save || (() => {}),
  discard: handlers.discard || (() => {}),
  edit: handlers.edit || (() => {}),
  forget: handlers.forget || (() => {}),
})

check('the page registers one settings.section tab under the entry id', () => {
  assert.equal(page.spec.name, 'settings.section')
  assert.equal(page.spec.id, 'git')
  assert.equal(page.spec.locale, 'git')
  assert.equal(typeof page.component, 'function')
  assert.equal(page.spec.label(), 'nav')
})
check('the page renders, and says what the host reported', () => {
  assert.ok(texts(render(projection(status()))).includes('status.ready'))
  assert.ok(texts(render(projection(status({ configured: false, readable: false, keyFile: { path: '/home/.dsh/dsh-git.key', exists: false, mode: null, safe: false } })))).includes('status.none'))
  assert.ok(texts(render(projection(status({ readable: false, error: 'wrong key' })))).includes('status.unreadable'))
  const unreachable = texts(render(projection(null)))
  assert.ok(unreachable.includes('status.unknown'))
  assert.ok(unreachable.includes('unavailable'))
})
check('the state dot follows the same three facts', () => {
  const dot = (state) => findAll(render(state), 'StateDot')[0].props.state
  assert.equal(dot(projection(status())), 'done')
  assert.equal(dot(projection(status({ configured: false, readable: false }))), 'idle')
  assert.equal(dot(projection(status({ readable: false }))), 'warning')
  assert.equal(dot(projection(null)), 'idle')
})
check('the token control is the native one, told what the host said', () => {
  const ready = findAll(render(projection(status())), 'SettingsSecretField')[0].props
  assert.equal(ready.id, 'plugin-config-git-token')
  assert.equal(ready.configured, true)
  assert.equal(ready.stateLabel, 'token.set')
  assert.equal(ready.disabled, false)
  assert.equal(ready.text, '')
  const none = findAll(render(projection(status({ configured: false }))), 'SettingsSecretField')[0].props
  assert.equal(none.configured, false)
  assert.equal(none.stateLabel, 'token.unset')
})
check('the native form is handed the state and the slot\'s own save and discard', () => {
  const save = () => {}
  const discard = () => {}
  const form = findAll(render(projection(status()), { save, discard }), 'SettingsForm')[0].props
  assert.equal(form.onSave, save)
  assert.equal(form.onDiscard, discard)
  assert.equal(form.state.available, true)
  assert.equal(form.labels.save, 'save')
  assert.equal(form.labels.unavailable, 'unavailable')
})
check('the delete button is offered only while a record exists, and calls forget', () => {
  let forgotten = 0
  const button = findAll(render(projection(status()), { forget: () => { forgotten += 1 } }), 'Button')[0]
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.equal(forgotten, 1)
  assert.equal(findAll(render(projection(status({ configured: false }))), 'Button')[0].props.disabled, true)
})
check('the ownership line is the fix when a repository is foreign-owned, and quiet when it is not', () => {
  const foreign = texts(render(projection(status({
    ownership: { root: '/workspace', exists: true, user: '99:100', checked: 2, misowned: [{ path: '/workspace/other', uid: 0, gid: 0, mode: '755' }] },
  }))))
  assert.ok(foreign.includes('own.problem'), JSON.stringify(foreign))
  assert.ok(foreign.includes('chown -R 99:100 /workspace/other'), JSON.stringify(foreign))
  const clean = texts(render(projection(status())))
  assert.ok(clean.includes('own.clean'), JSON.stringify(clean))
  assert.equal(clean.some((line) => line.startsWith('chown')), false)
  const absent = texts(render(projection(status({ ownership: { root: '/none', exists: false, user: '99:100', checked: 0, misowned: [] } }))))
  assert.ok(absent.includes('own.missing'), JSON.stringify(absent))
  // No report at all (say a host half that predates the scan) renders nothing.
  assert.equal(texts(render(projection(status({ ownership: undefined })))).some((line) => line.startsWith('own.')), false)
})
check('the technical facts are folded away in the native disclosure row', () => {
  const details = findAll(render(projection(status())), 'DisclosureRow')[0]
  assert.equal(details.props.open, false)
  assert.equal(details.props.expandable, true)
  assert.equal(details.props.title, 'details.title')
  const lines = texts(details)
  assert.ok(lines.includes('dsh-git/github'), JSON.stringify(lines))
  assert.ok(lines.some((line) => line.includes('credhelper.cjs')), JSON.stringify(lines))
})

let failed = 0
for (const [label, ok, message] of checks) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
}
console.log('\nchecks:', checks.length, '| css classes:', declaredClasses().size, '| dictionary keys:', keysOf(blockOf('zh')).length)
process.exit(failed === 0 ? 0 : 1)
