> 这份文档回答一个问题：什么时候需要 hub，怎么启动它、怎么让插件连上它，以及「租约」到底管什么。

# Hub（可选）

hub 是仓库 `hub/` 目录里的一个小型 Python 服务（FastAPI + SQLite）。它的唯一职责是**在多台机器 / 多个 DSH 实例之间共享连接器定义、同步状态和运行历史**。

它是可选的。单机使用完全不需要它。

---

## 1. 什么时候需要

| 你的情况 | 需要 hub 吗 |
| --- | --- |
| 一台机器、一个 DSH 实例 | 不需要 |
| 一台机器、多个 DSH 实例（比如不同 profile），想共用同一批连接器 YAML | **值得**：省得手抄 YAML，还能共享运行历史 |
| 两台机器（台式机 + 笔记本），连接器定义想改一处生效两处 | **需要** |
| 两台机器都跑同一个连接器，不想让同一批待办被推两遍 | 需要（hub 提供租约原语，但见第 4 节的限制） |
| 只是想让**待办本身**在两台机器间同步 | **不需要 hub**。那是 dsh-global-todo 自己的 `sync.dir` 功能，与本插件无关 |

一句话判断：**要共享的是「怎么同步」（YAML），考虑 hub；要共享的是「同步什么」（todos.json），用上游的 `sync.dir`。**

hub 不存待办，也不发起任何外部请求。它不代理 GitHub / Todoist / 飞书的凭据，只是一个「保管 YAML 字节、发租约、存运行记录」的小服务。

---

## 2. 启动

完整说明在 [`hub/README.md`](../hub/README.md)（包括 systemd unit、Docker、备份、故障排查）。这里只给最短路径。

### 2.1 最小命令

```bash
cd /path/to/dsh-global-todo-connector

python3 -m venv .venv
. .venv/bin/activate
pip install -r hub/requirements.txt

# 不加 token：只接受回环地址的请求
python -m hub.app --host 127.0.0.1 --port 8765 --data ./data
```

验活：

```bash
curl -s http://127.0.0.1:8765/health | jq
# {"ok":true,"data":{"name":"dsh-global-todo-connector-hub","version":"0.1.0",...}}
```

### 2.2 跨机器使用时必须设 token

```bash
export GTC_HUB_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m hub.app --host 0.0.0.0 --port 8765 --data ./data
```

设了 token 之后，所有 `/v1/*` 请求都必须带 `X-Hub-Token` 头，值必须完全一致（头名大小写不敏感，值不是）。`/health` 永远不鉴权，方便探活。

**不要把 hub 暴露到公网。** 它没有 TLS、没有限流、没有审计，只有一个共享密钥。跨机器使用时放进 WireGuard / Tailscale / ZeroTier，或者走 SSH 隧道：

```bash
ssh -N -L 8765:127.0.0.1:8765 user@hub-host
# 本机照常连 http://127.0.0.1:8765
```

### 2.3 systemd / Docker 一句话

- **systemd**：把 `ExecStart` 写成 `/srv/dsh-hub/.venv/bin/python -m uvicorn hub.app:app --host 0.0.0.0 --port 8765`，`Environment="GTC_HUB_TOKEN=…"`、`Environment="GTC_HUB_DATA=/var/lib/dsh-hub"`，unit 文件全文见 [`hub/README.md` §2.3](../hub/README.md)。
- **Docker**：`cd hub && docker compose up -d --build`，数据库在具名卷 `hub-data` 上，`docker compose down` 不加 `-v` 不会丢数据。

数据只有一份 SQLite：`<data>/hub.db`（外加运行时的 `-wal` / `-shm`）。备份请用 `sqlite3 hub.db ".backup /path/backup.db"` 或停服后整目录拷——只拷 `hub.db` 漏掉 `-wal` 会丢最近的提交。

---

## 3. 插件侧怎么连

有两种方式，配置项优先于环境变量。

### 3.1 插件配置（推荐）

插件配置里的 `hub` 块：

```jsonc
{
  "hub": {
    "url": "http://127.0.0.1:8765",   // 必填；空字符串 = 不用 hub
    "token": "……",                    // 设了 token 的 hub 必填
    "instance": "laptop",             // 可选，用来标识「我是谁」
    "timeoutMs": 8000                 // 可选，默认 8000
  }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `hub.url` | 空 | hub 的地址。空表示不使用 hub，所有 hub 操作会明确报 `hub-unavailable` |
| `hub.token` | 空 | 对应 hub 的 `GTC_HUB_TOKEN`；为空时不发 `X-Hub-Token` 头（对端必须是回环模式） |
| `hub.instance` | `<hostname>/<pid>` | 标识实例身份。建议在多机部署时显式设成 `laptop` / `desktop` 这种名字，看租约和 revision 时更容易分辨 |
| `hub.timeoutMs` | `8000` | 单次 hub 请求超时 |

v2 新增插件配置项：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `config.fileProxy` | 空 | 设成 `hub` 时，todos.json 的读写改走 hub 的 file-manager（`lib/fileproxy.js`，revision CAS + 冲突重试）。**hub.url 未配置时插件直接拒绝构造（fail-fast）**——一半走代理一半走本地锁会弄坏 revision 记账，宁可报错也不静默回落。`dsh_connector_status` 的 `status.fileProxy` 字段显示当前模式 |

### 3.2 环境变量

不想把 URL / token 写进配置（比如用 systemd 注入）时：

```bash
export GTC_HUB_URL=http://127.0.0.1:8765
export GTC_HUB_TOKEN=……
```

优先级：`hub.url` > `GTC_HUB_URL`，`hub.token` > `GTC_HUB_TOKEN`。

### 3.3 验证连上了

```
dsh_connector_hub  action: status
```

返回：

```jsonc
{
  "ok": true,
  "action": "status",
  "result": {
    "status": {
      "url": "http://127.0.0.1:8765",
      "instance": "laptop",
      "health": { "name": "dsh-global-todo-connector-hub", "version": "0.1.0", "uptimeSeconds": 42, "connectors": 3, "activeLeases": 0 },
      "remote": [
        { "name": "taskwarrior", "revision": 4, "hash": "9f8e7d6c5b4a3210", "local": true }
      ],
      "local": ["taskwarrior", "todoist"]
    }
  }
}
```

`remote[].local` 告诉你「hub 上这个连接器本地有没有」，一眼看出两边差哪些。

---

## 4. 租约模型

### 4.1 hub 侧的语义

租约是 hub 提供的一个原语：**同一个 connector 在同一时刻只允许一个实例持有租约。**

| 项目 | 值 |
| --- | --- |
| 获取 | `POST /v1/leases`，body `{connector, instance, ttlSeconds?}` |
| 续期 | `POST /v1/leases/{leaseId}/renew`，body `{ttlSeconds?}` |
| 释放 | `DELETE /v1/leases/{leaseId}`（幂等，不存在也返回 200） |
| 默认 TTL | `120` 秒 |
| TTL 范围 | `[15, 3600]` 秒，超出范围会被**静默夹紧**（不报错，避免旧客户端整体失败） |
| 冲突 | 别的实例持有时返回 `409 lease-held`，附带 `holder` 信息 |
| 幂等 | 同一个 `instance` 对同一个 connector 重复申请 → 复用同一个 `leaseId` 并续期 |
| 过期 | 后续请求惰性清理，不需要后台线程 |

数据库层是 `UNIQUE(connector)`，所以即使两个请求同时抢，也只有一个能成功。

`409` 的响应体长这样：

```jsonc
{
  "ok": false,
  "reason": "lease-held",
  "error": "连接器 'demo' 已被 'desktop' 占用",
  "holder": { "instance": "desktop", "leaseId": "…", "expiresAt": "2026-11-25T15:30:00+00:00" }
}
```

### 4.2 ⚠️ 当前插件的 sync 路径并不申请租约

这是必须说清楚的一点：**插件的同步流程（`dsh_connector_sync`、定时器、boot 触发）不会调用 `POST /v1/leases`。** hub 客户端里确实封装了 `acquireLease` / `renewLease` / `releaseLease`，hub 服务端也完整实现了这套 API 并在测试里覆盖，但当前的同步代码路径没有接入它。

实际后果：**两台机器配置同一个连接器同时跑 push，仍然可能把同一批待办各推一次。** hub 目前共享的是「连接器定义 + 运行历史」，不是「同一时刻只有一个人能写」。

如果你需要防止双写，现阶段可行的做法是：

1. **错开调度**：给不同机器的同一个连接器设不同的 `schedule.everyMinutes`，把时间窗拉远；
2. **只在一台机器上启用**：其余机器把对应连接器的 `enabled` 设为 `false`（它们仍能用 `dsh_connector_sync` 手动跑）；
3. 让下游对重复创建免疫——比如 `update` 动作走带 `remoteId` 的幂等更新，而不是每次 `push` 新建。

### 4.3 直接调租约 API

租约 API 是完整的、可直接用的。脚本里这样写：

```bash
TOKEN=…   # hub 设了 GTC_HUB_TOKEN 时的值
HUB=http://127.0.0.1:8765

# 申请（同一 instance 重复调用是幂等的，会续期）
curl -s -X POST "$HUB/v1/leases" \
  -H "X-Hub-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"connector":"taskwarrior","instance":"laptop","ttlSeconds":120}' | jq
# {"ok":true,"data":{"leaseId":"…","connector":"taskwarrior","instance":"laptop","expiresAt":"…"}}

# 续期
curl -s -X POST "$HUB/v1/leases/<leaseId>/renew" \
  -H "X-Hub-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"ttlSeconds":120}' | jq

# 释放（幂等）
curl -s -X DELETE "$HUB/v1/leases/<leaseId>" -H "X-Hub-Token: $TOKEN" | jq
```

也可以用插件暴露的 HTTP 接口，但它只暴露了 `hub/pull`、`hub/push`、`hub/runs`，没有租约入口——租约请直接对 hub 说话。

---

## 5. `dsh_connector_hub` 工具

一个工具，四个 action。

| action | 做什么 | 参数 |
| --- | --- | --- |
| `status` | 看 hub 健康 + 连接器清单对比 | — |
| `pull` | 把 hub 上的连接器定义拉到本地 `connectors/` | `names?`、`force?` |
| `push` | 把本地 `connectors/*.yaml` 推上 hub | `names?`、`force?` |
| `runs` | 看 hub 上的共享运行历史 | `names?`（只取第一个作为过滤器）、`limit?` |

### 5.1 `status`

返回 `{url, instance, health, remote[], local[]}`，见 3.3。`remote` 里每项带 `local: true|false`。

### 5.2 `pull`

```jsonc
{ "action": "pull", "names": ["taskwarrior"] }
```

行为：

- 不写 `names` → 拉 hub 上的**全部**连接器；
- 拉到每份 YAML 先**本地解析校验一遍**，hub 上存的是裸字节，坏了会在写盘前被挡住；
- 本地已有同名文件时**跳过**，除非 `force: true`；
- 返回 `{written: [{name, revision, hash}], skipped: [{name, reason}]}`。

```jsonc
{ "ok": true, "action": "pull", "result": { "pulled": { "written": [{ "name": "taskwarrior", "revision": 4, "hash": "9f8e…" }], "skipped": [] } } }
```

`skip` 的典型原因：`本地已有同名连接器（force 可覆盖）`。

### 5.3 `push`

```jsonc
{ "action": "push", "names": ["taskwarrior"] }
```

行为：

- 不写 `names` → 推本地全部；
- 先 `GET` 拿当前 `revision`，再带 `revision` 去 `PUT`（乐观锁）；别人在这中间改过就报 `409 revision-conflict`；
- `force: true` → 不带 `revision`，强制覆盖，revision 自增；
- 返回 `{pushed: [{name, revision, hash}]}`。

hub 上的 `hash` 是 `sha256(yaml)` 的前 16 位，用来判断「远端是否变过」而不用拉全文。

### 5.4 `runs`

```jsonc
{ "action": "runs", "names": ["taskwarrior"], "limit": 20 }
```

返回 hub 上保存的运行记录，`limit` 默认 20、取值 1–100（工具层夹紧），hub 服务端本身接受 1–200。**`names` 只取第一个**当 `connector` 过滤器；想看全部就别传 `names`。

本机每次 sync 结束后会自动把报告镜像到 hub（`addRun`）；镜像失败只 warn，不影响同步本身。所以本地 `runs.jsonl` 是权威的、hub 上的是副本。

想只看本地历史用 `dsh_connector_runs`；想看跨机器的用 `dsh_connector_hub { action: "runs" }` 或 `dsh_connector_runs { fromHub: true }`。

---

## 6. hub 存了什么、没存什么

| 内容 | hub 存 | 说明 |
| --- | --- | --- |
| 连接器 YAML 原文 | ✅ | 只存字符串，不解析。校验/合并全在插件侧 |
| `revision` / `hash` / `owner` / `updatedAt` | ✅ | 乐观锁与「远端变了吗」的判断依据 |
| 租约 | ✅ | 见第 4 节 |
| 共享状态（`/v1/state/{connector}`） | ✅ | 任意 JSON，带 revision 乐观锁。**当前插件不读写它**——同步水位线仍只存本地 `state/<name>.state.json` |
| 运行记录（`/v1/runs`） | ✅ | 每次 sync 一条，≤64 KiB |
| files 表（v2） | ✅ | `todo-store` 的 revision 与 mtime；文档本体在 `--todo-store` 指向的文件里，hub 只记账 |
| watchers 表（v2） | ✅ | 每连接器的 `everyMinutes`/`callbackUrl`/`instance`/`next_run_at` |
| **待办本身（todos.json）** | ⚠️ v2 起 hub 可代管 | 见第 6.5 节；默认仍是"永远只在本地" |
| 任何外部系统的凭据 | ❌（v1）/ ⚠️（v2 secrets.json） | v2 的 `${secret:ALIAS}` 明文存在 hub 的 `secrets.json`（0600），插件进程只见别名 |
| 冲突合并逻辑 | ❌ | hub 只提供原语，策略在客户端 |

hub 的数据是「可重建的缓存 + 共享状态」：连接器 YAML 的源头通常在 git 里，丢了 `hub.db` 不会丢待办本身，最多丢运行历史和 revision 记录。

### 6.5 v2 的三个代理能力

v2 起 hub 可以站进数据链路（全部显式 opt-in，默认行为与 v1 相同）：

| 能力 | API | 插件侧开关 | 说明 |
| --- | --- | --- | --- |
| file-manager | `GET/PUT /v1/files/todo-store` | 插件配置 `config.fileProxy: hub` | todos.json 读写经 hub，revision CAS 防多实例踩踏；插件侧 `lib/fileproxy.js` 与本地 store 同接口；hub 不可达时 **fail-fast**，不静默回落 |
| request 代理 | `POST /v1/request` | 连接器 `executor.via: hub` | REST 出站经 hub：SSRF 过滤（只放行公网地址）、`${secret:ALIAS}` 在 hub 的 `secrets.json` 解析、每连接器 60 次/分钟限流、审计进 runs（不记 header 值） |
| task-watcher | `PUT/GET/DELETE /v1/watch/{connector}` | 连接器 `watcher: hub` | hub 后台每 30s 扫到期 watcher → 抢租约（instance=`watcher`）→ POST callback（带 `x-hub-token`）。插件侧不再设本地定时器，且解析期强制 `everyMinutes: 0` 防双重触发 |

安全注意：`--todo-store` 让 hub 拿到 todos.json 的写权，`secrets.json` 让 hub 拿到下游凭据——**hub 从「旁边」变成「链路上」后，它的机器账号权限要按能改你全部待办、读你全部下游 token 来对待**。单机自用跑回环没问题；跨机部署务必设 token + SSH 隧道。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `hub-unavailable`，error 是「没有配置 hub：请在插件配置里设置 hub.url，或设置 GTC_HUB_URL 环境变量」 | 没配 hub。配 `hub.url` 或设环境变量 |
| `hub-unavailable`，error 提到超时 | hub 没起、地址写错、或被防火墙挡住。先 `curl <url>/health` |
| `hub-unavailable`，error 说「返回的不是 JSON」 | URL 指到了别的东西（比如 DSH 自己的 3080 端口） |
| `401 unauthorized` | `X-Hub-Token` 缺失或不对。注意值区分大小写 |
| `403 forbidden`，「只接受本机请求」 | hub 没设 token，而请求来自非回环地址。设 token，或走 SSH 隧道 |
| `409 revision-conflict` | 别人先写了。重新 `pull` 拿最新的再改，或用 `force: true` |
| `409 lease-held` | 别的实例持着租约。看 `holder.instance` / `expiresAt`，等它过期 |
| `404 lease-missing`（renew 时） | 租约已过期或被释放，重新 `POST /v1/leases` |
| `database schema version N is newer than this hub supports` | 用旧版 hub 打开了新版建的库。升级 hub，或换一个 `--data` 目录 |
| 数据「丢了」 | 备份时只拷了 `hub.db` 没带 `-wal`。见第 2 节 |

---

## 8. hub 与上游的 `sync.dir` 是两件事

很容易搞混，对比一下：

| | 本插件的 hub | dsh-global-todo 的 `sync.dir` |
| --- | --- | --- |
| 共享什么 | 连接器 YAML、状态、运行记录 | `todos.json` 里的待办本身 |
| 谁实现 | 本仓库 `hub/` | 上游插件 |
| 需要额外进程 | 是（Python） | 否（共享目录即可） |
| 解决什么问题 | 「两台机器用同一份同步规则」 | 「两台机器看同一份待办」 |

两者可以同时用：`sync.dir` 让待办在多机之间一致，hub 让连接器定义在多机之间一致。**但注意**：如果两台机器的待办已经通过 `sync.dir` 完全同步，那么两台机器各自跑同一个连接器 pull 会得到相同结果——幂等，无害；而 push 则可能重复（见 4.2），通常只让一台机器 `enabled: true` 更简单。

---

## 9. 参考

- [`hub/README.md`](../hub/README.md)：hub 的完整文档（启动参数、systemd、Docker、API 细节、备份、故障排查、测试）
- [CONNECTORS.md](CONNECTORS.md)：连接器 YAML 参考
- [ARCHITECTURE.md](ARCHITECTURE.md)：整体设计与安全模型
- [DESIGN-v2.md](DESIGN-v2.md)：v2 代理层的设计定稿与依据
