/**
 * Agent tools.
 *
 * These are the surface a model uses to *write and run* connectors.  The rule
 * that shaped most of the design: a model must be able to go from "I want my
 * old TaskWarrior list in DSH" to a working connector without ever guessing a
 * field name, so `scaffold` emits a compilable starting point, `validate`
 * answers with the exact field that is wrong, and `write` refuses to save
 * something that would not run.
 *
 * Every tool returns a plain JSON value and declares an `output.schema`; the
 * host renders `output.render` into content blocks. Nothing here throws to the
 * caller — failures come back as `{ ok: false, reason, error }` so one bad call
 * never derails a turn.
 */

/** @param {string} text */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/** Wrap a thrown ConnectorError into the `{ok:false}` answer tools return. */
async function attempt(run) {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return {
      ok: false,
      reason: error?.reason ?? 'internal',
      error: error?.message ?? String(error),
      ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
    }
  }
}

/** A JSON schema fragment reused by outputs that carry a run report. */
const RUN_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
}

const CONNECTOR_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
}

/**
 * Build the tool definitions.
 *
 * @param {object} manager the manager from `manager.js`
 * @param {{ logger?: object }} [options]
 */
export function createTools(manager, options = {}) {
  const logger = options.logger

  const definitions = [
    {
      name: 'dsh_connector_list',
      description:
        '列出这台机器上已配置的待办连接器（YAML 文件），含方向、执行器类型、是否启用与定时周期。不读远端数据，只读本地定义。',
      parameters: {
        type: 'object',
        properties: {
          verbose: {
            type: 'boolean',
            description: '为 true 时附带每个连接器的完整 YAML 原文（可能较长）',
          },
        },
        additionalProperties: false,
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            connectors: { type: 'array', items: CONNECTOR_SUMMARY_SCHEMA },
          },
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`读取失败：${value.error ?? value.reason}`)
          if (value.connectors.length === 0) {
            return textBlock('还没有任何连接器。用 dsh_connector_scaffold 生成一个起点，再用 dsh_connector_write 保存。')
          }
          const lines = value.connectors.map((item) => {
            if (!item.ok) return `- ${item.name}：无法解析（${item.error}）`
            const schedule = item.everyMinutes > 0 ? `每 ${item.everyMinutes} 分钟` : '不定时'
            return `- ${item.name}（${item.label}）${item.enabled ? '启用' : '停用'} · ${item.direction} · ${item.kind} · ${schedule}`
          })
          return textBlock(`${value.connectors.length} 个连接器：\n${lines.join('\n')}`)
        },
      },
      async execute(args) {
        const result = await attempt(async () => {
          const connectors = await manager.listConnectors()
          if (args.verbose === true) {
            for (const item of connectors) {
              try {
                item.yaml = (await manager.readConnector(item.name)).text
              } catch {
                /* already reported as ok:false */
              }
            }
          }
          return connectors
        })
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, connectors: result.value }
      },
    },

    {
      name: 'dsh_connector_get',
      description: '读取一个连接器的完整 YAML 原文与解析后的摘要（方向、标签、执行器、字段映射）。改之前先读，能避免覆盖别人的改动。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '连接器名（就是 YAML 文件名，不含后缀）' } },
        required: ['name'],
        additionalProperties: false,
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            name: { type: 'string' },
            yaml: { type: 'string' },
            summary: CONNECTOR_SUMMARY_SCHEMA,
          },
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`读取失败：${value.error ?? value.reason}`)
          const s = value.summary
          return textBlock(
            `${value.name}：${s.direction} · ${s.executor} · 标签 ${s.tag}\n\`\`\`yaml\n${value.yaml}\n\`\`\``,
          )
        },
      },
      async execute(args) {
        const result = await attempt(async () => {
          const loaded = await manager.readConnector(args.name)
          return {
            name: loaded.name,
            file: loaded.file,
            yaml: loaded.text,
            summary: {
              direction: loaded.yaml.connector.direction,
              executor: loaded.yaml.client.executor.kind,
              tag: loaded.yaml.tag,
              enabled: loaded.yaml.connector.enabled,
              requiresPull: loaded.yaml.requiresPull,
              requiresPush: loaded.yaml.requiresPush,
            },
          }
        })
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, ...result.value }
      },
    },

    {
      name: 'dsh_connector_scaffold',
      description:
        '生成一个可直接编辑、也一定能通过校验的连接器 YAML 起点。生成的是**停用**状态，改完再用 dsh_connector_write 保存。适合在不知道字段名时先拿到骨架。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '连接器名，小写字母数字加 . _ -，例如 taskwarrior' },
          kind: { type: 'string', enum: ['cmd', 'rest'], description: '执行器类型：cmd 走本地命令，rest 走 HTTP' },
          direction: { type: 'string', enum: ['pull', 'push', 'both'], description: '同步方向' },
          label: { type: 'string', description: '展示名，默认与 name 相同' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, yaml: { type: 'string' } },
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`生成失败：${value.error ?? value.reason}`)
          return textBlock(`\`\`\`yaml\n${value.yaml}\n\`\`\``)
        },
      },
      async execute(args) {
        const result = await attempt(async () =>
          manager.scaffold({
            name: args.name,
            kind: args.kind ?? 'cmd',
            direction: args.direction ?? 'pull',
            label: args.label ?? '',
          }),
        )
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, yaml: result.value }
      },
    },

    {
      name: 'dsh_connector_validate',
      description:
        '只校验不改文件：把一段连接器 YAML 交给它，返回能否解析、以及解析出来会是什么（方向、执行器、映射字段）。写文件之前先跑一遍能省掉一次失败的重启。',
      parameters: {
        type: 'object',
        properties: { yaml: { type: 'string', description: '完整连接器 YAML 文本' } },
        required: ['yaml'],
        additionalProperties: false,
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, valid: { type: 'boolean' }, connector: CONNECTOR_SUMMARY_SCHEMA },
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (value.valid !== true) {
            return textBlock(
              `校验未通过${value.field ? `（${value.field}）` : ''}：${value.error ?? value.reason}`,
            )
          }
          return textBlock(`校验通过：${JSON.stringify(value.connector)}`)
        },
      },
      async execute(args) {
        const outcome = await attempt(async () => manager.validate(args.yaml, { source: '<validate>' }))
        // A validation tool that answered `ok: false` for a bad file would be
        // indistinguishable from a broken tool. The call succeeded; the file
        // did not. `valid` carries the file's verdict.
        if (outcome.ok !== true) {
          return { ok: true, valid: false, reason: outcome.reason, error: outcome.error, field: outcome.field }
        }
        return { ok: true, valid: true, connector: outcome.value.connector }
      },
    },

    {
      name: 'dsh_connector_write',
      description:
        '把连接器 YAML 保存为文件。会先完整校验，校验不过就拒绝写入并指出出错的字段——不会留下一个坏文件让定时器在半夜炸。文件名即连接器 id，必须与 YAML 里的 connector.name 一致。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '连接器名（文件名，不含后缀）' },
          yaml: { type: 'string', description: '完整连接器 YAML 文本' },
        },
        required: ['name', 'yaml'],
        additionalProperties: false,
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, name: { type: 'string' }, file: { type: 'string' } },
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (value.ok !== true) {
            return textBlock(`保存失败${value.field ? `（${value.field}）` : ''}：${value.error ?? value.reason}`)
          }
          return textBlock(`已保存 ${value.name} → ${value.file}`)
        },
      },
      async execute(args) {
        const result = await attempt(async () => manager.writeConnector(args.name, args.yaml))
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error, field: result.field }
        return { ok: true, name: result.value.name, file: result.value.file }
      },
    },

    {
      name: 'dsh_connector_delete',
      description: '删除一个连接器定义文件。只删定义，不动已经同步到本地待办清单里的条目——那些条目仍带 client:<名字> 标签。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '连接器名' } },
        required: ['name'],
        additionalProperties: false,
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, name: { type: 'string' }, deleted: { type: 'boolean' } },
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`删除失败：${value.error ?? value.reason}`)
          return textBlock(`已删除 ${value.name}`)
        },
      },
      async execute(args) {
        const result = await attempt(async () => manager.deleteConnector(args.name))
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, name: result.value.name, deleted: result.value.deleted }
      },
    },

    {
      name: 'dsh_connector_sync',
      description:
        '立即跑一次连接器同步（下拉远端 / 推上去 / 双向），返回本次报告：新建了几条、更新了几条、有没有冲突、有没有远端已消失的条目。dryRun 只算不写，适合先确认一次要动多少东西。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '连接器名' },
          dryRun: { type: 'boolean', description: '为 true 时只计算不写盘、不发网络/命令请求' },
          reason: { type: 'string', description: '写进运行日志的来源标注，默认 manual' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      output: {
        schema: RUN_REPORT_SCHEMA,
        render: (_args, value) => {
          if (value.ok !== true) {
            return textBlock(`同步失败（${value.reason ?? 'internal'}）：${value.error ?? ''}`)
          }
          const r = value.report
          const bits = []
          if (r.created !== undefined) bits.push(`新建 ${r.created}`)
          if (r.updated !== undefined) bits.push(`更新 ${r.updated}`)
          if (r.conflicts !== undefined) bits.push(`冲突 ${r.conflicts}`)
          if (r.pushed !== undefined) bits.push(`推出 ${r.pushed}`)
          if (r.unlinked !== undefined && r.unlinked > 0) bits.push(`远端已消失 ${r.unlinked}`)
          const head = `${r.connector} · ${r.direction}${r.dryRun ? ' · dryRun' : ''} · ${r.durationMs}ms`
          return textBlock(`${head}\n${bits.length > 0 ? bits.join('，') : '没有变化'}`)
        },
      },
      async execute(args, exec) {
        const result = await attempt(async () =>
          manager.sync(args.name, {
            dryRun: args.dryRun === true,
            reason: typeof args.reason === 'string' && args.reason !== '' ? args.reason : 'tool',
          }),
        )
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, report: result.value }
      },
    },

    {
      name: 'dsh_connector_status',
      description:
        '看连接器平台自身的健康状况：待办存储文件在哪、连接器目录、已排定的定时任务、可选 hub 的地址与连通性。排查「为什么没同步」时先看这个。',
      parameters: {
        type: 'object',
        properties: { probeHub: { type: 'boolean', description: '为 true 时真的去连一次 hub 并列出远端连接器' } },
        additionalProperties: false,
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`读取失败：${value.error ?? value.reason}`)
          const s = value.status
          const lines = [
            `待办存储：${s.store?.file ?? '未知'}${s.store?.exists === false ? '（还不存在）' : ''}`,
            `连接器目录：${s.connectorDir}`,
            `定时中：${s.scheduled.length === 0 ? '无' : s.scheduled.join('、')}`,
            `hub：${s.hub === null ? '未配置（可选）' : `${s.hub.url}${value.hub ? `（${value.hub.health?.connectors ?? '?'} 个远端连接器）` : ''}`}`,
          ]
          if (value.hub) lines.push(`远端连接器：${value.hub.remote.map((e) => e.name).join('、') || '无'}`)
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const result = await attempt(async () => {
          const status = await manager.status()
          let hub = null
          let hubProbe = null
          // Probing is opt-in: it is a network call, and the common question
          // ("why did nothing sync?") is answered by the local status alone.
          if (args.probeHub === true) {
            if (status.hub === null) {
              hubProbe = { ok: false, reason: 'hub-unavailable', error: '没有配置 hub' }
            } else {
              try {
                hub = await manager.hubStatus()
                hubProbe = { ok: true }
              } catch (error) {
                hubProbe = { ok: false, reason: error?.reason ?? 'hub-unavailable', error: error?.message ?? String(error) }
              }
            }
          }
          return { status, hub, hubProbe }
        })
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, status: result.value.status, hub: result.value.hub, hubProbe: result.value.hubProbe }
      },
    },

    {
      name: 'dsh_connector_runs',
      description: '读最近的同步运行记录（本地运行日志，若配置了 hub 也可读 hub 上的历史）。用于回答「上次同步是什么时候、结果如何」。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '只看的连接器名，省略则看全部' },
          limit: { type: 'number', description: '条数，1–100，默认 20' },
          fromHub: { type: 'boolean', description: '为 true 时从 hub 读历史而不是本地日志' },
        },
        additionalProperties: false,
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`读取失败：${value.error ?? value.reason}`)
          if (value.runs.length === 0) return textBlock('还没有运行记录。')
          const lines = value.runs.map((entry) => {
            const at = entry.at ?? entry.createdAt ?? entry.created_at ?? '?'
            const report = entry.report ?? entry.run?.report ?? {}
            const state = entry.ok === false || report.failed ? '失败' : '成功'
            const counts = [
              report.created !== undefined ? `新建 ${report.created}` : null,
              report.updated !== undefined ? `更新 ${report.updated}` : null,
              report.pushed !== undefined ? `推出 ${report.pushed}` : null,
              report.conflicts ? `冲突 ${report.conflicts}` : null,
            ]
              .filter(Boolean)
              .join('，')
            return `${at} · ${entry.connector ?? report.connector ?? '?'} · ${state}${counts ? ` · ${counts}` : ''}`
          })
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20
        const result = await attempt(async () =>
          args.fromHub === true ? manager.hubRuns({ connector: args.name, limit }) : manager.lastRuns(args.name, limit),
        )
        if (result.ok !== true) return { ok: false, reason: result.reason, error: result.error }
        return { ok: true, runs: result.value }
      },
    },

    {
      name: 'dsh_connector_hub',
      description:
        '可选的多机共享中枢：把连接器定义在多台 DSH 之间共享。status 看状态、pull 从 hub 拉到本地、push 把本地推到 hub、runs 看共享运行历史。没有配置 hub.url 时会明确报错而不是静默跳过。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'pull', 'push', 'runs'], description: '要做的事' },
          names: {
            type: 'array',
            items: { type: 'string' },
            description: '只处理这几个连接器；省略则处理全部',
          },
          force: { type: 'boolean', description: 'pull 时覆盖本地同名文件；push 时忽略版本冲突' },
          limit: { type: 'number', description: 'runs 时的条数，1–100' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (value.ok !== true) return textBlock(`hub 操作失败（${value.reason ?? 'hub-unavailable'}）：${value.error ?? ''}`)
          return textBlock(`hub ${value.action} 完成：${JSON.stringify(value.result)}`)
        },
      },
      async execute(args) {
        const action = args.action
        const names = Array.isArray(args.names) ? args.names : undefined
        const result = await attempt(async () => {
          if (action === 'status') return { status: await manager.hubStatus() }
          if (action === 'pull') return { pulled: await manager.hubPull({ names, force: args.force === true }) }
          if (action === 'push') return { pushed: await manager.hubPush({ names, force: args.force === true }) }
          return {
            runs: await manager.hubRuns({
              connector: names?.[0],
              limit: Number.isInteger(args.limit) ? args.limit : 20,
            }),
          }
        })
        if (result.ok !== true) return { ok: false, action, reason: result.reason, error: result.error }
        return { ok: true, action, result: result.value }
      },
    },
  ]

  if (logger !== undefined) logger.info?.(`dsh-global-todo-connector：准备了 ${definitions.length} 个工具`)
  return definitions
}
