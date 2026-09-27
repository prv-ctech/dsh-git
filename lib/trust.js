// dsh-git — workspace ownership, read-only.
//
// Git refuses to touch a repository whose owner is not the current user
// ("detected dubious ownership"), and the only exception is `safe.directory` in
// the *global* config. This plugin deliberately never writes that key: an entry
// it wrote is indistinguishable from one an operator wrote by hand, so the fix it
// points at is ownership on the host. What it does instead is say which
// repositories git would refuse, so the answer is a `chown` on the host rather
// than an exception list nobody can audit.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { modeString } from './crypto.js'

/** The folder the scan walks unless configuration names another. */
export const DEFAULT_SCAN_ROOT = '/workspace'

/** How deep below the root a repository is still found. */
const MAX_DEPTH = 2

/** How many repositories one pass will ever look at, so a wrong root stays cheap. */
const MAX_REPOS = 200

/**
 * The repositories a folder holds: its own, plus those at most `maxDepth`
 * directories below it, with dependency trees and dot-directories skipped.
 * A linked worktree counts — its `.git` is a file.
 * @param root - the folder to scan.
 * @param maxDepth - how deep to walk.
 * @param limit - the most repositories one pass will find.
 * @returns sorted absolute repository paths.
 */
function scanRepos(root, maxDepth, limit) {
  const found = []
  if (typeof root !== 'string' || root.length === 0) return found
  const isRepo = (path) => existsSync(join(path, '.git'))
  if (isRepo(root)) found.push(root)
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // an unreadable directory contributes nothing
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (isRepo(path)) {
        found.push(path)
        continue
      }
      walk(path, depth + 1)
    }
  }
  walk(root, 1)
  return found.sort()
}

/**
 * The owner of one path, in the form git and `ls -n` report it.
 * @param path - the path to stat.
 * @returns `{ path, uid, gid, mode }`, or null when it cannot be read.
 */
function ownerOf(path) {
  try {
    const stat = statSync(path)
    return { path, uid: stat.uid, gid: stat.gid, mode: modeString(stat.mode) }
  } catch {
    return null
  }
}

/**
 * Which repositories under a folder git would refuse, and why.
 *
 * Git stats two things: the repository directory and the gitdir itself, so a
 * foreign owner on either one is reported (once per repository). Group differs
 * from the user's group on every container that mounts a shared volume and
 * breaks nothing, so only the user is compared.
 *
 * @param root - the folder to scan; empty or missing falls back to {@link DEFAULT_SCAN_ROOT}.
 * @param options - `uid`/`gid` to compare against (defaults to this process), plus
 *   `maxDepth`/`limit` for the test.
 * @returns the facts a status surface shows.
 */
export function ownershipReport(root, options = {}) {
  const uid = typeof options.uid === 'number' ? options.uid : process.getuid()
  const gid = typeof options.gid === 'number' ? options.gid : process.getgid()
  const path = resolve(typeof root === 'string' && root.trim().length > 0 ? root.trim() : DEFAULT_SCAN_ROOT)
  const facts = { root: path, user: uid + ':' + gid, exists: false, checked: 0, misowned: [] }
  let directory = false
  try {
    directory = statSync(path).isDirectory()
  } catch {
    directory = false
  }
  if (!directory) return facts
  const repos = scanRepos(path, options.maxDepth ?? MAX_DEPTH, options.limit ?? MAX_REPOS)
  const misowned = []
  for (const repo of repos) {
    const offender = [repo, join(repo, '.git')]
      .map(ownerOf)
      .find((owner) => owner !== null && owner.uid !== uid)
    if (offender !== undefined) misowned.push(offender)
  }
  return { ...facts, exists: true, checked: repos.length, misowned }
}
