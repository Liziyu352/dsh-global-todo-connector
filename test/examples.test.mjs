import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseConnector, stringifyConnector } from '../lib/connector.js'

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples')

test('every example connector parses and is disabled by default', async () => {
  const files = (await readdir(EXAMPLES)).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  assert.equal(files.length >= 4, true, 'the repository should ship a few worked examples')

  for (const file of files) {
    const text = await readFile(path.join(EXAMPLES, file), 'utf8')
    const connector = parseConnector(text, { source: file })
    assert.equal(
      connector.connector.name,
      path.basename(file, path.extname(file)),
      `${file} must be named after its connector so writeConnector accepts it`,
    )
    assert.equal(connector.connector.enabled, false, `${file} must ship disabled: writing a file must not start pushing`)
    assert.equal(connector.mapping.pull.id.path !== '', true, `${file} needs a stable id for idempotent sync`)
  }
})

test('every example survives a stringify → parse round-trip', async () => {
  const files = (await readdir(EXAMPLES)).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  for (const file of files) {
    const text = await readFile(path.join(EXAMPLES, file), 'utf8')
    const first = parseConnector(text, { source: file })
    const second = parseConnector(stringifyConnector(first), { source: file })
    assert.deepEqual(second.connector, first.connector, `${file}: connector block drifted`)
    assert.deepEqual(second.client, first.client, `${file}: client block drifted`)
    assert.deepEqual(second.mapping, first.mapping, `${file}: mapping drifted`)
  }
})

test('the examples cover both executor kinds and all three directions', async () => {
  const files = (await readdir(EXAMPLES)).filter((name) => name.endsWith('.yaml'))
  const kinds = new Set()
  const directions = new Set()
  for (const file of files) {
    const connector = parseConnector(await readFile(path.join(EXAMPLES, file), 'utf8'), { source: file })
    kinds.add(connector.client.executor.kind)
    directions.add(connector.connector.direction)
  }
  assert.deepEqual([...kinds].sort(), ['cmd', 'rest'])
  assert.deepEqual([...directions].sort(), ['both', 'pull', 'push'])
})
