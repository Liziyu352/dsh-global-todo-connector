# Connector Hub（可选 / 实验性）

一个跑在局域网或本机的小服务，让**多台机器上的多个 DeepSeek Harness 实例共享同一组 Todo 连接器**：
连接器定义（YAML）、共享同步状态（cursor、映射表等）、运行记录，以及防止两边同时写的**租约**。

它是 `dsh-global-todo-connector` 的可选组件。不装它，插件照常单机工作（读取本机 `connectors/` 目录、状态写在本地）；
装了它，插件可以把它当作共享的「真相来源」，并靠租约避免两台机器同时跑同一个连接器把同一批 todo 重复写两遍。

从 **0.2.0** 起，hub 还多了三个可选的**代理层**（详见 §4.7–4.9，均为实验性、不开启也能用）：

| 能力 | 解决了什么 | 默认 |
| --- | --- | --- |
| **file-manager**（`/v1/files/*`） | 多实例共写同一个 `todos.json` 时，把「谁写、何时写」收口到 hub，避免文件锁在 NFS/SMB 上不可靠 | 关闭，需 `--todo-store` |
| **request 代理**（`POST /v1/request`） | 下游平台的 token 只放在 hub 一处；同时把 SSRF 和滥用挡在外面 | 开启，但无 token 时仍受来源限制 |
| **task-watcher**（`/v1/watch/*`） | 让 hub 按计划唤醒某个实例去同步，省掉每台机器各跑一个定时器 | 开启，可用 `--no-watcher` 关 |

> 定位说明：hub 存放**连接器定义和同步状态**，在 request 代理模式下**会**代表客户端发起外部请求（凭据从 hub 本地的
> `secrets.json` 读取，不入库）。它不解决冲突合并——它只提供「谁现在可以写」的原语，冲突策略由客户端决定。

---

## 1. 为什么需要它

单机使用插件时，状态都在本地，没有问题。一旦两台机器（比如台式机 + 笔记本）都要跑同一份连接器，会出现三类问题：

| 问题 | 没有 hub | 有 hub |
| --- | --- | --- |
| 连接器定义散落 | 每台机器各存一份 YAML，改一处要手动同步 | `PUT /v1/connectors/{name}` 一处更新，其余实例拉取 |
| 双写 | 两台机器同时跑，同一批 todo 被创建两次 | 写入前先取租约，同一连接器同时只有一台能写 |
| 状态漂移 | 各自记各自的 cursor / 映射，逐渐分叉 | 共享 `state`，配 `revision` 乐观锁防止覆盖 |

代价是一个需要自己运维的进程和一份 SQLite 文件。**只用一台机器的话不需要装它。**

---

## 2. 启动

### 2.1 本地 venv（推荐用于开发／单机）

在仓库根目录执行：

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r hub/requirements.txt

# 无 token：只接受本机（回环地址）请求
python -m hub.app --port 8765 --data ./data

# 有 token：任何来源都必须带 X-Hub-Token
export GTC_HUB_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m hub.app --host 0.0.0.0 --port 8765 --data ./data
```

也可以走 ASGI 入口（生产推荐，配合下面的 systemd 示例）：

```bash
python -m uvicorn hub.app:app --host 127.0.0.1 --port 8765
```

> 在 `hub/` 目录内运行时把入口换成 `python app.py …` 或 `uvicorn app:app`，两种写法都支持。

无论哪种方式起来，都应该能直接验活：

```bash
curl -s http://127.0.0.1:8765/health
# {"ok":true,"data":{"name":"dsh-global-todo-connector-hub","version":"0.2.0",...}}
```

### 2.2 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | 监听地址 |
| `--port` | `8765` | 监听端口 |
| `--data` | `$GTC_HUB_DATA` 或 `./data` | 数据目录，会自动创建，数据库为其中的 `hub.db` |
| `--token` | 无（读 `$GTC_HUB_TOKEN`） | 覆盖环境变量里的 token |
| `--todo-store` | 无（读 `$GTC_HUB_TODO_STORE`） | 共享 `todos.json` 的路径；给了才启用 `/v1/files/todo-store` |
| `--no-watcher` | 关闭 | 不启动 task-watcher 后台线程 |

优先级：`--token` > `$GTC_HUB_TOKEN`。两者都为空时进入「仅回环」模式。

`--todo-store` 指向的文件**不必预先存在**：读不到时按空文档 `{"version":2,"todos":[],"trash":[]}` 返回，
第一次 `PUT` 时才创建（父目录必须已存在且可写）。

### 2.3 systemd unit 示例

```ini
# /etc/systemd/system/dsh-connector-hub.service
[Unit]
Description=DSH Global Todo Connector Hub
After=network-online.target

[Service]
Type=simple
User=dsh
Group=dsh
WorkingDirectory=/srv/dsh-hub
Environment="GTC_HUB_TOKEN=请换成一串足够长的随机值"
Environment="GTC_HUB_DATA=/var/lib/dsh-hub"
# 建议绑 0.0.0.0 但用防火墙限制来源；只给本机用就保持 127.0.0.1
ExecStart=/srv/dsh-hub/.venv/bin/python -m uvicorn hub.app:app --host 0.0.0.0 --port 8765
Restart=on-failure
RestartSec=3

# 最小权限：数据库目录之外不需要任何写权限
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/dsh-hub

[Install]
WantedBy=multi-user.target
```

```bash
sudo install -d -o dsh -g dsh /var/lib/dsh-hub
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-connector-hub
curl -s http://127.0.0.1:8765/health
```

### 2.4 Docker

`hub/` 目录里已经带了 `Dockerfile` 与 `docker-compose.yml`：

```bash
cd hub
export GTC_HUB_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
docker compose up -d --build
curl -s http://127.0.0.1:8765/health
```

数据库在具名卷 `hub-data` 上，`docker compose down`（不加 `-v`）不会丢数据。
compose 默认只把端口发布到宿主机回环 `127.0.0.1:8765`；要让局域网访问，先确认你有 token 和私有网络，再改成 `"8765:8765"`。

容器默认开启 file-manager，把宿主机的 `./todos` 挂到 `/todos`，`GTC_HUB_TODO_STORE` 指向其中的 `todos.json`。
要禁用就 `GTC_HUB_TODO_STORE= docker compose up -d`；要换目录就 `GTC_HUB_TODOS_DIR=/srv/dsh/todos`。
**不要**把 `todos.json` 单文件挂进容器：hub 用 `temp+rename` 原子写，需要整个可写目录。

> 容器内启动的是 `python -m hub.app`，因此可以用 compose 的 `command:` 追加 `--no-watcher` 等参数。

---

## 3. 鉴权模型

两种模式，由 `GTC_HUB_TOKEN` 是否为空决定：

| 模式 | 判定 | 行为 |
| --- | --- | --- |
| **Token 模式**（推荐） | `GTC_HUB_TOKEN` 非空 | 除 `/health` 外所有 `/v1/*` 必须带 `X-Hub-Token: <token>`，用 `hmac.compare_digest` 做常数时间比较，不匹配返回 `401 unauthorized`。**带对 token 的请求不受来源限制**，这就是跨机器共享的用法。 |
| **仅本机模式** | `GTC_HUB_TOKEN` 为空 | 不校验 token，只接受回环来源（`127.0.0.0/8`、`::1`、`::ffff:127.*`），其他来源一律 `403 forbidden`（"hub 未设置 token，只接受本机请求"）。 |

`GET /health` **永远不需要鉴权**：它只暴露计数和版本，方便 systemd / 容器健康检查、也能在浏览器里直接看。

鉴权是一层薄薄的共享密钥，不是用户体系：所有客户端共用一个 token，无法区分是谁。**不要把它当成多租户方案。**

---

## 4. API

所有响应统一包络：

```jsonc
// 成功
{"ok": true, "data": { /* ... */ }}
// 失败
{"ok": false, "reason": "machine-readable-code", "error": "人类可读说明"}
```

状态码：`400` 请求格式错、`401` token 不对、`403` 来源不被允许、`404` 不存在、`409` 冲突（revision / 租约）、`413` 载荷过大、`422` 字段校验失败、`429` 代理请求限流、`500` 服务端错误、`502` 上游/代理失败。
所有时间都是 UTC ISO-8601（如 `2026-11-25T15:08:49.900049+00:00`）。

v1 的路由是连接器 / 租约 / 状态 / 运行记录（§4.2–4.6）；v2 新增文件代理、request 代理、task-watcher（§4.7–4.9）。

### 4.1 健康检查

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 返回 `{name, version, uptimeSeconds, connectors, activeLeases, now}` |

### 4.2 连接器

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/connectors` | 列表：`{connectors:[{name, revision, hash, owner, updatedAt}]}`（不含 YAML 正文） |
| `GET` | `/v1/connectors/{name}` | 详情：`{name, yaml, revision, hash, owner, updatedAt}`；不存在 `404 not-found` |
| `PUT` | `/v1/connectors/{name}` | body `{yaml, owner?, revision?}`，见下 |
| `DELETE` | `/v1/connectors/{name}?revision=N` | 删除；revision 不匹配 `409`，不存在 `404` |

`PUT` 的语义：

- 省略 `revision` → **强制覆盖**，服务端把 revision 自增（新建时从 1 开始）。
- 给了 `revision` → 乐观锁，与当前值不一致返回 `409 revision-conflict`（新建时当前值为 `0`，所以首次写入可以带 `revision: 0`）。
- `yaml` 必须非空（`422 invalid-yaml`）且不超过 1 MiB（`413 payload-too-large`）。
- `hash` = `sha256(yaml)` 的前 16 位十六进制，客户端用它判断「远端是否变了」而不用拉全文。
- 省略 `owner` 时保留原 owner；显式传（包括空串）则覆盖。

返回：`{name, revision, hash, updatedAt}`。

> **hub 只存 YAML 原文（字符串），不做解析。** 它不关心里面写了什么连接器、字段是否合法——校验、解析、合并语义全部由 DSH 插件侧负责。
> hub 的职责仅仅是一个共享仓库：原子地保管字节、维护 `revision`/`hash`、发租约、存状态和运行日志。

### 4.3 租约（防双写）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/leases` | body `{connector, instance, ttlSeconds?}`；成功 `201` |
| `POST` | `/v1/leases/{leaseId}/renew` | body `{ttlSeconds?}`；不存在/已过期 `404 lease-missing` |
| `DELETE` | `/v1/leases/{leaseId}` | 释放；**幂等**，不存在也返回 `200 {released:false}` |

- `ttlSeconds` 默认 `120`，会被夹到 `[15, 3600]`（超出范围不报错，只夹紧，避免旧客户端整体失败）。
- 同一 `instance` 对同一连接器重复申请 → **幂等复用同一个 `leaseId` 并续期**，返回 `201`。这能让「请求发出但响应丢了」的重试安全。
- 别的 instance 持有时返回 `409`，并附上持有者信息：

```jsonc
{
  "ok": false,
  "reason": "lease-held",
  "error": "连接器 'demo' 已被 'desktop' 占用",
  "holder": {"instance": "desktop", "leaseId": "…", "expiresAt": "…"}
}
```

- 过期租约由后续请求**惰性清理**：每次读/写租约都会先删掉过期行，所以不需要后台清理线程，也不会出现「过期了但一直被占」。

一个连接器同一时刻只有一个有效租约（数据库上是 `UNIQUE(connector)`，即使两个线程同时抢也只有一个能成功）。

### 4.4 共享状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/state/{connector}` | `{connector, revision, state, updatedAt}`；从未写过时 `revision=0, state=null` |
| `PUT` | `/v1/state/{connector}` | body `{state, revision?}`，乐观锁语义与连接器相同 |

`state` 可以是任意 JSON（对象、数组、标量、`null`）。`PUT` 时 `state` 字段**必须出现**（要清空就显式传 `null`），避免漏字段导致误清空。返回 `{connector, revision, updatedAt}`。

首次写入可以带 `revision: 0`；不给则强制覆盖。

### 4.5 运行记录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/runs` | body `{connector, run}`，`run` 为任意 JSON 对象且 ≤ 64 KiB；返回 `{id}` |
| `GET` | `/v1/runs?connector=<name>&limit=<n>` | 按 `id` 倒序返回 `{runs:[{id, connector, run, createdAt}]}` |

`limit` 默认 `20`，最大 `200`（超过返回 `422`）。省略 `connector` 则返回所有连接器的记录。

### 4.6 统计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/stats` | `{connectors, runs, leases, dbBytes}`，`dbBytes` 含 `-wal`/`-shm` 的实际占用 |

### 4.7 文件代理（file-manager，v2）

把 `todos.json` 的读写收口到 hub，供多实例共享。**需要启动时给 `--todo-store`**，否则整个 `/v1/files/*` 返回 `503 file-manager-disabled`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/files/todo-store` | `{name, revision, exists, doc, path, updatedAt}`；文件不存在时 `doc` 为空文档、`revision=0` |
| `PUT` | `/v1/files/todo-store` | body `{doc, revision}`；`revision` 必须等于当前值，否则 `409 revision-conflict` |

- 目前白名单只有 `todo-store`，其他名字一律 `404 not-found`（虚拟路径，不是任意文件读取）。
- `PUT` 的 `revision` 是**必填**，没有「强制覆盖」模式：文件代理的全部价值就是不让两个人同时写。冲突时响应带 `currentRevision`，客户端重新 `GET` 合并后再试。
- `doc.version` 必须 ≤ 2，`todos` 必须是数组，否则 `422 invalid-document`。写入前做**宽进严出**的修复：缺 `id`/`title` 的记录丢弃，重复 `id` 只留第一条，未知字段原样保留（与插件侧 `lib/store.js` 的 salvage 语义一致），避免老版本客户端写坏新字段。
- 落盘用 `tempfile` + `fsync` + `os.replace` 原子替换，文件权限沿用原文件的 mode；读取方永远看不到半个 JSON。
- 目标是**共享目录上的同一个文件**（NFS/SMB 也行），这样还没升级到 v2 的实例直读文件也能看到内容——「原版优先」，代理和不代理的实例可以共存。

### 4.8 request 代理（v2）

`POST /v1/request` 让 hub 代表客户端调下游平台，凭据只存在 hub 一侧。

```jsonc
// 请求
{
  "kind": "rest",                 // v2 只支持 "rest"
  "url": "https://api.todoist.com/rest/v2/tasks",
  "method": "GET",                // GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS
  "headers": {"Authorization": "${secret:TODOIST}"},
  "body": {"content": "买牛奶"},   // 对象 → JSON；字符串 → 原样发送
  "timeoutMs": 20000,             // 夹到 [1000, 120000]，默认 20000
  "success": [200, 201]           // 可选，判断 ok 的状态码集合，默认 2xx
}
// 响应
{"ok": true, "data": {"status": 200, "body": {...}, "durationMs": 143}}
```

- **SSRF 防护**：先解析主机名（`getaddrinfo`），逐个检查**所有**返回地址，任一是私网/回环/链路本地/CGNAT/保留地址就整体拒绝 `403 blocked-target`。IP 字面量同样检查，IPv4-mapped IPv6（`::ffff:127.0.0.1`）先拆壳再判断。只放行公网 http/https。
- **秘钥别名**：hub 数据目录下 `secrets.json`（`{"TODOIST": "Bearer xxx"}`，建议 `chmod 600`），headers 里的 `${secret:ALIAS}` 在发送前替换。别名不存在时替换为空串并在运行记录里留 warning，**不会**把别名当字面量发出去。secrets 每次请求重新读取，改完不用重启；权限过宽会打一条警告日志。
- **限流**：每个连接器每分钟 60 次（滑动窗口），超限 `429 rate-limited`。连接器名取自 `x-connector` 头，缺省 `default`。
- **响应上限 8 MiB**，超过 `502 response-too-large`；不跟随重定向（`3xx` 原样返回给调用方判断）。
- **审计**：每次调用都写一条 `POST /v1/runs`（`kind:"proxy-request"`），记录 `url`（**查询串被剥掉**，防止 token 落进日志）、`method`、`status`、`durationMs`、`ok`、`error`。**header 值一律不记**。

```bash
# secrets.json
install -m 600 /dev/null ./data/secrets.json
cat > ./data/secrets.json <<'EOF'
{"TODOIST": "Bearer 0123456789abcdef"}
EOF
```

### 4.9 任务唤醒（task-watcher，v2）

让 hub 按计划回调某个实例，由实例去跑同步。适合「机器常开但 DSH 不是常开」的拓扑，也避免每台机器各写一个 cron。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/watch/{connector}` | `{connector, watcher}`；没有订阅时 `watcher: null` |
| `PUT` | `/v1/watch/{connector}` | body `{everyMinutes, callbackUrl, instance}`，创建或覆盖 |
| `DELETE` | `/v1/watch/{connector}` | `{deleted: true/false}`，幂等 |

- `everyMinutes` 夹到 `[1, 1440]`；`callbackUrl` 必须是 http/https，**允许回环和内网**（实例就在那里；这与 §4.8 的公网限制不同）。
- 后台线程每 30 秒扫一次到期且 `enabled` 的订阅；到期后先 `POST /v1/leases` 抢租约（instance 记为 `watcher`，TTL = `everyMinutes*60` 上限 3600），**抢不到就跳过**——这样调度和实例自己的同步不会同时跑。
- 抢到后向 `callbackUrl` 发 `POST {"connector": "...", "trigger": "watcher", "at": "..."}`，带 `X-Hub-Token`（若 hub 启用了 token），超时 120 秒，**不重试**。成功后把 `nextRunAt` 推进一个周期；失败也只推进（避免坏地址导致每 30 秒死循环），并记 `watcher-skip`。
- 运行记录里能看到 `kind: "watcher-dispatch"` / `"watcher-skip"`。`--no-watcher` 关闭线程，但订阅数据仍保留。
- 回调由 hub 主动发出，所以 hub 必须能路由到实例地址；实例在 NAT 后面时用 Tailscale/WireGuard 地址，或干脆不用 watcher、由实例自己定时。

### 4.10 快速自测

```bash
TOKEN=... # 与启动时一致
curl -s localhost:8765/health | jq
curl -s -H "X-Hub-Token: $TOKEN" localhost:8765/v1/connectors | jq
curl -s -X PUT -H "X-Hub-Token: $TOKEN" -H 'content-type: application/json' \
     -d '{"yaml":"name: demo\n","owner":"laptop"}' \
     localhost:8765/v1/connectors/demo | jq

# v2：文件代理（需启动时带 --todo-store）
curl -s -H "X-Hub-Token: $TOKEN" localhost:8765/v1/files/todo-store | jq '.data.revision'
# v2：request 代理（回环地址会被 SSRF 拦住，这是预期行为）
curl -s -X POST -H "X-Hub-Token: $TOKEN" -H 'content-type: application/json' \
     -d '{"kind":"rest","url":"https://api.github.com/rate_limit"}' \
     localhost:8765/v1/request | jq '.data.status'
# v2：订阅一个唤醒任务
curl -s -X PUT -H "X-Hub-Token: $TOKEN" -H 'content-type: application/json' \
     -d '{"everyMinutes":30,"callbackUrl":"http://127.0.0.1:3080/sync","instance":"laptop"}' \
     localhost:8765/v1/watch/demo | jq
```

---

## 5. 数据落盘

- 目录由 `--data` 指定（默认 `$GTC_HUB_DATA` 或 `./data`），不存在会自动 `mkdir -p`。
- 数据库：`<data>/hub.db`，外加运行时产生的 `hub.db-wal`、`hub.db-shm`。
- **备份**：服务运行时直接 `sqlite3 hub.db ".backup /path/backup.db"` 最稳；或停服后拷 `hub.db`。
  只拷 `hub.db` 而漏掉 `-wal` 会丢最近的提交。
- 表结构用 `PRAGMA user_version` 记录版本（当前为 `2`）。v1 → v2 是**增量迁移**：打开旧库时自动补建 `files`、`watchers` 两张表，原有连接器/租约/状态/运行记录全部保留。打开一个版本比程序更新的库会**直接拒绝启动**，避免旧程序写坏新结构。
- **`<data>/secrets.json`**（可选）：request 代理的秘钥别名表，纯文本 JSON，权限请设 `600`。它不在数据库里，也不在 `GET /v1/*` 的任何响应中；备份时注意别把它混进公开的归档。
- **`todos.json`**（可选）：由 `--todo-store` 单独指定路径，**不放在 data 目录里**——它通常已经在某个共享目录上，被 DSH 插件直接读写。hub 只维护它的 `revision`（在 `files` 表里）和内容本身。
- 数据是「可重建的缓存 + 共享状态」的性质：连接器 YAML 的源头通常在 git 里，丢失 hub.db 不会丢 todo 本身，最多丢运行历史、同步 cursor 和 watcher 订阅。

---

## 6. 多设备拓扑

### 6.1 两台机器 → 一个 hub（推荐）

```
┌──────────────┐        ┌──────────────┐
│  笔记本      │        │   台式机     │
│  DSH + 插件  │        │  DSH + 插件  │
└──────┬───────┘        └──────┬───────┘
       │  HTTPS/HTTP + X-Hub-Token
       └───────────┬───────────┘
                   │   （WireGuard / Tailscale 私网）
            ┌──────▼───────┐
            │  Connector   │
            │     Hub      │   hub.db (SQLite, WAL)
            └──────────────┘
```

典型流程：

1. 一台常开的机器（或 NAS/小主机）跑 hub，设 `GTC_HUB_TOKEN`，绑在私网地址上。
2. 两台机器配置相同的 hub URL 和 token。
3. 每次同步前 `POST /v1/leases`；拿到租约的那台写 todo 并 `PUT /v1/state`；写完 `DELETE` 释放。
4. 没抢到租约的那台本轮跳过（或等下一轮），从而不会重复创建。

### 6.2 单机

不装 hub，插件用本地目录即可。也可以在本机 `127.0.0.1:8765` 跑一个，用于**多开 DSH 实例**之间共享状态——这是最省事、最安全的部署方式。

### 6.3 多 hub（不推荐）

多个 hub 之间**没有同步**。除非你能保证每个连接器只归属一个 hub，否则会出现两个「真相来源」。

---

## 7. 安全建议

- **默认不设 token = 只能本机访问**。跨机器用就**必须**设 token，且用 `python -c 'import secrets; print(secrets.token_urlsafe(32))'` 这类方式生成，不要用弱口令。
- **不要暴露到公网。** hub 只有共享密钥鉴权，没有 TLS、没有限流、没有审计。
- 跨机器时放在 **WireGuard / Tailscale / ZeroTier** 之类的私网里，或至少走 SSH 隧道：

  ```bash
  ssh -N -L 8765:127.0.0.1:8765 user@hub-host
  # 然后本机连 http://127.0.0.1:8765
  ```

- token 走环境变量或 systemd `Environment=`，不要写进 git。它等价于「能改所有连接器和状态」的权限。
- 数据库文件权限设为 `600`，目录 `700`（systemd 示例里由 `User=dsh` 保证隔离）。
- 反向代理（nginx/Caddy）终止 TLS 时，记得 hub 看到的来源会变成 `127.0.0.1`——此时**必须**启用 token 模式，否则回环放行会变成谁都能进。
- **request 代理把 hub 变成了一台「能访问公网的主机」**：拿到 token 的人可以借它探测外部世界。所以 token 的地位等同于「出网代理权限」。SSRF 只拦内网，不拦你不想让它访问的公网站点；真有需要就在防火墙上限制 hub 的出站目标。
- `secrets.json` 是明文（这是刻意的：它要能被 hub 读取才能替换），务必 `chmod 600` + 目录 `700`，且**不要**放到被 git 跟踪或被挂进容器的公开目录里。库里的 `runs` 记录刻意不存 header 值和 URL 查询串。
- task-watcher 会带 token 向 `callbackUrl` 发 POST。别把订阅指向不受信任的地址，否则等于把 token 交给对方。
- 文件代理虽然能防并发，但**不能**防止别的进程绕过 hub 直接改 `todos.json`。启用 file-manager 后，请让所有实例都走代理（`fileProxy: hub`），不要有的走代理、有的直写。

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `403 forbidden`，error 提到「只接受本机请求」 | 没设 `GTC_HUB_TOKEN`，且请求不是从回环来的。要么设 token，要么走 SSH 隧道。 |
| `401 unauthorized` | `X-Hub-Token` 缺失/不对。注意大小写不敏感的是头名，值必须完全一致。 |
| `409 revision-conflict` | 别人先写了。重新 `GET` 拿最新 `revision`，合并后再写。这是正常保护，不是 bug。 |
| `409 lease-held` | 另一台机器正持有租约。看返回里的 `holder.instance`/`expiresAt`；确认它真的挂了再等租约过期（最多 `ttlSeconds` 秒）。 |
| `404 lease-missing`（renew） | 租约已过期或被释放。重新 `POST /v1/leases` 拿新的。 |
| `413 payload-too-large` | YAML > 1 MiB 或 run > 64 KiB，或整个请求体 > 2 MiB。压缩/裁剪内容。 |
| `database is locked` | `busy_timeout` 是 5 秒；持续出现说明有长事务或另一个进程独占。检查是否有第二个 hub 指向同一个 `hub.db`（**不要这么做**，一个库只给一个 hub 进程）。 |
| 启动时报 `database schema version N is newer than this hub supports` | 你用旧版 hub 打开了新版建的库。升级 hub，或换一个新的 `--data` 目录。 |
| `/health` 正常但 `/v1/*` 全 403/401 | 鉴权生效了。先确认 token 模式再确认头。 |
| 数据「丢了」 | 很可能只备份了 `hub.db` 没带 `-wal`。见 §5。 |
| `Address already in use` | 端口被占：`ss -ltnp \| grep 8765`，换 `--port` 或停掉旧进程。 |
| `/v1/files/*` 返回 `503 file-manager-disabled` | 启动时没给 `--todo-store`（或 `$GTC_HUB_TODO_STORE`）。 |
| `/v1/files/*` 返回 `500 store-corrupt` | `todos.json` 不是合法 JSON，或 `version` 比 hub 支持的更新。hub **不会**自动重置文件——先人工修好或备份后移走。 |
| `/v1/request` 一直 `403 blocked-target` | 目标是回环/内网。这是 SSRF 防护，不是 bug；要访问内网服务请直接在实例侧调，别经过 hub。 |
| `/v1/request` 返回 `429 rate-limited` | 同一连接器一分钟超过 60 次。合并请求，或调大客户端的批量粒度。 |
| 代理请求 `502 upstream-error`，detail 提到 SOCKS/socksio | hub 主机的 `ALL_PROXY` 在劫持出网。hub 本身已用 `trust_env=False` 忽略这些变量，若仍出现说明请求走了别处；检查 `env | grep -i proxy`。 |
| watcher 从不触发 | `--no-watcher` 被打开了，或 `nextRunAt` 还没到（默认首次在一个周期之后）。`GET /v1/watch/{connector}` 看订阅状态；运行记录里找 `watcher-skip` 及原因。 |
| watcher 一直 `watcher-skip` 且 reason 是 `lease-held` | 某台实例正持有该连接器的租约，或上次的 `watcher` 租约还没过期（最长 3600 秒）。 |

日志直接看标准输出：systemd 用 `journalctl -u dsh-connector-hub -f`，Docker 用 `docker compose logs -f hub`，venv 直跑就在终端里。

---

## 9. 测试

```bash
pip install -r hub/requirements.txt httpx==0.28.1 pytest==8.3.4
python -m pytest hub/tests -q
```

测试用 `TestClient` + 临时目录，不会碰 `./data`，也**不出网**（代理相关用例用 `httpx.MockTransport`，DNS 用 monkeypatch 注入）。
当前共 62 个用例，覆盖：

- 鉴权两条分支（401/403/回环变体/带 token 的远程来源）；
- 连接器 CRUD、强制覆盖、revision 冲突、校验与体量上限；
- 租约获取/幂等续期/占用冲突/过期抢占/TTL 夹紧；
- 状态乐观锁、run 追加与查询、统计与健康检查；
- **v2**：文件代理往返与 CAS 冲突、salvage 修复与未知字段保留、文件不存在/损坏/未启用、v1→v2 库迁移；
- **v2**：SSRF 回环/私网/链路本地/十进制 IP/IPv4-mapped 全部拒绝、主机名解析全量校验、8 MiB 上限、秘钥别名替换与缺失告警、限流 429 与按连接器隔离、审计记录不含 header 值和查询串；
- **v2**：watcher 的增删查、参数校验、到期触发、租约被占跳过、回调失败记录、`nextRunAt` 推进、线程启停、以及不继承环境代理（`trust_env=False`）。
