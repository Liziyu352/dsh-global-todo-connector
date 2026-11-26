/**
 * Config schema for the settings page (V1.1).
 *
 * The Host settings service reads `entry.fiber.runtime.Config` as the ONLY
 * schema source (packages/settings/settings/src/index.ts:427), and cordis
 * itself validates the plugin config through the same schema
 * (vendor/cordis/src/fiber.ts:80 resolveConfig). Fields must be marked
 * `.volatile()` to become editable on the settings page
 * (packages/settings/settings/src/schema.ts:37 volatileForm).
 *
 * `@deepseek-ai/schemastery` lives in the profile's node_modules. When the
 * plugin runs from a local directory install, Node's upward resolution may
 * not reach it, so the import is best-effort: on failure `Config` stays
 * undefined and the plugin falls back to its manual DEFAULTS merge (no
 * settings page, no behaviour change).
 */
import { DEFAULTS } from './defaults.js'

let Config
try {
  const { default: z } = await import('@deepseek-ai/schemastery')

  Config = z.object({
    storePath: z.string().default(DEFAULTS.storePath).volatile(),
    dataDir: z.string().default(DEFAULTS.dataDir).volatile(),
    hub: z.object({
      url: z.string().default(DEFAULTS.hub.url).volatile(),
      token: z.string().role('secret').default(DEFAULTS.hub.token).volatile(),
      instance: z.string().default(DEFAULTS.hub.instance).volatile(),
      timeoutMs: z.number().default(DEFAULTS.hub.timeoutMs).volatile(),
    }).default(DEFAULTS.hub),
    fileProxy: z.string().default(DEFAULTS.fileProxy).volatile(),
    tools: z.boolean().default(DEFAULTS.tools).volatile(),
    routes: z.boolean().default(DEFAULTS.routes).volatile(),
    schedule: z.boolean().default(DEFAULTS.schedule).volatile(),
  })
} catch {
  // schemastery unavailable — keep manual DEFAULTS merge, no settings page.
  Config = undefined
}

export { Config }
