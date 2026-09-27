# dsh-git

GitHub credentials for the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
web app — paste a token once, and `git push` just works.

## What This Does

It adds a **Git** tab to Settings: paste a GitHub token, press **Save**, done. The
token is sealed with AES-256-GCM and kept in the harness's own credential record;
git reads it through a `0600` unix socket, so the plaintext never enters a tool
result, a git file, an environment variable, or a model context.

Nothing outside Node's standard library sits in the trust path, and nothing ever
reads the token back out — no route, command, or log line returns it.

Works with **DSH 0.1.7-rc.2**, web profile.

## Getting Started

```sh
# main, as it moves — the form that always resolves
dsh plugin --profile web add github:prv-ctech/dsh-git

# one exact release, pinned until you say otherwise
dsh plugin --profile web add github:prv-ctech/dsh-git#v0.2.0
```

Then restart `dsh web` and open **Settings → Git**. A fine-grained token with
**Contents: Read and write** is enough. Nothing needs configuring: the key file and
the socket live in `$DSH_HOME`, beside the record they belong to. Every field has a
default (`host`, `username`, `scanRoot`, `keyFile`, `socketPath`,
`manageGitConfig`); override one in the profile patch if you need to.

## Folder Ownership

Git refuses a repository whose owner is not the user running it:

```
fatal: detected dubious ownership in repository at '/workspace/<your-project>'
```

**Settings → Git** names every checkout it would refuse, with the fix:

```sh
chown -R 99:100 /workspace/<your-project>
```

It never writes `safe.directory`, because an exception list it wrote could not be
told apart from one you wrote by hand.

## Removing It

```sh
dsh plugin --profile web remove dsh-git
```

Restart `dsh web`. The credential record, the key file, and the plugin's own git
helper entry go with it — another tool's git config is left alone — so a reinstall
starts clean. Disabling the bundle is not removing it, and keeps your token.

No code of this plugin runs if you remove the package while `dsh` is stopped, with
HMR off, or while the bundle is already disabled. Then, by hand:

```sh
rm -f "$DSH_HOME/dsh-git.key" "$DSH_HOME/dsh-git.sock"
git config --global --unset-all credential.https://github.com.helper
```

and delete the `dsh-git/github:` entry under `records:` in
`$DSH_HOME/.credentials.yaml`.

## Notes

- Any process running as you can read the key file and the record. The point is
  keeping secrets out of _model context_ and _git's own storage_, not out of your
  account.
- Lose the key file and the stored token is unreadable; saving the token again is
  the only fix, by design.

## License

MIT — see [LICENSE](LICENSE).
