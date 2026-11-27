/** Plugin defaults — the single source both the manual merge and the Config schema read. */

export const DEFAULTS = {
  storePath: '',
  dataDir: '',
  hub: { url: '', token: '', instance: '', timeoutMs: 8000 },
  fileProxy: '',
  tools: true,
  routes: true,
  schedule: true,
  // Where the configuration UI itself lives. Three seats exist: the General
  // row inside the bottom-left settings panel (settingsPage), the plugin
  // detail page (detailPage) and a dedicated sidebar tab (sidebarTab).
  // Per the user's standing requirement only the settings page is enabled
  // out of the box; the other two are opt-in. All three render the same
  // field set.
  settingsPage: true,
  detailPage: false,
  sidebarTab: false,
}
