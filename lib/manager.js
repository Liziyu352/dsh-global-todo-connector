/**
 * The connector registry: the thing the tools and the HTTP routes both talk to.
 *
 * Responsibilities, in the order they matter:
 *
 *   1. Keep connector files on disk as YAML in one directory, so the user can
 *      edit them with an editor, diff them with git, and move them between
 *      machines without the plugin getting in the way.
 *   2. Validate every file before it is accepted, and refuse to save a
 *      connector that could not run — a bad file discovered at 3 a.m. by a
 *      timer is much worse than a rejected write right now.
 *   3. Run connectors on a schedule and on demand, with the engine doing the
 *      actual pull/push work.
 *   4. Remember what happened: a bounded run log on disk, plus the in-memory
 *      copy the panel shows.
 *
 * Nothing here writes todos; that is `engine.js`'s job, and it does it through
 * `store.js`'s lock.
 */

import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ConnectorError } from './errors.js'
import { parseConnector, stringifyConnector, scaffoldConnector } from './connector.js'
import { createStore, resolvePluginDir, resolveStorePath } from './store.js'
import { createEngine } from './engine.js'
import { createHubClient } from './hub.js'

/** Only these suffixes are treated as connector files. */
const CONNECTOR_SUFFIXES = ['.yaml', '.yml']
const CONNECTOR_DIR = 'connectors'
const STATE_DIR = 'state'
const RUN_LOG = 'runs.jsonl'
/** Keep the on-disk run log bounded; it is a diagnostic, not an audit trail. */
const RUN_LOG_LIMIT = 500
const DEFAULT_HUB_TIMEOUT = 8000

/**
 * @param {object} options
 * @param {object} options.config plugin config from cordis
 * @param {{ info: Function, warn: Function, error: Function }} options.logger
 * @param {() => number} [options.now]
 */
export function createManager({ config = {}, logger, now = () => Date.now() }) {
  const pluginDir = resolvePluginDir(config)
  const connectorDir = path.join(pluginDir, CONNECTOR_DIR)
  const stateDir = path.join(pluginDir, STATE_DIR)
  const runLogFile = path.join(pluginDir, RUN_LOG)
  const store = createStore({ file: resolveStorePath(config), logger })
  const engine = createEngine({ store, stateDir, logger, now })

  /** name → timer handle for scheduled connectors */
  const timers = new Map()
  let bootTimer = null
  let started = false

  function hubOptions() {
    const raw = config.hub ?? {}
    const url = String(raw.url ?? process.env.GTC_HUB_URL ?? '').trim()
    if (url === '') return null
    return {
      url,
      token: String(raw.token ?? process.env.GTC_HUB_TOKEN ?? '').trim(),
      instance: String(raw.instance ?? '').trim() || undefined,
      timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : DEFAULT_HUB_TIMEOUT,
    }
  }

  function requireHub() {
    const options = hubOptions()
    if (options === null) {
      throw new ConnectorError('hub-unavailable', '没有配置 hub：请在插件配置里设置 hub.url，或设置 GTC_HUB_URL 环境变量')
    }
    return createHubClient(options)
  }

  // -- files ---------------------------------------------------------------

  async function ensureDirs() {
    await mkdir(connectorDir, { recursive: true })
    await mkdir(stateDir, { recursive: true })
  }

  function fileOf(name) {
    return path.join(connectorDir, `${name}.yaml`)
  }

  /** List connector files without parsing them (cheap enough for a panel). */
  async function listFiles() {
    let entries
    try {
      entries = await readdir(connectorDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw new ConnectorError('store-unwritable', `读不了连接器目录 ${connectorDir}：${error?.message ?? error}`)
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!CONNECTOR_SUFFIXES.includes(ext)) continue
      out.push({ name: path.basename(entry.name, ext), file: path.join(connectorDir, entry.name) })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /**
   * Read and validate one connector.
   *
   * Returns the normalized connector plus the raw text and the parsed YAML —
   * the panel shows the raw text, the tools work on the normalized form.
   */
  async function readConnector(name) {
    const candidates = [fileOf(name), path.join(connectorDir, `${name}.yml`)]
    for (const file of candidates) {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw new ConnectorError('store-unwritable', `读不了 ${file}：${error?.message ?? error}`)
      }
      const connector = parseConnector(text, { source: file })
      return { name, file, text, yaml: connector, source: file }
    }
    throw new ConnectorError('not-found', `连接器 ${name} 不存在（找过 ${candidates.join(' 和 ')}）`, { name })
  }

  /** All connector files, each parsed; a broken file is reported, not thrown. */
  async function listConnectors() {
    const files = await listFiles()
    const out = []
    for (const entry of files) {
      try {
        const loaded = await readConnector(entry.name)
        out.push({
          name: entry.name,
          file: entry.file,
          enabled: loaded.yaml.connector.enabled,
          direction: loaded.yaml.connector.direction,
          label: loaded.yaml.connector.label,
          client: loaded.yaml.client.name,
          kind: loaded.yaml.client.executor.kind,
          everyMinutes: loaded.yaml.connector.schedule.everyMinutes,
          conflicts: loaded.yaml.connector.conflict,
          ok: true,
        })
      } catch (error) {
        out.push({ name: entry.name, file: entry.file, ok: false, error: error?.message ?? String(error) })
      }
    }
    return out
  }

  /**
   * Validate YAML without saving it.
   *
   * The result is deliberately chatty: the first failure plus a list of what
   * was understood, because "invalid-connector: client.executor.pull：必填" is
   * only half an answer.
   */
  function validate(yamlText, options = {}) {
    const source = options.source ?? '<inline>'
    try {
      const connector = parseConnector(yamlText, { source })
      return {
        ok: true,
        connector: {
          name: connector.connector.name,
          direction: connector.connector.direction,
          executor: connector.client.executor.kind,
          tag: connector.tag,
          requiresPull: connector.requiresPull,
          requiresPush: connector.requiresPush,
          pullFields: Object.keys(connector.mapping.pull),
        },
      }
    } catch (error) {
      throw error
    }
  }

  /**
   * Save a connector, refusing anything that does not parse.
   *
   * `revision` is intentionally absent here: connector files are local and the
   * hub is the only place with optimistic locking.
   */
  async function writeConnector(name, yamlText) {
    const connector = parseConnector(yamlText, { source: `connectors/${name}.yaml` })
    if (connector.connector.name !== name) {
      throw new ConnectorError(
        'invalid-connector',
        `文件名是 ${name}，但 YAML 里的 connector.name 是 ${connector.connector.name}；两者必须一致（文件名就是连接器 id）`,
        { field: 'connector.name' },
      )
    }
    await ensureDirs()
    const file = fileOf(name)
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    let handle
    try {
      handle = await open(temp, 'w', 0o600)
      await handle.writeFile(yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`, 'utf8')
      await handle.sync().catch(() => {})
    } finally {
      await handle?.close().catch(() => {})
    }
    await rename(temp, file)
    reschedule(connector)
    return { name, file, connector }
  }

  async function deleteConnector(name) {
    const file = fileOf(name)
    try {
      await rm(file, { force: false })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Try the .yml spelling before declaring it missing.
        try {
          await rm(path.join(connectorDir, `${name}.yml`), { force: false })
          return { name, deleted: true }
        } catch (inner) {
          if (inner?.code === 'ENOENT') throw new ConnectorError('not-found', `连接器 ${name} 不存在`, { name })
          throw inner
        }
      }
      throw error
    }
    clearTimer(name)
    return { name, deleted: true }
  }

  /** A starting point a human can edit. Never enabled by default. */
  function scaffold(options = {}) {
    return scaffoldConnector(options)
  }

  // -- runs ----------------------------------------------------------------

  async function appendRun(entry) {
    // The file is the single source of truth: `lastRuns` reads it back, so an
    // in-memory mirror would only be a second copy that can disagree after a
    // reload. Keeping < 500 lines makes reading it cheap.
    try {
      await ensureDirs()
      await appendFile(runLogFile, `${JSON.stringify(entry)}\n`, 'utf8')
      await trimRunLog()
    } catch (error) {
      // A full disk must not fail a sync that already succeeded.
      logger?.warn?.(`写运行日志失败：${error?.message ?? error}`)
    }
  }

  /**
   * Keep the run log bounded.
   *
   * Trimming on every write would rewrite the file on every sync; instead the
   * file is allowed to grow to a size multiple of the retention window and then
   * compacted in one pass. `appendFile` cannot exceed a few hundred KB between
   * compactions, so this stays cheap.
   */
  async function trimRunLog() {
    const info = await stat(runLogFile).catch(() => null)
    if (info === null || info.size < RUN_LOG_LIMIT * 400) return
    const text = await readFile(runLogFile, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length <= RUN_LOG_LIMIT) return
    const kept = lines.slice(-RUN_LOG_LIMIT).join('\n')
    const temp = `${runLogFile}.${process.pid}.trim.tmp`
    await writeFile(temp, `${kept}\n`, 'utf8')
    await rename(temp, runLogFile)
  }

  async function readRunLog(limit = 50) {
    try {
      const text = await readFile(runLogFile, 'utf8')
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      const out = []
      for (const line of lines.slice(-limit)) {
        try {
          out.push(JSON.parse(line))
        } catch {
          /* skip a torn line */
        }
      }
      return out.reverse()
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw new ConnectorError('store-unwritable', `读不了运行日志 ${runLogFile}：${error?.message ?? error}`)
    }
  }

  /**
   * Run one connector now.
   *
   * The report is written to the run log and to the hub when one is configured;
   * failures are converted into a report with `ok: false` so a timer can log
   * them without a try/catch at every call site.
   */
  async function sync(name, options = {}) {
    const loaded = await readConnector(name)
    const connector = loaded.yaml
    const startedAt = now()
    const reason = options.reason ?? 'manual'
    let report
    let failure = null
    try {
      report = await engine.sync(connector, { dryRun: options.dryRun === true, reason })
    } catch (error) {
      failure = error
      report = {
        connector: name,
        label: connector.connector.label,
        direction: connector.connector.direction,
        dryRun: options.dryRun === true,
        reason,
        startedAt,
        finishedAt: now(),
        durationMs: now() - startedAt,
        failed: true,
        failureReason: error?.reason ?? 'internal',
        error: error?.message ?? String(error),
      }
    }
    const entry = {
      at: now(),
      connector: name,
      reason,
      dryRun: options.dryRun === true,
      ok: failure === null,
      failed: failure !== null,
      ...(failure === null ? {} : { failureReason: report.failureReason, error: report.error }),
      report,
    }
    await appendRun(entry)
    await mirrorRunToHub(name, entry)
    if (failure !== null) throw failure
    return report
  }

  async function mirrorRunToHub(name, entry) {
    const options = hubOptions()
    if (options === null) return
    try {
      const hub = createHubClient(options)
      await hub.addRun(name, entry)
    } catch (error) {
      // The hub is a convenience; a run that succeeded locally stays succeeded.
      logger?.warn?.(`把运行结果写进 hub 失败：${error?.message ?? error}`)
    }
  }

  async function lastRuns(name, limit = 20) {
    const log = await readRunLog(RUN_LOG_LIMIT)
    const filtered = name === undefined ? log : log.filter((entry) => entry.connector === name)
    return filtered.slice(0, limit)
  }

  // -- scheduling ----------------------------------------------------------

  function clearTimer(name) {
    const handle = timers.get(name)
    if (handle !== undefined) {
      clearTimeout(handle)
      timers.delete(name)
    }
  }

  function reschedule(connector) {
    const name = connector.connector.name
    clearTimer(name)
    if (!connector.connector.enabled) return
    const minutes = connector.connector.schedule.everyMinutes
    if (!Number.isInteger(minutes) || minutes <= 0) return
    const period = minutes * 60_000
    const tick = async () => {
      try {
        await sync(name, { reason: 'schedule' })
      } catch (error) {
        logger?.warn?.(`定时同步 ${name} 失败：${error?.message ?? error}`)
      }
      // Re-arm only after the run finished: a slow connector must not stack up
      // overlapping runs behind itself.
      if (timers.has(name)) {
        const handle = setTimeout(tick, period)
        handle.unref?.()
        timers.set(name, handle)
      }
    }
    const handle = setTimeout(tick, period)
    handle.unref?.()
    timers.set(name, handle)
  }

  /** Start the scheduler for every enabled connector. Idempotent. */
  async function start() {
    if (started) return { started: false, scheduled: timers.size }
    started = true
    await ensureDirs()
    const files = await listFiles()
    let scheduled = 0
    for (const entry of files) {
      try {
        const loaded = await readConnector(entry.name)
        reschedule(loaded.yaml)
        if (loaded.yaml.connector.enabled && loaded.yaml.connector.schedule.onBoot) {
          // Run once shortly after boot; a burst at load time would fight the
          // host's own startup work for the event loop.
          setTimeout(() => {
            sync(entry.name, { reason: 'boot' }).catch((error) => {
              logger?.warn?.(`启动同步 ${entry.name} 失败：${error?.message ?? error}`)
            })
          }, 3000)?.unref?.()
        }
        if (loaded.yaml.connector.enabled && loaded.yaml.connector.schedule.everyMinutes > 0) scheduled += 1
      } catch (error) {
        logger?.warn?.(`跳过无法解析的连接器 ${entry.name}：${error?.message ?? error}`)
      }
    }
    return { started: true, scheduled }
  }

  function stop() {
    started = false
    for (const name of [...timers.keys()]) clearTimer(name)
    if (bootTimer !== null) {
      clearTimeout(bootTimer)
      bootTimer = null
    }
  }

  // -- hub ----------------------------------------------------------------

  async function hubStatus() {
    const hub = requireHub()
    const health = await hub.health()
    const remote = await hub.listConnectors()
    const local = await listConnectors()
    const localNames = new Set(local.map((item) => item.name))
    return {
      url: hub.url,
      instance: hub.instance,
      health,
      remote: remote.map((entry) => ({ ...entry, local: localNames.has(entry.name) })),
      local: local.map((entry) => entry.name),
    }
  }

  async function hubPull(options = {}) {
    const hub = requireHub()
    const remote = await hub.listConnectors()
    const names = Array.isArray(options.names) && options.names.length > 0 ? options.names : remote.map((e) => e.name)
    const written = []
    const skipped = []
    for (const name of names) {
      const detail = await hub.getConnector(name)
      parseConnector(detail.yaml, { source: `hub:${name}` })
      const existing = await readFile(fileOf(name), 'utf8').catch(() => null)
      if (existing !== null && options.force !== true) {
        skipped.push({ name, reason: '本地已有同名连接器（force 可覆盖）' })
        continue
      }
      await writeConnector(name, detail.yaml)
      written.push({ name, revision: detail.revision, hash: detail.hash })
    }
    return { written, skipped }
  }

  async function hubPush(options = {}) {
    const hub = requireHub()
    const names = Array.isArray(options.names) && options.names.length > 0 ? options.names : (await listFiles()).map((e) => e.name)
    const pushed = []
    for (const name of names) {
      const loaded = await readConnector(name)
      const existing = await hub.getConnector(name).catch((error) => {
        if (error?.reason === 'not-found') return null
        throw error
      })
      const result = await hub.putConnector(name, loaded.text, {
        revision: options.force === true ? undefined : existing?.revision,
      })
      pushed.push({ name, revision: result.revision, hash: result.hash })
    }
    return { pushed }
  }

  async function hubRuns(options = {}) {
    const hub = requireHub()
    return hub.listRuns({ connector: options.connector, limit: options.limit })
  }

  // -- status --------------------------------------------------------------

  /** Everything a status call needs to answer "is this thing healthy?". */
  async function status() {
    const stored = await store.describe().catch((error) => ({ file: null, error: error?.message ?? String(error) }))
    const hub = hubOptions()
    return {
      pluginDir,
      connectorDir,
      stateDir,
      hub: hub === null ? null : { url: hub.url, instance: hub.instance, token: hub.token !== '' },
      store: stored,
      connectors: await listConnectors(),
      scheduled: [...timers.keys()],
    }
  }

  return {
    pluginDir,
    connectorDir,
    stateDir,
    fileOf,
    listFiles,
    listConnectors,
    readConnector,
    writeConnector,
    deleteConnector,
    validate,
    scaffold,
    sync,
    lastRuns,
    start,
    stop,
    status,
    hubStatus,
    hubPull,
    hubPush,
    hubRuns,
    engine,
    store,
    stringifyConnector,
  }
}
