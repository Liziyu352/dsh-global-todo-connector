/**
 * Plugin entry point.
 *
 * Two contracts shape this file:
 *
 *   1. `dsh-global-todo` must be present, or nothing here makes sense.  It
 *      exposes no Cordis service, so there is no `inject` to wait on — the
 *      dependency is a *data* dependency on its JSON store.  We therefore check
 *      both the live loader entries and the store file, and bail out quietly
 *      (one log line) when neither says the plugin is installed.
 *   2. Every registration belongs to this context and must be disposable. The
 *      Loader may unload or reload this plugin at any moment, and a leaked
 *      timer, tool or route would outlive it.
 *
 * The plugin deliberately imports nothing from `@deepseek-ai/*`: tools use raw
 * JSON Schema and routes use the plain `webServer.register` contract, which is
 * what keeps this working across 0.2.x releases and in lean compositions that
 * do not load the agent preset.
 */

import { access } from 'node:fs/promises'

import { createManager } from './manager.js'
import { createRoutes } from './routes.js'
import { createTools } from './tools.js'
import { resolveStorePath } from './store.js'

export const name = 'dsh-global-todo-connector'
export const VERSION = '0.1.0'

/** `tools` and `webServer` are both optional: the plugin is useful without either. */
export const inject = []

export const DEFAULTS = {
  storePath: '',
  dataDir: '',
  hub: { url: '', token: '', instance: '', timeoutMs: 8000 },
  tools: true,
  routes: true,
  schedule: true,
}

/** The keys `DEFAULTS` documents, exposed so a test can keep the two honest. */
export const DEFAULT_CONFIG_KEYS = Object.keys(DEFAULTS)

/** Merge a partial config over the defaults, one level deep for `hub`. */
export function resolveConfig(config = {}) {
  return {
    ...DEFAULTS,
    ...config,
    hub: { ...DEFAULTS.hub, ...(config.hub ?? {}) },
  }
}

/**
 * Is `dsh-global-todo` present?
 *
 * Checked against the Loader entry list first (authoritative while the host is
 * running), then against the store file on disk (authoritative when this plugin
 * loads before the todo plugin, which happens in some compositions).
 */
async function detectGlobalTodo(ctx, config) {
  try {
    const loader = ctx?.loader
    for (const entry of loader?.entries?.() ?? []) {
      const moduleName = String(entry?.options?.name ?? '')
      if (moduleName === 'dsh-global-todo' || moduleName.startsWith('dsh-global-todo@')) {
        return { found: true, via: `loader:${entry.options.id ?? moduleName}` }
      }
    }
  } catch {
    /* a loader without entries() is not a reason to refuse to start */
  }
  try {
    await access(resolveStorePath(config))
    return { found: true, via: 'store-file' }
  } catch {
    return { found: false, via: 'none' }
  }
}

/** Detection, exported for tests: the plugin's whole gating rule lives here. */
export const detectGlobalTodoForTests = detectGlobalTodo

/**
 * @param {object} ctx cordis context
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const logger = ctx?.logger ?? console

  // Detection is async; the rest of `apply` must be synchronous so cordis can
  // attribute every registration to this fiber.
  //
  // `ready` is the single place the manager comes from. Tools and routes await
  // the same promise instead of reaching for a mutable variable, so their
  // ordering does not depend on which `then` was queued first.
  const ready = detectGlobalTodo(ctx, resolved).then(
    async (result) => {
      if (!result.found) {
        logger.warn?.(
          'dsh-global-todo-connector：没检测到 dsh-global-todo（既没有它的 Loader 条目，也没有它的存储文件），本插件不启动。',
        )
        return null
      }
      try {
        const manager = createManager({ config: resolved, logger })
        logger.info?.(`dsh-global-todo-connector：已连接 dsh-global-todo（${result.via}）`)
        if (resolved.schedule !== false) {
          const started = await manager.start()
          logger.info?.(`dsh-global-todo-connector：排定 ${started.scheduled} 个定时连接器`)
        }
        return manager
      } catch (error) {
        // A broken connector directory must not take the host down.
        logger.error?.(`dsh-global-todo-connector 启动失败：${error?.message ?? error}`)
        return null
      }
    },
    (error) => {
      logger.warn?.(`dsh-global-todo-connector：检测 dsh-global-todo 失败（${error?.message ?? error}），本插件不启动。`)
      return null
    },
  )

  ctx.effect(() => {
    let disposed = false
    ready.then((manager) => {
      if (disposed) manager?.stop()
    })
    return () => {
      disposed = true
      ready.then((manager) => manager?.stop(), () => {})
    }
  }, 'dsh-global-todo-connector:manager')

  if (resolved.tools !== false) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => {
        let disposers = []
        let cancelled = false
        ready.then((manager) => {
          if (cancelled || manager === null) return
          try {
            const definitions = createTools(manager, { logger })
            disposers = definitions.map((definition) => toolCtx.tools.register(definition))
            logger.info?.(`dsh-global-todo-connector：注册了 ${definitions.length} 个工具`)
          } catch (error) {
            logger.error?.(`dsh-global-todo-connector：注册工具失败：${error?.message ?? error}`)
          }
        })
        return () => {
          cancelled = true
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* a failed cleanup must not mask the next one */
            }
          }
          disposers = []
        }
      }, 'dsh-global-todo-connector:tools')
    })
  }

  if (resolved.routes !== false) {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        let disposers = []
        let cancelled = false
        ready.then((manager) => {
          if (cancelled || manager === null) return
          try {
            const routes = createRoutes({ manager, logger })
            disposers = routes.map((route) => webCtx.webServer.register(route))
            logger.info?.(`dsh-global-todo-connector：注册了 ${routes.length} 条 HTTP 路由`)
          } catch (error) {
            logger.error?.(`dsh-global-todo-connector：注册路由失败：${error?.message ?? error}`)
          }
        })
        return () => {
          cancelled = true
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* ignore */
            }
          }
          disposers = []
        }
      }, 'dsh-global-todo-connector:routes')
    })
  }

  // Teach the model when the connector platform is worth reaching for. Without
  // this the tools exist but the model has no reason to prefer them over
  // hand-editing JSON.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => {
      const dispose = promptCtx.systemPrompt.section({
        name: 'dsh-global-todo-connector:guidance',
        order: 3045,
        text: [
          '全局待办的连接器（dsh-global-todo-connector）：',
          '- 用户要把 DSH 的待办接到外部系统（飞书/钉钉/TaskWarrior/Todoist/自建 REST）时，用 dsh_connector_* 工具写 YAML 连接器，不要手写 JSON 存储。',
          '- 新建连接器：先 dsh_connector_scaffold 拿骨架，改完 dsh_connector_validate，再 dsh_connector_write；write 会拒绝不能解析的文件。',
          '- 连接器默认停用（enabled: false）；确认没问题后改成 true，或用 dsh_connector_sync 手动跑一次。',
          '- 连接器只同步带 client:<客户端名> 标签的待办，不会影响其它待办；远端消失的条目只报告为 unlinked，不会自动删除。',
        ].join('\n'),
      })
      return () => dispose?.()
    }, 'dsh-global-todo-connector:guidance')
  })
}

export default { name, apply }
