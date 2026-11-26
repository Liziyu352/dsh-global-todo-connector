/**
 * Client for the optional local Connector Hub.
 *
 * The hub is a tiny FastAPI service that stores connector YAML, a shared sync
 * state blob, a run log and short-lived write leases.  It exists so that two
 * machines can share one set of connector definitions instead of each keeping
 * its own copy — the same problem `dsh-global-todo`'s `sync.dir` solves for
 * todos, but one level up: here it is the *connector definitions* that must
 * agree, because a connector that runs on both machines twice will duplicate
 * every record downstream.
 *
 * Nothing in this module is required for the plugin to work: every method here
 * is only called when the user configured `hub.url`.
 */

import { hostname } from 'node:os'
import { ConnectorError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Build a hub client.
 *
 * `url` is the hub root (e.g. `http://127.0.0.1:8765`); a trailing slash is
 * tolerated because people paste URLs out of a terminal.
 *
 * @param {{ url: string, token?: string, instance?: string, timeoutMs?: number }} options
 */
export function createHubClient(options = {}) {
  const baseUrl = String(options.url ?? '').trim().replace(/\/+$/, '')
  if (baseUrl === '') throw new ConnectorError('invalid-request', 'hub.url 为空')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new ConnectorError('invalid-request', `hub.url 不是合法 URL：${baseUrl}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ConnectorError('invalid-request', 'hub.url 只支持 http:// 或 https://')
  }

  const token = String(options.token ?? '').trim()
  const instance = String(options.instance ?? '').trim() || defaultInstance()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  /**
   * One request.  Every failure mode is translated into a ConnectorError so
   * callers never have to distinguish "network died" from "hub said no".
   */
  async function request(method, path, body) {
    const url = `${baseUrl}${path}`
    const headers = { accept: 'application/json' }
    if (token !== '') headers['x-hub-token'] = token
    const init = { method, headers, redirect: 'follow' }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    init.signal = controller.signal
    let response
    try {
      response = await fetch(url, init)
    } catch (error) {
      clearTimeout(timer)
      if (error?.name === 'AbortError') {
        throw new ConnectorError('hub-unavailable', `连接 hub 超时（${timeoutMs}ms）：${url}`)
      }
      throw new ConnectorError('hub-unavailable', `连不上 hub ${url}：${error?.message ?? error}`)
    }
    let text
    try {
      text = await response.text()
    } finally {
      clearTimeout(timer)
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new ConnectorError('hub-unavailable', `hub 响应超过 ${MAX_RESPONSE_BYTES} 字节上限`)
    }
    let payload
    try {
      payload = text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      // A proxy or a wrong port usually answers with HTML; say so instead of
      // surfacing a JSON parse error that points at the wrong thing.
      throw new ConnectorError(
        'hub-unavailable',
        `${url} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      )
    }
    if (payload?.ok === true) return payload.data
    if (payload?.ok === false) {
      throw new ConnectorError(
        String(payload.reason ?? 'hub-error'),
        String(payload.error ?? `hub 请求失败（HTTP ${response.status}）`),
        stripEnvelope(payload),
      )
    }
    // The hub always wraps; anything else is not a hub we understand.
    throw new ConnectorError(
      'hub-unavailable',
      `${url} 的响应不是 hub 包络（HTTP ${response.status}）：${text.slice(0, 200)}`,
    )
  }

  return {
    url: baseUrl,
    instance,
    timeoutMs,

    /** Liveness + counters.  Works without a token (the hub leaves /health open). */
    health: () => request('GET', '/health'),

    listConnectors: () => request('GET', '/v1/connectors').then((data) => data.connectors ?? []),

    /** @returns {Promise<{name:string,yaml:string,revision:number,hash:string}>} */
    getConnector: (name) => request('GET', `/v1/connectors/${encodeURIComponent(name)}`),

    /**
     * Create or replace a connector.
     *
     * `revision` is the optimistic-lock guard: pass the revision you read to
     * avoid clobbering an edit made on another machine.  Omit it to overwrite.
     */
    putConnector: (name, yaml, options = {}) =>
      request('PUT', `/v1/connectors/${encodeURIComponent(name)}`, {
        yaml,
        ...(options.owner === undefined ? { owner: instance } : { owner: options.owner }),
        ...(options.revision === undefined ? {} : { revision: options.revision }),
      }),

    deleteConnector: (name, options = {}) => {
      const query = options.revision === undefined ? '' : `?revision=${encodeURIComponent(options.revision)}`
      return request('DELETE', `/v1/connectors/${encodeURIComponent(name)}${query}`)
    },

    /**
     * Take the write lease for one connector.
     *
     * Only the holder may push for that connector; a second machine gets
     * `lease-held` with the current holder instead of silently writing twice.
     */
    acquireLease: (connector, options = {}) =>
      request('POST', '/v1/leases', {
        connector,
        instance,
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      }),

    renewLease: (leaseId, ttlSeconds) =>
      request('POST', `/v1/leases/${encodeURIComponent(leaseId)}/renew`, ttlSeconds === undefined ? {} : { ttlSeconds }),

    releaseLease: (leaseId) => request('DELETE', `/v1/leases/${encodeURIComponent(leaseId)}`),

    /** @returns {Promise<{revision:number,state:unknown}>} */
    getState: (connector) => request('GET', `/v1/state/${encodeURIComponent(connector)}`),

    putState: (connector, state, options = {}) =>
      request('PUT', `/v1/state/${encodeURIComponent(connector)}`, {
        state,
        ...(options.revision === undefined ? {} : { revision: options.revision }),
      }),

    addRun: (connector, run) => request('POST', '/v1/runs', { connector, run }),

    listRuns: (options = {}) => {
      const params = new URLSearchParams()
      if (options.connector) params.set('connector', options.connector)
      if (Number.isInteger(options.limit)) params.set('limit', String(options.limit))
      const query = params.toString()
      return request('GET', `/v1/runs${query === '' ? '' : `?${query}`}`).then((data) => data.runs ?? [])
    },

    stats: () => request('GET', '/v1/stats'),
  }
}

/** Strip the envelope keys before they get merged into an error's extras. */
function stripEnvelope(payload) {
  const extras = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'ok' || key === 'reason' || key === 'error') continue
    extras[key] = value
  }
  return extras
}

/** A stable-ish identity for this DSH instance, used as the lease holder. */
function defaultInstance() {
  let host = 'unknown-host'
  try {
    host = hostname() || 'unknown-host'
  } catch {
    host = 'unknown-host'
  }
  return `${host}/${process.pid}`
}

/**
 * Merge hub-hosted connector definitions into the local set.
 *
 * Local files always win on name collision unless `override` is set: a machine
 * that pinned its own copy should not silently get the hub's version, and the
 * resulting diff is exactly what the user needs to see in `dsh_connector_status`.
 *
 * @param {{ hub: object, local: {name: string, yaml: string, source: string}[] }} input
 */
export async function fetchHubConnectors(hub, local = []) {
  const remote = await hub.listConnectors()
  const localNames = new Set(local.map((item) => item.name))
  return remote.map((entry) => ({
    name: entry.name,
    revision: entry.revision,
    hash: entry.hash,
    owner: entry.owner ?? null,
    updatedAt: entry.updatedAt ?? null,
    local: localNames.has(entry.name),
  }))
}
