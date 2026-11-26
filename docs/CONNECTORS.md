> 这份文档回答一个问题：`connectors/*.yaml` 里到底能写什么，每个字段是什么含义，写错了会怎样。

# 连接器 YAML 参考

一个 connector（连接器）就是一份 YAML 文件，描述「本地全局待办」与「某个外部待办系统」之间的对应关系：怎么把它那边的记录读下来（pull），怎么把本地改动送上去（push），以及两边的字段、状态、优先级怎么翻译。

文件放在插件数据目录的 `connectors/` 下：

```
~/.dsh/global-todo-connector/
├── connectors/
│   ├── taskwarrior.yaml        # 文件名 = 连接器 id
│   └── todoist.yaml
├── state/
│   └── taskwarrior.state.json  # 幂等水位线，插件自动维护
└── runs.jsonl                  # 运行历史，读取上限最近 500 条
```

数据目录由插件配置 `dataDir` 决定，默认 `~/.dsh/global-todo-connector`。

**文件名就是连接器 id。** `connectors/taskwarrior.yaml` 里必须写 `connector.name: taskwarrior`，否则保存会被拒绝（`文件名是 taskwarrior，但 YAML 里的 connector.name 是 xxx；两者必须一致`）。id 只能是小写字母、数字、点、下划线和短横线，最多 64 字符，且以字母或数字开头。

---

## 1. 最小可用示例

```yaml
version: 1

connector:
  name: notes
  label: 本地笔记
  enabled: false
  direction: push

client:
  name: notes
  executor:
    kind: cmd
    push:
      run: cat >> "${env:HOME}/.dsh/global-todo-connector/notes-log.json"
      stdin: batch

mapping:
  push:
    id: "${remoteId}"
    title: "${todo.title}"
```

这份文件（仓库里的 `examples/notes.yaml`）不需要任何外部服务就能跑通：每次 push 把一批待办以 JSON 追加进一个本地文件，适合用来确认整条链路是通的。

`enabled` 默认是 **false**。新建连接器时保持 false，用 `dsh_connector_sync` 手动跑一次确认结果符合预期，再改成 true 交给定时器。

---

## 2. 顶层结构

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `version` | 整数 | 否 | `1` | 格式版本。目前只接受 `1`；写成 `2` 会被拒绝并提示升级插件 |
| `connector` | 映射 | 是 | — | 连接器本体：id、方向、冲突策略、调度、批量上限 |
| `client` | 映射 | 是 | — | 下游系统：名字、标签、缺省优先级、执行器 |
| `mapping` | 映射 | 否 | 十个字段同名直通 | 字段映射，见第 7 节 |

未知的顶层键会被**静默忽略**（不会被当成错误），这既是为了向前兼容，也意味着拼错的字段名不会报错——写完请用 `dsh_connector_validate` 核对结果里 `connector` 的摘要，而不是只看有没有报错。

---

## 3. `connector` 块

| 字段 | 类型 | 必填 | 默认 | 取值 / 说明 |
| --- | --- | --- | --- | --- |
| `name` | 字符串 | 是 | — | 连接器 id，必须与文件名一致；`^[a-z0-9][a-z0-9._-]{0,63}$` |
| `label` | 字符串 | 否 | 同 `client.name` | 给人看的名字，出现在工具输出和运行报告里 |
| `description` | 字符串 | 否 | 空 | 一句说明，只用于展示 |
| `enabled` | 布尔 | 否 | **`false`** | 是否参与**定时**同步。显式调用 `dsh_connector_sync` 不受它限制 |
| `direction` | 枚举 | 否 | `pull` | `pull` / `push` / `both` |
| `conflict` | 枚举 | 否 | `newer` | `newer` / `remote` / `local` |
| `schedule.everyMinutes` | 整数 | 否 | `15` | `0`–`10080`。`0` 表示不定时，只能手动触发 |
| `schedule.onBoot` | 布尔 | 否 | `false` | 插件启动后延迟约 3 秒跑一次 |
| `watcher` | 枚举 | 否 | 空 | 唯一合法值 `hub`（v2）：把定时调度权交给 hub 的 task-watcher，本机不再设定时器。**强制要求 `everyMinutes: 0`**，否则校验报「避免双重触发」；插件启动时向 hub 注册订阅（到期抢租约后回调本机 sync 接口）。需要插件已配置 hub |
| `limits.maxPull` | 整数 | 否 | `200` | 单次 pull 最多处理多少条远端记录（`1`–`2000`） |
| `limits.maxPush` | 整数 | 否 | `200` | 单次 push 最多推送多少条本地待办（`1`–`2000`） |

### 3.1 `direction`

| 值 | 含义 | 要求 |
| --- | --- | --- |
| `pull` | 只把远端拉下来，写成本地待办 | 执行器必须有 `pull` 动作 |
| `push` | 只把本地改动推上去 | 执行器必须有 `push` 动作 |
| `both` | 先 pull 再 push（同一次 sync 内顺序执行） | 执行器必须同时有 `pull` 和 `push` |

`direction` 与实际配置的动作必须匹配，否则加载时报错，例如：

```
client.executor.push：direction 是 both，但 cmd 执行器没有配置 push
```

### 3.2 `conflict`：两边都改过时谁赢

冲突只在**同一对记录两边都自上次同步后发生了改动**时才会产生。只有一边动过就正常合并，不会记冲突。

| 值 | 谁赢 |
| --- | --- |
| `newer` | 比较 `updatedAt`：远端时间 `>=` 本地时间时远端赢（相等算远端赢），否则本地赢 |
| `remote` | 无条件远端赢 |
| `local` | 无条件本地赢 |

无论谁赢，冲突都会记进本次运行报告的 `conflicts[]`：

```jsonc
{
  "localId": "t-1a2b3c4d",
  "remoteId": "9f8e…",
  "winner": "local",
  "policy": "newer",
  "fields": ["title", "priority"],   // 两边不一致的字段
  "localUpdatedAt": 1764140000000,
  "remoteUpdatedAt": 1764139000000
}
```

两个细节：

- **本地赢时，远端水位线也会前进**，所以同一条冲突不会在下次同步里重复出现。如果你希望下次再争一次，改远端记录的时间戳或删掉 `state/<name>.state.json` 里的对应条目。
- 冲突的结果**不会丢数据**：输的一方只是这次不写入，值仍留在各自系统里。

### 3.3 `schedule`

```yaml
schedule:
  everyMinutes: 15
  onBoot: true
```

- 定时器**只在上一轮跑完之后才重新计时**，不会堆叠并发。同一连接器的并发 sync 请求会被合并成同一个进行中的任务。
- `everyMinutes: 0` + `enabled: true` → 不参与定时，但 `onBoot: true` 仍然会在启动时跑一次。
- 时间从插件加载时开始算，不是整点对齐。

---

## 4. `client` 块

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | 字符串 | 否 | 同 `connector.name` | 下游系统的名字。会派生成标签 `client:<slug>` |
| `priority` | 枚举 | 否 | `normal` | 新建本地待办时的缺省优先级，见 4.1 |
| `project` | 字符串 | 否 | 空 | 项目名，会派生标签 `project:<名字>`；别名 `group` |
| `tags` | 列表 / 逗号字符串 | 否 | 空 | 额外附加到每条本地待办的标签 |
| `executor` | 映射 | 是 | — | `cmd` 或 `rest`，见第 5 节 |

### 4.1 `client.priority` 只是缺省值

拉下来的记录会先看远端自己有没有优先级；没有才轮到这里。完整规则是：

1. 远端记录映射出了 `priority` → 用它，`prioritySource` 记为 `human`；
2. 否则如果远端记录有 `dueAt` → **按截止时间推算**（`priorityForDue`）：已逾期 `urgent`，48 小时内 `high`，7 天内 `normal`，更远 `low`，`prioritySource` 记为 `rule`；
3. 只有既没有优先级、也没有截止时间时，才用 `client.priority`。

也就是说，`client.priority` 不是「覆盖值」，只在信息最缺的时候兜底。

优先级取值：`urgent` / `high` / `normal` / `low`，也接受 `P0`/`P1`/`P2`/`P3` 别名（大小写不敏感）。

### 4.2 标签是怎么算出来的

每条拉下来的待办会被打上这些标签：

```
client:<client.name>   连接器所有者标签，push 时靠它筛选「这条待办归我管」
<client.tags 里的每一条>
<远端记录自己映射出来的 tags>
project:<client.project>   如果配了 project
```

`client.name` 会先 slug 化：转小写，非 `[a-z0-9._-]` 的连续字符替换成 `-`，去掉首尾 `-`，加上 `client:` 前缀，并截断到 32 字符。例如 `name: "Task Warrior 2"` → `client:task-warrior-2`。

`client.tags` 写法宽松：可以写数组，也可以写逗号分隔的字符串；开头的 `#` 会被去掉；大小写不敏感去重；最多 20 条，单条最多 32 字符。

```yaml
client:
  name: tw
  project: 工作
  tags: "taskwarrior, #gtd"
```

---

## 5. 执行器

两种：`cmd`（跑一条命令，读 stdout）和 `rest`（发一个 HTTP 请求）。

两种执行器都至少要有 `pull` 或 `push` 之一；可选 `update`。**没有 `close` 动作**——关闭/完成一条待办就是一次普通的 `push`（配了 `update` 时是 `update`），`mapping.push` 里的 `${todo.status}` 会是 `done` / `cancelled`。下游系统据此自行决定是标记完成还是走关闭接口。

三个动作可用：

| 动作 | 何时调用 |
| --- | --- |
| `pull` | pull 阶段，读远端记录 |
| `push` | push 阶段，发送**新增**的待办（没有 `update` 时也发送已关联的待办） |
| `update` | push 阶段，发送**已有远端 id** 的待办。不配 `update` 时所有待办都走 `push` 一次性批量发送 |

### 5.1 `cmd` 执行器

```yaml
client:
  executor:
    kind: cmd
    cwd: "${env:HOME}"        # 可选，命令的工作目录
    env:                       # 可选，附加环境变量
      TASKRC: /home/me/.taskrc
    pull:
      run: task status:pending export
      timeoutMs: 20000
      parse: json
      items: ""
    push:
      run: task import -
      timeoutMs: 20000
      stdin: batch
```

**执行器级字段**

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | 枚举 | 是 | — | `cmd` |
| `cwd` | 字符串 | 否 | 进程当前目录 | 工作目录，支持变量插值 |
| `env` | 映射 | 否 | 空 | 追加进子进程的环境变量，值支持变量插值 |

**动作级字段**

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `run` | 字符串 | 是 | — | 要执行的命令，经 shell 执行（`$SHELL -c`，Windows 用 `%COMSPEC% /d /s /c`）。别名 `cmd` / `command`。最长 4000 字符 |
| `timeoutMs` | 整数 | 否 | `20000` | `1000`–`600000`，超时后进程被 SIGKILL |
| `parse` | 枚举 | 否 | `json` | `json` / `ndjson` / `lines` / `text` |
| `items` | 字符串 | 否 | 空 | 点路径，从解析结果里取数组 |
| `stdin` | 枚举 | 否 | `todo` | `batch` 或 `todo`，只影响 push |
| `env` | 映射 | 否 | 空 | 只对这个动作生效的环境变量，优先级高于执行器级 `env` |

**`parse` 的语义**

| 值 | 怎么解析 stdout |
| --- | --- |
| `json` | `JSON.parse` 整个输出，得到一个值；配 `items` 就按点路径往下取数组 |
| `ndjson` | 每行一个 JSON，解析成 `{records: [...]}`；此时 `items` 必须写 `records` 才能取到数组 |
| `lines` | 按行切分，去掉空行，得到 `{records: ["…", "…"]}`；`items` 被忽略 |
| `text` | 与 `lines` 完全相同（别名） |

`items` 的点路径支持 `a.b` 和 `a.b[0].c`。留空表示「解析结果本身就是数组」。

**`stdin` 的语义**（push）

| 值 | 发到 stdin 的内容 |
| --- | --- |
| `batch` | 永远是 JSON 数组，哪怕只有一条记录 |
| `todo` | 恰好一条记录时发裸对象，多条时发数组 |

`update` 动作无论 `stdin` 写什么，都只发**单条**记录的 JSON 对象。`remoteId` 可以通过 `${remoteId}` 拼进命令或 URL。

**stdout 的处理**：上限 4 MiB，超出时保留尾部（并丢掉第一个不完整的行）；stderr 上限 64 KiB。命令退出码非 0 直接判失败，报错里带最后三行 stderr。

### 5.2 `rest` 执行器

```yaml
client:
  executor:
    kind: rest
    baseUrl: https://api.todoist.com/rest/v2
    headers:
      Authorization: Bearer ${env:TODOIST_TOKEN}
      Accept: application/json
    timeoutMs: 20000
    followRedirects: true
    pull:
      method: GET
      path: /tasks
    push:
      method: POST
      path: /tasks
      body: "${records}"
```

**执行器级字段**

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | 枚举 | 是 | — | `rest` |
| `baseUrl` | 字符串 | 是 | — | 只允许 `http://` 或 `https://`；末尾斜杠会被去掉。别名 `baseURL` |
| `headers` | 映射 | 否 | 空 | 请求头，值支持变量插值 |
| `timeoutMs` | 整数 | 否 | `20000` | `1000`–`600000` |
| `followRedirects` | 布尔 | 否 | `true` | 设成 `false` 时不自动跟随 3xx（3xx 会按失败处理，除非 `success` 里列了它） |
| `via` | 枚举 | 否 | 空 | 唯一合法值 `hub`（v2）：出站请求改经 hub 的 `POST /v1/request` 转发——SSRF 防护、`${secret:ALIAS}` 在 hub 侧解析、限流与审计。没配 hub 时使用它会**报错**（fail-fast，不静默回落直连） |

**动作级字段**

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `method` | 枚举 | 否 | `GET` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` |
| `path` | 字符串 | 否 | 空 | 拼在 `baseUrl` 后面；以 `/` 开头就直接接，否则自动补 `/` |
| `query` | 映射 | 否 | 空 | 查询参数，值必须是标量，会被转成字符串并做变量插值 |
| `headers` | 映射 | 否 | 空 | 只对这个动作生效的请求头，覆盖执行器级同名头 |
| `body` | 任意 JSON | 否 | 无 | 请求体，见下方警告 |
| `items` | 字符串 | 否 | 空 | 点路径，从响应 JSON 里取数组 |
| `timeoutMs` | 整数 | 否 | 继承执行器 | `1000`–`600000` |
| `success` | 列表 | 否 | 空 = 任意 2xx | 允许的状态码，可写数字或数字字符串，取值必须落在 `100`–`599` |

> **⚠️ REST 的 `push` / `update` 必须显式写 `body`。**
>
> 当前实现里，如果动作没写 `body:`，请求**不会带上任何请求体**（连 `Content-Type` 都没有）——即使内部已经准备好了要发送的记录。
>
> - `push` 写 `body: "${records}"`：整体单占位符，渲染后仍是数组，会被序列化成 JSON 数组。
> - `update` **不能**用 `${records}`，那个变量只在 `push` 的作用域里存在，`update` 里会渲染成空——请显式构造模板，比如 `body: { id: "${remoteId}", status: "done" }`。
>
> 这一条已经实测确认：`POST` 不带 `body:` 时服务端收到空 body；`PATCH` 写 `body: "${records}"` 会发出 `Content-Type: application/json` 加空 body。

`body` 里整个字符串是一个占位符时**保留类型**（`"${records}"` → 数组本身），混合在文本里则转成字符串（对象和数组会被 `JSON.stringify`）。没写 `Content-Type` 时，只要请求有 body，默认按 `application/json` 发送。

响应处理：状态码不在允许集合内 → `exec-failed`，错误消息里带 `HTTP <状态码> <状态文本>：<响应体前 300 字符>`；超时 → `请求超时（<N>ms）`。

---

## 6. 变量插值

YAML 里凡是字符串，基本都会在运行时渲染 `${...}` 占位符。

| 占位符 | 得到 |
| --- | --- |
| `${env:NAME}` | 进程环境变量 `NAME`；不存在时是空字符串 |
| `${secret:ALIAS}` | （v2，仅 `executor.via: hub` 时有意义）**原样透传**，占位符不动，由 hub 的 request 代理用它的 `secrets.json` 把别名换成真值。明文凭据因此不出现在插件进程里；不走 hub 时写这个占位符等于把字面量发给对方 |
| `${now}` | 当前时间的 ISO-8601 字符串 |
| `${today}` | 当前日期，`YYYY-MM-DD` |
| `${connector.*}` | 连接器自身字段，如 `${connector.name}`、`${connector.label}` |
| `${client.*}` | 下游配置，如 `${client.name}`、`${client.project}`、`${client.tags}` |
| `${todo.*}` | 本地待办字段，如 `${todo.title}`、`${todo.dueAt}`、`${todo.tags}`。**只在 `mapping.push` 模板里可用** |
| `${remoteId}` | 这条待办已关联的远端 id，没关联时是空串。`update` 动作与 `mapping.push` 里可用 |
| `${records}` | 本次要发送的记录数组。**只在 `rest` 的 `push` 动作里可用** |

**类型规则**

- 整个字符串**只有**一个占位符（`"${records}"`）→ 返回原始类型，数组还是数组、数字还是数字。
- 占位符混在文本里（`"id-${remoteId}"`）→ 拼成字符串；对象和数组会被 `JSON.stringify`。
- 取不到的路径不会报错：整值占位符得到 `undefined`，混在文本里则渲染成空字符串。

**可用范围**

`todo.*` 不在执行器的任何位置生效——待办字段只能通过 `mapping.push` 变成 payload，执行器只看到渲染后的 body / stdin。

| 场景 | 可用的根 |
| --- | --- |
| `cmd` 的 `pull` 命令 | `connector`、`client`、`now`、`today`、`env:` |
| `cmd` 的 `push` 命令 | `connector`、`client`、`now`、`today`、`env:` |
| `cmd` 的 `update` 命令 | 上面的 + `remoteId` |
| `cmd` 的 `cwd` / 执行器 `env` / 动作 `env` | 与所在动作相同 |
| `rest` 的 `pull` 的 `path` / `query` / `headers` | `connector`、`client`、`now`、`today`、`env:` |
| `rest` 的 `push` 的 `path` / `query` / `headers` / `body` | 上面的 + `records` |
| `rest` 的 `update` 的 `path` / `query` / `headers` / `body` | 上面的 + `remoteId`（**没有** `records`） |
| `mapping.push` | `todo`、`remoteId`、`client`、`connector` |
| `mapping.pull.*.path` | **不渲染**，只当作远端 JSON 的路径 |

> **⚠️ shell 命令里的 `${...}` 会被插件先吃掉。**
>
> `run:` 里的字符串在交给 shell 之前会先过一遍插值，识别的是 `${...}` 花括号形式。所以：
>
> - `echo ${HOME}` → 插值把 `${HOME}` 当成 scope 路径，取不到 → 变成 `echo `（空）。
> - `echo $HOME`（不带花括号）→ 语法上不匹配，原样交给 shell，正常工作。
> - `echo $(date +%Y)` → `$(` 不是 `${`，同样原样交给 shell。
> - `echo ${env:HOME}` → 插件先替换成真实路径，shell 再收到成品。
>
> 要传 token 之类的敏感值，用 `${env:NAME}`；要 shell 自己展开，写不带花括号的 `$NAME` 或 `$(...)`。`$$` **不会**转义成字面量 `$`，别用它。

`${env:...}` 是从插件进程的环境里读的，所以 token 建议这么放：

```yaml
headers:
  Authorization: Bearer ${env:TODOIST_TOKEN}
```

命令执行前，子进程环境会**剔除**这些变量，避免把它们泄露给用户自己写的脚本：

- 所有 `DEEPSEEK_*`
- `DSH_*TOKEN`、`DSH_*KEY`
- `OPENAI_*`、`ANTHROPIC_*`、`AWS_*`

注意这是前缀/模式匹配，不是「所有 `*_TOKEN`」。你自己设的 `TODOIST_TOKEN` 之类**不会**被剔除——这也正是 `${env:TODOIST_TOKEN}` 能生效的原因。想在 shell 里用，请显式设进 `env:`。

---

## 7. `mapping`

`mapping` 决定「远端 JSON 的哪个字段」对应「本地待办的哪个字段」。

### 7.1 两种写法

```yaml
# 写法一：平铺，等于 pull 映射（push 用默认模板）
mapping:
  id: uuid
  title: description

# 写法二：显式分开
mapping:
  pull:
    id: uuid
    title: description
  push:
    description: "${todo.title}"
```

> **两者不能混用。** 只要写了 `mapping.pull:`，平铺的那些键就**完全被忽略**（不是合并）。想要平铺 + 显式 push，请把平铺字段一起写进 `mapping.pull:` 里。

`mapping` 整块可以省略，此时十个字段都按同名直通（`id: id`、`title: title`……），push 侧用默认模板。

### 7.2 `mapping.pull`

每个字段的写法三选一：

```yaml
mapping:
  pull:
    id: uuid                          # ① 字段名
    dueAt: fields.截止时间              # ② 点路径
    description: annotations.0.description
    status:                            # ③ 带值映射
      path: status
      map:
        pending: open
        completed: done
```

- **点路径**支持 `a.b`、`a.b[0].c`，以及单独的 `.`（表示整条记录，适合 `lines` 解析出来的纯字符串）。
- **`map` 的方向固定是「远端值 → 本地值」**。没命中的值会走内置的宽松回退（见下），仍不认识就当没有这个字段。

可映射的字段只有这十个：

| 字段 | 落进本地待办的 | 说明 |
| --- | --- | --- |
| `id` | 记录关联 | **必填且不能为空**，见 7.3 |
| `title` | `title` | 最长 200 字符 |
| `description` | `description` | 最长 10000 字符 |
| `dueAt` | `dueAt` | ISO 字符串，或 Unix 秒/毫秒时间戳 |
| `status` | `status` | `open` / `doing` / `done` / `cancelled` / `archived` |
| `priority` | `priority` | `urgent` / `high` / `normal` / `low` |
| `tags` | `tags` | 数组或逗号分隔字符串；与本地已有标签**取并集**，不删 |
| `updatedAt` | 水位线 | ISO 字符串或时间戳，用来判断「哪边更新」 |
| `notes` | `notes[0]` | **只在新建时写入**，之后的变更不再同步 |
| `url` | — | **只在新建时读取，不落库**；本地记录没有 url 字段 |

写错字段名会直接报错：

```
mapping：不认识的字段 bogus（可用：id, title, description, dueAt, status, priority, tags, updatedAt, notes, url，或嵌套在 pull / push 下）
```

**状态和优先级的内置回退**（`map` 里没写、或写了的没命中时）：

| 远端值 | 本地 |
| --- | --- |
| `open` `todo` `pending` | `open` |
| `doing` `inprogress` `in-progress` `active` `blocked` | `doing` |
| `done` `completed` `complete` `closed` | `done` |
| `cancelled` `canceled` | `cancelled` |
| `archived` | `archived` |
| `p0` `urgent` `critical` `highest` | `urgent` |
| `p1` `high` | `high` |
| `p2` `medium` `normal` | `normal` |
| `p3` `low` `lowest` `none` | `low` |

回退是大小写不敏感的。`map` 里写的东西优先级高于回退。

### 7.3 `mapping.pull.id` 为什么必填

没有稳定的远端 id 就没法建立「这条本地待办 = 那条远端记录」的对应关系，每次同步都会重复新建。所以：

```yaml
mapping:
  id: ""        # ✗ 报错
```

```
mapping.pull.id：必须提供一个稳定 id 的字段路径（例如 uuid / id），否则无法幂等同步
```

不写 `mapping` 时默认路径就是 `id`。拉下来的记录如果在这个路径上是空的，这条记录会被跳过并计进报告的 `skipped`，不会静默新建一条无主待办。

### 7.4 `mapping.push`

`mapping.push` 是一棵**模板树**：你写的 JSON 结构就是发出去的 JSON 结构，每个字符串按 `${...}` 渲染。

```yaml
mapping:
  push:
    content: "${todo.title}"          # 改名
    description: "${todo.description}"
    due_datetime: "${todo.dueAt}"
    priority: "${todo.priority}"
    labels: "${todo.tags}"            # 数组保持数组
    meta:                             # 嵌套结构原样保留
      source: dsh
      localId: "${todo.id}"
```

规则：

- 整值是单个占位符时保留类型：`"${todo.tags}"` 发出去是数组；`"${todo.dueAt}"` 在 dueAt 为空时发出去是 `null`（不是空串）；取不到的字段（比如拼错成 `${todo.nope}`）整值是 `undefined`，JSON 序列化时**整个键消失**。
- 占位符混在文本里时才是字符串：`"d=${todo.dueAt}"` 在 dueAt 为空时得到 `"d="`。
- 不写 `mapping.push` 时，默认发送 `{title, description, dueAt, status, priority, tags}`，已关联的记录额外带 `id`。
- **push 不会自动反向翻译 `mapping.pull` 里的 `map`。** 你在 pull 里写 `pending → open`，push 时发出去的仍然是本地的 `open`，不是 `pending`。要发远端词汇，请在 `mapping.push` 里自己写死或另建一个连接器。这是当前实现的真实行为，不要指望它自动取反。

---

## 8. 一次同步到底做了什么

`pull`（在存储锁外执行，可能很慢）：

1. 跑 `pull` 动作，解析出远端记录数组；
2. 逐条用 `mapping.pull` 映射成本地字段；
3. 拿 `id` 去 `state/<name>.state.json` 里找已有链接：
   - 没链接 → **新建**本地待办（打上 `client:<name>` 等标签）；
   - 有链接、远端没变 → 跳过；
   - 有链接、远端变了、本地没变 → **更新**本地（只改真正变化的字段）；
   - 两边都变了 → 按 `conflict` 策略判胜负，记进 `conflicts[]`；
4. 本地有链接、但这次远端列表里没有它 → 记进 `unlinked[]`，**不删任何东西**。

`push`（同样在锁外执行）：

1. 扫所有带 `client:<name>` 标签的本地待办；
2. 其中「从没推过」或「`updatedAt` 比上次同步水位线新」的，才进候选；
3. 带 `inbox` 标签的**不推**（收件箱里还没整理的东西不上传）；
4. 按 `limits.maxPush` 截断；
5. 有 `update` 动作时，已关联的走 `update`、新的走 `push`；没有 `update` 时全部走一次批量 `push`；
6. 成功后只**前进水位线**，不改写待办的 `updatedAt`（那是用户编辑时间）。

**幂等性**：同一份远端数据连续拉两次，第二次 `created: 0, updated: 0`。判断依据是状态文件里的两条时间水位线（上次同步时本地的 `updatedAt`、远端的 `updatedAt`）。

**绝不隐式删除**：任何一边删了记录，另一方都不会跟着删。远端删了只会出现在报告的 `unlinked` 里，本地待办原样保留（它的 `client:` 标签也保留，下次 push 可能把它重新推回去——如果不想要，请手动改标签或状态）。

**`dryRun` 的真实语义**：`dsh_connector_sync` 的 `dryRun: true` 只跳过**写盘**（不改 `todos.json`、不改状态文件）。`pull` 命令/请求**仍然会执行**（它会真的去读远端，甚至可能有副作用），`push` 则整个跳过、不发任何请求。把它当成「预演要改多少条、要推几条」，不要当成「完全没有副作用」。

### 运行报告

```jsonc
{
  "connector": "taskwarrior",
  "label": "TaskWarrior",
  "direction": "both",
  "dryRun": false,
  "reason": "tool",              // tool / manual / schedule / boot / api
  "startedAt": 1764140000000,
  "finishedAt": 1764140000420,
  "durationMs": 420,
  "parts": [ /* 每个方向一个 */ ],
  "created": 2,
  "updated": 1,
  "conflicts": 0,
  "pushed": 3,
  "unlinked": 1
}
```

`reason` 说明这次是谁触发的：工具调用是 `tool`，定时器是 `schedule`，启动是 `boot`，HTTP 接口是 `api`，直接调用是 `manual`。

---

## 9. 完整示例

### 9.1 TaskWarrior（`cmd`，双向）

仓库里的 `examples/taskwarrior.yaml`：

```yaml
version: 1

connector:
  name: taskwarrior
  label: TaskWarrior
  enabled: false
  direction: both
  conflict: newer
  schedule:
    everyMinutes: 15
    onBoot: true
  limits:
    maxPull: 200
    maxPush: 200

client:
  name: taskwarrior
  priority: normal
  project: inbox
  tags:
    - taskwarrior
  executor:
    kind: cmd
    pull:
      run: task status:pending export
      timeoutMs: 20000
      parse: json
    push:
      run: task import -
      timeoutMs: 20000
      stdin: batch

mapping:
  pull:
    id: uuid
    title: description
    description: annotations.0.description
    status:
      path: status
      map:
        pending: open
        waiting: doing
        completed: done
        deleted: cancelled
    priority:
      path: priority
      map:
        H: urgent
        M: high
        L: low
    tags: tags
    dueAt: due
    updatedAt: modified
  push:
    description: "${todo.title}"
    status:
      pending: "${todo.status}"
    priority: "${todo.priority}"
    due: "${todo.dueAt}"
    tags: "${todo.tags}"
```

两个实测过的坑：

- TaskWarrior 原生日期是 `20261130T160000Z`，**`Date.parse` 认不出来**，`dueAt` 会是 `null`。需要先把日期转成 ISO，用 `jq` 洗一遍：

  ```yaml
  run: task status:pending export | jq -c 'map(if .due then .due |= (strptime("%Y%m%dT%H%M%SZ") | strftime("%Y-%m-%dT%H:%M:%SZ")) else . end)'
  ```

- `task import -` 收到空字符串的 `due` 或 `status: open` 时会**静默地什么都不导入**（退出码 0）。所以 `mapping.push` 里不要塞 `status`，除非你确认取值合法。

### 9.2 Todoist（`rest`，双向）

`examples/todoist.yaml` 的骨架：

```yaml
version: 1

connector:
  name: todoist
  label: Todoist
  enabled: false
  direction: both
  conflict: newer
  schedule:
    everyMinutes: 30
  limits:
    maxPush: 100

client:
  name: todoist
  project: inbox
  executor:
    kind: rest
    baseUrl: https://api.todoist.com/rest/v2
    headers:
      Authorization: Bearer ${env:TODOIST_TOKEN}
      Accept: application/json
    pull:
      method: GET
      path: /tasks
    push:
      method: POST
      path: /tasks
      body: "${records}"          # 必须写，见 5.2 的警告

mapping:
  pull:
    id: id
    title: content
    dueAt: due.datetime
    status:
      path: checked
      map:
        false: open
        true: done
    priority:
      path: priority
      map:
        "1": low
        "2": normal
        "3": high
        "4": urgent
    tags: labels
```

注意 `map` 的键是远端值，YAML 里 `true`/`false`/数字都建议加引号写成字符串，避免被 YAML 解析成布尔或整数后跟远端返回的字符串对不上。

### 9.3 飞书 / 钉钉（走现成的 CLI）

飞书、钉钉这类系统通常已经有内部 CLI，最省事的接法是让 CLI 输出 JSON，用 `cmd` 执行器接住——YAML 里不需要任何 HTTP 细节。

```yaml
version: 1

connector:
  name: feishu
  label: 飞书任务
  enabled: false
  direction: pull
  conflict: remote
  schedule:
    everyMinutes: 15
    onBoot: true

client:
  name: feishu
  priority: normal
  project: 工作
  tags:
    - feishu
  executor:
    kind: cmd
    pull:
      run: feishu-tasks --format json
      timeoutMs: 30000
      parse: json

mapping:
  pull:
    id: record_id
    title: fields.任务名称
    description: fields.描述
    dueAt: fields.截止时间
    status:
      path: fields.状态
      map:
        未开始: open
        进行中: doing
        已完成: done
        已取消: cancelled
    priority:
      path: fields.优先级
      map:
        紧急: urgent
        高: high
        中: normal
        低: low
    tags: fields.标签
    updatedAt: last_modified_time
```

飞书只拉不推（`direction: pull`），因为往共享任务表里写通常是人的决定。仓库里的 `examples/feishu.yaml` 就是这样。

钉钉如果走 REST，可以这样配（`examples/dingtalk.yaml`）：

```yaml
client:
  executor:
    kind: rest
    baseUrl: https://api.dingtalk.com
    headers:
      x-acs-dingtalk-access-token: ${env:DINGTALK_TOKEN}
      Content-Type: application/json
    pull:
      method: POST
      path: /v1.0/todo/users/me/workspaces
      query: {}
      body:
        pageSize: 100
      success:
        - 200
```

`success` 允许放宽接受的状态码；钉钉有些接口在业务失败时也返回 200，此时需要在 `mapping` 或下游脚本层面判断，插件只看 HTTP 状态码。

上面这段没有写 `items`，意味着假设响应体本身就是记录数组。钉钉实际返回的通常是 `{"workItems": [...]}` 这种包了一层的对象——那就补一行 `items: workItems`（放在 `pull` 动作里），否则会报 `items 路径 "(根)" 指向的不是数组`。

### 9.4 只推不拉（`push`）

```yaml
version: 1

connector:
  name: notes
  label: 本地笔记
  enabled: false
  direction: push
  conflict: local
  schedule:
    everyMinutes: 0        # 不定时，只手动
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
    dueAt: "${todo.dueAt}"
    updatedAt: "${todo.updatedAt}"
```

---

## 10. 校验与常见报错

写完之后先用 `dsh_connector_validate` 过一遍。它返回：

```jsonc
// 通过
{ "ok": true, "valid": true, "connector": { "name": "notes", "direction": "push", "executor": "cmd", "tag": "client:notes", "requiresPull": false, "requiresPush": true, "pullFields": [...] } }

// 不通过 —— 注意 ok 仍然是 true，靠 valid 判断
{ "ok": true, "valid": false, "reason": "invalid-connector", "error": "mapping.pull.id：必须提供一个稳定 id 的字段路径（例如 uuid / id），否则无法幂等同步", "field": "mapping.pull.id" }
```

`field` 会精确指到出错的字段路径，照着改就行。

### 报错速查

| reason | 触发场景 | 怎么办 |
| --- | --- | --- |
| `invalid-yaml` | YAML 语法错：Tab 缩进、多文档、锚点/别名/标签 | 用空格缩进；一个文件只写一个文档；不要用 `&` `*` `!` |
| `invalid-connector` | 字段缺失、枚举写错、数值越界 | 看 `field` 和 `error`，多半是拼写或范围问题 |
| `invalid-name` | 名字不合法（**当前版本不会抛这个 reason**：名字校验走 `invalid-connector` 的 `connector.name` 字段错误；`invalid-name` 只存在于 HTTP 状态码映射表里） | 只能是小写字母/数字/`._-`，字母或数字开头 |
| `invalid-body` | 走 HTTP 接口时请求体不是合法 JSON 对象 | 检查 content-type 和 JSON 语法 |
| `not-found` | 指定的连接器文件不存在 | `dsh_connector_list` 看看到底有哪些 |
| `payload-too-large` | 请求体超 1 MiB / YAML 超 1 MiB | 拆文件或精简内容 |
| `exec-failed` | 命令退出码非 0，或 HTTP 状态码不在允许列表 | 看错误里的 stderr 尾部或 HTTP 状态与响应体 |
| `invalid-remote` | 远端记录缺少 `mapping.pull.id` 指向的字段 | 改映射路径，或让下游输出稳定 id |
| `store-busy` | 5 秒内拿不到 `todos.json.lock` | 通常是别的东西正在写存储；等一下重试 |
| `store-corrupt` | `todos.json` 不是合法 JSON，或 schema 版本高于 2 | 不要删文件；先备份，再人工修或移走 |
| `store-unwritable` | 存储文件/目录不可写 | 检查权限与磁盘 |
| `hub-unavailable` | 配了 hub 但连不上 / 没配 hub 却调了 hub 操作 | 检查 `hub.url`、网络、hub 进程 |
| `lease-held` | hub 上该连接器的租约被别的实例持有 | 等租约过期，或去 hub 上释放 |
| `revision-conflict` | 向 hub 写连接器时 revision 不匹配 | 拉最新的再改，或用 `force` |

### 字段级报错原文

下面这些都是实际会出现的消息，方便直接搜索：

```
connector.name：只能包含小写字母、数字、点、下划线和短横线，并以字母或数字开头
connector.direction：只能是 pull / push / both
connector.conflict：只能是 newer / remote / local
connector.schedule.everyMinutes：必须是 0–10080 之间的整数
connector.limits.maxPull：必须是 1–2000 之间的整数
client.executor.kind：只能是 cmd / rest
client.executor.pull.run：必填（要执行的命令）
client.executor.pull.parse：只能是 json / ndjson / lines / text
client.executor.pull.timeoutMs：必须是 1000–600000 之间的整数
client.executor.baseUrl：必填
client.executor.baseUrl：只支持 http:// 或 https://
client.executor.pull.method：只能是 GET / POST / PUT / PATCH / DELETE
client.executor.pull.success：HTTP 状态码必须是 100–599 的整数（读到 "abc"）
client.executor.headers.bad header：HTTP 头名字不合法：bad header
优先级只能是 urgent / high / normal / low（或 P0–P3），收到 super
mapping.pull.status.map.OPEN：映射目标必须是字符串
cmd 执行器至少要有一个 pull 或 push 动作
rest 执行器至少要有一个 pull 或 push 动作
版本 2 高于本插件支持的 1，请升级插件
连接器文件必须是一个映射
YAML 不允许用 Tab 缩进，请改用空格（第 3 行）
```
