# dsh-snapshot-manager

DeepSeek Harness（DSH）桌面版插件：**会话快照 / 回滚**。

- 每个轮次**开始前**自动对工作区做一次**增量文件快照**（内容寻址存储，同一内容只存一份）——回滚语义统一为"回到本轮之前"，所以每轮只留一条快照。
- 发现连续对话最后结果不对时，可以从任一快照**回滚**：文件恢复 + 通过 `sessionController.fork(atSeq)` 把对话退回到该时点（原会话完整保留），并可把**编辑后的输入**自动发进新会话继续。
- 快照库维护：面板右上角「**清理快照垃圾**」删除孤立快照（会话日志已不存在）、回收没有任何快照引用的内容对象，并归并历史遗留的非规范化工作区索引 key。

纯 JavaScript，无构建步骤；Host 半边只用 Node 内置模块（不 import 任何 `@deepseek-ai/*` 包），Client 半边是手写的 `window.__ModuleLoader__` bundle。

## 安装

### 方式一：官方插件命令（推荐）

```bash
# 从 npm 安装（包发布后）
dsh plugin --profile web add dsh-snapshot-manager

# 或直接从 GitHub 安装
dsh plugin --profile web add github:985451842/dsh-snapshot-manager
```

该命令会把包安装进 profile 的 `node_modules` 并写入 `package.json` 的 `dsh.profile.bundles`；
加载器随后把**包内自带的 `cordis.patch.yml`** 当作一层 bundle 合成进插件树 —— 无需手工编辑 profile 补丁。

包内声明（官方约定）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [] }
}
```

`cordis.patch.yml` 只有两行，`name` 用**裸包名**（由 profile 的 `node_modules` 解析）：

```yaml
- insert:
    - id: snapshot-manager
      name: 'dsh-snapshot-manager'
```

> 装好后若插件未出现，重启一次应用；**改过 Host 代码后**同样需要重启（或在设置里禁用/启用一次该条目）才会重新加载。

### 方式二：本地脚本（开发 / 免发布）

> **插件源码位置**：本目录（`D:\javaProject\dsh\dsh-snapshot-manager`）是插件的唯一开发工作区，
> 后续所有插件改动都在这里完成并提交。

```powershell
# 发布模式：自包含安装到 $DSH_HOME\plugins\dsh-snapshot-manager
pwsh -File install.ps1 -Release

# 开发模式：入口指向本目录的 lib\bootstrap.js，改完 host.js 约 1 秒生效
pwsh -File install.ps1 -DevFromWorkspace
```

脚本会在 `$DSH_HOME\profiles\desktop\cordis.patch.yml` 里维护一段受管块（首次修改前自动备份为
`cordis.patch.yml.bak-snapshot-manager`）：

```yaml
# >>> dsh-snapshot-manager (managed by install.ps1) >>>
- insert:
    - id: snapshot-manager
      name: 'C:/Users/<you>/.dsh/plugins/dsh-snapshot-manager/lib/host.js'
# <<< dsh-snapshot-manager <<<
```

开发模式会额外写入 `config.devChannelDir`（默认 `D:/javaProject/dsh/.dsh-probe/plugin-dev`，
随工作区走），用于开发期的文件命令通道；发布模式不写。

### 生效方式

- 新增/修改补丁行由 DSH 的 HMR 实时重组，通常**不需要重启应用**。
- 客户端 bundle 由 `dsh.client` + `exports["./client"]` 走官方通道提供，`dsh-client-hmr` 每 500ms 轮询，
  改完 `lib/client.js` 后**无需刷新页面**即会热替换（也可手动刷新）。
- 若某次改动未能生效（例如模块被 Node 缓存），可重跑一次 `install.ps1`，或在设置里禁用/启用该插件条目。

## 配置

在补丁行的 `config` 下传入（全部可选）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/snapshot-manager` | 快照库根目录 |
| `captureOnTurnStart` | `true` | 轮次开始采集（**每轮唯一的那条快照**，"回到本轮之前 / 编辑并重来"依赖它） |
| `captureOnTurnEnd` | `true` | 轮次结束时的**兜底基线**：仅当该会话一条快照都没有时才补一条（插件在会话中途才挂上时用），不会每轮新增记录 |
| `excludes` | 见 `DEFAULT_EXCLUDES` | 按路径段排除的目录名 |
| `excludeExtensions` | 见 `DEFAULT_EXCLUDE_EXTENSIONS` | 按扩展名排除 |
| `maxFileBytes` | 8 MiB | 单个文件超过则不纳入快照 |
| `maxSnapshotsPerSession` | 200 | 每会话保留快照数，超出从最旧回收 |
| `checkpointEvery` | 20 | 每多少个快照写一次全量记录（限制链式回溯长度） |
| `scanTimeoutMs` | 60000 | 单次扫描超时 |
| `devChannelDir` | 空 | **开发期专用**：命令通道目录；发布时不要设置 |

## 存储结构

```
$DSH_HOME/snapshot-manager/
  index/<workspaceKey>.json      工作区扫描索引：relPath -> {size, mtimeMs, hash}
  objects/<h2>/<hash>            文件内容对象（内容寻址，天然去重）
  sessions/<sessionId>/<id>.json 快照记录：{phase, turn, seq, forkSeq, parent, full, changes}
```

快照只存"与上一个快照的差异"，`checkpointEvery` 个之后写一次全量；还原时沿链回溯即可得到任意时点的完整路径表。

## HTTP 接口

都注册在 DSH 已鉴权的共享 fetch 通道上（`ctx.connection.fetch.register`），前缀 `/api/snapshot-manager/v3`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping`、`/status` | 自检 |
| GET | `/snapshots?sessionId=` | 快照时间线 |
| GET | `/preview?sessionId=&snapshotId=` | 干跑预览（将恢复/删除哪些文件、对话切点） |
| POST | `/restore` | `{sessionId, snapshotId, files, scope, conversation, promptText, dryRun}`（`scope` 取 `'all'`（默认）或 `'session'`） |
| POST | `/capture` | 手动打快照：`{sessionId, label?}`。**不需要传 cwd** —— 客户端只发 sessionId，工作目录由 Host 解析 |
| DELETE | `/snapshot?sessionId=&snapshotId=` | 删除某条快照 |
| POST | `/pruneSnapshots` | 删除孤立快照（会话日志已不存在）+ 归并遗留的工作区索引 key |
| POST | `/gc` | 回收没有任何快照记录引用的内容对象 |
| GET | `/beacon` | 客户端挂载信标（诊断用） |

## 维护

快照面板右上角有 **清理快照垃圾**，等价于依次调用：

```
POST /pruneSnapshots   # 删除孤立快照（会话日志已不存在）+ 归并遗留的工作区索引 key
POST /gc               # 回收没有任何快照记录引用的内容对象
```

工作区索引 key 由**规范化路径**（`path.resolve`）生成，并在每次插件挂载时自愈归并——
所以 `D:\a\b` 与 `D:/a/b` 不会再分裂成两把 key（否则回滚会拿错基线）。

## 界面入口

| 位置 | 内容 |
|---|---|
| 会话头部 | 「⏱ 快照」时间线面板 |
| 每轮对话尾部 | 「✎ 编辑并重来」（打开时间线面板并展开本轮那条快照的回滚视图） |
| 快照面板行内 | 回滚…（展开后：☑ 恢复文件 → 可选「只恢复本次会话修改的文件」、☑ 回退对话、可选把输入发进新会话）/ 删除 |
| 快照面板右上角 | 「清理快照垃圾」（孤立快照 + 无引用对象 + 索引 key 归并） |

## 快照模型：每轮一条

回滚语义统一为「**回到本轮之前**」，所以每个轮次只留一条快照（`phase: 'start'`，在 `turn/start` 采集），
它同时是"这一轮改变之前"的完整状态。相邻轮次之间若发生了带外改动（手改文件、构建、另一会话），
下一轮的起点快照会如实记录这些改动——不需要额外一条"结果"快照来代表它们。

### 位置锚点：锚在提问上，不是 turn/start 上

采集时机是 `turn/start`（此刻文件还是本轮改动之前的干净状态），但**位置与说明**都锚在紧随其后的
那条**真实用户提问**上。原因是 `turn/start` 比提问早几个事件（实测 seq 282 vs 285，中间夹着
`agent/inbox/spliced`）；若直接用 `turn/start` 的 seq，快照会显示在「上一轮回复之后、本次提问之前」，
既不是提问起点也不是上一轮终点。

判定「真实提问」看 `data.source.kind === 'user'`：DSH 会在轮次前后注入大量同样是 `user/message` 的
消息（`runtime-context`、`skill-catalog`、`agent-instructions`、`tool-jobs`、`subagent-settled`、
`plugin`、`goal`…，本机 1000+ 条里只有 835 条是 `user`）。这些不是"用户在问什么"，绝不能拿来当
本轮提问——否则首个快照没有说明（列表里显示「—」），后续快照的说明会变成上一轮提问甚至
"Current runtime context. …" 这类注入文本。同一轮里若有多条真实提问（排队输入、追加指令），
以**第一条**代表本轮。

因此一条起点快照记录两个位置 + 一个说明，含义不同：

- `seq`：本次提问的序号——**时间线显示位置**（"从这里开始问的"）。
- `label`：本次提问的文本——列表里的「说明」，也是「编辑并重来」的预填文本。
- `forkSeq`：本轮之前最后一次 `turn/end`——**对话回退切点**。回滚 fork 出的新会话保留到 `forkSeq` 为止，
  即**不包含**本次提问，所以你可以在新会话里改完再发。

打开面板（`GET /snapshots`）或做回滚预览（`GET /preview`）时，会对该会话做一次
**起点快照锚点/说明自愈**（`repairStartLabels`，每代只做一次，幂等）：按 `turn/start` 切分轮次，
把每条 `start` 快照的 `seq`/`label` 修正到该轮第一条真实提问上。判定不靠猜——轮号对不上、
或 seq 与任何提问都不相等时一律跳过，绝不用"上一条提问"顶替。

- **基线**（`phase: 'baseline'`）：仅当插件在某会话中途才挂上、该会话一条记录都没有时补一条，
  保证正在跑的这一轮也有还原点。
- **旧模型的"结果"快照**（`phase: 'end'`）不再新增也不再展示；历史记录仍留在库里（回滚时按轮号兜底可见）。
- **手动**（`phase: 'manual'`）与**回滚前**（`phase: 'pre-rollback'`）不受影响。

### 工作目录是怎么解析出来的

自动采集拿到的是 DSH 给的真实 Session，`header.cwd` 天然存在；但**手动打快照、预览、回滚**只有
`sessionId`，所以 Host 按下面顺序解析工作目录（`resolveSessionCwd`）：

1. **缓存**：采集过、或见过该会话事件时记下的 `header.cwd`（事件监听里顺手缓存）。
2. **`sessionController.inspect(sessionId)`**：读持久化的会话 header（不激活 Agent），
   供"插件还没见过这个会话"的情况兜底。
3. 都拿不到才报错，且给的是可操作提示：「请先在这个会话里发一条消息（让插件看到它的工作区）」。

> 早期版本由客户端在 `POST /capture` 里带 `cwd`，客户端只发 `sessionId` 时就会失败并弹出
> 「该会话没有工作目录，跳过采集」。现在 cwd 一律由 Host 解析，客户端不必也不应传路径。

### 文件恢复范围：全量 / 只恢复本次会话修改的文件

回滚的差异是「快照目标状态 vs 当前工作区实况」逐路径比出来的，因此**快照之后发生的一切改动都会被算进去**——
包括 git merge/pull/checkout、IDE 手改、构建等**带外改动**。这类改动不属于任何对话轮次，
所以你在快照列表里看不到它们，但回滚清单里会出现（实测一例：某快照自身只记了 3 个变化，
预览却列出"恢复 25 / 删除 24"，全部来自快照之后的一次 `git merge`）。

面板上的选项是两级：

```
☑ 恢复文件   ☐ 只恢复本次会话修改的文件   ☑ 回退对话（生成新会话）
将恢复 2   将删除 0   保持不变 1   将清理空目录 1
```

- **恢复文件**：总开关。不勾选就只回退对话，不碰任何文件。
- **只恢复本次会话修改的文件**：勾选①后才出现。不勾选 = **全量**（默认），
  完整还原到该时点；勾选 = 只动本会话自己写过的路径。
- 下面的「将恢复 / 将删除 / 保持不变 / 将清理空目录」**随所选范围实时变化**
  （计数来自同一次扫描，切换不需重新请求）；只回退对话时这一行不显示。

| 范围 | 语义 | 代价 |
|---|---|---|
| **全量**（默认） | 完整还原到该时点：带外改动也会被还原或删除 | 可能覆盖你在快照之后的开发工作 |
| **只恢复本次会话修改的文件** | 只动本会话自己 `write`/`edit` 写过的路径 | **可能残留**：经 `pwsh`、构建、子代理产生的改动抓不到（这些会**列在回滚报告里**，见下） |

- 收窄范围靠的是事件流里 `tool/call` 的参数路径，覆盖 `write` / `edit` 以及有修改作用的
  `str_replace_editor`（`create`/`str_replace`/`insert`；`view` 是只读，不计入），
  并且会过滤掉工作区之外与排除规则命中的路径。
- 这份记录**落盘保存**在 `<存储根>/journal/<会话id>.jsonl`（每行一个相对路径，追加写），
  因此**跨插件热重载与应用重启存活**——否则重开面板时该选项会因为"没有记录"而不可用。
  存储根默认在 `$DSH_HOME/snapshot-manager`，不写进工作区，也不随工作区快照回滚。
- **已知不完整**：经 `pwsh` 等终端命令、构建、子代理产生的改动抓不到（这些没有文件路径参数）。
  DSH 自带的 `workspaceChanges` 服务能覆盖这些情况，但它比对的是每轮 `turn/start`→`turn/end`
  之间的工作区快照，会把该窗口内的**外部改动一并算进去**——与"只保留本会话改的"目标相反，
  因此这里没有采用它。
- **默认必须是全量**：如果默认收窄，遇到"想连带撤掉带外改动"的情况会静默不生效；
  全量最坏只是多做一点，且回滚前有自动 `pre-rollback` 恢复点兜底。
- 该范围**抓不到**经 shell 命令、构建、子代理产生的改动，所以是**可选项而非默认**。
- 两个范围都不因"暂时没有差异"而禁用，这样你可以切换着看两边各要动多少。
- 回滚写入前会校验目标路径仍落在工作区内，越界路径跳过并记入报告警告。

### 目录也会回滚：只收「快照之后新建、且已经空了」的目录

快照只记录文件，所以早先的回滚**只删文件、不删目录**：上一轮搭出来的 `tools/ghx/`、
`tools/ghx/lib/` 会原地留下空壳，看起来就像根本没回滚。现在删完文件后会再走一遍 `rmdir`
（自深到浅），判定条件两条，缺一不可：

1. 该目录在快照时点**并不存在**（由"当时存在的、被跟踪的文件路径"反推出来的目录集合判定）；
   快照时就有的目录一律不动。
2. 删完之后目录下**不再有任何文件存活**——只要还剩一个（本次范围不删的、删不掉而残留的、
   或 `node_modules` 这类被排除的内容），整个目录就原样保留。

因此：

- 全量回滚会把上一轮新建的整棵目录树收干净（前提是里面的文件都在本次删除清单里）；
- 勾了「只恢复本次会话修改的文件」时，范围外的文件（工具运行时自己写的缓存等）会留下，
  它们所在的目录也随之保留——**这是范围本身的语义，不是目录回滚失效**。
- 预览里会用「将清理空目录 N 个」预告这次会收掉多少个目录；回滚报告里给出实际清理的数量。

## 安全边界与已知限制

- 回滚**只处理快照跟踪过的路径**：被排除目录（`node_modules`、`target`、`.git` 等）与从未纳入快照的文件绝不触碰。
- "快照之后新建的文件"会在回滚时被删除（这正是"回到那一刻"的语义）；预览会明确列出，确认后才执行。
- 目录**只删空的**，且只删"快照时点并不存在"的目录；非空目录（含被排除内容、或本次范围不删的残留）
  一律保留，不会递归删除目录里的东西。
- 回滚对话采用 **fork 新会话**，DSH 的会话日志是只追加的，不支持就地截断或改写历史；原会话始终保留。
- 首次采集是整工作区基线（本仓库实测约 1800 个文件、扫描+哈希约 1 秒、落盘约 5 秒）；
  之后每轮增量为 0.2～1 秒（只哈希真正变化的文件）。
- 需要模型继续生成时，若账号额度不足，新会话的回合会以 provider 错误结束——那是模型侧问题，与插件无关。

## 开发说明

- `lib/host.js`：Host 半边实现（单文件，避免 `?rev=` 动态 import 时的相对 import 缓存问题）。
- `lib/bootstrap.js`：仅开发模式使用的稳定入口，按内容哈希 `import('./host.js?rev=…')` 实现改完即生效。
- `lib/client.js`：浏览器半边（手写 bundle，只用 `react` / `react/jsx-runtime` 两个平台 seed，UI 全部走主题变量）。
- 代码中以 `DEV-ONLY` 标注的探针、启动标记与开发命令通道，均可安全地随发布副本一起存在：
  它们只在配置显式给出 `devChannelDir` 时才会启用。
