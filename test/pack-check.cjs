// Publish-readiness check: what `npm pack` / `npm publish` would ship must carry
// everything a consumer's `dsh plugin add` needs after install — the bundle
// patch, both halves, the credential helper, the licence — and must leave the
// development-only files behind. It must also ship no runtime dependency at all:
// every harness package is an optional peer the loader supplies.
//
//   node test/pack-check.cjs
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/crypto.js',
  'lib/socket.js',
  'lib/credhelper.cjs',
]
const EXCLUDED = [/^test\//, /^node_modules\//, /^\.gitignore$/, /\.tgz$/]

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' }),
)[0]
const shipped = packed.files.map((file) => file.path)

let failed = 0
const check = (label, ok) => {
  if (!ok) failed += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
}

check(
  'the tarball is named after the package and version',
  packed.filename === manifest.name + '-' + manifest.version + '.tgz',
)
check(
  'every required file is shipped',
  REQUIRED.every((path) => shipped.includes(path)),
)
check(
  'no development-only file is shipped',
  shipped.every((path) => !EXCLUDED.some((pattern) => pattern.test(path))),
)
check(
  'the packed manifest declares the bundle patch',
  manifest.dsh?.bundle?.patch === './cordis.patch.yml' && shipped.includes('cordis.patch.yml'),
)
check(
  'the packed manifest declares the browser half',
  manifest.dsh?.client?.platform === 'web' &&
    manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings') &&
    manifest.exports['./client']?.default === './lib/client.js',
)
check(
  'the patch inserts the git row by package name',
  /- insert:[\s\S]*?id: git[\s\S]*?name: dsh-git/.test(patch),
)
check('the patch declares no config block', !/^\s*config:/m.test(patch))
check('the package declares no runtime dependency at all', manifest.dependencies === undefined)
check(
  'every harness package it imports is an optional peer',
  Object.keys(manifest.peerDependencies).length > 0 &&
    Object.keys(manifest.peerDependencies).every(
      (name) => manifest.peerDependenciesMeta?.[name]?.optional === true,
    ),
)
check(
  'it imports nothing but node builtins besides those peers',
  (() => {
    const imported = new Set(
      [...readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
        (match) => match[1],
      ),
    )
    for (const specifier of imported) {
      const bare = specifier.startsWith('node:') || specifier.startsWith('./')
      if (!bare) check('  ' + specifier, Boolean(manifest.peerDependencies[specifier]))
    }
    return true
  })(),
)
check('the version is a plain release version', /^\d+\.\d+\.\d+$/.test(manifest.version))

console.log('\npacked files:', shipped.length, '|', packed.filename, packed.size, 'bytes')
process.exit(failed === 0 ? 0 : 1)
