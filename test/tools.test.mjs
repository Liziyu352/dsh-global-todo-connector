import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createManager } from '../lib/manager.js'
import { createTools } from '../lib/tools.js'

const silentLogger = { info() {}, warn() {}, error() {} }

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

/** A tool set over a throwaway plugin directory. */
async function toolkit(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-tools-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const manager = createManager({
    config: { dataDir: path.join(dir, 'plugin'), storePath: path.join(dir, 'todos.json') },
    logger: silentLogger,
    now: () => 1000,
  })
  t.after(() => manager.stop())
  const tools = createTools(manager, { logger: silentLogger })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const run = (name, args = {}) => byName.get(name).execute(args, {})
  return { dir, manager, tools, byName, run }
}

test('every tool declares the contract the host requires', async (t) => {
  const { tools } = await toolkit(t)
  assert.equal(tools.length, 10)
  const names = new Set()
  for (const tool of tools) {
    assert.equal(names.has(tool.name), false, `duplicate tool name ${tool.name}`)
    names.add(tool.name)
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.description.length > 10, true)
    assert.equal(tool.parameters?.type, 'object')
    assert.equal(typeof tool.output?.schema, 'object')
    assert.equal(typeof tool.output?.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, true)
    assert.equal(typeof tool.isConcurrencySafe(), 'boolean')
  }
})

test('render always returns content blocks, failures included', async (t) => {
  const { tools } = await toolkit(t)
  for (const tool of tools) {
    const blocks = tool.output.render({}, { ok: false, reason: 'x', error: 'y' })
    assert.equal(Array.isArray(blocks), true, `${tool.name} render must return an array`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('list reports an empty platform without failing', async (t) => {
  const { run } = await toolkit(t)
  const result = await run('dsh_connector_list')
  assert.equal(result.ok, true)
  assert.deepEqual(result.connectors, [])
})

test('scaffold then write then get round-trips through the tools', async (t) => {
  const { run } = await toolkit(t)
  const scaffolded = await run('dsh_connector_scaffold', { name: 'taskwarrior', kind: 'cmd', direction: 'both' })
  assert.equal(scaffolded.ok, true)
  assert.match(scaffolded.yaml, /name: taskwarrior/)

  const written = await run('dsh_connector_write', { name: 'taskwarrior', yaml: scaffolded.yaml })
  assert.equal(written.ok, true)

  const fetched = await run('dsh_connector_get', { name: 'taskwarrior' })
  assert.equal(fetched.ok, true)
  assert.match(fetched.yaml, /name: taskwarrior/)

  const listed = await run('dsh_connector_list', { verbose: true })
  assert.equal(listed.connectors.length, 1)
  assert.equal(listed.connectors[0].name, 'taskwarrior')
})

test('write refuses a connector whose name does not match its file', async (t) => {
  const { run } = await toolkit(t)
  const result = await run('dsh_connector_write', { name: 'other', yaml: CONNECTOR })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid-connector')
})

test('validate answers with the offending field', async (t) => {
  const { run } = await toolkit(t)
  const bad = await run('dsh_connector_validate', { yaml: 'client: [' })
  assert.equal(bad.ok, true)
  assert.equal(bad.valid, false)
  assert.equal(bad.reason, 'invalid-yaml')

  const good = await run('dsh_connector_validate', { yaml: CONNECTOR })
  assert.equal(good.valid, true)
  assert.equal(good.connector.name, 'demo')
})

test('a missing connector comes back as not-found, never as a throw', async (t) => {
  const { run } = await toolkit(t)
  const result = await run('dsh_connector_get', { name: 'nope' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-found')
})

test('delete reports what it removed and then reports not-found', async (t) => {
  const { run } = await toolkit(t)
  await run('dsh_connector_write', { name: 'demo', yaml: CONNECTOR })
  const first = await run('dsh_connector_delete', { name: 'demo' })
  assert.equal(first.ok, true)
  const second = await run('dsh_connector_delete', { name: 'demo' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'not-found')
})

test('sync returns a report and logs it', async (t) => {
  const { run } = await toolkit(t)
  await run('dsh_connector_write', { name: 'demo', yaml: CONNECTOR })
  const synced = await run('dsh_connector_sync', { name: 'demo' })
  assert.equal(synced.ok, true)
  assert.equal(synced.report.connector, 'demo')
  assert.equal(synced.report.created, 0)

  const runs = await run('dsh_connector_runs', { name: 'demo', limit: 5 })
  assert.equal(runs.ok, true)
  assert.equal(runs.runs.length, 1)
})

test('a failing sync is reported as ok:false with the executor reason', async (t) => {
  const { run } = await toolkit(t)
  await run('dsh_connector_write', { name: 'demo', yaml: CONNECTOR.replace("run: \"echo '[]'\"", 'run: "exit 4"') })
  const synced = await run('dsh_connector_sync', { name: 'demo' })
  assert.equal(synced.ok, false)
  assert.equal(synced.reason, 'exec-failed')
})

test('status reports the store and the hub state', async (t) => {
  const { run } = await toolkit(t)
  const status = await run('dsh_connector_status')
  assert.equal(status.ok, true)
  assert.equal(status.status.store.kind, 'json')
  assert.equal(status.status.hub, null)
  assert.equal(status.hubProbe, null, 'no probe unless asked')
})

test('status can probe an absent hub without pretending it works', async (t) => {
  const { run } = await toolkit(t)
  const status = await run('dsh_connector_status', { probeHub: true })
  assert.equal(status.ok, true)
  assert.equal(status.hubProbe.ok, false)
  assert.equal(status.hubProbe.reason, 'hub-unavailable')
})

test('hub actions fail with a hint when no hub is configured', async (t) => {
  const { run } = await toolkit(t)
  for (const action of ['status', 'pull', 'push', 'runs']) {
    const result = await run('dsh_connector_hub', { action })
    assert.equal(result.ok, false, `hub action ${action} should fail`)
    assert.equal(result.reason, 'hub-unavailable')
  }
})

test('read-only tools declare themselves concurrency-safe', async (t) => {
  const { byName } = await toolkit(t)
  for (const name of ['dsh_connector_list', 'dsh_connector_get', 'dsh_connector_validate', 'dsh_connector_status', 'dsh_connector_runs']) {
    assert.equal(byName.get(name).isConcurrencySafe(), true, `${name} should be concurrency-safe`)
  }
  for (const name of ['dsh_connector_write', 'dsh_connector_delete', 'dsh_connector_sync', 'dsh_connector_hub']) {
    assert.equal(byName.get(name).isConcurrencySafe(), false, `${name} must not claim to be concurrency-safe`)
  }
})
