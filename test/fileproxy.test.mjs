/**
 * Tests for the v2 additions:
 *   - lib/fileproxy.js: the hub-backed store (CAS retry, no-write updates, describe)
 *   - connector.js: `executor.via` and `connector.watcher` parsing + round-trip
 *   - runner.js: rest via 'hub' goes through the hub client, and refuses without one
 *   - manager.js: config.fileProxy fail-fast
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'

import { parseConnector, stringifyConnector } from '../lib/connector.js'
import { createFileProxy } from '../lib/fileproxy.js'
import { createManager } from '../lib/manager.js'
import { ConnectorError } from '../lib/errors.js'

/** A hub client double whose file document lives in memory. */
function fakeHubClient(initialTodos = []) {
  let revision = 0
  let doc = { version: 2, todos: initialTodos, trash: [] }
  let reads = 0
  let writes = 0
  const seenRevisions = []
  return {
    get stats() { return { reads, writes } },
    get revision() { return revision },
    async readFile() {
      reads += 1
      return { doc, revision }
    },
    async putFile(name, next, expected) {
      writes += 1
      seenRevisions.push(expected)
      if (expected !== revision) {
        const error = new ConnectorError('revision-conflict', 'no')
        error.extras = { currentRevision: revision }
        throw error
      }
      doc = next
      revision += 1
      return { revision }
    },
    // unused by these tests
    async requestProxy() { throw new Error('not implemented') },
    async putWatcher() { return {} },
  }
}

function logger() {
  const lines = []
  return Object.assign(() => {}, {
    lines,
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
  })
}

test('fileproxy reads through the hub and tracks revision', async () => {
  const hub = fakeHubClient([{ id: 't-1', title: 'one' }])
  const proxy = createFileProxy({ hubClient: hub })
  const todos = await proxy.all()
  assert.equal(todos.length, 1)
  assert.equal(todos[0].id, 't-1')
  const described = await proxy.describe()
  assert.equal(described.kind, 'hub-proxy')
  assert.equal(described.todos, 1)
  assert.equal(described.revision, 0)
})

test('fileproxy update runs the mutator and CAS-writes', async () => {
  const hub = fakeHubClient([])
  const proxy = createFileProxy({ hubClient: hub })
  const result = await proxy.update((doc) => {
    const next = [...doc.todos, { id: 't-new', title: 'fresh' }]
    return { next, result: 'created' }
  })
  assert.equal(result.result, 'created')
  assert.equal(hub.stats.writes, 1)
  assert.equal(hub.revision, 1)
  assert.equal((await proxy.all()).length, 1)
})

test('fileproxy update with no next does not write', async () => {
  const hub = fakeHubClient([{ id: 't-1', title: 'one' }])
  const proxy = createFileProxy({ hubClient: hub })
  const result = await proxy.update((doc) => ({ result: doc.todos.length }))
  assert.equal(result.result, 1)
  assert.equal(hub.stats.writes, 0)
})

test('fileproxy retries on revision-conflict then succeeds', async () => {
  const hub = fakeHubClient([])
  const proxy = createFileProxy({ hubClient: hub })
  // Simulate another instance writing between our read and our PUT.
  const originalPut = hub.putFile.bind(hub)
  let bumped = false
  hub.putFile = async (name, doc, expected) => {
    if (!bumped) {
      bumped = true
      await originalPut(name, { version: 2, todos: [{ id: 'other', title: 'other' }], trash: [] }, hub.revision)
    }
    return originalPut(name, doc, expected)
  }
  const result = await proxy.update((doc) => ({ next: [...doc.todos, { id: 'mine', title: 'mine' }] }))
  assert.ok(result)
  // The other instance's record must survive the CAS retry: we rewrote the
  // document we re-read, not the stale one.
  const todos = await proxy.all()
  assert.ok(todos.some((item) => item.id === 'other'), 'foreign write survives')
  assert.ok(todos.some((item) => item.id === 'mine'), 'our write lands')
  assert.ok(hub.stats.writes >= 2)
})

test('fileproxy surfaces revision-conflict after exhausting retries', async () => {
  const hub = fakeHubClient([])
  const proxy = createFileProxy({ hubClient: hub })
  hub.putFile = async () => {
    throw new ConnectorError('revision-conflict', 'always')
  }
  await assert.rejects(
    () => proxy.update((doc) => ({ next: doc.todos })),
    (error) => error instanceof ConnectorError && error.reason === 'revision-conflict',
  )
})

test('fileproxy rejects a missing hub client', () => {
  assert.throws(() => createFileProxy({ hubClient: null }), (error) => error instanceof ConnectorError)
})

test('fileproxy external changes are counted', async () => {
  const hub = fakeHubClient([])
  const proxy = createFileProxy({ hubClient: hub })
  await proxy.all()
  await hub.putFile('todo-store', { version: 2, todos: [{ id: 'x', title: 'x' }], trash: [] }, 0)
  const described = await proxy.describe()
  assert.ok(described.externalChanges >= 1)
})

test('connector parses executor.via and connector.watcher with round-trip', () => {
  const yaml = [
    'version: 1',
    'connector:',
    '  name: probe',
    '  enabled: false',
    '  direction: pull',
    '  schedule: { everyMinutes: 0 }',
    '  watcher: hub',
    'client:',
    '  executor:',
    '    kind: rest',
    '    baseUrl: https://api.example.com',
    '    via: hub',
    '    pull: { method: GET, path: /tasks }',
    'mapping: { id: id, title: title }',
    '',
  ].join('\n')
  const parsed = parseConnector(yaml, { source: 'probe.yaml' })
  assert.equal(parsed.connector.watcher, 'hub')
  assert.equal(parsed.client.executor.via, 'hub')
  const round = parseConnector(stringifyConnector(parsed), { source: 'probe.yaml' })
  assert.deepEqual(round.connector.connector, parsed.connector.connector)
  assert.deepEqual(round.client.executor, parsed.client.executor)
})

test('watcher hub requires everyMinutes 0', () => {
  const yaml = [
    'version: 1',
    'connector:',
    '  name: probe',
    '  schedule: { everyMinutes: 15 }',
    '  watcher: hub',
    'client:',
    '  executor: { kind: cmd, pull: { run: "true" } }',
    'mapping: { id: id, title: title }',
    '',
  ].join('\n')
  assert.throws(
    () => parseConnector(yaml, { source: 'probe.yaml' }),
    (error) => error instanceof ConnectorError && error.message.includes('双重触发'),
  )
})

test('invalid watcher and via values are rejected', () => {
  const base = [
    'version: 1',
    'connector:',
    '  name: probe',
    '  schedule: { everyMinutes: 0 }',
    '  watcher: PIGEON',
    'client:',
    '  executor: { kind: cmd, pull: { run: "true" } }',
    'mapping: { id: id, title: title }',
    '',
  ].join('\n')
  assert.throws(() => parseConnector(base, { source: 'a.yaml' }), (error) => error.message.includes('connector.watcher'))

  const viaBase = [
    'version: 1',
    'connector:',
    '  name: probe',
    'client:',
    '  executor:',
    '    kind: rest',
    '    baseUrl: https://api.example.com',
    '    via: pigeon',
    '    pull: { method: GET, path: /tasks }',
    'mapping: { id: id, title: title }',
    '',
  ].join('\n')
  assert.throws(() => parseConnector(viaBase, { source: 'b.yaml' }), (error) => error.message.includes('executor.via'))
})

test('runner routes rest through the hub proxy when via is hub', async () => {
  const { runRequest } = await import('../lib/runner.js')
  const executor = {
    kind: 'rest',
    baseUrl: 'https://api.example.com',
    headers: { Authorization: '${secret:PROBE}' },
    timeoutMs: 1000,
    via: 'hub',
    pull: { method: 'GET', path: '/tasks', items: '' },
    push: null,
    update: null,
  }
  const calls = []
  const hubClient = {
    async requestProxy(spec) {
      calls.push(spec)
      return { status: 200, body: [{ id: 'r1' }] }
    },
  }
  const result = await runRequest(executor, executor.pull, { scope: {}, hubClient })
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload, [{ id: 'r1' }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'rest')
  assert.equal(calls[0].url, 'https://api.example.com/tasks')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers.Authorization, '${secret:PROBE}', 'secrets pass through by alias, unresolved')
})

test('runner refuses via-hub without a hub client (no silent fallback)', async () => {
  const { runRequest } = await import('../lib/runner.js')
  const executor = {
    kind: 'rest',
    baseUrl: 'https://api.example.com',
    headers: {},
    timeoutMs: 1000,
    via: 'hub',
    pull: { method: 'GET', path: '/tasks', items: '' },
    push: null,
    update: null,
  }
  await assert.rejects(
    () => runRequest(executor, executor.pull, { scope: {} }),
    (error) => error instanceof ConnectorError && error.reason === 'hub-unavailable',
  )
})

test('pullRecords threads the hub client to rest executors', async () => {
  const { pullRecords } = await import('../lib/runner.js')
  const connector = {
    connector: { name: 'probe', direction: 'pull' },
    client: {
      name: 'probe',
      executor: {
        kind: 'rest',
        baseUrl: 'https://api.example.com',
        headers: {},
        timeoutMs: 1000,
        via: 'hub',
        pull: { method: 'GET', path: '/tasks', items: '' },
        push: null,
        update: null,
      },
    },
    mapping: { pull: { id: { path: 'id' } } },
  }
  const calls = []
  const hubClient = { async requestProxy(spec) { calls.push(spec); return { status: 200, body: [] } } }
  const report = await pullRecords(connector, { scope: {}, hubClient })
  assert.deepEqual(report.records, [])
  assert.equal(calls.length, 1)
})

test('manager builds a hub-proxy store when fileProxy is hub', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-proxy-'))
  try {
    const lines = logger()
    const manager = createManager({
      config: { dataDir: path.join(dir, 'plugin'), storePath: path.join(dir, 'todos.json'), fileProxy: 'hub', hub: { url: 'http://127.0.0.1:1' } },
      logger: lines,
    })
    assert.equal(manager.store.kind, 'hub-proxy')
    assert.ok(lines.lines.some((line) => line.includes('fileProxy=hub')))
    await manager.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manager with fileProxy hub but no hub.url fails fast on proxy use', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-proxy-'))
  try {
    const lines = logger()
    const manager = createManager({
      config: { dataDir: path.join(dir, 'plugin'), storePath: path.join(dir, 'todos.json'), fileProxy: 'hub' },
      logger: lines,
    })
    assert.equal(manager.store.kind, 'hub-proxy')
    // Any read goes through the (unconfigured) proxy and must fail loudly.
    await assert.rejects(
      () => manager.store.all(),
      (error) => error instanceof ConnectorError && error.reason === 'hub-unavailable',
    )
    await manager.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manager rejects an invalid fileProxy value at construction', () => {
  assert.throws(
    () => createManager({ config: { dataDir: os.tmpdir(), storePath: os.tmpdir(), fileProxy: 'carrier-pigeon' }, logger }),
    (error) => error instanceof ConnectorError && error.reason === 'invalid-request',
  )
})

test('manager keeps the local store when fileProxy is unset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-proxy-'))
  try {
    await writeFile(path.join(dir, 'todos.json'), JSON.stringify({ version: 2, todos: [], trash: [] }))
    const manager = createManager({ config: { dataDir: path.join(dir, 'plugin'), storePath: path.join(dir, 'todos.json') }, logger })
    assert.equal(manager.store.kind, 'json')
    await manager.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
