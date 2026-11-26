/**
 * The sync engine: pull a connector's records, map them onto the
 * `dsh-global-todo` store, and push local changes back.
 *
 * Design notes that are load-bearing:
 *
 *   - **The file lock is never held across a network call.**  A pull can take
 *     seconds; holding `todos.json.lock` for that long would block the panel.
 *     So a sync is: pull outside the lock → apply under the lock → push outside
 *     the lock.
 *
 *   - **Idempotency lives in a state file, not in the todo.**  Each connector
 *     keeps `{ remoteId ↔ localId }` plus the `updatedAt` pair it saw last, so
 *     the next run can tell "unchanged / changed here / changed there" without
 *     guessing.  The `client:<name>` tag is a *recovery* hint (state rebuilt by
 *     exact title match) rather than the primary key, because tags are
 *     user-editable and length-capped.
 *
 *   - **Nothing is deleted implicitly.**  A remote record disappearing does not
 *     delete the local todo: the local list is the human's memory, and a
 *     connector bug must not be able to erase it.  Removals only flow local →
 *     remote when the user explicitly asks.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ConnectorError } from './errors.js'
import { readPath, renderDeep } from './connector.js'
import { pullRecords, pushRecords } from './runner.js'
import { LIMITS, STATUSES, createTodoRecord, hasInboxTag, newTodoId, priorityForDue } from './store.js'

export const STATE_VERSION = 1

/** The default remote→local status vocabulary, when the connector has no map. */
const STATUS_FALLBACK = Object.freeze({
  open: 'open',
  todo: 'open',
  pending: 'open',
  doing: 'doing',
  inprogress: 'doing',
  'in-progress': 'doing',
  active: 'doing',
  blocked: 'doing',
  done: 'done',
  completed: 'done',
  complete: 'done',
  closed: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  archived: 'archived',
})

const PRIORITY_FALLBACK = Object.freeze({
  p0: 'urgent',
  p1: 'high',
  p2: 'normal',
  p3: 'low',
  urgent: 'urgent',
  critical: 'urgent',
  highest: 'urgent',
  high: 'high',
  medium: 'normal',
  normal: 'normal',
  low: 'low',
  lowest: 'low',
  none: 'low',
})

/**
 * Load a connector's sync state, tolerating a missing or damaged file.
 *
 * Losing state costs one re-link pass, so it is never worth failing a sync
 * over — but it *is* worth warning about, because a silent rebuild can pair
 * the wrong records.
 *
 * @param {string} file
 * @param {{ warn?: (message: string) => void }} [logger]
 */
export async function loadState(file, logger) {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || !parsed.links) throw new Error('缺少 links')
    const links = {}
    for (const [localId, link] of Object.entries(parsed.links)) {
      if (link === null || typeof link !== 'object') continue
      if (typeof link.remoteId !== 'string') continue
      links[localId] = {
        remoteId: link.remoteId,
        localUpdatedAt: Number.isFinite(link.localUpdatedAt) ? link.localUpdatedAt : 0,
        remoteUpdatedAt: Number.isFinite(link.remoteUpdatedAt) ? link.remoteUpdatedAt : 0,
        localStatus: typeof link.localStatus === 'string' ? link.localStatus : 'open',
        remoteStatus: typeof link.remoteStatus === 'string' ? link.remoteStatus : 'open',
        lastSyncedAt: Number.isFinite(link.lastSyncedAt) ? link.lastSyncedAt : 0,
      }
    }
    return { version: STATE_VERSION, links, lastRun: parsed.lastRun ?? null, lastResult: parsed.lastResult ?? null }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`连接器状态文件 ${file} 读不了，按空状态继续：${error?.message ?? error}`)
    }
    return { version: STATE_VERSION, links: {}, lastRun: null, lastResult: null }
  }
}

/**
 * Persist state atomically (temp file + rename), so a crash mid-write leaves
 * the previous good copy in place.
 *
 * @param {string} file
 * @param {object} state
 */
export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  const payload = `${JSON.stringify(state, null, 2)}\n`
  await writeFile(temp, payload, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw new ConnectorError('store-unwritable', `写入状态 ${file} 失败：${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function lookupMap(map, value) {
  if (value === undefined || value === null) return undefined
  const key = String(value).trim().toLowerCase()
  for (const [from, to] of Object.entries(map ?? {})) {
    if (String(from).trim().toLowerCase() === key) return to
  }
  return undefined
}

function normalizeStatus(value, map) {
  if (value === undefined || value === null || value === '') return undefined
  const mapped = lookupMap(map, value) ?? lookupMap(STATUS_FALLBACK, value)
  if (mapped !== undefined && STATUSES.includes(mapped)) return mapped
  const direct = String(value).trim().toLowerCase()
  return STATUSES.includes(direct) ? direct : undefined
}

function normalizePriorityValue(value, map) {
  if (value === undefined || value === null || value === '') return undefined
  const mapped = lookupMap(map, value) ?? lookupMap(PRIORITY_FALLBACK, value)
  if (mapped !== undefined) return mapped
  const direct = String(value).trim().toLowerCase()
  return ['urgent', 'high', 'normal', 'low'].includes(direct) ? direct : undefined
}

function normalizeDue(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything below 1e12 is a Unix timestamp in seconds.
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeTagsOf(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#/, '')
    if (tag === '' || tag.length > LIMITS.tag) continue
    // Case-insensitive dedupe, matching the upstream tag rules: `Foo` and `foo`
    // are the same tag, and the first spelling wins.
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= LIMITS.tags) break
  }
  return out
}

/**
 * Turn one remote record into the local field set.
 *
 * Unknown/blank fields are `undefined` rather than a default, so a patch never
 * overwrites a local value the downstream simply did not send.
 *
 * @param {unknown} record
 * @param {object} connector
 * @returns {{ remoteId: string, fields: object }}
 */
export function mapRemote(record, connector) {
  const pull = connector.mapping.pull
  const read = (key) => (pull[key] === undefined ? undefined : readPath(record, pull[key].path))
  const remoteIdRaw = read('id')
  const remoteId = remoteIdRaw === undefined || remoteIdRaw === null ? '' : String(remoteIdRaw).trim()
  if (remoteId === '') {
    throw new ConnectorError(
      'invalid-remote',
      `记录缺少 id 字段（mapping.pull.id 指向 "${pull.id.path}"）：${JSON.stringify(record).slice(0, 200)}`,
    )
  }
  const title = read('title')
  const fields = {
    title: typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, LIMITS.title) : undefined,
    description:
      typeof read('description') === 'string' ? String(read('description')).trim().slice(0, LIMITS.description) : undefined,
    dueAt: read('dueAt') === undefined ? undefined : normalizeDue(read('dueAt')),
    status: normalizeStatus(read('status'), pull.status?.map),
    priority: normalizePriorityValue(read('priority'), pull.priority?.map),
    tags: read('tags') === undefined ? undefined : normalizeTagsOf(read('tags')),
    notes: read('notes') === undefined ? undefined : String(read('notes')).trim().slice(0, LIMITS.note),
  }
  const updatedRaw = pull.updatedAt === undefined ? undefined : readPath(record, pull.updatedAt.path)
  const updatedAt = updatedRaw === undefined ? 0 : Number.isFinite(Number(updatedRaw)) ? Number(updatedRaw) : Date.parse(String(updatedRaw)) || 0
  return { remoteId, fields, remoteUpdatedAt: Number.isFinite(updatedAt) ? updatedAt : 0, record }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {ReturnType<import('./store.js').createStore>} options.store
 * @param {string} options.stateDir directory holding per-connector `state.json`
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.logger]
 * @param {() => number} [options.now]
 */
export function createEngine({ store, stateDir, logger, now = () => Date.now() }) {
  /** @type {Map<string, Promise<object>>} serializes runs per connector */
  const running = new Map()

  async function stateFileOf(name) {
    return path.join(stateDir, `${name}.state.json`)
  }

  /**
   * Pull one connector.
   *
   * @param {object} connector normalized connector
   * @param {{ dryRun?: boolean, reason?: string }} [options]
   * @returns {Promise<object>} a run report
   */
  async function pull(connector, options = {}) {
    const name = connector.connector.name
    const startedAt = now()
    const stateFile = await stateFileOf(name)
    const state = await loadState(stateFile, logger)
    const { records, meta } = await pullRecords(connector, { scope: { connector: connector.connector, client: connector.client } })

    const mapped = []
    const skipped = []
    for (const record of records) {
      if (mapped.length >= connector.connector.limits.maxPull) break
      try {
        mapped.push(mapRemote(record, connector))
      } catch (error) {
        skipped.push({ reason: error?.message ?? String(error) })
      }
    }

    const byRemoteId = new Map()
    for (const [localId, link] of Object.entries(state.links)) byRemoteId.set(link.remoteId, localId)

    const report = {
      connector: name,
      direction: 'pull',
      startedAt,
      finishedAt: startedAt,
      dryRun: options.dryRun === true,
      reason: options.reason ?? 'manual',
      remote: { total: records.length, usable: mapped.length, skipped: skipped.length, meta },
      created: [],
      updated: [],
      conflicts: [],
      unlinked: [],
      skipped,
    }

    const plan = await store.update((doc) => {
      const created = []
      const updated = []
      const conflicts = []
      const touched = new Set()

      // Index by title for the state-recovery path only.
      const titleIndex = new Map()
      for (const todo of doc.todos) {
        if (!Array.isArray(todo.tags) || !todo.tags.includes(connector.tag)) continue
        const key = todo.title.trim().toLowerCase()
        if (!titleIndex.has(key)) titleIndex.set(key, todo)
      }

      for (const item of mapped) {
        const knownLocalId = byRemoteId.get(item.remoteId)
        let todo = knownLocalId === undefined ? undefined : doc.todos.find((candidate) => candidate.id === knownLocalId)
        let recovered = false
        if (todo === undefined && item.fields.title !== undefined) {
          // State loss recovery: the tag says this came from us, and an exact
          // title match is unambiguous enough to re-attach.
          const candidate = titleIndex.get(item.fields.title.trim().toLowerCase())
          if (candidate !== undefined && !touched.has(candidate.id)) {
            todo = candidate
            recovered = true
          }
        }

        if (todo === undefined) {
          if (item.fields.title === undefined) {
            report.skipped.push({ remoteId: item.remoteId, reason: '远端记录没有标题' })
            continue
          }
          const id = newTodoId(doc.todos.map((entry) => entry.id))
          const tags = [connector.tag, ...(connector.client.tags ?? []), ...(item.fields.tags ?? [])]
          if (connector.projectTag) tags.push(connector.projectTag)
          const status = item.fields.status ?? 'open'
          const dueAt = item.fields.dueAt ?? null
          const record = createTodoRecord({
            id,
            title: item.fields.title,
            description: item.fields.description ?? '',
            status,
            dueAt,
            tags,
            notes: item.fields.notes,
            createdBy: 'agent',
            // A downstream that names a priority wins (`prioritySource: human`
            // tells the panel not to re-level it by deadline). Otherwise the
            // level is derived from the deadline the way the upstream plugin
            // does it, and `client.priority` is only the no-deadline fallback.
            priority:
              item.fields.priority ??
              (dueAt === null ? connector.client.priority : priorityForDue(dueAt, { now: startedAt })),
            prioritySource: item.fields.priority === undefined ? 'rule' : 'human',
            captureSource: 'connector',
            now: startedAt,
          })
          doc.todos.push(record)
          touched.add(record.id)
          created.push({ localId: record.id, remoteId: item.remoteId, title: record.title })
          if (!report.dryRun) {
            state.links[record.id] = {
              remoteId: item.remoteId,
              localUpdatedAt: record.updatedAt,
              remoteUpdatedAt: item.remoteUpdatedAt,
              localStatus: record.status,
              remoteStatus: status,
              lastSyncedAt: startedAt,
            }
          }
          continue
        }

        touched.add(todo.id)
        const link = state.links[todo.id] ?? {
          remoteId: item.remoteId,
          localUpdatedAt: 0,
          remoteUpdatedAt: 0,
          localStatus: todo.status,
          remoteStatus: 'open',
          lastSyncedAt: 0,
        }

        const localChanged = todo.updatedAt > (link.localUpdatedAt ?? 0)
        const remoteChanged = item.remoteUpdatedAt > (link.remoteUpdatedAt ?? 0) || (item.remoteUpdatedAt === 0 && link.remoteUpdatedAt === 0 && recovered)
        const changes = {}

        const consider = (key, next) => {
          if (next === undefined) return
          const current = todo[key]
          if (JSON.stringify(current) === JSON.stringify(next)) return
          changes[key] = next
        }
        // Only a remote record that actually moved may overwrite local fields.
        // Replaying an unchanged record would undo edits the user made here:
        // the values differ precisely because the local side moved.
        if (remoteChanged) {
          consider('title', item.fields.title)
          consider('description', item.fields.description)
          consider('dueAt', item.fields.dueAt === undefined ? undefined : item.fields.dueAt)
          consider('status', item.fields.status)
          // A remote priority is the human's decision on the other side, so it is
          // recorded as `human`-sourced. Compare first: assigning unconditionally
          // would make every run look like a change and rewrite updatedAt.
          if (item.fields.priority !== undefined && item.fields.priority !== todo.priority) {
            changes.priority = item.fields.priority
            changes.prioritySource = 'human'
          }
          if (item.fields.tags !== undefined) {
            const merged = new Set([...(todo.tags ?? []), connector.tag, ...(connector.client.tags ?? [])])
            if (connector.projectTag) merged.add(connector.projectTag)
            for (const tag of item.fields.tags) if (!merged.has(tag)) merged.add(tag)
            const next = [...merged].slice(0, LIMITS.tags)
            if (JSON.stringify(next) !== JSON.stringify(todo.tags)) changes.tags = next
          }
        }

        if (Object.keys(changes).length === 0) {
          if (!report.dryRun) {
            state.links[todo.id] = {
              ...link,
              remoteId: item.remoteId,
              remoteUpdatedAt: item.remoteUpdatedAt || link.remoteUpdatedAt,
              localUpdatedAt: todo.updatedAt,
              localStatus: todo.status,
              remoteStatus: item.fields.status ?? link.remoteStatus,
              lastSyncedAt: startedAt,
            }
          }
          continue
        }

        if (localChanged && remoteChanged) {
          // Both sides moved. The policy decides, and the loser is recorded so
          // the run report can say exactly what was overwritten.
          const localAt = todo.updatedAt ?? 0
          const remoteAt = item.remoteUpdatedAt ?? 0
          let winner = connector.connector.conflict
          if (winner === 'newer') winner = remoteAt >= localAt ? 'remote' : 'local'
          conflicts.push({
            localId: todo.id,
            remoteId: item.remoteId,
            winner,
            policy: connector.connector.conflict,
            fields: Object.keys(changes),
            localUpdatedAt: localAt,
            remoteUpdatedAt: remoteAt,
          })
          if (winner === 'local') {
            if (!report.dryRun) {
              // Keep the local values but remember the remote watermark so the
              // same conflict is not re-raised every run.
              state.links[todo.id] = {
                ...link,
                remoteId: item.remoteId,
                remoteUpdatedAt: item.remoteUpdatedAt,
                lastSyncedAt: startedAt,
              }
            }
            continue
          }
        }

        Object.assign(todo, changes)
        todo.updatedAt = startedAt
        todo.updatedBy = 'agent'
        todo.activity = Array.isArray(todo.activity) ? todo.activity.slice(-LIMITS.activity) : []
        todo.activity.push({ kind: 'synced', by: 'agent', at: startedAt, summary: `来自 ${connector.client.name}：${Object.keys(changes).join(', ')}` })
        updated.push({ localId: todo.id, remoteId: item.remoteId, fields: Object.keys(changes) })
        if (!report.dryRun) {
          state.links[todo.id] = {
            remoteId: item.remoteId,
            localUpdatedAt: todo.updatedAt,
            remoteUpdatedAt: item.remoteUpdatedAt,
            localStatus: todo.status,
            remoteStatus: item.fields.status ?? link.remoteStatus,
            lastSyncedAt: startedAt,
          }
        }
      }

      // Local todos that carry our tag but have no remote counterpart are
      // reported, never deleted: this is the "somebody removed it upstream"
      // case, which a human decides.
      // Presence must be judged against what this run actually fetched, not
      // against the previous state: the old link still names a remote record
      // that no longer exists, which is exactly the case worth reporting.
      const presentRemoteIds = new Set(mapped.map((item) => item.remoteId))
      for (const todo of doc.todos) {
        if (!Array.isArray(todo.tags) || !todo.tags.includes(connector.tag)) continue
        if (touched.has(todo.id)) continue
        const link = state.links[todo.id]
        if (link === undefined) continue
        if (!presentRemoteIds.has(link.remoteId)) {
          report.unlinked.push({ localId: todo.id, remoteId: link.remoteId, title: todo.title })
        }
      }

      report.created = report.dryRun ? created : created
      report.updated = updated
      report.conflicts = conflicts
      report.finishedAt = now()
      if (options.dryRun) {
        return { result: null }
      }
      return { next: doc.todos, result: null }
    })

    void plan
    if (!options.dryRun) {
      state.lastRun = startedAt
      state.lastResult = summarize(report)
      await saveState(stateFile, state)
    }
    report.durationMs = now() - startedAt
    return report
  }

  /**
   * Push local changes for one connector.
   *
   * Only todos that carry the connector's tag *and* changed after the last
   * successful sync are candidates — otherwise every run would rewrite the
   * whole list into the downstream system.
   *
   * @param {object} connector
   * @param {{ dryRun?: boolean, reason?: string }} [options]
   * @returns {Promise<object>}
   */
  async function push(connector, options = {}) {
    const name = connector.connector.name
    const startedAt = now()
    const stateFile = await stateFileOf(name)
    const state = await loadState(stateFile, logger)

    const candidates = await store.all()
    const batch = []
    for (const todo of candidates) {
      if (!Array.isArray(todo.tags) || !todo.tags.includes(connector.tag)) continue
      const link = state.links[todo.id]
      const changedLocally = link === undefined || (todo.updatedAt ?? 0) > (link.localUpdatedAt ?? 0)
      if (!changedLocally) continue
      if (hasInboxTag(todo)) continue
      const payload = buildPushPayload(todo, link, connector, startedAt)
      batch.push({ todo, payload, remoteId: link?.remoteId })
      if (batch.length >= connector.connector.limits.maxPush) break
    }

    const report = {
      connector: name,
      direction: 'push',
      startedAt,
      finishedAt: startedAt,
      dryRun: options.dryRun === true,
      reason: options.reason ?? 'manual',
      candidates: batch.length,
      items: batch.map((item) => ({ localId: item.todo.id, remoteId: item.remoteId ?? null, title: item.todo.title })),
      pushed: 0,
      meta: {},
    }
    if (options.dryRun || batch.length === 0) {
      report.finishedAt = now()
      report.durationMs = report.finishedAt - startedAt
      return report
    }

    const result = await pushRecords(
      connector,
      batch.map((item) => ({ payload: item.payload, remoteId: item.remoteId })),
      { scope: { connector: connector.connector, client: connector.client } },
    )
    report.pushed = result.pushed
    report.createdRemote = result.created ?? 0
    report.updatedRemote = result.updated ?? 0
    report.meta = result.meta

    await store.update((doc) => {
      const touched = new Set(batch.map((item) => item.todo.id))
      for (const todo of doc.todos) {
        if (!touched.has(todo.id)) continue
        // Only the watermark moves: `updatedAt` is the user's edit time and
        // must not be rewritten just because we talked to the downstream.
        const link = state.links[todo.id] ?? { remoteId: '', remoteUpdatedAt: 0, localStatus: 'open', remoteStatus: 'open' }
        state.links[todo.id] = {
          ...link,
          localUpdatedAt: todo.updatedAt,
          localStatus: todo.status,
          lastSyncedAt: startedAt,
        }
      }
      return { result: null }
    })
    state.lastRun = startedAt
    state.lastResult = summarize(report)
    await saveState(stateFile, state)
    report.finishedAt = now()
    report.durationMs = report.finishedAt - startedAt
    return report
  }

  /**
   * Run one connector in its configured direction(s).
   *
   * Concurrent calls for the same connector share the in-flight promise: two
   * timers firing at once must not double-create.
   *
   * @param {object} connector
   * @param {{ dryRun?: boolean, reason?: string }} [options]
   */
  function sync(connector, options = {}) {
    const name = connector.connector.name
    const existing = running.get(name)
    if (existing !== undefined) return existing
    const task = (async () => {
      const startedAt = now()
      const parts = []
      if (connector.requiresPull) parts.push(await pull(connector, options))
      if (connector.requiresPush) parts.push(await push(connector, options))
      const report = {
        connector: name,
        label: connector.connector.label,
        direction: connector.connector.direction,
        dryRun: options.dryRun === true,
        reason: options.reason ?? 'manual',
        startedAt,
        finishedAt: now(),
        durationMs: 0,
        parts,
        created: parts.reduce((sum, part) => sum + (part.created?.length ?? 0), 0),
        updated: parts.reduce((sum, part) => sum + (part.updated?.length ?? 0), 0),
        conflicts: parts.reduce((sum, part) => sum + (part.conflicts?.length ?? 0), 0),
        pushed: parts.reduce((sum, part) => sum + (part.pushed ?? 0), 0),
        unlinked: parts.reduce((sum, part) => sum + (part.unlinked?.length ?? 0), 0),
      }
      report.durationMs = report.finishedAt - report.startedAt
      return report
    })()
    running.set(name, task)
    task.then(
      () => running.delete(name),
      () => running.delete(name),
    )
    return task
  }

  return { pull, push, sync, isRunning: (name) => running.has(name) }
}

/**
 * Build the downstream payload for one local todo.
 *
 * `mapping.push` is a template tree: every string inside is rendered against
 * `{ todo, remoteId }`, so `${todo.title}` and `${todo.dueAt}` work anywhere.
 * When no `mapping.push` is configured the todo's own fields are sent.
 *
 * @param {object} todo
 * @param {object | undefined} link
 * @param {object} connector
 * @param {number} at
 */
export function buildPushPayload(todo, link, connector, at) {
  const scope = {
    todo: {
      ...todo,
      overdue: todo.dueAt !== null && todo.dueAt !== undefined && Date.parse(todo.dueAt) < at,
    },
    remoteId: link?.remoteId ?? '',
    client: connector.client,
    connector: connector.connector,
  }
  const template = connector.mapping.push
  if (template === null || template === undefined) {
    return {
      title: todo.title,
      description: todo.description,
      dueAt: todo.dueAt,
      status: todo.status,
      priority: todo.priority,
      tags: todo.tags,
      ...(link?.remoteId ? { id: link.remoteId } : {}),
    }
  }
  // `renderDeep` walks nested maps/lists, so a downstream that wants
  // `{"status": {"pending": ...}}` can express it instead of receiving the
  // template object stringified into one field.
  const rendered = {}
  for (const [key, value] of Object.entries(template)) rendered[key] = renderDeep(value, scope)
  return rendered
}

/** The compact form stored as `lastResult`. */
function summarize(report) {
  return {
    at: report.finishedAt ?? report.startedAt,
    direction: report.direction,
    created: report.created?.length ?? 0,
    updated: report.updated?.length ?? 0,
    conflicts: report.conflicts?.length ?? 0,
    pushed: report.pushed ?? 0,
    unlinked: report.unlinked?.length ?? 0,
  }
}
