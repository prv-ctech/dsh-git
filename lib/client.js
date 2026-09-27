// dsh-git — browser half (0.1.7-rc.2 lazy-CJS client bundle).
//
// Executing this file only REGISTERS the factory below; every side effect,
// including the stylesheet injection, runs at materialization inside the
// closure. The registration id is the package name, which is also the boot-graph
// row id.
//
// The page owns no secret transport of its own: it POSTs a token or a
// passphrase to the host routes inside the browser-auth fence, and the host
// never sends either back. Status is the only thing this page ever reads, so
// nothing here can put a secret into a model context. It occupies its own
// `settings.section` tab — the same seat dsh-im, dsh-caveman and
// dsh-codex-subscription hold — not a row inside General.
//
// The unlock mode is the profile entry's volatile Config, written through
// `ctx.configForms` — 0.1.7's one settings transport for browser plugins — so
// the Host configuration editor persists it and applies it live.

window.__ModuleLoader__.load({
  id: "dsh-git",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    // ---- identity ---------------------------------------------------------
    const PLUGIN_ID = "dsh-git";
    // In 0.1.7 a settings namespace IS a profile entry id, so this equals the
    // `id:` of the bundle patch row in cordis.patch.yml.
    const ENTRY_ID = "git";
    const LOCALE_NS = "git";
    // The host routes, all inside the browser-auth fence.
    const API = {
      state: "/api/dsh-git.state",
      token: "/api/dsh-git.token",
      forget: "/api/dsh-git.forget",
      unlock: "/api/dsh-git.unlock",
      lock: "/api/dsh-git.lock",
    };

    // ---- styles -----------------------------------------------------------
    const STYLES = `
.dgg-group{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dgg-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dgg-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dgg-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dgg-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dgg-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dgg-pill:hover:not(:disabled):not(.dgg-selected){background:var(--dsw-alias-interactive-bg-hover)}
.dgg-pill.dgg-selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}
.dgg-pill:disabled{opacity:.5;cursor:default}
.dgg-input{box-sizing:border-box;flex:1 1 220px;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dgg-button{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dgg-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dgg-button:disabled{opacity:.5;cursor:default}
.dgg-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dgg-ok{color:var(--dsw-alias-label-primary)}
.dgg-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg);padding:8px 10px}
.dgg-mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;word-break:break-all}
.dgg-facts{display:flex;flex-direction:column;gap:2px}
`;

    function installStyles(ctx) {
      if (typeof document === "undefined") return;
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = PLUGIN_ID + "/client.css";
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "dsh-git: client stylesheet");
    }

    // ---- dictionaries -----------------------------------------------------
    const zh = {
      "nav": "Git",
      "settings.title": "GitHub 凭据",
      "settings.description": "令牌以 AES-256-GCM 密封后存于原生凭据记录，git 通过本地套接字取用。",
      "settings.unavailable": "无法连接 Host（此页面未连接配置服务）",
      "mode.label": "解锁方式",
      "mode.keyfile": "密钥文件",
      "mode.ask": "每次启动输入口令",
      "mode.hint": "切换解锁方式后需要重新保存令牌",
      "token.placeholder": "github_pat_…（仅发送给 Host，从不回读）",
      "token.save": "保存令牌",
      "token.saved": "令牌已密封保存",
      "token.forget": "删除令牌",
      "token.forgotten": "令牌已删除",
      "token.required": "请输入令牌",
      "pass.placeholder": "口令（仅保存在内存中）",
      "pass.unlock": "解锁",
      "pass.locked": "已锁定 —— 输入口令解锁后可保存令牌",
      "pass.unlocked": "已解锁",
      "pass.lock": "立即锁定",
      "status.configured": "已配置",
      "status.missing": "未配置",
      "status.readable": "可读取",
      "status.unreadable": "无法解密",
      "fact.keyFile": "密钥文件",
      "fact.socket": "套接字",
      "fact.helper": "git helper",
      "fact.record": "记录",
      "fact.host": "主机",
      "helper.yes": "已安装",
      "helper.no": "未安装",
      "warn.mode": "权限需为 600：",
      "error.prefix": "错误：",
    };

    const en = {
      "nav": "Git",
      "settings.title": "GitHub credentials",
      "settings.description": "The token is sealed with AES-256-GCM inside the native credential record; git reads it over a local socket.",
      "settings.unavailable": "Host unreachable (this page is not connected to the configuration service)",
      "mode.label": "Unlock with",
      "mode.keyfile": "Key file",
      "mode.ask": "Passphrase each start",
      "mode.hint": "Switching the unlock mode means the token must be saved again",
      "token.placeholder": "github_pat_… (sent to the Host only, never read back)",
      "token.save": "Save token",
      "token.saved": "Token sealed and stored",
      "token.forget": "Delete token",
      "token.forgotten": "Token deleted",
      "token.required": "Enter a token first",
      "pass.placeholder": "Passphrase (kept in memory only)",
      "pass.unlock": "Unlock",
      "pass.locked": "Locked — unlock with your passphrase before saving a token",
      "pass.unlocked": "Unlocked",
      "pass.lock": "Lock now",
      "status.configured": "Configured",
      "status.missing": "Not configured",
      "status.readable": "readable",
      "status.unreadable": "undecryptable",
      "fact.keyFile": "Key file",
      "fact.socket": "Socket",
      "fact.helper": "git helper",
      "fact.record": "Record",
      "fact.host": "Host",
      "helper.yes": "installed",
      "helper.no": "not installed",
      "warn.mode": "must be mode 600:",
      "error.prefix": "Error: ",
    };

    // ---- Settings → Git: the credential page -------------------------------
    function GitSettingsPage(props) {
      const t = props.t;
      const [state, setState] = React.useState(null);
      const [token, setToken] = React.useState("");
      const [passphrase, setPassphrase] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const mode = props.useForm((snapshot) => {
        const section = snapshot.value;
        return section && section.unlockMode === "ask" ? "ask" : "keyfile";
      });
      const formStatus = props.useForm((snapshot) => snapshot.status);
      const formWritable = props.useForm((snapshot) => snapshot.writable);

      const refresh = React.useCallback(() => {
        fetch(API.state, { credentials: "include" })
          .then((response) => response.json())
          .then((body) => setState(body))
          .catch(() => setState({ ok: false, error: "unreachable" }));
      }, []);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      const post = (path, body) => {
        setBusy(true);
        setNotice(null);
        return fetch(path, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        })
          .then((response) => response.json().then((payload) => ({ status: response.status, payload })))
          .then(({ status, payload }) => {
            if (status >= 400 || !payload.ok) throw new Error(payload && payload.error ? payload.error : "HTTP " + status);
            refresh();
            return payload;
          })
          .catch((error) => {
            setNotice(error.message);
            return null;
          })
          .finally(() => setBusy(false));
      };

      const formReady = formStatus === "ready" && formWritable;
      const modePill = (value, label) => h(
        "button",
        {
          key: value,
          type: "button",
          className: "dgg-pill" + (mode === value ? " dgg-selected" : ""),
          disabled: !formReady,
          "aria-pressed": mode === value,
          onClick: () => void props.setUnlockMode(value),
        },
        label,
      );

      const configured = Boolean(state && state.configured);
      const readable = Boolean(state && state.readable);
      const locked = Boolean(state && state.locked);
      const keyFile = state && state.keyFile ? state.keyFile : null;
      const statusText = !configured
        ? t("status.missing")
        : readable
          ? t("status.configured") + " · " + t("status.readable")
          : t("status.configured") + " · " + t("status.unreadable");

      const fact = (label, value) => h(
        "div",
        { className: "dgg-note" },
        label + ": ",
        h("span", { className: "dgg-mono" }, value),
      );

      return h(
        "div",
        { className: "dgg-group" },
        h(
          "div",
          { className: "dgg-head" },
          h(
            "div",
            null,
            h("div", { className: "dgg-title" }, t("settings.title")),
            h(
              "div",
              { className: "dgg-desc" },
              formStatus === "ready" && state && state.credentials !== false
                ? t("settings.description")
                : t("settings.unavailable"),
            ),
          ),
          h("div", { className: "dgg-note dgg-ok" }, statusText),
        ),

        // unlock mode — the profile entry's volatile Config, applied live
        h(
          "div",
          { className: "dgg-row" },
          h("span", { className: "dgg-note" }, t("mode.label")),
          modePill("keyfile", t("mode.keyfile")),
          modePill("ask", t("mode.ask")),
          h("span", { className: "dgg-note" }, t("mode.hint")),
        ),

        // passphrase, only meaningful in ask mode
        mode === "ask"
          ? h(
            "div",
            { className: "dgg-row" },
            h("input", {
              className: "dgg-input",
              type: "password",
              autoComplete: "off",
              placeholder: t("pass.placeholder"),
              value: passphrase,
              onChange: (event) => setPassphrase(event.target.value),
            }),
            h(
              "button",
              {
                type: "button",
                className: "dgg-button",
                disabled: busy || passphrase.length === 0,
                onClick: () => {
                  void post(API.unlock, { passphrase }).then((payload) => {
                    if (payload) {
                      setPassphrase("");
                      setNotice(t("pass.unlocked"));
                    }
                  });
                },
              },
              t("pass.unlock"),
            ),
            locked
              ? h("span", { className: "dgg-note" }, t("pass.locked"))
              : h(
                "button",
                {
                  type: "button",
                  className: "dgg-button",
                  disabled: busy,
                  onClick: () => void post(API.lock, {}),
                },
                t("pass.lock"),
              ),
          )
          : null,

        // the token itself — write-only
        h(
          "div",
          { className: "dgg-row" },
          h("input", {
            className: "dgg-input",
            type: "password",
            autoComplete: "off",
            placeholder: t("token.placeholder"),
            value: token,
            onChange: (event) => setToken(event.target.value),
          }),
          h(
            "button",
            {
              type: "button",
              className: "dgg-button",
              disabled: busy || token.length === 0,
              onClick: () => {
                if (token.trim().length === 0) {
                  setNotice(t("token.required"));
                  return;
                }
                void post(API.token, { token }).then((payload) => {
                  if (payload) {
                    setToken("");
                    setNotice(t("token.saved"));
                  }
                });
              },
            },
            t("token.save"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dgg-button",
              disabled: busy || !configured,
              onClick: () => {
                void post(API.forget, {}).then((payload) => {
                  if (payload) setNotice(t("token.forgotten"));
                });
              },
            },
            t("token.forget"),
          ),
        ),

        state && state.error
          ? h("div", { className: "dgg-warn" }, t("error.prefix") + state.error)
          : null,
        state && keyFile && keyFile.exists && !keyFile.safe
          ? h("div", { className: "dgg-warn" }, t("warn.mode") + " " + keyFile.path + " (" + keyFile.mode + ")")
          : null,
        notice ? h("div", { className: "dgg-note" }, notice) : null,

        state
          ? h(
            "div",
            { className: "dgg-facts" },
            fact(t("fact.record"), state.credentialKey),
            fact(t("fact.host"), state.host),
            keyFile ? fact(t("fact.keyFile"), keyFile.path + (keyFile.exists ? " (" + keyFile.mode + ")" : " (absent)")) : null,
            fact(t("fact.socket"), state.socketPath),
            fact(t("fact.helper"), state.helper.path + " — " + (state.helper.installed ? t("helper.yes") : t("helper.no"))),
          )
          : null,
      );
    }

    // ---- plugin ------------------------------------------------------------
    // `configForms` is 0.1.7's settings transport for browser plugins; `remote`
    // must be injected alongside it because it carries the forwarded settings
    // invalidation that `ctx.configForms.get(entryId)` subscribes to.
    const inject = ["slots", "locale", "remote", "configForms"];

    function apply(ctx) {
      installStyles(ctx);

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-git: dictionaries");

      // -- Settings → Git: own tab, the same seat dsh-im, dsh-caveman and
      // dsh-codex-subscription hold — not a row inside General. `label` is a
      // locale-following thunk: the shell resolves it through
      // `resolveSlotLabel` on every locale revision, so the tab renames itself
      // without a re-registration.
      const t = ctx.locale.bind(LOCALE_NS);
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        {
          name: "settings.section",
          id: ENTRY_ID,
          order: 25,
          label: () => t("nav"),
          locale: LOCALE_NS,
          inject: () => {
            const form = ctx.configForms.get(ENTRY_ID);
            return {
              hooks: { form },
              setUnlockMode: (mode) => {
                void form.set("unlockMode", mode).catch(() => {});
              },
            };
          },
        },
        GitSettingsPage,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
