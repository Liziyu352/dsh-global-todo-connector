import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  INBOX_TAG,
  LIMITS,
  SCHEMA_VERSION,
  createStore,
  createTodoRecord,
  hasInboxTag,
  newTodoId,
  normalizeDocument,
  normalizeTodo,
  presentTodo,
  priorityForDue,
  resolveHomeDir,
  resolvePluginDir,
  resolveStorePath,
} from '../lib/store.js'

/** Make a throwaway directory and guarantee it is removed afterwards. */
async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gtc-store-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('resolveHomeDir prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveHomeDir({ DSH_HOME: '/custom/home' }), '/custom/home')
  assert.equal(resolveHomeDir({ DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'))
  assert.equal(resolveHomeDir({}), path.join(os.homedir(), '.dsh'))
})

test('resolveStorePath honours storePath and defaults to the global-todo file', () => {
  assert.equal(resolveStorePath({ storePath: '/tmp/elsewhere/todos.json' }, {}), '/tmp/elsewhere/todos.json')
  assert.equal(resolveStorePath({ storePath: '' }, { DSH_HOME: '/h' }), path.join('/h', 'global-todo', 'todos.json'))
})

test('resolvePluginDir sits next to the todo file', () => {
  assert.equal(resolvePluginDir({}, { DSH_HOME: '/h' }), path.join('/h', 'global-todo-connector'))
  assert.equal(resolvePluginDir({ dataDir: '/data' }, { DSH_HOME: '/h' }), '/data')
})

test('priorityForDue maps the remaining time onto the four levels', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  assert.equal(priorityForDue('2025-12-31T00:00:00.000Z', { now }), 'urgent')
  assert.equal(priorityForDue('2026-01-02T00:00:00.000Z', { now }), 'high')
  assert.equal(priorityForDue('2026-01-05T00:00:00.000Z', { now }), 'normal')
  assert.equal(priorityForDue('2026-02-01T00:00:00.000Z', { now }), 'low')
  // No deadline and an unparseable deadline both land on `low`: nothing about
  // them argues for attention, and the upstream plugin answers the same.
  assert.equal(priorityForDue(null, { now }), 'low')
  assert.equal(priorityForDue(undefined, { now }), 'low')
  assert.equal(priorityForDue('not a date', { now }), 'low')
  assert.equal(priorityForDue('   ', { now }), 'low')
})

test('newTodoId looks like the upstream ids and avoids collisions', () => {
  const id = newTodoId()
  assert.match(id, /^t-[0-9a-f]{8}$/)
  // Handing it a list that already contains its own output must produce a new
  // id — connectors create many todos in one pass.
  const taken = [id]
  const next = newTodoId(taken)
  assert.notEqual(next, id)
  assert.ok(!taken.includes(next))
})

test('normalizeTodo repairs a hand-edited record', () => {
  const todo = normalizeTodo({
    id: 't-1',
    title: '  hello  ',
    status: 'nonsense',
    priority: 'P1',
    tags: 'a, b ,, #c',
    links: [{ url: 'https://example.com', title: 'x' }, null, 42, '', { value: '' }],
    steps: [{ title: 'step', done: true }, { title: '', done: false }, 'garbage'],
    activity: Array.from({ length: 80 }, (_, i) => ({ at: i, kind: 'created', by: 'human' })),
  })
  assert.equal(todo.id, 't-1')
  assert.equal(todo.title, 'hello')
  assert.equal(todo.status, 'open')
  // An invalid priority is not silently coerced from `P1`: P1 is a valid alias.
  assert.equal(todo.priority, 'normal')
  assert.deepEqual(todo.tags, ['a', 'b', 'c'])
  // Only entries that actually name a target survive: `null`, numbers and
  // empty strings are dropped rather than turned into empty links.
  assert.equal(todo.links.length, 1)
  assert.equal(todo.links[0].value, 'https://example.com')
  assert.equal(todo.links[0].kind, 'url')
  // Steps carry their text in `title`; a step without one is not a step.
  assert.equal(todo.steps.length, 1)
  assert.equal(todo.steps[0].title, 'step')
  assert.equal(todo.steps[0].done, true)
  assert.equal(todo.activity.length, LIMITS.activity)
})

test('normalizeTodo rejects records without an id or title', () => {
  assert.equal(normalizeTodo({ id: '', title: 'x' }), null)
  assert.equal(normalizeTodo({ id: 't-1', title: '' }), null)
  assert.equal(normalizeTodo(null), null)
  assert.equal(normalizeTodo([]), null)
})

test('normalizeTodo keeps unknown fields so a patch cannot drop them', () => {
  const todo = normalizeTodo({ id: 't-1', title: 'x', futureField: { deep: 1 } })
  assert.deepEqual(todo.futureField, { deep: 1 })
})

test('normalizeDocument drops duplicates and reports the schema version', () => {
  const doc = normalizeDocument(
    {
      version: SCHEMA_VERSION,
      todos: [
        { id: 't-1', title: 'a' },
        { id: 't-1', title: 'duplicate' },
        { id: 't-2', title: 'b' },
        'nope',
      ],
      trash: [],
    },
    { activityLimit: 5 },
  )
  assert.equal(doc.version, SCHEMA_VERSION)
  assert.deepEqual(doc.todos.map((todo) => todo.id), ['t-1', 't-2'])
  assert.equal(doc.todos[0].title, 'a')
})

test('normalizeDocument survives a completely broken payload', () => {
  const doc = normalizeDocument(null, { activityLimit: 5 })
  assert.deepEqual(doc, { version: SCHEMA_VERSION, todos: [], trash: [] })
})

test('createTodoRecord fills the same shape the upstream plugin writes', () => {
  const record = createTodoRecord({
    id: 't-abc',
    title: 'from remote',
    description: 'd',
    status: 'open',
    priority: 'high',
    prioritySource: 'human',
    captureSource: 'connector',
    dueAt: '2026-01-02T00:00:00.000Z',
    tags: ['client:demo'],
    notes: 'a note',
    createdAt: 1,
    updatedAt: 1,
  })
  assert.equal(record.id, 't-abc')
  assert.equal(record.seq, 0)
  assert.equal(record.priority, 'high')
  assert.equal(record.prioritySource, 'human')
  assert.equal(record.inboxReason, '')
  assert.equal(record.doneAt, null)
  assert.equal(record.notes.length, 1)
  assert.equal(record.notes[0].text, 'a note')
  assert.equal(record.notes[0].by, 'agent')
  assert.equal(record.activity.at(-1).kind, 'created')
  // Field order is part of the on-disk contract: a human reading the JSON (or a
  // `git diff` of it) should see the same layout the upstream plugin produces.
  assert.deepEqual(Object.keys(record).slice(0, 6), ['id', 'seq', 'title', 'description', 'status', 'priority'])
})

test('presentTodo projects the fields a listing needs', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const view = presentTodo(
    {
      id: 't-1',
      seq: 3,
      title: 'x',
      status: 'open',
      priority: 'high',
      dueAt: '2025-12-31T00:00:00.000Z',
      tags: ['inbox'],
      inboxReason: 'no-due',
      activity: [],
      updatedAt: now,
    },
    now,
  )
  assert.equal(view.id, 't-1')
  assert.equal(view.overdue, true)
  assert.equal(view.inbox, true)
  assert.equal(view.inboxReason, 'no-due')
  assert.equal(view.tags.length, 1)
})

test('hasInboxTag only trusts the tag list', () => {
  assert.equal(hasInboxTag({ tags: [INBOX_TAG] }), true)
  assert.equal(hasInboxTag({ tags: ['x'] }), false)
  assert.equal(hasInboxTag({}), false)
})

test('store read on a missing file returns an empty document without creating it', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'nested', 'todos.json')
  const store = createStore({ file })
  const doc = await store.read()
  assert.deepEqual(doc, { version: SCHEMA_VERSION, todos: [], trash: [] })
  const description = await store.describe()
  assert.equal(description.exists, false)
  assert.equal(description.todos, 0)
})

test('store update persists, serializes concurrent writers, and preserves trash', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  const store = createStore({ file })

  await store.update((doc) => ({ next: [...doc.todos, createTodoRecord({ id: 't-1', title: 'one', createdAt: 1 })], result: null }))
  await store.update((doc) => ({ next: [...doc.todos, createTodoRecord({ id: 't-2', title: 'two', createdAt: 2 })], result: null }))

  // Ten concurrent appends must all land: the promise chain plus the lock file
  // is what keeps read-modify-write from losing entries.
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      store.update((doc) => ({
        next: [...doc.todos, createTodoRecord({ id: `t-c${i}`, title: `c${i}`, createdAt: 100 + i })],
        result: null,
      })),
    ),
  )

  const todos = await store.all()
  assert.equal(todos.length, 12)
  assert.deepEqual(new Set(todos.map((todo) => todo.id)).size, 12)

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.version, SCHEMA_VERSION)
  assert.equal(raw.todos.length, 12)
  assert.ok(Array.isArray(raw.trash))
})

test('store update without `next` does not touch the file', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  const store = createStore({ file })
  await store.update((doc) => ({ next: [...doc.todos, createTodoRecord({ id: 't-1', title: 'one', createdAt: 1 })], result: null }))
  const before = await readFile(file, 'utf8')
  const count = await store.update((doc) => ({ result: doc.todos.length }))
  assert.equal(count, 1)
  assert.equal(await readFile(file, 'utf8'), before)
})

test('store rejects a nested update instead of deadlocking', async (t) => {
  const dir = await scratch(t)
  const store = createStore({ file: path.join(dir, 'todos.json') })
  await assert.rejects(
    store.update(async () => {
      await store.update(() => ({ result: 1 }))
      return { result: 2 }
    }),
    (error) => error.reason === 'internal',
  )
})

test('store refuses to overwrite a corrupt file', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  await writeFile(file, '{ this is not json', 'utf8')
  const store = createStore({ file })
  await assert.rejects(store.read(), (error) => error.reason === 'store-corrupt')
  // The corrupt bytes must survive: the user can repair them by hand, and a
  // silently reset file would lose every todo.
  assert.equal(await readFile(file, 'utf8'), '{ this is not json')
})

test('store refuses a file written by a newer schema', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  await writeFile(file, JSON.stringify({ version: SCHEMA_VERSION + 1, todos: [], trash: [] }), 'utf8')
  const store = createStore({ file })
  await assert.rejects(store.read(), (error) => error.reason === 'store-corrupt')
})

test('store counts external modifications', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  const store = createStore({ file })
  await store.update((doc) => ({ next: [...doc.todos], result: null }))
  await store.read()
  // Simulate another process (or the user in an editor) rewriting the file.
  await writeFile(file, JSON.stringify({ version: SCHEMA_VERSION, todos: [], trash: [] }), 'utf8')
  await store.read()
  const description = await store.describe()
  assert.ok(description.externalChanges >= 1)
})

test('store tolerates a hand-edited file with a bad record', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  await writeFile(
    file,
    JSON.stringify({
      version: SCHEMA_VERSION,
      todos: [{ id: 't-1', title: 'good' }, { title: 'no id' }, null],
      trash: [],
    }),
    'utf8',
  )
  const store = createStore({ file })
  const todos = await store.all()
  assert.equal(todos.length, 1)
  assert.equal(todos[0].id, 't-1')
})

test('store writes atomically and leaves no temp files behind', async (t) => {
  const dir = await scratch(t)
  const file = path.join(dir, 'todos.json')
  const store = createStore({ file })
  await store.update((doc) => ({ next: [...doc.todos, createTodoRecord({ id: 't-1', title: 'x', createdAt: 1 })], result: null }))
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(dir)
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [])
  assert.deepEqual(names.filter((name) => name.endsWith('.lock')), [])
})
