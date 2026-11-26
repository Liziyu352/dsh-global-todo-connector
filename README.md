> 这份文档回答一个问题：这个插件是什么、能解决什么、怎么在十分钟内跑通第一个连接器。

# dsh-global-todo-connector

**把 DeepSeek Harness 的全局待办接到外部待办系统——用一份 YAML 声明，不需要 Agent 轮询。**

飞书、钉钉、TaskWarrior、Todoist、你自己写的 REST API，都能接。写一个文件，剩下的事插件自己按时间表做。

![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-339933)
![DSH](https://img.shields.io/badge/DSH-0.2.x-4B32C3)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## 它解决什么问题

`dsh-global-todo` 把待办放在一个 JSON 文件里，人和 Agent 读写同一份。但那个文件只在这台机器上——你真正干活的地方可能是 TaskWarrior 的命令行、团队共用的飞书任务表、或者公司的钉钉待办。

没有这个插件时，只有两种做法：

| 做法 | 问题 |
| --- | --- |
| 让 Agent 每次会话都去查一遍外部系统 | 每次都要烧 token、每次都要人提醒、会话一关就断 |
| 手动把待办抄过去 | 抄一次两次可以，抄到第三周就没人抄了 |

这个插件把「同步」从**对话里的一件事**变成**配置里的一件事**：连接器写好之后，定时器自己跑，pull 把远端的拉下来，push 把本地改过的推上去。Agent 只在你要改连接器、或者要看某次同步结果的时候才需要参与。

它做的事很窄：**搬运和翻译**。不替你做决定，不替你删东西，不替你合并冲突（只按你写的策略选一边，然后把分歧记进报告）。

---

## 快速开始

### 第 0 步：确认前提

- DSH 已经装好并能跑起来（`dsh web`）；
- 已经装了 [`dsh-global-todo`](https://github.com/LUgABeEEE/dsh-global-todo)（本插件强依赖它，没装的话插件不会启动，只在日志里留一条 warning）。

```bash
ls ~/.dsh/global-todo/todos.json     # 上游的存储文件
ls ~/.dsh/profiles                   # 你有哪些 profile
```

### 第 1 步：安装

插件装进**某个 profile**，不是装进整台机器。把下面的 `<profile>` 换成上一步 `ls` 出来的那个（本机常见是 `web`）：

```bash
# 从本地检出装（当前推荐：包还没发布到 npm）
dsh plugin --profile <profile> add /绝对路径/dsh-global-todo-connector

# 发布之后也可以从 npm 装（包名与仓库同名）
dsh plugin --profile <profile> add dsh-global-todo-connector
```

装完**必须重启宿主**（重新跑一次 `dsh web`），再刷新页面。插件是宿主组合里的一行 Loader，不是热加载脚本。

重启后确认工具在：

```
dsh_connector_status
```

它应该返回待办存储的路径、连接器目录、已排定的定时任务。如果这个工具根本不存在，说明 profile 装错了或者宿主没重启。

### 第 2 步：写第一个连接器

先用不依赖任何外部服务的那一个——它把待办追加进一个本地文件，用来证明整条链路是通的。

```
dsh_connector_scaffold  name: notes  kind: cmd  direction: push
```

拿到骨架之后改成下面这样，再用 `dsh_connector_write` 保存（[`examples/notes.yaml`](examples/notes.yaml) 是同一份的完整版，多了 `description`、`tags` 和 `updatedAt`）：

```yaml
version: 1

connector:
  name: notes
  label: 本地笔记
  enabled: false
  direction: push
  conflict: local
  schedule:
    everyMinutes: 0
  limits:
    maxPush: 200

client:
  name: notes
  executor:
    kind: cmd
    push:
      run: cat >> "${env:HOME}/.dsh/global-todo-connector/notes-log.json"
      timeoutMs: 5000
      stdin: batch

mapping:
  push:
    id: "${remoteId}"
    title: "${todo.title}"
    status: "${todo.status}"
    priority: "${todo.priority}"
```

> `enabled: false` 是刻意的。第一个连接器先手动跑，看清楚它到底会动什么，再交给定时器。

### 第 3 步：跑一次

```
dsh_connector_validate  yaml: <上面这段文本>
dsh_connector_sync      name: notes  dryRun: true
dsh_connector_sync      name: notes
```

`validate` 通过时返回 `{"ok": true, "valid": true, ...}`；不通过时 **`ok` 仍然是 `true`**，要看 `valid: false` 和 `field`（这是有意的设计——工具调用本身成功了，只是文件不合法）。

`dryRun: true` 只跳过写盘：`pull` 的命令/请求**照样会执行**（会真的去读远端），`push` 完全不发。它适合看「这次会推几条」，不适合当成无副作用的预演。

### 第 4 步：看结果

```
dsh_connector_runs  name: notes  limit: 5
```

或者直接看文件：

```bash
cat ~/.dsh/global-todo-connector/notes-log.json
tail -5 ~/.dsh/global-todo-connector/runs.jsonl
```

`notes-log.json` 里每行是一个 JSON 数组——每次 push 追加一批。看到它们，说明映射、执行器、水位线全部正常（`notes` 是 push-only，没有 pull 阶段）。

### 第 5 步：启用并换成真实系统

把 `enabled` 改成 `true`，设定 `schedule.everyMinutes`，用 `dsh_connector_write` 覆盖保存。然后从 `examples/` 里挑一个接近的作为起点：

| 文件 | 方向 | 执行器 | 说明 |
| --- | --- | --- | --- |
| [`examples/taskwarrior.yaml`](examples/taskwarrior.yaml) | both | cmd | TaskWarrior 双向：`task export` / `task import -` |
| [`examples/todoist.yaml`](examples/todoist.yaml) | both | rest | Todoist 双向，REST + token |
| [`examples/feishu.yaml`](examples/feishu.yaml) | pull | cmd | 飞书任务表，走现成 CLI |
| [`examples/dingtalk.yaml`](examples/dingtalk.yaml) | pull | rest | 钉钉待办，POST + 分页参数 |
| [`examples/notes.yaml`](examples/notes.yaml) | push | cmd | 本地文件，零依赖 |

外部的 token 一律用 `${env:NAME}` 从环境变量取，别写进 YAML——那文件是要提交进 git 的。

---

## 三层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  ① DSH 插件本体（本仓库 lib/）                                        │
│                                                                     │
│     connectors/*.yaml  ──▶  映射 + 冲突策略  ──▶  定时器 / 手动工具    │
│           │                        │                    │            │
│           │                        ▼                    ▼            │
│           │              ~/.dsh/global-todo/todos.json（带锁直接读写）│
│           │                                                 │        │
│     10 个 dsh_connector_* 工具 + /api/global-todo-connector 路由      │
└───────────┬─────────────────────────────────────┬───────────────────┘
            │ 可选：共享 YAML / 运行历史             │ pull / push
            ▼                                     ▼
┌───────────────────────────────┐   ┌─────────────────────────────────┐
│  ② 可选 hub（hub/，Python）    │   │  ③ 下游 Client 执行器            │
│                               │   │                                 │
│   共享连接器 YAML              │   │  cmd  ──▶ shell 命令，读 stdout  │
│   revision 乐观锁              │   │          TaskWarrior / lark-cli  │
│   租约原语                     │   │          / 自写脚本 / todo.txt    │
│   共享运行历史                 │   │                                 │
│                               │   │  rest ──▶ 一个 HTTP 请求         │
│   不存待办、不代理凭据          │   │          Todoist / 钉钉 / 飞书   │
│   不发起外部请求               │   │          / 自建服务              │
└───────────────────────────────┘   └─────────────────────────────────┘
```

hub 在**旁边**，不在数据链路里：todos.json 和外部系统之间的搬运完全不经过它，它只负责把「怎么同步」这份 YAML 分发给多台机器，以及收集运行历史。

第一层是必需的，另外两层按需：单机不需要 hub；执行器只要 `cmd` 和 `rest` 两种，能覆盖「有 CLI 的」和「有 API 的」两类系统。

垂直方向的数据流只有一条：**远端记录 → 映射 → 本地待办 → 映射 → 远端记录**。中间没有队列、没有中间库、没有额外进程。

---

## 与 dsh-global-todo 的关系

| | |
| --- | --- |
| **强依赖** | 没有上游就不启动。启动时探测 Loader 条目或 `~/.dsh/global-todo/todos.json`，都没有就放弃并打 warning |
| **只读写它的 JSON 存储** | 直接操作 `todos.json`（schema version 2），遵守它的原子写和 `todos.json.lock` 跨进程锁约定 |
| **不改它的 HTTP 路由** | 不使用、也不修改 `/api/global-todo/*`。为什么不走 HTTP，见 [ARCHITECTURE.md](docs/ARCHITECTURE.md#2-为什么不调-dsh-global-todo-的-http-api) |
| **不碰它的界面** | 没有 UI 注入。同步结果通过工具输出、`runs.jsonl` 和 HTTP 接口暴露 |
| **待办的多机同步不归它管** | 那是上游自己的 `sync.dir` 功能；本插件的 hub 只共享连接器定义 |

用一个比喻：上游管**清单**，本插件管**清单和外部世界之间的搬运**。两者的存储是同一个文件，所以 `todos.json` 是唯一的真相来源。

---

## 工具清单

全部在 `dsh_connector_*` 命名空间下。加载插件后自动注册，Agent 直接调用。

| 工具 | 做什么 |
| --- | --- |
| `dsh_connector_list` | 列出本机所有连接器：方向、执行器、启用状态、定时周期。`verbose: true` 附带完整 YAML |
| `dsh_connector_get` | 读一个连接器的 YAML 原文 + 解析摘要。改之前先读，避免覆盖别人的改动 |
| `dsh_connector_scaffold` | 生成一个一定能通过校验的 YAML 起点（**停用**状态）。不知道字段名时先要骨架 |
| `dsh_connector_validate` | 校验 YAML，返回 `{ok, valid, field?, connector?}`。失败时 `ok` 仍为 `true`，看 `valid` |
| `dsh_connector_write` | 保存连接器。先校验，不过就拒绝写入——不会留下坏文件让定时器半夜炸 |
| `dsh_connector_delete` | 删除连接器定义。只删定义，已同步的待办仍带 `client:<名字>` 标签 |
| `dsh_connector_sync` | 立刻跑一次。返回报告：新建/更新/冲突/推出/unlinked 各多少条 |
| `dsh_connector_status` | 平台健康：存储文件、连接器目录、定时任务、hub 配置。`probeHub: true` 会真的连一次 hub |
| `dsh_connector_runs` | 最近的运行记录。`fromHub: true` 读 hub 上的共享历史 |
| `dsh_connector_hub` | hub 操作：`status` / `pull` / `push` / `runs` |

推荐的改法永远是：**`scaffold` → 编辑 → `validate` → `write`**。不要手写文件后直接指望它能加载，校验器会告诉你差哪个字段。

### 也可以走 HTTP

插件同时注册了一组本地路由（`/api/global-todo-connector/*`），方便脚本和 cron 调用。它们只接受本机请求（回环地址 + 非跨站 + Host 校验），不需要凭据：

```bash
curl -s http://127.0.0.1:3080/api/global-todo-connector/status | jq
curl -s -X POST http://127.0.0.1:3080/api/global-todo-connector/sync \
  -H 'content-type: application/json' \
  -d '{"name":"notes"}' | jq
```

---

## 文档

| 文档 | 回答什么问题 |
| --- | --- |
| [docs/CONNECTORS.md](docs/CONNECTORS.md) | YAML 里每个字段是什么意思、写错了报什么错、有哪些完整示例 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 为什么不走 HTTP、一次同步的内部时序、幂等和冲突怎么实现、安全模型 |
| [docs/HUB.md](docs/HUB.md) | 什么时候需要 hub、怎么启动和连接、租约到底管什么 |
| [hub/README.md](hub/README.md) | hub 服务的完整文档：启动参数、systemd、Docker、API、备份、排错 |

想先看代码：`lib/connector.js` 是 YAML 的权威 schema，`lib/engine.js` 是同步语义，`lib/runner.js` 是执行器。

---

## 开发

```bash
npm test                 # 135 个单元测试（连接器、引擎、路由、存储、YAML…）
npm run test:hub         # hub 的 pytest
```

插件需要 Node `>=22.19.0`、DSH `>=0.2.3 <0.3.0`，peer 依赖 `dsh-global-todo >=0.23.0 <0.24.0`。

---

## License

MIT © [liziyu352](https://github.com/Liziyu352)
