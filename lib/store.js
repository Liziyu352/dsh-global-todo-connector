/**
 * Read/write access to the `dsh-global-todo` store.
 *
 * `dsh-global-todo` provides no Cordis service and fences its own HTTP routes
 * behind the host connection gate, so the only integration that survives
 * every configuration is the data file itself.  This module therefore
 * re-implements the *reading* half of that plugin's store contract and a very
 * narrow writing half:
 *
 *   - it never rewrites a whole document from its own memory; every mutation
 *     is a read-modify-write under a cross-process lock, so a concurrent
 *     `dsh-global-todo` write is never lost;
 *   - it writes with the same atomic dance (temp file, fsync, rename), so a
 *     crash cannot leave half a JSON document behind;
 *   - it only ever appends and patches fields the upstream plugin understands,
 *     and never deletes anything it did not create.
 *
 * The field set mirrors `dsh-global-todo` 0.23.x (schema version 2).  Records
 * are normalized tolerantly on read: one mangled row must never take the whole
 * list down.
 */

import { access, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

import { ConnectorError } from './errors.js'

/** The schema this reader understands. Newer files are refused, not guessed at. */
export const SCHEMA_VERSION = 2

export const STATUSES = Object.freeze(['open', 'doing', 'done', 'cancelled', 'archived'])
export const PRIORITIES = Object.freeze(['urgent', 'high', 'normal', 'low'])
export const PRIORITY_ALIASES = Object.freeze({ p0: 'urgent', p1: 'high', p2: 'normal', p3: 'low' })
export const ACTORS = Object.freeze(['human', 'agent'])

/** Mirrors `dsh-global-todo`'s LIMITS. Keeping them equal keeps writes acceptable. */
export const LIMITS = Object.freeze({
  title: 200,
  description: 10000,
  tags: 20,
  tag: 32,
  activity: 50,
  note: 2000,
  notes: 50,
  steps: 20,
  step: 200,
  evidence: 300,
})

const SOMEDAY_TAG = 'someday'
const INBOX_TAG = 'inbox'

// ---------------------------------------------------------------------------
// Where the file lives
// ---------------------------------------------------------------------------

/**
 * The directory DSH calls home.
 *
 * `DSH_HOME` wins when set (that is how DSH itself resolves it); otherwise the
 * historical default `~/.dsh`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveHomeDir(env = process.env) {
  const explicit = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return explicit === '' ? path.join(homedir(), '.dsh') : path.resolve(explicit)
}

/**
 * The todo file, following `dsh-global-todo`'s own resolution.
 *
 * @param {{ storePath?: string }} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveStorePath(config = {}, env = process.env) {
  const explicit = typeof config?.storePath === 'string' ? config.storePath.trim() : ''
  if (explicit !== '') return path.resolve(explicit)
  return path.join(resolveHomeDir(env), 'global-todo', 'todos.json')
}

/** Where this plugin keeps its own files (connectors, state, logs, settings). */
export function resolvePluginDir(config = {}, env = process.env) {
  const explicit = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (explicit !== '') return path.resolve(explicit)
  return path.join(resolveHomeDir(env), 'global-todo-connector')
}

// ---------------------------------------------------------------------------
// Tolerant normalization (read path)
// ---------------------------------------------------------------------------

function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return max !== undefined && trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function normalizeTags(value) {
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#/, '')
    if (tag === '' || tag.length > LIMITS.tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= LIMITS.tags) break
  }
  return out
}

function normalizeLink(raw) {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (value === '') return null
    return { kind: /^https?:\/\//i.test(value) ? 'url' : 'file', value: value.slice(0, 4096), title: '' }
  }
  if (raw === null || typeof raw !== 'object') return null
  const value = text(raw.value ?? raw.path ?? raw.url, 4096)
  if (value === '') return null
  const kind = ['url', 'file', 'image'].includes(raw.kind)
    ? raw.kind
    : /^https?:\/\//i.test(value)
      ? 'url'
      : 'file'
  return { kind, value, title: text(raw.title, 200) }
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const link = normalizeLink(item)
    if (link === null) continue
    const key = `${link.kind}:${link.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(link)
  }
  return out
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const title = text(raw.title, LIMITS.step)
    if (title === '') continue
    out.push({ title, done: raw.done === true })
    if (out.length >= LIMITS.steps) break
  }
  return out
}

function normalizeActivity(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value.slice(-LIMITS.activity)) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.kind !== 'string') continue
    const entry = { at: Number.isFinite(raw.at) ? raw.at : Date.now(), by: raw.by === 'agent' ? 'agent' : 'human', kind: raw.kind }
    const summary = text(raw.summary, 300)
    if (summary !== '') entry.summary = summary
    out.push(entry)
  }
  return out
}

/**
 * Make one stored record safe to work with.
 *
 * @param {unknown} raw
 * @returns {object | null} `null` when the row cannot be salvaged at all
 */
export function normalizeTodo(raw, activityLimit = LIMITS.activity) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = text(raw.id, 200)
  const title = text(raw.title, LIMITS.title)
  if (id === '' || title === '') return null
  const status = typeof raw.status === 'string' && STATUSES.includes(raw.status) ? raw.status : 'open'
  const todo = {
    id,
    seq: Number.isFinite(raw.seq) ? raw.seq : 0,
    title,
    description: text(raw.description, LIMITS.description),
    status,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
    prioritySource: raw.prioritySource === 'human' ? 'human' : 'rule',
    suggestedPriority: PRIORITIES.includes(raw.suggestedPriority) ? raw.suggestedPriority : '',
    captureSource: typeof raw.captureSource === 'string' ? raw.captureSource : '',
    inboxReason: typeof raw.inboxReason === 'string' ? raw.inboxReason : '',
    dueAt: typeof raw.dueAt === 'string' ? raw.dueAt : null,
    tags: normalizeTags(raw.tags),
    links: normalizeLinks(raw.links),
    steps: normalizeSteps(raw.steps),
    evidence: text(raw.evidence, LIMITS.evidence),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    createdBy: raw.createdBy === 'agent' ? 'agent' : 'human',
    updatedBy: raw.updatedBy === 'agent' ? 'agent' : 'human',
    doneAt: Number.isFinite(raw.doneAt) ? raw.doneAt : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    originDir: typeof raw.originDir === 'string' ? raw.originDir : '',
    originSessionId: typeof raw.originSessionId === 'string' ? raw.originSessionId : '',
    lastDispatch: raw.lastDispatch && typeof raw.lastDispatch === 'object' ? raw.lastDispatch : null,
    completion: raw.completion && typeof raw.completion === 'object' ? raw.completion : null,
    review: normalizeReview(raw.review),
    notes: Array.isArray(raw.notes) ? raw.notes.slice(-LIMITS.notes) : [],
    activity: normalizeActivity(raw.activity).slice(-activityLimit),
  }
  // Unknown fields survive: a newer upstream plugin may write fields this
  // version does not model, and dropping them on a patch would be data loss.
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(todo, key)) todo[key] = value
  }
  return todo
}

function normalizeReview(raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.pending !== true) return null
  return { pending: true, at: Number.isFinite(raw.at) ? raw.at : Date.now(), by: raw.by === 'agent' ? 'agent' : 'human' }
}

/**
 * Read a whole document tolerantly.
 *
 * @param {unknown} value
 * @param {{ activityLimit?: number }} [options]
 * @returns {{ version: number, todos: object[], trash: object[] }}
 */
export function normalizeDocument(value, options = {}) {
  const activityLimit = Number.isInteger(options.activityLimit) ? options.activityLimit : LIMITS.activity
  const raw = value !== null && typeof value === 'object' ? value : {}
  const list = Array.isArray(raw.todos) ? raw.todos : []
  const todos = []
  const seen = new Set()
  for (const entry of list) {
    const todo = normalizeTodo(entry, activityLimit)
    if (todo === null || seen.has(todo.id)) continue
    seen.add(todo.id)
    todos.push(todo)
  }
  const trash = Array.isArray(raw.trash) ? raw.trash.filter((item) => item !== null && typeof item === 'object') : []
  return {
    version: Number.isFinite(raw.version) ? raw.version : SCHEMA_VERSION,
    todos,
    trash,
  }
}

// ---------------------------------------------------------------------------
// Helpers shared with the write path
// ---------------------------------------------------------------------------

/** `t-` plus eight hex characters, exactly like the upstream plugin. */
export function newTodoId(used = []) {
  const taken = new Set(used)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `t-${randomUUID().replace(/-/g, '').slice(0, 8)}`
    if (!taken.has(id)) return id
  }
  throw new ConnectorError('internal', '无法生成不重复的待办 id')
}

/** The level a deadline implies, per the upstream rule. */
export function priorityForDue(dueAt, { now = Date.now() } = {}) {
  // No deadline has no urgency signal at all, so the level is `low` — the same
  // answer the upstream plugin gives for an unparseable value. Returning
  // `normal` here would quietly outrank genuinely low-priority work.
  if (dueAt === null || dueAt === undefined) return 'low'
  const at =
    typeof dueAt === 'number' ? dueAt : typeof dueAt === 'string' && dueAt.trim() !== '' ? Date.parse(dueAt) : Number.NaN
  if (!Number.isFinite(at)) return 'low'
  const remaining = at - now
  if (remaining <= 0) return 'urgent'
  if (remaining <= 48 * 3600 * 1000) return 'high'
  if (remaining <= 7 * 24 * 3600 * 1000) return 'normal'
  return 'low'
}

export function hasInboxTag(todo) {
  return Array.isArray(todo?.tags) && todo.tags.some((tag) => String(tag).toLowerCase() === INBOX_TAG)
}

/**
 * Build a fresh record shaped like `dsh-global-todo`'s `createTodo` output.
 *
 * The connector writes into the same file the upstream plugin owns, so the
 * shape must match what that plugin's own reader would accept from itself —
 * including `prioritySource`, `captureSource`, and an initial `created`
 * activity entry.
 *
 * @param {object} input
 * @returns {object}
 */
export function createTodoRecord(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const by = input.createdBy === 'human' ? 'human' : 'agent'
  const prioritySource = input.prioritySource === 'human' ? 'human' : 'rule'
  const dueAt = input.dueAt ?? null
  const record = {
    id: input.id,
    seq: 0,
    title: String(input.title ?? '').trim().slice(0, LIMITS.title),
    description: String(input.description ?? '').slice(0, LIMITS.description),
    status: STATUSES.includes(input.status) ? input.status : 'open',
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
    prioritySource,
    suggestedPriority: '',
    captureSource: typeof input.captureSource === 'string' ? input.captureSource : 'connector',
    inboxReason: '',
    dueAt,
    tags: normalizeTags(input.tags ?? []),
    links: normalizeLinks(input.links ?? []),
    steps: normalizeSteps(input.steps ?? []),
    evidence: text(input.evidence, LIMITS.evidence),
    createdAt: now,
    updatedAt: now,
    createdBy: by,
    updatedBy: by,
    doneAt: input.status === 'done' ? now : null,
    sessionId: '',
    originDir: '',
    originSessionId: '',
    lastDispatch: null,
    completion: null,
    review: null,
    notes: [],
    activity: [],
  }
  // A downstream that carries a note gets it as the first note, not as
  // description text, so the panel's note timeline shows where it came from.
  if (typeof input.notes === 'string' && input.notes.trim() !== '') {
    record.notes.push({ at: now, by, text: input.notes.trim().slice(0, LIMITS.note) })
  }
  record.activity.push({ at: now, by, kind: 'created', summary: record.title })
  return record
}

export { SOMEDAY_TAG, INBOX_TAG }

/** One-line projection used by tools and the HTTP list route. */
export function presentTodo(todo, now = Date.now()) {
  const overdue = todo.dueAt !== null && todo.status !== 'done' && todo.status !== 'cancelled' && Date.parse(todo.dueAt) < now
  return {
    id: todo.id,
    seq: todo.seq,
    title: todo.title,
    status: todo.status,
    priority: todo.priority,
    dueAt: todo.dueAt,
    tags: todo.tags,
    overdue,
    inbox: hasInboxTag(todo),
    inboxReason: todo.inboxReason,
    updatedAt: todo.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Atomic write + lock (the same guarantees the upstream store gives)
// ---------------------------------------------------------------------------

async function pathExists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function ensureDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw new ConnectorError('store-unwritable', `建不了目录 ${directory}：${error?.message ?? error}`)
  }
}

async function renameWithRetry(from, to, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error?.code
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt))
    }
  }
}

/**
 * Replace `file` atomically: write a sibling temp file, flush it, then rename.
 *
 * @param {string} file
 * @param {string} payload
 */
async function atomicWrite(file, payload) {
  const directory = path.dirname(file)
  await ensureDirectory(directory)
  const temp = `${file}.${process.pid}.${Date.now()}.connector.tmp`
  try {
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      // A platform that refuses to fsync is a warning, not a lost save (Windows
      // EPERM on read-only handles is the usual offender).
      await handle.sync().catch(() => {})
    } finally {
      await handle.close()
    }
    await renameWithRetry(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new ConnectorError('store-unwritable', `写入 ${file} 失败：${error?.message ?? error}`)
  }
  // Make the rename itself durable where the platform allows it.
  try {
    const dir = await open(directory, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch {
    /* best effort */
  }
}

/**
 * A cross-process lock file, modelled on the upstream one.
 *
 * Test-and-set is `open(file, 'wx')`; the holder is identified by pid + token
 * so a release can never delete somebody else's lock.  An abandoned lock is
 * reaped when its process is gone (same host) or when it is older than
 * `staleMs` (another machine / a recycled pid).
 */
function createFileLock({ file, timeoutMs = 5000, staleMs = 30000 }) {
  let held = null

  async function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  async function reapIfAbandoned() {
    let raw
    let info
    try {
      raw = await readFile(file, 'utf8')
      info = await stat(file)
    } catch {
      return
    }
    let payload = null
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
    const sameHost = payload?.host === undefined || payload.host === (process.env.HOSTNAME ?? '')
    const abandoned = payload && Number.isInteger(payload.pid)
      ? sameHost
        ? !(await isAlive(payload.pid))
        : Date.now() - info.mtimeMs > staleMs
      : Date.now() - info.mtimeMs > staleMs
    if (!abandoned) return
    await unlink(file).catch(() => {})
  }

  async function acquire() {
    const deadline = Date.now() + timeoutMs
    let delay = 8
    for (;;) {
      try {
        const handle = await open(file, 'wx')
        const token = randomUUID()
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, host: process.env.HOSTNAME ?? '', at: Date.now(), token }), 'utf8')
        } finally {
          await handle.close()
        }
        held = token
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new ConnectorError('store-busy', `无法创建锁文件 ${file}：${error?.message ?? error}`)
        }
      }
      await reapIfAbandoned()
      if (Date.now() >= deadline) {
        throw new ConnectorError('store-busy', `等待写锁超时（${timeoutMs}ms）：${file}`)
      }
      await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())))
      delay = Math.min(delay * 2, 200)
    }
  }

  async function release() {
    if (held === null) return
    const token = held
    held = null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const raw = await readFile(file, 'utf8')
        const payload = JSON.parse(raw)
        if (payload?.token !== token) return
        await unlink(file)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
  }

  return { acquire, release }
}

// ---------------------------------------------------------------------------
// The store facade
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.file absolute path of `todos.json`
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @param {number} [options.activityLimit]
 * @param {number} [options.lockTimeoutMs]
 * @param {number} [options.lockStaleMs]
 */
export function createStore({ file, logger, activityLimit = LIMITS.activity, lockTimeoutMs = 5000, lockStaleMs = 30000 }) {
  const lock = createFileLock({ file: `${file}.lock`, timeoutMs: lockTimeoutMs, staleMs: lockStaleMs })
  let chain = Promise.resolve()
  let busy = false
  let known = null
  let externalChanges = 0
  let lastExternalAt = null

  function remember(info) {
    known = info === null ? null : `${info.mtimeMs}:${info.size}`
  }

  function observe(info) {
    if (info === null) {
      if (known !== null) {
        externalChanges += 1
        lastExternalAt = Date.now()
      }
      known = null
      return
    }
    const fingerprint = `${info.mtimeMs}:${info.size}`
    if (known !== null && known !== fingerprint) {
      externalChanges += 1
      lastExternalAt = Date.now()
    }
    known = fingerprint
  }

  async function read() {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        observe(null)
        return { version: SCHEMA_VERSION, todos: [], trash: [] }
      }
      throw new ConnectorError('store-unwritable', `读不到待办文件 ${file}：${error?.message ?? error}`)
    }
    observe(await stat(file).catch(() => null))
    if (raw.trim() === '') return { version: SCHEMA_VERSION, todos: [], trash: [] }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Never reset a corrupt file: it is the only copy of somebody's list.
      throw new ConnectorError('store-corrupt', `${file} 不是合法 JSON：${error?.message ?? error}`, { file })
    }
    const doc = normalizeDocument(parsed, { activityLimit })
    if (doc.version > SCHEMA_VERSION) {
      throw new ConnectorError(
        'store-corrupt',
        `${file} 的 schema 版本是 ${doc.version}，本插件只认识 ${SCHEMA_VERSION}，请升级插件或移走文件`,
        { file, version: doc.version },
      )
    }
    return doc
  }

  async function write(doc) {
    const payload = `${JSON.stringify({ version: SCHEMA_VERSION, todos: doc.todos, trash: doc.trash ?? [] }, null, 2)}\n`
    await atomicWrite(file, payload)
    remember(await stat(file).catch(() => null))
  }

  /**
   * Run one mutation under the write lock.
   *
   * The mutator receives the freshly read document and returns `{ next?, result }`.
   * Returning `next` (a todo array) writes; omitting it only reads.
   *
   * @template T
   * @param {(doc: { version: number, todos: object[], trash: object[] }) => ({ next?: object[], result: T } | Promise<{ next?: object[], result: T }>)} mutator
   * @returns {Promise<T>}
   */
  function update(mutator) {
    // A mutator that calls `update` again would queue behind its own parent and
    // wait forever, so refuse at call time rather than at chain time — the
    // nested call is created while the outer mutation is still running.
    if (busy) return Promise.reject(new ConnectorError('internal', 'store.update 不能在 mutator 里嵌套调用'))
    const run = chain.then(async () => {
      busy = true
      try {
        await ensureDirectory(path.dirname(file))
        await lock.acquire()
        try {
          const doc = await read()
          const outcome = (await mutator(doc)) ?? {}
          if (outcome.next !== undefined) {
            if (!Array.isArray(outcome.next)) {
              throw new ConnectorError('internal', 'store.update 的 next 必须是待办数组')
            }
            await write({ version: SCHEMA_VERSION, todos: outcome.next, trash: doc.trash })
          }
          return outcome.result
        } finally {
          await lock.release()
        }
      } finally {
        busy = false
      }
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function all() {
    const doc = await read()
    return doc.todos
  }

  async function describe() {
    let exists = false
    let bytes = 0
    let todos = 0
    try {
      const text = await readFile(file, 'utf8')
      exists = true
      bytes = Buffer.byteLength(text)
      todos = normalizeDocument(JSON.parse(text), { activityLimit }).todos.length
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`读取 ${file} 统计失败：${error?.message ?? error}`)
    }
    return { kind: 'json', file, exists, bytes, todos, schemaVersion: SCHEMA_VERSION, externalChanges, lastExternalAt }
  }

  return { kind: 'json', file, read, write, update, all, describe }
}
