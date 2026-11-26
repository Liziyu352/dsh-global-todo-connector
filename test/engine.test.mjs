import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseConnector } from '../lib/connector.js'
import { buildPushPayload, createEngine, loadState, mapRemote, saveState } from '../lib/engine.js'
import { createStore, createTodoRecord } from '../lib/store.js'

/** Make a throwaway workspace: a todos.json plus a state directory. */
async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-engine-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'todos.json')
  const stateDir = path.join(dir, 'state')
  const store = createStore({ file })
  /** Write `payload` as the fake downstream's output and return its connector. */
  async function remote(payload) {
    const target = path.join(dir, `remote-${Math.random().toString(36).slice(2)}.json`)
    await writeFile(target, JSON.stringify(payload), 'utf8')
    return fileConnector(target)
  }
  return { dir, file, stateDir, store, remote }
}

/**
 * A connector whose pull prints a JSON document.
 *
 * The payload goes into a file rather than into the command line so the YAML
 * stays readable and the shell never has to survive nested quoting.
 */
function fileConnector(file) {
  return parseConnector(
    `
version: 1
connector:
  name: demo
  enabled: true
  direction: pull
client:
  name: demo
  executor:
    kind: cmd
    pull:
      run: cat ${file}
      parse: json
`,
    { source: 'test' },
  )
}

/** A connector whose push writes its stdin to a file we can read back. */
function captureConnector(outFile, { direction = 'both', extra = '' } = {}) {
  const text = `
version: 1
connector:
  name: demo
  enabled: true
  direction: ${direction}
client:
  name: demo
  executor:
    kind: cmd
    pull:
      run: "printf '[]'"
      parse: json
    push:
      run: "cat > ${outFile}"
      stdin: batch
${extra}`
  return parseConnector(text, { source: 'test' })
}

const RECORD = (overrides = {}) => ({
  id: 'r1',
  title: 'from remote',
  description: '',
  status: 'todo',
  priority: 'p1',
  updatedAt: 1000,
  ...overrides,
})

test('mapRemote reads dotted paths and normalizes the vocabulary', () => {
  const connector = parseConnector(
    `
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: echo }
mapping:
  pull:
    id: uuid
    title: fields.summary
    status:
      path: state
      map: { TODO: open, DONE: done }
    priority:
      path: fields.priority
      map: { P1: urgent, P4: low }
    tags: labels
    dueAt: when
`,
    { source: 'test' },
  )
  const mapped = mapRemote(
    {
      uuid: 'abc',
      fields: { summary: '  hello  ', priority: 'p1' },
      state: 'TODO',
      labels: ['one', 'Two', 'one', ''],
      when: '2026-01-02T00:00:00.000Z',
    },
    connector,
  )
  assert.equal(mapped.remoteId, 'abc')
  assert.equal(mapped.fields.title, 'hello')
  assert.equal(mapped.fields.status, 'open')
  assert.equal(mapped.fields.priority, 'urgent')
  assert.deepEqual(mapped.fields.tags, ['one', 'Two'])
  assert.equal(mapped.fields.dueAt, '2026-01-02T00:00:00.000Z')
})

test('mapRemote leaves unsent fields undefined so patches do not erase them', () => {
  const connector = parseConnector(
    `
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: echo }
`,
    { source: 'test' },
  )
  const mapped = mapRemote({ id: 'abc', title: 'only a title' }, connector)
  assert.equal(mapped.fields.description, undefined)
  assert.equal(mapped.fields.dueAt, undefined)
  assert.equal(mapped.fields.status, undefined)
  assert.equal(mapped.fields.priority, undefined)
  assert.equal(mapped.fields.tags, undefined)
})

test('mapRemote rejects a record with no remote id', () => {
  const connector = parseConnector(
    `
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: echo }
`,
    { source: 'test' },
  )
  assert.throws(() => mapRemote({ title: 'no id' }, connector), (error) => error.reason === 'invalid-remote')
})

test('state files round-trip and forget records without a remoteId', async (t) => {
  const { dir } = await workspace(t)
  const file = path.join(dir, 'state.json')
  await saveState(file, {
    version: 1,
    links: {
      't-1': { remoteId: 'r1', localUpdatedAt: 1, remoteUpdatedAt: 2, localStatus: 'open', remoteStatus: 'open', lastSyncedAt: 3 },
      't-2': { localUpdatedAt: 1 },
      't-3': null,
    },
    lastRun: 5,
    lastResult: { at: 5, created: 1 },
  })
  const state = await loadState(file)
  assert.deepEqual(Object.keys(state.links), ['t-1'])
  assert.equal(state.links['t-1'].remoteId, 'r1')
  assert.equal(state.lastRun, 5)
})

test('a corrupt state file degrades to an empty state instead of failing the sync', async (t) => {
  const { dir } = await workspace(t)
  const file = path.join(dir, 'state.json')
  await writeFile(file, '{ nope', 'utf8')
  const warnings = []
  const state = await loadState(file, { warn: (message) => warnings.push(message) })
  assert.deepEqual(state.links, {})
  assert.equal(warnings.length, 1)
  // The warning is the only signal: silently rebuilding state can mis-pair
  // records if the recovery-by-title path is used.
  assert.match(warnings[0], /状态/)
})

test('pull creates todos, and a second pull is a no-op', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  const connector = await remote([RECORD()])

  const first = await engine.pull(connector)
  assert.equal(first.created.length, 1)
  assert.equal(first.updated.length, 0)

  const todos = await store.all()
  assert.equal(todos.length, 1)
  assert.equal(todos[0].title, 'from remote')
  assert.equal(todos[0].status, 'open')
  assert.equal(todos[0].priority, 'high')
  assert.deepEqual(todos[0].tags, ['client:demo'])
  assert.equal(todos[0].createdBy, 'agent')
  assert.equal(todos[0].captureSource, 'connector')

  const second = await engine.pull(connector)
  assert.equal(second.created.length, 0)
  assert.equal(second.updated.length, 0)
  assert.equal((await store.all()).length, 1)
})

test('pull applies changes from the remote side', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })

  await engine.pull(await remote([RECORD()]))
  clock = 2000
  const report = await engine.pull(await remote([RECORD({ title: 'renamed', updatedAt: 2000 })]))
  assert.equal(report.updated.length, 1)
  const [todo] = await store.all()
  assert.equal(todo.title, 'renamed')
  assert.equal(todo.updatedAt, 2000)
  assert.equal(todo.updatedBy, 'agent')
  assert.equal(todo.activity.at(-1).kind, 'synced')
})

test('pull keeps local edits when the remote side did not change', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })
  await engine.pull(await remote([RECORD()]))

  // The user edits locally; the remote record is untouched (same updatedAt).
  await store.update((doc) => ({
    next: doc.todos.map((todo) => ({ ...todo, title: 'local title', updatedAt: 1500 })),
    result: null,
  }))

  clock = 2000
  const report = await engine.pull(await remote([RECORD()]))
  assert.equal(report.updated.length, 0)
  assert.deepEqual(report.conflicts, [])
  const [todo] = await store.all()
  assert.equal(todo.title, 'local title')
})

test('pull resolves a both-sides change with the configured policy', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })
  await engine.pull(await remote([RECORD()]))

  await store.update((doc) => ({
    next: doc.todos.map((todo) => ({ ...todo, title: 'local', updatedAt: 5000 })),
    result: null,
  }))

  // Remote is newer -> remote wins under `newer`.
  clock = 6000
  const report = await engine.pull(await remote([RECORD({ title: 'remote', updatedAt: 9000 })]))
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.conflicts[0].winner, 'remote')
  assert.equal((await store.all())[0].title, 'remote')
})

test('a local-wins conflict is reported and the local title survives', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })
  await engine.pull(await remote([RECORD()]))
  await store.update((doc) => ({
    next: doc.todos.map((todo) => ({ ...todo, title: 'local', updatedAt: 9000 })),
    result: null,
  }))
  clock = 10000
  const report = await engine.pull(await remote([RECORD({ title: 'remote', updatedAt: 2000 })]))
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.conflicts[0].winner, 'local')
  assert.equal((await store.all())[0].title, 'local')
})

test('pull reports records that vanished remotely without deleting them', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })
  await engine.pull(await remote([RECORD()]))

  clock = 2000
  const report = await engine.pull(await remote([]))
  assert.equal(report.unlinked.length, 1)
  assert.equal(report.unlinked[0].remoteId, 'r1')
  assert.equal((await store.all()).length, 1, 'a vanished remote record must not delete the local todo')
})

test('pull recovers the mapping by title when the state file is lost', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })
  await engine.pull(await remote([RECORD()]))
  await saveState(path.join(stateDir, 'demo.state.json'), { version: 1, links: {}, lastRun: null, lastResult: null })

  clock = 2000
  const report = await engine.pull(await remote([RECORD({ title: 'from remote', updatedAt: 1700000000001 })]))
  assert.equal(report.created.length, 0, 'the title match should recover instead of duplicating')
  assert.equal((await store.all()).length, 1)
})

test('pull skips records beyond maxPull', async (t) => {
  const { dir, stateDir, store } = await workspace(t)
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  const records = Array.from({ length: 5 }, (_, i) => RECORD({ id: `r${i}`, title: `t${i}` }))
  const file = path.join(dir, 'many.json')
  await writeFile(file, JSON.stringify(records), 'utf8')
  const connector = parseConnector(
    `
version: 1
connector:
  name: demo
  enabled: true
  direction: pull
  limits: { maxPull: 2 }
client:
  name: demo
  executor:
    kind: cmd
    pull:
      run: cat ${file}
      parse: json
`,
    { source: 'test' },
  )
  const report = await engine.pull(connector)
  assert.equal(report.created.length, 2)
  assert.equal((await store.all()).length, 2)
})

test('dryRun reports what would change and writes nothing', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  const report = await engine.pull(await remote([RECORD()]), { dryRun: true })
  assert.equal(report.created.length, 1)
  assert.equal((await store.all()).length, 0)
})

test('push sends only tagged, locally-changed, non-inbox todos', async (t) => {
  const { dir, stateDir, store } = await workspace(t)
  const out = path.join(dir, 'pushed.json')
  const connector = captureConnector(out)

  await store.update((doc) => ({
    next: [
      createTodoRecord({ id: 't-1', title: 'ours', tags: ['client:demo'], createdAt: 1, now: 1 }),
      createTodoRecord({ id: 't-2', title: 'theirs', tags: ['other'], createdAt: 1, now: 1 }),
      createTodoRecord({ id: 't-3', title: 'inbox', tags: ['client:demo', 'inbox'], createdAt: 1, now: 1 }),
    ],
    result: null,
  }))

  const engine = createEngine({ store, stateDir, now: () => 2000 })
  const report = await engine.push(connector)
  assert.equal(report.candidates, 1)
  assert.equal(report.pushed, 1)

  const sent = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].description, 'ours')  // task text goes as description
  assert.equal(sent[0].tags.includes('client:demo'), true)
})

test('push does not resend an unchanged todo, but does resend an edited one', async (t) => {
  const { dir, stateDir, store } = await workspace(t)
  const out = path.join(dir, 'pushed.json')
  const connector = captureConnector(out)
  let clock = 1000
  const engine = createEngine({ store, stateDir, now: () => clock })

  await store.update((doc) => ({ next: [createTodoRecord({ id: 't-1', title: 'a', tags: ['client:demo'], createdAt: 1, now: 1 })], result: null }))
  const first = await engine.push(connector)
  assert.equal(first.pushed, 1)

  clock = 2000
  const second = await engine.push(connector)
  assert.equal(second.pushed, 0, 'unchanged todos must not be pushed again')

  await store.update((doc) => ({ next: doc.todos.map((todo) => ({ ...todo, title: 'b', updatedAt: 3000 })), result: null }))
  clock = 3000
  const third = await engine.push(connector)
  assert.equal(third.pushed, 1)
  const sent = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(sent[0].description, 'b', 'a batch push always sends an array')
})

test('push honours a template tree in mapping.push', async (t) => {
  const { dir, stateDir, store } = await workspace(t)
  const out = path.join(dir, 'pushed.json')
  const connector = captureConnector(out, {
    extra: `mapping:
  id: id
  push:
    content: "\${todo.title}"
    due: "\${todo.dueAt}"
    done: "\${todo.status}"
    labels: "\${todo.tags}"
    client: "\${client.name}"
`,
  })
  await store.update((doc) => ({
    next: [
      createTodoRecord({
        id: 't-1',
        title: 'ship it',
        status: 'done',
        dueAt: '2026-01-02T00:00:00.000Z',
        tags: ['client:demo'],
        createdAt: 1,
        now: 1,
      }),
    ],
    result: null,
  }))
  const engine = createEngine({ store, stateDir, now: () => 2000 })
  await engine.push(connector)
  const sent = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].content, 'ship it')
  assert.equal(sent[0].due, '2026-01-02T00:00:00.000Z')
  assert.equal(sent[0].done, 'done')
  assert.equal(sent[0].client, 'demo')
})

test('buildPushPayload sends the todo fields when no template is configured', () => {
  const connector = parseConnector(
    `
version: 1
connector: { name: demo, direction: both }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: echo }
    push: { run: cat }
`,
    { source: 'test' },
  )
  const payload = buildPushPayload(
    { id: 't-1', title: 'x', description: 'd', dueAt: null, status: 'open', priority: 'high', tags: ['client:demo'] },
    { remoteId: 'r1' },
    connector,
    1000,
  )
  // The task text goes out as `description` (TaskWarrior semantics); `title`
  // is not sent at all — a `title` key with an empty description segfaults
  // `task import` 2.6.2.
  assert.equal(payload.description, 'x')
  assert.equal(payload.notes, 'd')
  assert.equal(payload.title, undefined)
  // The default payload inverts the pull vocabulary: local `open` maps to the
  // remote word `pending` via the push fallback.
  assert.equal(payload.status, 'pending')
  // Local `high` has no entry in the default pull priority map, so it goes
  // through PRIORITY_PUSH_FALLBACK as `M`.
  assert.equal(payload.priority, 'M')
  // Nulls are omitted, not sent.
  assert.equal('dueAt' in payload, false)
  assert.equal(payload.id, 'r1')
})

test('push records the remote id so a later pull can match', async (t) => {
  const { dir, stateDir, store } = await workspace(t)
  const connector = captureConnector(path.join(dir, 'pushed.json'))
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  await store.update((doc) => ({ next: [createTodoRecord({ id: 't-1', title: 'a', tags: ['client:demo'], createdAt: 1, now: 1 })], result: null }))
  await engine.push(connector)
  const state = await loadState(path.join(stateDir, 'demo.state.json'))
  assert.equal(state.links['t-1'] !== undefined, true)
  assert.equal(state.links['t-1'].localUpdatedAt, 1)
})

test('sync runs pull then push for a both-direction connector', async (t) => {
  const { dir, stateDir, store } = await workspace(t)
  const out = path.join(dir, 'pushed.json')
  const connector = captureConnector(out)
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  const report = await engine.sync(connector)
  assert.equal(report.direction, 'both')
  assert.equal(report.parts.length, 2)
  assert.equal(report.parts[0].direction, 'pull')
  assert.equal(report.parts[1].direction, 'push')
})

test('concurrent syncs of one connector share a single run', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  const connector = await remote([RECORD()])
  const [a, b] = await Promise.all([engine.sync(connector), engine.sync(connector)])
  assert.equal(a, b, 'the second call must join the in-flight run rather than duplicate it')
  assert.equal((await store.all()).length, 1)
})

test('a failing connector surfaces a readable error and leaves the store intact', async (t) => {
  const { stateDir, store, remote } = await workspace(t)
  const connector = parseConnector(
    `
version: 1
connector: { name: demo, enabled: true, direction: pull }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: "exit 3", parse: json }
`,
    { source: 'test' },
  )
  const engine = createEngine({ store, stateDir, now: () => 1000 })
  await assert.rejects(
    engine.pull(connector),
    (error) => error.reason === 'exec-failed' && /退出码 3/.test(error.message),
  )
  assert.equal((await store.all()).length, 0)
})
