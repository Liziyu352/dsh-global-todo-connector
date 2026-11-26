# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
