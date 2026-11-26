/**
 * HTTP surface.
 *
 * Every route here is registered with `auth: 'anonymous'` and re-checks that
 * the caller is a local, credential-less script.  That combination is not
 * paranoia: DSH's web server defaults every route to `required`, which means
 * a plain `curl http://127.0.0.1:3080/...` gets a bare `unauthorized` because
 * the caller carries no session cookie.  A connector platform has to be
 * scriptable from the outside — that is the whole point of an executor — so it
 * opts out of the cookie check and does its own loopback check instead.
 *
 * The plugin never accepts a browser-originated request with credentials,
 * because a page on the internet must not be able to rewrite connectors.
 */

import { ConnectorError, asConnectorError, statusForReason } from './errors.js'

export const ROUTE_BASE = '/api/global-todo-connector'
const MAX_BODY_BYTES = 1024 * 1024

/**
 * @param {object} options
 * @param {object} options.manager
 * @param {object} options.logger
 */
export function createRoutes({ manager, logger }) {
  const routes = []
  // The host's webServer keys its exact table by path only — registering two
  // methods for one path throws "duplicate exact route" and drops the whole
  // batch. Every distinct path is therefore ONE route here, and the handler
  // dispatches on `request.method` itself, answering 405 for anything
  // unlisted (same shape as dsh-global-todo's `verbs()` helper).
  const route = (path, handlers) => {
    const byMethod = new Map(Object.entries(handlers))
    routes.push({
      kind: 'exact',
      path: `${ROUTE_BASE}${path}`,
      auth: 'anonymous',
      handler: wrap(async (request, response) => {
        const handler = byMethod.get(request.method ?? 'GET')
        if (handler === undefined) {
          throw new ConnectorError('method-not-allowed', `${request.method} 不支持（可用：${[...byMethod.keys()].join(', ')}）`)
        }
        return handler(request, response)
      }),
    })
  }
  const read = (path, handler) => route(path, { GET: handler })
  const write = (path, handler) => route(path, { POST: handler })

  // -- diagnostics ---------------------------------------------------------

  read('/health', async () => {
    const status = await manager.status()
    return {
      ok: true,
      data: {
        name: 'dsh-global-todo-connector',
        version: VERSION,
        connectors: status.connectors.length,
        scheduled: status.scheduled,
        store: status.store,
        hub: status.hub === null ? null : { url: status.hub.url, token: status.hub.token },
      },
    }
  })

  read('/status', async () => {
    return { ok: true, data: await manager.status() }
  })

  // -- connectors ----------------------------------------------------------

  read('/connectors', async () => {
    return { ok: true, data: { connectors: await manager.listConnectors() } }
  })

  route('/connector', {
    GET: async (request) => {
      const name = queryOf(request, 'name')
      if (name === '') throw new ConnectorError('invalid-request', '缺少 name 查询参数')
      const loaded = await manager.readConnector(name)
      return { ok: true, data: { name: loaded.name, file: loaded.file, yaml: loaded.text } }
    },
    POST: async (request) => {
      const body = await readJsonBody(request)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name === '') throw new ConnectorError('invalid-request', '缺少 name 字段')
      if (typeof body.yaml !== 'string' || body.yaml.trim() === '') {
        throw new ConnectorError('invalid-request', '缺少 yaml 字段')
      }
      const saved = await manager.writeConnector(name, body.yaml)
      return { ok: true, data: { name: saved.name, file: saved.file } }
    },
    DELETE: async (request) => {
      const name = queryOf(request, 'name') || (await readJsonBody(request)).name
      if (typeof name !== 'string' || name.trim() === '') throw new ConnectorError('invalid-request', '缺少 name')
      const result = await manager.deleteConnector(name.trim())
      return { ok: true, data: result }
    },
  })

  write('/validate', async (request) => {
    const body = await readJsonBody(request)
    if (typeof body.yaml !== 'string') throw new ConnectorError('invalid-request', '缺少 yaml 字段')
    return { ok: true, data: manager.validate(body.yaml, { source: '<api>' }) }
  })

  read('/scaffold', async (request) => {
    const name = queryOf(request, 'name')
    if (name === '') throw new ConnectorError('invalid-request', '缺少 name 查询参数')
    return {
      ok: true,
      data: {
        yaml: manager.scaffold({
          name,
          kind: queryOf(request, 'kind') || 'cmd',
          direction: queryOf(request, 'direction') || 'pull',
          label: queryOf(request, 'label'),
        }),
      },
    }
  })

  // -- runs ----------------------------------------------------------------

  write('/sync', async (request) => {
    const body = await readJsonBody(request)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') throw new ConnectorError('invalid-request', '缺少 name 字段')
    const report = await manager.sync(name, { dryRun: body.dryRun === true, reason: 'api' })
    return { ok: true, data: { report } }
  })

  read('/runs', async (request) => {
    const name = queryOf(request, 'name')
    const limit = Math.min(Math.max(Number(queryOf(request, 'limit')) || 20, 1), 100)
    const runs = await manager.lastRuns(name === '' ? undefined : name, limit)
    return { ok: true, data: { runs } }
  })

  // -- hub -----------------------------------------------------------------

  read('/hub', async () => {
    return { ok: true, data: await manager.hubStatus() }
  })

  write('/hub/pull', async (request) => {
    const body = await readJsonBody(request)
    const names = Array.isArray(body.names) ? body.names.filter((item) => typeof item === 'string') : undefined
    return { ok: true, data: await manager.hubPull({ names, force: body.force === true }) }
  })

  write('/hub/push', async (request) => {
    const body = await readJsonBody(request)
    const names = Array.isArray(body.names) ? body.names.filter((item) => typeof item === 'string') : undefined
    return { ok: true, data: await manager.hubPush({ names, force: body.force === true }) }
  })

  read('/hub/runs', async (request) => {
    const limit = Math.min(Math.max(Number(queryOf(request, 'limit')) || 20, 1), 100)
    return { ok: true, data: { runs: await manager.hubRuns({ connector: queryOf(request, 'name'), limit }) } }
  })

  return routes
}

/** The plugin version, kept in one place so health and package stay honest. */
const VERSION = '0.1.0'

/**
 * Wrap a handler with the response contract, error mapping and the loopback
 * check.
 *
 * Handlers return `{ ok: true, data }`; anything thrown becomes
 * `{ ok: false, reason, error }` with a matching status code.
 */
function wrap(handler) {
  return async (request, response) => {
    if (!isLocalRequest(request)) {
      sendJson(response, 403, { ok: false, reason: 'forbidden', error: '只接受本机请求' })
      return
    }
    try {
      const payload = await handler(request, response)
      if (response.writableEnded) return
      sendJson(response, 200, payload)
    } catch (error) {
      const wrapped = asConnectorError(error)
      sendJson(response, statusForReason(wrapped.reason), wrapped.toJSON())
    }
  }
}

/** JSON out, always no-store: these answers must never be cached by a proxy. */
function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new ConnectorError('payload-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ConnectorError('invalid-body', `请求体不是合法 JSON：${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConnectorError('invalid-body', '请求体必须是一个 JSON 对象')
  }
  return parsed
}

function queryOf(request, key) {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    return url.searchParams.get(key) ?? ''
  } catch {
    return ''
  }
}

/**
 * Is this a local script, rather than a browser page or a remote client?
 *
 * Three conditions, all required: the socket peer is a loopback address, the
 * `Host` header also names a loopback address (defeats DNS rebinding), and the
 * request is not cross-site (defeats a page on the internet posting here with
 * the user's browser as the transport).
 */
export function isLocalRequest(request) {
  const address = request?.socket?.remoteAddress ?? ''
  const peerLoopback =
    address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!peerLoopback) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const host = String(request.headers?.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0].toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.startsWith('127.')
}

export { wrap as wrapRoute, MAX_BODY_BYTES }
