/**
 * Executors: how a connector actually talks to its downstream client.
 *
 * Two kinds exist, and they are deliberately boring:
 *
 *   - `cmd`  — run a command, read stdout.  This is how you reach TaskWarrior,
 *              `todo.txt`, a shell script, `lark-cli`, `dws`, anything.
 *   - `rest` — one HTTP request.  This is how you reach an HTTP API.
 *
 * Both return the same shape (`{ records, meta }`) so the sync engine never
 * has to care which one ran.  Nothing here knows what a todo is: the engine
 * maps records, the runner only moves bytes.
 */

import { spawn } from 'node:child_process'

import { ConnectorError } from './errors.js'
import { readPath, renderDeep, renderTemplate } from './connector.js'

/** Output beyond this is a runaway command, not a todo list. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

/**
 * Variables that must never reach a connector command.
 *
 * A connector is user-authored YAML that runs arbitrary commands; leaking the
 * harness' own credentials into it would turn "I configured a todo sync" into
 * "I exfiltrated my API key".
 */
const SCRUBBED = [/^DEEPSEEK_/i, /^DSH_.*TOKEN/i, /^DSH_.*KEY/i, /^OPENAI_/i, /^ANTHROPIC_/i, /^AWS_/i]

function scrubEnv(base) {
  const out = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (SCRUBBED.some((pattern) => pattern.test(key))) continue
    out[key] = value
  }
  return out
}

function shellOf() {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c'] }
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-c'] }
}

function truncate(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  // Keep the tail: the interesting part of a failed command is at the end.
  let sliced = text.slice(-maxBytes)
  const firstNewline = sliced.indexOf('\n')
  if (firstNewline > 0) sliced = sliced.slice(firstNewline + 1)
  return { text: sliced, truncated: true }
}

/**
 * Run one command and collect its stdout.
 *
 * @param {object} action normalized `cmd` action from connector.js
 * @param {{ scope?: object, stdin?: string | null, cwd?: string, env?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, signal: string | null, truncated: boolean, durationMs: number }>}
 */
export function runCommand(action, options = {}) {
  const scope = options.scope ?? {}
  const command = String(renderTemplate(action.run, scope))
  const cwd = options.cwd ? String(renderTemplate(options.cwd, scope)) : process.cwd()
  const env = {
    ...scrubEnv(process.env),
    ...Object.fromEntries(Object.entries(options.env ?? {}).map(([k, v]) => [k, String(renderTemplate(v, scope))])),
    ...Object.fromEntries(Object.entries(action.env ?? {}).map(([k, v]) => [k, String(renderTemplate(v, scope))])),
  }
  const stdin = options.stdin === undefined ? null : options.stdin
  const started = Date.now()

  return new Promise((resolve, reject) => {
    const shell = shellOf()
    let child
    try {
      child = spawn(shell.file, [...shell.args, command], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal: options.signal,
      })
    } catch (error) {
      reject(new ConnectorError('exec-failed', `启动命令失败：${error?.message ?? error}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, action.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        stdoutTruncated = true
        return
      }
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length > MAX_STDERR_BYTES) return
      stderr += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new ConnectorError('exec-failed', `命令执行失败：${error?.message ?? error}`))
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = truncate(stdout, MAX_OUTPUT_BYTES)
      const err = truncate(stderr, MAX_STDERR_BYTES)
      const durationMs = Date.now() - started
      if (code !== 0) {
        // A non-zero exit is not always fatal (some CLIs exit 1 for "empty"), so
        // the message carries the code and the engine decides whether to care.
        reject(
          new ConnectorError(
            'exec-failed',
            `命令退出码 ${code ?? signal}${err.text.trim() ? `：${err.text.trim().split('\n').slice(-3).join(' ')}` : ''}`,
            { code, signal, stderr: err.text, durationMs },
          ),
        )
        return
      }
      resolve({ stdout: out.text, stderr: err.text, code, signal, truncated: out.truncated, durationMs })
    })

    if (stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdin, 'utf8')
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Perform one HTTP request.
 *
 * @param {object} executor normalized `rest` executor
 * @param {object} action normalized `rest` action
 * @param {{ scope?: object, body?: unknown }} [options]
 * @returns {Promise<{ status: number, payload: unknown, text: string, durationMs: number }>}
 */
export async function runRequest(executor, action, options = {}) {
  const scope = options.scope ?? {}
  const path = String(renderTemplate(action.path ?? '', scope))
  const url = new URL(`${executor.baseUrl}${path.startsWith('/') ? path : path === '' ? '' : `/${path}`}`)
  for (const [key, value] of Object.entries(action.query ?? {})) {
    url.searchParams.set(key, String(renderTemplate(value, scope)))
  }

  const headers = {}
  for (const [key, value] of Object.entries({ ...executor.headers, ...action.headers })) {
    headers[key] = String(renderTemplate(value, scope))
  }
  // An explicit `Content-Type` in the YAML wins; JSON is the default because
  // that is what every todo API speaks.
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')

  let body
  if (action.body !== undefined && !['GET', 'HEAD'].includes(action.method)) {
    const rendered = renderDeep(action.body, scope)
    if (typeof rendered === 'string') {
      body = rendered
      if (!hasContentType) headers['Content-Type'] = 'application/json'
    } else {
      body = JSON.stringify(rendered)
      if (!hasContentType) headers['Content-Type'] = 'application/json'
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), action.timeoutMs ?? executor.timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: action.method,
      headers,
      body,
      signal: controller.signal,
      redirect: executor.followRedirects === false ? 'manual' : 'follow',
    })
    const text = await response.text()
    let payload = null
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    const allowed = Array.isArray(action.success) && action.success.length > 0 ? action.success : null
    const ok = allowed === null ? response.status >= 200 && response.status < 300 : allowed.includes(response.status)
    if (!ok) {
      throw new ConnectorError('exec-failed', `HTTP ${response.status} ${response.statusText}：${text.slice(0, 300)}`, {
        status: response.status,
        body: text.slice(0, 2000),
      })
    }
    return { status: response.status, payload, text, durationMs: Date.now() - started }
  } catch (error) {
    if (error instanceof ConnectorError) throw error
    if (error?.name === 'AbortError') {
      throw new ConnectorError('exec-failed', `请求超时（${action.timeoutMs ?? executor.timeoutMs}ms）`)
    }
    throw new ConnectorError('exec-failed', `请求失败：${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turn a command's stdout into records.
 *
 * @param {string} text
 * @param {'json' | 'ndjson' | 'lines' | 'text'} parse
 * @param {string} [itemsPath] dotted path to the array inside the payload
 * @returns {{ records: unknown[], meta: object }}
 */
export function parseOutput(text, parse, itemsPath = '') {
  if (parse === 'lines' || parse === 'text') {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return { records: lines, meta: { format: parse, count: lines.length } }
  }
  if (parse === 'ndjson') {
    const records = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        throw new ConnectorError('exec-failed', `输出不是合法 NDJSON：${trimmed.slice(0, 200)}`)
      }
    }
    return { records: selectItems({ records }, itemsPath), meta: { format: 'ndjson' } }
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ConnectorError('exec-failed', `输出不是合法 JSON：${text.trim().slice(0, 200) || '（空）'}`)
  }
  return { records: selectItems(payload, itemsPath), meta: { format: 'json' } }
}

/**
 * Pick the record array out of a payload.
 *
 * @param {unknown} payload
 * @param {string} itemsPath
 * @returns {unknown[]}
 */
export function selectItems(payload, itemsPath = '') {
  const node = itemsPath === '' ? payload : readPath(payload, itemsPath)
  if (node === undefined || node === null) {
    if (itemsPath === '') return []
    throw new ConnectorError('exec-failed', `响应里找不到 items 路径 "${itemsPath}"`)
  }
  if (!Array.isArray(node)) {
    throw new ConnectorError('exec-failed', `items 路径 "${itemsPath || '(根)'}" 指向的不是数组`)
  }
  return node
}

/**
 * Run a connector's pull direction.
 *
 * The returned `records` are raw downstream records; the engine maps them.
 *
 * @param {object} connector normalized connector
 * @param {{ scope?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{ records: unknown[], meta: object }>}
 */
export async function pullRecords(connector, options = {}) {
  const { executor } = connector.client
  const scope = options.scope ?? {}
  if (executor.kind === 'cmd') {
    const action = executor.pull
    const result = await runCommand(action, { scope, cwd: executor.cwd, env: executor.env, signal: options.signal })
    const parsed = parseOutput(result.stdout, action.parse, action.items)
    return { records: parsed.records, meta: { ...parsed.meta, durationMs: result.durationMs, truncated: result.truncated } }
  }
  const action = executor.pull
  const result = await runRequest(executor, action, { scope })
  if (typeof result.payload === 'string') {
    const parsed = parseOutput(result.payload, 'json', action.items)
    return { records: parsed.records, meta: { ...parsed.meta, durationMs: result.durationMs, status: result.status } }
  }
  return {
    records: selectItems(result.payload, action.items),
    meta: { format: 'json', durationMs: result.durationMs, status: result.status },
  }
}

/**
 * Run a connector's push direction for a batch of todos.
 *
 * Records that already have a remote id go through the `update` action when the
 * connector defines one (PATCH /tasks/{id} and friends); everything else uses
 * the `push` action.  A connector that only defines `push` gets one batch call,
 * which is the shape most CLIs accept.
 *
 * @param {object} connector normalized connector
 * @param {{ payload: unknown, remoteId?: string }[]} items
 * @param {{ scope?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{ pushed: number, created: number, updated: number, meta: object }>}
 */
export async function pushRecords(connector, items, options = {}) {
  const { executor } = connector.client
  const scope = options.scope ?? {}
  if (items.length === 0) return { pushed: 0, created: 0, updated: 0, meta: { skipped: true } }

  const split = executor.update !== null && executor.update !== undefined
  const updates = split ? items.filter((item) => item.remoteId) : []
  const creates = split ? items.filter((item) => !item.remoteId) : items

  let created = 0
  let updated = 0
  const meta = {}

  if (creates.length > 0) {
    const records = creates.map((item) => item.payload)
    if (executor.kind === 'cmd') {
      const action = executor.push
      const stdin = action.stdin === 'batch' ? JSON.stringify(records) : JSON.stringify(records.length === 1 ? records[0] : records)
      const result = await runCommand(action, { scope, stdin, cwd: executor.cwd, env: executor.env, signal: options.signal })
      meta.create = { durationMs: result.durationMs, stdout: result.stdout.slice(0, 2000) }
    } else {
      const action = executor.push
      const body = action.body === undefined ? records : action.body
      const result = await runRequest(executor, action, { scope: { ...scope, records }, body })
      meta.create = { status: result.status, durationMs: result.durationMs }
    }
    created = creates.length
  }

  for (const item of updates) {
    if (executor.kind === 'cmd') {
      const action = executor.update
      // An `update` action is always one record at a time: the downstream needs
      // to know *which* record, and that is conveyed by the id in the payload
      // or by `${remoteId}` in the command line.
      const stdin = JSON.stringify(item.payload)
      const result = await runCommand(action, {
        scope: { ...scope, remoteId: item.remoteId },
        stdin,
        cwd: executor.cwd,
        env: executor.env,
        signal: options.signal,
      })
      meta.update = { durationMs: result.durationMs, stdout: result.stdout.slice(0, 2000) }
    } else {
      const action = executor.update
      const body = action.body === undefined ? item.payload : action.body
      const result = await runRequest(executor, action, { scope: { ...scope, remoteId: item.remoteId }, body })
      meta.update = { status: result.status, durationMs: result.durationMs }
    }
    updated += 1
  }

  return { pushed: created + updated, created, updated, meta }
}
