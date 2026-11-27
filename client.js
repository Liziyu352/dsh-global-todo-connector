/**
 * Client module: configuration UI for the global todo connector.
 *
 * Three seats exist, following the user's standing requirement (recorded in
 * runtime memory, 2026-11-27): the configuration UI may live in exactly three
 * places — the left sidebar tab, the plugin detail page, and the settings
 * panel (bottom-left account menu) — and NEVER in the Plugins page's
 * "built-in plugin settings" column (`plugins.item` is deliberately not used).
 * Only the settings-panel seat is enabled out of the box; the other two are
 * opt-in. The switches are themselves volatile config fields, so they can be
 * flipped from the very UI they control; seat registration follows the synced
 * values live.
 *
 *   settingsPage (default true)  → a row in the settings panel's General
 *                                  section (`settings.general.item`).
 *   detailPage   (default false) → the plugin detail page (`plugins.row.config`)
 *                                  plus a full settings section
 *                                  (`settings.section`, also listed in the
 *                                  settings panel navigation).
 *   sidebarTab   (default false) → a dedicated left sidebar tab
 *                                  (`main` + `sidebar.panellist`).
 *
 * All seats render the SAME field set; only the chrome differs.
 *
 * The settings schema itself lives on the Host side (lib/schema.js →
 * runtime.Config); this module only draws the form. The form model is
 * hand-rolled: SettingsFormModel only addresses top-level fields, while our
 * config nests under `hub`. Fields are edited as text drafts; saving turns
 * each changed draft into one settings path op ({op:'set', path:['hub','url'],
 * value}), which the Host validates against the volatile paths of
 * runtime.Config.
 *
 * Requirement: the Host entry id (cordis.patch.yml insert id) and this module
 * id must both resolve to the namespace `global-todo-connector` —
 * `configForms.get(ns)` resolves by entry id, and the form only appears once
 * the Host serves that namespace (whileServed).
 */
;(function () {
  'use strict'
  const NS = 'global-todo-connector'

  window.__ModuleLoader__.load({
    id: 'dsh-global-todo-connector',
    factory: function (require) {
      const React = require('react')
      const { SettingsForm, SettingsValueField } = require('@deepseek-ai/dsh-client-ui-primitives')
      const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

      const h = React.createElement

      /** The client-side defaults, mirrored from lib/defaults.js (the Host may not send values). */
      const SEAT_DEFAULTS = { settingsPage: true, detailPage: false, sidebarTab: false }
      const SEAT_FLAGS = ['settingsPage', 'detailPage', 'sidebarTab']

      /** Fields the page edits. `boolean` renders true/false text; `numeric` parses numbers. */
      const FIELDS = [
        { path: ['storePath'], label: 'storePath', hint: 'todos.json 绝对路径；留空用默认位置' },
        { path: ['dataDir'], label: 'dataDir', hint: '连接器 YAML 与状态目录；留空用默认位置' },
        { path: ['hub', 'url'], label: 'hub.url', hint: '可选 hub 地址，例如 http://127.0.0.1:8765' },
        { path: ['hub', 'instance'], label: 'hub.instance', hint: '本实例标识；留空自动生成' },
        { path: ['hub', 'timeoutMs'], label: 'hub.timeoutMs', numeric: true, hint: 'hub 请求超时（毫秒）' },
        { path: ['fileProxy'], label: 'fileProxy', hint: 'todos.json 读写方式：空=直读本地文件；hub=经 hub file-manager 代理（实验性）' },
        { path: ['tools'], label: 'tools', boolean: true, hint: '注册 dsh_connector_* 工具' },
        { path: ['routes'], label: 'routes', boolean: true, hint: '注册 /api/global-todo-connector HTTP 路由' },
        { path: ['schedule'], label: 'schedule', boolean: true, hint: '启用连接器本地定时调度' },
        { path: ['settingsPage'], label: 'settingsPage', boolean: true, hint: '在左下角设置页的「通用」区显示配置（关掉后需从其它入口或 profile 配置改回）' },
        { path: ['detailPage'], label: 'detailPage', boolean: true, hint: '在插件详情页显示配置（同时在设置页导航列出整页）' },
        { path: ['sidebarTab'], label: 'sidebarTab', boolean: true, hint: '在左侧标签栏显示配置页' },
      ]

      /** hub.token is write-only: an empty draft never writes, the stored value never echoes back. */
      const TOKEN_PATH = ['hub', 'token']

      /** plugins.row.config key: `<package name>#<row id>` (ui-plugin-manager README). */
      const ROW_CONFIG_KEY = 'dsh-global-todo-connector#global-todo-connector'

      /** Sidebar tab / main panel id (MainPanelId is a branded string at the type level only). */
      const PANEL_ID = NS

      const LOCALE = {
        zh: {
          title: '全局待办连接器',
          summary: '用 YAML 连接器把全局待办同步到外部系统；连接器文件用 dsh_connector_* 工具管理。',
          panel: '全局待办连接器',
          rowLocal: '本地直连（未配置 hub）',
          rowHub: 'hub 已配置',
          unavailable: '设置服务不可用',
          readOnly: '配置只读',
          saveFailed: '保存失败：配置已被其它来源修改，请刷新后重试',
          save: '保存',
          saving: '保存中…',
          resetLabel: '还原默认',
          overriddenLabel: '已覆盖',
          invalidLabel: '格式不正确',
          tokenHint: 'hub 访问令牌（write-only：留空保存=不更改，已存值不回显）',
          expand: '展开配置',
          collapse: '收起',
        },
        en: {
          title: 'Global Todo Connector',
          summary: 'Sync the global todo list to external systems through YAML connectors; manage connector files with the dsh_connector_* tools.',
          panel: 'Global Todo Connector',
          rowLocal: 'Local file (no hub configured)',
          rowHub: 'Hub configured',
          unavailable: 'Settings service unavailable',
          readOnly: 'Configuration is read-only',
          saveFailed: 'Save failed: the configuration changed elsewhere, refresh and retry',
          save: 'Save',
          saving: 'Saving…',
          resetLabel: 'Reset',
          overriddenLabel: 'Overridden',
          invalidLabel: 'Invalid value',
          tokenHint: 'Hub access token (write-only: save with empty text to keep the stored value; it is never echoed back)',
          expand: 'Show settings',
          collapse: 'Hide',
        },
      }

      const parseBoolean = (text) => {
        const s = text.trim().toLowerCase()
        if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
        if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
        return undefined
      }

      const keyOf = (path) => path.join('.')

      const valueAt = (value, path) => {
        let node = value
        for (const key of path) {
          if (node === undefined || node === null) return undefined
          node = node[key]
        }
        return node
      }

      function formatValue(field, value) {
        if (value === undefined || value === null) return ''
        if (field.boolean) return value === true ? 'true' : value === false ? 'false' : String(value)
        return String(value)
      }

      /** Parse one draft text into {value}|{invalid:true}; empty text clears (unset). */
      function parseDraft(field, text) {
        if (field.boolean) {
          const parsed = parseBoolean(text)
          return parsed === undefined ? { invalid: true } : { value: parsed }
        }
        const trimmed = text.trim()
        if (trimmed === '') return { value: undefined }
        if (field.numeric) {
          const n = Number(trimmed)
          return Number.isFinite(n) ? { value: n } : { invalid: true }
        }
        return { value: trimmed }
      }

      function createController(form, t) {
        /** Draft store: staged text per field path, token draft, save state. */
        const store = createSnapshotStore({ draft: {}, tokenDraft: '', saving: false, failed: false })

        const unsubscribeForm = form.subscribe(() => store.update(() => {}))

        // Memoized projection: React's useSyncExternalStore requires getSnapshot
        // to return a stable reference while nothing changed, or it throws
        // "The result of getSnapshot should be cached to avoid an infinite loop".
        let cachedView = null
        let cachedFormSnapshot = null
        let cachedStoreState = null
        const projection = () => {
          const snapshot = form.getSnapshot()
          const state = store.getSnapshot()
          if (cachedView !== null && cachedFormSnapshot === snapshot && cachedStoreState === state) {
            return cachedView
          }
          const { draft, tokenDraft, saving, failed } = state
          const available = snapshot.status === 'ready'
          const writable = available && snapshot.writable === true

          const fields = FIELDS.map((field) => {
            const key = keyOf(field.path)
            const current = formatValue(field, valueAt(snapshot.value, field.path))
            const staged = draft[key]
            const text = staged === undefined ? current : staged
            const parsed = staged === undefined ? { value: null } : parseDraft(field, staged)
            const base = valueAt(snapshot.base, field.path)
            const user = valueAt(snapshot.user, field.path)
            return {
              field,
              key,
              text,
              invalid: parsed.invalid === true,
              edited: staged !== undefined && staged !== current,
              overridden: user !== undefined && JSON.stringify(user) !== JSON.stringify(base),
            }
          })

          const tokenStaged = tokenDraft.trim() !== ''
          const dirty = tokenStaged || fields.some((item) => item.edited && !item.invalid)
          const invalid = fields.some((item) => item.invalid)
          const revision = snapshot.revision
          cachedFormSnapshot = snapshot
          cachedStoreState = state
          cachedView = { available, writable, dirty, invalid, saving, failed, fields, tokenDraft, tokenStaged, revision, t }
          return cachedView
        }

        const edit = (field, text) => {
          store.update((state) => { state.draft[keyOf(field.path)] = text; state.failed = false })
        }

        const resetField = (field) => {
          store.update((state) => { delete state.draft[keyOf(field.path)]; state.failed = false })
        }

        const editToken = (text) => {
          store.update((state) => { state.tokenDraft = text; state.failed = false })
        }

        const save = async () => {
          const view = projection()
          if (!view.writable || view.invalid || !view.dirty) return
          const ops = []
          for (const item of view.fields) {
            if (!item.edited || item.invalid) continue
            const parsed = parseDraft(item.field, item.text)
            if (parsed.value === undefined) ops.push({ op: 'unset', path: item.field.path })
            else ops.push({ op: 'set', path: item.field.path, value: parsed.value })
          }
          if (view.tokenStaged) ops.push({ op: 'set', path: TOKEN_PATH, value: store.getSnapshot().tokenDraft.trim() })
          if (ops.length === 0) return
          store.update((state) => { state.saving = true; state.failed = false })
          const ok = await form.mutate(ops, view.revision)
          try { debug.lastMutate = { ops, revision: view.revision, ok } } catch { /* non-debug host */ }
          store.update((state) => {
            state.saving = false
            if (ok) { state.draft = {}; state.tokenDraft = '' }
            else state.failed = true
          })
        }

        const discard = () => {
          store.update((state) => { state.draft = {}; state.tokenDraft = ''; state.failed = false })
        }

        const dispose = () => { unsubscribeForm() }

        return {
          store,
          projection,
          actions: { edit, resetField, editToken, save, discard },
          dispose,
        }
      }

      /** One short status line for collapsed chrome (row head). */
      function statusLine(view) {
        const hubUrl = view.fields.find((item) => item.key === 'hub.url')?.text
        return hubUrl && hubUrl.trim() !== '' ? `${view.t('rowHub')}` : view.t('rowLocal')
      }

      /** The shared form body — identical field set for every seat. */
      function formBody(view, actions) {
        const t = view.t
        const labels = {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: view.failed ? t('saveFailed') : '',
          save: t('save'),
          saving: t('saving'),
        }

        const fieldNodes = view.fields.map((item) => h(SettingsValueField, {
          id: item.key,
          key: item.key,
          label: item.field.label,
          hint: item.field.hint,
          numeric: item.field.numeric === true,
          disabled: !view.writable || view.saving,
          text: item.text,
          overridden: item.overridden,
          invalid: item.invalid,
          overriddenLabel: t('overriddenLabel'),
          resetLabel: t('resetLabel'),
          invalidLabel: t('invalidLabel'),
          onEdit: (text) => actions.edit(item.field, text),
          onReset: () => actions.resetField(item.field),
        }))

        fieldNodes.push(h(SettingsValueField, {
          id: 'hub-token',
          key: 'hub-token',
          label: 'hub.token',
          hint: t('tokenHint'),
          disabled: !view.writable || view.saving,
          text: view.tokenDraft,
          overridden: false,
          invalid: false,
          overriddenLabel: t('overriddenLabel'),
          resetLabel: t('resetLabel'),
          invalidLabel: t('invalidLabel'),
          onEdit: (text) => actions.editToken(text),
        }))

        return h(SettingsForm, {
          labels,
          state: { available: true, writable: view.writable, dirty: view.dirty, invalid: view.invalid, saving: view.saving },
          onSave: actions.save,
          onDiscard: actions.discard,
        }, fieldNodes)
      }

      /** Seat: settings panel General row — collapsed head, expandable full form. */
      function GeneralRow(props) {
        const view = props.useConnectorSettings((state) => state)
        const t = view.t
        const [expanded, setExpanded] = React.useState(false)

        const head = h('button', {
          key: 'head',
          type: 'button',
          onClick: () => setExpanded((value) => !value),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: '8px 4px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
          },
        },
          h('span', { style: { fontWeight: 600 } }, t('title')),
          h('span', { style: { opacity: 0.6, fontSize: 12 } }, statusLine(view)),
          h('span', { style: { marginLeft: 'auto', opacity: 0.6, fontSize: 12 } }, expanded ? t('collapse') : t('expand')),
        )

        if (!expanded) return h('div', { style: { borderBottom: '1px solid var(--dsw-divider, rgba(128,128,128,0.2))' } }, head)

        const body = view.available === false
          ? h('div', { style: { opacity: 0.75, padding: '4px 4px 12px' } }, t('unavailable'))
          : formBody(view, props)

        return h('div', { style: { borderBottom: '1px solid var(--dsw-divider, rgba(128,128,128,0.2))' } },
          head,
          h('div', { style: { padding: '0 4px 12px' } },
            h('div', { style: { opacity: 0.75, fontSize: 12, paddingBottom: 8 } }, t('summary')),
            body,
          ),
        )
      }

      /** Seat: the plugin detail page row (view 'summary' | 'page'). */
      function RowConfigPage(props) {
        const view = props.useConnectorSettings((state) => state)
        if (props.view === 'summary') {
          return h('div', { style: { opacity: 0.75 } }, view.available === false ? view.t('unavailable') : statusLine(view))
        }
        if (!view.available) return h('div', null, view.t('unavailable'))
        return h('div', null,
          h('div', { style: { opacity: 0.75, fontSize: 12, paddingBottom: 8 } }, view.t('summary')),
          formBody(view, props),
        )
      }

      /** Seat: the settings-panel full section (same body, its own chrome). */
      function SectionPage(props) {
        const view = props.useConnectorSettings((state) => state)
        if (!view.available) return h('div', null, view.t('unavailable'))
        return h('div', null,
          h('div', { style: { opacity: 0.75, fontSize: 12, paddingBottom: 8 } }, view.t('summary')),
          formBody(view, props),
        )
      }

      /** Seat: the sidebar tab page. */
      function PanelPage(props) {
        const view = props.useConnectorSettings((state) => state)
        if (!view.available) return h('div', { style: { padding: 16 } }, view.t('unavailable'))
        return h('div', { style: { padding: 16, maxWidth: 640, margin: '0 auto' } },
          h('div', { style: { opacity: 0.75, fontSize: 12, paddingBottom: 8 } }, view.t('summary')),
          formBody(view, props),
        )
      }

      /** Seat: the sidebar tab icon ({size, active} per SidebarPanelIconOwnerProps). */
      function PanelIcon(props) {
        const size = props.size ?? 20
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { opacity: props.active === false ? 0.6 : 1 },
          'aria-hidden': true,
        },
          h('rect', { x: 3, y: 4, width: 9, height: 16, rx: 2 }),
          h('path', { d: 'M5.6 8.6l1.1 1.1 1.9-2.3' }),
          h('path', { d: 'M5.6 13.6l1.1 1.1 1.9-2.3' }),
          h('path', { d: 'M12.5 12h2.5', strokeDasharray: '2 2' }),
          h('circle', { cx: 18, cy: 12, r: 3 }),
        )
      }

      /**
       * One seat flag: a synced volatile boolean ref ({get, subscribe}) or a
       * plain boolean. Absent → the compiled-in default.
       */
      function seatFlag(config, name) {
        try {
          const ref = config?.[name]
          const value = ref && typeof ref.get === 'function' ? ref.get() : ref
          if (typeof value === 'boolean') return value
        } catch {
          /* a broken ref must not break the seats */
        }
        return SEAT_DEFAULTS[name]
      }

      function apply(ctx, config) {
        // Debug instrumentation (temporary): expose the seat machine state to the page.
        const debug = { applied: true, flags: {}, whileServed: false, installed: [], configType: '', errors: [] }
        try { window.__gtcSeats = debug } catch { /* non-browser */ }
        try { debug.configType = config && typeof config === 'object' ? (typeof config.settingsPage) : String(config) } catch { /* ignore */ }

        ctx.effect(() => ctx.locale.register(NS, { zh: LOCALE.zh, en: LOCALE.en }), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          let controller
          try { controller = createController(ctx.configForms.get(NS), t) } catch (error) {
            debug.errors.push(`controller: ${String(error?.message || error).slice(0, 200)}`)
            return
          }

          /** One inject face shared by every seat: the projection hook plus the controller actions. */
          const injectFace = () => ({
            hooks: {
              connectorSettings: {
                getSnapshot: () => controller.projection(),
                subscribe: (listener) => controller.store.subscribe(listener),
              },
            },
            ...controller.actions,
          })

          const installGeneral = () => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
            name: 'settings.general.item',
            id: NS,
            order: 30,
            locale: NS,
            inject: injectFace,
          }, GeneralRow))

          const installDetail = () => {
            const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: NS,
              order: 60,
              label: () => t('title'),
              locale: NS,
              inject: injectFace,
            }, SectionPage))
            const disposeRow = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config',
              key: ROW_CONFIG_KEY,
              locale: NS,
              inject: injectFace,
            }, RowConfigPage))
            return () => { disposeSection?.(); disposeRow?.() }
          }

          const installSidebar = () => {
            const disposePanel = ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: injectFace,
            }, PanelPage))
            const disposeIcon = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => t('panel'),
              locale: NS,
            }, PanelIcon))
            return () => { disposePanel?.(); disposeIcon?.() }
          }

          const seats = [
            { key: 'general', flag: 'settingsPage', install: installGeneral },
            { key: 'section', flag: 'detailPage', install: installDetail },
            { key: 'sidebar', flag: 'sidebarTab', install: installSidebar },
          ]

          // The seats only make sense while the Host serves our namespace.
          return ctx.configForms.whileServed([NS], () => {
            debug.whileServed = true
            const active = {}

            const sync = () => {
              for (const seat of seats) {
                const want = seatFlag(config, seat.flag)
                try { debug.flags[seat.flag] = want } catch { /* ignore */ }
                if (want === true && active[seat.key] === undefined) {
                  try {
                    active[seat.key] = seat.install()
                    try { debug.installed.push(seat.key) } catch { /* ignore */ }
                  } catch (error) {
                    console?.warn?.(`${NS}: ${seat.key} seat failed to register`, error)
                    try { debug.errors.push(`${seat.key}: ${String(error?.message || error).slice(0, 200)}`) } catch { /* ignore */ }
                  }
                } else if (want === false && active[seat.key] !== undefined) {
                  try { active[seat.key]?.() } catch { /* ignore */ }
                  active[seat.key] = undefined
                }
              }
            }

            const unsubscribeFlags = []
            for (const name of SEAT_FLAGS) {
              const ref = config?.[name]
              if (ref && typeof ref.subscribe === 'function') {
                try { unsubscribeFlags.push(ref.subscribe(sync)) } catch { /* ignore */ }
              }
            }
            sync()

            return () => {
              for (const unsubscribe of unsubscribeFlags) {
                try { unsubscribe?.() } catch { /* ignore */ }
              }
              for (const dispose of Object.values(active)) {
                try { dispose?.() } catch { /* ignore */ }
              }
            }
          })
        }, `${NS}: settings seats`)
      }

      return { inject: ['slots', 'locale', 'configForms'], apply }
    },
  })
})()
