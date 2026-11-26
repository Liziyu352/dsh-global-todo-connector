# v2 设计方案：Hub 作为 Todo 系统与 Harness 之间的代理层

> 状态：**v2 设计定稿（依据用户提供的 mermaid 架构图扩写）**。本文是任务③的设计部分；实现按 §6 的次序推进。v1（已发布 0.1.0）是"连接器直控"形态；v2 引入 hub 代理层，把「谁来读写 todos.json」「谁去调下游平台」拆成两层。

## 0. 用户 mermaid 图 → 本文的翻译

用户的图（要点照录，作为最高优先级约束）：

- 原插件 `todo-plugin`（即 dsh-global-todo）与 connector 层**并列**暴露给 LLM；
- JSON 共享位置是**原插件的**（connector 不另立存储）；
- transmission 传输层是**原插件共享锁实现**；
- cnt-plugin（connector 插件）**方法 1 = 直读写 JSON（现状）**、**方法 2 = 经 file-manager 代理（实验性、推荐方向）**；
- 下游平台（TaskWarrior/飞书/钉钉…）**方法 1 = connector 直控（现状）**、**方法 2 = 经 hub request 代理**；
- task-watcher 定时任务是 **Hub 独有**；
- GUI 在 connector 层；人类可经 **hub cli** 或 connector 的 dsh 配置页面操作。

两条铁律（用户明说）：**原版优先**——上游 dsh-global-todo 的存储、锁、路由、GUI 一律不动；多出来的职责合并进 connector 层与 hub，不反向侵入上游。**可调整但不推翻**。

## 1. v1 现状与 v2 的差距

| 职责 | v1 现状 | v2 目标 |
| --- | --- | --- |
| 读 todos.json | connector 直接读写（带文件锁） | 默认仍直读写；**可选**经 hub 的 file-manager 代理 |
| 调下游平台 | connector 的 cmd/rest 执行器在本机直跑 | 默认仍直控；**可选**经 hub 的 request 代理转发 |
| 定时调度 | connector 进程内 setTimeout（`schedule.everyMinutes`） | 仍保留；hub 侧 task-watcher 承担**跨实例唯一调度** |
| 多实例 | 每个实例独立同步，靠锁防交错 | hub 租约（已有 `/v1/leases`）+ watcher 保证同一连接器同一时刻只有一个实例在跑 |
| hub | 可选的 YAML 配置共享（connectors/state/runs） | 升级为代理层：+ file-manager、+ request、+ task-watcher |

设计原则：**两种方法并存，方法 2 全部是显式 opt-in**。不配置 hub = 完整的 v1 行为，零回归。

## 2. 总体拓扑（v2）

```
┌──────────────────────────── DeepSeek Harness（每台机器一个）───────────────────────────┐
│                                                                                      │
│  ┌──────────────────┐        ┌──────────────────────────────────────────────────┐    │
│  │ dsh-global-todo  │        │ dsh-global-todo-connector（cnt-plugin）            │    │
│  │ （原版，不动）     │        │                                                  │    │
│  │  todos.json      │◀──A────┤  A: 本地读写（方法1，默认）：文件锁直读写            │    │
│  │  /api/*  GUI     │        │  B: 经 hub file-manager 代理（方法2，实验性）       │    │
│  └──────────────────┘        │  下游: 方法1 connector 直控（cmd/rest，默认）       │    │
│                              │        方法2 经 hub request 代理                   │    │
│                              │  10 个 dsh_connector_* 工具 / 12 条路由 / GUI 挂这里│    │
│                              └───────────────┬──────────────────────────────────┘    │
└──────────────────────────────────────────────┼───────────────────────────────────────┘
                                               │ HTTP（x-hub-token）
                          ┌────────────────────▼─────────────────────┐
                          │ hub（FastAPI，hub/ 目录，可多机共享）        │
                          │  /v1/connectors   YAML 共享（v1 已有）      │
                          │  /v1/leases      同步租约（v1 已有）        │
                          │  /v1/state /v1/runs                        │
                          │  /v1/files/*     ★ 新 file-manager 代理     │
                          │  /v1/request     ★ 新 request 代理          │
                          │  /v1/watch/*     ★ 新 task-watcher          │
                          └────────────────────┬───────────────────────┘
                                               │
                       下游平台（TaskWarrior / 飞书 / 钉钉 / Todoist / …）
                       ——只在「request 代理」模式下由 hub 直连；其余模式仍由各机器的 connector 直连
```

职责划分一句话：**hub 管「谁在什么时候、经谁的手」碰 todos.json 与下游平台；connector 管「怎么映射、怎么翻译」；上游插件管「存什么」——三者互不越界。**

## 3. 组件设计

### 3.1 file-manager（hub 新增，`/v1/files/*`）

定位：todos.json 的**受托读写代理**。connector 方法 2 时不自己碰文件，而是让 hub 代表它读/写。价值：

- **多实例并发收口**：所有实例的写都过 hub 一把进程内锁 + SQLite 事务，比「N 台机器各自抢同一把 NFS 文件锁」可靠；
- **审计**：谁、何时、改了什么，hub 全记（`/v1/runs` 已有雏形）；
- **为 v3 铺路**：v3 要把存储换成经 hub 的带 Token API，file-manager 就是那层 API 的 v2 前身（v3 只是把它指向 MySQL 后端）。

API（全部沿用 hub 现有包络 `{ok,data}` / `{ok:false,reason,error}`）：

| 方法/路径 | 语义 |
| --- | --- |
| `GET /v1/files/todo-store` | 返回整个文档 `{version, todos, trash}` + `revision`（乐观锁版本号，每次写 +1） |
| `PUT /v1/files/todo-store` | body `{doc, revision}`；`revision` 不匹配 → 409 `revision-conflict`（带 current）；匹配 → 原子落盘、revision+1 |
| `POST /v1/files/todo-store/update` | body `{revision, mutator?}` —— v2 简化：只提供整文档 CAS 写；字段级 patch 留给 v3 |
| `GET /v1/files/todo-store/watch` | （可选，SSE/长轮询）revision 变化通知，供本地缓存失效 |

实现要点：

- hub 侧 `hub/files.py`：路径**白名单**只允许 `todo-store` 一个虚拟名（映射到 hub 启动参数 `--todo-store <path>` 指向的 todos.json）；读写复用上游的存储契约（version=2、`{version,todos,trash}`），**锁与格式校验逻辑移植自 connector 的 lib/store.js，翻译成 Python**；
- 每次写前 `salvage()` 校验（坏记录丢弃而非报错，与 connector 行为一致）；写走 temp+rename 原子写；
- `revision` 存 SQLite（`files(table, path, revision, mtime)`），JSON 本体仍在文件系统（不进数据库，保证上游插件直读不受影响——**原版优先**）；
- 鉴权沿用现有 `X-Hub-Token` / loopback 两态。

### 3.2 connector 侧 fileProxy（方法 2 的客户端）

`lib/fileproxy.js`：`createFileProxy(hubClient)` 实现与 `createStore` **同接口**（`read/write/update/all/describe`），内部：

- `read` → `GET /v1/files/todo-store`；
- `update(mutator)` → 读（带 revision）→ 本地跑 mutator → `PUT` CAS；409 时重读重试，退避 3 次后抛 `revision-conflict`；
- 文件锁、指纹检测等逻辑**不再需要**（并发收口在 hub），但 `describe()` 保留同形状输出（`kind:'hub-proxy'`）。

接入方式（最小侵入）：`lib/index.js` 的 manager 构造加一个开关——

```yaml
# cordis.patch.yml / profile 覆盖
config:
  fileProxy: hub        # '' (默认, 直读写) | 'hub' (实验性)
```

`createManager` 收到 `fileProxy:'hub'` 且 hub 可达时，用 fileProxy 替换本地 store；hub 不可达 → 启动失败并 warn（fail-fast，绝不静默回落——静默回落会出现「实例 A 走代理、实例 B 直写」的脑裂）。该开关文档标注 **实验性**。

### 3.3 request 代理（hub 新增，`POST /v1/request`）

定位：下游平台调用的转发器。connector 方法 2 时，cmd/rest 执行器不发本机请求，而是把「要发什么」交给 hub 代发。价值：出口 IP 收口、凭据只在 hub 侧（connector YAML 里用 `${env:HUB_KEY_ALIAS}` 引别名而非真 token）、统一超时/重试审计。

API：

```
POST /v1/request
{
  "kind": "rest",            // v2 只支持 rest；cmd 代理留到有真实需求再做
  "url": "...",              // 必须完整 URL，hub 侧做 SSRF 校验（见下）
  "method": "GET",
  "headers": {...},          // 值可含 ${secret:alias}，hub 用自己的秘钥表替换
  "body": ...,
  "timeoutMs": 20000,
  "success": [200]
}
→ 200 { ok:true, data:{ status, body, durationMs } }
```

安全（这条是硬约束）：

- **SSRF 防护**：hub 拒绝目标是私网/回环/链路本地地址的请求（解析 host 后逐 IP 校验，IPv4-mapped 一并处理）；
- **秘钥别名表**：hub 启动目录 `secrets.json`（0600）`{"TODOIST": "Bearer xxx"}`；请求头值里的 `${secret:TODOIST}` 在 hub 内替换，**明文 token 永远不经过 connector 的 YAML/日志**；
- 响应体上限复用 hub 的 8MiB；每分钟每连接器限流（默认 60，超限 429）；
- 审计：每次代理写 `/v1/runs`（`kind:'proxy-request'`，**不记 headers 值**）。

connector 侧接入：`lib/runner.js` 的 rest 分支加一个 `via: 'hub'` 执行器选项；`via:'hub'` 时 `runRequest` 改为调 `POST /v1/request`（模板渲染仍在 connector 本地做，只把「渲染后的最终请求」交出去）。YAML 示例：

```yaml
client:
  executor:
    kind: rest
    via: hub            # 实验性：经 hub 代理发出
    baseUrl: https://api.todoist.com/rest/v2
    headers: { Authorization: "${secret:TODOIST}" }
```

### 3.4 task-watcher（hub 新增）

定位：**hub 独有**的定时调度器。v1 的调度在 connector 进程内（`schedule.everyMinutes`），多实例时会各自触发；v2 引入 hub 侧统一调度，保证「同一连接器同一时刻全网络只有一次同步在跑」。

机制（复用 v1 已有的租约）：

1. hub 启动一个后台线程（`hub/watcher.py`），每分钟扫 `watchers` 表；
2. 到期的 (connector, ) 条目 → `POST /v1/leases` 抢租约；抢到 → 通过**回调**通知某个在线实例执行同步；
3. 回调地址来自实例注册：connector 连上 hub 时 `PUT /v1/watch/{connector}/subscription {callbackUrl, instance}`（callbackUrl = 本实例 DSH 的 `/api/global-todo-connector/sync` 路由，hub 到实例的调用也要带 token——实例侧校验 `x-hub-token` 与 loopback）；
4. 无任何实例在线 → 本轮跳过并记 run（`kind:'watcher-skip'`）；租约失败 → 别的实例在跑，跳过；
5. watcher 只是「触发器」：同步本体仍在 connector（引擎、映射、执行器都没动）。

YAML 开关（连接器文件内）：

```yaml
connector:
  schedule:
    everyMinutes: 0      # 本实例不定时（v1 行为保留）
  watcher: hub          # 交给 hub 统一调度（与 hub 配置配套；未配 hub 时 validate 报错）
```

优先级规则：`watcher: hub` 时本地 `schedule.everyMinutes` 必须为 0（避免双调度），validate 强制。

### 3.5 保持不变的部分（原版优先清单）

- 上游 dsh-global-todo：**零改动**。它的 todos.json、锁、路由、GUI 全按 v1 契约使用；
- connector 的引擎/映射/执行器语义：零改动（只有「调用通道」可选换）；
- GUI 与 dsh 配置页面：仍在 connector 层（用户的图如此）；v2 只在状态页加「fileProxy / via / watcher」三个字段的展示，不做新面板；
- hub cli（人类操作路径）：v2 在 `dsh_connector_hub` 工具的 action 枚举里加 `watch`（查看/暂停 watcher 订阅），路由加 `GET /hub/watch`。

## 4. 数据与兼容

- hub SQLite 加 3 张表：`files`（revision）、`secrets` 不进库（文件）、`watchers`（connector, everyMinutes, callbackUrl, instance, enabled, nextRunAt）；`PRAGMA user_version` 1→2，迁移向前兼容（旧库自动补表）；
- 旧连接器 YAML 无 `via`/`watcher` 字段 = 完整 v1 行为；新字段对 v1 parser 是未知键（静默忽略），**v2 parser 必须显式接受并校验**；
- `/v1/files/*` 与 `/v1/request`、`/v1/watch/*` 都要求 hub ≥ 0.2.0（版本号在 `/health` 暴露，connector 连接时检查，不匹配 warn）。

## 5. 风险与取舍

| 风险 | 处置 |
| --- | --- |
| file-proxy 与直写混用脑裂 | fail-fast：`fileProxy:'hub'` 但 hub 不可达 → 实例拒绝启动该 connector（warn + 不注册调度） |
| request 代理被滥用打内网 | SSRF 白名单校验 + 限流 + 秘钥不落 YAML |
| watcher 与本地 schedule 双跑 | validate 强制 `watcher:hub ⇒ everyMinutes:0` |
| hub 成为单点 | 全部代理能力是 opt-in；hub 挂 = 退化回 v1 直连行为（重启 connector 即可），设计上没有硬依赖 |
| revision 冲突风暴 | CAS 重试退避 3 次 + 冲突计数进 runs；高频冲突时文档建议切回方法 1 |

## 6. 实现次序（本仓库内落地）

1. `hub/files.py` + `/v1/files/*` 路由 + 测试（SQLite revision 表）；
2. `lib/fileproxy.js` + `config.fileProxy` 开关 + 测试；
3. `hub/request.py`（SSRF 校验 + 秘钥别名 + 限流）+ `/v1/request` + 测试；
4. `lib/runner.js` rest 分支 `via:'hub'` + connector parser 接受 `via` 字段 + 测试；
5. `hub/watcher.py` + `/v1/watch/*` + connector 订阅注册 + validate 强制规则 + 测试；
6. docs：CONNECTORS.md 加 `via`/`watcher` 字段表，HUB.md 加三个新 API，ARCHITECTURE.md 更新拓扑图；
7. 全量测试 + bump 0.2.0 + commit/push。

每步保持「hub 不在 = v1 行为不变」的可回归性。
