# v3 设计方案：MySQL 后端 + 经 hub 本地进程的带 Token global-todo API

> 状态：**设计稿（待用户确认后才动手实现）**。本文是任务④的产出；按约定，方案写完先停下等用户拍板，未经确认不写任何实现代码。
>
> 用户原始需求（一句话）：「经 hub 本地进程访问带 Token 的 global-todo API，接管 JSON 读写，处理多实例同步与并发」。
>
> 前置：v2（已实现并推送，commit `37b25f8`）交付了 file-manager（`/v1/files/todo-store`，revision CAS）、request 代理、task-watcher。v3 是它的直接后继——**把「文件」抽象换掉，但把 CAS 语义、鉴权模型和 fail-fast 原则原样继承**。

## 0. 用户需求 → 本文的翻译

用户给的这一句话里其实有四个决定：

1. **「经 hub 本地进程」** —— API 的宿主是 hub（那个 Python FastAPI 进程），不在 DSH 插件进程里实现存储。插件侧只当客户端。与 v2 的 file-manager 同构：文件在 hub、账在 hub、插件只持有 revision。
2. **「带 Token 的 global-todo API」** —— 所有请求必须过鉴权；hub 的 `GTC_HUB_TOKEN` / `X-Hub-Token` 模型沿用。**不提供无 Token 的局域网明文模式**——v3 的 API 等于「你全部待办的读写权」，这一点比 v2 更严格。
3. **「接管 JSON 读写」** —— todos.json 退出数据链路。上游 dsh-global-todo 仍把 todos.json 当它的存储（原版优先铁律不动），但**本插件的所有读写都改走 API**；todos.json 变成由 hub 单写、被上游读的「兼容层」。多实例因此天然安全：写入的唯一入口在 hub 进程内。
4. **「处理多实例同步与并发」** —— 并发控制从「文件锁 + CAS」升级为「数据库事务 + CAS」。MySQL 的行锁/事务替我们做 v2 里 `BEGIN IMMEDIATE` 干的活；revision CAS 语义对外不变（插件侧 `lib/fileproxy.js` 一行不用改，见 §4）。

**MySQL 存什么**：待办记录（todos）与 trash。连接器 YAML、state 水位线、run log **不进库**——前两者的源头在 git/本地文件（v1 决策不变，可重建），后两者是追加日志，留在本地文件即可。

## 1. v2 → v3 的差距

| 职责 | v2 现状 | v3 目标 |
| --- | --- | --- |
| todos.json 读写 | 直读写（本地锁）或经 file-manager 代理（CAS + 单文件） | 经 hub API 读写；hub 后端从 JSON 文件换成 MySQL |
| 并发控制 | `BEGIN IMMEDIATE`（SQLite 写锁）+ 文件锁 | MySQL 行锁（`SELECT ... FOR UPDATE`）+ 事务 + revision CAS |
| 多实例 | 单 hub 串行写 | 同左（写入口唯一），但 hub 可多副本读、写仍收敛到单库 |
| 鉴权 | token 可选（无 token 仅回环） | **token 必选**；无 token 的 hub 拒绝挂载 v3 存储（启动即报错） |
| 上游兼容 | todos.json 是上游与 connector 的共同真相 | todos.json 仍是上游的存储；connector 侧改走 API。**上游感知不到任何变化**（原版优先） |
| schema | SQLite `user_version=2` | MySQL `schema_migrations` 表，迁移脚本幂等 |

设计原则不变：**不配置 = v2 行为，零回归**。`config.fileProxy` 增加第三个值 `hub-mysql`（或复用 `hub` + 服务端能力协商，见 §5.1 的取舍），未配置时插件照旧直读写 JSON。

## 2. 存储模型

### 2.1 表结构（MySQL 8.0，utf8mb4）

```sql
CREATE TABLE todo_documents (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  instance      VARCHAR(255) NOT NULL DEFAULT 'default',  -- 预留多文档；v3 只用 'default'
  version       INT NOT NULL,            -- 上游 SCHEMA_VERSION，恒为 2
  revision      BIGINT UNSIGNED NOT NULL, -- CAS 计数器，每次写 +1（继承 v2 files 表语义）
  updated_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_instance (instance)
) ENGINE=InnoDB;

CREATE TABLE todos (
  internal_id   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  instance      VARCHAR(255) NOT NULL DEFAULT 'default',
  todo_id       VARCHAR(16)  NOT NULL,   -- 上游 id：t-xxxxxxxx
  seq           INT NOT NULL,
  title         VARCHAR(768) NOT NULL,   -- LIMITS.title=200 字符，utf8mb4 最坏 4 字节/字符
  payload       JSON NOT NULL,           -- 完整上游记录（含 description/tags/links/steps/activity/... 原样保存）
  updated_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_instance_todo (instance, todo_id),
  KEY idx_instance_status ((CAST(payload->>'$.status' AS CHAR(16)))),
  KEY idx_instance_due ((CAST(payload->>'$.dueAt' AS CHAR(32))))
) ENGINE=InnoDB;

CREATE TABLE trash (
  internal_id   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  instance      VARCHAR(255) NOT NULL DEFAULT 'default',
  todo_id       VARCHAR(16) NOT NULL,
  payload       JSON NOT NULL,
  trashed_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_instance_todo (instance, todo_id)
) ENGINE=InnoDB;

CREATE TABLE schema_migrations (
  version       INT PRIMARY KEY,
  applied_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
```

要点：

- **payload 原样存整条记录**（JSON 列），不为每个上游字段建列。理由：上游 SCHEMA_VERSION=2 的字段集可能继续演化（v2 经验：`review`/`completion`/`dispatch` 都是后来出现的），宽表会被上游演进拖着走；JSON 列 + 两三个查询索引（status/dueAt）是「兼容上游任意演进」与「够用的查询」之间的平衡点。
- **`revision` 是 CAS 计数器**，放 `todo_documents` 一行上，语义与 v2 files 表完全一致：读带 revision，写带 expectedRevision，不匹配 409。
- 索引只建 status/dueAt 两个函数索引（MySQL 8.0.13+），`list` 查询的两种过滤走索引；全文搜索（query 参数）直接 `JSON_SEARCH`/`LIKE` 全表扫——上游本来就只支持小清单（≤ 数百条），不值得建 FULLTEXT。
- 时间戳一律 `TIMESTAMP(6)`（UTC），与上游 ISO-8601 互转在 hub 内做。

### 2.2 连接与凭据

- `GTC_MYSQL_DSN`（或 CLI `--mysql-dsn`）：形如 `mysql://user:pass@host:3306/dbname`。**必填**才启用 v3 存储；没配 DSN 的 hub 保持 v2 文件模式。
- DSN 里的密码支持 `${env:NAME}` 展开，避免写进 systemd unit 明文。
- 连接池：`aiomysql`（或 `asyncmy`），`pool_size=8`，`pool_recycle=3600`。写事务全部 `SELECT ... FOR UPDATE` 包住 CAS 判断，隔离级别用默认 REPEATABLE READ。

## 3. API 设计

沿用 hub 现有包络（`{ok, data}` / `{ok:false, reason, error}`）与 `X-Hub-Token` 鉴权。新增/改动：

| 端点 | v2 | v3 |
| --- | --- | --- |
| `GET /v1/files/todo-store` | 读 JSON 文件 + revision | 改为读库：拼出上游文档形状 `{version:2, todos:[...], trash:[...], revision}` |
| `PUT /v1/files/todo-store` | CAS 写文件 | CAS 写库：事务内校验 revision → 全量替换该 instance 的 todos/trash → revision+1 |
| `GET /health` | — | 加 `storage: "file" \| "mysql"` 字段，插件用它做能力协商 |
| `POST /v1/queries/list`（新） | — | 服务端过滤查询：`{status?, tag?, query?, sort?, limit?}` → 直接 SQL 过滤，避免每次同步全量拉文档 |
| `POST /v1/mutations/status`（新，可选） | — | 单条状态变更事务：`{todoId, status, by}` → 行锁 + 更新 payload.status + activity 追加，revision+1 |

**取舍：v3 第一期只做全量文档读写（`/v1/files` 换后端），不做增量 mutation API。** 理由：上游 store 的写路径是「读全文档 → 改 → 写全文档」，插件侧 `lib/fileproxy.js` 已经按这个形状工作；全量替换事务虽然写放大，但在待办量级（≤ 数百条）下单事务 <10ms，不值得先做增量协议。`/v1/queries` 与 `/v1/mutations` 是二期优化，schema 已为其留好索引。

**为什么不引入新的 REST 风格资源**（如 `/v1/todos/{id}`）：上游的数据一致性单位是「整份文档 + 全局 seq 分配」（`assignSequence` 跨记录去重），逐条 REST 会在 hub 里重新实现一遍上游 service 的业务规则——违背「原版优先」，也制造两套真相。文档级 CAS 是对上游模型最忠实的投影。

### 3.1 插件侧接入：一个新文件，零改引擎

```js
// lib/mystore.js（计划名）
// 与 createStore/createFileProxy 同接口：read/write/update/all/describe
// read → GET /v1/files/todo-store；update → GET+mutator+PUT（revision CAS 重试，
// 逻辑与 fileproxy 相同，只是错误 reason 用 revision-conflict 同名复用）
```

- `config.fileProxy` 增加值 `api`（名字候选，见 §5.2）→ manager 用 `createMysqlProxy({hubClient})` 顶替 store。engine/manager/routes/tools **零改动**——它们只认 store 接口。
- v2 的 `fileProxy: hub`（JSON 文件后端）继续可用，作为没有 MySQL 的用户的降级路径。
- `describe()` 返回 `kind:'hub-api'` + 服务端 `storage` 字段，`dsh_connector_status` 原样透出。

### 3.2 能力协商（启动时一次）

插件启动向 hub `GET /health`：

- `storage:"mysql"` 且插件配置 `fileProxy:"api"` → 启用 v3 存储代理；
- `storage:"file"`（hub 没配 MySQL）→ 报 `invalid-request`「hub 未启用 MySQL 存储，fileProxy:api 不可用」（fail-fast，不静默回落——与 v2 同一原则）；
- hub 不可达 → 插件照 v2 规则：启动失败并 warn，定时器不排（tools/routes 仍可用，`dsh_connector_sync` 显式触发时报 `hub-unavailable`）。

## 4. 并发与多实例

| 场景 | v2（file-manager） | v3（MySQL） |
| --- | --- | --- |
| 两实例同时 PUT | SQLite `BEGIN IMMEDIATE` 串行化，输者 409 重试 | `SELECT revision FOR UPDATE` → 比对 → 全量替换 → COMMIT；输者在行锁上排队，拿锁后发现 revision 已变 → 409。语义相同，等待换成行锁 |
| 上游（dsh-global-todo）直接写 todos.json | v2 文件模式：互相感知（外部改动计数） | **不兼容**：上游写文件不会进库，插件走 API 读不到它。见 §6 的第一个风险 |
| hub 多副本 | 不支持（单文件 SQLite） | 读可多副本；写仍单库收敛，CAS 保证不丢 |
| watcher 触发 + 手动 sync 并发 | 租约挡住 watcher，CAS 挡住手动 | 同左，无新增机制 |

## 5. 风险与开放问题（需要用户拍板的点）

### 5.1 「fileProxy 值域」两种方案

- **A（倾向）**：`fileProxy` 保持两值 `'' | 'hub'`，v3 后端由**服务端**决定——hub 配了 MySQL，`fileProxy:hub` 自动走 MySQL API。优点：插件配置面不变，能力协商全在 `/health`。缺点：「我配的是文件还是库」要看服务端才知道。
- **B**：`fileProxy: 'hub' | 'api'` 两值并存，A 指文件后端、B 指 MySQL 后端，插件侧显式选择。优点：意图显式。缺点：多一个配置概念，且用户可能写错组合（`api` 配了没 MySQL 的 hub → 报错）。

### 5.2 上游直写文件与 API 读不同步（最大的语义风险）

上游 dsh-global-todo 继续把 todos.json 当存储：用户在 DSH 面板/LLM 里用 `global_todo_add` 建的待办**只写文件、不进库**。插件走 API 时看不到它；反之连接器 pull 的新条目只进库、上游面板看不到。

缓解选项（可组合）：

- **a（倾向）**：文档里写死这条边界——「fileProxy:api 模式下，连接器同步的世界与 DSH 内待办是两个圈，互相看不见」；把 hub 做一个**单向文件→库的导入器**（watcher 每 5 分钟读 todos.json 的 mtime，变了就 CAS 导入），让上游侧的变更单向流入。库→文件方向不做（会与上游文件锁打架，违背原版优先）。
- **b**：不做缓解，接受双圈世界，文档明示。
- **c**：库→文件反向同步也做（hub 成为 todos.json 的唯一写者，上游只读）——**放弃**：上游写路径是活的，锁文件、recent-session.json、 purge 定时器都在写，挡不住。

### 5.3 MySQL 依赖

hub 从「零外部依赖（SQLite）」变成「需要 MySQL 8.0+」。部署成本上升是 v3 的主要代价；作为交换得到真正的多实例并发与崩溃一致性。是否值得取决于用户是否真的要多实例——**单机用户应继续用 v2 文件模式**。

### 5.4 其它

- Python 驱动选型（aiomysql vs asyncmy）实现时定；两者都纯 async、无重大差异。
- 备份策略从「拷 hub.db」变成「mysqldump」，hub/README 的备份节要重写。
- `runs.jsonl`、连接器 YAML、state 水位线不进库（§0 已定），所以 v3 不需要新的表迁移框架之外的迁移。

## 6. 实现次序（确认后执行）

1. `hub/mysql.py`：连接池 + schema 迁移（schema_migrations v1：todo_documents/todos/trash）。
2. `hub/store.py`：`Storage` 抽象基类抽出 `FileStorage`（现实现）/`MySqlStorage` 两个后端，`create_app` 按 DSN 选择；files 端点改走抽象，CAS 语义逐字保留。
3. `/health` 加 `storage` 字段；`--mysql-dsn` CLI + `${env:}` 展开。
4. 插件侧 `lib/mystore.js`（复用 fileproxy 的 CAS 重试骨架）+ `fileProxy:'api'` 解析 + 能力协商。
5. 测试：hub 侧 pytest（内存 MySQL 或 testcontainers；退路是 sqlite 分支继续跑，MySQL 分支标 skipif 无 DSN）；插件侧 node 测试（fake hub 扩展 storage 协商）。
6. docs：CONNECTORS/HUB/ARCHITECTURE 各加一节；CHANGELOG Unreleased；DESIGN-v2 的「v3 铺路」注记改为指向本文。

预计规模：hub 侧 ~600 行 + 测试；插件侧 ~150 行 + 测试。无 npm/python 新增运行时依赖（驱动除外）。

---

**按约定，本文到此停笔。** 上面 §5 的四个决策点（fileProxy 值域、双圈语义的缓解、是否接受 MySQL 依赖、要不要做 `/v1/queries` 一期就上）等你确认后才会动第一行实现代码。
