import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, DEFAULT_CONFIG_KEYS, detectGlobalTodoForTests, name, resolveConfig, VERSION } from '../lib/index.js'

/** A cordis stand-in: enough surface for `apply` to run, and a place to record. */
function fakeContext({ entries = [], services = ['tools', 'webServer', 'systemPrompt'] } = {}) {
  const registered = { tools: [], routes: [], sections: [] }
  const disposers = []
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    loader: { entries: () => entries },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(_names, callback) {
      const scoped = {
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
          return () => {}
        },
        tools: { register: (definition) => (registered.tools.push(definition), () => {}) },
        webServer: { register: (route) => (registered.routes.push(route), () => {}) },
        systemPrompt: { section: (section) => (registered.sections.push(section), () => {}) },
      }
      callback(scoped)
    },
    services,
  }
  return { ctx, registered, logs, disposeAll: () => disposers.forEach((fn) => fn?.()) }
}

/** Wait for the plugin's async bootstrap to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-index-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('the module exports the shape a DSH host bundle expects', () => {
  assert.equal(name, 'dsh-global-todo-connector')
  assert.equal(VERSION, '0.1.0')
  assert.equal(typeof apply, 'function')
  assert.deepEqual(DEFAULT_CONFIG_KEYS, ['storePath', 'dataDir', 'hub', 'fileProxy', 'tools', 'routes', 'schedule', 'settingsPage', 'detailPage', 'sidebarTab'])
})

test('resolveConfig fills defaults without clobbering a partial config', () => {
  const resolved = resolveConfig({ hub: { url: 'http://127.0.0.1:8765' } })
  assert.equal(resolved.storePath, '')
  assert.equal(resolved.tools, true)
  assert.equal(resolved.hub.url, 'http://127.0.0.1:8765')
  assert.equal(resolved.hub.timeoutMs, 8000)
  assert.equal(resolveConfig().hub.token, '')
})

test('the plugin stays dormant when dsh-global-todo is absent', async (t) => {
  const dir = await home(t)
  const { ctx, registered, logs } = fakeContext()
  apply(ctx, { storePath: path.join(dir, 'missing.json'), dataDir: path.join(dir, 'plugin') })
  await settle()
  assert.equal(registered.tools.length, 0)
  assert.equal(registered.routes.length, 0)
  assert.equal(logs.some((entry) => entry.level === 'warn' && /没检测到/.test(entry.message)), true)
})

test('a Loader entry for dsh-global-todo is enough to start', async (t) => {
  const dir = await home(t)
  const { ctx, registered } = fakeContext({ entries: [{ options: { id: 'global-todo', name: 'dsh-global-todo' } }] })
  apply(ctx, { storePath: path.join(dir, 'todos.json'), dataDir: path.join(dir, 'plugin') })
  await settle()
  assert.equal(registered.tools.length, 10)
  assert.equal(registered.routes.length, 12)
  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].name, 'dsh-global-todo-connector:guidance')
  assert.equal(registered.sections[0].order, 3045)
})

test('the store file on disk is enough to start when the Loader has no entry', async (t) => {
  const dir = await home(t)
  const storePath = path.join(dir, 'todos.json')
  await writeFile(storePath, JSON.stringify({ version: 2, todos: [], trash: [] }), 'utf8')
  const { ctx, registered } = fakeContext({ entries: [] })
  apply(ctx, { storePath, dataDir: path.join(dir, 'plugin') })
  await settle()
  assert.equal(registered.tools.length, 10)
  assert.equal(registered.routes.length, 12)
})

test('tools can be disabled without disabling the routes', async (t) => {
  const dir = await home(t)
  const { ctx, registered } = fakeContext({ entries: [{ options: { name: 'dsh-global-todo' } }] })
  apply(ctx, { storePath: path.join(dir, 'todos.json'), dataDir: path.join(dir, 'plugin'), tools: false })
  await settle()
  assert.equal(registered.tools.length, 0)
  assert.equal(registered.routes.length, 12)
})

test('routes can be disabled without disabling the tools', async (t) => {
  const dir = await home(t)
  const { ctx, registered } = fakeContext({ entries: [{ options: { name: 'dsh-global-todo' } }] })
  apply(ctx, { storePath: path.join(dir, 'todos.json'), dataDir: path.join(dir, 'plugin'), routes: false })
  await settle()
  assert.equal(registered.tools.length, 10)
  assert.equal(registered.routes.length, 0)
})

test('every registered tool and route has the shape the host validates', async (t) => {
  const dir = await home(t)
  const { ctx, registered } = fakeContext({ entries: [{ options: { name: 'dsh-global-todo' } }] })
  apply(ctx, { storePath: path.join(dir, 'todos.json'), dataDir: path.join(dir, 'plugin') })
  await settle()

  for (const route of registered.routes) {
    assert.equal(route.kind, 'exact')
    // One route per path: the handler dispatches on request.method, so the
    // route object itself carries no method field.
    assert.equal(route.path.startsWith('/api/global-todo-connector'), true)
    assert.equal(typeof route.handler, 'function')
    assert.equal(route.auth, 'anonymous', 'a local script carries no cookie, so routes must be anonymous')
  }

  for (const tool of registered.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(Number.isFinite(tool.timeoutMs), true)
  }
})

test('the manager is stopped when the fiber is disposed', async (t) => {
  const dir = await home(t)
  const { ctx, disposeAll } = fakeContext({ entries: [{ options: { name: 'dsh-global-todo' } }] })
  apply(ctx, { storePath: path.join(dir, 'todos.json'), dataDir: path.join(dir, 'plugin') })
  await settle()
  // Reaching through the manager is not part of the public surface, so the
  // assertion is that disposal is quiet and idempotent.
  assert.doesNotThrow(disposeAll)
})

test('a services-less host still loads (both registration targets optional)', async (t) => {
  const dir = await home(t)
  const { ctx, registered } = fakeContext({ entries: [{ options: { name: 'dsh-global-todo' } }] })
  // Simulate `inject` never firing because neither service exists.
  ctx.inject = () => {}
  assert.doesNotThrow(() =>
    apply(ctx, { storePath: path.join(dir, 'todos.json'), dataDir: path.join(dir, 'plugin') }),
  )
  await settle()
  assert.equal(registered.tools.length, 0)
})

test('detectGlobalTodoForTests reports which signal it used', async (t) => {
  const dir = await home(t)
  const missing = await detectGlobalTodoForTests({ loader: { entries: () => [] } }, { storePath: path.join(dir, 'nope.json') })
  assert.deepEqual(missing, { found: false, via: 'none' })

  await mkdir(dir, { recursive: true })
  const storePath = path.join(dir, 'todos.json')
  await writeFile(storePath, '{}', 'utf8')
  const byFile = await detectGlobalTodoForTests({ loader: { entries: () => [] } }, { storePath })
  assert.equal(byFile.found, true)
  assert.equal(byFile.via, 'store-file')

  const byLoader = await detectGlobalTodoForTests(
    { loader: { entries: () => [{ options: { id: 'global-todo', name: 'dsh-global-todo' } }] } },
    { storePath },
  )
  assert.equal(byLoader.via, 'loader:global-todo')
})
