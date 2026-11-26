/**
 * Test entry point.
 *
 * `node --test test/*.test.mjs` is what CI runs; this file exists so that
 * `npm test` works from any shell (including Windows cmd) without relying on
 * glob expansion being performed by the shell.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = (await readdir(dir))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(dir, name))

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
