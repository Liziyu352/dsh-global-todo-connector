/**
 * The connector model: what a `connectors/*.yaml` file means, and how a
 * downstream "client" is described by it.
 *
 * Shape (all keys are documented in docs/CONNECTORS.md):
 *
 * ```yaml
 * version: 1
 * connector:
 *   name: taskwarrior
 *   label: TaskWarrior
 *   enabled: true
 *   direction: pull          # pull | push | both
 *   conflict: newer          # newer | remote | local
 *   schedule: { everyMinutes: 15, onBoot: false }
 * client:
 *   name: taskwarrior        # 下游名字，写成 tag client:<name>
 *   priority: normal         # 新建条目的缺省优先级
 *   project: 工作             # 项目组，写成 tag project:<group>
 *   tags: [tw]
 *   executor:
 *     kind: cmd | rest
 *     ...
 * mapping:
 *   id: uuid
 *   title: description
 *   ...
 * ```
 *
 * Validation is strict on purpose: a connector that half-loads is worse than
 * one that refuses to load with a precise line-level reason, because the
 * failure mode of the former is silently duplicating somebody's todo list.
 */

import { ConnectorError } from './errors.js'
import { PRIORITIES, PRIORITY_ALIASES, STATUSES, LIMITS } from './store.js'
import { parseYaml, stringifyYaml, YamlError } from './yaml.js'

export const CONNECTOR_VERSION = 1
export const DIRECTIONS = Object.freeze(['pull', 'push', 'both'])
export const CONFLICT_POLICIES = Object.freeze(['newer', 'remote', 'local'])
export const EXECUTOR_KINDS = Object.freeze(['cmd', 'rest'])
export const DEFAULT_CONFLICT = 'newer'
export const DEFAULT_EVERY_MINUTES = 15
export const MAX_YAML_BYTES = 1024 * 1024

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * Normalize a priority value, accepting the `P0`–`P3` aliases the DSH panel uses.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizePriority(value, fallback = 'normal') {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (PRIORITIES.includes(text)) return text
  if (PRIORITY_ALIASES[text] !== undefined) return PRIORITY_ALIASES[text]
  throw new ConnectorError('invalid-connector', `优先级只能是 ${PRIORITIES.join(' / ')}（或 P0–P3），收到 ${String(value)}`)
}

/**
 * Pick the connector's tag name for a client.
 *
 * Tags are limited to 32 characters and must survive `dsh-global-todo`'s
 * normalization, so the name is lowercased/slugified here once, at load, and
 * every later step reuses it.
 *
 * @param {string} name
 * @returns {string}
 */
export function clientTagOf(name) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `client:${slug}`.slice(0, LIMITS.tag)
}

export function projectTagOf(project) {
  const text = String(project).trim()
  if (text === '') return ''
  return `project:${text}`.slice(0, LIMITS.tag)
}

// ---------------------------------------------------------------------------
// Field references and templates
// ---------------------------------------------------------------------------

/**
 * Read `a.b[0].c` style paths out of a JSON value.
 *
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
export function readPath(value, path) {
  if (typeof path !== 'string' || path === '' || path === '.') return value
  let node = value
  for (const rawPart of path.split('.')) {
    if (node === null || node === undefined) return undefined
    const part = rawPart.trim()
    const match = /^([^[\]]*)((?:\[[0-9]+\])*)$/.exec(part)
    if (match === null) return undefined
    const key = match[1]
    if (key !== '') {
      if (typeof node !== 'object' || !(key in node)) return undefined
      node = node[key]
    }
    for (const indexText of match[2].match(/\[[0-9]+\]/g) ?? []) {
      const index = Number(indexText.slice(1, -1))
      if (!Array.isArray(node)) return undefined
      node = node[index]
    }
  }
  return node
}

const TEMPLATE = /\$\{([^}]+)\}/g

/**
 * Render `${...}` placeholders against a scope.
 *
 * `${env:NAME}` reads the process environment — this is how a connector keeps
 * a token out of its YAML file.  `${remote.*}` reads the raw remote record and
 * `${todo.*}` the local one; anything else is looked up in the scope root.
 *
 * When the whole string is a single placeholder the raw value is returned
 * (so a number stays a number); otherwise the parts are joined as text.
 *
 * @param {unknown} template
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
export function renderTemplate(template, scope = {}) {
  if (typeof template !== 'string') return template
  const whole = /^\$\{([^}]+)\}$/.exec(template)
  if (whole !== null) return resolvePlaceholder(whole[1], scope)
  return template.replace(TEMPLATE, (_match, expression) => {
    const value = resolvePlaceholder(expression, scope)
    if (value === null || value === undefined) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

/** Deep-render every string inside a plain object/array. */
export function renderDeep(value, scope = {}) {
  if (typeof value === 'string') return renderTemplate(value, scope)
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, scope))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = renderDeep(item, scope)
    return out
  }
  return value
}

function resolvePlaceholder(expression, scope) {
  const trimmed = String(expression).trim()
  if (trimmed.startsWith('env:')) {
    return process.env[trimmed.slice(4)] ?? ''
  }
  if (trimmed === 'now') return new Date().toISOString()
  if (trimmed === 'today') return new Date().toISOString().slice(0, 10)
  // `a.b[0]` inside a placeholder.
  const parts = trimmed.split('.')
  let node = scope
  for (const part of parts) {
    if (node === null || node === undefined) return undefined
    const match = /^([^[\]]*)((?:\[[0-9]+\])*)$/.exec(part)
    if (match === null) return undefined
    if (match[1] !== '') {
      if (typeof node !== 'object' || !(match[1] in node)) return undefined
      node = node[match[1]]
    }
    for (const indexText of match[2].match(/\[[0-9]+\]/g) ?? []) {
      if (!Array.isArray(node)) return undefined
      node = node[Number(indexText.slice(1, -1))]
    }
  }
  return node
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function fail(message, field) {
  throw new ConnectorError('invalid-connector', `${field ? `${field}：` : ''}${message}`, { field })
}

function requireObject(value, field) {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) fail('必须是映射（key: value）', field)
  return value
}

function optionalString(value, field, max = 2000) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('必须是字符串', field)
  const text = value.trim()
  if (text.length > max) fail(`最多 ${max} 个字符`, field)
  return text
}

function requireName(value, field) {
  const text = optionalString(value, field, 64)
  if (text === '') fail('不能为空', field)
  if (!NAME_PATTERN.test(text)) {
    fail('只能包含小写字母、数字、点、下划线和短横线，并以字母或数字开头', field)
  }
  return text
}

function optionalStringList(value, field, { maxItems = 20, maxLength = LIMITS.tag } = {}) {
  if (value === undefined || value === null || value === '') return []
  const list = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(list)) fail('必须是字符串数组', field)
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== 'string') fail('标签必须是字符串', field)
    const text = raw.trim().replace(/^#/, '')
    if (text === '') continue
    if (text.length > maxLength) fail(`单个标签最多 ${maxLength} 个字符`, field)
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length > maxItems) fail(`最多 ${maxItems} 个`, field)
  }
  return out
}

function optionalPositiveInt(value, field, fallback, { min = 0, max = 1_000_000 } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < min || num > max) {
    fail(`必须是 ${min}–${max} 之间的整数`, field)
  }
  return num
}

function optionalBoolean(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'boolean') fail('必须是 true 或 false', field)
  return value
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const MAPPING_KEYS = Object.freeze([
  'id',
  'title',
  'description',
  'dueAt',
  'status',
  'priority',
  'tags',
  'updatedAt',
  'notes',
  'url',
])

const DEFAULT_PULL_MAPPING = Object.freeze({
  id: 'id',
  title: 'title',
  description: 'description',
  dueAt: 'dueAt',
  status: 'status',
  priority: 'priority',
  tags: 'tags',
  updatedAt: 'updatedAt',
  notes: 'notes',
  url: 'url',
})

const DEFAULT_PUSH_MAPPING = Object.freeze({
  title: 'title',
  description: 'description',
  dueAt: 'dueAt',
  status: 'status',
  priority: 'priority',
})

/**
 * Turn one mapping spec into `{ path, map }`.
 *
 * `status: status` is the shorthand; `status: { path: status, map: { TODO: open } }`
 * is the form you need when the downstream does not speak DSH's vocabulary.
 * The map is always *remote value → local value*; push inverts it.
 *
 * @param {unknown} spec
 * @param {string} field
 * @returns {{ path: string, map: Record<string, string> }}
 */
function normalizeFieldSpec(spec, field) {
  if (typeof spec === 'string') return { path: spec.trim(), map: {} }
  if (spec !== null && typeof spec === 'object' && typeof spec.path === 'string') {
    const map = {}
    if (spec.map !== undefined && spec.map !== null) {
      const rawMap = requireObject(spec.map, `${field}.map`)
      for (const [from, to] of Object.entries(rawMap)) {
        if (typeof to !== 'string') fail('映射目标必须是字符串', `${field}.map.${from}`)
        map[String(from)] = to
      }
    }
    return { path: spec.path.trim(), map }
  }
  fail('必须是字段名/点路径字符串，或 { path, map } 形式的映射', field)
}

/**
 * @param {unknown} value
 * @returns {{ pull: Record<string, {path: string, map: Record<string,string>}>, push: Record<string, unknown> | null }}
 */
function normalizeMapping(value) {
  const raw = requireObject(value, 'mapping')
  const unknown = Object.keys(raw).filter(
    (key) => !MAPPING_KEYS.includes(key) && key !== 'pull' && key !== 'push',
  )
  if (unknown.length > 0) {
    fail(`不认识的字段 ${unknown.join(', ')}（可用：${MAPPING_KEYS.join(', ')}，或嵌套在 pull / push 下）`, 'mapping')
  }

  // Flat form maps the pull direction and is the common case; `pull:` / `push:`
  // are the explicit forms when the two directions differ.
  const flat = {}
  for (const key of MAPPING_KEYS) {
    if (raw[key] !== undefined) flat[key] = raw[key]
  }
  const pullSource = raw.pull === undefined ? flat : requireObject(raw.pull, 'mapping.pull')

  const pull = {}
  for (const key of MAPPING_KEYS) {
    pull[key] = normalizeFieldSpec(DEFAULT_PULL_MAPPING[key], `mapping.pull.${key}`)
  }
  for (const key of MAPPING_KEYS) {
    if (pullSource[key] !== undefined) pull[key] = normalizeFieldSpec(pullSource[key], `mapping.pull.${key}`)
  }
  // A mapping without an id cannot be made idempotent; refuse early rather than
  // duplicating every todo on every run.
  if (pull.id.path === '') {
    fail('必须提供一个稳定 id 的字段路径（例如 uuid / id），否则无法幂等同步', 'mapping.pull.id')
  }

  // The push side is a template object, not a field map: a downstream that
  // needs `{ summary: `${todo.title}`, due: ... }` is the rule, not the exception.
  let push = null
  if (raw.push !== undefined) {
    const pushRaw = requireObject(raw.push, 'mapping.push')
    push = pushRaw
  }
  return { pull, push }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

function normalizeCmdAction(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('必填', field)
    return null
  }
  const raw = requireObject(value, field)
  const command = optionalString(raw.run ?? raw.cmd ?? raw.command, `${field}.run`, 4000)
  if (command === '') fail('必填（要执行的命令）', `${field}.run`)
  return {
    run: command,
    timeoutMs: optionalPositiveInt(raw.timeoutMs, `${field}.timeoutMs`, 20000, { min: 1000, max: 600000 }),
    parse: normalizeParse(raw.parse, field),
    items: optionalString(raw.items, `${field}.items`, 200),
    stdin: raw.stdin === 'batch' ? 'batch' : 'todo',
    env: normalizeEnv(raw.env, `${field}.env`),
  }
}

function normalizeParse(value, field) {
  if (value === undefined || value === null || value === '') return 'json'
  const text = String(value).trim().toLowerCase()
  if (!['json', 'ndjson', 'lines', 'text'].includes(text)) {
    fail('只能是 json / ndjson / lines / text', `${field}.parse`)
  }
  return text
}

function normalizeEnv(value, field) {
  const raw = requireObject(value, field)
  const out = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`环境变量名不合法：${key}`, `${field}.${key}`)
    if (typeof item !== 'string') fail('环境变量值必须是字符串', `${field}.${key}`)
    out[key] = item
  }
  return out
}

/**
 * HTTP headers look like environment variables but are not: `X-Api-Key` and
 * `Accept-Language` are legal header names that no shell would accept as a
 * variable name, so they get their own, looser check.
 */
function normalizeHeaders(value, field) {
  const raw = requireObject(value, field)
  const out = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) fail(`HTTP 头名字不合法：${key}`, `${field}.${key}`)
    if (typeof item !== 'string') fail('HTTP 头值必须是字符串', `${field}.${key}`)
    out[key] = item
  }
  return out
}

function normalizeCmdExecutor(raw) {
  const pull = normalizeCmdAction(raw.pull, 'client.executor.pull')
  const push = normalizeCmdAction(raw.push, 'client.executor.push')
  const update = normalizeCmdAction(raw.update, 'client.executor.update')
  if (pull === null && push === null) {
    fail('cmd 执行器至少要有一个 pull 或 push 动作', 'client.executor')
  }
  return {
    kind: 'cmd',
    cwd: optionalString(raw.cwd, 'client.executor.cwd', 4096),
    env: normalizeEnv(raw.env, 'client.executor.env'),
    pull,
    push,
    update,
  }
}

function normalizeHttpAction(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('必填', field)
    return null
  }
  const raw = requireObject(value, field)
  const method = optionalString(raw.method, `${field}.method`, 10).toUpperCase() || 'GET'
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    fail('只能是 GET / POST / PUT / PATCH / DELETE', `${field}.method`)
  }
  return {
    method,
    path: optionalString(raw.path, `${field}.path`, 2000),
    query: normalizeQuery(raw.query, `${field}.query`),
    headers: normalizeHeaders(raw.headers, `${field}.headers`),
    body: raw.body === undefined ? undefined : raw.body,
    items: optionalString(raw.items, `${field}.items`, 200),
    timeoutMs: optionalPositiveInt(raw.timeoutMs, `${field}.timeoutMs`, 20000, { min: 1000, max: 600000 }),
    success: normalizeStatusList(raw.success, `${field}.success`),
  }
}

/**
 * Accepted HTTP status codes.
 *
 * YAML gives us a number for `200` and a string for `"2xx"`, and both are
 * natural things to write, so accept either and reject anything that is not an
 * integer status.
 */
function normalizeStatusList(value, field) {
  if (value === undefined || value === null || value === '') return []
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const raw of list) {
    const status = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      fail(`HTTP 状态码必须是 100–599 的整数（读到 ${JSON.stringify(raw)}）`, field)
    }
    if (!out.includes(status)) out.push(status)
  }
  return out
}

function normalizeQuery(value, field) {
  const raw = requireObject(value, field)
  const out = {}
  for (const [key, item] of Object.entries(raw)) {
    if (item === null || item === undefined) continue
    if (typeof item === 'object') fail('查询参数只能是标量值', `${field}.${key}`)
    out[key] = String(item)
  }
  return out
}

function normalizeRestExecutor(raw) {
  const baseUrl = optionalString(raw.baseUrl ?? raw.baseURL, 'client.executor.baseUrl', 2000)
  if (baseUrl === '') fail('必填', 'client.executor.baseUrl')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail(`不是合法的 URL：${baseUrl}`, 'client.executor.baseUrl')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail('只支持 http:// 或 https://', 'client.executor.baseUrl')
  }
  const pull = normalizeHttpAction(raw.pull, 'client.executor.pull')
  const push = normalizeHttpAction(raw.push, 'client.executor.push')
  const update = normalizeHttpAction(raw.update, 'client.executor.update')
  if (pull === null && push === null) {
    fail('rest 执行器至少要有一个 pull 或 push 动作', 'client.executor')
  }
  return {
    kind: 'rest',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    headers: normalizeHeaders(raw.headers, 'client.executor.headers'),
    timeoutMs: optionalPositiveInt(raw.timeoutMs, 'client.executor.timeoutMs', 20000, { min: 1000, max: 600000 }),
    followRedirects: optionalBoolean(raw.followRedirects, 'client.executor.followRedirects', true),
    pull,
    push,
    update,
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * Normalize one parsed connector document.
 *
 * @param {unknown} value parsed YAML
 * @param {{ source?: string }} [options] `source` is the file name, used in errors
 * @returns {object} the normalized connector
 */
export function normalizeConnector(value, options = {}) {
  const source = options.source ?? ''
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConnectorError('invalid-connector', `${source ? `${source}：` : ''}连接器文件必须是一个映射`)
  }
  const raw = value

  const version = optionalPositiveInt(raw.version, 'version', CONNECTOR_VERSION, { min: 1, max: 99 })
  if (version > CONNECTOR_VERSION) {
    throw new ConnectorError(
      'invalid-connector',
      `${source ? `${source}：` : ''}版本 ${version} 高于本插件支持的 ${CONNECTOR_VERSION}，请升级插件`,
    )
  }

  const connectorRaw = requireObject(raw.connector, 'connector')
  const name = requireName(connectorRaw.name, 'connector.name')

  const direction = optionalString(connectorRaw.direction, 'connector.direction', 20).toLowerCase() || 'pull'
  if (!DIRECTIONS.includes(direction)) fail(`只能是 ${DIRECTIONS.join(' / ')}`, 'connector.direction')

  const conflict = optionalString(connectorRaw.conflict, 'connector.conflict', 20).toLowerCase() || DEFAULT_CONFLICT
  if (!CONFLICT_POLICIES.includes(conflict)) {
    fail(`只能是 ${CONFLICT_POLICIES.join(' / ')}`, 'connector.conflict')
  }

  const scheduleRaw = requireObject(connectorRaw.schedule, 'connector.schedule')
  const schedule = {
    everyMinutes: optionalPositiveInt(scheduleRaw.everyMinutes, 'connector.schedule.everyMinutes', DEFAULT_EVERY_MINUTES, {
      min: 0,
      max: 7 * 24 * 60,
    }),
    onBoot: optionalBoolean(scheduleRaw.onBoot, 'connector.schedule.onBoot', false),
  }

  const limitsRaw = requireObject(connectorRaw.limits, 'connector.limits')
  const limits = {
    maxPull: optionalPositiveInt(limitsRaw.maxPull, 'connector.limits.maxPull', 200, { min: 1, max: 2000 }),
    maxPush: optionalPositiveInt(limitsRaw.maxPush, 'connector.limits.maxPush', 200, { min: 1, max: 2000 }),
  }

  const clientRaw = requireObject(raw.client, 'client')
  const clientName = optionalString(clientRaw.name, 'client.name', 100) || name
  const project = optionalString(clientRaw.project ?? clientRaw.group, 'client.project', 60)
  const executorRaw = requireObject(clientRaw.executor, 'client.executor')
  const kind = optionalString(executorRaw.kind, 'client.executor.kind', 20).toLowerCase()
  if (!EXECUTOR_KINDS.includes(kind)) fail(`只能是 ${EXECUTOR_KINDS.join(' / ')}`, 'client.executor.kind')
  const executor = kind === 'cmd' ? normalizeCmdExecutor(executorRaw) : normalizeRestExecutor(executorRaw)

  const mapping = normalizeMapping(raw.mapping)

  const connector = {
    version: CONNECTOR_VERSION,
    source,
    connector: {
      name,
      label: optionalString(connectorRaw.label, 'connector.label', 120) || clientName,
      description: optionalString(connectorRaw.description, 'connector.description', 2000),
      // Off unless asked for: writing a YAML file must not silently start
      // pushing to somebody's task tracker on the next scheduler tick.
      enabled: optionalBoolean(connectorRaw.enabled, 'connector.enabled', false),
      direction,
      conflict,
      schedule,
      limits,
    },
    client: {
      name: clientName,
      // A downstream's own priority: the level DSH uses when the remote record
      // does not say, and what this connector stamps on todos it creates.
      priority: normalizePriority(clientRaw.priority, 'normal'),
      project,
      tags: optionalStringList(clientRaw.tags, 'client.tags'),
      executor,
    },
    mapping,
  }

  connector.tag = clientTagOf(clientName)
  connector.projectTag = projectTagOf(project)
  connector.requiresPull = direction === 'pull' || direction === 'both'
  connector.requiresPush = direction === 'push' || direction === 'both'
  validateDirectionSupport(connector)
  return connector
}

/** Refuse a document that asks for a direction its executor cannot serve. */
function validateDirectionSupport(connector) {
  const { executor } = connector.client
  if (connector.requiresPull && executor.pull === null) {
    fail(`direction 是 ${connector.connector.direction}，但 ${executor.kind} 执行器没有配置 pull`, 'client.executor.pull')
  }
  if (connector.requiresPush && executor.push === null) {
    fail(`direction 是 ${connector.connector.direction}，但 ${executor.kind} 执行器没有配置 push`, 'client.executor.push')
  }
}

/**
 * Parse a connector file's text into a normalized connector.
 *
 * @param {string} text
 * @param {{ source?: string }} [options]
 * @returns {object}
 */
export function parseConnector(text, options = {}) {
  if (typeof text !== 'string') throw new ConnectorError('invalid-yaml', '连接器内容必须是字符串')
  if (Buffer.byteLength(text, 'utf8') > MAX_YAML_BYTES) {
    throw new ConnectorError('payload-too-large', '连接器 YAML 超过 1 MiB 上限')
  }
  let parsed
  try {
    parsed = parseYaml(text)
  } catch (error) {
    if (error instanceof YamlError) {
      throw new ConnectorError('invalid-yaml', `${options.source ? `${options.source}：` : ''}${error.message}`)
    }
    throw error
  }
  return normalizeConnector(parsed, options)
}

/**
 * Serialize a normalized connector back to YAML.
 *
 * The output is what `dsh_connector_write` stores, so it must round-trip
 * through `parseConnector`.  Runtime-only fields (`tag`, `requiresPull`, …) are
 * derived, never written.
 *
 * @param {object} connector
 * @returns {string}
 */
export function stringifyConnector(connector) {
  const doc = {
    version: CONNECTOR_VERSION,
    connector: {
      name: connector.connector.name,
      label: connector.connector.label,
      enabled: connector.connector.enabled,
      direction: connector.connector.direction,
      conflict: connector.connector.conflict,
      schedule: { everyMinutes: connector.connector.schedule.everyMinutes, onBoot: connector.connector.schedule.onBoot },
      limits: { maxPull: connector.connector.limits.maxPull, maxPush: connector.connector.limits.maxPush },
    },
    client: {
      name: connector.client.name,
      priority: connector.client.priority,
      project: connector.client.project,
      tags: connector.client.tags,
      executor: serializeExecutor(connector.client.executor),
    },
    mapping: serializeMapping(connector.mapping),
  }
  if (connector.connector.description) doc.connector.description = connector.connector.description
  return stringifyYaml(doc)
}

/**
 * Write the mapping back out in the shape a human would have typed.
 *
 * Flat (`title: title`) is the readable default; `pull:`/`push:` only appear
 * when a field is remapped or the push side is customized, because nesting an
 * all-identity map just to be explicit makes the common file worse.
 */
function serializeMapping(mapping) {
  const pull = serializePullMapping(mapping.pull)
  const flat = Object.entries(pull).every(([key, spec]) => typeof spec === 'string' && spec === DEFAULT_PULL_MAPPING[key])
  if (flat && mapping.push === null) return pull
  return { pull, ...(mapping.push === null ? {} : { push: mapping.push }) }
}

/** Write a field map back out, collapsing the identity shorthand to a bare path. */
function serializePullMapping(pull) {
  const out = {}
  for (const [key, spec] of Object.entries(pull)) {
    if (Object.keys(spec.map ?? {}).length === 0) out[key] = spec.path
    else out[key] = { path: spec.path, map: spec.map }
  }
  return out
}

function serializeExecutor(executor) {
  if (executor.kind === 'cmd') {
    const out = { kind: 'cmd' }
    if (executor.cwd) out.cwd = executor.cwd
    if (Object.keys(executor.env).length > 0) out.env = executor.env
    for (const key of ['pull', 'push', 'update']) {
      const action = executor[key]
      if (action === null) continue
      const item = { run: action.run, timeoutMs: action.timeoutMs, parse: action.parse }
      if (action.items) item.items = action.items
      if (action.stdin !== 'todo') item.stdin = action.stdin
      if (Object.keys(action.env).length > 0) item.env = action.env
      out[key] = item
    }
    return out
  }
  const out = { kind: 'rest', baseUrl: executor.baseUrl, timeoutMs: executor.timeoutMs }
  if (Object.keys(executor.headers).length > 0) out.headers = executor.headers
  for (const key of ['pull', 'push', 'update']) {
    const action = executor[key]
    if (action === null) continue
    const item = { method: action.method }
    if (action.path) item.path = action.path
    if (Object.keys(action.query).length > 0) item.query = action.query
    if (Object.keys(action.headers).length > 0) item.headers = action.headers
    if (action.body !== undefined) item.body = action.body
    if (action.items) item.items = action.items
    item.timeoutMs = action.timeoutMs
    // Only emitted when it narrows the accepted codes; an empty list means
    // "any 2xx", which is the default and would be noise in the file.
    if (action.success.length > 0) item.success = action.success
    out[key] = item
  }
  return out
}

/**
 * The starting point `dsh_connector_scaffold` writes.
 *
 * A scaffold that parses is the difference between "read the docs" and "edit
 * two lines"; every field here is valid, so the agent only has to fill in the
 * command or URL.
 *
 * @param {{ name: string, kind?: 'cmd' | 'rest', direction?: string, label?: string }} options
 * @returns {string}
 */
export function scaffoldConnector({ name, kind = 'cmd', direction = 'pull', label = '' } = {}) {
  const safeName = NAME_PATTERN.test(String(name ?? '')) ? String(name) : 'my-connector'
  const doc = {
    version: CONNECTOR_VERSION,
    connector: {
      name: safeName,
      label: label || safeName,
      enabled: false,
      direction,
      conflict: DEFAULT_CONFLICT,
      schedule: { everyMinutes: DEFAULT_EVERY_MINUTES, onBoot: false },
      limits: { maxPull: 200, maxPush: 200 },
    },
    client: {
      name: safeName,
      priority: 'normal',
      project: '',
      tags: [safeName],
      executor:
        kind === 'cmd'
          ? {
              kind: 'cmd',
              pull: { run: 'task export', timeoutMs: 20000, parse: 'json', items: '' },
              ...(direction === 'push' || direction === 'both'
                ? { push: { run: 'task import -', timeoutMs: 20000, parse: 'json', stdin: 'batch' } }
                : {}),
            }
          : {
              kind: 'rest',
              baseUrl: 'https://api.example.com',
              headers: { Authorization: 'Bearer ${env:TODO_TOKEN}' },
              timeoutMs: 20000,
              pull: { method: 'GET', path: '/tasks', items: 'data', timeoutMs: 20000 },
              ...(direction === 'push' || direction === 'both'
                ? { push: { method: 'POST', path: '/tasks', timeoutMs: 20000 } }
                : {}),
            },
    },
    mapping: { ...DEFAULT_PULL_MAPPING },
  }
  return stringifyYaml(doc)
}
