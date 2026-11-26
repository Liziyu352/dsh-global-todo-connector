# Connector Hub（可选 / 实验性）

一个跑在局域网或本机的小服务，让**多台机器上的多个 DeepSeek Harness 实例共享同一组 Todo 连接器**：
连接器定义（YAML）、共享同步状态（cursor、映射表等）、运行记录，以及防止两边同时写的**租约**。

它是 `dsh-global-todo-connector` 的可选组件。不装它，插件照常单机工作（读取本机 `connectors/` 目录、状态写在本地）；
装了它，插件可以把它当作共享的「真相来源」，并靠租约避免两台机器同时跑同一个连接器把同一批 todo 重复写两遍。

> 定位说明：hub 只存放**连接器定义和同步状态**，不代管任何 GitHub / npm / Todo 的凭据，也不发起外部请求。
> 它不解决冲突合并——它只提供「谁现在可以写」的原语，冲突策略由客户端决定。

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
# {"ok":true,"data":{"name":"dsh-global-todo-connector-hub","version":"0.1.0",...}}
```

### 2.2 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | 监听地址 |
| `--port` | `8765` | 监听端口 |
| `--data` | `$GTC_HUB_DATA` 或 `./data` | 数据目录，会自动创建，数据库为其中的 `hub.db` |
| `--token` | 无（读 `$GTC_HUB_TOKEN`） | 覆盖环境变量里的 token |

优先级：`--token` > `$GTC_HUB_TOKEN`。两者都为空时进入「仅回环」模式。

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

状态码：`400` 请求格式错、`401` token 不对、`403` 来源不被允许、`404` 不存在、`409` 冲突（revision / 租约）、`413` 载荷过大、`422` 字段校验失败、`500` 服务端错误。
所有时间都是 UTC ISO-8601（如 `2026-11-25T15:08:49.900049+00:00`）。

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

### 4.7 快速自测

```bash
TOKEN=... # 与启动时一致
curl -s localhost:8765/health | jq
curl -s -H "X-Hub-Token: $TOKEN" localhost:8765/v1/connectors | jq
curl -s -X PUT -H "X-Hub-Token: $TOKEN" -H 'content-type: application/json' \
     -d '{"yaml":"name: demo\n","owner":"laptop"}' \
     localhost:8765/v1/connectors/demo | jq
```

---

## 5. 数据落盘

- 目录由 `--data` 指定（默认 `$GTC_HUB_DATA` 或 `./data`），不存在会自动 `mkdir -p`。
- 只有一个数据库：`<data>/hub.db`，外加运行时产生的 `hub.db-wal`、`hub.db-shm`。
- **备份**：服务运行时直接 `sqlite3 hub.db ".backup /path/backup.db"` 最稳；或停服后拷 `hub.db`。
  只拷 `hub.db` 而漏掉 `-wal` 会丢最近的提交。
- 表结构用 `PRAGMA user_version` 记录版本（当前为 `1`）。打开一个版本比程序更新的库会**直接拒绝启动**，避免旧程序写坏新结构。
- 数据是「可重建的缓存 + 共享状态」的性质：连接器 YAML 的源头通常在 git 里，丢失 hub.db 不会丢 todo 本身，最多丢运行历史和同步 cursor。

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

日志直接看标准输出：systemd 用 `journalctl -u dsh-connector-hub -f`，Docker 用 `docker compose logs -f hub`，venv 直跑就在终端里。

---

## 9. 测试

```bash
pip install -r hub/requirements.txt httpx==0.28.1 pytest==8.3.4
python -m pytest hub/tests -q
```

测试用 `TestClient` + 临时目录，不会碰 `./data`。覆盖鉴权两条分支、连接器 CRUD 与 revision 冲突、租约获取/幂等续期/占用冲突/过期抢占、状态乐观锁、run 追加与查询、统计与健康检查。
