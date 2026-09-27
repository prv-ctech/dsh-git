# Changelog

Consumer-visible changes, newest first. Each entry is written with the change it
describes, and the release workflow refuses to publish a tag this file has no
section for.

Entries below 1.0 follow [SemVer](https://semver.org/spec/v2.0.0.html): a
breaking change ships as a **minor** bump, so read a minor as "may need a change
on your side".

## [0.2.1] - 2026-09-27

No behavioural change. The plugin does what 0.2.0 did; this release carries the
tooling and documentation that landed after it.

### Changed

- `lib/` is reformatted to the style the rest of the repo already uses — single
  quotes, no semicolons, and quotes off object keys that do not need them.
  Running the formatter over 0.2.0's `lib/` reproduces these files byte for byte,
  so what ships here is the same program, not a rewrite of it.
- The README documents rolling back: pin the tag before the one you are on. Every
  release keeps its own tarball, so an older tag stays installable.

## [0.2.0] - 2026-09-27

Breaking: ownership is now the only exception this plugin makes, and removing the
package now removes everything it wrote.

### Removed

- The allow-path exception list, the passphrase unlock mode, `safe.directory`
  writing, and the `.unlock`, `.lock` and `.trust` routes. A `0600` key file is
  the only key source left, and the plugin writes exactly one git config key: its
  own credential helper entry.

### Added

- Uninstall cleans up after itself. Once the package has actually left the
  profile, the credential record, the key file and the helper entry go with it. A
  dispose — a reload, an upgrade, a shutdown — deletes nothing, and neither does
  disabling the bundle, so a config edit cannot silently eat a token.

### Changed

- Settings → Git is rebuilt on the harness's own components (`SettingsForm`,
  `SettingsSecretField`, `StateDot`, `DisclosureRow`), so the token stages and
  saves the way every other settings page does, and the ownership warning uses
  the same row.
- Releases are version tags only. The rolling `latest` release is gone, so what a
  profile runs is always a version someone named, never a moving target.
- The README is rewritten around the current behaviour.

## [0.1.0] - 2026-09-27

First release.

### Added

- A **Git** tab in Settings. The page is write-only for secrets and reads status
  only.
- The token is sealed with AES-256-GCM inside the harness's own credential
  record and never leaves the host process.
- A bundled git credential helper: git asks the helper, the helper relays one
  `get` over a `0600` unix socket, and the host answers from the decrypted record
  in its own memory. The plaintext never enters a tool result, a git file, an
  environment variable, or a model context.
- An unlock mode that stretches a passphrase with scrypt.
- Ownership detection in the Settings card: every checkout git would refuse is
  named, with the `chown` that fixes it.

### Notes

- Nothing outside Node's standard library sits in the trust path. There is no
  environment-variable mode, by design.
