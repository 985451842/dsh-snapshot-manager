/**
 * dsh-snapshot-manager — Host 半边实现（单文件，无相对 import）。
 *
 * 为什么是单文件：开发期由 bootstrap.js 用 `?rev=<内容哈希>` 动态 import 本文件来实现
 * 「改完即生效」的热重载；Node 只会按 URL 缓存模块，带 query 的 URL 能整体重新求值，
 * 但本文件内部的相对 import 不会被 query 影响（会命中旧缓存），因此这里不写相对 import。
 *
 * 依赖限制：只使用 node: 内置模块与 ctx 提供的服务，不 import 任何 @deepseek-ai/* 包
 * （插件目录不在 profile 的 node_modules 解析路径上）。
 */
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

export const VERSION = '0.4.2';

/**
 * 回滚确认令牌有效期。
 * 预览与执行之间留出足够时间让用户看清单，但过期后必须重新预览，
 * 避免一个旧清单在很久以后仍然可以执行。
 */
export const PLAN_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 预览/回滚清单在 HTTP 响应里的展示上限；执行始终使用完整清单。 */
export const PLAN_DISPLAY_LIMIT = 500;

/**
 * 合法的快照阶段。
 *
 * 不只在展示时使用：阶段会拼进记录文件名（`<序号>-<阶段>-<时间>`），所以任何来自
 * HTTP 的未知阶段都必须收敛到一个白名单值，否则 `../` 之类的字符串会带着路径
 * 语义写文件（详见 `capture` 与 `safeSegment`）。
 */
export const PHASES = Object.freeze(['start', 'end', 'baseline', 'manual', 'pre-rollback']);

/**
 * 「事件流说运行中、但会话控制器明确说空闲」时的陈旧标记容忍时长。
 *
 * 只有该会话超过这段时间**一个事件都没有**（说明 turn/end 很可能丢了）才允许把标记
 * 改回空闲；否则宁可拒绝回滚。默认 1 小时，远大于正常轮次的事件间隔。
 */
export const STALE_RUNNING_MS = 60 * 60 * 1000;

/** 回滚事务日志的根目录名（位于快照根下）。 */
const RESTORE_DIR = 'restore';

/** 跨进程存储锁文件名（位于快照根下）。 */
const STORE_LOCK_FILE = '.store.lock';
/** 跨进程锁的最长等待时间。 */
const STORE_LOCK_WAIT_MS = 60 * 1000;
/** 没有 PID 可判断时，锁文件超过该时长视为陈旧。 */
const STORE_LOCK_STALE_MS = 30 * 60 * 1000;

/** 插件可用性标识（同时是 dsh.client 的 id 与路由前缀来源）。 */
export const PLUGIN_NAME = 'snapshot-manager';

/**
 * 路由版本段。
 * 起因：早期版本没有收集 connection.fetch.register 的 disposer，热重载后旧路由会残留占位；
 * 更麻烦的是"残留路由的闭包读的是它那一代的旧 holder"，即使后来修好了服务解析也救不回来。
 * 现在注册/释放都正确，正常情况下无需再改；一旦发现旧路由抢答，改这个值即可绕开。
 */
export const ROUTE_VERSION = 'v4';

/** Loader 依赖：路由需要 connection；其余服务通过 ctx.get 可选获取。 */
export const inject = ['connection'];

/**
 * 「本会话修改过的文件」最多记多少个（防内存无界增长）。
 * 正常会话远达不到；一旦触顶，新路径不再记录，但**不影响默认的全量回滚**。
 */
export const MAX_TRACKED_FILES = 20000;

/**
 * 默认排除的路径段（大小写不敏感）。
 *
 * 条目可以是精确的目录名，也可以包含 `*` / `?` 通配（只匹配单个路径段，不跨 `/`）：
 * 很多工具会往工作区里放临时目录（`.tmp-gradle`、`.tmp-junit`……），逐个登记
 * 新名字永远会漏；`excludeGitignoredDirs` 之外的这层通配用来兜住同类命名。
 */
export const DEFAULT_EXCLUDES = [
  '.git', '.hg', '.svn', '.idea', '.vscode', '.vs',
  'node_modules', 'bower_components', 'vendor',
  'target', 'build', 'dist', 'out', 'output', 'bin', 'obj',
  '.gradle', '.gradle-user-home', '.next', '.nuxt', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', '.dsh-probe',
  '.tmp-*', '.temp-*',
];

/** 默认不采集的扩展名（体积大且通常不是源码/配置）。 */
export const DEFAULT_EXCLUDE_EXTENSIONS = [
  '.zip', '.7z', '.rar', '.gz', '.tar', '.jar', '.war', '.class',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.img', '.pdb',
  '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.psd', '.ai', '.sketch',
];

/** 插件自动维护的忽略清单（每个工作区一份）的格式版本。 */
export const MANAGED_IGNORE_VERSION = 1;

/** 自动忽略候选的最小文件数：太小的目录即使忽略也救不回上限。 */
export const AUTO_IGNORE_MIN_FILES = 100;

/** 单次自动写入最多追加的目录数。 */
export const AUTO_IGNORE_MAX_ADD = 10;

/** 自动忽略清单的条目上限，防止无限增长。 */
export const AUTO_IGNORE_MAX_ENTRIES = 200;

/** 超限诊断（只读遍历）的时间预算，避免在异常大目录上卡住。 */
const OVERFLOW_REPORT_BUDGET_MS = 10 * 1000;

/**
 * 自动忽略的安全门槛：目录（子树）里只要有这些扩展名的文件，就不自动加入清单。
 *
 * 它同时覆盖源码、文档、配置和数据类文件——自动排除一旦写错，回滚就再也覆盖不到
 * 这些内容；宁可让采集失败并报告，也不静默排除可能有人在改的目录。
 */
const EDITABLE_EXTENSIONS = new Set([
  '.java', '.kt', '.kts', '.scala', '.groovy', '.js', '.jsx', '.ts', '.tsx',
  '.mjs', '.cjs', '.vue', '.svelte', '.py', '.go', '.rs', '.c', '.h', '.cc',
  '.cpp', '.cxx', '.hpp', '.cs', '.rb', '.php', '.swift', '.m', '.mm', '.sql',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.gradle', '.proto',
  '.graphql', '.tf', '.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.html',
  '.htm', '.css', '.scss', '.sass', '.less', '.toml', '.ini', '.conf',
  '.properties', '.env', '.csv', '.tsv',
]);

/** 当前宿主进程的模块目录（版本目录或插件 lib 目录）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 跨代共享持有者。
 *
 * 放在 globalThis 上而不是由 bootstrap 传入：bootstrap.js 的模块 URL 固定，
 * Node 会一直用首次加载的版本（我们后来给 bootstrap 加的 holder 参数从未生效）。
 * host.js 每次改动都是新 URL，所以放在它这里、并且挂到 globalThis 上，
 * 才能保证「无论哪一代注册的路由，取到的都是当前活着的那个服务实例」。
 * @returns {{current: object|null, generation: number, beacons: Array<object>}} 共享持有者。
 */
function sharedHolder() {
  const key = '__dshSnapshotManagerHolder__';
  const existing = globalThis[key];
  if (existing !== undefined && existing !== null) return existing;
  const created = { current: null, generation: 0, beacons: [] };
  globalThis[key] = created;
  return created;
}

/**
 * 解析 DSH home：显式配置 > $DSH_HOME > ~/.dsh。
 * @param {object} config - 插件配置。
 * @returns {string} 绝对路径。
 */
export function resolveDshHome(config = {}) {
  const explicit = typeof config.dshHome === 'string' ? config.dshHome.trim() : '';
  if (explicit.length > 0) return explicit;
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  if (fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * 归一化配置，补齐全部默认值。
 * @param {object} config - 原始配置。
 * @returns {object} 归一化配置。
 */
export function resolveConfig(config = {}) {
  const dshHome = resolveDshHome(config);
  const int = (value, fallback, min = 1) => (Number.isSafeInteger(value) && value >= min ? value : fallback);
  const list = (value, fallback) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : fallback;

  return {
    dshHome,
    root: typeof config.root === 'string' && config.root.trim().length > 0
      ? config.root.trim()
      : join(dshHome, 'snapshot-manager'),
    captureOnTurnStart: config.captureOnTurnStart !== false,
    captureOnTurnEnd: config.captureOnTurnEnd !== false,
    maxFileBytes: int(config.maxFileBytes, 8 * 1024 * 1024),
    maxFilesPerSnapshot: int(config.maxFilesPerSnapshot, 20000),
    maxSessionBytes: int(config.maxSessionBytes, 512 * 1024 * 1024),
    excludes: list(config.excludes, DEFAULT_EXCLUDES),
    excludeExtensions: list(config.excludeExtensions, DEFAULT_EXCLUDE_EXTENSIONS),
    /**
     * 是否跳过被 git 忽略的**目录**（只跳目录，不跳被忽略的文件）。
     *
     * 生成目录几乎必然被 gitignore，所以它比“枚举目录名”更能覆盖别人新造的目录；
     * 非 git 仓库、git 不可用或命令超时时静默回退为不跳过。传 false 可关闭。
     */
    excludeGitignoredDirs: config.excludeGitignoredDirs !== false,
    /**
     * 自动维护插件自己的排除清单。
     *
     * `'overflow'`（默认）：采集将要超过 maxFilesPerSnapshot 时，把“不含源码/文本文件”
     * 的大目录写进 `<root>/ignore/<workspaceKey>.json`，然后重扫一次；
     * `'off'`：清单只读，不自动写。清单本身始终参与扫描排除（不在工作区里）。
     */
    autoIgnore: config.autoIgnore === false || config.autoIgnore === 'off' ? 'off' : 'overflow',
    maxSnapshotsPerSession: int(config.maxSnapshotsPerSession, 200),
    /** 每多少个快照写一次全量（full）记录，使链式回溯长度有界。 */
    checkpointEvery: int(config.checkpointEvery, 20),
    scanTimeoutMs: int(config.scanTimeoutMs, 60 * 1000),
    devChannelDir: typeof config.devChannelDir === 'string' && config.devChannelDir.trim().length > 0
      ? config.devChannelDir.trim()
      : '',
    devChannelToken: typeof config.devChannelToken === 'string' && config.devChannelToken.trim().length > 0
      ? config.devChannelToken.trim()
      : '',
    rawConfig: config,
  };
}

/**
 * 启动开发期命令轮询：读 <dir>/cmd.json，执行后写 <dir>/last-out.json 与 out-<id>.json。
 * 插件运行在宿主进程内，因此可以借此在无浏览器令牌的情况下做端到端验证。
 * @param {object} options - dir / dispatch / logger / intervalMs。
 * @returns {() => void} 停止函数。
 */
export function startDevChannel({ dir, dispatch, logger, intervalMs = 600, token = '' }) {
  let stopped = false;
  let lastText = null;
  let running = false;
  const cmdPath = join(dir, 'cmd.json');

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const info = await stat(cmdPath).catch(() => undefined);
      if (info === undefined || info.isDirectory()) return;
      const text = await readFile(cmdPath, 'utf8');
      if (text === lastText) return;
      lastText = text;

      let cmd;
      try {
        cmd = JSON.parse(text);
      } catch (error) {
        cmd = { op: '__invalid__', parseError: String(error?.message ?? error) };
      }

      // 开发通道是文件投递，没有身份校验；强制 id 是唯一能防“同一命令在每次
      // 重载/重启时重放”的约束。无 id 的命令直接拒绝，而不是执行后留下不可区分结果。
      if (typeof cmd?.id !== 'string' || cmd.id.length === 0) {
        logger.warn('dev 命令缺少 id（或 id 不是字符串），已拒绝执行');
        return;
      }
      if (token.length > 0 && cmd.token !== token) {
        logger.warn('dev 命令 token 不匹配，已拒绝执行');
        return;
      }
      const outId = safeSegment(cmd.id);
      const already = await stat(join(dir, `out-${outId}.json`)).then(() => true).catch(() => false);
      if (already) {
        logger.info(`dev 命令 ${cmd.id}（${String(cmd.op)}）已执行过，跳过重放`);
        return;
      }

      const startedAt = Date.now();
      let payload;
      try {
        payload = { ok: true, op: cmd?.op ?? null, id: cmd?.id ?? null, ms: 0, result: await dispatch(cmd ?? {}) };
      } catch (error) {
        payload = {
          ok: false,
          op: cmd?.op ?? null,
          id: cmd?.id ?? null,
          error: String(error?.message ?? error),
          stack: String(error?.stack ?? ''),
        };
      }
      payload.ms = Date.now() - startedAt;
      payload.at = new Date().toISOString();

      await mkdir(dir, { recursive: true });
      const body = JSON.stringify(payload, null, 2);
      await writeFile(join(dir, 'last-out.json'), body, 'utf8');
      await writeFile(join(dir, `out-${outId}.json`), body, 'utf8');
      if (!payload.ok) logger.warn(`dev 命令 ${String(cmd?.op)} 失败：${payload.error}`);
    } catch (error) {
      logger.warn(`dev 通道轮询失败：${String(error?.message ?? error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`dev 通道已启动：${cmdPath}`);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/* ============================================================================
 * 快照存储层（内容寻址 + 链式增量）
 *
 * 目录结构（config.root 下）：
 *   index/<workspaceKey>.json          工作区扫描索引：relPath -> {size, mtimeMs, hash}
 *   objects/<hash 前 2 位>/<hash>      文件内容对象（同一内容只存一份）
 *   sessions/<sessionId>/<snapId>.json 快照记录：{parent, full, changes:{path: hash|null}}
 *   meta/<sessionId>.json              会话级元信息：标签、最近 forkSeq 等
 *
 * 快照记录只存「与上一个快照的差异」，每 checkpointEvery 个写一次全量（full）快照，
 * 使还原时的链式回溯长度有界。
 * ========================================================================== */

/**
 * 计算字符串的短哈希（用于工作区 key）。
 * @param {string} text - 输入。
 * @returns {string} 12 位十六进制。
 */
export function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * 规范化工作区路径：统一斜杠写法与相对段。
 *
 * 工作区 key 必须由规范化路径生成——否则同一目录的 `D:\\a\\b` 与 `D:/a/b` 会得到两把 key，
 * 索引分裂后回滚会拿错基线（真实隐患，不只是垃圾文件）。
 * @param {string} cwd - 原始工作目录。
 * @returns {string} 规范化后的绝对路径。
 */
export function normalizeWorkspacePath(cwd) {
  const text = String(cwd ?? '');
  if (text.length === 0) return '';
  try {
    return resolve(text);
  } catch {
    return text.replace(/\//g, sep);
  }
}

/**
 * 由工作区路径得到存储用的 key。
 * @param {string} cwd - 工作目录。
 * @returns {string} 12 位十六进制 key。
 */
export function workspaceKeyOf(cwd) {
  const normalized = normalizeWorkspacePath(cwd);
  // Windows/macOS 默认文件系统大小写不敏感；同一目录的不同大小写不能分裂成两把索引 key。
  const keyText = (process.platform === 'win32' || process.platform === 'darwin')
    ? normalized.normalize('NFC').toLowerCase()
    : normalized;
  return shortHash(keyText);
}

/**
 * 从工具调用参数里抓出 `file_path`。
 *
 * 为什么用正则而不是 JSON.parse：`arguments` 是完整参数的 JSON 字符串（`write` 的
 * `content` 可能上百 KB），每个 tool/call 都反序列化一次代价过高；而实测 208/208 次
 * `write`/`edit` 调用都能被这条正则命中，且取值与 JSON.parse 结果完全一致。
 * @param {string} raw - event.data.arguments。
 * @returns {string|null} 文件路径（原样，未归一）。
 */
function extractFilePath(raw, key = 'file_path') {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
  if (match === null) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

/**
 * 从一次工具调用里取出它要**修改**的文件路径（绝对路径）；不改文件则返回 null。
 *
 * 覆盖三类写文件工具：
 *   - `write` / `edit`：参数为 `file_path`；
 *   - `str_replace_editor`：参数为 `path`，且只有 `create`/`str_replace`/`insert` 会落盘，
 *     `view` 是只读（DSH 自己的产出记录也是这么判定的）。
 * 注意：`read` 有 `file_path` 但只读，故意不在此列。
 * @param {string} toolName - event.data.name。
 * @param {string} raw - event.data.arguments（JSON 字符串）。
 * @returns {string|null} 绝对路径或 null。
 */
function extractMutationPath(toolName, raw) {
  if (toolName === 'write' || toolName === 'edit') return extractFilePath(raw, 'file_path');
  if (toolName === 'str_replace_editor') {
    const command = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(typeof raw === 'string' ? raw : '');
    if (command === null) return null;
    let value;
    try {
      value = JSON.parse(`"${command[1]}"`);
    } catch {
      return null;
    }
    if (value !== 'create' && value !== 'str_replace' && value !== 'insert') return null;
    return extractFilePath(raw, 'path');
  }
  return null;
}

/**
 * 把工具参数里的路径归一成工作区相对路径（`/` 分隔）；不在工作区内则返回 null。
 *
 * `file_path` 既可能是绝对路径，也可能是**工作区相对路径**（DSH 按会话 cwd 解析它）。
 * 早期这里只接受绝对路径，导致模型用 `subdir/...` 这类相对写法时
 * `write`/`edit` 全部被静默忽略——「只恢复本次会话修改的文件」于是显示 0。
 * 现在两种写法都先折算成绝对路径，再判断是否越界。
 * @param {string} cwd - 工作区根目录。
 * @param {string} target - 工具参数里的路径（绝对或相对）。
 * @returns {string|null} 相对路径或 null。
 */
export function relWithinWorkspace(cwd, target) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  if (typeof target !== 'string' || target.length === 0) return null;
  let absolute;
  try {
    absolute = isAbsolute(target) ? target : resolve(cwd, target);
  } catch {
    return null;
  }
  let rel;
  try {
    rel = relative(resolve(cwd), absolute);
  } catch {
    return null;
  }
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * 路径身份比较用的 key。
 *
 * Windows 与 macOS（默认大小写不敏感卷）上 `Foo.txt` 与 `foo.txt` 是同一个文件，
 * 且 macOS 常见 NFD 文件名；这里统一 Unicode NFC + 大小写折叠（Linux 保持原样）。
 * 如果按原始字符串比较，回滚会把同一个文件同时算成「要恢复」和「要删除」：先写回旧内容、
 * 再 `rm` 掉同名文件，最后什么都没了，报告还显示成功。这里统一大小写折叠，
 * 让计划、journal 过滤、类型冲突判断都按同一个身份工作。
 * @param {string} rel - 工作区相对路径（/ 分隔）。
 * @returns {string} 比较 key。
 */
export function pathKeyOf(rel) {
  const text = String(rel ?? '');
  if (text.length === 0) return text;
  // macOS 默认 APFS/HFS+ 大小写不敏感，且常以 NFD 返回文件名；与 NFC 快照记录合并。
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return text.normalize('NFC').toLowerCase();
  }
  return text;
}

/**
 * 判断路径是否等于某个目录或位于其下。
 * `dir === ''` 表示工作区根（所有路径都算在其下）。
 * @param {string} rel - 相对路径。
 * @param {string} dir - 目录相对路径。
 * @returns {boolean} 是否在其下。
 */
export function isUnderDir(rel, dir) {
  if (dir.length === 0) return true;
  return rel === dir || rel.startsWith(`${dir}/`);
}

/**
 * 判断路径是否命中一组「未知路径/未知目录」。
 * 未知项既可能是文件（例如被占用的大文件），也可能是目录（例如变成了符号链接的目录、
 * 或 readdir 失败的目录），所以这里同时接受「等于」和「位于其下」。
 * @param {string} rel - 相对路径。
 * @param {Iterable<string>} keys - 已折叠大小写的比较 key。
 * @returns {boolean} 是否命中。
 */
export function isUnderAnyKey(rel, keys) {
  const key = pathKeyOf(rel);
  for (const item of keys) if (isUnderDir(key, item)) return true;
  return false;
}

/**
 * 判断路径 key 是否等于某个 key，或位于其下（用于已按 pathKeyOf 折叠的集合）。
 * 逐段向上查，避免为每条路径线性扫描整组 unknown。
 * @param {string} key - 已折叠的路径 key。
 * @param {Set<string>} keys - 已折叠的路径 key 集合。
 * @returns {boolean} 是否命中。
 */
function matchesUnderKey(key, keys) {
  let current = key;
  for (;;) {
    if (keys.has(current)) return true;
    const slash = current.lastIndexOf('/');
    if (slash < 0) return false;
    current = current.slice(0, slash);
  }
}

/**
 * 把单个路径段的通配模式转成正则源码：`*` 匹配任意字符，`?` 匹配单个字符。
 * 模式不跨 `/`，因为排除规则本来就是逐段匹配的。
 * @param {string} pattern - 已小写的模式。
 * @returns {string} 正则源码（不含锚点）。
 */
function segmentGlobSource(pattern) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

/**
 * 编译排除规则（构造时调一次，扫描过程中逐条路径复用）。
 *
 * - 字面条目按路径段精确匹配（大小写不敏感，与原行为一致）；
 * - 含 `*` / `?` 的条目按段级通配匹配，例如 `.tmp-*`；
 * - `excludeExtensions` 仍按“最后一个点之后的后缀”精确匹配。
 *
 * @param {Iterable<string>} excludes - 排除段/通配。
 * @param {Iterable<string>} [excludeExtensions] - 排除扩展名。
 * @returns {(relPath: string) => boolean} 判定函数。
 */
export function compileExcludeMatcher(excludes, excludeExtensions = []) {
  const literals = new Set();
  const sources = [];
  for (const raw of excludes ?? []) {
    if (typeof raw !== 'string') continue;
    const item = raw.trim().toLowerCase();
    if (item.length === 0) continue;
    if (item.includes('*') || item.includes('?')) sources.push(segmentGlobSource(item));
    else literals.add(item);
  }
  const pattern = sources.length > 0 ? new RegExp(`^(?:${sources.join('|')})$`) : null;
  const exts = new Set();
  for (const raw of excludeExtensions ?? []) {
    if (typeof raw === 'string' && raw.length > 0) exts.add(raw.toLowerCase());
  }
  return (relPath) => {
    const lower = String(relPath).toLowerCase();
    for (const segment of lower.split('/')) {
      if (literals.has(segment)) return true;
      if (pattern !== null && pattern.test(segment)) return true;
    }
    const dot = lower.lastIndexOf('.');
    return dot !== -1 && exts.has(lower.slice(dot));
  };
}

/**
 * 判断路径是否被排除（按路径段匹配，大小写不敏感；兼容旧调用）。
 * @param {string} relPath - 相对路径（/ 分隔）。
 * @param {Set<string>|Iterable<string>} excludes - 排除段/通配。
 * @param {Set<string>|Iterable<string>} exts - 排除扩展名。
 * @returns {boolean} 是否排除。
 */
export function isExcluded(relPath, excludes, exts) {
  return compileExcludeMatcher(excludes, exts)(relPath);
}

/**
 * 列出被 git 忽略的**目录**（相对 cwd、`/` 分隔、无尾斜杠）。
 *
 * 为什么只看目录、不看文件：忽略目录几乎都是生成物/缓存，跳过它们能避免
 * “刷新构建就多出几万个文件”撑爆扫描；而被忽略的**文件**（`.env`、本地配置……）
 * 往往仍值得纳入快照和回滚，所以保留。
 *
 * 非 git 仓库、未安装 git、命令超时或输出异常时返回空数组：采集退回原有行为，
 * 不会因为一个可选优化而失败。
 *
 * @param {string} cwd - 工作区根目录。
 * @param {{timeoutMs?: number}} [options] - 超时（默认 5 秒）。
 * @returns {Promise<string[]>} 忽略目录列表（去重、排序）。
 */
export function listGitignoredDirs(cwd, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  return new Promise((resolve) => {
    // --directory：把“整个目录被忽略”折叠成一条 `dir/`，避免逐文件列出；
    // -z：路径里可能有空格/引号，用 NUL 分隔最稳。
    execFile(
      'git',
      ['-C', cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve([]);
          return;
        }
        const dirs = new Set();
        for (const item of String(stdout).split('\0')) {
          if (item.length === 0 || !item.endsWith('/')) continue;
          const rel = item.slice(0, -1).replace(/\\/g, '/').replace(/^\.\//, '');
          if (rel.length > 0) dirs.add(rel);
        }
        resolve([...dirs].sort());
      },
    );
  });
}

/**
 * 插件自动维护的忽略清单文件路径（按工作区隔离，放在插件数据根下）。
 * @param {object} config - 归一化配置。
 * @param {string} cwd - 工作区根。
 * @returns {string} 清单文件的绝对路径。
 */
export function managedIgnoreFile(config, cwd) {
  return join(config.root, 'ignore', `${workspaceKeyOf(cwd)}.json`);
}

/**
 * 归一化清单里的路径条目：统一 `/`、去掉 `./` 与前导斜杠、拒绝空段/`..`。
 * @param {unknown} value - 原始值。
 * @returns {string} 合法相对路径；非法返回空串。
 */
function normalizeManagedIgnorePath(value) {
  if (typeof value !== 'string') return '';
  let rel = value.replace(/\\/g, '/').trim();
  rel = rel.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel.length === 0) return '';
  const segments = rel.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return '';
  return rel;
}

/**
 * 校验并去重清单条目，最多保留 AUTO_IGNORE_MAX_ENTRIES 条。
 * @param {unknown} entries - 原始 entries。
 * @returns {Array<{kind: 'path'|'pattern', value: string, source: 'auto'|'manual', addedAt?: number, note?: string}>} 条目。
 */
function normalizeManagedIgnoreEntries(entries) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(entries)) return out;
  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object') continue;
    if (raw.kind !== 'path' && raw.kind !== 'pattern') continue;
    const value = raw.kind === 'path'
      ? normalizeManagedIgnorePath(raw.value)
      : String(raw.value ?? '').trim();
    if (value.length === 0) continue;
    // 模式按路径段匹配，不跨 `/`；带 `/` 的路径必须用 kind:'path'。
    if (raw.kind === 'pattern' && value.includes('/')) continue;
    const key = `${raw.kind}:${raw.kind === 'path' ? pathKeyOf(value) : value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { kind: raw.kind, value, source: raw.source === 'auto' ? 'auto' : 'manual' };
    if (Number.isSafeInteger(raw.addedAt)) entry.addedAt = raw.addedAt;
    if (typeof raw.note === 'string' && raw.note.length > 0) entry.note = raw.note.slice(0, 200);
    out.push(entry);
    if (out.length >= AUTO_IGNORE_MAX_ENTRIES) break;
  }
  return out;
}

/**
 * 读取某工作区的自动忽略清单；文件不存在/损坏/字段非法时返回空清单，不影响采集。
 * @param {object} config - 归一化配置。
 * @param {string} cwd - 工作区根。
 * @returns {Promise<{file: string, entries: Array<object>}>} 清单路径与条目。
 */
export async function readManagedIgnore(config, cwd) {
  const file = managedIgnoreFile(config, cwd);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return { file, entries: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { file, entries: [] };
  }
  return { file, entries: normalizeManagedIgnoreEntries(parsed?.entries) };
}

/**
 * 把清单条目编译成判定函数：path 条目按相对路径前缀匹配，pattern 条目按段通配。
 * @param {Array<object>} entries - 清单条目。
 * @returns {{entries: Array<object>, prefixes: Set<string>, match: (relPath: string) => boolean}} 判定结果。
 */
export function compileManagedIgnore(entries) {
  const list = normalizeManagedIgnoreEntries(entries);
  const prefixes = new Set();
  const patterns = [];
  for (const entry of list) {
    if (entry.kind === 'path') prefixes.add(pathKeyOf(entry.value));
    else patterns.push(entry.value);
  }
  const segmentMatch = compileExcludeMatcher(patterns, []);
  return {
    entries: list,
    prefixes,
    match(relPath) {
      // 祖先链上命中任意 path 前缀即排除；与 excludes 的段匹配语义一致（大小写折叠）。
      if (prefixes.size > 0 && matchesUnderKey(pathKeyOf(relPath), prefixes)) return true;
      return segmentMatch(relPath);
    },
  };
}

/**
 * 追加自动忽略条目（原子写 JSON，去重，保留手工条目与注释性字段）。
 * @param {object} config - 归一化配置。
 * @param {string} cwd - 工作区根。
 * @param {Array<string|{value: string, note?: string}>} additions - 待追加的目录。
 * @returns {Promise<{file: string, entries: Array<object>, added: Array<object>}>} 写入结果。
 */
export async function appendManagedIgnore(config, cwd, additions) {
  const file = managedIgnoreFile(config, cwd);
  const current = await readManagedIgnore(config, cwd);
  const entries = current.entries.slice();
  const seen = new Set(entries.map((entry) => `${entry.kind}:${entry.kind === 'path' ? pathKeyOf(entry.value) : entry.value.toLowerCase()}`));
  const added = [];
  for (const item of Array.isArray(additions) ? additions : []) {
    const rel = normalizeManagedIgnorePath(item !== null && typeof item === 'object' ? item.value : item);
    if (rel.length === 0) continue;
    const key = `path:${pathKeyOf(rel)}`;
    if (seen.has(key)) continue;
    if (entries.length >= AUTO_IGNORE_MAX_ENTRIES) break;
    const entry = { kind: 'path', value: rel, source: 'auto', addedAt: Date.now() };
    if (item !== null && typeof item === 'object' && typeof item.note === 'string' && item.note.length > 0) {
      entry.note = item.note.slice(0, 200);
    }
    entries.push(entry);
    seen.add(key);
    added.push(entry);
    if (added.length >= AUTO_IGNORE_MAX_ADD) break;
  }
  if (added.length > 0) {
    await writeJson(file, {
      v: MANAGED_IGNORE_VERSION,
      cwd: normalizeWorkspacePath(cwd),
      updatedAt: Date.now(),
      entries,
    });
  }
  return { file, entries, added };
}

/**
 * 从文件名取小写扩展名（`.env` 这类点开头文件也按扩展名处理）。
 * @param {string} name - 文件名。
 * @returns {string} 扩展名（含点）；没有则空串。
 */
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * 只读地走一遍工作区，统计“可计入条目”的分布，用于超限诊断与自动忽略候选。
 *
 * 与 scanWorkspace 的区别：不 stat、不哈希、不读文件内容，只 readdir + 累计计数；
 * 有 10 秒预算，超时返回 truncated=true（此时不做自动忽略）。
 * @param {object} options - 参数。
 * @param {string} options.cwd - 工作区根。
 * @param {object} options.config - 归一化配置。
 * @param {(rel: string, isDir: boolean) => boolean} options.isIgnored - 是否排除。
 * @returns {Promise<{total: number, truncated: boolean, subtree: Map<string, number>, subtreeEditable: Map<string, number>, topLevel: Map<string, number>, elapsedMs: number}>} 报告。
 */
async function collectOverflowReport({ cwd, config, isIgnored }) {
  const startedAt = Date.now();
  const budget = Math.max(1000, Math.min(config.scanTimeoutMs, OVERFLOW_REPORT_BUDGET_MS));
  /** 目录 -> 直接子文件数。 */
  const direct = new Map();
  /** 目录 -> 直接子文件里“可编辑类”（源码/文本/配置/数据）的数量。 */
  const directEditable = new Map();
  const dirs = [];
  let total = 0;
  let truncated = false;
  const stack = [''];
  while (stack.length > 0) {
    if (Date.now() - startedAt > budget) {
      truncated = true;
      break;
    }
    const relDir = stack.pop();
    let dirents;
    try {
      dirents = await readdir(join(cwd, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    let count = 0;
    let editable = 0;
    for (const dirent of dirents) {
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (isIgnored(rel, dirent.isDirectory())) continue;
      if (dirent.isDirectory()) {
        dirs.push(rel);
        stack.push(rel);
        continue;
      }
      count += 1;
      total += 1;
      if (EDITABLE_EXTENSIONS.has(extensionOf(dirent.name))) editable += 1;
    }
    if (count > 0) direct.set(relDir, count);
    if (editable > 0) directEditable.set(relDir, editable);
  }
  // 把直接计数累加到祖先目录，得到每个目录的子树文件数/可编辑文件数。
  const subtree = new Map(direct);
  const subtreeEditable = new Map(directEditable);
  const allDirs = ['', ...dirs];
  allDirs.sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of allDirs) {
    if (dir === '') continue;
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    subtree.set(parent, (subtree.get(parent) ?? 0) + (subtree.get(dir) ?? 0));
    subtreeEditable.set(parent, (subtreeEditable.get(parent) ?? 0) + (subtreeEditable.get(dir) ?? 0));
  }
  const topLevel = new Map();
  const rootCount = direct.get('') ?? 0;
  if (rootCount > 0) topLevel.set('（根目录）', rootCount);
  for (const [dir, count] of subtree) {
    if (dir === '' || dir.includes('/')) continue;
    topLevel.set(dir, count);
  }
  return { total, truncated, subtree, subtreeEditable, topLevel, elapsedMs: Date.now() - startedAt };
}

/**
 * 从超限报告里挑“可以安全自动忽略”的目录。
 *
 * 安全线：子树里不能有任何源码/文本/配置/数据文件（见 EDITABLE_EXTENSIONS），
 * 且目录至少 AUTO_IGNORE_MIN_FILES 个文件；选择能覆盖超出部分的最少目录，
 * 覆盖不够就一个都不写（避免把清单写成半套）。
 * @param {object} report - collectOverflowReport 的结果。
 * @param {object} config - 归一化配置。
 * @returns {Array<{dir: string, count: number}>} 选中的目录。
 */
function pickAutoIgnoreCandidates(report, config) {
  if (report.truncated) return [];
  const cap = config.maxFilesPerSnapshot;
  const needed = report.total - cap;
  if (needed <= 0) return [];
  // 留 2% 余量，避免“刚好压线”下一次又超。
  const remaining = needed + Math.max(1, Math.floor(cap * 0.02));
  const candidates = [];
  for (const [dir, count] of report.subtree) {
    if (dir.length === 0) continue;
    if (count < AUTO_IGNORE_MIN_FILES) continue;
    if ((report.subtreeEditable.get(dir) ?? 0) > 0) continue;
    candidates.push({ dir, count });
  }
  candidates.sort((a, b) => b.count - a.count);
  const selected = [];
  let covered = 0;
  for (const candidate of candidates) {
    if (selected.length >= AUTO_IGNORE_MAX_ADD || covered >= remaining) break;
    const key = pathKeyOf(candidate.dir);
    const related = selected.some((item) => {
      const other = pathKeyOf(item.dir);
      return key === other || key.startsWith(`${other}/`) || other.startsWith(`${key}/`);
    });
    if (related) continue;
    selected.push(candidate);
    covered += candidate.count;
  }
  return covered >= needed ? selected : [];
}

/**
 * 超限错误文案：给出 Top 目录和可执行的处理方式。
 * @param {object} config - 归一化配置。
 * @param {object} report - collectOverflowReport 的结果。
 * @param {string} [extra] - 追加说明。
 * @returns {string} 错误消息。
 */
function maxFilesExceededMessage(config, report, extra = '') {
  const dirs = busiestRootDirs(report.topLevel);
  const parts = [`工作区文件数超过 maxFilesPerSnapshot=${config.maxFilesPerSnapshot}，已中止采集/扫描`];
  parts.push(`本次共统计到 ${report.total} 个可计入条目${report.truncated ? '（诊断因超时未走完）' : ''}`);
  if (dirs.length > 0) {
    parts.push(`未排除目录中最多：${dirs.map(([dir, count]) => `${dir}/（${count}）`).join('、')}`);
  }
  const hints = [];
  if (config.excludeGitignoredDirs === false) {
    hints.push('开启 excludeGitignoredDirs 自动跳过 git 忽略的目录');
  }
  hints.push('把这些目录移出工作区，或加入 config.excludes（支持 * / ? 通配，如 `.tmp-*`）');
  hints.push('调大 maxFilesPerSnapshot');
  parts.push(`处理方式：${hints.join('；')}`);
  if (extra.length > 0) parts.push(extra);
  return parts.join('；');
}

/**
 * 算出「删完这些文件之后会变空、而且在该快照时点并不存在」的目录（深的在前）。
 *
 * 为什么要有这一步：快照只记录文件，所以回滚过去只删文件，工具运行时新建的目录
 * （例如 `tools/ghx/`、`tools/ghx/lib/`）会原地留下，看起来就像"根本没回滚"。
 * 判定条件两条，缺一不可：
 *   1. 该目录不在快照跟踪到的目录集合里（`trackedDirs`）——快照时就存在的目录绝不动；
 *   2. 删完之后目录下不再有任何文件存活——只要还剩一个（包括本次范围不删的那个），就保留。
 * @param {object} context - `{ current, trackedDirs }`：当前工作区索引条目与快照时点已存在的目录集合。
 * @param {Array<{rel: string, action: string}>} removeList - 本次要删除的文件。
 * @returns {string[]} 待删除目录的相对路径（深的在前）。
 */
export function pruneDirsFor(context, removeList) {
  const removedRel = new Set(removeList.map((item) => item.rel));
  const candidates = new Set();
  for (const item of removeList) {
    if (item.action !== 'created-after') continue;
    const parts = item.rel.split('/');
    for (let i = parts.length - 1; i >= 1; i -= 1) candidates.add(parts.slice(0, i).join('/'));
  }
  const allPaths = Object.keys(context?.current ?? {});
  // 预先展开“存活文件的祖先目录”，避免为每个候选目录线性扫描全部文件。
  const survivorDirs = new Set();
  for (const path of allPaths) {
    if (removedRel.has(path)) continue;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) survivorDirs.add(parts.slice(0, i).join('/'));
  }
  const out = [];
  for (const rel of candidates) {
    if (context?.trackedDirs?.has(rel)) continue;
    if (survivorDirs.has(rel)) continue;
    out.push(rel);
  }
  return out.sort((a, b) => b.split('/').length - a.split('/').length);
}

/**
 * 从「顶层目录 -> 条目数」里取最占用的几个（用于超限报错）。
 * @param {Map<string, number>} counts - 统计表。
 * @param {number} [limit] - 展示条数。
 * @returns {Array<[string, number]>} 从多到少；根目录文件不在其中。
 */
function busiestRootDirs(counts, limit = 5) {
  return [...counts]
    .filter(([name]) => name.length > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

/**
 * 扫描工作区，产出当前索引与「相对某份期望哈希表的变化」。
 *
 * 增量策略：先用 (size, mtimeMs) 判断文件是否可能变化，只有可能变化的文件才读盘算哈希，
 * 未变化的直接沿用上次的哈希 —— 这是把每轮成本压到亚秒级的关键。
 *
 * `expectedHashes` 是本会话上一条快照的 tree。只有索引里的哈希与它一致时才允许复用；
 * 否则强制重新哈希。否则同一工作区的另一个会话推进全局索引后，本会话的增量快照
 * 会把别人的改动误当成“早已存在”，回滚树就会缺文件。
 * @param {object} options - 参数。
 * @param {string} options.cwd - 工作区根目录。
 * @param {object} options.config - 归一化配置。
 * @param {object} options.previousIndex - 上次索引 { entries: { rel: {size, mtimeMs, hash} } }。
 * @param {Record<string, string|null>|null} [options.expectedHashes] - 本会话上一条快照的路径表。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {boolean} [options.allowAutoIgnore] - 允许在超限时自动维护忽略清单（只有采集路径传 true）。
 * @returns {Promise<{changes: Record<string, {hash: string|null, size: number|null}>, index: object, stats: object}>} 扫描结果。
 */
export async function scanWorkspace({ cwd, config, previousIndex, expectedHashes = null, signal, allowAutoIgnore = false }) {
  const startedAt = Date.now();
  const excludePath = compileExcludeMatcher(config.excludes, config.excludeExtensions);
  // git 忽略目录是“按来源”而不是“按名字”的排除：别人新建的缓存/生成目录只要被
  // ignore 就能命中。探测失败（非仓库、没装 git、超时）时返回空数组，退回原行为。
  const gitignoredDirs = config.excludeGitignoredDirs === false
    ? []
    : await listGitignoredDirs(cwd);
  const gitignoredDirKeys = new Set(gitignoredDirs.map((rel) => pathKeyOf(rel)));
  // 插件自动维护的清单（插件数据目录、按工作区隔离）。文件不存在/损坏时为空，不影响采集。
  const managed = await readManagedIgnore(config, cwd);
  const managedIgnore = compileManagedIgnore(managed.entries);
  const previous = previousIndex?.entries ?? {};
  const expected = expectedHashes ?? null;
  // 在大小写不敏感的文件系统上，期望哈希表可能仍用旧的大小写（例如 `Foo.txt`），
  // 而本次 readdir 返回 `foo.txt`。按折叠 key 查期望值，避免因“查不到 expected”
  // 而误用索引里的旧哈希，漏掉一次仅大小写重命名后的内容变化。
  const expectedByKey = expected === null
    ? null
    : new Map(Object.entries(expected).map(([rel, hash]) => [pathKeyOf(rel), hash]));
  const entries = {};
  const changes = {};
  /**
   * 本次扫描遇到、但**没有可靠内容哈希**的路径：符号链接、超大文件、stat/read 失败、
   * 非普通文件，以及 readdir 失败的目录。
   *
   * 这些路径不能简单地从索引里省略：省略会被 capture 解释成「已经不存在」，
   * 回滚时就会把仍然存在的文件删掉。记录成 unknown 后，回滚对这些路径只提示、不动手。
   */
  const unknown = {};
  /** readdir 失败的目录（相对路径；'' 表示工作区根）。 */
  const unreadableDirs = [];
  /** 本次扫描到的目录（相对路径；用于识别「快照要文件、现在却是目录」的冲突）。 */
  const dirs = new Set();
  let skipped = 0;
  let excluded = 0;
  let symlinks = 0;
  let oversized = 0;
  let unreadable = 0;
  let hashed = 0;
  let reused = 0;
  let bytes = 0;
  let seenFiles = 0;
  /** 一旦越过上限就停止哈希/写入，改为报诊断或自动修复。 */
  let overflow = false;
  /** 被整棵跳过的忽略目录（gitignore + 自动清单），写进快照记录供回滚跳过。 */
  const ignoredDirsSkipped = [];
  const symlinkSamples = [];
  const excludedSamples = [];
  const oversizedSamples = [];
  const vcsDirs = [];

  /** 深度优先遍历，避免递归爆栈。 */
  const stack = [''];
  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('扫描已取消');
    if (Date.now() - startedAt > config.scanTimeoutMs) throw new Error(`扫描超过 ${config.scanTimeoutMs}ms`);
    const relDir = stack.pop();
    let dirents;
    try {
      dirents = await readdir(join(cwd, relDir), { withFileTypes: true });
    } catch {
      unreadable += 1;
      if (!unreadableDirs.includes(relDir)) unreadableDirs.push(relDir);
      if (relDir !== '') dirs.add(relDir);
      continue;
    }
    for (const dirent of dirents) {
      // 目录级检查不够：单个目录里塞几万个文件时，整个扫描会在这里超时很久
      //（stat/读哈希是逐文件的 await），必须逐文件也检查一次截止时间。
      if (Date.now() - startedAt > config.scanTimeoutMs) throw new Error(`扫描超过 ${config.scanTimeoutMs}ms`);
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory() && dirent.name === '.git') {
        if (vcsDirs.length < 20) vcsDirs.push(rel);
      }
      // 先按段判断排除，再看链接：否则 node_modules 里的链接会被当作“未知文件”静默收集，
      // 既放大快照记录，也会让“回滚不会碰排除目录”的承诺变得难以解释。
      if (excludePath(rel)) {
        excluded += 1;
        skipped += 1;
        if (excludedSamples.length < 20) excludedSamples.push(rel);
        continue;
      }
      // 插件自动维护的清单：path 条目按相对路径前缀、pattern 条目按段通配。
      if (managedIgnore.entries.length > 0 && managedIgnore.match(rel)) {
        excluded += 1;
        skipped += 1;
        if (dirent.isDirectory() && ignoredDirsSkipped.length < 1000) ignoredDirsSkipped.push(rel);
        continue;
      }
      // git 忽略只按目录整棵跳过（父目录命中，子内容不会再被读到）；被忽略的**文件**保留。
      if (gitignoredDirKeys.size > 0 && dirent.isDirectory() && gitignoredDirKeys.has(pathKeyOf(rel))) {
        excluded += 1;
        skipped += 1;
        if (ignoredDirsSkipped.length < 1000) ignoredDirsSkipped.push(rel);
        continue;
      }
      if (!dirent.isDirectory()) {
        seenFiles += 1;
        if (seenFiles > config.maxFilesPerSnapshot) {
          overflow = true;
          break;
        }
      }
      if (dirent.isSymbolicLink()) {
        symlinks += 1;
        skipped += 1;
        unknown[rel] = 'symlink';
        if (symlinkSamples.length < 20) symlinkSamples.push(rel);
        continue;
      }
      if (dirent.isDirectory()) {
        dirs.add(rel);
        stack.push(rel);
        continue;
      }
      if (!dirent.isFile()) {
        skipped += 1;
        unknown[rel] = 'not-a-file';
        continue;
      }
      let info;
      try {
        info = await stat(join(cwd, rel));
      } catch {
        unreadable += 1;
        skipped += 1;
        unknown[rel] = 'unreadable';
        continue;
      }
      if (info.size > config.maxFileBytes) {
        oversized += 1;
        skipped += 1;
        unknown[rel] = 'oversized';
        if (oversizedSamples.length < 20) oversizedSamples.push(rel);
        continue;
      }
      const prev = previous[rel];
      const expectedHash = expectedByKey === null ? undefined : expectedByKey.get(pathKeyOf(rel));
      const mayReuse = prev !== undefined
        && prev.size === info.size
        && prev.mtimeMs === Math.floor(info.mtimeMs)
        // 本会话期望的哈希与索引不一致时不能复用：索引可能被同工作区的其他会话推进过。
        && (expectedHash === undefined || expectedHash === prev.hash);
      if (mayReuse) {
        entries[rel] = prev;
        bytes += info.size;
        reused += 1;
        continue;
      }
      let hash;
      try {
        hash = await hashFileAt(join(cwd, rel));
      } catch {
        unreadable += 1;
        skipped += 1;
        unknown[rel] = 'unreadable';
        continue;
      }
      hashed += 1;
      entries[rel] = { size: info.size, mtimeMs: Math.floor(info.mtimeMs), hash };
      bytes += info.size;
      if (prev === undefined || prev.hash !== hash) {
        changes[rel] = { hash, size: info.size };
      }
    }
    if (overflow) break;
  }

  if (overflow) {
    const shouldSkip = (rel, isDir) => excludePath(rel)
      || (managedIgnore.entries.length > 0 && managedIgnore.match(rel))
      || (isDir && gitignoredDirKeys.size > 0 && gitignoredDirKeys.has(pathKeyOf(rel)));
    // 只做一轮 readdir 统计，拿到“谁占满名额”的完整分布；超时则报告不完整。
    const report = await collectOverflowReport({ cwd, config, isIgnored: shouldSkip });
    const autoEnabled = allowAutoIgnore && config.autoIgnore === 'overflow';
    const selected = autoEnabled ? pickAutoIgnoreCandidates(report, config) : [];
    if (selected.length > 0) {
      let appended;
      try {
        appended = await appendManagedIgnore(config, cwd, selected.map((item) => ({
          value: item.dir,
          note: `自动忽略：子树 ${item.count} 个文件，超过 maxFilesPerSnapshot=${config.maxFilesPerSnapshot}`,
        })));
      } catch (error) {
        throw new Error(
          `${maxFilesExceededMessage(config, report, '；自动写入忽略清单失败')}：${String(error?.message ?? error)}`,
        );
      }
      if (appended.added.length > 0) {
        try {
          const retried = await scanWorkspace({ cwd, config, previousIndex, expectedHashes, signal, allowAutoIgnore: false });
          retried.stats.autoIgnored = appended.added.length;
          retried.stats.autoIgnoredPaths = appended.added.map((entry) => entry.value);
          retried.stats.autoIgnoreFile = appended.file;
          return retried;
        } catch (error) {
          throw new Error(
            `${String(error?.message ?? error)}；已自动加入忽略清单：`
            + `${appended.added.map((entry) => entry.value).join('、')}，但仍超过上限`,
          );
        }
      }
    }
    const extra = autoEnabled
      ? (report.truncated ? '；诊断报告超时，未自动忽略' : '；没有找到足够的“零源码/文本”目录可自动忽略')
      : '';
    throw new Error(maxFilesExceededMessage(config, report, extra));
  }

  // 消失的路径记为空值（表示该快照时点该文件不存在）。
  // 但被跳过/读不到/在不可读目录下的路径不能记成“不存在”：那是未知，不是删除。
  const unknownKeys = new Set(Object.keys(unknown).map(pathKeyOf));
  const unreadableKeys = new Set(unreadableDirs.map(pathKeyOf));
  for (const rel of Object.keys(previous)) {
    if (entries[rel] !== undefined) continue;
    const relKey = pathKeyOf(rel);
    if (matchesUnderKey(relKey, unknownKeys) || matchesUnderKey(relKey, unreadableKeys)) continue;
    // 新加的排除规则/新开的 gitignore/自动清单会让“上一条快照里还纳入过”的路径这次扫不到。
    // 这不能记成 null（那表示当时不存在，回滚会删文件）——记为 unknown，回滚只提示不动手。
    if (excludePath(rel)
      || (managedIgnore.entries.length > 0 && managedIgnore.match(rel))
      || (gitignoredDirKeys.size > 0 && matchesUnderKey(relKey, gitignoredDirKeys))) {
      unknown[rel] = 'excluded';
      continue;
    }
    changes[rel] = { hash: null, size: null };
  }

  const total = Object.keys(entries).length;
  return {
    changes,
    unknown,
    unreadableDirs,
    ignoredDirs: ignoredDirsSkipped,
    dirs: [...dirs],
    index: { cwd: normalizeWorkspacePath(cwd), scannedAt: Date.now(), entries },
    stats: {
      total,
      bytes,
      changed: Object.keys(changes).length,
      hashed,
      reused,
      skipped,
      excluded,
      ignoredDirs: ignoredDirsSkipped.length,
      symlinks,
      oversized,
      unreadable,
      unknown: Object.keys(unknown).length,
      unknownDirs: unreadableDirs.length,
      vcsDirs,
      samples: { symlinks: symlinkSamples, excluded: excludedSamples, ignoredDirs: ignoredDirsSkipped.slice(0, 20), oversized: oversizedSamples },
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/**
 * 计算文件内容哈希。
 * @param {string} file - 绝对路径。
 * @returns {Promise<string>} sha1 十六进制。
 */
export async function hashFileAt(file) {
  return hashBytes(await readFile(file));
}

/** 内容寻址快照存储。 */
export class SnapshotStore {
  /**
   * @param {object} config - 归一化配置。
   * @param {{info: Function, warn: Function, error: Function}} logger - 日志。
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.root = config.root;
  }

  /**
   * 写入文件内容对象（同内容只存一份）。
   * @param {string} hash - 内容哈希。
   * @param {Buffer} bytes - 内容。
   * @returns {Promise<void>} 写完后 resolve。
   */
  async putObject(hash, bytes) {
    const actual = hashBytes(bytes);
    if (actual !== hash) {
      throw new Error(`对象内容与哈希不匹配（期望 ${hash}，实际 ${actual}）`);
    }
    const dir = join(this.root, 'objects', hash.slice(0, 2));
    const file = join(dir, hash);
    const existing = await stat(file).catch(() => undefined);
    if (existing !== undefined && existing.isFile()) return;
    await writeFileAtomic(file, bytes);
  }

  /**
   * 读取文件内容对象。
   * @param {string} hash - 内容哈希。
   * @returns {Promise<Buffer>} 内容。
   */
  async getObject(hash) {
    return readFile(join(this.root, 'objects', hash.slice(0, 2), hash));
  }

  /**
   * 对象是否存在（不做内容哈希校验，内容校验由 getObject 的调用方完成）。
   * 回滚前用它做预检，避免先删掉文件、写到一半才发现对象缺失。
   * @param {string} hash - 内容哈希。
   * @returns {Promise<boolean>} 存在返回 true。
   */
  async hasObject(hash) {
    const info = await stat(join(this.root, 'objects', hash.slice(0, 2), hash)).catch(() => undefined);
    return info !== undefined && info.isFile();
  }

  /**
   * 读取工作区索引。
   * @param {string} workspaceKey - 工作区 key。
   * @returns {Promise<object|null>} 索引或 null。
   */
  async readIndex(workspaceKey) {
    return readJson(join(this.root, 'index', `${workspaceKey}.json`));
  }

  /**
   * 写入工作区索引。
   * @param {string} workspaceKey - 工作区 key。
   * @param {object} index - 索引数据。
   * @returns {Promise<void>} 写完后 resolve。
   */
  async writeIndex(workspaceKey, index) {
    await writeJson(join(this.root, 'index', `${workspaceKey}.json`), index);
  }

  /**
   * 读取某会话的全部快照（按时间升序）。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<Array<object>>} 快照记录数组。
   */
  async listSnapshots(sessionId) {
    const dir = join(this.root, 'sessions', safeSegment(sessionId));
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await readJson(join(dir, name));
      if (record !== null) out.push(record);
    }
    out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return out;
  }

  /**
   * 追加一个快照记录。
   * @param {object} record - 快照记录（含 id/sessionId/parent/full/changes）。
   * @returns {Promise<void>} 写完后 resolve。
   */
  async putSnapshot(record) {
    // id 也会进文件名：即便调用方已经生成过 id，这里再做一次净化（防御性）。
    await writeJson(join(this.root, 'sessions', safeSegment(record.sessionId), `${safeSegment(record.id)}.json`), record);
  }

  /**
   * 删除一个快照记录。
   * @param {string} sessionId - 会话 id。
   * @param {string} id - 快照 id。
   * @returns {Promise<void>} 删完后 resolve。
   */
  async deleteSnapshot(sessionId, id) {
    await rm(join(this.root, 'sessions', safeSegment(sessionId), `${safeSegment(id)}.json`), { force: true });
  }

  /**
   * 把某个快照的路径 -> 哈希映射完整还原出来，并报告链是否完整。
   *
   * 以前只返回 tree：一旦 trim/手动删除把 full 基座删掉，链会静默断在缺失的 parent，
   * 得到的是“只剩最后一段 diff”的残缺树，回滚会把其余文件当成“快照之后新建”全部删掉。
   * 这里把完整性单独返回，回滚前必须检查。
   * @param {Array<object>} snapshots - 该会话全部快照（升序）。
   * @param {string} snapshotId - 目标快照 id。
   * @returns {{tree: Record<string, string|null>, complete: boolean, reason: string|null, chain: string[]}} 结果。
   */
  resolveTreeInfo(snapshots, snapshotId) {
    const byId = new Map(snapshots.map((item) => [item.id, item]));
    const chain = [];
    let cursor = byId.get(snapshotId);
    if (cursor === undefined) {
      return { tree: {}, unknown: {}, unknownDirs: [], complete: false, reason: 'missing-target', chain: [] };
    }
    let complete = false;
    let reason = null;
    while (cursor !== undefined) {
      chain.push(cursor);
      if (cursor.full === true) {
        complete = true;
        break;
      }
      if (cursor.parent === null || cursor.parent === undefined) {
        complete = false;
        reason = 'non-full-base';
        break;
      }
      const parent = byId.get(cursor.parent);
      if (parent === undefined) {
        complete = false;
        reason = `missing-parent:${String(cursor.parent)}`;
        break;
      }
      cursor = parent;
    }
    const tree = {};
    /** 路径 -> 原因；这些路径在该快照时点存在但内容未知，回滚绝不能当成“不存在”。 */
    const unknown = {};
    /** 该快照时点内容未知的整棵目录（例如 readdir 失败）；回滚不能删除其下任何路径。 */
    let unknownDirs = [];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const record = chain[i];
      // full 是完整基座：它记录的就是当时的完整已知路径表，之前的状态不再相关。
      if (record.full === true) {
        for (const rel of Object.keys(tree)) delete tree[rel];
        for (const rel of Object.keys(unknown)) delete unknown[rel];
        unknownDirs = [];
      }
      for (const [rel, hash] of Object.entries(record.changes ?? {})) {
        tree[rel] = hash;
        delete unknown[rel];
      }
      for (const [rel, why] of Object.entries(record.unknown ?? {})) {
        delete tree[rel];
        unknown[rel] = why;
      }
      // 未知目录按“本快照扫描到了什么”覆盖：本次扫描没把它列为未知，说明这次能读到
      //（或它已不存在），不应继续继承更早的整棵目录未知状态。
      // `ignoredDirs`（被 git 忽略而没采集的目录）按同样的语义处理：目标是该快照时，
      // 这些目录下的路径一律视为“未采集”，回滚不会删除或覆盖它们。
      const unknownDirsNext = [
        ...(Array.isArray(record.unknownDirs) ? record.unknownDirs : []),
        ...(Array.isArray(record.ignoredDirs) ? record.ignoredDirs : []),
      ];
      unknownDirs = [...new Set(unknownDirsNext)];
      const dirKeys = new Set(unknownDirs.map(pathKeyOf));
      if (dirKeys.size > 0) {
        for (const rel of Object.keys(tree)) {
          if (matchesUnderKey(pathKeyOf(rel), dirKeys)) delete tree[rel];
        }
      }
    }
    return { tree, unknown, unknownDirs, complete, reason, chain: chain.map((item) => item.id) };
  }

  /**
   * 只返回路径表（兼容旧调用方）。
   * @param {Array<object>} snapshots - 该会话全部快照（升序）。
   * @param {string} snapshotId - 目标快照 id。
   * @returns {Record<string, string|null>} 路径到哈希的映射。
   */
  resolveTree(snapshots, snapshotId) {
    return this.resolveTreeInfo(snapshots, snapshotId).tree;
  }

  /**
   * 统计存储占用。
   * @returns {Promise<object>} 对象数与字节数。
   */
  async stats() {
    let objects = 0;
    let bytes = 0;
    const objectsRoot = join(this.root, 'objects');
    let buckets = [];
    try {
      buckets = await readdir(objectsRoot, { withFileTypes: true });
    } catch {
      return { objects: 0, bytes: 0 };
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const files = await readdir(join(objectsRoot, bucket.name)).catch(() => []);
      for (const file of files) {
        const info = await stat(join(objectsRoot, bucket.name, file)).catch(() => undefined);
        if (info === undefined) continue;
        objects += 1;
        bytes += info.size;
      }
    }
    return { objects, bytes };
  }
}

/**
 * 读取 JSON 文件。
 * @param {string} file - 路径。
 * @returns {Promise<object|null>} 解析结果或 null。
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 判断同机 PID 是否仍存活。
 * @param {number} pid - 进程号。
 * @returns {boolean} 存活/无权限确认时 true。
 */
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但当前用户无权限；只有 ESRCH 才能确认已退出。
    return error?.code !== 'ESRCH';
  }
}

/**
 * 获取跨进程的存储锁。
 *
 * 进程内的 `storeQueue` 只能串行同一实例；热重载前后的两代实例、或同一 store 被两个
 * DSH 进程共享时，仍可能并发写 index/对象/快照记录。这里用 `.store.lock` 的
 * `open('wx')` 原子创建做跨进程互斥，PID 存活检测 + 30 分钟 mtime 容忍处理崩溃残留。
 * @param {string} root - 快照根。
 * @param {{warn: Function}} logger - 日志。
 * @returns {Promise<() => Promise<void>>} 释放函数。
 */
async function acquireStoreLock(root, logger) {
  await mkdir(root, { recursive: true });
  const file = join(root, STORE_LOCK_FILE);
  const token = randomUUID();
  const payload = JSON.stringify({
    token,
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
  });
  const deadline = Date.now() + STORE_LOCK_WAIT_MS;
  let waited = false;
  for (;;) {
    let handle;
    try {
      handle = await open(file, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
        try {
          await handle.sync();
        } catch {
          /* 某些文件系统不支持 fsync */
        }
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = await readJson(file);
          // 只在仍持有锁时删除；陈旧锁可能已被别的进程接管。
          if (current?.token === token) await rm(file, { force: true });
        } catch {
          /* 释放失败不阻塞任务 */
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => undefined);
      if (info === undefined) continue; // 刚好被释放，重试
      const current = await readJson(file);
      const ownerDead = current?.host === hostname()
        && Number.isSafeInteger(current.pid)
        && !isProcessAlive(current.pid);
      const expired = info.mtimeMs < Date.now() - STORE_LOCK_STALE_MS;
      if (ownerDead || expired) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`另一个快照实例正在操作快照库（${String(current?.pid ?? 'unknown')}），请稍后重试`);
      }
      if (!waited) {
        waited = true;
        logger.warn('快照存储正被另一个实例使用，等待其完成…');
      }
      await new Promise((done) => setTimeout(done, 120));
    }
  }
}

/**
 * 原子写文件：同目录临时文件 + fsync + 改名。
 *
 * 回滚写文件如果直接 `writeFile`，进程在写一半时退出会留下截断文件；
 * 用同目录 `rename` 至少保证目标要么是旧内容、要么是完整新内容。
 * @param {string} file - 目标路径。
 * @param {Buffer|Uint8Array|string} bytes - 内容。
 * @returns {Promise<void>} 写完后 resolve。
 */
async function writeFileAtomic(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const seq = (writeJsonSeq += 1);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${seq}`;
  let handle;
  try {
    handle = await open(tmp, 'w');
    await handle.writeFile(bytes);
    try {
      await handle.sync();
    } catch {
      /* 某些文件系统/网络盘不支持 fsync；不因此让写入失败 */
    }
  } finally {
    try {
      await handle?.close();
    } catch {
      /* 忽略 */
    }
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 原子写 JSON 文件（先写临时文件再改名）。
 * @param {string} file - 目标路径。
 * @param {unknown} value - 可序列化值。
 * @returns {Promise<void>} 写完后 resolve。
 */
async function writeJson(file, value) {
  await writeFileAtomic(file, Buffer.from(JSON.stringify(value), 'utf8'));
}

/** 临时文件序号（进程内自增）。 */
let writeJsonSeq = 0;

/**
 * 计算字节内容的 sha1。
 * @param {Buffer|Uint8Array} bytes - 内容。
 * @returns {string} 40 位十六进制。
 */
export function hashBytes(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/**
 * 读文件，遇到瞬时占用重试几次。
 * @param {string} file - 绝对路径。
 * @param {number} [attempts] - 最多尝试次数。
 * @returns {Promise<Buffer>} 内容。
 */
async function readFileWithRetry(file, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await readFile(file);
    } catch (error) {
      last = error;
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') break;
      if (i + 1 < attempts) await new Promise((done) => setTimeout(done, 40 * (i + 1)));
    }
  }
  throw last ?? new Error(`无法读取 ${file}`);
}

/**
 * 计算某一恢复范围的计划摘要（用于确认令牌绑定）。
 * 计划摘要覆盖完整清单，而不是 HTTP 响应里被截断的展示清单。
 * @param {object} plan - buildPlan 的结果。
 * @param {'all'|'session'} scope - 范围。
 * @returns {string} 摘要。
 */
function planHashFor(plan, scope) {
  const source = scope === 'session' ? (plan.sessionScope ?? {}) : plan;
  const restore = (source.restore ?? [])
    .map((item) => `${item.action}:${item.rel}:${item.hash ?? ''}`)
    .sort();
  const remove = (source.remove ?? [])
    .map((item) => `${item.action}:${item.rel}`)
    .sort();
  const dirs = [...(source.pruneDirs ?? [])].sort();
  const mkdirs = [...(source.restoreDirs ?? [])].sort();
  return createHash('sha1').update(JSON.stringify({ restore, remove, dirs, mkdirs })).digest('hex');
}

/**
 * 判断真实路径是否落在真实工作区内。
 * @param {string} realRoot - realpath 后的工作区根。
 * @param {string} realTarget - realpath 后的目标。
 * @returns {boolean} 是否在内部。
 */
function isWithinReal(realRoot, realTarget) {
  const rel = relative(realRoot, realTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 构造一个“真实路径”校验器。
 *
 * 词法上的 `relative()` 挡不住目录 junction / 符号链接：快照之后把某个目录替换成
 * 指向工作区外（或工作区内另一目录）的链接，`writeFile(join(cwd, rel))` 就会跟着
 * 写出去。这里对目标最近的已存在祖先做 realpath：既判断是否仍在工作区内，也判断
 * 真实相对路径是否**仍等于计划 rel**；写操作还拒绝目标是符号链接。
 * @param {string} cwd - 工作区根。
 * @returns {Promise<{realCwd: string, check: (target: string, options?: {write?: boolean, rel?: string}) => Promise<{ok: boolean, reason?: string}>}>} 校验器。
 */
async function createRealGuard(cwd) {
  const realCwd = await realpath(cwd).catch(() => normalizeWorkspacePath(cwd));
  const cache = new Map();
  const realOf = async (path) => {
    if (cache.has(path)) return cache.get(path);
    const value = await realpath(path).catch(() => path);
    cache.set(path, value);
    return value;
  };
  const check = async (target, { write = false, rel = null } = {}) => {
    let current = target;
    let leaf;
    for (;;) {
      const info = await lstat(current).catch(() => undefined);
      if (info !== undefined) {
        leaf = { path: current, info };
        break;
      }
      const parent = dirname(current);
      if (parent === current) return { ok: false, reason: 'no-existing-ancestor' };
      current = parent;
    }
    const realAncestor = await realOf(leaf.path);
    if (!isWithinReal(realCwd, realAncestor)) return { ok: false, reason: 'outside-workspace' };
    if (leaf.path === target && leaf.info.isSymbolicLink()) {
      // 目标本身是链接：写操作拒绝（会写到链接目标），删除操作允许（rm 删链接本身）。
      return write ? { ok: false, reason: 'target-is-symlink' } : { ok: true };
    }
    if (leaf.path === target) {
      const realTarget = await realOf(target);
      if (!isWithinReal(realCwd, realTarget)) return { ok: false, reason: 'outside-workspace' };
    }
    // 工作区内的 junction/symlink 祖先也会重定向到计划外的文件。只判断"仍在工作区内"
    // 不够，必须确认最近已存在祖先的真实相对路径与计划 rel 一致。
    if (typeof rel === 'string' && rel.length > 0) {
      const plannedRel = relWithinWorkspace(cwd, leaf.path);
      const actualRel = relWithinWorkspace(realCwd, realAncestor);
      if (plannedRel !== null && actualRel !== null && pathKeyOf(plannedRel) !== pathKeyOf(actualRel)) {
        return { ok: false, reason: 'redirected-path' };
      }
    }
    return { ok: true };
  };
  return { realCwd, check };
}

/**
 * 把任意 id 变成安全的目录/文件片段。
 *
 * 关键：`..`、`.`、`...` 这类**纯点号**片段在路径拼接里是有语义的（父目录/当前目录/
 * 一个普通文件名），一个来自 HTTP 的 sessionId 只要等于 `..`，记录就会被写到
 * `<root>` 而不是 `<root>/sessions/`。因此这里除了替换非法字符，还要拦住纯点号。
 * @param {string} id - 原始 id。
 * @returns {string} 安全片段（非空）。
 */
export function safeSegment(id) {
  const cleaned = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (cleaned.length === 0) return '_';
  // `.` / `..` / `...` 都不能当目录名或文件名片段：它们会被路径解析吃掉。
  if (/^\.+$/.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

/**
 * 把任意阶段名收敛到白名单。
 *
 * 阶段会进入记录 id，而记录 id 会进入文件名；这里不做白名单，`phase: '../../../x'`
 * 就能把一条 JSON 记录写到存储根之外。
 * @param {unknown} phase - 原始阶段。
 * @returns {string} 白名单内的阶段（否则 `manual`）。
 */
export function normalizePhase(phase) {
  return typeof phase === 'string' && PHASES.includes(phase) ? phase : 'manual';
}

/**
 * 从 user/message 事件数据里取出纯文本（用于快照标签）。
 * @param {unknown} data - 事件数据。
 * @returns {string} 文本。
 */
export function messageText(data) {
  const blocks = data?.message?.content ?? data?.content;
  if (typeof blocks === 'string') return blocks.trim();
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 判断一条 `user/message` 事件是不是**真实的用户提问**。
 *
 * 为什么需要判定：DSH 会在轮次前后注入大量同样是 `user/message` 的事件
 * （`runtime-context`、`skill-catalog`、`agent-instructions`、`tool-jobs`、
 * `subagent-settled`、`plugin`、`goal`…）。实测 1000+ 条里只有 835 条 kind 是 `user`。
 * 这些注入消息不是"用户在问什么"，若拿它们当本轮提问，快照的「说明」会变成
 * "Current runtime context. …" 这类文本，锚点也会停在注入消息上。
 * @param {unknown} data - 事件数据。
 * @returns {boolean} 是真实用户输入返回 true。
 */
export function isUserQuestion(data) {
  const kind = data?.source?.kind;
  // 老日志没有 source 字段：保持旧行为（按提问处理），避免漏掉真实提问。
  if (typeof kind !== 'string' || kind.length === 0) return true;
  return kind === 'user';
}

/**
 * 为诊断输出生成一行事件摘要。
 * @param {object} event - 会话事件。
 * @returns {string} 摘要文本。
 */
export function summarizeEvent(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'turn/end':
      return `reason=${JSON.stringify(data.reason)}`;
    case 'turn/start':
      return `turn=${String(data.turn)}`;
    case 'step/start':
    case 'step/end':
      return `turn=${String(data.turn)} step=${String(data.step)}`;
    case 'user/message':
      return messageText(data).slice(0, 80);
    case 'assistant/message': {
      const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
      const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join(' ');
      const tools = blocks.filter((block) => block?.type === 'tool-call').map((block) => block.name).join(',');
      return `${text.slice(0, 80)}${tools.length > 0 ? ` tools=[${tools}]` : ''}`;
    }
    case 'tool/result':
      return data.error !== undefined ? `error=${JSON.stringify(data.error)}` : 'ok';
    case 'session/end-seed':
      return 'seed boundary';
    default:
      return '';
  }
}

/**
 * 依据 DSH 的完成轮次规则，从事件流计算对话 fork 的安全切点。
 *
 * 与 `@deepseek-ai/dsh-api-session-controller` 的 `latestCompletedPrefixBoundary`
 * 保持同一语义：有上一轮 `turn/end` 时从它向后延伸独立事件，遇到 `turn/start`、
 * 用户消息或 `agent/inbox/spliced` 停止；没有完成轮次时切到第一个输入插入之前。
 * @param {Array<object>} events - 会话事件（按 seq 升序）。
 * @param {number|null} beforeSeq - 只考虑该 seq 之前的事件；null 表示全部。
 * @returns {number|null} 可用的 atSeq；无法计算返回 null。
 */
function forkBoundaryFromEvents(events, beforeSeq) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const limit = Number.isSafeInteger(beforeSeq) ? beforeSeq : Number.MAX_SAFE_INTEGER;
  const relevant = events.filter((event) => typeof event.seq === 'number' && event.seq < limit);
  if (relevant.length === 0) return null;
  const isInput = (event) =>
    event.type === 'agent/inbox/spliced'
    || (event.type === 'user/message' && (event.surfaceOp === 'append' || event.data?.source?.kind === 'user'));
  const lastEnd = relevant.findLast((event) => event.type === 'turn/end');
  if (lastEnd !== undefined) {
    let boundary = lastEnd.seq;
    for (const event of relevant) {
      if (event.seq <= boundary) continue;
      if (event.type === 'turn/start' || isInput(event)) break;
      boundary = event.seq;
    }
    return boundary;
  }
  const firstInput = relevant.find((event) => isInput(event));
  if (firstInput !== undefined) return Math.max(0, firstInput.seq - 1);
  return Math.max(0, limit - 1);
}

/** 快照 / 回滚服务。 */
export class SnapshotService {
  /**
   * @param {object} ctx - Host context。
   * @param {object} config - 原始配置。
   * @param {{info: Function, warn: Function, error: Function}} logger - 日志。
   */
  constructor(ctx, config, logger) {
    this.ctx = ctx;
    this.logger = logger;
    this.config = resolveConfig(config);
    this.pluginDir = HERE;
    /** 本代序号（热重载时递增，仅用于诊断）。 */
    this.generation = 0;
    this.started = false;
    this.disposed = false;
    this.stopDevChannel = undefined;
    this.disposeIndexTap = undefined;
    this.lastError = null;
    /** ctx.on 返回的 disposer（热重载时必须释放，避免监听累积）。 */
    this.listenerDisposers = [];
    /** 内容寻址快照存储。 */
    this.store = new SnapshotStore(this.config, logger);
    /** 每个会话的采集队列（串行化，避免并发扫描同一工作区）。 */
    this.queues = new Map();
    /**
     * 每个工作区的串行队列。
     *
     * 只按会话串行是不够的：同一 cwd 的多个会话共享一把工作区索引，并发的 scan/write
     * 会互相推进索引，导致增量快照漏文件。采集、手动采集、预览、回滚都走这里。
     */
    this.workspaceQueues = new Map();
    /**
     * 存储级串行队列。
     *
     * 工作区队列只覆盖同一 cwd；GC/prune/自愈这些维护操作会跨会话删除对象和记录，
     * 必须和采集/回滚/预览共用一把锁，否则可能出现「对象刚写入、记录还没落盘就被 GC
     * 回收」或「trim 提升基座的同时 GC 正在扫引用」的竞态。
     * 队列挂在跨代共享 holder 上：热重载/禁用启用产生的新实例与旧实例共用同一条尾指针，
     * 旧实例的在途采集不会与新实例的 GC 并发（跨进程仍需要外部锁，见 README 已知限制）。
     */
    this.shared = sharedHolder();
    if (!(this.shared.storeQueue instanceof Promise)) this.shared.storeQueue = Promise.resolve();
    this.storeQueue = this.shared.storeQueue;
    /** 回滚计划令牌：一次性、5 分钟过期。 */
    this.planTokens = new Map();
    /** 历史快照的对话切点安全校验缓存（key: sessionId + atSeq）。 */
    this.forkSafety = new Map();
    /** 回滚事务序号（只用于文件名去重）。 */
    this.restoreSeq = 0;
    /** 每个会话的瞬态元信息（标签、最近一次 turn/end 的 seq 等）。 */
    this.meta = new Map();
    /**
     * 已从日志水合过 filesTouched 的会话 id。
     * 「本会话改过哪些文件」必须跨插件重载/应用重启存活——否则用户重开面板时该选项
     * 会因为没有记录而不可用（这正是它一度"选不了"的原因）。
     */
    this.journalLoaded = new Set();
    /** 正在排队补基线的会话（turn-stopping 与 turn/end 可能同时触发）。 */
    this.baselineQueued = new Set();
    /**
     * 已做过「起点快照说明/锚点自愈」的会话 id（本代内只做一次，自愈本身幂等）。
     * @type {Set<string>}
     */
    this.labelRepaired = new Set();
    /** 会话写入日志目录的 mkdir 结果缓存（只建一次）。 */
    this.journalReady = undefined;
    /** 最近一次采集摘要，供 UI/自检显示。 */
    this.lastCapture = null;
    /** 快照存储根不可写时的错误（启动探测/采集失败时设置）。 */
    this.storageError = null;
    /** 排除规则的编译结果（含通配；配置不再变化，构造时算一次）。 */
    this.excludeMatch = compileExcludeMatcher(this.config.excludes, this.config.excludeExtensions);
  }

  /**
   * 取（或初始化）某会话的元信息。
   * @param {object} session - Session 对象。
   * @returns {object} 元信息。
   */
  metaFor(session) {
    let meta = this.meta.get(session.id);
    if (meta === undefined) {
      meta = { turn: null, label: null, labelSeq: null, labelTurn: undefined, lastTurnEndSeq: null, snapshots: 0, lastError: null, filesTouched: [], cwd: null, running: null, lastEventAt: 0 };
      this.meta.set(session.id, meta);
    }
    return meta;
  }

  /**
   * 把任务排进某个工作区的串行队列。
   * @param {string} cwd - 工作区根。
   * @param {() => Promise<T>} task - 任务。
   * @returns {Promise<T>} 任务结果。
   * @template T
   */
  withWorkspace(cwd, task) {
    const key = normalizeWorkspacePath(cwd).toLowerCase();
    if (key.length === 0) return task();
    const previous = this.workspaceQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    // 队列里保存一个不会 reject 的尾指针，避免一次失败把后续任务全部带崩。
    this.workspaceQueues.set(key, next.catch(() => undefined));
    return next;
  }

  /**
   * 把任务排进存储级串行队列。
   * @param {() => Promise<T>} task - 任务。
   * @returns {Promise<T>} 任务结果。
   * @template T
   */
  withStore(task) {
    const previous = this.shared?.storeQueue ?? this.storeQueue;
    const next = previous.catch(() => undefined).then(async () => {
      const release = await acquireStoreLock(this.config.root, this.logger);
      try {
        return await task();
      } finally {
        await release();
      }
    });
    const tail = next.catch(() => undefined);
    this.storeQueue = tail;
    if (this.shared !== undefined && this.shared !== null) this.shared.storeQueue = tail;
    return next;
  }

  /**
   * 检测会话当前是否仍在运行。
   *
   * 两个来源：
   *   1. 事件流维护的 `meta.running`（本代插件亲眼看到 turn/start 之后、turn/end 之前）；
   *   2. `sessionController.list()` 的 `running` 字段，用来兜住“插件在轮次中途才挂上”
   *      以及运行中的子代理。
   *
   * **任一来源明确为运行中即拒绝**。注意不能反过来让 `list` 的 `false` 覆盖事件流的
   * `true`：`list` 是读取时刻的快照，可能比 turn/start 事件晚一拍；一旦覆盖，
   * 回滚就会和正在写文件的轮次并发执行（`applyFilePlan` 的逐文件检查也会失效）。
   * 只有“事件流说运行中、控制器明确说空闲、且该会话超过 STALE_RUNNING_MS 没有任何
   * 新事件”时，才把运行标记当成陈旧的（turn/end 丢失）修回空闲。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{state: boolean|null, source: 'events'|'list'|'stale-events'|'unknown', subagents: string[]}>} 状态。
   */
  async detectRunning(sessionId) {
    const meta = this.meta.get(sessionId);
    const controller = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : undefined;
    let listState = null;
    let subagents = [];
    if (controller !== null && controller !== undefined && typeof controller.list === 'function') {
      try {
        const result = await controller.list({}, new AbortController().signal);
        const items = Array.isArray(result?.items) ? result.items : [];
        const self = items.find((item) => item?.sessionId === sessionId);
        subagents = items
          .filter((item) => item?.parentSessionId === sessionId && item?.running === true)
          .map((item) => String(item.sessionId));
        if (self !== undefined && typeof self.running === 'boolean') listState = self.running;
      } catch {
        /* list 不可用/超时：退回到事件流状态 */
      }
    }
    if (listState === true || subagents.length > 0) {
      // 注意不要把它写回 meta.running：那会让一次瞬时的“运行中”读数永久污染
      // 事件流状态（list 之后回落成 false 时，回滚会被永久拒绝）。
      return { state: true, source: 'list', subagents };
    }
    if (meta?.running === true) {
      const lastAt = Number.isSafeInteger(meta.lastEventAt) && meta.lastEventAt > 0 ? meta.lastEventAt : null;
      const silent = lastAt !== null && Date.now() - lastAt > STALE_RUNNING_MS;
      if (listState === false && silent) {
        meta.running = false;
        return { state: false, source: 'stale-events', subagents: [] };
      }
      return { state: true, source: 'events', subagents };
    }
    if (meta?.running === false) return { state: false, source: 'events', subagents: [] };
    if (listState === false) return { state: false, source: 'list', subagents: [] };
    return { state: null, source: 'unknown', subagents: [] };
  }

  /**
   * 找出**同一工作区里其他正在运行**的会话（包括其子代理）。
   *
   * 只检查“本会话是否在跑”不够：同一 cwd 的另一个会话一边跑一边写文件时，
   * 回滚会把它的写入踩掉，反之亦然。这里按规范化 cwd 比对，同时用
   * 事件流（this.meta）与 `sessionController.list()` 两个来源。
   * @param {string} cwd - 工作区根。
   * @param {string} exceptSessionId - 发起回滚的会话（排除自身）。
   * @returns {Promise<Array<{sessionId: string, source: 'events'|'list'}>>} 正在使用该工作区的其他会话。
   */
  async detectWorkspaceBusy(cwd, exceptSessionId) {
    const key = normalizeWorkspacePath(cwd).toLowerCase();
    if (key.length === 0) return [];
    const busy = new Map();
    for (const [id, meta] of this.meta) {
      if (id === exceptSessionId || meta?.running !== true) continue;
      if (typeof meta.cwd !== 'string' || meta.cwd.length === 0) continue;
      if (normalizeWorkspacePath(meta.cwd).toLowerCase() !== key) continue;
      busy.set(id, 'events');
    }
    const controller = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : undefined;
    if (controller !== null && controller !== undefined && typeof controller.list === 'function') {
      try {
        const result = await controller.list({}, new AbortController().signal);
        const items = Array.isArray(result?.items) ? result.items : [];
        for (const item of items) {
          if (item === null || item === undefined) continue;
          const id = String(item.sessionId ?? '');
          if (id.length === 0 || id === exceptSessionId || item.running !== true) continue;
          if (typeof item.cwd !== 'string' || item.cwd.length === 0) continue;
          if (normalizeWorkspacePath(item.cwd).toLowerCase() !== key) continue;
          busy.set(id, 'list');
        }
      } catch {
        /* list 不可用：只用事件流里已知的会话 */
      }
    }
    return [...busy.entries()].map(([sessionId, source]) => ({ sessionId, source }));
  }

  /**
   * 生成运行中拒绝回滚的统一错误文案。
   * @param {{subagents?: string[]}} info - detectRunning 的结果。
   * @returns {string} 错误文案。
   */
  runningError(info) {
    const sub = Array.isArray(info?.subagents) && info.subagents.length > 0
      ? `（含 ${info.subagents.length} 个运行中的子代理）`
      : '';
    return `当前会话仍在运行${sub}，已拒绝回滚。请先停止当前轮/子代理，等待结束（turn/end）后再重新预览。`;
  }

  /**
   * 回滚事务日志目录。
   * @returns {string} 绝对路径。
   */
  restoreDir() {
    return join(this.config.root, RESTORE_DIR);
  }

  /**
   * 某条回滚事务的日志路径。
   * @param {string} id - 事务 id。
   * @returns {string} 绝对路径。
   */
  restoreTxPath(id) {
    return join(this.restoreDir(), `${safeSegment(id)}.json`);
  }

  /**
   * 生成一条回滚事务 id。
   * @returns {string} id。
   */
  nextRestoreId() {
    this.restoreSeq += 1;
    return `tx-${Date.now().toString(36)}-${this.restoreSeq}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * 清理过期/已用的计划令牌。
   * @returns {void}
   */
  prunePlanTokens() {
    const now = Date.now();
    for (const [token, entry] of this.planTokens) {
      // 已用令牌保留到过期，这样重复执行能明确提示“已使用过”，而不是“无效”。
      if (entry.expiresAt <= now || now - entry.createdAt > 2 * PLAN_TOKEN_TTL_MS) {
        this.planTokens.delete(token);
      }
    }
    if (this.planTokens.size > 500) {
      const ordered = [...this.planTokens.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const entry of ordered.slice(0, this.planTokens.size - 500)) this.planTokens.delete(entry.token);
    }
  }

  /**
   * 为一份完整计划签发一次性确认令牌。
   * @param {object} plan - buildPlan 的结果（完整清单）。
   * @returns {string} 令牌。
   */
  issuePlanToken(plan) {
    this.prunePlanTokens();
    const token = randomUUID();
    const now = Date.now();
    this.planTokens.set(token, {
      token,
      sessionId: plan.sessionId,
      snapshotId: plan.snapshotId,
      hashes: {
        all: planHashFor(plan, 'all'),
        session: planHashFor(plan, 'session'),
      },
      createdAt: now,
      expiresAt: now + PLAN_TOKEN_TTL_MS,
      used: false,
    });
    return token;
  }

  /**
   * 校验一个计划令牌但不标记为已使用。
   *
   * 回滚在真正写文件前还要采集恢复点；恢复点失败时工作区没有变化，令牌不应被烧掉，
   * 否则用户重试会看到误导性的“已使用过”。校验与提交分开，提交在恢复点成功后进行。
   * @param {string} token - 令牌。
   * @param {{sessionId: string, snapshotId: string, scope: 'all'|'session', files: boolean}} expected - 期望绑定。
   * @param {{all: string, session: string}} [actualHashes] - 重新 buildPlan 后的实际计划摘要。
   * @returns {object} 令牌记录。
   */
  validatePlanToken(token, expected, actualHashes) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('缺少 planToken：请先预览并确认回滚清单');
    }
    this.prunePlanTokens();
    const entry = this.planTokens.get(token);
    if (entry === undefined) throw new Error('回滚确认令牌无效或已过期，请重新预览');
    if (entry.used) throw new Error('回滚确认令牌已使用过，请重新预览');
    if (entry.expiresAt <= Date.now()) throw new Error('回滚确认令牌已过期，请重新预览');
    if (entry.sessionId !== expected.sessionId || entry.snapshotId !== expected.snapshotId) {
      throw new Error('回滚确认令牌与目标快照不匹配，请重新预览');
    }
    if (expected.files === true) {
      const wanted = entry.hashes[expected.scope] ?? '';
      const actual = actualHashes?.[expected.scope] ?? '';
      if (wanted.length === 0 || actual.length === 0 || wanted !== actual) {
        throw new Error('工作区在预览之后已发生变化，计划清单不再一致：请重新预览并确认');
      }
    }
    return entry;
  }

  /**
   * 校验并消费一个计划令牌。
   *
   * 令牌绑定完整计划摘要：预览之后工作区又变了，摘要对不上就拒绝执行，
   * 而不是让用户“确认了 A、实际执行 B”。令牌只用一次。
   * @param {string} token - 令牌。
   * @param {{sessionId: string, snapshotId: string, scope: 'all'|'session', files: boolean}} expected - 期望绑定。
   * @param {{all: string, session: string}} [actualHashes] - 重新 buildPlan 后的实际计划摘要。
   * @returns {object} 令牌记录。
   */
  consumePlanToken(token, expected, actualHashes) {
    const entry = this.validatePlanToken(token, expected, actualHashes);
    entry.used = true;
    return entry;
  }

  /**
   * 读取回滚事务日志。
   * @param {string} id - 事务 id。
   * @returns {Promise<object|null>} 日志或 null。
   */
  async readRestoreTx(id) {
    return readJson(this.restoreTxPath(id));
  }

  /**
   * 写入回滚事务日志。
   * @param {object} tx - 事务记录。
   * @returns {Promise<void>} 写完后 resolve。
   */
  async writeRestoreTx(tx) {
    await writeJson(this.restoreTxPath(tx.id), tx);
  }

  /**
   * 列出尚未收尾的回滚事务（崩溃/中断后供 UI 恢复）。
   * @param {string} [sessionId] - 只列某会话。
   * @returns {Promise<Array<object>>} 事务摘要。
   */
  async listRecoveries(sessionId) {
    const dir = this.restoreDir();
    const names = await readdir(dir).catch(() => []);
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const tx = await readJson(join(dir, name));
      if (tx === null || typeof tx.id !== 'string') continue;
      if (sessionId !== undefined && sessionId.length > 0 && tx.sessionId !== sessionId) continue;
      if (!['in-progress', 'interrupted', 'partial', 'failed'].includes(tx.status)) continue;
      out.push({
        id: tx.id,
        sessionId: tx.sessionId,
        snapshotId: tx.snapshotId,
        preRollbackId: tx.preRollbackId ?? null,
        scope: tx.scope ?? 'all',
        status: tx.status,
        startedAt: tx.startedAt ?? null,
        interruptedAt: tx.interruptedAt ?? null,
        cwd: tx.cwd ?? null,
        plan: tx.plan ?? null,
      });
    }
    out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return out;
  }

  /**
   * 启动时把上次进程留下的 in-progress 事务标成 interrupted。
   * @returns {Promise<number>} 标记数量。
   */
  async markInterruptedTransactions() {
    const dir = this.restoreDir();
    const names = await readdir(dir).catch(() => []);
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(dir, name);
      const tx = await readJson(file);
      if (tx === null || tx.status !== 'in-progress') continue;
      tx.status = 'interrupted';
      tx.interruptedAt = Date.now();
      await writeJson(file, tx);
      count += 1;
    }
    return count;
  }

  /**
   * 清理已经收尾的回滚事务日志（默认保留 7 天，供诊断）。
   *
   * 事务文件原先只写不删；长期使用后 `listRecoveries` 每次面板打开都要反序列化全部文件，
   * 且已完成的事务会无界增长。这里只删 `done/recovered/reverted`，未收尾的事务保留。
   * @param {number} [maxAgeMs] - 保留时长。
   * @returns {Promise<number>} 删除数量。
   */
  async pruneRestoreTransactions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    return this.withStore(async () => {
      const dir = this.restoreDir();
      const names = await readdir(dir).catch(() => []);
      let removed = 0;
      const cutoff = Date.now() - maxAgeMs;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = join(dir, name);
        const tx = await readJson(file);
        if (tx === null) continue;
        if (!['done', 'recovered', 'reverted'].includes(tx.status)) continue;
        const finishedAt = tx.finishedAt ?? tx.recoveredAt ?? tx.startedAt ?? 0;
        if (finishedAt >= cutoff) continue;
        await rm(file, { force: true });
        removed += 1;
      }
      return removed;
    });
  }

  /**
   * 「本会话改过哪些文件」的日志文件路径。
   * 存放在存储根下（而不是工作区里），既不污染工作区，也不随工作区快照回滚。
   * @param {string} sessionId - 会话 id。
   * @returns {string} 绝对路径。
   */
  journalPath(sessionId) {
    return join(this.config.root, 'journal', `${safeSegment(sessionId)}.jsonl`);
  }

  /**
   * 从磁盘水合某会话的 filesTouched（每行一个相对路径）。
   *
   * 为什么要落盘：这份记录原先只存在内存里，插件每次热重载/应用重启都会丢，
   * 于是「只恢复本次会话修改的文件」对重启前的会话永远没有记录、选项不可用。
   * @param {object} session - Session。
   * @returns {Promise<string[]>} 已记录的路径（去重后）。
   */
  async loadJournal(session) {
    const meta = this.metaFor(session);
    if (this.journalLoaded.has(session.id)) return meta.filesTouched ?? [];
    let text = '';
    try {
      text = await readFile(this.journalPath(session.id), 'utf8');
    } catch (error) {
      // 文件不存在 = 这个会话确实没有记录，可以缓存；
      // 但瞬时错误（占用/权限/IO）不能缓存——否则一次失败会让这个会话的
      // 「只恢复本次会话修改的文件」永久为空，直到插件重载。
      if (error?.code === 'ENOENT') this.journalLoaded.add(session.id);
      return meta.filesTouched ?? [];
    }
    this.journalLoaded.add(session.id);
    const loaded = [];
    for (const line of text.split('\n')) {
      const rel = line.trim();
      if (rel.length === 0) continue;
      loaded.push(rel);
      if (loaded.length >= MAX_TRACKED_FILES) break;
    }
    // 合并而不是覆盖：水合期间可能已有新的工具调用写进了内存。
    // 这里对"当前" meta.filesTouched 判重（而不是 await 之前的那份），避免并发下写出重复项。
    const current = Array.isArray(meta.filesTouched) ? meta.filesTouched : [];
    for (const rel of loaded) {
      if (current.length >= MAX_TRACKED_FILES) break;
      if (!current.includes(rel)) current.push(rel);
    }
    meta.filesTouched = current;
    return meta.filesTouched;
  }

  /**
   * 追加一条「本会话写过的文件」记录（异步，失败不影响主流程）。
   * 注意 `appendFile` 的 `recursive` 选项**不会**建目录（实测 ENOENT），必须先 mkdir。
   * @param {string} sessionId - 会话 id。
   * @param {string} rel - 工作区相对路径。
   * @returns {void}
   */
  appendJournal(sessionId, rel) {
    const file = this.journalPath(sessionId);
    const journalDir = join(this.config.root, 'journal');
    if (this.journalReady === undefined) {
      this.journalReady = mkdir(journalDir, { recursive: true }).catch((error) => {
        // 建目录失败就清掉缓存，下次再试
        this.journalReady = undefined;
        this.logger.warn(`创建会话写入日志目录失败：${String(error?.message ?? error)}`);
      });
    }
    void this.journalReady
      .then(() => appendFile(file, `${rel}\n`, 'utf8'))
      .catch((error) => {
        this.logger.warn(`写入会话写入记录失败：${String(error?.message ?? error)}`);
      });
  }

  /**
   * 记下一个「本会话写过的文件」并落盘。
   * @param {object} session - Session。
   * @param {string} rel - 工作区相对路径。
   * @returns {Promise<string[]>} 记录后的集合。
   */
  async recordTouched(session, rel) {
    const paths = await this.loadJournal(session);
    const meta = this.metaFor(session);
    if (!Array.isArray(meta.filesTouched)) meta.filesTouched = paths;
    if (meta.filesTouched.length >= MAX_TRACKED_FILES || meta.filesTouched.includes(rel)) {
      return meta.filesTouched;
    }
    meta.filesTouched.push(rel);
    this.appendJournal(session.id, rel);
    return meta.filesTouched;
  }

  /**
   * 会话目录清单路径。
   * @returns {string} 路径。
   */
  sessionManifestPath() {
    return join(this.config.root, 'sessions', '.manifest.json');
  }

  /**
   * 启动时补建会话目录清单，并把当前所有会话目录并入。
   *
   * `gcObjects` 只能看到磁盘上仍存在的会话目录；如果某个目录被整体移走/瞬时不可见，
   * 它引用的对象会被当成孤儿删除。清单记录“曾经有过快照的会话”，缺失时让 GC 中止。
   * 清单损坏/不存在时不假装有保护。
   * @returns {Promise<void>}
   */
  async ensureSessionManifest() {
    return this.withStore(async () => {
      const dir = join(this.config.root, 'sessions');
      let folders;
      try {
        folders = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const manifestPath = this.sessionManifestPath();
      const existing = await readJson(manifestPath);
      const fileExists = await stat(manifestPath).then(() => true).catch(() => false);
      if (existing === null && fileExists) return; // 清单损坏：不覆盖，让 GC 保持保守
      const sessions = new Set(Array.isArray(existing?.sessions) ? existing.sessions : []);
      const before = sessions.size;
      for (const folder of folders) {
        if (folder.isDirectory()) sessions.add(folder.name);
      }
      if (sessions.size === before && existing !== null) return;
      await writeJson(manifestPath, { sessions: [...sessions].sort() });
    });
  }

  /**
   * 把某会话记入清单（在 capture 的存储锁内调用）。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<void>}
   */
  async rememberSession(sessionId) {
    const manifestPath = this.sessionManifestPath();
    const existing = await readJson(manifestPath);
    const fileExists = await stat(manifestPath).then(() => true).catch(() => false);
    if (existing === null && fileExists) return;
    const sessions = new Set(Array.isArray(existing?.sessions) ? existing.sessions : []);
    // 首次创建清单时把现有会话目录一并纳入，避免升级后的第一次采集只记住当前会话。
    if (existing === null) {
      const dir = join(this.config.root, 'sessions');
      const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const folder of folders) if (folder.isDirectory()) sessions.add(folder.name);
    }
    const key = safeSegment(sessionId);
    if (existing !== null && sessions.has(key)) return;
    sessions.add(key);
    await writeJson(manifestPath, { sessions: [...sessions].sort() });
  }

  /**
   * 从清单移除已彻底清理的会话目录。
   * @param {string[]} sessionIds - 会话 id。
   * @returns {Promise<void>}
   */
  async forgetSessions(sessionIds) {
    const manifestPath = this.sessionManifestPath();
    const existing = await readJson(manifestPath);
    if (existing === null || !Array.isArray(existing.sessions)) return;
    const remove = new Set(sessionIds.map((id) => safeSegment(id)));
    const sessions = existing.sessions.filter((id) => !remove.has(id));
    if (sessions.length === existing.sessions.length) return;
    await writeJson(manifestPath, { sessions });
  }

  /**
   * 探测快照根是否可写。
   *
   * 只读 home / 受限环境里 mkdir/writeFile 会直接抛错；以前失败只落日志，
   * 面板表现为“没有快照”。这里把错误留到 status/listSnapshots 里，让 UI 能说清楚原因。
   * @returns {Promise<string|null>} 失败原因或 null。
   */
  async checkStoreWritable() {
    const probe = join(this.config.root, `.write-probe-${process.pid}-${Date.now()}`);
    try {
      await mkdir(this.config.root, { recursive: true });
      await writeFile(probe, 'ok', 'utf8');
      await rm(probe, { force: true });
      this.storageError = null;
      return null;
    } catch (error) {
      const message = String(error?.message ?? error);
      this.storageError = `快照存储根不可写（${this.config.root}）：${message}`;
      this.logger.error(this.storageError);
      return this.storageError;
    }
  }

  /** 注册会话事件监听并启动开发通道。 */
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.logger.info(`存储根目录：${this.config.root}`);
    void this.writeBootMarker();
    void this.checkStoreWritable();
    // 维护会话目录清单：GC 用它在“某个会话目录整体不可见”时拒绝清对象。
    void this.ensureSessionManifest().catch((error) => {
      this.logger.warn(`会话目录清单初始化失败：${String(error?.message ?? error)}`);
    });
    // 上次进程如果在回滚中途退出，事务日志会停在 in-progress。启动时先标成
    // interrupted，让 UI 能弹出恢复入口，而不是把半完成状态当成正常状态。
    void this.withStore(() => this.markInterruptedTransactions())
      .then(async (count) => {
        if (count > 0) this.logger.warn(`检测到 ${count} 条中断的回滚事务，等待用户选择恢复方式`);
        const pruned = await this.pruneRestoreTransactions();
        if (pruned > 0) this.logger.info(`已清理 ${pruned} 条过期的回滚事务日志`);
      })
      .catch((error) => {
        this.logger.warn(`标记中断回滚事务失败：${String(error?.message ?? error)}`);
      });

    try {
      // ctx.on 返回 disposer：必须收集，否则每次热重载都会多留一份监听
      //（曾导致一次 turn/start 触发 8 次采集）。
      const listen = (event, handler) => {
        const dispose = this.ctx.on(event, handler);
        if (typeof dispose === 'function') this.listenerDisposers.push(dispose);
      };
      listen('session/event', (session, event) => {
        try {
          this.onSessionEvent(session, event);
        } catch (error) {
          this.lastError = { at: Date.now(), route: 'session/event', message: String(error?.message ?? error) };
          this.logger.warn(`处理 session/event 失败：${String(error?.message ?? error)}`);
        }
      });
      listen('agent/turn-stopping', ({ agent, turn }) => {
        try {
          const session = agent?.session;
          if (session === undefined) return;
          if (!this.config.captureOnTurnEnd) return;
          const origin = session?.header?.origin;
          const depth = session?.header?.delegationDepth ?? 0;
          if (origin === 'subagent' || depth > 0) return;
          const meta = this.metaFor(session);
          void this.captureBaselineIfNew(session, { seq: null, forkSeq: meta.lastTurnEndSeq ?? null, turn: turn ?? meta.turn, queuedAt: Date.now() });
        } catch (error) {
          this.logger.warn(`处理 agent/turn-stopping 失败：${String(error?.message ?? error)}`);
        }
      });
      listen('session/disposed', (session) => {
        this.meta.delete(session.id);
      });
    } catch (error) {
      this.logger.warn(`注册会话监听失败：${String(error?.message ?? error)}`);
    }

    if (typeof this.config.devChannelDir === 'string' && this.config.devChannelDir.length > 0) {
      if (this.config.devChannelToken.length === 0) {
        this.logger.warn('devChannelDir 已配置但缺少 devChannelToken；开发命令通道未启动（避免无鉴权写入通道）');
      } else {
        this.stopDevChannel = startDevChannel({
          dir: this.config.devChannelDir,
          logger: this.logger,
          token: this.config.devChannelToken,
          dispatch: (cmd) => this.dispatch(cmd),
        });
      }
    }

    // 每次挂载都自愈一次：把历史遗留的非规范化工作区 key 归并掉。
    void this.normalizeIndexKeys().catch((error) => {
      this.logger.warn(`工作区索引 key 归并失败：${String(error?.message ?? error)}`);
    });

    // 顺带自愈：修正历史上"结果快照锚点退化成起点"的记录。
    void this.repairEndAnchors().catch((error) => {
      this.logger.warn(`结果快照锚点修复失败：${String(error?.message ?? error)}`);
    });
  }

  /**
   * 处理单个会话事件：维护元信息并按轮次边界排队采集。
   * @param {object} session - Session。
   * @param {object} event - SessionEvent。
   * @returns {void}
   */
  onSessionEvent(session, event) {
    if (session === undefined || event === undefined) return;
    const meta = this.metaFor(session);
    // 运行状态不能只靠 turn/end：事件流是“活着的”证据，`lastEventAt` 用于在
    // 控制器报告空闲时判断“运行标记是不是已经陈旧”（见 detectRunning）。
    meta.lastEventAt = Date.now();
    // 每次事件都刷新真实工作目录：DSH 的 /cd 只追加 working-directory/change，
    // 不会改 header.cwd；这里优先用宿主的 workingDirectory 投影，其次事件缓存。
    this.recordSessionCwd(session);
    const type = event.type;

    if (type === 'working-directory/change') {
      const next = typeof event.data?.cwd === 'string' ? event.data.cwd : '';
      if (next.length > 0) meta.cwd = normalizeWorkspacePath(next);
      return;
    }

    if (type === 'user/message') {
      // 只有真实用户输入才算"本轮提问"；runtime-context 等注入消息一律不改标签/锚点。
      if (!isUserQuestion(event.data)) return;
      // 同一轮里可能有多次真实提问（排队输入、追加指令）：以**第一条**代表本轮，
      // 后续提问不再改写说明与锚点——切点在本轮之前，语义上属于同一条快照。
      if (meta.labelTurn === meta.turn) return;
      const text = messageText(event.data);
      if (text.length > 0) {
        meta.label = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        meta.labelSeq = event.seq;
      }
      meta.labelTurn = meta.turn;
      // 把「问题起点」快照重新锚到这条提问上：turn/start 比 user/message 早若干事件，
      // 若锚在 turn/start，时间线上它会落在上一轮回复与本次提问之间（首轮则完全没有说明）。
      void this.reanchorToQuestion(session, event.seq, text.length > 0 ? meta.label : null);
      return;
    }
    if (type === 'tool/call') {
      // 记录「本会话自己改过哪些文件」，供回滚时选择「只恢复本次会话修改的文件」。
      // 覆盖 write / edit / 有修改作用的 str_replace_editor；经 pwsh 等间接改的文件
      // 拿不到路径，属于已知不完整，因此该范围只是可选项、绝不作为默认行为。
      const abs = extractMutationPath(event.data?.name, event.data?.arguments);
      if (abs !== null) {
        const rel = relWithinWorkspace(this.effectiveCwdForSession(session), abs);
        if (rel !== null && !this.excludeMatch(rel)) {
          void this.recordTouched(session, rel);
        }
      }
      return;
    }
    const origin = session?.header?.origin;
    const depth = session?.header?.delegationDepth ?? 0;
    const isSubagent = origin === 'subagent' || depth > 0;
    if (type === 'turn/start') {
      meta.turn = event.data?.turn ?? meta.turn;
      meta.running = true;
      if (this.config.captureOnTurnStart && !isSubagent) {
        this.queueCapture(session, 'start', {
          seq: event.seq,
          // 本轮之前最后一次 turn/end；没有（首轮/插件重载后）时为 null，由 capture
          // 从持久化事件流计算一个**不包含本轮提问**的干净切点。
          forkSeq: meta.lastTurnEndSeq ?? null,
          turn: meta.turn,
          queuedAt: Date.now(),
        });
      }
      return;
    }
    if (type === 'turn/end') {
      meta.lastTurnEndSeq = event.seq;
      meta.running = false;
      // 每次轮次结束不再采集"结果快照"：回滚的语义统一为"回到本轮之前"，
      // 而那一刻的状态由下一轮的 start 快照承载。这里只保一个安全网 ——
      // 若该会话此前一条记录都没有（插件在会话中途才装上），补一条基线，
      // 否则这一轮跑出来的改动将没有任何还原点。
      if (this.config.captureOnTurnEnd && !isSubagent) {
        void this.captureBaselineIfNew(session, { seq: event.seq, forkSeq: event.seq, turn: event.data?.turn ?? meta.turn, queuedAt: Date.now() });
      }
      return;
    }
  }

  /**
   * 仅当该会话还没有任何快照时，补一条基线。
   *
   * 用途是兜住"插件在会话中途才挂上"的情况：那时本轮之前的状态没被记录过，
   * 若不补基线，这一轮的改动将无法回滚。除此之外不再按轮次采集，保持"一轮一条"。
   * @param {object} session - Session。
   * @param {{seq: number|null, forkSeq: number|null, turn: number|null}} info - 位置信息。
   * @returns {Promise<object>} 采集或跳过结果。
   */
  async captureBaselineIfNew(session, info) {
    // `agent/turn-stopping` 与 `turn/end` 会几乎同时触发；检查在入队之前，
    // 两个调用可能都看到“还没有快照”而各排一条 baseline。这里用会话级标记去重。
    if (this.baselineQueued.has(session.id)) {
      return { skipped: true, reason: 'baseline-already-queued' };
    }
    this.baselineQueued.add(session.id);
    try {
      const existing = await this.store.listSnapshots(session.id).catch(() => []);
      if (Array.isArray(existing) && existing.length > 0) {
        return { skipped: true, reason: 'already-has-snapshots', count: existing.length };
      }
      return await this.queueCapture(session, 'baseline', info);
    } finally {
      this.baselineQueued.delete(session.id);
    }
  }

  /**
   * 把「起点」快照的对话位置与说明重新锚到本次提问上。
   *
   * 起因：`turn/start` 比 `user/message` 早几个事件（实测 turn/start 在 seq=282、
   * 提问在 seq=285），而采集是挂在 `turn/start` 上的，于是快照在时间线上落在
   * 「上一轮回复之后、本次提问之前」——既不是提问起点，也不是上一轮终点。
   *
   * 改两样东西：
   *   - `seq`：时间线上的位置，改成这条提问的序号；
   *   - `label`：说明，改成这条提问的文本。
   * 为什么必须连 label 一起改：采集发生在 `turn/start`，那一刻**本轮提问还没到**，
   * 于是首轮的快照永远没有说明（列表里显示「—」），后续轮次显示的是**上一轮**提问，
   * 看起来就像把快照标在了"上一轮回答之后"的位置上。
   *
   * 不动的：
   *   - `files`/`changes`：文件状态仍是 turn/start 那一刻采的，语义正确；
   *   - `forkSeq`：保持「本轮之前」的干净切点，因此回滚后新会话不会包含这次提问。
   * @param {object} session - Session。
   * @param {number} seq - 该条 user/message 的事件序号。
   * @param {string|null} [label] - 该条提问的文本（空则只改位置）。
   * @returns {Promise<object>} 结果（无快照可锚时为 {skipped:true}）。
   */
  reanchorToQuestion(session, seq, label = null) {
    // 排在该会话的采集队列之后：提问常与本轮 turn/start 采集同时到达。
    const previous = this.queues.get(session.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.withStore(async () => {
        if (!Number.isSafeInteger(seq) || seq <= 0) return { skipped: true, reason: 'bad-seq' };
        const snapshots = await this.store.listSnapshots(session.id);
        const last = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;
        if (last === undefined) return { skipped: true, reason: 'no-snapshot' };
        if (last.phase !== 'start') return { skipped: true, reason: `phase-${String(last.phase)}` };
        // 只锚「刚刚」采下的那条。
        if (!(Date.now() - (last.at ?? 0) < 10 * 60 * 1000)) return { skipped: true, reason: 'too-old' };

        const patch = {};
        // 位置：只往"更靠后的提问"方向挪。
        if (!(typeof last.seq === 'number' && last.seq >= seq)) patch.seq = seq;
        // 说明：这条快照属于本次提问，标签必须跟着提问走。
        const text = typeof label === 'string' ? label.trim() : '';
        if (text.length > 0 && last.label !== text) patch.label = text;
        if (Object.keys(patch).length === 0) return { skipped: true, reason: 'already-anchored' };

        const refined = { ...last, ...patch };
        await this.store.putSnapshot(refined);
        this.logger.info(
          `快照重锚（${last.id}）：seq ${String(last.seq)}→${String(refined.seq)}`
          + `，label ${JSON.stringify((last.label ?? '').slice(0, 24))}→${JSON.stringify((refined.label ?? '').slice(0, 24))}`
          + `（forkSeq 保持 ${String(refined.forkSeq)}）`,
        );
        return { reanchored: true, id: last.id, seq: refined.seq, label: refined.label ?? null, forkSeq: refined.forkSeq };
      }))
      .catch((error) => {
        this.logger.warn(`重锚快照位置失败：${String(error?.message ?? error)}`);
        return { skipped: true, reason: 'error' };
      });
    this.queues.set(session.id, next);
    return next;
  }

  /**
   * 把一次采集排进该会话的串行队列。
   * @param {object} session - Session。
   * @param {'start'|'end'|'manual'} phase - 采集阶段。
   * @param {{seq: number|null, forkSeq: number|null, turn: number|null}} info - 位置信息。
   * @returns {Promise<object|undefined>} 采集结果。
   */
  queueCapture(session, phase, info) {
    const previous = this.queues.get(session.id) ?? Promise.resolve();
    // 触发时刻必须在**入队时**记下，而不是任务真正执行时：中间可能排着另一工作区的
    // 首次全量采集（秒级），这段时间里本轮写入不应被静默并进“本轮之前”的快照。
    const detail = { ...info, queuedAt: Number.isSafeInteger(info?.queuedAt) ? info.queuedAt : Date.now() };
    const next = previous
      .catch(() => undefined)
      // 先按会话串行，再按存储串行，最后按工作区串行：
      // 同一 cwd 的多个会话不能同时扫/写索引，维护操作也不能和采集交错。
      //
      // cwd 必须在**真正执行时**读取：入队到执行之间会话可能被 /cd 切走，
      // 拿入队时的旧目录加锁会锁错工作区（扫描用的却是新目录）。
      .then(() => this.withStore(() => {
        const cwd = this.effectiveCwdForSession(session);
        return typeof cwd === 'string' && cwd.length > 0
          ? this.withWorkspace(cwd, () => this.capture(session, phase, detail))
          : this.capture(session, phase, detail);
      }))
      .catch((error) => {
        const message = String(error?.message ?? error);
        this.lastError = { at: Date.now(), route: `capture:${phase}`, sessionId: session.id, message };
        this.logger.warn(`采集失败（${phase}）：${message}`);
        return undefined;
      });
    this.queues.set(session.id, next);
    return next;
  }

  /**
   * 从持久化事件流计算一个**不包含待处理用户输入**的对话切点。
   *
   * 背景：DSH 的 `/cd`、`agent/inbox/spliced`、用户消息都是追加事件；`session.header.cwd`
   * 不变。`fork` 用的是"到 atSeq 为止"的精确前缀，而首轮/插件重载后没有可用的
   * `lastTurnEndSeq`，旧代码取 `turn/start.seq - 1`，正好落在包含本轮原提问的
   * `agent/inbox/spliced` 上——新会话的 inbox 投影会把原提问重新排成待处理输入。
   *
   * 这里按 DSH `latestCompletedPrefixBoundary` 的同一套规则计算：
   *   - 有上一轮 `turn/end`：从它开始，向后吞掉独立的非输入事件，遇到
   *     `turn/start`、用户消息或 `agent/inbox/spliced` 就停；
   *   - 没有上一轮：切到本轮**第一个用户输入插入事件之前**（通常是 setup 事件），
   *     这样 fork 出来的会话既没有原提问，也没有半截轮次。
   * 读不到事件日志时返回 null；调用方会禁用对话回退，而不是退回到危险切点。
   * @param {object} session - Session。
   * @param {number|null} beforeSeq - 只考虑该 seq 之前的事件（通常是本轮 turn/start）。
   * @returns {Promise<number|null>} 可用的 atSeq，或 null。
   */
  async resolveForkSeq(session, beforeSeq) {
    const events = await this.readEvents(session.id).catch(() => null);
    if (!Array.isArray(events) || events.length === 0) return null;
    return forkBoundaryFromEvents(events, beforeSeq);
  }

  /**
   * 校验一条**历史**快照的对话切点是否安全。
   *
   * 0.3.3 及更早的首轮快照把 forkSeq 落在 `agent/inbox/spliced`（含本轮原提问）上；
   * 新采集已经写入 `forkSeqSafe: true` 并修正切点，但已有记录不能直接信任。
   * 这里按事件流重新计算该轮的安全边界：记录切点必须不晚于安全边界，否则禁用对话回退。
   * 读不到事件流时同样禁用（宁可少一个功能，也不重放用户输入）。
   * @param {string} sessionId - 会话 id。
   * @param {object} record - 快照记录。
   * @returns {Promise<{safe: boolean, reason: string}>} 校验结果。
   */
  async checkForkSafety(sessionId, record) {
    const atSeq = Number.isSafeInteger(record?.forkSeq) ? record.forkSeq : null;
    if (atSeq === null) return { safe: false, reason: 'no-at-seq' };
    if (record.forkSeqSafe === true) return { safe: true, reason: 'captured-safe' };
    const key = `${sessionId}\u0000${atSeq}\u0000${String(record.phase)}\u0000${String(record.turn)}\u0000${String(record.seq)}`;
    const cached = this.forkSafety.get(key);
    if (cached !== undefined) return cached;

    const events = await this.readEvents(sessionId).catch(() => null);
    let result;
    if (!Array.isArray(events) || events.length === 0) {
      result = { safe: false, reason: 'no-log' };
    } else {
      const at = events.find((event) => event.seq === atSeq);
      if (at === undefined) {
        result = { safe: false, reason: 'missing-event' };
      } else if (record.phase === 'start' && Number.isSafeInteger(record.turn)) {
        const turnStart = events
          .filter((event) => event.type === 'turn/start'
            && event.data?.turn === record.turn
            && (record.seq === null || record.seq === undefined || event.seq <= record.seq))
          .at(-1);
        const boundary = turnStart === undefined ? null : forkBoundaryFromEvents(events, turnStart.seq);
        result = boundary !== null && atSeq <= boundary
          ? { safe: true, reason: 'before-input' }
          : { safe: false, reason: 'includes-input' };
      } else {
        // baseline / 历史 end：直接按 inbox 投影检查切点前缀是否还有待处理输入。
        const state = { 'next-turn': [], 'next-step': [] };
        let invalid = false;
        for (const event of events) {
          if (event.seq > atSeq) break;
          if (event.type !== 'agent/inbox/spliced') continue;
          const splice = event.data ?? {};
          const target = splice.target;
          if (target !== 'next-turn' && target !== 'next-step') { invalid = true; break; }
          const inbox = state[target];
          const start = splice.start;
          const removed = splice.removedCount ?? 0;
          if (!Number.isSafeInteger(start) || start < 0 || start > inbox.length
            || !Number.isSafeInteger(removed) || removed < 0 || start + removed > inbox.length) {
            invalid = true;
            break;
          }
          state[target] = inbox.toSpliced(start, removed, ...(Array.isArray(splice.inserted) ? splice.inserted : []));
        }
        const pending = state['next-turn'].length + state['next-step'].length;
        const boundaryIsInput = at.type === 'agent/inbox/spliced'
          || (at.type === 'user/message' && (at.surfaceOp === 'append' || at.data?.source?.kind === 'user'));
        result = !invalid && pending === 0 && !boundaryIsInput
          ? { safe: true, reason: 'no-pending-input' }
          : { safe: false, reason: invalid ? 'invalid-inbox' : 'pending-input' };
      }
    }

    if (this.forkSafety.size >= 200) this.forkSafety.clear();
    this.forkSafety.set(key, result);
    return result;
  }

  /**
   * 采集一次快照：扫描工作区 -> 落对象 -> 写快照记录 -> 更新索引 -> 修剪。
   * @param {object} session - Session（需要 header.cwd）。
   * @param {'start'|'end'|'manual'} phase - 阶段。
   * @param {{seq?: number|null, forkSeq?: number|null, turn?: number|null, queuedAt?: number, cwd?: string, label?: string, skipTrim?: boolean, rollbackOf?: string|null}} info - 位置与采集选项。
   * @returns {Promise<object>} 采集结果。
   */
  async capture(session, phase, info = {}) {
    // 阶段会进入记录 id → 文件名；来自 HTTP 的任意字符串必须先收敛到白名单。
    phase = normalizePhase(phase);
    const cwd = typeof info.cwd === 'string' && info.cwd.length > 0
      ? normalizeWorkspacePath(info.cwd)
      : this.effectiveCwdForSession(session);
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('该会话没有工作目录，跳过采集');
    const origin = session?.header?.origin;
    const depth = session?.header?.delegationDepth ?? 0;
    if (origin === 'subagent' || depth > 0) throw new Error('子代理会话不采集');

    const meta = this.metaFor(session);
    // 真实 Session 的 /cd 结果要落缓存，后续手动采集/预览才能拿到新目录。
    meta.cwd = normalizeWorkspacePath(cwd);
    const startedAt = Date.now();
    const queuedAt = Number.isSafeInteger(info.queuedAt) ? info.queuedAt : startedAt;
    const workspaceKey = workspaceKeyOf(cwd);
    const snapshots = await this.store.listSnapshots(session.id);
    const last = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;

    // 上一条快照的完整路径表：增量差异必须相对它，而不是相对全局工作区索引。
    // 链断了（历史 trim/删除造成）时不能拿残缺树当基线，改为写一条新的 full 基座。
    let previousTree = null;
    let chainRepaired = false;
    if (last !== undefined) {
      const infoTree = this.store.resolveTreeInfo(snapshots, last.id);
      if (infoTree.complete) previousTree = infoTree.tree;
      else {
        chainRepaired = true;
        this.logger.warn(
          `会话 ${session.id} 的快照链不完整（${String(infoTree.reason)}），将为下一条快照重建 full 基座`,
        );
      }
    }

    // 首轮或插件重载后没有 lastTurnEndSeq：从事件流计算安全切点，避免把本轮原提问
    // 包进 fork 前缀（DSH 的 inbox 投影会把 `agent/inbox/spliced` 重建成待处理输入）。
    let forkSeq = Number.isSafeInteger(info.forkSeq) ? info.forkSeq : null;
    let forkSeqSafe = forkSeq !== null;
    if (phase === 'start' && forkSeq === null) {
      forkSeq = await this.resolveForkSeq(session, Number.isSafeInteger(info.seq) ? info.seq : null);
      forkSeqSafe = forkSeq !== null;
      if (forkSeq === null) {
        this.logger.warn(`会话 ${session.id} 的对话切点无法从事件流确认，已禁用该快照的对话回退`);
      }
    } else if (phase === 'manual' && forkSeq === null) {
      // 手动快照也记录“点击时最后一次完成轮次”的切点；否则对话回退只能按当前末尾 fork，
      // 等于复制整段对话，语义上没有意义。
      forkSeq = await this.resolveForkSeq(session, null);
      forkSeqSafe = forkSeq !== null;
    }

    // 同一轮次边界只采一次：热重载会短暂存在多代实例，各自持有队列，
    // 若不按磁盘上的最后一条记录去重，会出现同一 turn/end 被并发采集成十几条。
    const turn = info.turn ?? meta.turn ?? null;
    if (last !== undefined && (phase === 'start' || phase === 'end') && last.phase === phase) {
      const sameTurn = turn !== null && last.turn === turn;
      const sameSeq = info.seq !== null && info.seq !== undefined && last.seq === info.seq;
      if ((sameTurn || sameSeq) && Date.now() - (last.at ?? 0) < 10 * 60 * 1000) {
        // 同一边界重复上报：不新增记录，但如果这次带来了更精确的位置信息，就回填旧记录。
        //
        // 为什么必须回填：`agent/turn-stopping` 先落一条 end（那时还拿不到 `turn/end` 的 seq），
        // 随后 `turn/end` 才带来真实 seq。若直接丢弃后者，结果快照的对话锚点会退化成
        // "本轮之前"——与起点快照完全重复，而且语义是错的（选它回退对话会把这一轮丢掉）。
        const betterSeq = (last.seq === null || last.seq === undefined) && typeof info.seq === 'number';
        // end 的 forkSeq 语义就是"本轮结束"（= 自己的 seq）。turn-stopping 先落的那条
        // 用的是上一轮的结束边界，是缺陷值；一旦拿到权威 seq 就必须覆盖掉它。
        const betterFork = typeof info.forkSeq === 'number'
          && (last.forkSeq === null || last.forkSeq === undefined || (phase === 'end' && betterSeq));
        if (betterSeq || betterFork) {
          const refined = {
            ...last,
            seq: betterSeq ? info.seq : last.seq,
            forkSeq: betterFork ? info.forkSeq : last.forkSeq,
            ...(betterFork ? { forkSeqSafe: true } : {}),
          };
          await this.store.putSnapshot(refined);
          this.logger.info(`回填快照位置（${last.id}：seq ${String(last.seq)}→${String(refined.seq)}，forkSeq ${String(last.forkSeq)}→${String(refined.forkSeq)}）`);
          return { refined: true, id: last.id, seq: refined.seq, forkSeq: refined.forkSeq };
        }
        this.logger.info(`跳过重复采集（${phase} turn=${String(turn)} seq=${String(info.seq)}，已有 ${last.id}）`);
        return { skipped: true, reason: 'duplicate', lastId: last.id };
      }
    }

    const previousIndex = await this.store.readIndex(workspaceKey);
    const {
      index,
      stats,
      unknown: scannedUnknown = {},
      unreadableDirs: scannedUnknownDirs = [],
      ignoredDirs: scannedIgnoredDirs = [],
      dirs: scannedDirs = [],
    } = await scanWorkspace({
      cwd,
      config: this.config,
      previousIndex,
      expectedHashes: previousTree,
      // 只有采集路径允许自动维护清单；预览/诊断永远只读。
      allowAutoIgnore: this.config.autoIgnore === 'overflow',
    });
    if ((stats.autoIgnored ?? 0) > 0) {
      this.logger.warn(
        `自动忽略 ${stats.autoIgnored} 个目录并重扫（${String(stats.autoIgnoreFile ?? '')}）：`
        + `${(stats.autoIgnoredPaths ?? []).join('、')}`,
      );
    }
    if (stats.bytes > this.config.maxSessionBytes) {
      throw new Error(
        `本次快照内容约 ${stats.bytes} 字节，超过 maxSessionBytes=${this.config.maxSessionBytes}；`
        + '请调整 excludes 或提高该上限',
      );
    }

    /**
     * 多久写一次全量（full）记录。
     *
     * 不能再用 `snapshots.length % checkpointEvery`：一旦会话达到保留上限，
     * `trim` 会把长度稳定压在上限值（默认 200，且 200 % 20 === 0），于是之后
     * **每一轮都变成 full 记录**——记录体积、扫描与 GC 成本都翻一个量级。
     * 这里改为「距上一个 full 之后又累积了多少条非 full 记录」，与数组长度解耦，
     * 修剪把新的最老记录提升成基座后计数自然归零，节奏不会退化。
     */
    let sinceFull = 0;
    for (let i = snapshots.length - 1; i >= 0; i -= 1) {
      if (snapshots[i].full === true) break;
      sinceFull += 1;
    }
    const full = last === undefined
      || previousTree === null
      || sinceFull >= Math.max(0, this.config.checkpointEvery - 1);
    /**
     * 本次快照中「存在但内容未知」的路径。
     *
     * 这些路径既不能写成 null（那表示“当时不存在”，回滚会删文件），也不能静默丢弃
     * （下一条快照/下一次回滚就再也看不到它们）。存进 unknown，由 resolveTree 在
     * 目标快照时把它们从路径表移除，回滚时跳过并提示。
     */
    const effectiveUnknown = { ...scannedUnknown };
    const unknownReasonByKey = new Map(
      Object.entries(scannedUnknown).map(([rel, why]) => [pathKeyOf(rel), why]),
    );
    const unknownKeys = new Set(Object.keys(scannedUnknown).map(pathKeyOf));
    const unknownDirKeys = new Set([...scannedUnknownDirs, ...scannedIgnoredDirs].map(pathKeyOf));

    // 统一规范化成 path -> hash|null（null 表示该时点文件不存在）。
    // 在大小写不敏感的文件系统上，路径身份按 pathKeyOf 折叠：`Foo.txt` 与 `foo.txt`
    // 必须被当成同一个文件，否则一次仅大小写重命名会让回滚同时生成恢复和删除两条记录。
    let effectiveChanges;
    if (full) {
      effectiveChanges = Object.fromEntries(Object.entries(index.entries).map(([rel, entry]) => [rel, entry.hash]));
    } else {
      effectiveChanges = {};
      const previousByKey = new Map();
      for (const rel of Object.keys(previousTree)) {
        const key = pathKeyOf(rel);
        if (!previousByKey.has(key)) previousByKey.set(key, rel);
      }
      const matchedPrevious = new Set();
      for (const [rel, entry] of Object.entries(index.entries)) {
        const previousRel = previousByKey.get(pathKeyOf(rel));
        if (previousRel === undefined) {
          effectiveChanges[rel] = entry.hash;
          continue;
        }
        matchedPrevious.add(previousRel);
        if (previousTree[previousRel] !== entry.hash) effectiveChanges[previousRel] = entry.hash;
      }
      for (const rel of Object.keys(previousTree)) {
        if (matchedPrevious.has(rel)) continue;
        if (unknownKeys.has(pathKeyOf(rel)) || matchesUnderKey(pathKeyOf(rel), unknownDirKeys)) {
          // 仍然存在但这次读不到：保留为 unknown，绝不写成 null。
          effectiveUnknown[rel] = unknownReasonByKey.get(pathKeyOf(rel)) ?? 'unreadable';
          continue;
        }
        if (previousTree[rel] !== null) effectiveChanges[rel] = null;
      }
    }

    // 落对象：本次快照引用到的当前内容必须真的存在于对象库。
    // 顺便用“读到的字节”重新算哈希：扫描与读盘之间文件变了时，以实际内容为准，
    // 避免把新字节存到旧哈希名下（旧实现会静默产生不可校验的对象）。
    const currentRelByKey = new Map();
    for (const rel of Object.keys(index.entries)) currentRelByKey.set(pathKeyOf(rel), rel);
    let objectsWritten = 0;
    const referenced = full
      ? Object.keys(index.entries).map((rel) => [rel, index.entries[rel].hash])
      : Object.entries(effectiveChanges).filter(([, hash]) => typeof hash === 'string');
    for (const [rel, hash] of referenced) {
      const objectPath = join(this.config.root, 'objects', hash.slice(0, 2), hash);
      const before = await stat(objectPath).catch(() => undefined);
      if (before !== undefined && before.isFile()) continue;
      // 增量变更的 key 可能沿用上一条快照的写法（大小写不同），读盘时要用当前实际路径。
      const currentRel = currentRelByKey.get(pathKeyOf(rel)) ?? rel;
      let bytes;
      try {
        bytes = await readFileWithRetry(join(cwd, currentRel));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // 扫描之后被删了：按“此刻不存在”记录，避免快照引用一个不存在的对象。
          delete index.entries[currentRel];
          if (full) delete effectiveChanges[rel];
          else effectiveChanges[rel] = null;
          delete effectiveUnknown[rel];
          continue;
        }
        throw new Error(`采集失败：无法读取 ${currentRel}（${String(error?.message ?? error)}）`);
      }
      const actual = hashBytes(bytes);
      if (full) {
        effectiveChanges[rel] = actual;
      } else if (previousTree[rel] === actual) {
        // 读盘时已经回到上一条快照的内容，这条差异可以撤销。
        delete effectiveChanges[rel];
      } else {
        effectiveChanges[rel] = actual;
      }
      index.entries[currentRel] = { ...(index.entries[currentRel] ?? {}), hash: actual, size: bytes.length };
      await this.store.putObject(actual, bytes);
      objectsWritten += 1;
    }

    // 捕获窗口风险：采集触发之后仍有 mtime 更新的文件，说明本轮改动可能已经混进
    // “本轮之前”的快照。只做提示，不假装能消除这个窗口。
    const windowRisk = [];
    for (const [rel, entry] of Object.entries(index.entries)) {
      if (entry.mtimeMs >= queuedAt && windowRisk.length < 50) windowRisk.push(rel);
    }
    const effectiveStats = {
      ...stats,
      changed: Object.keys(effectiveChanges).length,
      unknown: Object.keys(effectiveUnknown).length,
      unknownDirs: scannedUnknownDirs.length,
      windowRisk: windowRisk.length,
    };
    // 展示用差异数：full 记录虽然携带整棵树，但不应该把“总文件数”显示成“改动数”。
    let displayChanged = Object.keys(effectiveChanges).length;
    if (full && previousTree !== null) {
      displayChanged = 0;
      for (const [rel, entry] of Object.entries(index.entries)) {
        if (previousTree[rel] !== entry.hash) displayChanged += 1;
      }
      for (const [rel, hash] of Object.entries(previousTree)) {
        if (hash !== null && index.entries[rel] === undefined) displayChanged += 1;
      }
    }

    const id = `${String(snapshots.length).padStart(5, '0')}-${phase}-${Date.now().toString(36)}`;
    // 只记录“没有文件”的目录（含空目录和只含空子目录的树），而不是整个目录树：
    // 其余目录可由目标文件路径反推，避免每条快照都携带一份完整目录清单。
    const dirsWithFiles = new Set();
    for (const rel of Object.keys(index.entries)) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i += 1) dirsWithFiles.add(parts.slice(0, i).join('/'));
    }
    const emptyDirs = scannedDirs.filter((rel) => !dirsWithFiles.has(rel));
    const record = {
      // v2 起增加 unknown / unknownDirs：旧记录（v1）没有这份信息，历史快照无法补记
      // “当时存在但未采集”的路径，回滚旧 v1 快照时仍可能按旧语义处理。
      v: 2,
      generation: this.generation,
      id,
      sessionId: session.id,
      phase,
      turn: info.turn ?? meta.turn ?? null,
      seq: info.seq ?? null,
      forkSeq,
      ...(forkSeqSafe ? { forkSeqSafe: true } : {}),
      at: Date.now(),
      cwd,
      label: typeof info.label === 'string' && info.label.length > 0 ? info.label : (meta.label ?? null),
      parent: previousTree === null ? null : (last?.id ?? null),
      full,
      changes: effectiveChanges,
      changeCount: displayChanged,
      // 目录清单（只含没有文件的目录）：回滚时用于区分“快照时点已存在”和“之后新建”的空目录。
      // 老记录没有该字段，只能按文件路径反推，空目录语义仍是旧限制。
      ...(emptyDirs.length > 0 ? { emptyDirs } : {}),
      ...(Object.keys(effectiveUnknown).length > 0 ? { unknown: effectiveUnknown } : {}),
      ...(scannedUnknownDirs.length > 0 ? { unknownDirs: scannedUnknownDirs } : {}),
      // 这次被 git 忽略整棵跳过的目录：回滚到该快照时视为“未采集”，
      // 不会因为之后取消忽略/关掉开关，就把里面的文件当成 created-after 删掉。
      ...(scannedIgnoredDirs.length > 0 ? { ignoredDirs: scannedIgnoredDirs } : {}),
      stats: effectiveStats,
      window: {
        queuedAt,
        scanStartedAt: startedAt,
        finishedAt: Date.now(),
        risk: windowRisk,
      },
      ...(chainRepaired ? { chainRepaired: true } : {}),
      ...(typeof info.rollbackOf === 'string' && info.rollbackOf.length > 0 ? { rollbackOf: info.rollbackOf } : {}),
    };
    await this.store.putSnapshot(record);
    try {
      await this.rememberSession(session.id);
    } catch (error) {
      this.logger.warn(`记录会话目录清单失败：${String(error?.message ?? error)}`);
    }
    await this.store.writeIndex(workspaceKey, index);
    const trimmed = info.skipTrim === true ? 0 : await this.trim(session.id).catch((error) => {
      this.logger.warn(`修剪快照失败：${String(error?.message ?? error)}`);
      return 0;
    });

    meta.snapshots = snapshots.length + 1;
    if (this.lastError !== null && this.lastError.sessionId === session.id) this.lastError = null;
    this.lastCapture = {
      at: new Date().toISOString(),
      sessionId: session.id,
      snapshotId: id,
      phase,
      totalMs: Date.now() - startedAt,
      stats: effectiveStats,
      objectsWritten,
      full,
      trimmed,
      windowRisk: windowRisk.length,
    };
    this.logger.info(
      `快照 ${id}（${phase}）：${effectiveStats.changed} 个变化 / 共 ${effectiveStats.total} 个文件，`
      + `哈希 ${effectiveStats.hashed}、复用 ${effectiveStats.reused}、耗时 ${effectiveStats.elapsedMs}ms`
      + (windowRisk.length > 0 ? `、窗口风险 ${windowRisk.length}` : ''),
    );
    return { record: { ...record, changes: undefined, changeCount: record.changeCount }, trimmed };
  }

  /**
   * 按保留策略修剪某会话的快照（只删记录，blob 由 gc 回收）。
   *
   * 关键：删除最老记录之前，必须保证新的最老记录能独立成树。若它不是 full，
   * 先用它还完整的链解析出完整 tree，把它提升为新的 full 基座（parent=null），
   * 再删除更老的记录。否则 children 的 parent 会悬空，resolveTree 只能拿到
   * 最后一段 diff，回滚会把其余文件误判为“快照之后新建”而删除。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<number>} 删除数量。
   */
  async trim(sessionId) {
    const snapshots = await this.store.listSnapshots(sessionId);
    const excess = snapshots.length - this.config.maxSnapshotsPerSession;
    if (excess <= 0) return 0;
    const oldestKept = snapshots[excess];
    if (oldestKept === undefined) return 0;
    if (oldestKept.full !== true) {
      const info = this.store.resolveTreeInfo(snapshots, oldestKept.id);
      if (!info.complete) {
        // 链本身已经不完整：宁可超出上限，也不能继续删掉可能还有用的记录。
        this.logger.warn(`跳过修剪：会话 ${sessionId} 的快照链不完整（${String(info.reason)}）`);
        return 0;
      }
      await this.store.putSnapshot({
        ...oldestKept,
        parent: null,
        full: true,
        changes: info.tree,
        // 提升成 full 基座时必须把**合并后**的 unknown 一起写回：否则早先记录里
        // “存在但读不到/超限/链接”的路径，会在新基座里变成“根本不存在”，
        // 之后回滚就会把后来变得可读的同一路径当成 created-after 删掉。
        ...(Object.keys(info.unknown ?? {}).length > 0 ? { unknown: info.unknown } : { unknown: undefined }),
        ...(Array.isArray(info.unknownDirs) && info.unknownDirs.length > 0
          ? { unknownDirs: info.unknownDirs }
          : { unknownDirs: undefined }),
        promotedAt: Date.now(),
      });
    }
    for (const record of snapshots.slice(0, excess)) await this.store.deleteSnapshot(sessionId, record.id);
    return excess;
  }

  /**
   * 删除一条快照记录。
   *
   * 只允许删“叶子”：如果还有记录的 parent 指向它，删掉会让这些子记录失去
   * 增量基线，resolveTree 会退化成残缺树。要么先删更新的记录，要么用修剪
   * （修剪会先把新的最老记录提升成 full 基座）。
   * @param {string} sessionId - 会话 id。
   * @param {string} id - 快照 id。
   * @returns {Promise<{deleted: string, sessionId: string}>} 删除结果。
   */
  async deleteSnapshot(sessionId, id) {
    return this.withStore(async () => {
      const snapshots = await this.store.listSnapshots(sessionId);
      const target = snapshots.find((item) => item.id === id);
      if (target === undefined) throw new Error(`找不到快照 ${id}`);
      const children = snapshots.filter((item) => item.parent === id);
      if (children.length > 0) {
        throw new Error(
          `快照 ${id} 是 ${children.length} 条后续快照的基线，删除会破坏回滚链；`
          + '请先删除更新的快照，或使用“清理快照垃圾”/修剪功能',
        );
      }
      await this.store.deleteSnapshot(sessionId, id);
      return { deleted: id, sessionId };
    });
  }

  /**
   * 生成「回到该快照」的完整计划（内部用，不签发令牌）。
   *
   * 判定依据：严格校验过的快照链路径表 vs 当前工作区扫描结果。
   * 只处理快照自己跟踪过的路径，绝不触碰从未纳入快照的文件。
   * 同时算出回滚时会被一并收掉的「空目录」、采集窗口风险与未跟踪项。
   * @param {string} sessionId - 会话 id。
   * @param {string} [snapshotId] - 目标快照（省略取最后一个）。
   * @returns {Promise<object>} 完整计划。
   */
  async buildPlan(sessionId, snapshotId) {
    // 回滚预览里的 label 会被客户端当作「编辑并重来」的预填文本，先自愈一次。
    await this.repairStartLabels(sessionId).catch((error) => {
      this.logger.warn(`起点快照说明自愈失败：${String(error?.message ?? error)}`);
    });
    const snapshots = await this.store.listSnapshots(sessionId);
    if (snapshots.length === 0) throw new Error('该会话还没有快照');
    const target = typeof snapshotId === 'string' && snapshotId.length > 0
      ? snapshotId
      : snapshots[snapshots.length - 1].id;
    const record = snapshots.find((item) => item.id === target);
    if (record === undefined) throw new Error(`找不到快照 ${target}`);
    const recorded = record.cwd;
    // 老快照可能没记 cwd；此时按会话解析（缓存或 sessionController.inspect），而不是直接失败。
    const cwd = typeof recorded === 'string' && recorded.length > 0 ? recorded : await this.resolveSessionCwd(sessionId);

    const treeInfo = this.store.resolveTreeInfo(snapshots, target);
    if (!treeInfo.complete) {
      throw new Error(
        `快照链不完整（${String(treeInfo.reason)}），已拒绝回滚。`
        + '请先清理该会话的旧快照，或换一个更近的快照；不要用残缺链执行回滚。',
      );
    }
    const tree = treeInfo.tree;
    const targetUnknown = treeInfo.unknown ?? {};
    const targetUnknownDirs = Array.isArray(treeInfo.unknownDirs) ? treeInfo.unknownDirs : [];
    /**
     * v1 快照没有 unknown 字段，无法区分“当时不存在”和“当时因超限/占用/链接未采集”。
     * 只要该快照的统计里出现过这些跳过项，就按保守策略处理：不删除目标为 null 的路径，
     * 也不把当前多出来的路径当成 created-after；宁可留下文件并提示，也不静默误删。
     */
    const legacyUnknownRisk = record.v !== 2 && (
      (Number(record.stats?.symlinks) || 0)
      + (Number(record.stats?.oversized) || 0)
      + (Number(record.stats?.unreadable) || 0)
    ) > 0;
    const workspaceKey = workspaceKeyOf(cwd);
    const previousIndex = await this.store.readIndex(workspaceKey);
    // 期望哈希用目标树：全局索引与本快照不一致时强制重新哈希，避免别的会话
    // 推进索引后把当前内容误当成“目标状态”。
    const {
      index,
      stats,
      unknown: currentUnknown = {},
      unreadableDirs: currentUnknownDirs = [],
      dirs: currentDirs = [],
    } = await scanWorkspace({
      cwd,
      config: this.config,
      previousIndex,
      expectedHashes: tree,
    });
    const current = index.entries;

    /**
     * 目标路径表与当前索引都按 `pathKeyOf` 折叠后建立 map。
     *
     * 关键：同一张 map 里一个文件只能出现一次，所以 `Foo.txt` 与 `foo.txt` 不会被拆成
     * “恢复旧名字 + 删除新名字”两条互相抵消的操作；类型冲突也按同一个身份判断。
     */
    const targetByKey = new Map();
    for (const [rel, hash] of Object.entries(tree)) {
      const key = pathKeyOf(rel);
      const prior = targetByKey.get(key);
      if (prior === undefined || (prior.hash === null && hash !== null)) targetByKey.set(key, { rel, hash });
    }
    const currentByKey = new Map();
    for (const [rel, entry] of Object.entries(current)) {
      currentByKey.set(pathKeyOf(rel), { rel, hash: entry.hash, size: entry.size ?? null });
    }
    const targetUnknownKeys = new Set(Object.keys(targetUnknown).map(pathKeyOf));
    for (const dir of targetUnknownDirs) targetUnknownKeys.add(pathKeyOf(dir));
    const currentUnknownByKey = new Map(Object.entries(currentUnknown).map(([rel, why]) => [pathKeyOf(rel), why]));
    const currentUnknownDirKeys = new Set(currentUnknownDirs.map(pathKeyOf));
    const currentDirKeys = new Set(currentDirs.map(pathKeyOf));

    const restore = [];
    const remove = [];
    const unknownItems = [];
    const unknownSeen = new Set();
    let unchanged = 0;
    const addUnknown = (rel, reason) => {
      const key = pathKeyOf(rel);
      if (unknownSeen.has(key)) return;
      unknownSeen.add(key);
      unknownItems.push({ rel, reason });
    };
    /** 当前扫描里该路径（或其祖先）为什么不可信；没有则 null。逐段向上查，避免 O(n×m)。 */
    const currentUnknownReason = (key) => {
      let current = key;
      for (;;) {
        if (currentUnknownByKey.has(current)) return currentUnknownByKey.get(current);
        const slash = current.lastIndexOf('/');
        if (slash < 0) break;
        current = current.slice(0, slash);
      }
      current = key;
      for (;;) {
        if (currentUnknownDirKeys.has(current)) return 'unreadable-dir';
        const slash = current.lastIndexOf('/');
        if (slash < 0) break;
        current = current.slice(0, slash);
      }
      return null;
    };

    for (const [key, target] of targetByKey) {
      if (matchesUnderKey(key, targetUnknownKeys)) {
        // 目标时点这个路径存在但内容未知（读不到/超限/链接/目录不可读）：不动它。
        addUnknown(target.rel, 'target-unknown');
        continue;
      }
      const cur = currentByKey.get(key);
      if (target.hash === null) {
        if (cur === undefined) {
          unchanged += 1;
          continue;
        }
        if (legacyUnknownRisk) {
          addUnknown(cur.rel, 'legacy-unknown');
          continue;
        }
        const why = currentUnknownReason(key);
        if (why !== null) {
          addUnknown(cur.rel, why);
          continue;
        }
        remove.push({ rel: cur.rel, action: 'snapshot-absent', size: cur.size });
        continue;
      }
      if (cur !== undefined) {
        if (cur.hash === target.hash) {
          unchanged += 1;
          continue;
        }
        const why = currentUnknownReason(key);
        // 当前路径（或祖先）是符号链接/junction：扫描器无法确认其下内容，
        // 恢复写入可能穿透到计划外的文件；与其它 unknown 一样只提示、不执行。
        if (why !== null) {
          addUnknown(target.rel, why);
          continue;
        }
        restore.push({ rel: target.rel, action: 'overwrite', size: cur.size, hash: target.hash });
        continue;
      }
      const why = currentUnknownReason(key);
      if (why !== null) {
        addUnknown(target.rel, why);
        continue;
      }
      restore.push({ rel: target.rel, action: 'recreate', size: null, hash: target.hash });
    }

    // 当前索引里有、但目标快照没有跟踪过的路径 = 快照之后新建的文件。
    // 只有“目标时点明确不存在”才能删；目标时点未知的路径必须保留。
    for (const [key, cur] of currentByKey) {
      if (targetByKey.has(key)) continue;
      if (matchesUnderKey(key, targetUnknownKeys)) {
        addUnknown(cur.rel, 'target-unknown');
        continue;
      }
      if (legacyUnknownRisk) {
        addUnknown(cur.rel, 'legacy-unknown');
        continue;
      }
      const why = currentUnknownReason(key);
      if (why !== null) {
        addUnknown(cur.rel, why);
        continue;
      }
      remove.push({ rel: cur.rel, action: 'created-after', size: cur.size });
    }

    /**
     * 回滚前预检：计划里要写的对象是否真的存在于对象库。
     *
     * 预览/执行都不应该等到写了几个文件之后才发现某个对象在历史 GC/损坏中丢了；
     * 先查一遍，缺失就拒绝执行（预览会给出警告），避免“先删掉新建文件、再失败”的半完成状态。
     */
    const restoreHashes = [...new Set(restore.map((item) => item.hash).filter((hash) => typeof hash === 'string'))];
    const missingObjects = [];
    for (const hash of restoreHashes) {
      if (!(await this.store.hasObject(hash))) missingObjects.push(hash);
    }

    // 该快照时点确实存在的目录：文件路径推导出的目录 + 记录里的“无文件目录”。
    // 新记录带 `emptyDirs`（只存没有文件的目录，避免每条记录携带整棵目录树）；
    // 老记录没有该字段，空目录语义仍是旧限制。
    const recordedDirs = Array.isArray(record.emptyDirs) ? record.emptyDirs : null;
    const trackedDirs = new Set();
    for (const target of targetByKey.values()) {
      if (typeof target.hash !== 'string') continue;
      const parts = target.rel.split('/');
      for (let i = 1; i < parts.length; i += 1) trackedDirs.add(parts.slice(0, i).join('/'));
    }
    if (recordedDirs !== null) {
      for (const rel of recordedDirs) {
        if (typeof rel === 'string' && rel.length > 0) trackedDirs.add(rel);
      }
    }
    const trackedDirKeys = new Set([...trackedDirs].map(pathKeyOf));
    // 目标时点已经存在、当前却不存在的**无文件目录**：恢复时显式 mkdir。
    // 有文件的目录会由文件恢复隐式创建。
    const restoreDirs = recordedDirs === null
      ? []
      : [...recordedDirs].filter((rel) => !currentDirKeys.has(pathKeyOf(rel))
        && currentUnknownReason(pathKeyOf(rel)) === null);
    const dirContext = { current, trackedDirs };

    /**
     * 计算待清理目录，并补上「目标要文件、当前却是目录」的显式清理项。
     *
     * 后者不会被 pruneDirsFor 自动发现：空目录没有可从 remove 清单推导出的文件，
     * 但恢复文件前必须先把同名空目录 rmdir 掉，否则 rename 会失败。
     */
    const buildPruneDirs = (removeList, restoreList, includeAllNewDirs = false) => {
      const out = pruneDirsFor(dirContext, removeList);
      const seen = new Set(out.map(pathKeyOf));
      const removedKeys = new Set(removeList.map((item) => pathKeyOf(item.rel)));
      const dirRelByKey = new Map(currentDirs.map((rel) => [pathKeyOf(rel), rel]));
      for (const item of restoreList) {
        const key = pathKeyOf(item.rel);
        if (!currentDirKeys.has(key) || currentByKey.has(key)) continue;
        // 目标要文件、当前是同名目录：目录可能只含嵌套空目录。只清最外层不够，
        // rmdir 会因深层目录非空失败；把该子树中不残留文件的目录都按深到浅加入。
        for (const [dirKey, dirRel] of dirRelByKey) {
          if (dirKey !== key && !isUnderDir(dirKey, key)) continue;
          if (seen.has(dirKey)) continue;
          const prefix = `${dirKey}/`;
          const survivors = [...currentByKey.keys()].filter((other) => other.startsWith(prefix) && !removedKeys.has(other));
          // 目录里还有本次不删除/未知的内容时不清理，恢复会失败并在报告里显示；不要递归删目录。
          if (survivors.length > 0) continue;
          out.push(dirRel);
          seen.add(dirKey);
        }
      }
      // 新记录带有完整目录清单：快照之后新建、且清完文件后仍为空的目录也一并收掉。
      // 老记录没有 `dirs` 时无法区分“快照时已存在的空目录”，保持旧行为（不自动清）。
      if (recordedDirs !== null && includeAllNewDirs) {
        for (const [dirKey, dirRel] of dirRelByKey) {
          if (dirKey.length === 0 || trackedDirKeys.has(dirKey) || seen.has(dirKey)) continue;
          const prefix = `${dirKey}/`;
          const survivors = [...currentByKey.keys()].filter((other) => other.startsWith(prefix) && !removedKeys.has(other));
          if (survivors.length > 0) continue;
          out.push(dirRel);
          seen.add(dirKey);
        }
      }
      out.sort((a, b) => b.split('/').length - a.split('/').length);
      return out;
    };

    // 「本会话修改过的文件」范围：只保留本会话自己写过的路径（write/edit 记录）。
    // 这是可选的收窄范围，默认不启用 —— 它抓不到经 shell/构建/子代理产生的改动，
    // 因此绝不能替代全量，只用于「只想撤掉这次对话干的事」。
    // 必须先水合：日志是异步读的，否则插件重载后这里会读到空集合。
    const touched = await this.loadJournal({ id: sessionId, header: { cwd } });
    const sessionFiles = new Set(touched.map(pathKeyOf));
    const sessionRestore = restore.filter((item) => sessionFiles.has(pathKeyOf(item.rel)));
    const sessionRemove = remove.filter((item) => sessionFiles.has(pathKeyOf(item.rel)));
    // 两种范围各自要收掉的空目录（同一个算法、同一份扫描结果，只是清单不同）。
    const pruneDirs = buildPruneDirs(remove, restore, true);
    const sessionPruneDirs = buildPruneDirs(sessionRemove, sessionRestore, false);

    const controller = typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined;
    const forkAvailable = controller !== undefined && controller !== null && typeof controller.fork === 'function';
    // 新记录带 forkSeqSafe；历史记录必须按事件流重新校验，避免把 0.3.3 之前
    // 落在 agent/inbox/spliced 上的切点当成安全切点（会把原提问重放进新会话）。
    const forkSafety = forkAvailable && Number.isSafeInteger(record.forkSeq)
      ? await this.checkForkSafety(sessionId, record)
      : { safe: false, reason: 'no-at-seq' };
    const conversationAvailable = forkAvailable && forkSafety.safe === true;
    const runningInfo = await this.detectRunning(sessionId);
    // 同一 cwd 的其他会话若正在运行，回滚会与它的写入互相覆盖（只查本会话不够）。
    const busyElsewhere = await this.detectWorkspaceBusy(cwd, sessionId);
    const sessionCwd = this.meta.get(sessionId)?.cwd;
    const warnings = [];
    if (runningInfo.state === true) warnings.push(this.runningError(runningInfo));
    if (forkAvailable && Number.isSafeInteger(record.forkSeq) && !conversationAvailable) {
      warnings.push('该快照没有可验证的对话切点（旧版首轮快照可能包含待处理输入），已禁用对话回退；文件回滚不受影响');
    }
    if (busyElsewhere.length > 0) {
      const ids = busyElsewhere.slice(0, 3).map((item) => item.sessionId).join('、');
      warnings.push(
        `同一工作区还有 ${busyElsewhere.length} 个会话正在运行（${ids}${busyElsewhere.length > 3 ? '…' : ''}）；`
        + '执行回滚会被拒绝，请先等它们结束（turn/end）',
      );
    }
    if (typeof sessionCwd === 'string' && sessionCwd.length > 0
      && normalizeWorkspacePath(sessionCwd) !== normalizeWorkspacePath(cwd)) {
      warnings.push('目标快照的工作区与会话当前工作区不同；文件和对话可能落在不同目录');
    }
    if (Array.isArray(record.window?.risk) && record.window.risk.length > 0) {
      warnings.push(`该快照采集窗口内有 ${record.window.risk.length} 个文件被修改，回滚可能无法撤销这些改动（见 window.risk）`);
    }
    const untracked = {
      symlinks: stats.symlinks ?? 0,
      excluded: stats.excluded ?? 0,
      oversized: stats.oversized ?? 0,
      unreadable: stats.unreadable ?? 0,
      unknown: unknownItems.length,
      vcsDirs: Array.isArray(stats.vcsDirs) ? stats.vcsDirs : [],
      samples: stats.samples ?? {},
    };
    const untrackedTotal = untracked.symlinks + untracked.excluded + untracked.oversized + untracked.unreadable;
    if (untrackedTotal > 0) {
      warnings.push(`另有 ${untrackedTotal} 个路径未纳入快照（排除/符号链接/超大/不可读）；回滚不会处理它们，可能留下未回滚内容`);
    }
    if (legacyUnknownRisk) {
      warnings.push(
        '该快照由 0.3.1 及更早版本采集，没有记录“当时存在但未采集”的路径；'
        + '本次按保守策略不删除快照后新建的文件，可能留下未回滚内容',
      );
    }
    if (unknownItems.length > 0) {
      warnings.push(
        `有 ${unknownItems.length} 个路径状态未知（被占用/超大/符号链接/不可读），本次回滚不会删除或覆盖它们；`
        + '如果需要完整恢复，请先让这些路径可读后重新预览',
      );
    }
    if (missingObjects.length > 0) {
      warnings.push(
        `快照对象库缺少 ${missingObjects.length} 个内容对象，相关文件无法恢复；`
        + '执行会被拒绝，请先检查快照存储是否完整',
      );
    }
    if (untracked.vcsDirs.length > 0) {
      warnings.push(`检测到 ${untracked.vcsDirs.length} 个 .git 目录未被快照（提交/分支/索引等 VCS 状态不会回滚）`);
    }
    return {
      sessionId,
      snapshotId: target,
      cwd,
      running: runningInfo.state,
      runningSource: runningInfo.source,
      runningSubagents: runningInfo.subagents,
      /** 同一工作区里其他正在运行的会话（执行会被拒绝，预览只提示）。 */
      workspaceBusy: busyElsewhere,
      label: record.label ?? null,
      phase: record.phase,
      turn: record.turn ?? null,
      seq: record.seq ?? null,
      forkSeq: record.forkSeq ?? null,
      at: record.at,
      counts: {
        restore: restore.length,
        remove: remove.length,
        unchanged,
        unknown: unknownItems.length,
        missingObjects: missingObjects.length,
        scanned: stats.total,
        // 回滚时会被一并收掉的目录数（快照时点不存在、删完文件后变空）。
        dirsRemove: pruneDirs.length,
        dirsCreate: restoreDirs.length,
      },
      // 完整清单：执行阶段用这一份，HTTP 响应再用 displayPlan 截断展示。
      restore,
      remove,
      /** 目标时点存在、当前缺失、需要显式重建的目录（含空目录）。 */
      restoreDirs,
      /** 目标时点未知、或当前读不到而跳过的路径；只提示，不执行。 */
      unknown: unknownItems,
      /** 计划要写、但对象库中缺失的内容哈希。 */
      missingObjects,
      scan: stats,
      untracked,
      warnings,
      window: record.window ?? null,
      /**
       * 本次回滚实际要收掉的空目录（执行阶段直接用这份，避免和展示清单重复计算）。
       * 两种范围各算一份：全量 / 只恢复本会话修改的文件。
       */
      pruneDirs,
      /**
       * 「只恢复本会话修改的文件」的差异清单，与上面全量清单来自同一次扫描，可直接切换。
       * trackedFiles 为累计记录数（可能包含已不在差异里的历史路径），用于判断该选项是否可用。
       */
      sessionScope: {
        trackedFiles: sessionFiles.size,
        // unchanged 只数"本会话写过、且此刻仍存在并与该时点一致"的路径。
        // 不能直接用 trackedFiles 减去 restore/remove：被删除的旧路径（例如会话自己清理掉的
        // 临时文件）既不在差异里、也不在"保持不变"里，相减会把它们算成"保持不变"，数字骗人。
        counts: {
          restore: sessionRestore.length,
          remove: sessionRemove.length,
          dirsRemove: sessionPruneDirs.length,
          // 判据：此刻仍存在、且内容哈希与该时点目标一致。被删除的旧路径会被自然排除。
          unchanged: [...sessionFiles].filter((key) => {
            const entry = currentByKey.get(key);
            const target = targetByKey.get(key);
            return entry !== undefined && target !== undefined
              && typeof target.hash === 'string' && entry.hash === target.hash;
          }).length,
        },
        restore: sessionRestore,
        remove: sessionRemove,
        pruneDirs: sessionPruneDirs,
        restoreDirs: [],
        available: sessionRestore.length + sessionRemove.length > 0,
      },
      /** 对话回退计划：回退后新会话将包含到 forkSeq 为止的历史。 */
      conversation: {
        available: conversationAvailable,
        sourceSessionId: sessionId,
        atSeq: conversationAvailable ? record.forkSeq : null,
        note: conversationAvailable
          ? `新会话将保留到事件 #${record.forkSeq} 为止的历史（即本次提问之前），本次提问及其后的对话不再进入新会话（原会话完整保留）`
          : '该快照没有可验证的对话切点；对话回退已禁用，文件回滚不受影响',
      },
    };
  }

  /**
   * 把完整计划裁成 HTTP 展示用的清单。
   * @param {object} plan - buildPlan 的完整结果。
   * @returns {object} 展示副本。
   */
  displayPlan(plan) {
    const limit = PLAN_DISPLAY_LIMIT;
    return {
      ...plan,
      restore: plan.restore.slice(0, limit),
      remove: plan.remove.slice(0, limit),
      unknown: (plan.unknown ?? []).slice(0, limit),
      missingObjects: (plan.missingObjects ?? []).slice(0, limit),
      // 展示不需要完整目录清单；执行阶段用的是 buildPlan 的完整 pruneDirs。
      pruneDirs: plan.pruneDirs.slice(0, 200),
      restoreDirs: (plan.restoreDirs ?? []).slice(0, 200),
      truncated: plan.restore.length > limit || plan.remove.length > limit,
      sessionScope: {
        ...plan.sessionScope,
        restore: plan.sessionScope.restore.slice(0, limit),
        remove: plan.sessionScope.remove.slice(0, limit),
        pruneDirs: plan.sessionScope.pruneDirs.slice(0, 200),
        restoreDirs: [],
        truncated: plan.sessionScope.restore.length > limit || plan.sessionScope.remove.length > limit,
      },
    };
  }

  /**
   * 解析目标快照与工作区（供预览/回滚在加锁前使用）。
   * @param {string} sessionId - 会话 id。
   * @param {string} [snapshotId] - 目标快照（省略取最后一个）。
   * @returns {Promise<{snapshots: Array<object>, target: string, record: object, cwd: string}>} 目标信息。
   */
  async resolvePlanTarget(sessionId, snapshotId) {
    const snapshots = await this.store.listSnapshots(sessionId);
    if (snapshots.length === 0) throw new Error('该会话还没有快照');
    const target = typeof snapshotId === 'string' && snapshotId.length > 0
      ? snapshotId
      : snapshots[snapshots.length - 1].id;
    const record = snapshots.find((item) => item.id === target);
    if (record === undefined) throw new Error(`找不到快照 ${target}`);
    const recorded = record.cwd;
    const cwd = typeof recorded === 'string' && recorded.length > 0
      ? recorded
      : await this.resolveSessionCwd(sessionId);
    return { snapshots, target, record, cwd };
  }

  /**
   * 预览：在目标工作区锁内重新扫描，签发一次性确认令牌。
   * @param {string} sessionId - 会话 id。
   * @param {string} [snapshotId] - 目标快照。
   * @returns {Promise<object>} 展示计划 + planToken。
   */
  async preview(sessionId, snapshotId) {
    const targetInfo = await this.resolvePlanTarget(sessionId, snapshotId);
    return this.withStore(() => this.withWorkspace(targetInfo.cwd, async () => {
      const plan = await this.buildPlan(sessionId, snapshotId);
      const planToken = this.issuePlanToken(plan);
      return { ...this.displayPlan(plan), planToken };
    }));
  }

  /**
   * 执行回滚：可选恢复文件、可选把对话 fork 到该快照的切点、可选把编辑后的文本发进新会话。
   * @param {object} request - 回滚请求。
   * @param {string} request.sessionId - 源会话 id。
   * @param {string} [request.snapshotId] - 目标快照。
   * @param {boolean} [request.files] - 是否恢复文件（默认 true）。
   * @param {boolean} [request.conversation] - 是否 fork 对话（默认 false）。
   * @param {boolean} [request.dryRun] - 只预览不执行。
   * @param {string} [request.promptText] - fork 后自动发送的文本（通常为编辑后的输入）。
   * @param {boolean} [request.recoveryPoint] - 回滚前是否自动生成恢复点（默认 true）。
   * @param {'all'|'session'} [request.scope] - 文件恢复范围：'all' 全量（默认）或 'session' 只恢复本会话修改过的文件。
   * @returns {Promise<object>} 执行报告。
   */
  async restore(request = {}) {
    const sessionId = String(request.sessionId ?? '');
    if (sessionId.length === 0) throw new Error('缺少 sessionId');
    if (typeof request.promptText === 'string' && request.promptText.length > 100000) {
      throw new Error('promptText 过长（最多 100000 个字符）');
    }
    const targetInfo = await this.resolvePlanTarget(sessionId, request.snapshotId);
    return this.withStore(() => this.withWorkspace(targetInfo.cwd, () => this.restoreLocked({ ...request, sessionId }, targetInfo.cwd)));
  }

  /**
   * 回滚执行前的对象预检：验证计划要写的每个对象都存在且内容与哈希一致。
   *
   * 只查存在性不够：从 0.3.2 开始回滚改成“先删后恢复”，一个内容损坏的对象如果只在
   * 写回时才暴露，前面的删除已经发生。这里在动工作区前把对象读一遍、重算哈希。
   * @param {Array<{hash?: string}>} restoreList - 计划恢复清单。
   * @returns {Promise<{missing: string[], corrupt: string[]}>} 缺失/损坏的哈希。
   */
  async verifyRestoreObjects(restoreList) {
    const hashes = [...new Set(
      (Array.isArray(restoreList) ? restoreList : [])
        .map((item) => item?.hash)
        .filter((hash) => typeof hash === 'string' && hash.length > 0),
    )];
    const missing = [];
    const corrupt = [];
    for (const hash of hashes) {
      try {
        const bytes = await this.store.getObject(hash);
        if (hashBytes(bytes) !== hash) corrupt.push(hash);
      } catch (error) {
        if (error?.code === 'ENOENT') missing.push(hash);
        else corrupt.push(hash);
      }
    }
    return { missing, corrupt };
  }

  /**
   * 在已持有工作区锁的情况下执行回滚。
   * @param {object} request - 回滚请求（sessionId 必填）。
   * @param {string} cwd - 工作区根。
   * @returns {Promise<object>} 执行报告。
   */
  async restoreLocked(request, cwd) {
    const sessionId = String(request.sessionId ?? '');
    const plan = await this.buildPlan(sessionId, request.snapshotId);
    const doFiles = request.files !== false;
    let doConversation = request.conversation === true;
    const conversationUnavailable = doConversation && plan.conversation?.available !== true;
    if (conversationUnavailable) {
      if (!doFiles) throw new Error('该快照没有可验证的对话切点，无法只回退对话');
      doConversation = false;
    }
    if (!doFiles && !doConversation) throw new Error('files 与 conversation 不能同时为否');
    // 文件恢复范围：默认全量；只有显式 'session' 才收窄。
    const scope = request.scope === 'session' ? 'session' : 'all';

    if (request.dryRun === true) {
      const planToken = this.issuePlanToken(plan);
      return { dryRun: true, plan: { ...this.displayPlan(plan), planToken } };
    }

    // 对象缺失/损坏时必须在动任何文件之前拒绝：否则先删掉“快照后新建”的文件，
    // 到写回缺失对象时才失败，工作区会停在半完成状态。
    const selectedRestore = scope === 'session' ? plan.sessionScope.restore : plan.restore;
    const objectCheck = await this.verifyRestoreObjects(selectedRestore);
    if (objectCheck.missing.length > 0 || objectCheck.corrupt.length > 0) {
      const parts = [];
      if (objectCheck.missing.length > 0) parts.push(`缺失 ${objectCheck.missing.length} 个`);
      if (objectCheck.corrupt.length > 0) parts.push(`损坏 ${objectCheck.corrupt.length} 个`);
      throw new Error(
        `快照对象${parts.join('、')}，已拒绝回滚；文件尚未改动。`
        + '请检查快照存储（objects 目录）是否完整，或换一个快照。',
      );
    }

    // 运行中的会话直接拒绝回滚：文件恢复会和当前轮的工具写入互相踩。
    // 这里用“事件流 + sessionController.list”双重检测；即使面板已经打开，
    // 服务端也会在真正执行前再拦一次。
    const runningNow = await this.detectRunning(sessionId);
    if (runningNow.state === true) throw new Error(this.runningError(runningNow));
    const busyNow = await this.detectWorkspaceBusy(cwd, sessionId);
    if (busyNow.length > 0) {
      const ids = busyNow.slice(0, 3).map((item) => item.sessionId).join('、');
      throw new Error(
        `同一工作区还有 ${busyNow.length} 个会话正在运行（${ids}${busyNow.length > 3 ? '…' : ''}），`
        + '已拒绝回滚：请先等它们结束（turn/end）后再试，避免互相覆盖文件。',
      );
    }

    const actualHashes = {
      all: planHashFor(plan, 'all'),
      session: planHashFor(plan, 'session'),
    };
    const tokenEntry = this.validatePlanToken(request.planToken, {
      sessionId,
      snapshotId: plan.snapshotId,
      scope,
      files: doFiles,
    }, actualHashes);

    const report = {
      sessionId,
      snapshotId: plan.snapshotId,
      cwd: plan.cwd,
      at: new Date().toISOString(),
      scope,
      files: null,
      conversation: null,
      prompt: null,
      recoveryPoint: null,
      transactionId: null,
      plan: {
        counts: plan.counts,
        sessionCounts: plan.sessionScope?.counts ?? null,
        warnings: plan.warnings ?? [],
      },
      warnings: [...(plan.warnings ?? [])],
    };
    if (conversationUnavailable) {
      report.warnings.push('该快照没有可验证的对话切点，已跳过对话回退');
    }

    if (doFiles) {
      // 1) 回滚前恢复点：万一回滚错了，还能再回滚回来。
      //    以前失败只 warning 然后继续，等于在“没有后悔药”的情况下改文件；
      //    现在默认生成失败就中止（显式 recoveryPoint:false 才允许跳过）。
      if (request.recoveryPoint !== false) {
        try {
          const recovery = await this.capture(
            { id: sessionId, header: { cwd: plan.cwd } },
            'pre-rollback',
            {
              seq: null,
              forkSeq: null,
              turn: null,
              queuedAt: Date.now(),
              // 恢复点必须记录**目标快照的工作区**，而不是当前 /cd 后的目录。
              cwd: plan.cwd,
              rollbackOf: plan.snapshotId,
              label: `回滚前自动恢复点（${plan.snapshotId}）`,
              // 正在回滚的目标快照不能被这次恢复点采集顺带 trim 掉，
              // 否则中断后 resume 找不到目标记录。
              skipTrim: true,
            },
          );
          report.recoveryPoint = recovery.record.id;
        } catch (error) {
          throw new Error(`无法生成回滚前恢复点，已中止回滚：${String(error?.message ?? error)}`);
        }
      }

      // 预恢复点采集本身也要花时间；在真正写文件前再确认一次。
      const beforeApply = await this.detectRunning(sessionId);
      if (beforeApply.state === true) throw new Error(this.runningError(beforeApply));
      const busyBeforeApply = await this.detectWorkspaceBusy(plan.cwd, sessionId);
      if (busyBeforeApply.length > 0) {
        throw new Error('同一工作区的其他会话在生成恢复点期间开始运行，已中止回滚（文件尚未改动）；请等它们结束后重新预览');
      }

      const filePlan = scope === 'session'
        ? { restore: plan.sessionScope.restore, remove: plan.sessionScope.remove, pruneDirs: plan.sessionScope.pruneDirs ?? [] }
        : { restore: plan.restore, remove: plan.remove, pruneDirs: plan.pruneDirs ?? [] };

      const tx = {
        id: this.nextRestoreId(),
        sessionId,
        snapshotId: plan.snapshotId,
        preRollbackId: report.recoveryPoint,
        scope,
        status: 'in-progress',
        startedAt: Date.now(),
        cwd: plan.cwd,
        files: true,
        conversation: doConversation,
        plan: {
          restore: filePlan.restore.length,
          remove: filePlan.remove.length,
          dirs: filePlan.pruneDirs.length,
        },
      };
      await this.writeRestoreTx(tx);
      report.transactionId = tx.id;

      // 恢复点已经成功、事务日志也落盘；从这里开始令牌才真正被消费。
      tokenEntry.used = true;
      try {
        report.files = await this.applyFilePlan(plan, scope, { sessionId });
        if (report.files.escapedCount > 0) {
          report.warnings.push(`有 ${report.files.escapedCount} 个路径未通过真实路径校验，已跳过（不写入、不删除）`);
        }
        try {
          const previousIndex = await this.store.readIndex(workspaceKeyOf(plan.cwd));
          const { index } = await scanWorkspace({ cwd: plan.cwd, config: this.config, previousIndex });
          await this.store.writeIndex(workspaceKeyOf(plan.cwd), index);
        } catch (error) {
          report.warnings.push(`刷新索引失败：${String(error?.message ?? error)}`);
        }
        tx.status = report.files.failed > 0 ? 'partial' : 'done';
        tx.finishedAt = Date.now();
        tx.report = {
          restored: report.files.restored,
          removed: report.files.removed,
          failed: report.files.failed,
          dirsRemoved: report.files.dirsRemoved,
        };
        await this.writeRestoreTx(tx);
      } catch (error) {
        tx.status = 'failed';
        tx.finishedAt = Date.now();
        tx.error = String(error?.message ?? error);
        await this.writeRestoreTx(tx).catch(() => undefined);
        throw error;
      }

      if (report.files.failed > 0) {
        report.warnings.push(
          `有 ${report.files.failed} 个文件恢复失败；${report.recoveryPoint ? `可回到回滚前恢复点 ${report.recoveryPoint}` : '未生成恢复点'}`,
        );
      }
    } else {
      // 只回退对话：没有恢复点采集步骤，校验通过后立即消费令牌。
      tokenEntry.used = true;
    }

    // 文件恢复不完整时不再 fork：否则新会话会基于一个半完成的工作区继续，用户却以为两边都成功了。
    if (doConversation && report.files !== null && report.files.failed > 0) {
      doConversation = false;
      report.warnings.push('文件恢复有失败，已跳过对话回退；请先处理失败项再重试对话回退');
    }
    const liveCwd = this.meta.get(sessionId)?.cwd;
    if (doConversation && typeof liveCwd === 'string' && liveCwd.length > 0
      && normalizeWorkspacePath(liveCwd) !== normalizeWorkspacePath(plan.cwd)) {
      doConversation = false;
      report.warnings.push('会话工作区已与目标快照不同，已跳过对话回退（避免新会话使用错误目录）');
    }
    if (doFiles && !doConversation) {
      report.warnings.push('本次只恢复文件，对话不会回退；原会话保持不变');
    } else if (!doFiles && doConversation) {
      report.warnings.push('本次只回退对话，文件不会变化；新会话可能看到被撤销轮次改动后的文件');
    }

    if (doConversation) {
      const controller = typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined;
      if (controller === undefined || controller === null || typeof controller.fork !== 'function') {
        report.warnings.push('sessionController 不可用，未执行对话回退');
      } else {
        const atSeq = Number.isSafeInteger(plan.conversation?.atSeq) ? plan.conversation.atSeq : undefined;
        if (atSeq === undefined) {
          report.warnings.push('该快照没有可验证的对话切点，已跳过对话回退');
        } else {
          try {
            const fork = await controller.fork({ sessionId, atSeq });
            const childSessionId = fork?.sessionId ?? null;
            report.conversation = { childSessionId, atSeq };
            if (childSessionId !== null && typeof request.promptText === 'string' && request.promptText.trim().length > 0) {
              try {
                const receipt = await controller.prompt({
                  requestId: `snapshot-manager-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
                  sessionId: childSessionId,
                  mode: 'queue',
                  content: [{ type: 'text', text: request.promptText }],
                }, new AbortController().signal);
                report.prompt = { accepted: receipt?.accepted === true };
              } catch (error) {
                report.warnings.push(`把消息发进新会话失败：${String(error?.message ?? error)}`);
              }
            }
          } catch (error) {
            report.warnings.push(`fork 失败：${String(error?.message ?? error)}`);
          }
        }
      }
    }

    return report;
  }

  /**
   * 按范围执行文件恢复/删除/空目录清理。
   *
   * 每个目标路径先做词法检查，再做真实路径检查；写文件用原子写。
   * 单个文件失败不会中断整批，最后汇总失败项供 UI 展示。
   * @param {object} plan - buildPlan 的完整计划。
   * @param {'all'|'session'} scope - 范围。
   * @param {{sessionId?: string}} [options] - 可选的会话 id，用于在写入过程中发现新一轮开始时中止。
   * @returns {Promise<object>} 文件报告。
   */
  async applyFilePlan(plan, scope, options = {}) {
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    const assertNotRunning = () => {
      if (sessionId.length > 0 && this.meta.get(sessionId)?.running === true) {
        throw new Error('会话在回滚过程中开始运行，已中止；文件可能未完成恢复，请使用恢复入口处理');
      }
    };
    const filePlan = scope === 'session'
      ? {
          restore: plan.sessionScope.restore,
          remove: plan.sessionScope.remove,
          pruneDirs: plan.sessionScope.pruneDirs ?? [],
          restoreDirs: plan.sessionScope.restoreDirs ?? [],
        }
      : {
          restore: plan.restore,
          remove: plan.remove,
          pruneDirs: plan.pruneDirs ?? [],
          restoreDirs: plan.restoreDirs ?? [],
        };
    const guard = await createRealGuard(plan.cwd);
    const restored = [];
    const removed = [];
    const failed = [];
    const escaped = [];
    const dirsRemoved = [];
    const dirsCreated = [];
    // 顺序很重要：先删“快照后新建/快照时不存在”的路径，再收空目录，最后恢复文件。
    //
    // 旧顺序是先恢复再删除。遇到「快照里是 a/b.txt，现在 a 是文件」时，
    // 恢复 a/b.txt 会因 a 是文件而失败，随后又把 a 删掉，最终两边都没有。
    // 先删 a 再恢复，mkdir(a) 就能正常建立；「快照要文件、现在是目录」也同理。
    for (const item of filePlan.remove) {
      assertNotRunning();
      const abs = resolve(join(plan.cwd, item.rel));
      if (relWithinWorkspace(plan.cwd, abs) === null) {
        escaped.push({ rel: item.rel, reason: 'lexical-escape' });
        failed.push({ rel: item.rel, action: item.action, error: '路径越出工作区，已跳过' });
        continue;
      }
      const check = await guard.check(abs, { write: false, rel: item.rel });
      if (!check.ok) {
        escaped.push({ rel: item.rel, reason: check.reason });
        failed.push({ rel: item.rel, action: item.action, error: `真实路径校验失败：${String(check.reason)}` });
        continue;
      }
      try {
        await rm(abs, { force: true });
        removed.push({ rel: item.rel, action: item.action });
      } catch (error) {
        failed.push({ rel: item.rel, action: item.action, error: String(error?.message ?? error) });
      }
    }
    for (const rel of filePlan.pruneDirs) {
      assertNotRunning();
      const abs = resolve(join(plan.cwd, rel));
      if (relWithinWorkspace(plan.cwd, abs) === null) continue;
      const check = await guard.check(abs, { write: false, rel });
      if (!check.ok) continue;
      try {
        await rmdir(abs);
        dirsRemoved.push(rel);
      } catch {
        /* 非空 / 已被删掉 / 被占用：保留原样，不视为失败 */
      }
    }
    for (const rel of filePlan.restoreDirs) {
      assertNotRunning();
      const abs = resolve(join(plan.cwd, rel));
      if (relWithinWorkspace(plan.cwd, abs) === null) {
        escaped.push({ rel, reason: 'lexical-escape' });
        failed.push({ rel, action: 'mkdir', error: '路径越出工作区，已跳过' });
        continue;
      }
      const check = await guard.check(abs, { write: true, rel });
      if (!check.ok) {
        escaped.push({ rel, reason: check.reason });
        failed.push({ rel, action: 'mkdir', error: `真实路径校验失败：${String(check.reason)}` });
        continue;
      }
      try {
        await mkdir(abs, { recursive: true });
        dirsCreated.push(rel);
      } catch (error) {
        failed.push({ rel, action: 'mkdir', error: String(error?.message ?? error) });
      }
    }
    for (const item of filePlan.restore) {
      assertNotRunning();
      const abs = resolve(join(plan.cwd, item.rel));
      if (relWithinWorkspace(plan.cwd, abs) === null) {
        escaped.push({ rel: item.rel, reason: 'lexical-escape' });
        failed.push({ rel: item.rel, action: item.action, error: '路径越出工作区，已跳过' });
        continue;
      }
      const check = await guard.check(abs, { write: true, rel: item.rel });
      if (!check.ok) {
        escaped.push({ rel: item.rel, reason: check.reason });
        failed.push({ rel: item.rel, action: item.action, error: `真实路径校验失败：${String(check.reason)}` });
        continue;
      }
      try {
        const bytes = await this.store.getObject(item.hash);
        if (hashBytes(bytes) !== item.hash) {
          throw new Error(`对象内容损坏：${item.hash}`);
        }
        await writeFileAtomic(abs, bytes);
        restored.push({ rel: item.rel, action: item.action, bytes: bytes.length });
      } catch (error) {
        failed.push({ rel: item.rel, action: item.action, error: String(error?.message ?? error) });
      }
    }
    return {
      restored: restored.length,
      removed: removed.length,
      failed: failed.length,
      dirsRemoved: dirsRemoved.length,
      dirsCreated: dirsCreated.length,
      escapedCount: escaped.length,
      unknown: Array.isArray(plan.unknown) ? plan.unknown.length : 0,
      sampleRestored: restored.slice(0, 20),
      sampleRemoved: removed.slice(0, 20),
      failures: failed.slice(0, 20),
      removedDirs: dirsRemoved.slice(0, 20),
      untracked: plan.untracked ?? null,
    };
  }

  /**
   * 恢复中断的回滚事务。
   * @param {string} id - 事务 id。
   * @param {'resume'|'revert'} action - resume=继续还原目标；revert=回到回滚前恢复点。
   * @returns {Promise<object>} 恢复报告。
   */
  async recover(id, action) {
    const tx = await this.readRestoreTx(id);
    if (tx === null) throw new Error('找不到该回滚事务');
    if (!['in-progress', 'interrupted', 'partial', 'failed'].includes(tx.status)) {
      throw new Error(`该事务当前状态为 ${String(tx.status)}，无需恢复`);
    }
    const target = action === 'revert' ? tx.preRollbackId : tx.snapshotId;
    if (action !== 'resume' && action !== 'revert') throw new Error('action 只能是 resume 或 revert');
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(action === 'revert' ? '该事务没有回滚前恢复点，无法 revert' : '该事务缺少目标快照');
    }
    const running = await this.detectRunning(tx.sessionId);
    if (running.state === true) throw new Error(this.runningError(running));
    return this.withStore(() => this.withWorkspace(tx.cwd, async () => {
      const plan = await this.buildPlan(tx.sessionId, target);
      const selectedRestore = tx.scope === 'session' ? plan.sessionScope.restore : plan.restore;
      const objectCheck = await this.verifyRestoreObjects(selectedRestore);
      if (objectCheck.missing.length > 0 || objectCheck.corrupt.length > 0) {
        throw new Error(
          `快照对象缺失/损坏（缺失 ${objectCheck.missing.length}、损坏 ${objectCheck.corrupt.length}），`
          + '已拒绝恢复；文件尚未改动',
        );
      }
      const runningNow = await this.detectRunning(tx.sessionId);
      if (runningNow.state === true) throw new Error(this.runningError(runningNow));
      const busyNow = await this.detectWorkspaceBusy(tx.cwd, tx.sessionId);
      if (busyNow.length > 0) {
        throw new Error('同一工作区还有其他会话正在运行，已拒绝恢复；请先等它们结束后再重试');
      }
      // 恢复入口同样会改名/删除文件；中断回滚之后用户可能已经继续工作。
      // 与正常回滚一致，先给**当前**工作区存一个恢复点，失败则中止，避免不可逆删除。
      let recoveryPoint = null;
      try {
        const recovery = await this.capture(
          { id: tx.sessionId, header: { cwd: tx.cwd } },
          'pre-rollback',
          {
            seq: null,
            forkSeq: null,
            turn: null,
            queuedAt: Date.now(),
            cwd: tx.cwd,
            label: `恢复前自动恢复点（${tx.id}）`,
            skipTrim: true,
          },
        );
        recoveryPoint = recovery.record.id;
        tx.recoveryPointId = recoveryPoint;
        await this.writeRestoreTx(tx);
      } catch (error) {
        throw new Error(`无法生成恢复前恢复点，已中止恢复：${String(error?.message ?? error)}`);
      }
      // 恢复点采集也要花时间；写文件前再确认一次。
      const runningAfter = await this.detectRunning(tx.sessionId);
      if (runningAfter.state === true) throw new Error(this.runningError(runningAfter));
      const busyAfter = await this.detectWorkspaceBusy(tx.cwd, tx.sessionId);
      if (busyAfter.length > 0) {
        throw new Error('同一工作区的其他会话在生成恢复点期间开始运行，已中止恢复（文件尚未改动）');
      }
      const files = await this.applyFilePlan(plan, tx.scope === 'session' ? 'session' : 'all', { sessionId: tx.sessionId });
      try {
        const previousIndex = await this.store.readIndex(workspaceKeyOf(tx.cwd));
        const { index } = await scanWorkspace({ cwd: tx.cwd, config: this.config, previousIndex });
        await this.store.writeIndex(workspaceKeyOf(tx.cwd), index);
      } catch {
        /* 索引刷新失败不影响恢复本身 */
      }
      tx.status = files.failed > 0 ? 'interrupted' : (action === 'revert' ? 'reverted' : 'recovered');
      tx.recoveredAt = Date.now();
      tx.recoveryAction = action;
      tx.recoveryReport = {
        restored: files.restored,
        removed: files.removed,
        failed: files.failed,
        dirsRemoved: files.dirsRemoved,
        recoveryPointId: recoveryPoint,
      };
      await this.writeRestoreTx(tx);
      return { transactionId: tx.id, action, targetSnapshotId: target, recoveryPointId: recoveryPoint, files };
    }));
  }

  /**
   * 取会话当前**有效**工作目录。
   *
   * `session.header.cwd` 是会话创建时的原始项目目录，DSH 的 `/cd`（`working_directory`
   * 工具）只会追加 `working-directory/change` 事件，不会改 header。因此这里：
   *   ① 真实 Session 优先用宿主 `workingDirectory.get(session)` 的 projection；
   *   ② 其次是本代插件从事件里维护的 `meta.cwd`；
   *   ③ 最后才回退到不可变的 `session.header.cwd`。
   * 合成会话（`{id, header}`）没有宿主的投影状态，只走 ②/③，避免误拿默认目录。
   * @param {object} session - Session 或合成会话。
   * @returns {string|null} 归一化后的 cwd。
   */
  effectiveCwdForSession(session) {
    if (session === undefined || session === null) return null;
    const meta = this.meta.get(session.id);
    const headerRaw = session?.header?.cwd;
    const hasKnownCwd = (typeof headerRaw === 'string' && headerRaw.length > 0)
      || (typeof meta?.cwd === 'string' && meta.cwd.length > 0);
    const workingDirectory = typeof this.ctx?.get === 'function' ? this.ctx.get('workingDirectory') : undefined;
    // 只对真实 Session 调 projection：合成会话会被宿主当未知 session 返回 defaultDirectory；
    // 没有 header/meta 的无工作区会话也不能拿宿主默认目录来采集。
    if (hasKnownCwd && typeof session.append === 'function'
      && workingDirectory !== null && workingDirectory !== undefined
      && typeof workingDirectory.get === 'function') {
      try {
        const current = workingDirectory.get(session);
        if (typeof current === 'string' && current.length > 0) return normalizeWorkspacePath(current);
      } catch {
        /* 服务不可用/会话不匹配：走事件缓存与 header */
      }
    }
    if (typeof meta?.cwd === 'string' && meta.cwd.length > 0) return meta.cwd;
    if (typeof headerRaw === 'string' && headerRaw.length > 0) return normalizeWorkspacePath(headerRaw);
    return null;
  }

  /**
   * 记下某会话当前有效的工作目录。
   *
   * 不能再用 header 覆盖事件里已经更新的值：`/cd` 之后 header 仍是旧项目目录，
   * 每次事件覆盖会把 `working-directory/change` 的效果抹掉。
   * @param {object} session - Session。
   * @returns {string|null} 归一化后的 cwd。
   */
  recordSessionCwd(session) {
    const current = this.effectiveCwdForSession(session);
    if (current === null) return null;
    this.metaFor(session).cwd = current;
    return current;
  }

  /**
   * 解析某会话的工作目录，供只有 sessionId 的调用方（手动打快照 / 预览 / 回滚）使用。
   *
   * 顺序：
   *   ① 本代事件缓存（含 `/cd` 后的值）；
   *   ② 活着的 Session → `workingDirectory` 投影；
   *   ③ 持久化日志里最后一条 `working-directory/change`（冷会话也能拿到 `/cd` 结果）；
   *   ④ `sessionController.list()` / `sessionPersistence.stat()` 的 header.cwd（原始项目目录）；
   *   ⑤ 旧 DSH 的 `inspect()`（兼容分支，当前 0.2.2-rc.1 没有该方法）；
   *   ⑥ 报错。
   * 注意 `list().items[].cwd` 是 header.cwd（原始目录），不能当作 `/cd` 后的有效目录；
   * 所以 ③ 必须排在 ④ 前面。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<string>} 归一化后的 cwd。
   */
  async resolveSessionCwd(sessionId) {
    const meta = this.meta.get(sessionId);
    if (typeof meta?.cwd === 'string' && meta.cwd.length > 0) return meta.cwd;

    const setCached = (value) => {
      const resolved = normalizeWorkspacePath(value);
      // 只在没有已知 cwd 时落缓存：若会话被迁移到别处，以实时事件为准。
      if (this.meta.get(sessionId) === meta || meta === undefined) {
        this.metaFor({ id: sessionId }).cwd = resolved;
      }
      return resolved;
    };

    const sessions = typeof this.ctx?.get === 'function' ? this.ctx.get('sessions') : undefined;
    const live = sessions !== null && sessions !== undefined && typeof sessions.get === 'function'
      ? sessions.get(sessionId)
      : undefined;
    if (live !== undefined && live !== null) {
      const current = this.effectiveCwdForSession(live);
      if (current !== null) return setCached(current);
    }

    // 冷会话：事件日志是 `/cd` 的唯一持久化来源。
    const events = await this.readEvents(sessionId).catch(() => null);
    let eventCwd = null;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event?.type === 'working-directory/change' && typeof event.data?.cwd === 'string' && event.data.cwd.length > 0) {
          eventCwd = event.data.cwd;
        }
      }
    }

    const controller = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : undefined;
    let headerCwd = null;
    if (controller !== null && controller !== undefined && typeof controller.list === 'function') {
      try {
        const result = await controller.list({}, new AbortController().signal);
        const item = Array.isArray(result?.items) ? result.items.find((row) => row?.sessionId === sessionId) : undefined;
        if (typeof item?.cwd === 'string' && item.cwd.length > 0) headerCwd = item.cwd;
      } catch {
        /* list 不可用：继续尝试持久化 header */
      }
    }
    if (headerCwd === null) {
      const persistence = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionPersistence') : undefined;
      if (persistence !== null && persistence !== undefined && typeof persistence.stat === 'function') {
        try {
          const stored = await persistence.stat(sessionId);
          const raw = stored?.header?.cwd;
          if (typeof raw === 'string' && raw.length > 0) headerCwd = raw;
        } catch {
          /* 读不到 header：继续尝试旧 inspect */
        }
      }
    }

    const resolved = eventCwd ?? headerCwd;
    if (resolved !== null) return setCached(resolved);

    // 兼容更老的 DSH：该方法在 0.2.2-rc.1 已不存在，但保留成本很低。
    if (controller !== null && controller !== undefined && typeof controller.inspect === 'function') {
      try {
        const inspection = await controller.inspect(sessionId);
        const raw = inspection?.meta?.cwd;
        if (typeof raw === 'string' && raw.length > 0) return setCached(raw);
      } catch {
        /* 落到报错 */
      }
    }
    throw new Error('读不到该会话的工作目录，无法打快照：请先在这个会话里发一条消息（让插件看到它的工作区），或确认该会话有工作区');
  }

  /**
   * 用合成会话做一次采集（不要求会话是活的）。
   * @param {{sessionId: string, cwd?: string, phase?: string, label?: string, seq?: number|null, forkSeq?: number|null, turn?: number|null}} input - 采集输入。
   * @returns {Promise<object>} 采集结果。
   */
  async captureSynthetic(input) {
    const sessionId = String(input?.sessionId ?? '');
    if (sessionId.length === 0) throw new Error('缺少 sessionId');
    // cwd 不再由客户端提供：客户端只发 sessionId，Host 自己解析（更可靠，也不信任客户端路径）。
    const cwd = await this.resolveSessionCwd(sessionId);
    const session = { id: sessionId, header: { cwd } };
    const meta = this.metaFor(session);
    // 合成会话没有宿主的 workingDirectory 投影，显式写入本次解析结果，避免 capture 回退到旧 meta。
    meta.cwd = cwd;
    const phase = typeof input.phase === 'string' && input.phase.length > 0 ? input.phase : 'manual';
    const label = typeof input.label === 'string' && input.label.length > 0 ? input.label.slice(0, 200) : undefined;
    return this.withStore(() => this.withWorkspace(cwd, () => this.capture(session, phase, {
      seq: Number.isSafeInteger(input.seq) ? input.seq : null,
      forkSeq: Number.isSafeInteger(input.forkSeq) ? input.forkSeq : null,
      turn: Number.isSafeInteger(input.turn) ? input.turn : null,
      queuedAt: Date.now(),
      cwd,
      ...(label === undefined ? {} : { label }),
      rollbackOf: typeof input.rollbackOf === 'string' ? input.rollbackOf : null,
    })));
  }

  /**
   * 列出当前会话工作区的插件忽略清单（手动管理入口）。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{cwd: string, file: string, entries: Array<object>}>} 清单。
   */
  async listManagedIgnore(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('缺少 sessionId');
    const cwd = await this.resolveSessionCwd(sessionId);
    const { file, entries } = await readManagedIgnore(this.config, cwd);
    return { cwd, file, entries };
  }

  /**
   * 手动添加一条忽略项（path 按相对路径前缀，pattern 按段名通配）。
   * @param {string} sessionId - 会话 id。
   * @param {{kind?: string, value?: string}} input - 条目。
   * @returns {Promise<{cwd: string, file: string, entries: Array<object>}>} 更新后的清单。
   */
  async addManagedIgnore(sessionId, input = {}) {
    const kind = input.kind === 'pattern' ? 'pattern' : input.kind === 'path' ? 'path' : '';
    if (kind.length === 0) throw new Error('忽略类型只能是 path 或 pattern');
    const raw = String(input.value ?? '');
    const value = kind === 'path' ? normalizeManagedIgnorePath(raw) : raw.trim();
    if (value.length === 0) throw new Error('忽略内容不能为空');
    if (kind === 'pattern' && value.includes('/')) throw new Error('通配模式不能包含 /；路径请用 path 类型添加');
    const cwd = await this.resolveSessionCwd(sessionId);
    await this.withStore(async () => {
      const current = await readManagedIgnore(this.config, cwd);
      const exists = current.entries.some((entry) => entry.kind === kind && (kind === 'path'
        ? pathKeyOf(entry.value) === pathKeyOf(value)
        : entry.value.toLowerCase() === value.toLowerCase()));
      if (exists) return;
      if (current.entries.length >= AUTO_IGNORE_MAX_ENTRIES) {
        throw new Error(`忽略清单最多 ${AUTO_IGNORE_MAX_ENTRIES} 条，请先删除不再需要的条目`);
      }
      current.entries.push({ kind, value, source: 'manual', addedAt: Date.now() });
      await writeJson(managedIgnoreFile(this.config, cwd), {
        v: MANAGED_IGNORE_VERSION,
        cwd: normalizeWorkspacePath(cwd),
        updatedAt: Date.now(),
        entries: current.entries,
      });
    });
    return this.listManagedIgnore(sessionId);
  }

  /**
   * 手动删除一条忽略项。
   * @param {string} sessionId - 会话 id。
   * @param {{kind?: string, value?: string}} input - 条目。
   * @returns {Promise<{cwd: string, file: string, entries: Array<object>}>} 更新后的清单。
   */
  async removeManagedIgnore(sessionId, input = {}) {
    const kind = input.kind === 'pattern' ? 'pattern' : input.kind === 'path' ? 'path' : '';
    if (kind.length === 0) throw new Error('忽略类型只能是 path 或 pattern');
    const raw = String(input.value ?? '').trim();
    if (raw.length === 0) throw new Error('缺少要删除的忽略内容');
    const value = kind === 'path' ? normalizeManagedIgnorePath(raw) : raw;
    const cwd = await this.resolveSessionCwd(sessionId);
    await this.withStore(async () => {
      const current = await readManagedIgnore(this.config, cwd);
      const next = current.entries.filter((entry) => !(entry.kind === kind && (kind === 'path'
        ? pathKeyOf(entry.value) === pathKeyOf(value)
        : entry.value.toLowerCase() === value.toLowerCase())));
      if (next.length === current.entries.length) throw new Error('忽略清单里找不到这一项');
      await writeJson(managedIgnoreFile(this.config, cwd), {
        v: MANAGED_IGNORE_VERSION,
        cwd: normalizeWorkspacePath(cwd),
        updatedAt: Date.now(),
        entries: next,
      });
    });
    return this.listManagedIgnore(sessionId);
  }

  /**
   * DEV-ONLY：启动标记，用于确认配置传递与可写目录。正式发布时删除。
   * @returns {Promise<void>} 写完后 resolve。
   */
  async writeBootMarker() {
    try {
      const payload = JSON.stringify({
        at: new Date().toISOString(),
        version: VERSION,
        config: this.config.rawConfig ?? null,
        pluginDir: this.pluginDir,
        pid: process.pid,
        node: process.version,
        cwd: process.cwd(),
      }, null, 2);
      // 只写开发通道目录与快照库根目录：绝不往插件自身的安装目录里写文件。
      const targets = [this.config.devChannelDir, join(this.config.dshHome, 'snapshot-manager')]
        .filter((dir) => typeof dir === 'string' && dir.length > 0);
      for (const dir of targets) {
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'boot.json'), payload, 'utf8');
        } catch {
          /* 换下一个目标 */
        }
      }
    } catch {
      /* 标记失败不影响插件 */
    }
  }

  /**
   * 命令分发：开发通道与未来的 UI 接口共用。
   * @param {{op?: string, args?: object}} cmd - 命令。
   * @returns {Promise<unknown>} 命令结果。
   */
  async dispatch(cmd) {
    const op = typeof cmd?.op === 'string' ? cmd.op : '';
    const args = cmd?.args !== null && typeof cmd.args === 'object' ? cmd.args : {};
    switch (op) {
      case 'status':
        return this.status();
      case 'clientGraph':
        return this.clientGraph();
      case 'listDir':
        return listDirTree(String(args.path ?? this.pluginDir), { maxEntries: Number(args.maxEntries ?? 50) });
      case 'nudgeGraph':
        return this.nudgeGraph();
      case 'probeInjection':
        return this.probeInjection();
      case 'authUrl':
        return this.authUrl(String(args.base ?? 'http://127.0.0.1:19387'));
      case 'scan':
        return this.devScan(String(args.cwd ?? process.cwd()));
      case 'capture':
        return this.devCapture(args);
      case 'snapshots':
        return this.listSnapshots(String(args.sessionId ?? ''));
      case 'treeAt':
        return this.devTreeAt(String(args.sessionId ?? ''), String(args.snapshotId ?? ''), String(args.rel ?? ''));
      case 'storeStats':
        return this.store.stats();
      case 'preview':
        return this.preview(String(args.sessionId ?? ''), String(args.snapshotId ?? ''));
      case 'restore':
        return this.restore(args);
      case 'recoveries':
        return { items: await this.listRecoveries(String(args.sessionId ?? '')) };
      case 'recover':
        return this.recover(String(args.id ?? ''), args.action === 'revert' ? 'revert' : 'resume');
      case 'devPrompt':
        return this.devPrompt(args);
      case 'rawEvents':
        return this.devRawEvents(args);
      case 'resetStore':
        await rm(this.config.root, { recursive: true, force: true });
        this.queues.clear();
        this.workspaceQueues.clear();
        this.planTokens.clear();
        this.forkSafety.clear();
        this.baselineQueued.clear();
        this.meta.clear();
        this.lastCapture = null;
        return { reset: true, root: this.config.root };
      case 'lastCapture':
        return this.lastCapture ?? { none: true };
      case 'beacons': {
        const store = sharedHolder().beacons;
        return { count: store.length, items: store };
      }
      case 'liveClient': {
        const gateway = typeof this.ctx.get === 'function' ? this.ctx.get('typertGateway') : undefined;
        let live = null;
        try {
          live = typeof gateway?.hasLiveClient === 'function' ? gateway.hasLiveClient() : 'no-method';
        } catch (error) {
          live = `error: ${String(error?.message ?? error)}`;
        }
        const store = sharedHolder().beacons;
        return { hasLiveClient: live, beacons: store.length, generation: this.generation, sharedGeneration: sharedHolder().generation };
      }
      case 'echo':
        return { echo: args, config: this.config };
      default:
        throw new Error(`未知命令：${op}`);
    }
  }

  /**
   * 强制 clientModules 重新组合插件图，并报告我方条目的解析结果。
   * 用途：入口路径变更后，图可能仍保留旧的 clientPath（客户端 bundle 指向旧位置）。
   * @returns {Promise<object>} 重组前后的条目信息。
   */
  async nudgeGraph() {
    const modules = typeof this.ctx.get === 'function' ? this.ctx.get('clientModules') : undefined;
    if (modules === undefined || modules === null) return { available: false };
    const mine = () => {
      try {
        const entries = modules.graph()?.entries ?? [];
        return entries.filter((entry) => String(entry?.id ?? '').includes('snapshot'))
          .map((entry) => ({ id: entry.id, url: entry.url, rev: entry.rev, path: safeClientPath(modules, entry.id) }));
      } catch (error) {
        return [{ error: String(error?.message ?? error) }];
      }
    };
    const before = mine();
    const steps = {};
    try {
      steps.rebuilt = modules.rebuilt?.('dsh-snapshot-manager') ?? 'no-method';
    } catch (error) {
      steps.rebuiltError = String(error?.message ?? error);
    }
    if (typeof modules.flush === 'function') {
      try {
        await new Promise((resolve) => {
          let settled = false;
          const done = (err) => {
            if (settled) return;
            settled = true;
            if (err) steps.flushError = String(err?.message ?? err);
            resolve();
          };
          const returned = modules.flush(done);
          if (returned !== undefined && typeof returned.then === 'function') returned.then(() => done(), done);
          setTimeout(() => done(), 3000);
        });
      } catch (error) {
        steps.flushThrow = String(error?.message ?? error);
      }
    } else {
      steps.flush = 'no-method';
    }
    return { available: true, before, after: mine(), steps };
  }

  /**
   * 读取浏览器插件图，验证客户端半边是否已解析并提供。
   * @returns {object} 图信息与本地包相关条目。
   */
  clientGraph() {
    const modules = typeof this.ctx.get === 'function' ? this.ctx.get('clientModules') : undefined;
    if (modules === undefined || modules === null) return { available: false, reason: 'clientModules 服务不可用' };
    let graph;
    try {
      graph = modules.graph();
    } catch (error) {
      return { available: false, reason: `graph() 失败：${String(error?.message ?? error)}` };
    }
    const entries = Array.isArray(graph?.entries) ? graph.entries : [];
    const mine = entries.filter((entry) => String(entry?.id ?? '').includes('snapshot'));
    return {
      available: true,
      rev: graph?.rev ?? null,
      total: entries.length,
      mine: mine.map((entry) => {
        let path;
        let baseline;
        try {
          path = modules.clientPath(entry.id);
        } catch (error) {
          path = `解析失败：${String(error?.message ?? error)}`;
        }
        try {
          baseline = modules.artifactBaseline(entry.id);
        } catch {
          baseline = undefined;
        }
        return { id: entry.id, url: entry.url, rev: entry.rev, path, baseline };
      }),
    };
  }

  /**
   * 取一个带启动令牌的已鉴权 URL（浏览器用它打开/恢复页面）。
   * @param {string} base - 站点根 URL。
   * @returns {object} 鉴权 URL 或失败原因。
   */
  authUrl(base) {
    const connection = typeof this.ctx.get === 'function' ? this.ctx.get('connection') : undefined;
    if (connection === undefined || connection === null) return { ok: false, reason: 'connection 服务不可用' };
    if (typeof connection.authenticatedUrl !== 'function') {
      return { ok: false, reason: 'connection.authenticatedUrl 不可用', keys: Object.keys(connection).slice(0, 40) };
    }
    try {
      return { ok: true, base, url: connection.authenticatedUrl(base) };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  /**
   * 用一段样例 HTML 验证 index 注入是否生效（无需浏览器鉴权即可自检）。
   * @returns {object} 注入前后的 HTML 片段。
   */
  probeInjection() {
    const webServer = typeof this.ctx.get === 'function' ? this.ctx.get('webServer') : undefined;
    if (webServer === undefined || webServer === null) return { available: false, reason: 'webServer 服务不可用' };
    const sample = '<html><head></head><body><div id="app"></div></body></html>';
    let applied = null;
    let rendered = null;
    let error = null;
    try {
      applied = typeof webServer.applyIndexTaps === 'function' ? webServer.applyIndexTaps(sample) : 'no-applyIndexTaps';
    } catch (caught) {
      error = String(caught?.message ?? caught);
    }
    try {
      rendered = typeof webServer.renderIndex === 'function' ? webServer.renderIndex(sample) : 'no-renderIndex';
    } catch (caught) {
      error = `${error ?? ''} renderIndex:${String(caught?.message ?? caught)}`;
    }
    return {
      available: true,
      tapInstalled: this.disposeIndexTap !== undefined,
      applied,
      rendered: typeof rendered === 'string' && rendered.length > 900 ? `${rendered.slice(0, 900)}…` : rendered,
      error,
    };
  }

  /**
   * 读出客户端 bundle 文件内容（供自带路由提供，避免依赖 clientModules 的图行）。
   * @returns {Promise<{text: string, rev: string, path: string}>} 内容与版本号。
   */
  async readClientBundle() {
    const path = join(this.pluginDir, 'client.js');
    const text = await readFile(path, 'utf8');
    const info = await stat(path);
    const rev = `${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}`;
    return { text, rev, path };
  }

  /**
   * 把客户端 bundle 注入页面（开发期不依赖 clientModules 的插件图）。
   * @param {object} webServer - webServer 服务。
   * @returns {void}
   */
  installClientInjection(webServer) {
    if (webServer === undefined || webServer === null || typeof webServer.tapIndex !== 'function') {
      this.logger.warn('webServer.tapIndex 不可用，客户端 UI 注入未安装');
      return;
    }
    const route = `/api/${PLUGIN_NAME}/${ROUTE_VERSION}/client.js`;
    const tag = `<script src="${route}?v=${VERSION}"></script>`;
    const dispose = webServer.tapIndex((html) => {
      if (typeof html !== 'string' || html.includes(route)) return html;
      const at = html.lastIndexOf('</body>');
      return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
    });
    this.disposeIndexTap = typeof dispose === 'function' ? dispose : undefined;
    this.logger.info(`客户端 UI 注入已安装：${route}`);
  }

  /**
   * DEV：只跑一次扫描，报告增量与耗时（不落快照）。
   * @param {string} cwd - 工作区根目录。
   * @returns {Promise<object>} 扫描统计。
   */
  async devScan(cwd) {
    const workspaceKey = workspaceKeyOf(cwd);
    const previousIndex = await this.store.readIndex(workspaceKey);
    const { changes, index, stats } = await scanWorkspace({ cwd, config: this.config, previousIndex });
    return {
      workspaceKey,
      hadIndex: previousIndex !== null,
      stats,
      sampleChanges: Object.entries(changes).slice(0, 15).map(([rel, change]) => ({
        rel,
        action: change.hash === null ? 'deleted' : 'changed',
        size: change.size,
      })),
      indexSize: Object.keys(index.entries).length,
    };
  }

  /**
   * DEV：用合成会话跑一次完整采集（不依赖真实对话）。
   * @param {object} args - {cwd, phase, sessionId, label, seq, forkSeq, turn}。
   * @returns {Promise<object>} 采集结果。
   */
  async devCapture(args) {
    const cwd = String(args.cwd ?? 'D:/javaProject/yf');
    const sessionId = String(args.sessionId ?? `dev-${shortHash(cwd)}`);
    const session = { id: sessionId, header: { cwd } };
    if (args.label !== undefined) this.metaFor(session).label = String(args.label);
    const phase = args.phase === 'start' ? 'start' : args.phase === 'end' ? 'end' : 'manual';
    const result = await this.capture(session, phase, {
      seq: Number.isSafeInteger(args.seq) ? args.seq : null,
      forkSeq: Number.isSafeInteger(args.forkSeq) ? args.forkSeq : null,
      turn: Number.isSafeInteger(args.turn) ? args.turn : null,
      cwd,
    });
    return { sessionId, ...result };
  }

  /**
   * 列出某会话的快照摘要。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<object>} 摘要列表。
   */
  async listSnapshots(sessionId) {
    if (sessionId.length === 0) return { error: '缺少 sessionId' };
    return this.withStore(async () => {
      // 面板每次打开都会调这里：顺手把历史快照的提问锚点/说明自愈一次（幂等）。
      await this.repairStartLabels(sessionId).catch((error) => {
        this.logger.warn(`起点快照说明自愈失败：${String(error?.message ?? error)}`);
      });
      const snapshots = await this.store.listSnapshots(sessionId);
      return {
      sessionId,
      count: snapshots.length,
      lastError: this.lastError !== null && this.lastError.sessionId === sessionId ? this.lastError : null,
      storageError: this.storageError,
      items: snapshots.map((record) => ({
        id: record.id,
        phase: record.phase,
        turn: record.turn,
        seq: record.seq,
        forkSeq: record.forkSeq,
        at: record.at,
        label: record.label,
        full: record.full === true,
        parent: record.parent,
        changeCount: Number.isSafeInteger(record.changeCount)
          ? record.changeCount
          : Object.keys(record.changes ?? {}).length,
        stats: record.stats,
        windowRisk: Array.isArray(record.window?.risk) ? record.window.risk.length : 0,
        rollbackOf: record.rollbackOf ?? null,
        chainRepaired: record.chainRepaired === true,
        promotedAt: record.promotedAt ?? null,
      })),
      };
    });
  }

  /**
   * DEV：还原某个快照的完整路径表（验证链式增量正确性）。
   * @param {string} sessionId - 会话 id。
   * @param {string} snapshotId - 快照 id（空则取最后一个）。
   * @returns {Promise<object>} 路径数与样本。
   */
  async devTreeAt(sessionId, snapshotId, probeRel) {
    const snapshots = await this.store.listSnapshots(sessionId);
    if (snapshots.length === 0) return { error: '该会话没有快照' };
    const target = snapshotId.length > 0 ? snapshotId : snapshots[snapshots.length - 1].id;
    const info = this.store.resolveTreeInfo(snapshots, target);
    const tree = info.tree;
    const paths = Object.keys(tree);
    return {
      sessionId,
      snapshotId: target,
      complete: info.complete,
      reason: info.reason,
      chain: info.chain,
      total: paths.length,
      present: paths.filter((rel) => tree[rel] !== null).length,
      absent: paths.filter((rel) => tree[rel] === null).length,
      probed: typeof probeRel === 'string' && probeRel.length > 0
        ? { rel: probeRel, tracked: probeRel in tree, hash: probeRel in tree ? tree[probeRel] : '未跟踪' }
        : undefined,
      sample: paths.slice(0, 5).map((rel) => ({ rel, hash: tree[rel] })),
    };
  }

  /**
   * 记录浏览器半边上报的信标（用于在无法直接看页面时验证 UI 是否挂载）。
   * 存在共享持有者里：路由可能由旧代注册，而信标必须能被任何一代读到。
   * @param {object} body - 信标内容。
   * @returns {void}
   */
  recordBeacon(body) {
    const store = sharedHolder().beacons;
    let detail = body?.detail ?? null;
    // 信标只用于诊断，不能让 owner 客户端把任意大的对象长期挂在进程内存里。
    try {
      const text = JSON.stringify(detail);
      if (typeof text === 'string' && text.length > 16 * 1024) {
        detail = { truncated: true, bytes: text.length };
      }
    } catch {
      detail = { truncated: true, reason: 'unserializable' };
    }
    store.push({
      at: Date.now(),
      generation: this.generation,
      phase: typeof body?.phase === 'string' ? body.phase : 'unknown',
      rev: typeof body?.rev === 'string' ? body.rev : null,
      error: typeof body?.error === 'string' ? body.error.slice(0, 800) : null,
      detail,
    });
    if (store.length > 50) store.splice(0, store.length - 50);
    this.logger.info(`浏览器信标：${body?.phase ?? 'unknown'}${body?.error ? `（错误：${String(body.error).slice(0, 160)}）` : ''}`);
  }

  /**
   * 自愈式迁移：把历史遗留的"非规范化工作区 key"索引归并到规范化 key 下。
   * 同一个工作区因斜杠写法不同分裂出的多把 key，会在这里被合并成一把。
   * @returns {Promise<object>} 迁移报告。
   */
  async normalizeIndexKeys() {
    return this.withStore(async () => {
    const dir = join(this.config.root, 'index');
    const names = await readdir(dir).catch(() => []);
    const report = { renamed: [], merged: [], refreshed: [], scanned: names.length };
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const current = name.slice(0, -'.json'.length);
      const record = await readJson(join(dir, name));
      if (record === null || typeof record.cwd !== 'string' || record.cwd.length === 0) continue;
      const normalized = normalizeWorkspacePath(record.cwd);
      const wanted = workspaceKeyOf(record.cwd);
      if (wanted === current) {
        if (normalized !== record.cwd) {
          record.cwd = normalized;
          await writeJson(join(dir, name), record);
          report.refreshed.push(current);
        }
        continue;
      }
      const target = join(dir, `${wanted}.json`);
      const existing = await readJson(target);
      if (existing === null) {
        record.cwd = normalized;
        await writeJson(target, record);
        await rm(join(dir, name), { force: true });
        report.renamed.push({ from: current, to: wanted, cwd: normalized });
      } else {
        const keepNew = (record.scannedAt ?? 0) > (existing.scannedAt ?? 0);
        if (keepNew) {
          record.cwd = normalized;
          await writeJson(target, record);
        }
        await rm(join(dir, name), { force: true });
        report.merged.push({ from: current, to: wanted, keptNewer: keepNew });
      }
    }
    if (report.renamed.length + report.merged.length + report.refreshed.length > 0) {
      this.logger.info(`工作区索引 key 已归并：重命名 ${report.renamed.length}、合并 ${report.merged.length}、规范化 ${report.refreshed.length}`);
    }
    return report;
    });
  }

  /**
   * 清理孤立快照：会话日志已不存在的快照目录。
   * @returns {Promise<object>} 清理报告。
   */
  async pruneSnapshots() {
    return this.withStore(async () => {
    const dir = join(this.config.root, 'sessions');
    let folders;
    try {
      folders = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: [], kept: 0, scanned: 0, corrupt: 0, skipped: true, reason: 'sessions 目录不存在' };
      this.logger.warn(`修剪快照跳过：无法读取 ${dir}（${String(error?.message ?? error)}）`);
      return { removed: [], kept: 0, scanned: 0, corrupt: 0, skipped: true, reason: `无法读取 sessions 目录：${String(error?.message ?? error)}` };
    }
    const removed = [];
    const kept = [];
    const candidates = [];
    let corrupt = 0;
    let unreadable = false;
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      let files;
      try {
        files = await readdir(join(dir, folder.name));
      } catch (error) {
        this.logger.warn(`修剪快照跳过：无法读取会话目录 ${folder.name}（${String(error?.message ?? error)}）`);
        unreadable = true;
        break;
      }
      const first = files.find((name) => name.endsWith('.json'));
      const record = first === undefined ? undefined : await readJson(join(dir, folder.name, first));
      if (first !== undefined && record === null) {
        // 读不出记录时不能凭 folder.name 猜 sessionId 并删目录；保留，等待人工处理。
        corrupt += 1;
        kept.push(folder.name);
        continue;
      }
      const sessionId = String(record?.sessionId ?? folder.name);
      const found = await this.findSessionDir(sessionId);
      if (found.state === 'unreadable') {
        this.logger.warn(`修剪快照跳过：无法确认会话日志是否存在（${sessionId}：${String(found.reason)}）`);
        unreadable = true;
        break;
      }
      if (found.state === 'absent') {
        candidates.push({ folder: folder.name, sessionId, records: files.length });
      } else {
        kept.push(sessionId);
      }
    }
    if (unreadable) {
      return { removed: [], kept: kept.length, scanned: folders.length, corrupt, skipped: true, reason: '无法确认会话日志是否仍然存在，已拒绝批量删除' };
    }
    // 一个日志都看不到却有一堆待删会话，最可能的原因不是"全部会话都删了"，
    // 而是 dshHome 配置/目录瞬时不可读；宁可不清，也不能把整个快照库删空。
    if (candidates.length > 0 && kept.length === 0) {
      return { removed: [], kept: 0, scanned: folders.length, corrupt, skipped: true, reason: '没有找到任何会话日志，已拒绝批量删除快照' };
    }
    for (const candidate of candidates) {
      await rm(join(dir, candidate.folder), { recursive: true, force: true });
      removed.push({ sessionId: candidate.sessionId, records: candidate.records });
    }
    if (removed.length > 0) {
      await this.forgetSessions(removed.map((item) => item.sessionId)).catch((error) => {
        this.logger.warn(`更新会话目录清单失败：${String(error?.message ?? error)}`);
      });
    }
    return { removed, kept: kept.length, scanned: folders.length, corrupt };
    });
  }

  /**
   * 回收没有任何快照记录引用的内容对象。
   * @returns {Promise<object>} 回收报告。
   */
  async gcObjects() {
    return this.withStore(async () => {
    const sessionsRoot = join(this.config.root, 'sessions');
    const referenced = new Set();
    let corrupt = 0;
    let folders;
    try {
      folders = await readdir(sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // sessions 根不存在时不能把所有对象当垃圾：可能只是存储还没建/被临时移走。
        return { referenced: 0, kept: 0, removed: 0, bytes: 0, corrupt: 0, skipped: true, reason: 'sessions 目录不存在' };
      }
      this.logger.warn(`GC 跳过：无法读取 ${sessionsRoot}（${String(error?.message ?? error)}）`);
      return { referenced: 0, kept: 0, removed: 0, bytes: 0, corrupt: 0, skipped: true, reason: `无法读取 sessions 目录：${String(error?.message ?? error)}` };
    }
    // 清单记录曾经有快照的会话；某个目录整体被移走时，它不是“没有引用”，
    // 而是引用关系无法确认。此时宁可跳过 GC，避免把该会话的对象删光。
    const manifestPath = this.sessionManifestPath();
    const manifestExists = await stat(manifestPath).then(() => true).catch(() => false);
    if (manifestExists) {
      const manifest = await readJson(manifestPath);
      if (manifest === null || !Array.isArray(manifest.sessions)) {
        return { referenced: 0, kept: 0, removed: 0, bytes: 0, corrupt: 0, skipped: true, reason: '会话目录清单无法解析' };
      }
      const presentFolders = new Set(folders.filter((folder) => folder.isDirectory()).map((folder) => folder.name));
      const missing = manifest.sessions.filter((id) => typeof id === 'string' && !presentFolders.has(id));
      if (missing.length > 0) {
        return {
          referenced: 0,
          kept: 0,
          removed: 0,
          bytes: 0,
          corrupt: 0,
          skipped: true,
          reason: `有 ${missing.length} 个已知会话的快照目录不存在（可能被移走），已拒绝回收对象`,
        };
      }
    }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      let files;
      try {
        files = await readdir(join(sessionsRoot, folder.name));
      } catch (error) {
        // 读不到某个会话目录 ≠ 它没有引用；继续回收会把该会话的对象删光。
        this.logger.warn(`GC 跳过：无法读取会话目录 ${folder.name}（${String(error?.message ?? error)}）`);
        return { referenced: referenced.size, kept: 0, removed: 0, bytes: 0, corrupt, skipped: true, reason: `无法读取会话目录 ${folder.name}` };
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const record = await readJson(join(sessionsRoot, folder.name, file));
        if (record === null) {
          // 读不出的记录不能当成“没有引用”：否则它引用的对象会被当成垃圾删掉。
          corrupt += 1;
          continue;
        }
        if (record.changes !== null && typeof record.changes === 'object' && !Array.isArray(record.changes)) {
          for (const hash of Object.values(record.changes)) {
            if (typeof hash === 'string' && hash.length > 0) referenced.add(hash);
          }
        } else {
          corrupt += 1;
        }
      }
    }
    if (corrupt > 0) {
      this.logger.warn(`GC 跳过：有 ${corrupt} 个快照记录无法解析，不能安全判断引用关系`);
      return { referenced: referenced.size, kept: 0, removed: 0, bytes: 0, corrupt, skipped: true, reason: '存在无法解析的快照记录' };
    }
    const objectsRoot = join(this.config.root, 'objects');
    let removed = 0;
    let bytes = 0;
    let kept = 0;
    const present = new Set();
    let buckets;
    try {
      buckets = await readdir(objectsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { referenced: referenced.size, kept: 0, removed: 0, bytes: 0, missing: referenced.size };
      this.logger.warn(`GC 跳过：无法读取对象目录（${String(error?.message ?? error)}）`);
      return { referenced: referenced.size, kept: 0, removed: 0, bytes: 0, corrupt, skipped: true, reason: `无法读取 objects 目录：${String(error?.message ?? error)}` };
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = join(objectsRoot, bucket.name);
      let files;
      try {
        files = await readdir(bucketDir);
      } catch (error) {
        this.logger.warn(`GC 跳过：无法读取对象桶 ${bucket.name}（${String(error?.message ?? error)}）`);
        return { referenced: referenced.size, kept, removed, bytes, corrupt, skipped: true, reason: `无法读取对象桶 ${bucket.name}` };
      }
      for (const file of files) {
        present.add(file);
        if (referenced.has(file)) {
          kept += 1;
          continue;
        }
        const info = await stat(join(bucketDir, file)).catch(() => undefined);
        if (info === undefined) {
          // 连 stat 都失败时不能当成可回收：宁可留下，也不要删掉可能是并发写入的对象。
          kept += 1;
          continue;
        }
        // 宽限期：采集是“先落对象、后写记录”，跨代/并发窗口里对象可能暂时未被引用。
        if (Date.now() - info.mtimeMs < 10 * 60 * 1000) {
          kept += 1;
          continue;
        }
        await rm(join(bucketDir, file), { force: true });
        removed += 1;
        bytes += info.size;
      }
      const left = await readdir(bucketDir).catch(() => []);
      if (left.length === 0) await rm(bucketDir, { recursive: true, force: true });
    }
    const missing = [...referenced].filter((hash) => !present.has(hash)).length;
    return { referenced: referenced.size, kept, removed, bytes, missing };
    });
  }

  /**
   * 冷读某个会话的全部事件（不加锁、不激活 Agent）。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<Array<object>|null>} 事件数组，读不到返回 null。
   */
  async readEvents(sessionId) {
    const persistence = typeof this.ctx.get === 'function' ? this.ctx.get('sessionPersistence') : undefined;
    if (persistence === undefined || typeof persistence.open !== 'function') return null;
    let handle;
    try {
      handle = await persistence.open(sessionId, 'read');
      const result = await handle.read(0);
      return Array.isArray(result?.events) ? result.events : [];
    } catch {
      return null;
    } finally {
      try {
        await handle?.close?.();
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 在 $DSH_HOME/sessions 下定位某个会话的日志目录。
   * 不复制后端的分段编码规则，而是按目录名匹配（我们的 id 全是安全字符）。
   *
   * 返回三态而不是 `null`：`absent` 才能安全地当成“日志确实不存在”，
   * `unreadable`（根目录不存在/权限/IO 错误）必须让调用方中止清理。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{state: 'found'|'absent'|'unreadable', dir?: string, reason?: string}>} 定位结果。
   */
  async findSessionDir(sessionId) {
    const root = join(this.config.dshHome, 'sessions');
    let buckets;
    try {
      buckets = await readdir(root, { withFileTypes: true });
    } catch (error) {
      return {
        state: 'unreadable',
        reason: error?.code === 'ENOENT' ? `sessions 目录不存在：${root}` : String(error?.message ?? error),
      };
    }
    let sawError = false;
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const candidate = join(root, bucket.name, sessionId);
      let info;
      try {
        info = await stat(candidate);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        sawError = true;
        continue;
      }
      if (info.isDirectory()) return { state: 'found', dir: candidate };
    }
    return sawError
      ? { state: 'unreadable', reason: '定位会话目录时遇到权限/IO 错误' }
      : { state: 'absent' };
  }

  /**
   * 自愈：把历史「起点」快照的锚点（seq）与说明（label）修正到**真实的用户提问**上。
   *
   * 旧实现留下的痕迹（本机实测）：
   *   - 会话首个快照的说明恒为 null（采集发生在 turn/start，那一刻本轮提问还没到），
   *     列表里显示成「—」，看起来像是"没有对应任何提问"；
   *   - 后续快照的说明是**上一轮**提问，或者被 `runtime-context` 之类的注入消息覆盖
   *     （实测出现过 "Current runtime context. …"）；
   *   - `seq` 可能停在注入消息上，而不是用户真正提问的那一条。
   *
   * 判定不靠猜：按 `turn/start` 切分轮次，取每轮**第一条** `source.kind === 'user'`
   * 的提问作为该轮锚点；只有能明确对上（轮号匹配，或 seq 与某条提问完全相同）才改写。
   * 日志还没刷上来（拿不到该轮提问）时一律跳过，绝不用"上一条提问"顶替。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<object>} 修复报告。
   */
  async repairStartLabels(sessionId) {
    if (this.labelRepaired.has(sessionId)) return { skipped: true, reason: 'cached' };
    const snapshots = await this.store.listSnapshots(sessionId);
    if (snapshots.length === 0) {
      // 还没有快照：不写「已修复」缓存，等这个会话真正有记录后再修。
      return { skipped: true, reason: 'no-snapshot' };
    }
    const events = await this.readEvents(sessionId);
    // 日志读不到（会话已清理 / 尚未落盘）时不缓存：下次打开面板再试。
    if (events === null) return { skipped: true, reason: 'no-log' };

    /** 轮号 -> 该轮第一条真实提问。 */
    const perTurn = new Map();
    /** 提问 seq -> 提问（用于精确匹配）。 */
    const bySeq = new Map();
    let turn = null;
    for (const event of events) {
      if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
        turn = event.data.turn;
        continue;
      }
      if (event.type !== 'user/message' || !isUserQuestion(event.data)) continue;
      const text = messageText(event.data);
      if (text.length === 0) continue;
      const question = { seq: event.seq, label: text.length > 200 ? `${text.slice(0, 200)}…` : text };
      bySeq.set(question.seq, question);
      if (!perTurn.has(turn)) perTurn.set(turn, question);
    }
    if (perTurn.size === 0) {
      // 日志已读到，但里面没有任何「真实提问」：可能是日志还没刷全。
      // 不缓存，下次打开面板再试；否则这条会话的说明/锚点会永久停在旧值。
      return { skipped: true, reason: 'no-question' };
    }
    this.labelRepaired.add(sessionId);

    const repaired = [];
    for (const record of snapshots) {
      if (record.phase !== 'start') continue;
      const question = perTurn.get(record.turn ?? null)
        ?? (Number.isSafeInteger(record.seq) ? bySeq.get(record.seq) : undefined);
      if (question === undefined) continue;
      if (record.seq === question.seq && record.label === question.label) continue;
      const fixed = { ...record, seq: question.seq, label: question.label, labelRepairedAt: Date.now() };
      await this.store.putSnapshot(fixed);
      repaired.push({
        id: record.id,
        turn: record.turn ?? null,
        fromSeq: record.seq ?? null,
        toSeq: question.seq,
        fromLabel: record.label ?? null,
        label: question.label,
      });
    }
    if (repaired.length > 0) {
      this.logger.info(`已修复 ${repaired.length} 条起点快照的提问锚点/说明（会话 ${sessionId}）`);
    }
    return { repaired, count: repaired.length };
  }

  /**
   * 自愈修复"结果快照"的对话锚点。
   *
   * 历史缺陷留下的痕迹：`end` 记录 `seq === null`，且 `forkSeq` 等于**上一轮**结束的边界
   * （也就是和起点快照同一个锚点）。可用的校正依据就在旁边：
   * `start(N+1).forkSeq` 记录的正是"本轮之前最后一次 turn/end 的 seq"，即 `end(N)` 该有的值。
   * @returns {Promise<object>} 修复报告。
   */
  async repairEndAnchors() {
    return this.withStore(async () => {
    const root = join(this.config.root, 'sessions');
    const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
    const repaired = [];
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const dir = join(root, folder.name);
      const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
      const records = [];
      for (const file of files) {
        const record = await readJson(join(dir, file));
        if (record !== null) records.push({ file, record });
      }
      for (let i = 0; i < records.length; i += 1) {
        const { file, record } = records[i];
        if (record.phase !== 'end' || record.seq !== null) continue;
        const next = records[i + 1]?.record;
        if (next === undefined || next.phase !== 'start') continue;
        if (typeof next.forkSeq !== 'number' || next.forkSeq === record.forkSeq) continue;
        const fixed = { ...record, seq: next.forkSeq, forkSeq: next.forkSeq, repairedAt: Date.now() };
        await this.store.putSnapshot(fixed);
        repaired.push({ id: record.id, sessionId: record.sessionId, from: record.forkSeq, to: next.forkSeq, file });
      }
    }
    if (repaired.length > 0) this.logger.info(`已修复 ${repaired.length} 条结果快照的对话锚点`);
    return { repaired, count: repaired.length };
    });
  }

  /**
   * DEV：导出某个会话最近的原始事件（诊断用）。
   * @param {{sessionId: string, tail?: number}} args - 参数。
   * @returns {Promise<object>} 事件摘要。
   */
  async devRawEvents(args) {
    const sessionId = String(args.sessionId ?? '');
    if (sessionId.length === 0) throw new Error('缺少 sessionId');
    const tail = Number.isSafeInteger(args.tail) && args.tail > 0 ? args.tail : 20;
    const events = await this.readEvents(sessionId);
    if (events === null) throw new Error('读不到日志');
    const slice = events.slice(Math.max(0, events.length - tail));
    return {
      sessionId,
      total: events.length,
      events: slice.map((event) => ({
        type: event.type,
        seq: event.seq,
        summary: summarizeEvent(event),
      })),
    };
  }

  /**
   * DEV：直接向某个会话发一条输入（用于验证 prompt 通道，避免重复 fork）。
   * @param {{sessionId: string, text: string}} args - 参数。
   * @returns {Promise<object>} 回执。
   */
  async devPrompt(args) {
    const sessionId = String(args.sessionId ?? '');
    const text = String(args.text ?? '');
    if (sessionId.length === 0 || text.length === 0) throw new Error('缺少 sessionId 或 text');
    const controller = typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined;
    if (typeof controller?.prompt !== 'function') throw new Error('sessionController.prompt 不可用');
    const receipt = await controller.prompt({
      requestId: `snapshot-manager-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal);
    return { accepted: receipt?.accepted === true, receipt };
  }

  /** 释放资源。 */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.listenerDisposers.reverse()) {
      try {
        dispose();
      } catch {
        /* 忽略 */
      }
    }
    this.listenerDisposers = [];
    try {
      this.stopDevChannel?.();
    } catch {
      /* 忽略 */
    }
    this.stopDevChannel = undefined;
    try {
      this.disposeIndexTap?.();
    } catch {
      /* 忽略 */
    }
    this.disposeIndexTap = undefined;
    this.queues.clear();
    this.workspaceQueues.clear();
    this.planTokens.clear();
    this.forkSafety.clear();
    this.baselineQueued.clear();
  }

  /**
   * 状态快照。
   * @returns {object} 自检信息。
   */
  status() {
    return {
      ok: true,
      plugin: `dsh-${PLUGIN_NAME}`,
      version: VERSION,
      started: this.started,
      disposed: this.disposed,
      root: this.config.root,
      pluginDir: this.pluginDir,
      storageError: this.storageError,
      excludes: this.config.excludes.length,
      lastError: this.lastError,
    };
  }
}

/**
 * 安全地读取某条客户端条目的 bundle 路径。
 * @param {object} modules - clientModules 服务。
 * @param {string} id - 条目 id。
 * @returns {string|undefined} 路径或错误说明。
 */
function safeClientPath(modules, id) {
  try {
    return modules.clientPath(id);
  } catch (error) {
    return `解析失败：${String(error?.message ?? error)}`;
  }
}

/**
 * 有界目录列表（开发期辅助）。
 * @param {string} dir - 目录。
 * @param {{maxEntries: number}} options - 上限。
 * @returns {Promise<object>} 条目列表。
 */
async function listDirTree(dir, { maxEntries }) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries.slice(0, maxEntries)) {
    const full = join(dir, entry.name);
    const info = await stat(full).catch(() => undefined);
    out.push({
      name: entry.name,
      dir: entry.isDirectory(),
      size: info?.size ?? null,
      mtime: info?.mtime?.toISOString?.() ?? null,
    });
  }
  return { dir, count: entries.length, entries: out, relativeToPlugin: relative(HERE, dir).split(sep).join('/') };
}

/**
 * 构造 HTTP 路由表。
 *
 * 处理器**不**闭包捕获某一代的服务实例，而是在每次请求时通过 resolveService 取当前的
 * 服务：这样即使因热重载残留了旧代注册的路由，它返回的也仍是活着的状态。
 * @param {() => SnapshotService} resolveService - 取当前服务实例。
 * @param {{info: Function, warn: Function, error: Function}} logger - 日志。
 * @returns {{routes: Array<object>}} 路由集合。
 */
export function createApi(resolveService, logger) {
  const prefix = `/api/${PLUGIN_NAME}/${ROUTE_VERSION}`;
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  /**
   * 把业务错误映射到 HTTP 状态码。尽量让调用方能区分参数错误、找不到、冲突和内部错误，
   * 而不是所有失败都返回 500。
   * @param {unknown} error - 错误。
   * @returns {number} HTTP 状态码。
   */
  const statusFor = (error) => {
    if (Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
    const message = String(error?.message ?? error);
    if (/缺少|不合法|非法|不能同时|不是合法|必须|只能|无法从事件流确认|没有可验证的对话切点/.test(message)) return 400;
    if (/找不到|还没有快照|没有快照|不存在/.test(message)) return 404;
    if (/仍在运行|正在运行|同一工作区|工作区在预览之后|已使用过|已过期|令牌与目标快照不匹配|工作区在预览之后已发生变化/.test(message)) return 409;
    return 500;
  };

  const guard = (label, handler) => async (request) => {
    const service = resolveService();
    try {
      return await handler(service, request);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (service !== undefined && service !== null) {
        service.lastError = { at: Date.now(), route: label, message };
      }
      logger.error(`${label} 失败：${message}`);
      return json({ ok: false, error: message }, statusFor(error));
    }
  };

  /**
   * 读取 JSON 请求体（空体返回 {}）。
   * @param {Request} request - 入站请求。
   * @returns {Promise<object>} 解析结果。
   */
  const readBody = async (request) => {
    let text = '';
    try {
      text = typeof request.text === 'function' ? await request.text() : '';
    } catch {
      return {};
    }
    if (text.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      throw new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`);
    }
  };

  /** 从 URL 取查询参数。 */
  const query = (request, name) => {
    try {
      return new URL(request.url).searchParams.get(name) ?? '';
    } catch {
      return '';
    }
  };

  const ok = (value) => json({ ok: true, ...value });

  return {
    routes: [
      { path: `${prefix}/ping`, methods: ['GET'], fetch: guard('ping', async (service) => ok(service.status())) },

      { path: `${prefix}/status`, methods: ['GET'], fetch: guard('status', async (service) => ok(service.status())) },

      /* ---------------- 快照与回滚 ---------------- */

      {
        path: `${prefix}/snapshots`,
        methods: ['GET'],
        fetch: guard('snapshots', async (service, request) => {
          const sessionId = query(request, 'sessionId');
          if (sessionId.length === 0) return json({ ok: false, error: '缺少 sessionId' }, 400);
          return ok(await service.listSnapshots(sessionId));
        }),
      },

      {
        path: `${prefix}/preview`,
        methods: ['GET'],
        fetch: guard('preview', async (service, request) => ok({
          plan: await service.preview(query(request, 'sessionId'), query(request, 'snapshotId')),
        })),
      },

      {
        path: `${prefix}/ignore`,
        methods: ['GET', 'POST', 'DELETE'],
        fetch: guard('ignore', async (service, request) => {
          if (request.method === 'GET') {
            const sessionId = query(request, 'sessionId');
            if (sessionId.length === 0) return json({ ok: false, error: '缺少 sessionId' }, 400);
            return ok(await service.listManagedIgnore(sessionId));
          }
          const body = await readBody(request);
          const sessionId = String(body.sessionId ?? query(request, 'sessionId') ?? '');
          if (sessionId.length === 0) return json({ ok: false, error: '缺少 sessionId' }, 400);
          const input = { kind: body.kind, value: body.value };
          return ok(request.method === 'DELETE'
            ? await service.removeManagedIgnore(sessionId, input)
            : await service.addManagedIgnore(sessionId, input));
        }),
      },

      {
        path: `${prefix}/restore`,
        methods: ['POST'],
        fetch: guard('restore', async (service, request) => ok({ report: await service.restore(await readBody(request)) })),
      },

      {
        path: `${prefix}/recoveries`,
        methods: ['GET'],
        fetch: guard('recoveries', async (service, request) => ok({
          items: await service.listRecoveries(query(request, 'sessionId')),
        })),
      },

      {
        path: `${prefix}/recover`,
        methods: ['POST'],
        fetch: guard('recover', async (service, request) => {
          const body = await readBody(request);
          const id = String(body.id ?? '');
          const action = body.action === 'revert' ? 'revert' : 'resume';
          if (id.length === 0) return json({ ok: false, error: '缺少事务 id' }, 400);
          return ok({ report: await service.recover(id, action) });
        }),
      },

      {
        path: `${prefix}/capture`,
        methods: ['POST'],
        fetch: guard('capture', async (service, request) => {
          const body = await readBody(request);
          // HTTP 手动快照只接受文档化字段；phase/seq/forkSeq 等内部字段不再从网络透传。
          const input = {
            sessionId: String(body.sessionId ?? ''),
            ...(typeof body.label === 'string' ? { label: body.label } : {}),
          };
          return ok({ record: await service.captureSynthetic(input) });
        }),
      },

      {
        path: `${prefix}/snapshot`,
        methods: ['DELETE', 'POST'],
        fetch: guard('snapshot.delete', async (service, request) => {
          const body = request.method === 'POST' ? await readBody(request) : {};
          const sessionId = query(request, 'sessionId') || String(body.sessionId ?? '');
          const snapshotId = query(request, 'snapshotId') || String(body.snapshotId ?? '');
          if (sessionId.length === 0 || snapshotId.length === 0) {
            return json({ ok: false, error: '缺少 sessionId 或 snapshotId' }, 400);
          }
          return ok(await service.deleteSnapshot(sessionId, snapshotId));
        }),
      },

      {
        path: `${prefix}/pruneSnapshots`,
        methods: ['POST'],
        fetch: guard('pruneSnapshots', async (service) => ok({
          report: await service.pruneSnapshots(),
          indexKeys: await service.normalizeIndexKeys(),
        })),
      },

      {
        path: `${prefix}/gc`,
        methods: ['POST'],
        fetch: guard('gc', async (service) => ok({ report: await service.gcObjects() })),
      },

      {
        path: `${prefix}/beacon`,
        methods: ['POST'],
        fetch: guard('beacon', async (service, request) => {
          const body = await readBody(request);
          service.recordBeacon(body);
          return ok({ received: true });
        }),
      },

      {
        // 自带客户端 bundle 路由：开发期由 index 注入直接加载，不依赖 clientModules 的图行。
        path: `${prefix}/client.js`,
        methods: ['GET'],
        fetch: guard('client.js', async (service) => {
          const { text, rev } = await service.readClientBundle();
          return new Response(text, {
            status: 200,
            headers: {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'no-store',
              'x-snapshot-manager-rev': rev,
            },
          });
        }),
      },
    ],
  };
}

/**
 * 取一个永不抛错的 logger。
 * @param {object} ctx - Host context。
 * @returns {{info: Function, warn: Function, error: Function}} 日志函数集合。
 */
export function safeLogger(ctx) {
  const raw = ctx?.logger;
  const wrap = (level) => (message) => {
    try {
      raw?.[level]?.(`[${PLUGIN_NAME}] ${message}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

/**
 * 挂载 Host 半边。
 * @param {object} ctx - Host context（需注入 connection）。
 * @param {object} [config] - patch 行提供的配置。
 * @param {{current: object|null, generation: number}} [holder] - bootstrap 提供的跨代共享持有者。
 * @returns {() => Promise<void>} 释放函数（供 bootstrap 热重载使用）。
 */
export function apply(ctx, config = {}, holder) {
  const logger = safeLogger(ctx);
  const normalized = config !== null && typeof config === 'object' ? config : {};
  const service = new SnapshotService(ctx, normalized, logger);

  // bootstrap 传入的 holder 与 globalThis 上的共享持有者，优先用后者。
  const shared = sharedHolder();
  const box = holder !== null && typeof holder === 'object' ? holder : shared;
  shared.current = service;
  shared.generation += 1;
  service.generation = shared.generation;
  if (box !== shared) {
    box.current = service;
    box.generation = shared.generation;
  }

  void service.writeBootMarker();
  logger.info(`Host 半边 v${VERSION} 开始挂载`);

  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
  const cleanups = [];
  if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
    logger.warn('connection.fetch 不可用，接口未注册');
  } else {
    // 每次请求都取**全局共享**的当前代服务：不能读 bootstrap 传入的那个 holder——
    // 开发期 bootstrap 会一直持有它自己那份，切换安装方式后旧路由就会永远指向已废弃的一代。
    const resolveService = () => (shared.current ?? service);
    const api = createApi(resolveService, logger);
    for (const route of api.routes) {
      try {
        // register 返回 disposer：必须收集起来，否则热重载时旧代的路由会一直占位。
        const dispose = connection.fetch.register({
          path: route.path,
          methods: route.methods,
          requestBody: 'buffered',
          fetch: route.fetch,
        });
        if (typeof dispose === 'function') cleanups.push(dispose);
      } catch (error) {
        logger.warn(`路由注册失败 ${route.path}: ${String(error?.message ?? error)}`);
      }
    }
  }

  try {
    service.start();
  } catch (error) {
    logger.error(`启动失败：${String(error?.message ?? error)}`);
  }

  try {
    // 客户端 UI 默认走官方通道（package.json 的 dsh.client + exports["./client"]，
    // 由 clientModules 组合进 __DSH_BOOT__.plugins 并实例化）。
    // 自带的 index 注入只是备用手段：两者同时生效会因重复注册而报错，故默认关闭。
    if (normalized.clientInjection === true) {
      const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
      service.installClientInjection(webServer);
    }
  } catch (error) {
    logger.warn(`安装客户端注入失败：${String(error?.message ?? error)}`);
  }

  logger.info(`Host 半边已加载 v${VERSION}`);
  return async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        logger.warn(`清理失败：${String(error?.message ?? error)}`);
      }
    }
    await service.dispose();
    // 只有在自己仍是"当前代"时才清空，避免把后来者的引用清掉。
    if (shared.current === service) shared.current = null;
    if (box !== shared && box.current === service) box.current = null;
  };
}

