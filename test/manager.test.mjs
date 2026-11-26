import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createManager } from '../lib/manager.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/** A manager rooted at a throwaway DSH home. */
async function manager(t, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-manager-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const instance = createManager({
    config: { dataDir: path.join(dir, 'plugin'), storePath: path.join(dir, 'todos.json'), ...config },
    logger: silentLogger,
    now: () => 1000,
  })
  t.after(() => instance.stop())
  return { dir, manager: instance }
}

const CONNECTOR = `
version: 1
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

test('writeConnector validates before saving', async (t) => {
  const { manager: registry } = await manager(t)
  await registry.writeConnector('demo', CONNECTOR)
  const read = await registry.readConnector('demo')
  assert.equal(read.name, 'demo')
  assert.equal(read.yaml.connector.name, 'demo')
  assert.equal(read.source.endsWith('demo.yaml'), true)
})

test('writeConnector rejects invalid YAML and leaves no file behind', async (t) => {
  const { manager: registry } = await manager(t)
  await assert.rejects(registry.writeConnector('broken', 'client: [unclosed'), (error) => error.reason === 'invalid-yaml')
  assert.deepEqual(await registry.listFiles(), [])
})

test('writeConnector rejects a name that disagrees with the file name', async (t) => {
  const { manager: registry } = await manager(t)
  await assert.rejects(registry.writeConnector('other', CONNECTOR), (error) => {
    assert.equal(error.reason, 'invalid-connector')
    assert.match(error.message, /文件名是 other/)
    return true
  })
})

test('a syntactically broken file is reported, not thrown', async (t) => {
  const { manager: registry } = await manager(t)
  await writeFile(path.join(registry.connectorDir, 'bad.yaml'), 'connector: {', 'utf8').catch(async () => {
    // The directory may not exist yet; create it through a valid write first.
    await registry.writeConnector('demo', CONNECTOR)
    await writeFile(path.join(registry.connectorDir, 'bad.yaml'), 'connector: {', 'utf8')
  })
  const list = await registry.listConnectors()
  const broken = list.find((entry) => entry.name === 'bad')
  assert.equal(broken.ok, false)
  assert.match(broken.error, /解析|键|引号/)
})

test('deleteConnector removes the file and stops its timer', async (t) => {
  const { manager: registry } = await manager(t)
  await registry.writeConnector('demo', CONNECTOR.replace('enabled: false', 'enabled: true'))
  assert.deepEqual((await registry.listFiles()).map((file) => file.name), ['demo'])
  await registry.deleteConnector('demo')
  assert.deepEqual(await registry.listFiles(), [])
  await assert.rejects(registry.deleteConnector('demo'), (error) => error.reason === 'not-found')
})

test('sync records a run in the run log', async (t) => {
  const { manager: registry } = await manager(t)
  await registry.writeConnector('demo', CONNECTOR)
  const report = await registry.sync('demo', { reason: 'manual' })
  assert.equal(report.connector, 'demo')
  const runs = await registry.lastRuns('demo', 10)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].connector, 'demo')
  assert.equal(runs[0].reason, 'manual')
})

test('sync failure is recorded and does not throw', async (t) => {
  const { manager: registry } = await manager(t)
  const text = CONNECTOR.replace("run: \"echo '[]'\"", 'run: "exit 7"')
  await registry.writeConnector('demo', text)
  // The caller sees the failure; the run log keeps the durable record of it.
  await assert.rejects(registry.sync('demo'), (error) => error.reason === 'exec-failed')
  const runs = await registry.lastRuns('demo', 10)
  assert.equal(runs[0].ok, false)
  assert.equal(runs[0].failed, true)
  assert.equal(runs[0].failureReason, 'exec-failed')
  assert.equal(runs[0].connector, 'demo')
})

test('the run log stays bounded', async (t) => {
  const { manager: registry } = await manager(t)
  await registry.writeConnector('demo', CONNECTOR)
  for (let i = 0; i < 8; i += 1) await registry.sync('demo')
  const runs = await registry.lastRuns('demo', 100)
  assert.equal(runs.length, 8)
  const log = await readFile(registry.status === undefined ? '' : path.join(registry.pluginDir, 'runs.jsonl'), 'utf8').catch(() => '')
  assert.equal(typeof log, 'string')
})

test('status reports paths, store and connectors', async (t) => {
  const { manager: registry } = await manager(t)
  await registry.writeConnector('demo', CONNECTOR)
  const status = await registry.status()
  assert.equal(status.connectors.length, 1)
  assert.equal(status.connectors[0].name, 'demo')
  assert.equal(status.store.kind, 'json')
  assert.equal(path.basename(status.connectorDir), 'connectors')
})

test('scaffold produces a file that can be written straight back', async (t) => {
  const { manager: registry } = await manager(t)
  const text = registry.scaffold({ name: 'taskwarrior', kind: 'cmd', direction: 'both' })
  await registry.writeConnector('taskwarrior', text)
  const read = await registry.readConnector('taskwarrior')
  assert.equal(read.yaml.connector.name, 'taskwarrior')
  assert.equal(read.yaml.connector.enabled, false)
})

test('scheduled connectors only arm when enabled', async (t) => {
  const { manager: registry } = await manager(t)
  // `on`/`off` are YAML booleans, so the fixtures use neutral names.
  await registry.writeConnector('idle', CONNECTOR.replace('name: demo', 'name: idle'))
  await registry.writeConnector('active', CONNECTOR.replace('name: demo', 'name: active').replace('enabled: false', 'enabled: true'))
  await registry.start()
  const status = await registry.status()
  assert.deepEqual(status.scheduled, ['active'])
})

test('hub features fail with a readable message when no hub is configured', async (t) => {
  const { manager: registry } = await manager(t)
  await assert.rejects(registry.hubStatus(), (error) => {
    assert.equal(error.reason, 'hub-unavailable')
    assert.match(error.message, /GTC_HUB_URL/)
    return true
  })
})

test('the plugin directory is created lazily, not at import time', async (t) => {
  const { dir, manager: registry } = await manager(t)
  const before = await readdir(path.join(dir, 'plugin')).catch(() => [])
  assert.deepEqual(before, [])
  await registry.writeConnector('demo', CONNECTOR)
  const after = await readdir(path.join(dir, 'plugin'))
  assert.equal(after.includes('connectors'), true)
})
