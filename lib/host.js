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
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export const VERSION = '0.3.1';

/**
 * 回滚确认令牌有效期。
 * 预览与执行之间留出足够时间让用户看清单，但过期后必须重新预览，
 * 避免一个旧清单在很久以后仍然可以执行。
 */
export const PLAN_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 预览/回滚清单在 HTTP 响应里的展示上限；执行始终使用完整清单。 */
export const PLAN_DISPLAY_LIMIT = 500;

/** 回滚事务日志的根目录名（位于快照根下）。 */
const RESTORE_DIR = 'restore';

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

/** 默认排除的目录名（按路径段精确匹配，大小写不敏感）。 */
export const DEFAULT_EXCLUDES = [
  '.git', '.hg', '.svn', '.idea', '.vscode', '.vs',
  'node_modules', 'bower_components', 'vendor',
  'target', 'build', 'dist', 'out', 'output', 'bin', 'obj',
  '.gradle', '.gradle-user-home', '.next', '.nuxt', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', '.dsh-probe',
];

/** 默认不采集的扩展名（体积大且通常不是源码/配置）。 */
export const DEFAULT_EXCLUDE_EXTENSIONS = [
  '.zip', '.7z', '.rar', '.gz', '.tar', '.jar', '.war', '.class',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.img', '.pdb',
  '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.psd', '.ai', '.sketch',
];

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
    excludes: list(config.excludes, DEFAULT_EXCLUDES),
    excludeExtensions: list(config.excludeExtensions, DEFAULT_EXCLUDE_EXTENSIONS),
    maxSnapshotsPerSession: int(config.maxSnapshotsPerSession, 200),
    /** 每多少个快照写一次全量（full）记录，使链式回溯长度有界。 */
    checkpointEvery: int(config.checkpointEvery, 20),
    maxSessionBytes: int(config.maxSessionBytes, 512 * 1024 * 1024),
    scanTimeoutMs: int(config.scanTimeoutMs, 60 * 1000),
    devChannelDir: typeof config.devChannelDir === 'string' && config.devChannelDir.trim().length > 0
      ? config.devChannelDir.trim()
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
export function startDevChannel({ dir, dispatch, logger, intervalMs = 600 }) {
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

      // 关键去重：热重载会为每一代重新启动本通道，而 cmd.json 里还留着上一条命令。
      // 若不按「结果文件是否已存在」去重，上一条命令（例如 resetStore）会被反复重放。
      if (typeof cmd?.id === 'string' && cmd.id.length > 0) {
        const already = await stat(join(dir, `out-${cmd.id}.json`)).then(() => true).catch(() => false);
        if (already) {
          logger.info(`dev 命令 ${cmd.id}（${String(cmd.op)}）已执行过，跳过重放`);
          return;
        }
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
      if (typeof cmd?.id === 'string' && cmd.id.length > 0) {
        await writeFile(join(dir, `out-${cmd.id}.json`), body, 'utf8');
      }
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
  return shortHash(normalizeWorkspacePath(cwd));
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
 * 早期这里只接受绝对路径，导致模型用 `yefu-admin/...` 这类相对写法时
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
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * 判断路径是否被排除（按路径段匹配，大小写不敏感）。
 * @param {string} relPath - 相对路径（/ 分隔）。
 * @param {Set<string>} excludes - 排除段集合。
 * @param {Set<string>} exts - 排除扩展名集合。
 * @returns {boolean} 是否排除。
 */
export function isExcluded(relPath, excludes, exts) {
  const lower = relPath.toLowerCase();
  const segments = lower.split('/');
  for (const segment of segments) if (excludes.has(segment)) return true;
  const dot = lower.lastIndexOf('.');
  if (dot !== -1 && exts.has(lower.slice(dot))) return true;
  return false;
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
  const out = [];
  for (const rel of candidates) {
    if (context?.trackedDirs?.has(rel)) continue;
    const prefix = `${rel}/`;
    const survivor = allPaths.some((path) => path.startsWith(prefix) && !removedRel.has(path));
    if (survivor) continue;
    out.push(rel);
  }
  return out.sort((a, b) => b.split('/').length - a.split('/').length);
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
 * @returns {Promise<{changes: Record<string, {hash: string|null, size: number|null}>, index: object, stats: object}>} 扫描结果。
 */
export async function scanWorkspace({ cwd, config, previousIndex, expectedHashes = null, signal }) {
  const startedAt = Date.now();
  const excludes = new Set(config.excludes.map((item) => item.toLowerCase()));
  const exts = new Set(config.excludeExtensions.map((item) => item.toLowerCase()));
  const previous = previousIndex?.entries ?? {};
  const expected = expectedHashes ?? null;
  const entries = {};
  const changes = {};
  let skipped = 0;
  let excluded = 0;
  let symlinks = 0;
  let oversized = 0;
  let unreadable = 0;
  let hashed = 0;
  let reused = 0;
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
      continue;
    }
    for (const dirent of dirents) {
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        symlinks += 1;
        skipped += 1;
        if (symlinkSamples.length < 20) symlinkSamples.push(rel);
        continue;
      }
      if (dirent.isDirectory() && dirent.name === '.git') {
        if (vcsDirs.length < 20) vcsDirs.push(rel);
      }
      if (isExcluded(rel, excludes, exts)) {
        excluded += 1;
        skipped += 1;
        if (excludedSamples.length < 20) excludedSamples.push(rel);
        continue;
      }
      if (dirent.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!dirent.isFile()) {
        skipped += 1;
        continue;
      }
      let info;
      try {
        info = await stat(join(cwd, rel));
      } catch {
        unreadable += 1;
        skipped += 1;
        continue;
      }
      if (info.size > config.maxFileBytes) {
        oversized += 1;
        skipped += 1;
        if (oversizedSamples.length < 20) oversizedSamples.push(rel);
        continue;
      }
      const prev = previous[rel];
      const expectedHash = expected === null ? undefined : expected[rel];
      const mayReuse = prev !== undefined
        && prev.size === info.size
        && prev.mtimeMs === Math.floor(info.mtimeMs)
        // 本会话期望的哈希与索引不一致时不能复用：索引可能被同工作区的其他会话推进过。
        && (expectedHash === undefined || expectedHash === prev.hash);
      if (mayReuse) {
        entries[rel] = prev;
        reused += 1;
        continue;
      }
      let hash;
      try {
        hash = await hashFileAt(join(cwd, rel));
      } catch {
        unreadable += 1;
        skipped += 1;
        continue;
      }
      hashed += 1;
      entries[rel] = { size: info.size, mtimeMs: Math.floor(info.mtimeMs), hash };
      if (prev === undefined || prev.hash !== hash) {
        changes[rel] = { hash, size: info.size };
      }
    }
  }

  // 消失的路径记为空值（表示该快照时点该文件不存在）。
  for (const rel of Object.keys(previous)) {
    if (entries[rel] === undefined) changes[rel] = { hash: null, size: null };
  }

  const total = Object.keys(entries).length;
  return {
    changes,
    index: { cwd: normalizeWorkspacePath(cwd), scannedAt: Date.now(), entries },
    stats: {
      total,
      changed: Object.keys(changes).length,
      hashed,
      reused,
      skipped,
      excluded,
      symlinks,
      oversized,
      unreadable,
      vcsDirs,
      samples: { symlinks: symlinkSamples, excluded: excludedSamples, oversized: oversizedSamples },
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
    await writeJson(join(this.root, 'sessions', safeSegment(record.sessionId), `${record.id}.json`), record);
  }

  /**
   * 删除一个快照记录。
   * @param {string} sessionId - 会话 id。
   * @param {string} id - 快照 id。
   * @returns {Promise<void>} 删完后 resolve。
   */
  async deleteSnapshot(sessionId, id) {
    await rm(join(this.root, 'sessions', safeSegment(sessionId), `${id}.json`), { force: true });
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
      return { tree: {}, complete: false, reason: 'missing-target', chain: [] };
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
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      for (const [rel, hash] of Object.entries(chain[i].changes ?? {})) tree[rel] = hash;
    }
    return { tree, complete, reason, chain: chain.map((item) => item.id) };
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
  return createHash('sha1').update(JSON.stringify({ restore, remove, dirs })).digest('hex');
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
 * 指向工作区外的链接，`writeFile(join(cwd, rel))` 就会跟着写出去。这里对目标最近的
 * 已存在祖先做 realpath，再判断是否仍在工作区内；写操作还拒绝目标是符号链接。
 * @param {string} cwd - 工作区根。
 * @returns {Promise<{realCwd: string, check: (target: string, options?: {write?: boolean}) => Promise<{ok: boolean, reason?: string}>}>} 校验器。
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
  const check = async (target, { write = false } = {}) => {
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
      return write ? { ok: false, reason: 'target-is-symlink' } : { ok: true };
    }
    if (leaf.path === target) {
      const realTarget = await realOf(target);
      if (!isWithinReal(realCwd, realTarget)) return { ok: false, reason: 'outside-workspace' };
    }
    return { ok: true };
  };
  return { realCwd, check };
}

/**
 * 把任意 id 变成安全的目录名。
 * @param {string} id - 原始 id。
 * @returns {string} 安全片段。
 */
export function safeSegment(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
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
    /** 回滚计划令牌：一次性、5 分钟过期。 */
    this.planTokens = new Map();
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
    /** 排除规则的小写集合（配置不再变化，构造时算一次）。 */
    this.excludeSet = new Set(this.config.excludes.map((item) => item.toLowerCase()));
    this.excludeExtSet = new Set(this.config.excludeExtensions.map((item) => item.toLowerCase()));
  }

  /**
   * 取（或初始化）某会话的元信息。
   * @param {object} session - Session 对象。
   * @returns {object} 元信息。
   */
  metaFor(session) {
    let meta = this.meta.get(session.id);
    if (meta === undefined) {
      meta = { turn: null, label: null, labelSeq: null, labelTurn: undefined, lastTurnEndSeq: null, snapshots: 0, lastError: null, filesTouched: [], cwd: null, running: null };
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
   * 检测会话当前是否仍在运行。
   *
   * 两个来源：
   *   1. 事件流维护的 `meta.running`（本代插件亲眼看到 turn/start 之后、turn/end 之前）；
   *   2. `sessionController.list()` 的 `running` 字段，用来兜住“插件在轮次中途才挂上”
   *      以及运行中的子代理。
   * 只要有一个来源明确为运行中，就拒绝回滚；无法确认时返回 null，由调用方决定是否放行。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{state: boolean|null, source: 'events'|'list'|'unknown', subagents: string[]}>} 状态。
   */
  async detectRunning(sessionId) {
    const meta = this.meta.get(sessionId);
    const controller = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : undefined;
    if (controller !== null && controller !== undefined && typeof controller.list === 'function') {
      try {
        const result = await controller.list({}, new AbortController().signal);
        const items = Array.isArray(result?.items) ? result.items : [];
        const self = items.find((item) => item?.sessionId === sessionId);
        const subagents = items
          .filter((item) => item?.parentSessionId === sessionId && item?.running === true)
          .map((item) => String(item.sessionId));
        if (self !== undefined && typeof self.running === 'boolean' && meta !== undefined) {
          meta.running = self.running;
        }
        if (self?.running === true || subagents.length > 0) {
          return { state: true, source: 'list', subagents };
        }
        if (self !== undefined && typeof self.running === 'boolean') {
          return { state: false, source: 'list', subagents: [] };
        }
      } catch {
        /* list 不可用/超时：退回到事件流状态 */
      }
    }
    if (meta?.running === true) return { state: true, source: 'events', subagents: [] };
    if (meta?.running === false) return { state: false, source: 'events', subagents: [] };
    return { state: null, source: 'unknown', subagents: [] };
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
    this.journalLoaded.add(session.id);
    let text = '';
    try {
      text = await readFile(this.journalPath(session.id), 'utf8');
    } catch {
      return meta.filesTouched ?? [];
    }
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
    // 上次进程如果在回滚中途退出，事务日志会停在 in-progress。启动时先标成
    // interrupted，让 UI 能弹出恢复入口，而不是把半完成状态当成正常状态。
    void this.markInterruptedTransactions()
      .then((count) => {
        if (count > 0) this.logger.warn(`检测到 ${count} 条中断的回滚事务，等待用户选择恢复方式`);
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
          const meta = this.metaFor(session);
          void this.captureBaselineIfNew(session, { seq: null, forkSeq: meta.lastTurnEndSeq ?? null, turn: turn ?? meta.turn });
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
      this.stopDevChannel = startDevChannel({
        dir: this.config.devChannelDir,
        logger: this.logger,
        dispatch: (cmd) => this.dispatch(cmd),
      });
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
    // 每次事件都刷新真实工作目录：会话可能通过 /cd 或工具改变 cwd，
    // 只在为空时缓存会让手动采集/回滚继续用旧目录。
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
        const rel = relWithinWorkspace(session.header?.cwd, abs);
        if (rel !== null && !isExcluded(rel, this.excludeSet, this.excludeExtSet)) {
          void this.recordTouched(session, rel);
        }
      }
      return;
    }
    if (type === 'turn/start') {
      meta.turn = event.data?.turn ?? meta.turn;
      meta.running = true;
      if (this.config.captureOnTurnStart) {
        this.queueCapture(session, 'start', {
          seq: event.seq,
          // 「重来本轮」的干净切点：本轮之前最后一次 turn/end；首轮则为该事件前一序号。
          forkSeq: meta.lastTurnEndSeq ?? Math.max(0, event.seq - 1),
          turn: meta.turn,
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
      if (this.config.captureOnTurnEnd) {
        void this.captureBaselineIfNew(session, { seq: event.seq, forkSeq: event.seq, turn: event.data?.turn ?? meta.turn });
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
      .then(async () => {
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
      })
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
    const cwd = session?.header?.cwd;
    const next = previous
      .catch(() => undefined)
      // 先按会话串行，再按工作区串行：同一 cwd 的多个会话不能同时扫/写索引。
      .then(() => (typeof cwd === 'string' && cwd.length > 0
        ? this.withWorkspace(cwd, () => this.capture(session, phase, { ...info, queuedAt: Date.now() }))
        : this.capture(session, phase, { ...info, queuedAt: Date.now() })))
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
   * 采集一次快照：扫描工作区 -> 落对象 -> 写快照记录 -> 更新索引 -> 修剪。
   * @param {object} session - Session（需要 header.cwd）。
   * @param {'start'|'end'|'manual'} phase - 阶段。
   * @param {{seq?: number|null, forkSeq?: number|null, turn?: number|null}} info - 位置信息。
   * @returns {Promise<object>} 采集结果。
   */
  async capture(session, phase, info = {}) {
    const cwd = session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('该会话没有工作目录，跳过采集');
    const origin = session?.header?.origin;
    const depth = session?.header?.delegationDepth ?? 0;
    if (origin === 'subagent' || depth > 0) throw new Error('子代理会话不采集');

    const meta = this.metaFor(session);
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
    const { index, stats } = await scanWorkspace({
      cwd,
      config: this.config,
      previousIndex,
      expectedHashes: previousTree,
    });

    const full = last === undefined || previousTree === null || snapshots.length % this.config.checkpointEvery === 0;
    // 统一规范化成 path -> hash|null（null 表示该时点文件不存在），
    // 这样 resolveTree 只需按顺序覆盖即可，全量与增量语义一致。
    let effectiveChanges;
    if (full) {
      effectiveChanges = Object.fromEntries(Object.entries(index.entries).map(([rel, entry]) => [rel, entry.hash]));
    } else {
      effectiveChanges = {};
      for (const [rel, entry] of Object.entries(index.entries)) {
        if (previousTree[rel] !== entry.hash) effectiveChanges[rel] = entry.hash;
      }
      for (const rel of Object.keys(previousTree)) {
        if (!(rel in index.entries) && previousTree[rel] !== null) effectiveChanges[rel] = null;
      }
    }

    // 落对象：本次快照引用到的当前内容必须真的存在于对象库。
    // 顺便用“读到的字节”重新算哈希：扫描与读盘之间文件变了时，以实际内容为准，
    // 避免把新字节存到旧哈希名下（旧实现会静默产生不可校验的对象）。
    let objectsWritten = 0;
    const referenced = full
      ? Object.keys(index.entries).map((rel) => [rel, index.entries[rel].hash])
      : Object.entries(effectiveChanges).filter(([, hash]) => typeof hash === 'string');
    for (const [rel, hash] of referenced) {
      const objectPath = join(this.config.root, 'objects', hash.slice(0, 2), hash);
      const before = await stat(objectPath).catch(() => undefined);
      if (before !== undefined && before.isFile()) continue;
      let bytes;
      try {
        bytes = await readFileWithRetry(join(cwd, rel));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // 扫描之后被删了：按“此刻不存在”记录，避免快照引用一个不存在的对象。
          delete index.entries[rel];
          if (full) delete effectiveChanges[rel];
          else effectiveChanges[rel] = null;
          continue;
        }
        throw new Error(`采集失败：无法读取 ${rel}（${String(error?.message ?? error)}）`);
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
      index.entries[rel] = { ...(index.entries[rel] ?? {}), hash: actual, size: bytes.length };
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
      windowRisk: windowRisk.length,
    };

    const id = `${String(snapshots.length).padStart(5, '0')}-${phase}-${Date.now().toString(36)}`;
    const record = {
      v: 1,
      generation: this.generation,
      id,
      sessionId: session.id,
      phase,
      turn: info.turn ?? meta.turn ?? null,
      seq: info.seq ?? null,
      forkSeq: info.forkSeq ?? null,
      at: Date.now(),
      cwd,
      label: typeof info.label === 'string' && info.label.length > 0 ? info.label : (meta.label ?? null),
      parent: previousTree === null ? null : (last?.id ?? null),
      full,
      changes: effectiveChanges,
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
    return { record: { ...record, changes: undefined, changeCount: Object.keys(effectiveChanges).length }, trimmed };
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
    const workspaceKey = workspaceKeyOf(cwd);
    const previousIndex = await this.store.readIndex(workspaceKey);
    // 期望哈希用目标树：全局索引与本快照不一致时强制重新哈希，避免别的会话
    // 推进索引后把当前内容误当成“目标状态”。
    const { index, stats } = await scanWorkspace({
      cwd,
      config: this.config,
      previousIndex,
      expectedHashes: tree,
    });
    const current = index.entries;

    const restore = [];
    const remove = [];
    let unchanged = 0;
    const tracked = new Set(Object.keys(tree));
    for (const [rel, targetHash] of Object.entries(tree)) {
      const currentHash = current[rel]?.hash ?? null;
      if (targetHash === null) {
        if (currentHash === null) unchanged += 1;
        else remove.push({ rel, action: 'snapshot-absent', size: current[rel]?.size ?? null });
        continue;
      }
      if (currentHash === targetHash) {
        unchanged += 1;
        continue;
      }
      restore.push({
        rel,
        action: currentHash === null ? 'recreate' : 'overwrite',
        size: targetHash === null ? null : (index.entries[rel]?.size ?? null),
        hash: targetHash,
      });
    }
    // 当前索引里有、但目标快照从未跟踪过的路径 = 快照之后新建的文件。
    for (const [rel, entry] of Object.entries(current)) {
      if (tracked.has(rel)) continue;
      remove.push({ rel, action: 'created-after', size: entry.size ?? null });
    }
    // 该快照时点确实存在的目录（由"当时存在"的跟踪文件路径推导），用于判定哪些目录是后来新建的。
    const trackedDirs = new Set();
    for (const [rel, hash] of Object.entries(tree)) {
      if (typeof hash !== 'string') continue;
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i += 1) trackedDirs.add(parts.slice(0, i).join('/'));
    }
    const dirContext = { current, trackedDirs };

    // 「本会话修改过的文件」范围：只保留本会话自己写过的路径（write/edit 记录）。
    // 这是可选的收窄范围，默认不启用 —— 它抓不到经 shell/构建/子代理产生的改动，
    // 因此绝不能替代全量，只用于「只想撤掉这次对话干的事」。
    // 必须先水合：日志是异步读的，否则插件重载后这里会读到空集合。
    const touched = await this.loadJournal({ id: sessionId, header: { cwd } });
    const sessionFiles = new Set(touched);
    const sessionRestore = restore.filter((item) => sessionFiles.has(item.rel));
    const sessionRemove = remove.filter((item) => sessionFiles.has(item.rel));
    // 两种范围各自要收掉的空目录（同一个算法、同一份扫描结果，只是清单不同）。
    const pruneDirs = pruneDirsFor(dirContext, remove);
    const sessionPruneDirs = pruneDirsFor(dirContext, sessionRemove);

    const controller = typeof this.ctx.get === 'function' ? this.ctx.get('sessionController') : undefined;
    const forkAvailable = controller !== undefined && controller !== null && typeof controller.fork === 'function';
    const runningInfo = await this.detectRunning(sessionId);
    const sessionCwd = this.meta.get(sessionId)?.cwd;
    const warnings = [];
    if (runningInfo.state === true) warnings.push(this.runningError(runningInfo));
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
      vcsDirs: Array.isArray(stats.vcsDirs) ? stats.vcsDirs : [],
      samples: stats.samples ?? {},
    };
    const untrackedTotal = untracked.symlinks + untracked.excluded + untracked.oversized + untracked.unreadable;
    if (untrackedTotal > 0) {
      warnings.push(`另有 ${untrackedTotal} 个路径未纳入快照（排除/符号链接/超大/不可读）；回滚不会处理它们，可能留下未回滚内容`);
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
        scanned: stats.total,
        // 回滚时会被一并收掉的目录数（快照时点不存在、删完文件后变空）。
        dirsRemove: pruneDirs.length,
      },
      // 完整清单：执行阶段用这一份，HTTP 响应再用 displayPlan 截断展示。
      restore,
      remove,
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
          unchanged: [...sessionFiles].filter((rel) => {
            const entry = current[rel];
            if (entry === undefined) return false;
            const targetHash = Object.prototype.hasOwnProperty.call(tree, rel) ? tree[rel] : undefined;
            return typeof targetHash === 'string' && entry.hash === targetHash;
          }).length,
        },
        restore: sessionRestore,
        remove: sessionRemove,
        pruneDirs: sessionPruneDirs,
        available: sessionRestore.length + sessionRemove.length > 0,
      },
      /** 对话回退计划：回退后新会话将包含到 forkSeq 为止的历史。 */
      conversation: {
        available: forkAvailable,
        sourceSessionId: sessionId,
        atSeq: Number.isSafeInteger(record.forkSeq) ? record.forkSeq : null,
        note: Number.isSafeInteger(record.forkSeq)
          ? `新会话将保留到事件 #${record.forkSeq} 为止的历史（即本次提问之前），本次提问及其后的对话不再进入新会话（原会话完整保留）`
          : '该快照没有记录可用的切点，将按源会话当前末尾 fork',
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
      // 展示不需要完整目录清单；执行阶段用的是 buildPlan 的完整 pruneDirs。
      pruneDirs: plan.pruneDirs.slice(0, 200),
      truncated: plan.restore.length > limit || plan.remove.length > limit,
      sessionScope: {
        ...plan.sessionScope,
        restore: plan.sessionScope.restore.slice(0, limit),
        remove: plan.sessionScope.remove.slice(0, limit),
        pruneDirs: plan.sessionScope.pruneDirs.slice(0, 200),
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
    return this.withWorkspace(targetInfo.cwd, async () => {
      const plan = await this.buildPlan(sessionId, snapshotId);
      const planToken = this.issuePlanToken(plan);
      return { ...this.displayPlan(plan), planToken };
    });
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
    const targetInfo = await this.resolvePlanTarget(sessionId, request.snapshotId);
    return this.withWorkspace(targetInfo.cwd, () => this.restoreLocked({ ...request, sessionId }, targetInfo.cwd));
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
    if (!doFiles && !doConversation) throw new Error('files 与 conversation 不能同时为否');
    // 文件恢复范围：默认全量；只有显式 'session' 才收窄。
    const scope = request.scope === 'session' ? 'session' : 'all';

    if (request.dryRun === true) {
      const planToken = this.issuePlanToken(plan);
      return { dryRun: true, plan: { ...this.displayPlan(plan), planToken } };
    }

    // 运行中的会话直接拒绝回滚：文件恢复会和当前轮的工具写入互相踩。
    // 这里用“事件流 + sessionController.list”双重检测；即使面板已经打开，
    // 服务端也会在真正执行前再拦一次。
    const runningNow = await this.detectRunning(sessionId);
    if (runningNow.state === true) throw new Error(this.runningError(runningNow));

    const actualHashes = {
      all: planHashFor(plan, 'all'),
      session: planHashFor(plan, 'session'),
    };
    this.consumePlanToken(request.planToken, {
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
        const atSeq = Number.isSafeInteger(plan.forkSeq) ? plan.forkSeq : undefined;
        try {
          const fork = await controller.fork(atSeq === undefined ? { sessionId } : { sessionId, atSeq });
          const childSessionId = fork?.sessionId ?? null;
          report.conversation = { childSessionId, atSeq: atSeq ?? null };
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
      ? { restore: plan.sessionScope.restore, remove: plan.sessionScope.remove, pruneDirs: plan.sessionScope.pruneDirs ?? [] }
      : { restore: plan.restore, remove: plan.remove, pruneDirs: plan.pruneDirs ?? [] };
    const guard = await createRealGuard(plan.cwd);
    const restored = [];
    const removed = [];
    const failed = [];
    const escaped = [];
    const dirsRemoved = [];
    for (const item of filePlan.restore) {
      assertNotRunning();
      const abs = resolve(join(plan.cwd, item.rel));
      if (relWithinWorkspace(plan.cwd, abs) === null) {
        escaped.push({ rel: item.rel, reason: 'lexical-escape' });
        failed.push({ rel: item.rel, action: item.action, error: '路径越出工作区，已跳过' });
        continue;
      }
      const check = await guard.check(abs, { write: true });
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
    for (const item of filePlan.remove) {
      assertNotRunning();
      const abs = resolve(join(plan.cwd, item.rel));
      if (relWithinWorkspace(plan.cwd, abs) === null) {
        escaped.push({ rel: item.rel, reason: 'lexical-escape' });
        failed.push({ rel: item.rel, action: item.action, error: '路径越出工作区，已跳过' });
        continue;
      }
      const check = await guard.check(abs, { write: false });
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
      const check = await guard.check(abs, { write: false });
      if (!check.ok) continue;
      try {
        await rmdir(abs);
        dirsRemoved.push(rel);
      } catch {
        /* 非空 / 已被删掉 / 被占用：保留原样，不视为失败 */
      }
    }
    return {
      restored: restored.length,
      removed: removed.length,
      failed: failed.length,
      dirsRemoved: dirsRemoved.length,
      escapedCount: escaped.length,
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
    return this.withWorkspace(tx.cwd, async () => {
      const plan = await this.buildPlan(tx.sessionId, target);
      const runningNow = await this.detectRunning(tx.sessionId);
      if (runningNow.state === true) throw new Error(this.runningError(runningNow));
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
      };
      await this.writeRestoreTx(tx);
      return { transactionId: tx.id, action, targetSnapshotId: target, files };
    });
  }

  /**
   * 记下某会话真实的工作目录（来自 DSH 给的 Session.header）。
   * 手动打快照只有 sessionId、没有 cwd，这里缓存一份作为可靠来源。
   * @param {object} session - Session。
   * @returns {string|null} 归一化后的 cwd。
   */
  recordSessionCwd(session) {
    const raw = session?.header?.cwd;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const meta = this.metaFor(session);
    meta.cwd = normalizeWorkspacePath(raw);
    return meta.cwd;
  }

  /**
   * 解析某会话的工作目录，供只有 sessionId 的调用方（手动打快照 / 预览 / 回滚）使用。
   *
   * 顺序：① 缓存（采集过或见过事件）→ ② sessionController.inspect() 读持久化 header
   * （不会激活 Agent）→ ③ 报错。第三个分支给出可操作的中文提示，而不是让用户看到
   * 底层那句「该会话没有工作目录，跳过采集」。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<string>} 归一化后的 cwd。
   */
  async resolveSessionCwd(sessionId) {
    const meta = this.meta.get(sessionId);
    if (typeof meta?.cwd === 'string' && meta.cwd.length > 0) return meta.cwd;

    const controller = typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : undefined;
    if (controller !== null && controller !== undefined && typeof controller.inspect === 'function') {
      try {
        const inspection = await controller.inspect(sessionId);
        const raw = inspection?.meta?.cwd;
        if (typeof raw === 'string' && raw.length > 0) {
          const resolved = normalizeWorkspacePath(raw);
          // 只能在没有已知 cwd 时落缓存：若会话被迁移到别处，以实时事件为准。
          if (this.meta.get(sessionId) === meta || meta === undefined) {
            this.metaFor({ id: sessionId }).cwd = resolved;
          }
          return resolved;
        }
      } catch {
        /* 读不到就落到下面的报错 */
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
    const phase = typeof input.phase === 'string' && input.phase.length > 0 ? input.phase : 'manual';
    if (typeof input.label === 'string') meta.label = input.label;
    return this.withWorkspace(cwd, () => this.capture(session, phase, {
      seq: Number.isSafeInteger(input.seq) ? input.seq : null,
      forkSeq: Number.isSafeInteger(input.forkSeq) ? input.forkSeq : null,
      turn: Number.isSafeInteger(input.turn) ? input.turn : null,
      queuedAt: Date.now(),
      rollbackOf: typeof input.rollbackOf === 'string' ? input.rollbackOf : null,
    }));
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
        changeCount: Object.keys(record.changes ?? {}).length,
        stats: record.stats,
        windowRisk: Array.isArray(record.window?.risk) ? record.window.risk.length : 0,
        rollbackOf: record.rollbackOf ?? null,
        chainRepaired: record.chainRepaired === true,
        promotedAt: record.promotedAt ?? null,
      })),
    };
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
    store.push({
      at: Date.now(),
      generation: this.generation,
      phase: typeof body?.phase === 'string' ? body.phase : 'unknown',
      rev: typeof body?.rev === 'string' ? body.rev : null,
      error: typeof body?.error === 'string' ? body.error.slice(0, 800) : null,
      detail: body?.detail ?? null,
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
  }

  /**
   * 清理孤立快照：会话日志已不存在的快照目录。
   * @returns {Promise<object>} 清理报告。
   */
  async pruneSnapshots() {
    const dir = join(this.config.root, 'sessions');
    const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const removed = [];
    const kept = [];
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const files = await readdir(join(dir, folder.name)).catch(() => []);
      const first = files.find((name) => name.endsWith('.json'));
      const record = first === undefined ? null : await readJson(join(dir, folder.name, first));
      const sessionId = String(record?.sessionId ?? folder.name);
      const logDir = await this.findSessionDir(sessionId);
      if (logDir === null) {
        await rm(join(dir, folder.name), { recursive: true, force: true });
        removed.push({ sessionId, records: files.length });
      } else {
        kept.push(sessionId);
      }
    }
    return { removed, kept: kept.length, scanned: folders.length };
  }

  /**
   * 回收没有任何快照记录引用的内容对象。
   * @returns {Promise<object>} 回收报告。
   */
  async gcObjects() {
    const sessionsRoot = join(this.config.root, 'sessions');
    const referenced = new Set();
    for (const folder of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!folder.isDirectory()) continue;
      for (const file of await readdir(join(sessionsRoot, folder.name)).catch(() => [])) {
        if (!file.endsWith('.json')) continue;
        const record = await readJson(join(sessionsRoot, folder.name, file));
        for (const hash of Object.values(record?.changes ?? {})) {
          if (typeof hash === 'string' && hash.length > 0) referenced.add(hash);
        }
      }
    }
    const objectsRoot = join(this.config.root, 'objects');
    let removed = 0;
    let bytes = 0;
    let kept = 0;
    for (const bucket of await readdir(objectsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = join(objectsRoot, bucket.name);
      for (const file of await readdir(bucketDir).catch(() => [])) {
        if (referenced.has(file)) {
          kept += 1;
          continue;
        }
        const info = await stat(join(bucketDir, file)).catch(() => undefined);
        await rm(join(bucketDir, file), { force: true });
        removed += 1;
        bytes += info?.size ?? 0;
      }
      const left = await readdir(bucketDir).catch(() => []);
      if (left.length === 0) await rm(bucketDir, { recursive: true, force: true });
    }
    return { referenced: referenced.size, kept, removed, bytes };
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
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<string|null>} 目录绝对路径或 null。
   */
  async findSessionDir(sessionId) {
    const root = join(this.config.dshHome, 'sessions');
    const buckets = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const candidate = join(root, bucket.name, sessionId);
      const exists = await stat(candidate).then((info) => info.isDirectory()).catch(() => false);
      if (exists) return candidate;
    }
    return null;
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
      this.labelRepaired.add(sessionId);
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
    this.labelRepaired.add(sessionId);
    if (perTurn.size === 0) return { skipped: true, reason: 'no-question' };

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
      return json({ ok: false, error: message }, 500);
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
        fetch: guard('snapshots', async (service, request) => ok(await service.listSnapshots(query(request, 'sessionId')))),
      },

      {
        path: `${prefix}/preview`,
        methods: ['GET'],
        fetch: guard('preview', async (service, request) => ok({
          plan: await service.preview(query(request, 'sessionId'), query(request, 'snapshotId')),
        })),
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
        fetch: guard('capture', async (service, request) => ok({ record: await service.captureSynthetic(await readBody(request)) })),
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

