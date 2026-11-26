/**
 * A small, dependency-free YAML subset parser and serializer.
 *
 * Why not just `import('yaml')`?  Two reasons, both learned the hard way:
 *
 * 1. A DSH plugin is loaded from the profile's `node_modules`, not from this
 *    repository's working tree.  Whatever parses the connector files must be
 *    available inside the *DSH process*, and we do not control what the user
 *    installed there.
 * 2. `dsh-global-todo` (the plugin this one extends) is deliberately
 *    dependency-free for the same reason: fewer moving parts survive a
 *    `0.2.x` upgrade.  We keep that property.
 *
 * The subset is chosen to make connector files pleasant to hand-write, not to
 * be a general YAML implementation:
 *
 *   - comments (`# ...` at line start or after whitespace, never inside quotes)
 *   - block mappings and block sequences, nested by indentation
 *   - `- key: value` compact sequence-of-mappings, plus deeper continuation
 *   - plain, single-quoted and double-quoted scalars, with the usual escapes
 *   - literal (`|`) and folded (`>`) block scalars with chomping indicators
 *   - flow collections on one line: `[a, b]`, `{a: 1}` (nested, quoted-aware)
 *   - booleans (true/false/yes/no/on/off), null (~/null/empty), ints, floats
 *   - multi-document files are rejected explicitly, anchors/aliases/tags too
 *
 * Everything outside the subset throws a `YamlError` with a line number.  A
 * connector file that silently mis-parses is far worse than one that refuses
 * to load.
 */

export class YamlError extends Error {
  constructor(message, line) {
    const suffix = Number.isInteger(line) ? `（第 ${line} 行）` : ''
    super(`${message}${suffix}`)
    this.name = 'YamlError'
    this.line = line ?? null
  }
}

const TRUE_WORDS = new Set(['true', 'yes', 'on'])
const FALSE_WORDS = new Set(['false', 'no', 'off'])
const NULL_WORDS = new Set(['null', '~'])

/**
 * Parse one YAML document into plain JS values.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  if (typeof text !== 'string') throw new YamlError('YAML 内容必须是字符串')
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const state = { lines: splitLines(source), index: 0 }

  // An explicit `---` document start is accepted and skipped; a second one is
  // rejected below because this parser handles exactly one document.
  skipBlank(state)
  const first = state.lines[state.index]
  if (first && /^---\s*$/.test(first.code)) {
    state.index += 1
    skipBlank(state)
  }
  const line = current(state)
  if (!line) return null

  const value = parseBlock(state, line.indent)
  skipBlank(state)
  const leftover = current(state)
  if (leftover) {
    if (/^(---|\.\.\.)\s*$/.test(leftover.code)) {
      throw new YamlError('不支持多文档 YAML（出现了第二个 --- ）', leftover.number)
    }
    throw new YamlError(`无法解析的内容：${leftover.code.trim().slice(0, 60)}`, leftover.number)
  }
  return value
}

/**
 * Serialize plain JS values back to block-style YAML.
 *
 * The output is intentionally boring: two-space indentation, double quotes only
 * where a plain scalar would be ambiguous.  Round-tripping through `parseYaml`
 * is covered by the test suite.
 *
 * @param {unknown} value
 * @param {{ indent?: number }} [options]
 * @returns {string}
 */
export function stringifyYaml(value, options = {}) {
  const indent = Number.isInteger(options.indent) ? options.indent : 2
  const lines = []
  emit(value, 0, lines, indent, { root: true })
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Lexing helpers
// ---------------------------------------------------------------------------

/**
 * Pre-scan raw text into physical lines.
 *
 * `raw` keeps the original text (block scalars need it verbatim), while `code`
 * is comment-stripped and right-trimmed for ordinary parsing.  A line whose
 * `code` is empty is blank for every purpose except block-scalar bodies.
 */
function splitLines(source) {
  const raw = source.split('\n')
  const lines = []
  for (let i = 0; i < raw.length; i += 1) {
    const code = stripComment(raw[i]).replace(/\s+$/, '')
    const trimmed = code.trim()
    if (trimmed !== '') {
      const leading = code.length - code.trimStart().length
      if (code.slice(0, leading).includes('\t')) {
        throw new YamlError('YAML 不允许用 Tab 缩进，请改用空格', i + 1)
      }
    }
    lines.push({ number: i + 1, raw: raw[i], code, text: trimmed, indent: code.length - code.trimStart().length })
  }
  return lines
}

function isBlankLine(line) {
  return line.text === ''
}

function current(state) {
  return state.lines[state.index]
}

function skipBlank(state) {
  while (state.index < state.lines.length && isBlankLine(state.lines[state.index])) state.index += 1
}

/** Advance past blank lines and return the next significant line, or undefined. */
function peek(state) {
  skipBlank(state)
  return current(state)
}

/**
 * Remove a trailing comment while respecting quotes.
 *
 * A `#` starts a comment only at the beginning of the line or after
 * whitespace, and only when it is not inside a quoted scalar.
 */
function stripComment(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === '\\') {
        // Single-quoted YAML has no backslash escapes; a backslash is literal.
        continue
      }
      if (ch === "'" && text[i + 1] === "'") i += 1
      else if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (ch === '\\') i += 1
      else if (ch === '"') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      // Only treat a quote as an opening quote when it starts a token.
      const prev = i === 0 ? ' ' : text[i - 1]
      if (/[\s:[{,-]/.test(prev)) quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i)
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function parseBlock(state, indent) {
  const line = peek(state)
  if (!line) return null
  if (line.indent < indent) return null
  if (line.indent > indent) {
    throw new YamlError(`缩进不一致（应为 ${indent} 个空格，实际 ${line.indent} 个）`, line.number)
  }
  if (isSequenceItem(line.text)) return parseSequence(state, indent)
  return parseMapping(state, indent)
}

function isSequenceItem(text) {
  return text === '-' || text.startsWith('- ')
}

function parseSequence(state, indent) {
  const items = []
  for (;;) {
    const line = peek(state)
    if (!line || line.indent !== indent || !isSequenceItem(line.text)) break
    state.index += 1

    const rest = line.text === '-' ? '' : line.text.slice(2).trimStart()

    if (rest === '') {
      const next = peek(state)
      items.push(next && next.indent > indent ? parseBlock(state, next.indent) : null)
      continue
    }

    if (isBlockScalarHeader(rest)) {
      items.push(readBlockScalar(state, rest, indent))
      continue
    }

    // `- key: value` starts a mapping whose first key sits on the dash line.
    if (looksLikeMappingEntry(rest)) {
      const innerIndent = line.indent + (line.text.length - rest.length)
      const map = {}
      fillEntry(state, map, parseMappingEntry(rest, line.number), innerIndent)
      parseMapping(state, innerIndent, map)
      items.push(map)
      continue
    }

    items.push(parseScalar(rest, line.number))
  }
  return items
}

function parseMapping(state, indent, seed) {
  const map = seed ?? {}
  for (;;) {
    const line = peek(state)
    if (!line || line.indent !== indent) break
    if (isSequenceItem(line.text)) break
    if (/^(---|\.\.\.)\s*$/.test(line.text)) {
      throw new YamlError('不支持多文档 YAML（出现了第二个 --- ）', line.number)
    }
    if (!looksLikeMappingEntry(line.text)) {
      throw new YamlError(`这里应该是 "键: 值"，但读到：${line.text.slice(0, 60)}`, line.number)
    }
    state.index += 1
    fillEntry(state, map, parseMappingEntry(line.text, line.number), indent)
  }
  return map
}

/** Resolve one mapping entry's value (inline scalar, block scalar, or nested block). */
function fillEntry(state, map, entry, indent) {
  if (Object.prototype.hasOwnProperty.call(map, entry.key)) {
    throw new YamlError(`重复的键：${entry.key}`, entry.line)
  }
  let value
  if (entry.blockScalar !== undefined) {
    value = readBlockScalar(state, entry.blockScalar, indent)
  } else if (entry.rawValue !== undefined) {
    value = parseScalar(entry.rawValue, entry.line)
  } else {
    const next = peek(state)
    value = next && next.indent > indent ? parseBlock(state, next.indent) : null
  }
  map[entry.key] = value
}

/**
 * Split one `key: value` line.  Returns `{ key, rawValue?, blockScalar?, line }`
 * where `rawValue` is absent when the line ends right after the colon.
 */
function parseMappingEntry(text, lineNumber) {
  const keyEnd = findKeyEnd(text)
  if (keyEnd === -1) {
    throw new YamlError(`找不到键值分隔的冒号：${text.slice(0, 60)}`, lineNumber)
  }
  const key = normalizeKey(text.slice(0, keyEnd), lineNumber)
  const rest = text.slice(keyEnd + 1).trimStart()
  if (rest === '') return { key, line: lineNumber }
  if (isBlockScalarHeader(rest)) return { key, blockScalar: rest, line: lineNumber }
  return { key, rawValue: rest, line: lineNumber }
}

/**
 * Find the `:` that separates a key from its value, respecting quoted keys and
 * requiring the colon to be followed by whitespace or a flow delimiter.
 */
function findKeyEnd(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'" && text[i + 1] === "'") i += 1
      else if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (ch === '\\') i += 1
      else if (ch === '"') quote = ''
      continue
    }
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s:[{,-]/.test(text[i - 1]))) {
      quote = ch
      continue
    }
    if (ch === ':' && (i + 1 === text.length || /[\s[\]{}]/.test(text[i + 1]))) {
      return i
    }
  }
  return -1
}

function normalizeKey(raw, lineNumber) {
  const text = raw.trim()
  if (text === '') throw new YamlError('键不能为空', lineNumber)
  if (text.startsWith('"') || text.startsWith("'")) {
    return String(parseScalar(text, lineNumber))
  }
  if (/^[?&*!|>%@`]/.test(text)) {
    throw new YamlError(`不支持以 ${text[0]} 开头的键（锚点/标签/复杂键不在支持范围）`, lineNumber)
  }
  return text
}

function looksLikeMappingEntry(text) {
  if (isBlockScalarHeader(text)) return false
  if (text.startsWith('[') || text.startsWith('{')) return false
  if (/^["']/.test(text) && findKeyEnd(text) === -1) return false
  return findKeyEnd(text) !== -1
}

// ---------------------------------------------------------------------------
// Block scalars
// ---------------------------------------------------------------------------

function isBlockScalarHeader(text) {
  return /^[|>][+-]?[0-9]?$/.test(text) || /^[|>][+-]?\s*$/.test(text)
}

/**
 * Consume an indented block scalar body.
 *
 * `header` is `|`, `|-`, `|+`, `>`, `>-` or `>+` (an explicit indentation
 * indicator is accepted and ignored).  The body is made of every subsequent
 * physical line that is blank or indented deeper than `parentIndent`.
 */
function readBlockScalar(state, header, parentIndent) {
  const literal = header.startsWith('|')
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'

  const body = []
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]
    if (isBlankLine(line)) {
      body.push({ blank: true, raw: line.raw, number: line.number })
      state.index += 1
      continue
    }
    if (line.indent <= parentIndent) break
    body.push({ blank: false, raw: line.raw, number: line.number })
    state.index += 1
  }

  // Trailing blank lines belong to the scalar only under the `keep` indicator;
  // for `clip`/`strip` they are separators between mappings.
  const trailing = []
  if (chomp === 'keep') {
    while (body.length > 0 && body[body.length - 1].blank) trailing.unshift(body.pop())
  } else {
    while (body.length > 0 && body[body.length - 1].blank) body.pop()
  }

  if (body.length === 0) return chomp === 'keep' ? '\n'.repeat(trailing.length + 1) : ''

  const contentIndent = body
    .filter((line) => !line.blank)
    .reduce((min, line) => Math.min(min, line.raw.length - line.raw.trimStart().length), Infinity)

  const texts = body.map((line) => (line.blank ? '' : line.raw.slice(contentIndent)))
  let text
  if (literal) {
    text = texts.join('\n')
  } else {
    text = foldLines(texts)
  }
  if (chomp === 'strip') return text
  if (chomp === 'keep') return `${text}\n${'\n'.repeat(trailing.length)}`
  return `${text}\n`
}

/**
 * YAML folded style: a single newline between two non-blank, non-indented lines
 * becomes a space; blank lines become hard newlines; deeper-indented lines keep
 * their newlines.
 */
function foldLines(texts) {
  let out = ''
  for (let i = 0; i < texts.length; i += 1) {
    const line = texts[i]
    if (i === 0) {
      out = line
      continue
    }
    const prev = texts[i - 1]
    const indented = /^\s/.test(line) || /^\s/.test(prev)
    if (line === '') out += '\n'
    else if (prev === '') out += line
    else out += indented ? `\n${line}` : ` ${line}`
  }
  return out
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

function parseScalar(text, lineNumber) {
  const value = text.trim()
  if (value === '') return null

  const first = value[0]
  if (first === '"' || first === "'") return parseQuoted(value, lineNumber)
  if (first === '[' || first === '{') return parseFlow(value, lineNumber)
  if (/^[&*!]/.test(value)) {
    throw new YamlError('不支持锚点（&）、别名（*）或标签（!）', lineNumber)
  }
  if (/^[@`%]/.test(value)) {
    throw new YamlError(`不支持以 ${first} 开头的标量`, lineNumber)
  }
  return parsePlain(value)
}

function parsePlain(value) {
  const lower = value.toLowerCase()
  if (NULL_WORDS.has(lower)) return null
  if (TRUE_WORDS.has(lower)) return true
  if (FALSE_WORDS.has(lower)) return false
  if (/^[+-]?(0|[1-9][0-9]*)$/.test(value)) {
    const num = Number(value)
    return Number.isSafeInteger(num) ? num : value
  }
  if (/^[+-]?(0|[1-9][0-9]*)\.[0-9]+([eE][+-]?[0-9]+)?$/.test(value) || /^[+-]?(0|[1-9][0-9]*)[eE][+-]?[0-9]+$/.test(value)) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return value
}

function parseQuoted(value, lineNumber) {
  const quote = value[0]
  let out = ''
  let i = 1
  for (; i < value.length; i += 1) {
    const ch = value[i]
    if (quote === "'") {
      if (ch === "'") {
        if (value[i + 1] === "'") {
          out += "'"
          i += 1
          continue
        }
        break
      }
      out += ch
      continue
    }
    // Double-quoted: support the escapes people actually use.
    if (ch === '\\') {
      const next = value[i + 1]
      i += 1
      switch (next) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case '"': out += '"'; break
        case '\\': out += '\\'; break
        case '/': out += '/'; break
        case '0': out += '\0'; break
        case 'u': {
          const hex = value.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError('非法的 \\u 转义', lineNumber)
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
          break
        }
        default:
          throw new YamlError(`不支持的转义 \\${next}`, lineNumber)
      }
      continue
    }
    if (ch === '"') break
    out += ch
  }
  if (i >= value.length) throw new YamlError('引号没有闭合', lineNumber)
  const trailing = value.slice(i + 1).trim()
  if (trailing !== '') {
    throw new YamlError(`引号闭合后还有多余内容：${trailing.slice(0, 40)}`, lineNumber)
  }
  return out
}

/** Parse a single-line flow collection (`[a, b]`, `{a: 1, b: [c]}`). */
function parseFlow(value, lineNumber) {
  const reader = { text: value, index: 0, lineNumber }
  const result = readFlowValue(reader)
  skipSpaces(reader)
  if (reader.index < reader.text.length) {
    throw new YamlError(`流式集合之后还有多余内容：${reader.text.slice(reader.index).slice(0, 40)}`, lineNumber)
  }
  return result
}

function skipSpaces(reader) {
  while (reader.index < reader.text.length && /\s/.test(reader.text[reader.index])) reader.index += 1
}

function readFlowValue(reader) {
  skipSpaces(reader)
  const ch = reader.text[reader.index]
  if (ch === '[') return readFlowSequence(reader)
  if (ch === '{') return readFlowMapping(reader)
  if (ch === '"' || ch === "'") return readFlowScalar(reader)
  return readFlowPlain(reader)
}

function readFlowSequence(reader) {
  reader.index += 1 // [
  const items = []
  skipSpaces(reader)
  if (reader.text[reader.index] === ']') {
    reader.index += 1
    return items
  }
  for (;;) {
    items.push(readFlowValue(reader))
    skipSpaces(reader)
    const ch = reader.text[reader.index]
    if (ch === ',') {
      reader.index += 1
      skipSpaces(reader)
      if (reader.text[reader.index] === ']') {
        reader.index += 1
        return items
      }
      continue
    }
    if (ch === ']') {
      reader.index += 1
      return items
    }
    throw new YamlError('流式序列缺少 ] 或 ,', reader.lineNumber)
  }
}

function readFlowMapping(reader) {
  reader.index += 1 // {
  const map = {}
  skipSpaces(reader)
  if (reader.text[reader.index] === '}') {
    reader.index += 1
    return map
  }
  for (;;) {
    skipSpaces(reader)
    const key = readFlowMapKey(reader)
    skipSpaces(reader)
    if (reader.text[reader.index] !== ':') {
      throw new YamlError('流式映射的键后面缺少冒号', reader.lineNumber)
    }
    reader.index += 1
    map[String(key)] = readFlowValue(reader)
    skipSpaces(reader)
    const ch = reader.text[reader.index]
    if (ch === ',') {
      reader.index += 1
      skipSpaces(reader)
      if (reader.text[reader.index] === '}') {
        reader.index += 1
        return map
      }
      continue
    }
    if (ch === '}') {
      reader.index += 1
      return map
    }
    throw new YamlError('流式映射缺少 } 或 ,', reader.lineNumber)
  }
}

function readFlowMapKey(reader) {
  const ch = reader.text[reader.index]
  if (ch === '"' || ch === "'") return readFlowScalar(reader)
  const start = reader.index
  while (reader.index < reader.text.length) {
    const current = reader.text[reader.index]
    if (current === ':' || current === ',' || current === '}') break
    reader.index += 1
  }
  return parsePlain(reader.text.slice(start, reader.index).trim())
}

function readFlowScalar(reader) {
  const start = reader.index
  const quote = reader.text[reader.index]
  reader.index += 1
  for (; reader.index < reader.text.length; reader.index += 1) {
    const ch = reader.text[reader.index]
    if (quote === "'") {
      if (ch === "'") {
        if (reader.text[reader.index + 1] === "'") {
          reader.index += 1
          continue
        }
        reader.index += 1
        return parseQuoted(reader.text.slice(start, reader.index), reader.lineNumber)
      }
      continue
    }
    if (ch === '\\') {
      reader.index += 1
      continue
    }
    if (ch === '"') {
      reader.index += 1
      return parseQuoted(reader.text.slice(start, reader.index), reader.lineNumber)
    }
  }
  throw new YamlError('流式标量的引号没有闭合', reader.lineNumber)
}

function readFlowPlain(reader) {
  const start = reader.index
  while (reader.index < reader.text.length) {
    const ch = reader.text[reader.index]
    if (ch === ',' || ch === ']' || ch === '}') break
    if (ch === ':' && /[\s,\]}]/.test(reader.text[reader.index + 1] ?? ' ')) break
    reader.index += 1
  }
  return parsePlain(reader.text.slice(start, reader.index).trim())
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function emit(value, depth, lines, indent, context = {}) {
  const pad = ' '.repeat(depth * indent)
  if (value === null || value === undefined) {
    if (context.root) lines.push('null')
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`)
      return
    }
    for (const item of value) {
      if (isPlainContainer(item)) {
        lines.push(`${pad}-`)
        emit(item, depth + 1, lines, indent, {})
        continue
      }
      lines.push(`${pad}- ${renderScalar(item)}`)
    }
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      lines.push(`${pad}{}`)
      return
    }
    for (const [key, item] of entries) {
      const renderedKey = renderKey(key)
      if (isPlainContainer(item)) {
        lines.push(`${pad}${renderedKey}:`)
        emit(item, depth + 1, lines, indent, {})
        continue
      }
      // Empty arrays/objects must stay typed: rendering them through
      // `renderScalar` would stringify `[]` as `""`, which reads back as a
      // string and turns `tags: []` into `tags: ""`.
      if (Array.isArray(item)) {
        lines.push(`${pad}${renderedKey}: []`)
        continue
      }
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}${renderedKey}: {}`)
        continue
      }
      lines.push(`${pad}${renderedKey}: ${renderScalar(item)}`)
    }
    return
  }
  lines.push(`${pad}${renderScalar(value)}`)
}

function isPlainContainer(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value === null || typeof value !== 'object') return false
  // An empty object must render inline as `{}`, not as an empty block.
  return Object.keys(value).length > 0
}

function renderKey(key) {
  const text = String(key)
  if (/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(text)) return text
  return JSON.stringify(text)
}

function renderScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'bigint') return String(value)
  const text = String(value)
  if (needsQuotes(text)) return JSON.stringify(text)
  return text
}

function needsQuotes(text) {
  if (text === '') return true
  if (text !== text.trim()) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true
  if (/: |\s#/.test(text)) return true
  if (text.includes('\n') || text.includes('\t')) return true
  const lower = text.toLowerCase()
  if (NULL_WORDS.has(lower) || TRUE_WORDS.has(lower) || FALSE_WORDS.has(lower)) return true
  if (/^[+-]?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text)) return true
  return false
}
