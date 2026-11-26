# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v2: hub proxy layer

Implements [docs/DESIGN-v2.md](docs/DESIGN-v2.md). The hub graduates from a
YAML share to a proxy between the todo store / downstream platforms and the
harness. Everything is opt-in; with no hub configured the plugin behaves
exactly as in 0.1.0.

### Added

- **File-manager** (`GET/PUT /v1/files/todo-store`): the hub can host the
  todo store's JSON reads/writes with optimistic revision CAS. The plugin side
  selects it with `config.fileProxy: hub` — `lib/fileproxy.js` implements the
  same store interface (read/update/all/describe) with conflict retry. Fail
  fast when the hub is missing: a half-proxied setup would corrupt revision
  bookkeeping, so it refuses to start rather than silently falling back.
- **Request proxy** (`POST /v1/request`): REST executors may declare
  `executor.via: hub` so outbound HTTP goes through the hub, which enforces
  SSRF filtering (public addresses only), resolves `${secret:ALIAS}` from its
  own `secrets.json` (the plaintext token never enters the harness process),
  rate-limits per connector, and audits every call into the run log without
  recording header values.
- **Task-watcher** (`PUT/GET/DELETE /v1/watch/{connector}`): a connector with
  `watcher: hub` hands its interval to the hub's background watcher, which
  grabs a lease and POSTs the connector's callback URL when due. Local timers
  are suppressed for such connectors (double-trigger guard: `watcher: hub`
  requires `schedule.everyMinutes: 0`, enforced at parse time).
- Hub schema migrates in place (v1 → v2, new `files`/`watchers` tables), hub
  version 0.2.0; `--todo-store` and `--no-watcher` CLI flags.

### Tests

- Node: 153 passing (was 136; +17 for fileproxy/via/watcher).
- Hub: 63 passing (was 17; +46 for files/request/watcher/migration).

## [0.1.0] — 2026-11-25

First release. The plugin is usable end to end: define a connector in YAML, let
the agent validate and write it, then sync.

### Added

- **Connector platform.** One YAML file per downstream system, stored under
  `<DSH_HOME>/global-todo-connector/connectors/`. A connector declares the
  client identity (name, priority, project, default tags), the executor, and how
  remote fields map onto DSH's todo model.
- **Two executors.** `cmd` runs a shell command and reads its stdout; `rest`
  speaks plain HTTP. Both are template-driven, so tokens come from `${env:...}`
  rather than being committed to the file.
- **Bidirectional sync with per-connector direction** (`pull`, `push`, `both`)
  and an explicit conflict policy (`newer`, `remote`, `local`). Records created
  locally carry a `client:<name>` tag, which is what makes push safe: a todo
  without the tag is never sent anywhere.
- **State tracking** in `state/<connector>.json`: a remote id ↔ local id map
  plus watermarks, so a second sync does not duplicate anything. Losing the file
  degrades to a title-based reconnect, not to duplicated records.
- **Ten agent tools** (`dsh_connector_list`, `get`, `scaffold`, `validate`,
  `write`, `delete`, `sync`, `status`, `runs`, `hub`) so the harness can author
  and operate connectors without hand-editing files.
- **Local HTTP API** under `/api/global-todo-connector` (loopback only) for
  scripts and the experimental hub.
- **Optional hub** (`hub/`, Python + FastAPI + SQLite): a small server that
  lets several Harness instances share one connector set and share sync state
  through revisioned leases. Entirely optional — the plugin works without it.
- **Zero runtime dependencies.** Included YAML subset parser/serializer, JSON
  store with atomic writes and a cross-process lock, and a small HTTP client,
  all written against Node built-ins.
- Worked examples for TaskWarrior, Todoist, Feishu, DingTalk, and a local
  file sink.

### Safety notes baked into the design

- A newly written connector ships with `enabled: false`; nothing starts pushing
  because a file appeared on disk.
- Remote deletions are reported as `unlinked`, never applied as local deletes.
- Todos living in the inbox (unconfirmed captures) are never pushed.
- `dsh_global_todo`'s own gates (`listLimit`, quotas, review) are respected for
  agent-created records; the connector writes records with an agent actor and
  an external capture source rather than pretending to be the human.
