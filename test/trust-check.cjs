// Ownership-report check for dsh-git: which repositories a folder holds, and
// which of them git would refuse for a foreign owner.
//
// The report is read-only by construction — this module never runs git and never
// touches a global config — so nothing here needs a throwaway ~/.gitconfig. A
// foreign-owned fixture cannot be created without root, so the mismatch path is
// exercised by comparing against an expected user this process is not.
//
//   node test/trust-check.cjs
const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, relative } = require('node:path')

const HOME = mkdtempSync(join(tmpdir(), 'dsh-git-trust-'))

const checks = []
const check = (label, fn) => {
  try {
    fn()
    checks.push([label, true, ''])
  } catch (error) {
    checks.push([label, false, error.message])
  }
}

// ---- a workspace to scan ---------------------------------------------------
const ROOT = join(HOME, 'workspace')
const repoAt = (relative) => {
  mkdirSync(join(ROOT, relative, '.git'), { recursive: true })
}
repoAt('repo-a')
repoAt('group/repo-b')
// Skipped on purpose: a dependency tree, a dot-directory, and a depth beyond
// the scan's bound.
mkdirSync(join(ROOT, 'node_modules/pkg/.git'), { recursive: true })
mkdirSync(join(ROOT, '.hidden/repo-c/.git'), { recursive: true })
mkdirSync(join(ROOT, 'deep/one/two/repo-d/.git'), { recursive: true })
mkdirSync(join(ROOT, 'plain'), { recursive: true })
// A linked worktree checkout: `.git` is a file, not a directory.
mkdirSync(join(ROOT, 'worktree'), { recursive: true })
writeFileSync(join(ROOT, 'worktree/.git'), 'gitdir: /nowhere\n')

const FOUND = [join(ROOT, 'group', 'repo-b'), join(ROOT, 'repo-a'), join(ROOT, 'worktree')].sort()

;(async () => {
  const { DEFAULT_SCAN_ROOT, ownershipReport } = await import('../lib/trust.js')

  check('the scan finds the repositories a folder holds', () => {
    const report = ownershipReport(ROOT)
    assert.equal(report.exists, true)
    assert.equal(report.checked, 3)
    assert.deepEqual(report.misowned, [])
    assert.equal(report.root, ROOT)
  })
  check('dependencies, dot-directories and the depth beyond the bound are skipped', () => {
    // The same fixture holds three repositories at three depths plus two that
    // must not be reached; the count is what proves the walk.
    assert.equal(ownershipReport(ROOT).checked, 3)
    assert.equal(ownershipReport(join(ROOT, 'deep', 'one', 'two', 'repo-d')).checked, 1)
  })
  check('the scan is bounded, and an absent root is empty rather than fatal', () => {
    assert.equal(ownershipReport(ROOT, { limit: 1 }).checked, 1)
    const absent = ownershipReport(join(HOME, 'absent'))
    assert.equal(absent.exists, false)
    assert.equal(absent.checked, 0)
    assert.deepEqual(absent.misowned, [])
  })
  check('an empty root falls back to the configured default', () => {
    assert.equal(ownershipReport('').root, DEFAULT_SCAN_ROOT)
    assert.equal(ownershipReport('   ').root, DEFAULT_SCAN_ROOT)
    assert.equal(DEFAULT_SCAN_ROOT, '/workspace')
  })
  check('a relative root resolves against the working directory', () => {
    assert.equal(ownershipReport(relative(process.cwd(), ROOT)).root, ROOT)
  })
  check('the expected user is this process, and is reported as `uid:gid`', () => {
    const report = ownershipReport(ROOT)
    assert.equal(report.user, process.getuid() + ':' + process.getgid())
  })
  check('a repository owned by another user is reported, with its owner and mode', () => {
    const stranger = process.getuid() + 1
    const report = ownershipReport(ROOT, { uid: stranger, gid: process.getgid() })
    assert.equal(report.checked, 3)
    assert.deepEqual(
      report.misowned.map((row) => row.path),
      FOUND,
    )
    assert.equal(report.user, stranger + ':' + process.getgid())
    for (const row of report.misowned) {
      assert.equal(row.uid, process.getuid())
      assert.equal(row.gid, process.getgid())
      assert.match(row.mode, /^[0-7]{3}$/)
    }
  })
  check('a group difference alone is not a mismatch', () => {
    // Git compares the user, not the group: a shared volume with another gid
    // must not be reported, or every container reports a false alarm.
    const report = ownershipReport(ROOT, { gid: process.getgid() + 1 })
    assert.deepEqual(report.misowned, [])
    assert.equal(report.user, process.getuid() + ':' + (process.getgid() + 1))
  })
  check('a folder that holds no repository reports none', () => {
    const empty = join(HOME, 'empty')
    mkdirSync(empty, { recursive: true })
    const report = ownershipReport(empty)
    assert.equal(report.exists, true)
    assert.equal(report.checked, 0)
    assert.deepEqual(report.misowned, [])
  })

  rmSync(HOME, { recursive: true, force: true })

  let failed = 0
  for (const [label, ok, message] of checks) {
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  <- ' + message))
  }
  console.log('\nchecks:', checks.length, '| throwaway home removed:', HOME)
  process.exit(failed === 0 ? 0 : 1)
})()
