import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createManager } from '../lib/manager.js'
import { createRoutes, isLocalRequest, MAX_BODY_BYTES } from '../lib/routes.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/**
 * Boot the route table on a real loopback socket.
 *
 * These are node http handlers, so the only faithful way to exercise the
 * loopback fence, the JSON envelope and the status mapping is to speak HTTP
 * to them.
 */
async function harness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-routes-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const manager = createManager({
    config: { dataDir: path.join(dir, 'plugin'), storePath: path.join(dir, 'todos.json') },
    logger: silentLogger,
    now: () => 1000,
  })
  t.after(() => manager.stop())

  const table = createRoutes({ manager, logger: silentLogger })
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    // The host's webServer keys routes by path only and lets the handler see
    // the method — mirror that here instead of matching on entry.method.
    const route = table.find((entry) => entry.path === url.pathname)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, reason: 'not-found' }))
      return
    }
    route.handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  async function call(method, pathname, body, headers = {}) {
    const init = { method, headers: { host: `127.0.0.1:${port}`, ...headers } }
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      init.headers['content-type'] = init.headers['content-type'] ?? 'application/json'
    }
    const response = await fetch(`${base}${pathname}`, init)
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
    return { status: response.status, payload, headers: response.headers }
  }

  return { manager, table, call, base }
}

const CONNECTOR = `version: 1
connector:
  name: demo
  enabled: false
  direction: pull
client:
  name: demo
  executor:
    kind: cmd
    pull:
      run: "echo '[]'"
      parse: json
`

test('every route opts out of the cookie check', async (t) => {
  const { table } = await harness(t)
  // One route per distinct path (methods dispatch inside the handler).
  const paths = new Set(table.map((route) => route.path))
  assert.equal(table.length, 12)
  assert.equal(paths.size, 12)
  for (const route of table) {
    assert.equal(route.auth, 'anonymous', `${route.path} must be anonymous`)
    assert.equal(route.kind, 'exact')
    assert.equal(route.path.startsWith('/api/global-todo-connector'), true)
  }
})

test('health answers without any credentials', async (t) => {
  const { call } = await harness(t)
  const { status, payload, headers } = await call('GET', '/api/global-todo-connector/health')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.name, 'dsh-global-todo-connector')
  assert.equal(headers.get('cache-control'), 'no-store')
})

test('status, connectors and scaffold read cleanly', async (t) => {
  const { call } = await harness(t)
  const status = await call('GET', '/api/global-todo-connector/status')
  assert.equal(status.payload.ok, true)
  assert.equal(Array.isArray(status.payload.data.connectors), true)

  const list = await call('GET', '/api/global-todo-connector/connectors')
  assert.deepEqual(list.payload.data.connectors, [])

  const scaffold = await call('GET', '/api/global-todo-connector/scaffold?name=taskwarrior&kind=cmd&direction=both')
  assert.equal(scaffold.payload.ok, true)
  assert.match(scaffold.payload.data.yaml, /name: taskwarrior/)
})

test('a connector round-trips through POST, GET and DELETE', async (t) => {
  const { call } = await harness(t)
  const written = await call('POST', '/api/global-todo-connector/connector', { name: 'demo', yaml: CONNECTOR })
  assert.equal(written.status, 200)
  assert.equal(written.payload.ok, true)

  const read = await call('GET', '/api/global-todo-connector/connector?name=demo')
  assert.equal(read.payload.data.name, 'demo')
  assert.match(read.payload.data.yaml, /name: demo/)

  const removed = await call('DELETE', '/api/global-todo-connector/connector?name=demo')
  assert.equal(removed.payload.ok, true)

  const missing = await call('GET', '/api/global-todo-connector/connector?name=demo')
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.reason, 'not-found')
})

test('validation failures map onto 422 with a machine reason', async (t) => {
  const { call } = await harness(t)
  const badYaml = await call('POST', '/api/global-todo-connector/validate', { yaml: 'client: [' })
  assert.equal(badYaml.status, 422)
  assert.equal(badYaml.payload.ok, false)
  assert.equal(badYaml.payload.reason, 'invalid-yaml')

  const noId = await call(
    'POST',
    '/api/global-todo-connector/validate',
    { yaml: 'version: 1\nconnector: {name: demo}\nmapping: {id: ""}\nclient: {name: demo, executor: {kind: cmd, pull: {run: echo}}}\n' },
  )
  assert.equal(noId.payload.reason, 'invalid-connector')
})

test('a malformed JSON body is rejected, not ignored', async (t) => {
  const { call } = await harness(t)
  const { status, payload } = await call('POST', '/api/global-todo-connector/validate', '{not json')
  assert.equal(status, 422)
  assert.equal(payload.reason, 'invalid-body')
})

test('an oversized body is refused before it is parsed', async (t) => {
  const { call } = await harness(t)
  const huge = `{"yaml":"${'x'.repeat(MAX_BODY_BYTES + 1024)}"}`
  const { status, payload } = await call('POST', '/api/global-todo-connector/validate', huge)
  assert.equal(status, 413)
  assert.equal(payload.reason, 'payload-too-large')
})

test('sync reports create counts and is visible in the run log', async (t) => {
  const { call } = await harness(t)
  await call('POST', '/api/global-todo-connector/connector', { name: 'demo', yaml: CONNECTOR })
  const synced = await call('POST', '/api/global-todo-connector/sync', { name: 'demo' })
  assert.equal(synced.payload.ok, true)
  assert.equal(synced.payload.data.report.created, 0)

  const runs = await call('GET', '/api/global-todo-connector/runs?name=demo')
  assert.equal(runs.payload.data.runs.length, 1)
  assert.equal(runs.payload.data.runs[0].reason, 'api')
})

test('a failing sync surfaces a 400 with the executor reason', async (t) => {
  const { call } = await harness(t)
  await call('POST', '/api/global-todo-connector/connector', {
    name: 'demo',
    yaml: CONNECTOR.replace("run: \"echo '[]'\"", 'run: "exit 2"'),
  })
  const { status, payload } = await call('POST', '/api/global-todo-connector/sync', { name: 'demo' })
  assert.equal(status, 400)
  assert.equal(payload.reason, 'exec-failed')
})

test('hub routes say "not configured" instead of hanging', async (t) => {
  const { call } = await harness(t)
  const { status, payload } = await call('GET', '/api/global-todo-connector/hub')
  assert.equal(status, 502)
  assert.equal(payload.reason, 'hub-unavailable')
})

test('the loopback fence rejects a non-local peer', () => {
  assert.equal(isLocalRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1:3080' } }), false)
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:10.0.0.5' }, headers: { host: '127.0.0.1' } }), false)
})

test('an unknown method on a known path is 405, not a crash', async (t) => {
  const { call } = await harness(t)
  const wrong = await call('PUT', '/api/global-todo-connector/connectors')
  assert.equal(wrong.status, 405)
  assert.equal(wrong.payload.ok, false)
  assert.equal(wrong.payload.reason, 'method-not-allowed')
  assert.match(wrong.payload.error, /GET/)
})

test('the loopback fence rejects a non-local Host header (DNS rebinding)', () => {
  assert.equal(isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.example.com' } }), false)
})

test('the loopback fence rejects a cross-site browser request', () => {
  assert.equal(
    isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' } }),
    false,
  )
})

test('the loopback fence accepts a plain local script', () => {
  assert.equal(isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }), true)
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3080' } }), true)
  assert.equal(isLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost:3080' } }), true)
})
