import assert from 'node:assert/strict'
import test from 'node:test'

import { YamlError, parseYaml, stringifyYaml } from '../lib/yaml.js'

test('parses a mapping with nested blocks', () => {
  const doc = parseYaml(`
version: 1
connector:
  name: taskwarrior
  enabled: true
  schedule:
    everyMinutes: 15
`)
  assert.deepEqual(doc, {
    version: 1,
    connector: { name: 'taskwarrior', enabled: true, schedule: { everyMinutes: 15 } },
  })
})

test('parses sequences, including compact "- key: value" items', () => {
  const doc = parseYaml(`
tags:
  - alpha
  - "b c"
items:
  - name: one
    value: 1
  - name: two
    value: 2
`)
  assert.deepEqual(doc, {
    tags: ['alpha', 'b c'],
    items: [
      { name: 'one', value: 1 },
      { name: 'two', value: 2 },
    ],
  })
})

test('parses block scalars with all three chomping modes', () => {
  const doc = parseYaml(`
literal: |
  first
  second
folded: >
  a b
  c d
keep: |+
  kept

strip: |-
  no newline
`)
  assert.equal(doc.literal, 'first\nsecond\n')
  assert.equal(doc.folded, 'a b c d\n')
  assert.equal(doc.keep, 'kept\n\n')
  assert.equal(doc.strip, 'no newline')
})

test('parses flow collections', () => {
  const doc = parseYaml(`
emptyList: []
emptyMap: {}
list: [a, b, "c d"]
map: {a: 1, b: [x, y]}
`)
  assert.deepEqual(doc, { emptyList: [], emptyMap: {}, list: ['a', 'b', 'c d'], map: { a: 1, b: ['x', 'y'] } })
})

test('strips comments but keeps hashes inside quotes', () => {
  const doc = parseYaml(`
# leading comment
value: plain # trailing comment
quoted: "keep # this"
single: '# not a comment'
`)
  assert.deepEqual(doc, { value: 'plain', quoted: 'keep # this', single: '# not a comment' })
})

test('handles quoted scalars with escapes and doubled single quotes', () => {
  const doc = parseYaml(`
double: "line\\nbreak"
single: 'it''s fine'
`)
  assert.equal(doc.double, 'line\nbreak')
  assert.equal(doc.single, "it's fine")
})

test('coerces booleans, null and numbers but not strings', () => {
  const doc = parseYaml(`
a: true
b: no
c: null
d: ~
e: 42
f: -3.5
g: "42"
h: 0x10
`)
  assert.equal(doc.a, true)
  assert.equal(doc.b, false)
  assert.equal(doc.c, null)
  assert.equal(doc.d, null)
  assert.equal(doc.e, 42)
  assert.equal(doc.f, -3.5)
  assert.equal(doc.g, '42')
  assert.equal(doc.h, '0x10')
})

test('round-trips a nested document', () => {
  const value = {
    version: 1,
    connector: { name: 'x', enabled: false, tags: [], empty: {} },
    list: [1, 'two', true, null],
    nested: { deep: { deeper: [ 'a', { b: 2 } ] } },
    text: 'line one\nline two\n',
    quoted: 'has: colon',
    numeric: '007',
  }
  const text = stringifyYaml(value)
  assert.deepEqual(parseYaml(text), value)
})

test('empty structural values stay typed', () => {
  const text = stringifyYaml({ list: [], map: {}, text: [] })
  const back = parseYaml(text)
  assert.deepEqual(back.list, [])
  assert.deepEqual(back.map, {})
  assert.deepEqual(back.text, [])
})

test('quotes values that would otherwise change type', () => {
  const text = stringifyYaml({ a: 'true', b: '42', c: 'null', d: ' raw ', e: 'yes' })
  const back = parseYaml(text)
  assert.equal(back.a, 'true')
  assert.equal(back.b, '42')
  assert.equal(back.c, 'null')
  assert.equal(back.d, ' raw ')
  assert.equal(back.e, 'yes')
})

test('rejects tab indentation with a line number', () => {
  assert.throws(
    () => parseYaml('a:\n\tb: 1\n'),
    (error) => error instanceof YamlError && /第 2 行/.test(error.message),
  )
})

test('rejects duplicate keys', () => {
  assert.throws(
    () => parseYaml('a: 1\na: 2\n'),
    (error) => error instanceof YamlError && /重复/.test(error.message),
  )
})

test('rejects multi-document input', () => {
  assert.throws(
    () => parseYaml('a: 1\n---\nb: 2\n'),
    (error) => error instanceof YamlError && /多文档/.test(error.message),
  )
})

test('rejects anchors and aliases', () => {
  assert.throws(() => parseYaml('a: &anchor 1\nb: *anchor\n'), YamlError)
})

test('parses an empty document as null', () => {
  // Matches js-yaml: `load('')` is undefined, which we normalize to null so the
  // caller can tell "no document" from "an empty mapping".
  assert.equal(parseYaml(''), null)
  assert.equal(parseYaml('# just a comment\n'), null)
})

test('rejects a document that is only a mapping value', () => {
  assert.throws(() => parseYaml('just a string'), (error) => error instanceof YamlError)
})
