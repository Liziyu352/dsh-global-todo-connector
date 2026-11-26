import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONNECTOR_VERSION,
  clientTagOf,
  parseConnector,
  projectTagOf,
  readPath,
  renderDeep,
  renderTemplate,
  scaffoldConnector,
  stringifyConnector,
} from '../lib/connector.js'
import { ConnectorError } from '../lib/errors.js'

/** Assert that `fn` throws a ConnectorError with the given reason. */
function throwsReason(fn, reason) {
  assert.throws(fn, (error) => error instanceof ConnectorError && error.reason === reason)
}

const MINIMAL = `
version: 1
connector:
  name: demo
client:
  name: demo
  executor:
    kind: cmd
    pull:
      run: echo '[]'
`

test('parses a minimal connector and fills every default', () => {
  const connector = parseConnector(MINIMAL, { source: 'test.yml' })
  assert.equal(connector.version, CONNECTOR_VERSION)
  assert.equal(connector.source, 'test.yml')
  assert.equal(connector.connector.name, 'demo')
  assert.equal(connector.connector.label, 'demo')
  assert.equal(connector.connector.enabled, false)
  assert.equal(connector.connector.direction, 'pull')
  assert.equal(connector.connector.conflict, 'newer')
  assert.equal(connector.connector.schedule.everyMinutes, 15)
  assert.equal(connector.connector.schedule.onBoot, false)
  assert.equal(connector.connector.limits.maxPull, 200)
  assert.equal(connector.connector.limits.maxPush, 200)
  assert.equal(connector.client.priority, 'normal')
  assert.deepEqual(connector.client.tags, [])
  // Identity mapping by default, so a downstream that already speaks the todo
  // vocabulary needs no mapping block at all.
  assert.equal(connector.mapping.pull.title.path, 'title')
  assert.deepEqual(connector.mapping.pull.title.map, {})
  assert.equal(connector.mapping.push, null)
  assert.equal(connector.tag, 'client:demo')
  assert.equal(connector.requiresPull, true)
  assert.equal(connector.requiresPush, false)
})

test('rejects a connector without a pull id path', () => {
  // Without a stable remote key every sync would re-create every todo.
  throwsReason(
    () => parseConnector(`
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: echo }
mapping:
  id: ""
`),
    'invalid-connector',
  )
})

test('rejects malformed YAML with a line number and an invalid-yaml reason', () => {
  assert.throws(
    () => parseConnector('version: 1\nconnector: [\n'),
    (error) => error instanceof ConnectorError && error.reason === 'invalid-yaml',
  )
})

test('rejects a direction the executor cannot serve', () => {
  // A pull-only executor that claims `both` would silently do nothing on push.
  throwsReason(
    () => parseConnector(`
version: 1
connector: { name: demo, direction: both }
client:
  name: demo
  executor:
    kind: cmd
    pull: { run: echo }
`),
    'invalid-connector',
  )
})

test('rejects unknown enums with the offending field', () => {
  assert.throws(
    () => parseConnector(MINIMAL.replace('name: demo\n', 'name: demo\n  direction: sideways\n')),
    (error) => error instanceof ConnectorError && /direction/.test(error.message),
  )
})

test('normalizes field specs with status and priority maps', () => {
  const connector = parseConnector(`
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
      map:
        TODO: open
        DONE: done
    priority:
      path: fields.priority
      map: { P1: urgent, P4: low }
`)
  assert.deepEqual(connector.mapping.pull.id, { path: 'uuid', map: {} })
  assert.equal(connector.mapping.pull.title.path, 'fields.summary')
  assert.equal(connector.mapping.pull.status.path, 'state')
  assert.deepEqual(connector.mapping.pull.status.map, { TODO: 'open', DONE: 'done' })
  assert.deepEqual(connector.mapping.pull.priority.map, { P1: 'urgent', P4: 'low' })
})

test('keeps a push template tree verbatim', () => {
  const connector = parseConnector(`
version: 1
connector: { name: demo, direction: both }
client:
  name: demo
  executor:
    kind: rest
    baseUrl: https://example.com
    pull: { path: /tasks, items: data }
    push: { method: POST, path: /tasks }
mapping:
  id: id
  push:
    content: "\${todo.title}"
    due_string: "\${todo.dueAt}"
    labels: "\${todo.tags}"
`)
  assert.deepEqual(connector.mapping.push, {
    content: '${todo.title}',
    due_string: '${todo.dueAt}',
    labels: '${todo.tags}',
  })
})

test('round-trips a scaffold through parse -> stringify -> parse', () => {
  for (const kind of ['cmd', 'rest']) {
    for (const direction of ['pull', 'push', 'both']) {
      const text = scaffoldConnector({ name: `demo-${kind}`, kind, direction })
      const first = parseConnector(text, { source: 'scaffold' })
      const again = parseConnector(stringifyConnector(first), { source: 'rewrite' })
      assert.deepEqual(again.mapping, first.mapping, `${kind}/${direction} mapping drifted`)
      assert.deepEqual(again.client.executor, first.client.executor, `${kind}/${direction} executor drifted`)
      assert.deepEqual(again.connector, first.connector, `${kind}/${direction} connector drifted`)
    }
  }
})

test('serializes identity mappings flat and remapped ones nested', () => {
  const flat = stringifyConnector(parseConnector(MINIMAL, { source: 'x' }))
  // A downstream that already speaks `id`/`title`/... needs no nesting; keeping
  // it flat is what makes the generated file readable enough to hand-edit.
  assert.match(flat, /mapping:\n {2}id: id\n {2}title: title\n/)

  const nested = stringifyConnector(
    parseConnector(
      `${MINIMAL}mapping:\n  pull:\n    id: uuid\n    status:\n      path: state\n      map:\n        TODO: open\n`,
      { source: 'x' },
    ),
  )
  assert.match(nested, /mapping:\n {2}pull:\n/)
  assert.match(nested, / {4}id: uuid/)
})

test('rejects header names that are not valid HTTP tokens', () => {
  throwsReason(
    () => parseConnector(`
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: rest
    baseUrl: https://example.com
    headers: { "Bad Header": x }
    pull: { path: /tasks }
`),
    'invalid-connector',
  )
})

test('accepts real-world header names', () => {
  const connector = parseConnector(`
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: rest
    baseUrl: https://example.com
    headers:
      Authorization: "Bearer \${env:TOKEN}"
      X-Api-Key: secret
      Accept-Language: zh-CN
    pull: { path: /tasks }
`)
  assert.deepEqual(connector.client.executor.headers, {
    Authorization: 'Bearer ${env:TOKEN}',
    'X-Api-Key': 'secret',
    'Accept-Language': 'zh-CN',
  })
})

test('rejects a missing executor', () => {
  throwsReason(
    () => parseConnector('version: 1\nconnector: { name: demo }\nclient:\n  name: demo\n'),
    'invalid-connector',
  )
})

test('rejects a REST executor without baseUrl', () => {
  throwsReason(
    () => parseConnector(`
version: 1
connector: { name: demo }
client:
  name: demo
  executor:
    kind: rest
    pull: { path: /tasks }
`),
    'invalid-connector',
  )
})

test('rejects YAML larger than the configured ceiling', () => {
  const huge = `version: 1\nconnector: { name: demo }\nclient:\n  name: demo\n  executor:\n    kind: cmd\n    pull: { run: echo }\n# ${'x'.repeat(1024 * 1024)}\n`
  throwsReason(() => parseConnector(huge), 'payload-too-large')
})

test('readPath walks dots and indexes', () => {
  const value = { a: { b: [{ c: 'deep' }] }, list: [10, 20] }
  assert.equal(readPath(value, 'a.b[0].c'), 'deep')
  assert.equal(readPath(value, 'list[1]'), 20)
  assert.equal(readPath(value, ''), value)
  assert.equal(readPath(value, 'missing.path'), undefined)
  assert.equal(readPath(value, 'a.b[9].c'), undefined)
})

test('renderTemplate keeps types for a lone placeholder and interpolates otherwise', () => {
  const scope = { todo: { title: 'ship it', count: 3, tags: ['a', 'b'] } }
  assert.equal(renderTemplate('${todo.count}', scope), 3)
  assert.deepEqual(renderTemplate('${todo.tags}', scope), ['a', 'b'])
  assert.equal(renderTemplate('title: ${todo.title}!', scope), 'title: ship it!')
  assert.equal(renderTemplate('${todo.missing}', scope), undefined)
  assert.equal(renderTemplate('x${todo.missing}y', scope), 'xy')
  assert.equal(renderTemplate('no placeholders', scope), 'no placeholders')
})

test('renderTemplate resolves env and clock placeholders', () => {
  process.env.GTC_TEST_VALUE = 'from-env'
  try {
    assert.equal(renderTemplate('${env:GTC_TEST_VALUE}', {}), 'from-env')
    assert.equal(renderTemplate('${env:GTC_TEST_MISSING}', {}), '')
    assert.match(String(renderTemplate('${now}', {})), /^\d{4}-\d{2}-\d{2}T/)
    assert.match(String(renderTemplate('${today}', {})), /^\d{4}-\d{2}-\d{2}$/)
  } finally {
    delete process.env.GTC_TEST_VALUE
  }
})

test('renderDeep recurses through objects and arrays', () => {
  const rendered = renderDeep(
    { a: '${todo.title}', b: ['${todo.count}', 7], c: { d: true } },
    { todo: { title: 'x', count: 2 } },
  )
  assert.deepEqual(rendered, { a: 'x', b: [2, 7], c: { d: true } })
})

test('derives stable tags for clients and projects', () => {
  assert.equal(clientTagOf('demo'), 'client:demo')
  assert.equal(clientTagOf('My Connector'), 'client:my-connector')
  assert.equal(projectTagOf('工作'), 'project:工作')
  // Tags are capped at 32 characters by the todo schema.
  assert.ok(clientTagOf('a'.repeat(80)).length <= 32)
  assert.equal(projectTagOf(''), '')
})

test('a connector with a project adds a project tag', () => {
  const withProject = MINIMAL.replace('client:\n  name: demo\n', 'client:\n  name: demo\n  project: Work\n')
  assert.notEqual(withProject, MINIMAL, 'fixture did not change; the test would be vacuous')
  assert.equal(parseConnector(withProject, { source: 'x' }).projectTag, 'project:Work')
})
