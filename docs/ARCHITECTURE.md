> 这份文档回答一个问题：这个插件为什么直接读写 dsh-global-todo 的 JSON 文件，而不是调它的 HTTP 接口；一次同步在内部是怎么走的，哪些情况会删数据、哪些不会。

# 架构

## 1. 它站在哪里

```
┌──────────────────────────────────────────────────────────────┐
│ DeepSeek Harness                                             │
│                                                              │
│  ┌────────────────────────┐        ┌──────────────────────┐  │
│  │ dsh-global-todo        │        │ dsh-global-todo-     │  │
│  │ （上游插件）            │        │ connector（本插件）   │  │
│  │                        │        │                      │  │
│  │ /api/global-todo/*     │        │ 10 个 dsh_connector_*│  │
│  │ 自己的 Cordis 生命周期   │        │ 定时器 + 执行器       │  │
│  │        │               │        │        │             │  │
│  │        ▼               │        │        ▼             │  │
│  │  ~/.dsh/global-todo/   │◀───────┼── 直接读写（带锁）    │  │
│  │    todos.json          │        │                      │  │
│  └────────────────────────┘        └──────────┬───────────┘  │
└───────────────────────────────────────────────┼──────────────┘
                                                │
                          ┌─────────────────────┴──────────────┐
                          ▼                                    ▼
                   cmd 执行器                            rest 执行器
              （shell 命令，读 stdout）              （一个 HTTP 请求）
                          │                                    │
                          ▼                                    ▼
              TaskWarrior / lark-cli /                 Todoist / 钉钉 /
              自写脚本 / todo.txt                      自建 API
```

本插件**不是**一个独立服务，它是 DSH 的一个插件：注册工具、注册 HTTP 路由、在内存里跑定时器。它没有守护进程，也没有数据库，唯一的持久化是插件目录下的几个文件。

## 2. 为什么不调 dsh-global-todo 的 HTTP API

上游插件确实暴露了 `/api/global-todo/*`，看起来是现成的集成点。实测过，不行，原因有两条：

**（一）它没有提供 Cordis service。** 它的 `lib/index.js` 只注册工具和路由，没有 `provide` / `ctx.set('globalTodo', ...)` 之类的服务注册。也就是说别的插件在进程内**没有**一个可注入的编程接口，只能走 HTTP。

**（二）它的路由在 DSH 的 connection fence 后面。** DSH 的 webServer 对被外部进程访问的路由有一套连接校验，本地脚本直接 `curl` 会拿到：

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/global-todo/health
401
$ curl -s http://127.0.0.1:3080/api/global-todo/health
{"ok":false,"reason":"unauthorized","error":"..."}
```

同一个地址的 `/` 是正常的 HTML，说明服务活着、只是这条路由拒绝了没有凭据的调用。上游的路由本身还额外做了严格的 loopback + Host 校验，即使绕过第一层也拿不到。

所以本插件改成**复用它的存储契约**：读同一个 `todos.json`，写同一个 `todos.json`，用同一把锁。好处是不依赖上游的 HTTP 层（它换实现也不影响），坏处是必须严格遵守它的存储格式——下面这些约束一条都不能破。

## 3. 复用的存储契约

上游把待办存在一个 JSON 文件里，本插件完全按它的规矩来。

| 约束 | 具体做法 |
| --- | --- |
| **路径** | `$DSH_HOME/global-todo/todos.json`，`DSH_HOME` 未设置时是 `~/.dsh`；插件配置 `storePath` 可覆盖 |
| **schema version 2** | 文件顶层有 `version` 字段。读到 `version > 2` 直接报 `store-corrupt` 并给出「版本是 N，本插件只认识 2，请升级插件或移走文件」，**绝不**按旧格式强解 |
| **原子写** | 先在**同目录**写临时文件 `<file>.<pid>.<ts>.connector.tmp`（mode `0600`），`fsync` 之后 `rename` 覆盖，最后尽力 `fsync` 目录。rename 是原子操作，所以任何时刻读到的都是完整文件 |
| **跨进程锁** | 锁文件是 `todos.json.lock`。用 `open(lockfile, 'wx')` 做 test-and-set，内容写 `{pid, host, at, token}`（token 是随机 uuid）。释放时校验 token，不是自己拿的锁不会误删。等锁超时 5 秒，超过 30 秒的锁视为陈旧可回收（同主机上 pid 已死的锁也会被回收） |
| **宽容读取** | 文件不存在或为空 → 当作空文档，不报错；JSON 解析失败 → `store-corrupt`，**不重置、不覆盖**，保留现场让人来修 |

写入失败会重试（`EPERM` / `EBUSY` / `EACCES`，Windows 上杀毒软件短暂占用文件的常见情况），最多 4 次。

因为两边用的是同一把锁、同一种原子写，所以「DSH 界面里点一下」和「连接器 pull 一条」同时发生也不会互相截断。

## 4. 一次 sync 的时序

关键在于：**绝不在持锁期间做网络调用或跑命令。**

```
sync(connector)
  │
  ├─ pull 阶段 ──────────────────────────────────────── 锁外
  │    跑 cmd / 发 rest 请求（可能几十秒）
  │    解析 + 映射成远端记录
  │
  ├─ 读状态文件 state/<name>.state.json ─────────────── 无锁
  │    { links: { localId: { remoteId, localUpdatedAt, ... } } }
  │
  ├─ 拿锁 ───────────────────────────────────────────── 锁内
  │    read  todos.json
  │    逐条比对、新建 / 更新 / 判冲突
  │    write todos.json（temp + fsync + rename）
  │  放锁
  │
  └─ push 阶段 ──────────────────────────────────────── 锁外
       扫带 client:<name> 标签的待办，挑出「新增或改过」的
       渲染 mapping.push，调执行器
       成功后再拿一次锁，只前进水位线
```

pull 慢不会阻塞 DSH 界面写待办；push 慢也不会。锁只在「读-改-写」那一小段被持有，通常是毫秒级。

**并发保护**：同一连接器的并发调用会被合并——引擎里有一个 `running` Map，第二个调用直接返回第一个的 promise，不会双跑。这解决了「定时器刚触发、用户又点了手动同步」的重复创建问题。

**pull 和 push 不是原子的。** 如果 pull 成功、push 失败，本地已经反映了远端的最新状态，只是没推上去；下次同步会重试 push（水位线没前进，候选还在）。反过来 push 成功、写状态失败，会重复推一次——所以下游最好对 `remoteId` 做幂等（带 id 的 update 天然幂等）。

## 5. 幂等：状态文件

每个连接器一份，路径 `<pluginDir>/state/<connector>.state.json`：

```jsonc
{
  "version": 1,
  "links": {
    "t-1a2b3c4d": {
      "remoteId": "9f8e7d6c",
      "localUpdatedAt": 1764140000000,   // 上次同步时本地 todo 的 updatedAt
      "remoteUpdatedAt": 1764139000000,  // 上次同步时远端记录的 updatedAt
      "localStatus": "open",
      "remoteStatus": "open",
      "lastSyncedAt": 1764140000420
    }
  },
  "lastRun": 1764140000420,
  "lastResult": { "at": 1764140000420, "direction": "both", "created": 2, "updated": 1, "conflicts": 0, "pushed": 3, "unlinked": 0 }
}
```

两条水位线各自回答一个问题：

- `todo.updatedAt > link.localUpdatedAt` → **本地变过**
- `remote.updatedAt > link.remoteUpdatedAt` → **远端变过**

四种组合：

| 本地变了 | 远端变了 | 处理 |
| --- | --- | --- |
| 否 | 否 | 什么都不做 |
| 是 | 否 | 留给 push 推上去 |
| 否 | 是 | 用远端值更新本地（只改真正不同的字段） |
| 是 | 是 | **冲突**，按 `conflict` 策略判胜负，记进报告 |

状态文件损坏或丢失时不会崩：读失败只 warn，然后当成空状态重来。代价是丢失关联信息，可能重复创建——引擎有一个兜底：如果远端记录的 id 不认识，但存在一条**标题完全相同**（去空白、转小写后比较）且带 `client:<name>` 标签的本地待办，就直接接管这条关联，而不是新建。

## 6. 绝不隐式删除

这是整套设计里最重要的一条规则。

| 事件 | 本插件的反应 |
| --- | --- |
| 远端记录不见了 | 记进本次报告的 `unlinked[]`，**不删**本地待办 |
| 本地待办被删 | 状态文件里的 link 变成孤儿，**不删**远端记录 |
| 远端把状态改成 `done` | 本地跟着变 `done`，不删 |
| 本地把状态改成 `cancelled` | 推上去变 `cancelled`，不删 |

删除是不可逆的、跨系统的操作，值得人来做。插件只报告「我看到了不一致」，不替你决定。

`unlinked` 的报告条目形如：

```jsonc
{ "localId": "t-1a2b3c4d", "remoteId": "9f8e7d6c", "title": "整理周报" }
```

看到它说明远端那边删了或者改了 id——你自己决定是删本地待办、还是把它重新推回去。

## 7. 冲突

只在**两边都变**时触发，具体规则见 [CONNECTORS.md 的 3.2](CONNECTORS.md#32-conflict两边都改过时谁赢)。这里的实现要点：

- `newer` 比较的是两边各自的 `updatedAt`，**相等时算远端赢**。
- 输的一方这次不写入，但它的值仍在各自系统里，没有丢。
- 无论谁赢，**远端水位线都会前进**，所以同一条冲突不会在下次同步重复报警。想让它在下次重新判一次，得让远端时间戳再变一次（或者手动删掉状态文件里那条 link）。
- 每个冲突都写进报告的 `conflicts[]`，运行历史里也留着。

## 8. 失败语义

| 场景 | 行为 |
| --- | --- |
| 单个连接器失败 | 其他连接器不受影响，各自独立调度、独立执行 |
| 失败本身 | 生成一个 `{failed: true, failureReason, error}` 的报告，**照样写进 `runs.jsonl` 和 hub**，然后抛给调用方 |
| 运行日志 | `<pluginDir>/runs.jsonl`，一行一次运行。读取时只取最近 500 行；文件涨到约 200 KB 以上时会被裁剪回最近 500 行。写日志失败只 warn，不会让同步失败 |
| 状态文件读失败 | 只 warn，按空状态继续（会被当成「从没同步过」，可能重复新建几条，所以状态文件值得备份） |
| 状态文件写失败 | 抛错（多数情况是 `store-unwritable`），这次同步整体算失败并写进 `runs.jsonl`；下次同步重试，最坏情况是重复推一次 |
| 连接器定义坏了 | `list` 里那一行显示 `ok: false` 和错误原因，其余连接器照常工作，不会因为一个坏文件整个插件起不来 |
| 上游插件不存在 | 插件**整个不启动**，只打一条 warning。见下 |

启动时会先探测 dsh-global-todo：Loader 里有它的条目、或者它的 `todos.json` 存在，才算就绪。两者都没有就放弃启动：

```
没检测到 dsh-global-todo（既没有它的 Loader 条目，也没有它的存储文件），本插件不启动。
```

这是刻意的：没有上游就没有待办可同步，装作正常只会让人困惑于「为什么同步永远是 0 条」。

## 9. hub 的边界

hub 是**可选的**，不装也能用。它的职责边界必须说清楚，因为它很容易被误解成「多机同步方案」。

| 能力 | 没有 hub | 有 hub |
| --- | --- | --- |
| 连接器定义 | 只在本机 `<pluginDir>/connectors/*.yaml` | 可推到 hub 共享，其他机器 `dsh_connector_hub` 拉下来 |
| 待办本身 | 只在本机 `todos.json` | **仍然只在本机**，hub 不存待办 |
| 多机待办同步 | 用 dsh-global-todo 自己的 `sync.dir` | 同左，与本插件无关 |
| 运行历史 | 本机 `runs.jsonl`（读取上限 500 条） | 可镜像到 hub，跨机查看 |
| 多实例防重复 push | 无 | hub 提供租约 API；**当前插件同步路径并未申请租约**，见 [HUB.md](HUB.md#4-租约模型) |
| 依赖 | 无 | 一个 Python 进程 |

一句话：**hub 共享的是「怎么同步」，不是「同步什么」。**

### 9.1 v2 之后：hub 可以站进链路（opt-in）

v2 给上表加了三个可选代理，每个都要显式打开；不开时上表逐条仍然成立：

| 能力 | 开关 | 边界变化 |
| --- | --- | --- |
| file-manager | 插件配置 `config.fileProxy: hub` | todos.json 读写经 hub（revision CAS）。hub 从「不存待办」变成「代管待办文件」；CAS 冲突退避重试，hub 不可达 fail-fast |
| request 代理 | 连接器 `executor.via: hub` | REST 出站经 hub。hub 从「不发起外部请求」变成「代发请求」；作为交换拿到 SSRF 防护、`${secret:ALIAS}` 侧解析（明文凭据只存在 hub 的 secrets.json）、限流与审计 |
| task-watcher | 连接器 `watcher: hub` | 调度权上交 hub，本机不设定时器（`everyMinutes` 强制 0）；hub 到期抢租约后回调本机 sync 接口 |

设计依据与实现次序见 [DESIGN-v2.md](DESIGN-v2.md)。

## 10. 安全模型

### 10.1 插件自己的 HTTP 路由

路由挂在 `/api/global-todo-connector` 下，全部声明 `auth: 'anonymous'`。

为什么要这样：DSH 的 webServer 里 `auth` 默认是 `required`，只有带凭据的浏览器会话能过。外部脚本（你写个 cron、或者另一台机器上的 curl）拿不到这个凭据，会被 401 挡掉——就像第 2 节里上游那个接口一样。所以本插件用 `anonymous` 放行，然后**在 handler 里自己做 loopback 校验**：

1. socket 的对端地址必须是回环：`::1`、`127.0.0.1`、`127.*`、`::ffff:127.*`；
2. `Sec-Fetch-Site` 不能是 `cross-site`（挡住浏览器里跨站发起的请求）；
3. `Host` 头的主机名必须是 `localhost` / `127.0.0.1` / `[::1]` / `127.*`（挡住 DNS rebinding）。

三条有一条不过就返回 `403 {"ok":false,"reason":"forbidden","error":"只接受本机请求"}`。响应一律 `cache-control: no-store`；请求体上限 1 MiB。

注意这只防「本机之外」和「浏览器跨站」。**本机上的任何进程都能调用这些接口**——如果你的机器上跑着不可信的代码，这个问题不在插件的威胁模型里。

### 10.2 命令执行器

`cmd` 执行器本质上就是「让 YAML 跑任意命令」，所以它必须假设自己会被恶意配置利用。防护措施是**清理环境变量**：子进程环境里会剔除

- 所有 `DEEPSEEK_*`
- `DSH_*TOKEN`、`DSH_*KEY`
- `OPENAI_*`、`ANTHROPIC_*`、`AWS_*`

这样即使有人往 YAML 里塞一句 `env`，也拿不到 harness 自己的凭据。

这不是万能的：模式是前缀匹配，你自己的 `TODOIST_TOKEN`、`GITHUB_TOKEN` 之类**不会**被剔除（否则 `${env:TODOIST_TOKEN}` 就没法用了）。所以别把敏感变量放在连接器进程能看到的地方，除非这个连接器确实需要它。

`cmd` 的 `run` 字符串会被 shell 执行，命令里不要拼接不可信的外部输入（比如直接把远端返回的标题拼进命令）——那是命令注入。需要传数据请用 `stdin`。

### 10.3 REST 执行器

`baseUrl` 只允许 `http://` 和 `https://`，其他协议（`file:`、`gopher:` 之类）在加载时就被拒绝。头名字按 RFC 7230 的 token 规则校验，防止头注入。

## 11. 文件与目录

```
~/.dsh/global-todo/
├── todos.json                  # 上游的存储，本插件读 + 写
└── todos.json.lock             # 跨进程锁

~/.dsh/global-todo-connector/    # 本插件的 dataDir
├── connectors/
│   ├── taskwarrior.yaml        # 连接器定义（人写）
│   └── todoist.yaml
├── state/
│   └── taskwarrior.state.json  # 幂等水位线（插件维护）
└── runs.jsonl                  # 运行历史，读取上限 500 行
```

`dataDir` 和 `storePath` 都可以在插件配置里改。两者指向不同目录是允许的。

## 12. 相关文档

- [CONNECTORS.md](CONNECTORS.md)：YAML 的完整字段参考
- [HUB.md](HUB.md)：可选的共享 hub
- [../README.md](../README.md)：安装与快速开始
