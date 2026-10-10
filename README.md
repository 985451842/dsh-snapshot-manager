# dsh-snapshot-manager

DeepSeek Harness（DSH）桌面版插件：**会话快照 / 回滚** + **归档会话管理**。

- 每个轮次**开始前**自动对工作区做一次**增量文件快照**（内容寻址存储，同一内容只存一份）——回滚语义统一为"回到本轮之前"，所以每轮只留一条快照。
- 发现连续对话最后结果不对时，可以从任一快照**回滚**：文件恢复 + 通过 `sessionController.fork(atSeq)` 把对话退回到该时点（原会话完整保留），并可把**编辑后的输入**自动发进新会话继续。
- **归档列表**在「设置」里：归档会话的列表 / 关键词搜索 / 取消归档 / **删除**（回收站，可还原）/ **物理删除**（连带清掉该会话的快照记录），另有回收站与快照垃圾清理。

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

开发模式会额外写入 `config.devChannelDir`，用于开发期的文件命令通道；发布模式不写。

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
  trash/<folder>/                回收站里的会话日志目录
  trash/index.json               回收站清单
```

快照只存"与上一个快照的差异"，`checkpointEvery` 个之后写一次全量；还原时沿链回溯即可得到任意时点的完整路径表。

## HTTP 接口

都注册在 DSH 已鉴权的共享 fetch 通道上（`ctx.connection.fetch.register`），前缀 `/api/snapshot-manager/v2`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping`、`/status` | 自检 |
| GET | `/snapshots?sessionId=` | 快照时间线 |
| GET | `/preview?sessionId=&snapshotId=` | 干跑预览（将恢复/删除哪些文件、对话切点） |
| POST | `/restore` | `{sessionId, snapshotId, files, conversation, promptText, dryRun}` |
| POST | `/capture` | 手动打快照 |
| DELETE | `/snapshot?sessionId=&snapshotId=` | 删除某条快照 |
| GET | `/archived` | 归档会话列表 |
| GET | `/searchArchived?q=` | 在归档会话里搜索 |
| GET | `/transcript?sessionId=&limit=` | 只读对话记录 |
| POST | `/archive`、`/unarchive` | 归档 / 取消归档 |
| GET/POST | `/trash` | 回收站列表 / 移入回收站（可还原） |
| POST | `/trash/restore`、`/trash/purge` | 还原 / 彻底删除回收站条目 |
| POST | `/delete` | **物理删除**：`{sessionId, confirm:true, force?}`，日志直接从磁盘抹掉（连带该会话的快照记录） |
| POST | `/pruneArchived` | **物理清理归档标记**：移除"日志已不存在"的残留归档标记 |
| POST | `/pruneSnapshots` | 删除孤立快照（会话已不存在且不在回收站）+ 归并遗留的工作区索引 key |
| POST | `/gc` | 回收没有任何快照记录引用的内容对象 |
| GET | `/diagnose?sessionId=` | 诊断：该会话还被哪些地方记着（归档集合 / 工作区记账 / 持久化 / 内存 Agent / 控制器行） |
| GET | `/beacon` | 客户端挂载信标（诊断用） |

## 删除会话的三档语义

DSH **没有**删除会话的官方 API，所以这里明确分成三档，按需要挑：

| 操作 | 归档标记 | 日志文件 | 可恢复性 |
|---|---|---|---|
| 删除（移入回收站） | **物理移除** | 移到 `trash/<folder>/` | 可还原到原位置 |
| 彻底删除（回收站内） | 再次确保移除 | 从 `trash/` 抹掉 | 不可恢复 |
| **物理删除**（归档列表里一步到位） | **物理移除** | **直接从 `sessions/` 抹掉** | 不可恢复 |

三档都会同时解除工作区记账、清掉投影缓存；**物理删除**还会连带删掉该会话自己的快照记录。

### 维护

界面上「🗂 归档」面板右上角有 **清理快照垃圾**，等价于依次调用：

```
POST /pruneSnapshots   # 删除孤立快照（会话已不存在且不在回收站）+ 归并遗留的工作区索引 key
POST /gc               # 回收没有任何快照记录引用的内容对象
```

工作区索引 key 由**规范化路径**（`path.resolve`）生成，并在每次插件挂载时自愈归并——
所以 `D:\a\b` 与 `D:/a/b` 不会再分裂成两把 key（否则回滚会拿错基线）。

**一个重要副作用（官方限制，不是本插件的 bug）**：如果某个会话此刻仍以 Agent 形式**加载在内存里**，
那么即使日志、标记、记账都清干净了，客户端的会话列表仍会记得它，直到该会话被卸载或**重启应用**。
原因：`Agent` 接口只有 `{ id }`，没有任何释放方法；`AgentHandle.dispose()` 属于创建者（agent loop），
第三方插件拿不到。`/diagnose` 可以确认到底是不是这个原因：

```jsonc
// GET /api/snapshot-manager/v3/diagnose?sessionId=session-xxxx
{
  "inArchivedSet": false, "inWorkspaceAccounting": [], "inPersistence": false,
  "liveAgent": true,                    // ← 若为 true，列表里的那一行就来自这里
  "controllerRow": { "running": false, "agentAvailable": true },
  "logDir": null
}
```


## 界面入口

| 位置 | 内容 |
|---|---|
| 会话头部 | 「⏱ 快照」时间线面板 |
| **设置 → 归档列表** | 归档会话管理器（注册在 `settings.section`，`id: snapshot-archive`，默认排在第 30 位）：搜索 / 取消归档 / 删除（回收站）/ 物理删除，含回收站与快照垃圾清理 |
| 每轮对话尾部 | 「✎ 编辑并重来」（打开时间线面板并展开本轮那条快照的回滚视图） |
| 快照面板行内 | 预览 / 回滚（可勾选恢复文件、回退对话，是否把输入发进新会话）/ 删除 |

## 快照模型：每轮一条

回滚语义统一为「**回到本轮之前**」，所以每个轮次只留一条快照（`phase: 'start'`，在 `turn/start` 采集），
它同时是"这一轮改变之前"的完整状态。相邻轮次之间若发生了带外改动（手改文件、构建、另一会话），
下一轮的起点快照会如实记录这些改动——不需要额外一条"结果"快照来代表它们。

- **基线**（`phase: 'baseline'`）：仅当插件在某会话中途才挂上、该会话一条记录都没有时补一条，
  保证正在跑的这一轮也有还原点。
- **旧模型的"结果"快照**（`phase: 'end'`）不再新增；历史记录保留在库里，时间线默认折叠，
  勾选「显示结果快照」可查看。
- **手动**（`phase: 'manual'`）与**回滚前**（`phase: 'pre-rollback'`）不受影响。

## 安全边界与已知限制

- 回滚**只处理快照跟踪过的路径**：被排除目录（`node_modules`、`target`、`.git` 等）与从未纳入快照的文件绝不触碰。
- "快照之后新建的文件"会在回滚时被删除（这正是"回到那一刻"的语义）；预览会明确列出，确认后才执行。
- 回滚对话采用 **fork 新会话**，DSH 的会话日志是只追加的，不支持就地截断或改写历史；原会话始终保留。
- 删除会话属于带外维护（官方没有删除 API）：本插件默认**先移入回收站**（可还原），
  也提供**一步物理删除**；两者都会物理移除归档标记。「彻底删除」与「物理删除」需二次确认，
  运行中的会话会被拒绝删除。
- **删掉后列表里可能仍有那一行**：只要该会话还以 Agent 形式加载在内存里，客户端就会记得它
  （`Agent` 没有任何释放接口，第三方插件无法强制卸载）。刷新页面或重启应用后消失；
  用 `/diagnose` 可确认。日志、归档标记、工作区记账、投影缓存都已真正清除。
- 首次采集是整工作区基线（本仓库实测约 1800 个文件、扫描+哈希约 1 秒、落盘约 5 秒）；
  之后每轮增量为 0.2～1 秒（只哈希真正变化的文件）。
- 需要模型继续生成时，若账号额度不足，新会话的回合会以 provider 错误结束——那是模型侧问题，与插件无关。

## 开发说明

- `lib/host.js`：Host 半边实现（单文件，避免 `?rev=` 动态 import 时的相对 import 缓存问题）。
- `lib/bootstrap.js`：仅开发模式使用的稳定入口，按内容哈希 `import('./host.js?rev=…')` 实现改完即生效。
- `lib/client.js`：浏览器半边（手写 bundle，只用 `react` / `react/jsx-runtime` 两个平台 seed，UI 全部走主题变量）。
- 代码中以 `DEV-ONLY` 标注的探针、启动标记与开发命令通道，均可安全地随发布副本一起存在：
  它们只在配置显式给出 `devChannelDir` 时才会启用。
