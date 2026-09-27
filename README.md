# dsh-git

GitHub credentials for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
0.1.7. The token is sealed with AES-256-GCM and stored in the harness's own
credential record; git reads it through a `0600` unix socket, so the plaintext
never enters a tool result, a git file, an environment variable, or a model
context. Nothing outside Node's standard library sits in the trust path.

| Surface | What it does |
|---|---|
| **Settings → Git** | Its own settings tab: stores or deletes the token, shows whether the record is readable, picks the unlock mode, and shows the record address, key file, socket path and helper state. |
| `/api/dsh-git.*` routes | The page's transport: `state`, `token`, `forget`, `unlock`, `lock` — registered inside the browser-auth fence. |
| git credential helper | `lib/credhelper.cjs`, registered once as `credential.https://github.com.helper`, relays one `get` to the socket and answers nothing when the vault is locked. |

## How a token gets used

1. The page POSTs the token to `/api/dsh-git.token`. The host seals it
   (`lib/crypto.js`) and writes the sealed bytes as an opaque `grant` payload in
   the credential record `dsh-git/github`.
2. `git` asks its configured helper for `github.com`.
3. The helper connects to the unix socket and speaks git's credential protocol.
4. The host decrypts the record in its own memory and answers `username` and
   `password` on that socket. The child process — not the model — reads the
   answer.

The reverse direction does not exist: no route, command, or log line returns the
token or the passphrase, so neither can reach a model context through this
plugin. The page only ever reads status.

## Unlock modes

| Mode | Key | Behaviour |
|---|---|---|
| `keyfile` (default) | 32 random bytes in a `0600` file, created on first save | No KDF: a random key is not guessable, so stretching it buys nothing. The file is read on every operation, so a rotated key is felt at once. |
| `ask` | A passphrase, stretched with scrypt (`N=32768 r=8 p=1`, 64 MiB `maxmem`) | The derived key lives only in the host process's memory. After a restart the vault is locked until the passphrase is typed again. |

There is deliberately no environment-variable mode. Reading a token from the
environment would mean the secret existing outside the sealed record and outside
this process — and, in a container deployment, editing the container to get it
there. Two unlock sources are enough.

## Configuration

The four `.volatile()` fields are the live surface: in 0.1.7 a volatile field is
projected into the profile entry's configuration form, and a volatile-only write
is felt at once, without a restart. The invariant the code keeps is that a
volatile field is read on *every* operation. `socketPath` and `manageGitConfig`
are therefore plain fields — the socket binds once per process and the helper is
registered once at load — so changing either is a profile-patch edit plus a
restart.

| Field | Default | Live | Meaning |
|---|---|---|---|
| `unlockMode` | `keyfile` | yes | `keyfile` or `ask`. Switching modes means the stored token must be saved again. |
| `keyFile` | `''` | yes | Empty resolves `$DSH_HOME/dsh-git.key` — the key lives in the same harness home as the record it opens, so a home that is recreated takes both with it. Point it elsewhere (a mounted volume you also keep the credentials document on) when the home is not what persists for you. |
| `host` | `github.com` | yes | The one host this plugin serves. A request for any other host is answered with nothing. |
| `username` | `x-access-token` | yes | Reported to git. GitHub accepts any value beside a valid token. |
| `socketPath` | `''` | restart | Empty resolves `$DSH_HOME/dsh-git.sock`. |
| `manageGitConfig` | `true` | restart | Keep `credential.https://<host>.helper` pointing at the bundled helper. The plugin adds its own entry and never touches another helper. |

## State on disk

| Path | What | Protection |
|---|---|---|
| `$DSH_HOME/.credentials.yaml` | the sealed payload, as record `dsh-git/github` | the harness's own credential document; the payload is opaque to the seam |
| `$DSH_HOME/dsh-git.key` | the key file, created on first save | `0600`, refused if readable beyond its owner |
| `$DSH_HOME/dsh-git.sock` | the credential socket | `0600`; removed on stop, and a stale file is removed before binding |
| `~/.gitconfig` | one `credential.https://github.com.helper` entry | a normal git config entry, added once |

The sealed payload is bound to its record address with additional authenticated
data, so a payload lifted out of this record cannot be replayed into another.

## Routes

| Route | Method | Answers |
|---|---|---|
| `/api/dsh-git.state` | GET | status only: configured, readable, locked, key-file mode, socket path, helper installed |
| `/api/dsh-git.token` | POST | seals and stores `{token}`; rejects an empty or whitespace-bearing token |
| `/api/dsh-git.forget` | POST | deletes the record and drops the cached copy |
| `/api/dsh-git.unlock` | POST | derives the key for `{passphrase}`, creating the vault when no record exists |
| `/api/dsh-git.lock` | POST | forgets the in-memory key |

All five sit inside the browser-auth fence, and none of them echoes a secret.

## What this does not protect against

- Any process running as the same user can read the key file and the credential
  record, and can talk to the socket. The design keeps secrets out of *model
  context* and out of *git's own storage*, not out of the account.
- A `git push` the model runs succeeds as you. That is the point of the helper.
- Losing the key file (or the passphrase) makes the stored token unreadable. The
  fix is to save the token again; there is no recovery path, by construction.

## Install

From the repository, as a bundle:

```sh
dsh plugin --profile web add github:prv-ctech/dsh-git#latest
```

Then **restart `dsh web`**. Installing selects the bundle; nothing else is
needed, and nothing extra is installed: the package has **no runtime
dependencies**. The three harness packages it imports
(`@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-home-paths`,
`@deepseek-ai/schemastery`) are declared as *optional peers*, and the 0.1.7
loader serves its own copies of them to the plugin — which is why a fresh
container needs no `npm install`, and why a plugin never drags a second copy of
a harness package into a profile.

From a local checkout, for development:

```sh
mkdir -p ~/.dsh/profiles/web
cd ~/.dsh/profiles/web
pnpm add link:/workspace/dsh-git
```

then add `dsh-git` to the profile's `dsh.profile.bundles` list and restart. The
plugin writes a `0600` key file on the first token save; no other setup is
needed.

## Removing it

```sh
git config --global --unset-all credential.https://github.com.helper
```

delete the profile entry, then delete the record through the page (or
`dsh-git/github` from `$DSH_HOME/.credentials.yaml`) and the key file.

## Develop

```sh
npm install         # development only: nothing here is a runtime dependency
npm test            # crypto, socket, host apply, client render
npm run check:boot  # a restart over a stored record still serves the socket
npm run check:live  # boots a throwaway harness and drives the whole design
npm run check:pack  # what the tarball would ship
```

Every check builds its own temporary `DSH_HOME`, and every one of them removes
what it created. `check:live` links this checkout into a *copy* of the profile,
keeps `HOME` isolated too (the plugin registers a global git credential helper),
and never writes to the operator's home or patch document.

## Layout

| Path | What |
|---|---|
| `lib/index.js` | host half: the credential record, both unlock modes, git config, the socket, the five routes |
| `lib/crypto.js` | AES-256-GCM sealing, the scrypt KDF, key-file loading and permission checks |
| `lib/socket.js` | git's credential protocol, and the `0600` unix socket that serves it |
| `lib/credhelper.cjs` | the credential helper git actually runs |
| `lib/client.js` | browser half: the Settings page |
| `cordis.patch.yml` | the one host row this bundle inserts |

The row id (`git`) is load-bearing: in 0.1.7 a settings namespace *is* the
profile entry id, so it is what the page addresses with
`ctx.configForms.get('git')`. The credential record's scope is the plugin name
(`dsh-git`), not the row id, so the address is `dsh-git/github`.

Pushing a `v*` tag publishes the GitHub release and moves the rolling `latest`
tag (`.github/workflows/release.yml`); pushes to `main` run the checks
(`.github/workflows/ci.yml`).

## Licence

MIT — see [LICENSE](LICENSE).
