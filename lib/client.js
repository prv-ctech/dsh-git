// dsh-git — browser half (0.1.7-rc.2 lazy-CJS client bundle).
//
// Executing this file only REGISTERS the factory below; every side effect,
// including the stylesheet injection, runs at materialization inside the
// closure. The registration id is the package name, which is also the boot-graph
// row id.
//
// The page owns no secret transport of its own: it POSTs a token to the host
// route inside the browser-auth fence, and the host never sends one back. Status
// is the only thing this page ever reads, so nothing here can put a secret into
// a model context. It occupies its own `settings.section` tab — the same seat
// dsh-im, dsh-caveman and dsh-codex-subscription hold — not a row inside General.
//
// The chrome is the harness's own (`@deepseek-ai/dsh-client-ui-primitives`),
// which the web shell seeds as a static module: the token control is the native
// `SettingsSecretField` inside the native `SettingsForm`, so staging, saving,
// the overridden badge and the failure line behave exactly as they do on the
// harness's own settings pages.

window.__ModuleLoader__.load({
  id: 'dsh-git',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const {
      Button,
      DisclosureRow,
      IconInfoOutlineRegular,
      SettingsForm,
      SettingsFormModel,
      SettingsSecretField,
      StateDot,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    // ---- identity ---------------------------------------------------------
    const PLUGIN_ID = 'dsh-git'
    // In 0.1.7 a settings namespace IS a profile entry id, so this equals the
    // `id:` of the bundle patch row in cordis.patch.yml.
    const ENTRY_ID = 'git'
    const LOCALE_NS = 'git'
    // The form's one control. The value lives outside the settings document.
    const TOKEN_FIELD = 'token'
    // The host routes, all inside the browser-auth fence.
    const API = {
      state: '/api/dsh-git.state',
      token: '/api/dsh-git.token',
      forget: '/api/dsh-git.forget',
    }

    // ---- styles -----------------------------------------------------------
    // Only what no primitive covers: page rhythm, the ownership warning, and
    // the monospace facts. Everything else is the harness's own styling.
    const STYLES = `
.dgg-page{display:flex;flex-direction:column;gap:16px;padding:16px 0}
.dgg-head{display:flex;flex-direction:column;gap:2px}
.dgg-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dgg-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dgg-line{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dgg-actions{display:flex;align-items:center;gap:8px}
.dgg-warn{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg);padding:8px 10px}
.dgg-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dgg-mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;word-break:break-all}
.dgg-facts{display:flex;flex-direction:column;gap:2px;padding:4px 0 8px}
`

    function installStyles(ctx) {
      if (typeof document === 'undefined') return
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = PLUGIN_ID
        tag.dataset.pluginCss = PLUGIN_ID + '/client.css'
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'dsh-git: client stylesheet')
    }

    // ---- dictionaries -----------------------------------------------------
    const zh = {
      nav: 'Git',
      'settings.title': 'GitHub 凭据',
      'settings.description': '令牌以 AES-256-GCM 密封后存于原生凭据记录，git 通过本地套接字取用。',
      'status.ready': '可以推送与拉取',
      'status.none': '尚未保存令牌',
      'status.unreadable': '已保存的令牌无法读取 —— 请重新保存',
      'status.unknown': '正在检查…',
      'token.label': 'GitHub 令牌',
      'token.hint': '仅发送给 Host 并密封保存，永不回读。',
      'token.set': '已保存令牌',
      'token.unset': '未保存令牌',
      'token.forget': '删除令牌',
      save: '保存',
      saving: '保存中…',
      saveFailed: 'Host 拒绝了该令牌',
      readOnly: '此部署的设置为只读。',
      unavailable: '无法连接 Host（此页面未连接配置服务）',
      'details.title': '技术细节',
      'fact.record': '记录',
      'fact.host': '主机',
      'fact.keyFile': '密钥文件',
      'fact.socket': '套接字',
      'fact.helper': 'git helper',
      'helper.yes': '已注册',
      'helper.no': '未注册',
      absent: '（不存在）',
      'own.clean': '{root} 下的 {count} 个仓库均属于 {user}。',
      'own.none': '{root} 下没有找到仓库。',
      'own.missing': '{root} 不存在 —— 无可扫描。',
      'own.problem':
        '{root} 下有 {count} 个文件夹不属于 {user}，git 拒绝从这些目录推送。请在宿主机上执行：',
      'warn.mode': '密钥文件权限必须为 600：',
      'error.prefix': '错误：',
    }

    const en = {
      nav: 'Git',
      'settings.title': 'GitHub credentials',
      'settings.description':
        'The token is sealed with AES-256-GCM in the native credential record; git reads it over a local socket.',
      'status.ready': 'Ready to push and pull',
      'status.none': 'No token saved yet',
      'status.unreadable': "The saved token can't be read — save it again",
      'status.unknown': 'Checking…',
      'token.label': 'GitHub token',
      'token.hint': 'Sent to the Host and sealed there; never read back.',
      'token.set': 'a token is saved',
      'token.unset': 'no token saved',
      'token.forget': 'Delete token',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The Host refused the token',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'Host unreachable (this page is not connected to the configuration service)',
      'details.title': 'Technical details',
      'fact.record': 'Record',
      'fact.host': 'Host',
      'fact.keyFile': 'Key file',
      'fact.socket': 'Socket',
      'fact.helper': 'git helper',
      'helper.yes': 'registered',
      'helper.no': 'not registered',
      absent: '(absent)',
      'own.clean': '{count} repositories under {root}, all owned by {user}.',
      'own.none': 'No repositories found under {root}.',
      'own.missing': "{root} doesn't exist — nothing to scan.",
      'own.problem':
        "{count} folders under {root} aren't owned by {user}, and git refuses to push from them. Fix on the host:",
      'warn.mode': 'The key file must be mode 600:',
      'error.prefix': 'Error: ',
    }

    /** The copy the shared settings form frame renders. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** One fact line: a label and a monospace value. */
    function fact(label, value) {
      return h(
        'div',
        { className: 'dgg-note' },
        label + ': ',
        h('span', { className: 'dgg-mono' }, value),
      )
    }

    /** Fill `{name}` placeholders in one dictionary string. */
    function fill(text, values) {
      return Object.keys(values).reduce(
        (line, name) => line.split('{' + name + '}').join(values[name]),
        text,
      )
    }

    // ---- Settings → Git: the credential page -------------------------------
    /**
     * The page's state: the native staged form over this namespace, plus what
     * the host reports about the record, the key, and the workspace.
     *
     * The form model owns the token draft — it is a write-only control, so its
     * value lives outside the settings document and the model's save is the only
     * thing that writes it.
     */
    class GitCard {
      constructor(scope) {
        this.scope = scope
        this.status = null
        this.error = null
        this.form = new SettingsFormModel(
          scope,
          [],
          [{ field: TOKEN_FIELD, write: (text) => this.writeToken(text) }],
        )
        this.store = this.form.bind(() => this.projection())
        this.refresh()
      }

      projection() {
        return {
          ...this.form.shell(),
          token: this.form.field(TOKEN_FIELD),
          status: this.status,
          error: this.error,
        }
      }

      /** Publish a re-read to the page. */
      publish() {
        this.store.set(this.projection())
      }

      /** Re-read the host status. Its failure is a line on the page, not a crash. */
      async refresh() {
        try {
          const response = await fetch(API.state, { credentials: 'include' })
          const body = await response.json()
          const ok = response.ok && body && body.ok
          this.status = ok ? body : null
          this.error = ok ? null : (body && body.error) || 'HTTP ' + response.status
        } catch (error) {
          this.status = null
          this.error = error && error.message ? error.message : String(error)
        }
        this.publish()
      }

      /** The form's save: seal one token host-side. `false` leaves the draft staged. */
      async writeToken(text) {
        const body = await this.post(API.token, { token: text })
        return body !== null
      }

      /** Delete the stored token. */
      async forgetToken() {
        await this.post(API.forget, {})
      }

      /** POST one host route, then re-read. Returns the body, or null on refusal. */
      async post(path, body) {
        let payload = null
        try {
          const response = await fetch(path, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          const parsed = await response.json()
          if (response.ok && parsed && parsed.ok) payload = parsed
          else this.error = (parsed && parsed.error) || 'HTTP ' + response.status
        } catch (error) {
          this.error = error && error.message ? error.message : String(error)
        }
        await this.refresh()
        return payload
      }

      /** The face the slot registration injects. */
      inject() {
        return {
          hooks: { gitCard: this.store },
          ...this.form.actions(),
          forget: () => {
            void this.forgetToken()
          },
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    /** The ownership line: what git will refuse, and the host command that fixes it. */
    function ownershipBlock(t, status) {
      const ownership = status && status.ownership ? status.ownership : null
      if (ownership === null) return null
      if (ownership.exists === false)
        return h('div', { className: 'dgg-note' }, fill(t('own.missing'), { root: ownership.root }))
      const misowned = ownership.misowned || []
      if (misowned.length === 0) {
        return h(
          'div',
          { className: 'dgg-note' },
          fill(ownership.checked > 0 ? t('own.clean') : t('own.none'), {
            root: ownership.root,
            count: String(ownership.checked),
            user: ownership.user,
          }),
        )
      }
      return h(
        'div',
        { className: 'dgg-warn' },
        h(
          'div',
          null,
          fill(t('own.problem'), {
            root: ownership.root,
            count: String(misowned.length),
            user: ownership.user,
          }),
        ),
        h(
          'div',
          { className: 'dgg-mono' },
          'chown -R ' + ownership.user + ' ' + misowned.map((row) => row.path).join(' '),
        ),
      )
    }

    function GitSettingsPage(props) {
      const t = props.t
      const state = props.useGitCard((snapshot) => snapshot)
      const [details, setDetails] = React.useState(false)
      const status = state.status
      const configured = Boolean(status && status.configured)
      const readable = Boolean(status && status.readable)
      const keyFile = status && status.keyFile ? status.keyFile : null
      const dot = status === null || !configured ? 'idle' : readable ? 'done' : 'warning'
      const line =
        status === null
          ? t('status.unknown')
          : !configured
            ? t('status.none')
            : readable
              ? t('status.ready')
              : t('status.unreadable')

      return h(
        'div',
        { className: 'dgg-page' },
        h(
          'div',
          { className: 'dgg-head' },
          h('div', { className: 'dgg-title' }, t('settings.title')),
          h('div', { className: 'dgg-desc' }, t('settings.description')),
        ),

        h('div', { className: 'dgg-line' }, h(StateDot, { state: dot }), h('span', null, line)),

        // The native staged form: its save is what writes the token.
        h(
          SettingsForm,
          { labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
          h(SettingsSecretField, {
            id: 'plugin-config-git-token',
            label: t('token.label'),
            hint: t('token.hint'),
            disabled: !state.writable,
            text: state.token.text,
            configured,
            stateLabel: configured ? t('token.set') : t('token.unset'),
            onEdit: (text) => {
              props.edit(TOKEN_FIELD, text)
            },
          }),
        ),

        h(
          'div',
          { className: 'dgg-actions' },
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: !configured,
              onClick: () => {
                props.forget()
              },
            },
            t('token.forget'),
          ),
        ),

        ownershipBlock(t, status),

        status === null ? h('div', { className: 'dgg-note' }, t('unavailable')) : null,
        state.error ? h('div', { className: 'dgg-warn' }, t('error.prefix') + state.error) : null,
        keyFile && keyFile.exists && !keyFile.safe
          ? h(
              'div',
              { className: 'dgg-warn' },
              t('warn.mode') + ' ' + keyFile.path + ' (' + keyFile.mode + ')',
            )
          : null,

        // Everything technical, folded away: a person who only wants git to
        // work never has to open it.
        h(
          DisclosureRow,
          {
            icon: h(IconInfoOutlineRegular, null),
            title: t('details.title'),
            open: details,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => {
              setDetails(!details)
            },
          },
          status === null
            ? h('div', { className: 'dgg-note' }, t('unavailable'))
            : h(
                'div',
                { className: 'dgg-facts' },
                fact(t('fact.record'), status.credentialKey),
                fact(t('fact.host'), status.host),
                keyFile
                  ? fact(
                      t('fact.keyFile'),
                      keyFile.path +
                        (keyFile.exists ? ' (' + keyFile.mode + ')' : ' ' + t('absent')),
                    )
                  : null,
                fact(t('fact.socket'), status.socketPath),
                fact(
                  t('fact.helper'),
                  status.helper.path +
                    ' — ' +
                    (status.helper.installed ? t('helper.yes') : t('helper.no')),
                ),
              ),
        ),
      )
    }

    // ---- plugin ------------------------------------------------------------
    // `configForms` is 0.1.7's settings transport for browser plugins; `remote`
    // must be injected alongside it because it carries the forwarded settings
    // invalidation that `ctx.configForms.get(entryId)` subscribes to.
    const inject = ['slots', 'locale', 'remote', 'configForms']

    function apply(ctx) {
      installStyles(ctx)

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-git: dictionaries')

      const card = new GitCard(ctx.configForms.get(ENTRY_ID))
      ctx.effect(
        () => () => {
          card.dispose()
        },
        'dsh-git: form subscription',
      )

      // -- Settings → Git: own tab, the same seat dsh-im, dsh-caveman and
      // dsh-codex-subscription hold — not a row inside General. `label` is a
      // locale-following thunk: the shell resolves it through
      // `resolveSlotLabel` on every locale revision, so the tab renames itself
      // without a re-registration.
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: ENTRY_ID,
            order: 25,
            label: () => t('nav'),
            locale: LOCALE_NS,
            inject: () => card.inject(),
          },
          GitSettingsPage,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
