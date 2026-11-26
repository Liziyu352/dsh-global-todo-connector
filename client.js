/**
 * Client module: settings page for the global todo connector.
 *
 * The Plugins page renders every `plugins.item` slot entry. The settings
 * schema itself lives on the Host side (lib/schema.js → runtime.Config);
 * this module only draws the form. The shape follows the official
 * ui-settings-shell card (ShellCardController → plugins.item slot), but the
 * form model is hand-rolled: SettingsFormModel only addresses top-level
 * fields, while our config nests under `hub`. Fields are edited as text
 * drafts; saving turns each changed draft into one settings path op
 * ({op:'set', path:['hub','url'], value}), which the Host validates against
 * the volatile paths of runtime.Config.
 *
 * Requirement: the Host entry id (cordis.patch.yml insert id) and this module
 * id must both resolve to the namespace `global-todo-connector` —
 * `configForms.get(ns)` resolves by entry id, and the slot only appears once
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
      ]

      /** hub.token is write-only: an empty draft never writes, the stored value never echoes back. */
      const TOKEN_PATH = ['hub', 'token']

      const LOCALE = {
        zh: {
          title: '全局待办连接器',
          summary: '用 YAML 连接器把全局待办同步到外部系统；连接器文件用 dsh_connector_* 工具管理。',
          unavailable: '设置服务不可用',
          readOnly: '配置只读',
          saveFailed: '保存失败：配置已被其它来源修改，请刷新后重试',
          save: '保存',
          saving: '保存中…',
          resetLabel: '还原默认',
          overriddenLabel: '已覆盖',
          invalidLabel: '格式不正确',
          tokenHint: 'hub 访问令牌（write-only：留空保存=不更改，已存值不回显）',
        },
        en: {
          title: 'Global Todo Connector',
          summary: 'Sync the global todo list to external systems through YAML connectors; manage connector files with the dsh_connector_* tools.',
          unavailable: 'Settings service unavailable',
          readOnly: 'Configuration is read-only',
          saveFailed: 'Save failed: the configuration changed elsewhere, refresh and retry',
          save: 'Save',
          saving: 'Saving…',
          resetLabel: 'Reset',
          overriddenLabel: 'Overridden',
          invalidLabel: 'Invalid value',
          tokenHint: 'Hub access token (write-only: save with empty text to keep the stored value; it is never echoed back)',
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

        const projection = () => {
          const snapshot = form.getSnapshot()
          const { draft, tokenDraft, saving, failed } = store.getSnapshot()
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
          return { available, writable, dirty, invalid, saving, failed, fields, tokenDraft, tokenStaged, revision, t }
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

      function ConnectorCard(props) {
        const view = props.useConnectorSettings((state) => state)
        const t = view.t
        if (props.view === 'summary') {
          return h('div', { style: { opacity: 0.75 } }, view.available === false ? t('unavailable') : t('summary'))
        }

        if (!view.available) return h('div', null, t('unavailable'))

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
          onEdit: (text) => props.edit(item.field, text),
          onReset: () => props.resetField(item.field),
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
          onEdit: (text) => props.editToken(text),
        }))

        return h(SettingsForm, {
          labels,
          state: { available: true, writable: view.writable, dirty: view.dirty, invalid: view.invalid, saving: view.saving },
          onSave: props.save,
          onDiscard: props.discard,
        }, fieldNodes)
      }

      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: LOCALE.zh, en: LOCALE.en }), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const controller = createController(ctx.configForms.get(NS), t)

          const disposeSlot = ctx.configForms.whileServed([NS], () => {
            const inject = () => ({
              hooks: {
                connectorSettings: {
                  getSnapshot: () => controller.projection(),
                  subscribe: (listener) => controller.store.subscribe(listener),
                },
              },
              ...controller.actions,
            })
            const disposeInject = ctx.slots.inject('plugins.item', () => ctx.slots.register({
              name: 'plugins.item',
              id: NS,
              order: 75,
              label: () => t('title'),
              locale: NS,
              inject,
            }, ConnectorCard))
            return () => disposeInject()
          })

          return () => { disposeSlot?.(); controller.dispose() }
        }, `${NS}: settings card`)
      }

      return { inject: ['slots', 'locale', 'configForms'], apply }
    },
  })
})()
