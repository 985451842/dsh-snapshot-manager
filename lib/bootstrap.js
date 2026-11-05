/**
 * 开发模式入口（install.ps1 -DevFromWorkspace 使用）。
 *
 * 发布模式直接把 `lib/host.js` 作为入口；开发模式需要在不重启宿主的情况下
 * 重新求值 Host 实现，因此这里按 `host.js` 内容哈希带 query 动态 import。
 * 跨代共享 holder 放在 globalThis 上，和 host.js 内的 `sharedHolder()` 同一把。
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLDER_KEY = '__dshSnapshotManagerHolder__';

const holder = globalThis[HOLDER_KEY] ?? { current: null, generation: 0, beacons: [] };
globalThis[HOLDER_KEY] = holder;

/** 与 host.js 的 Loader 依赖保持一致。 */
export const inject = ['connection'];

/**
 * 按内容哈希加载当前 Host 实现并挂载。
 * @param {object} ctx - Host context。
 * @param {object} [config] - patch 行配置。
 * @returns {Promise<(() => Promise<void>) | undefined>} host.js 返回的清理函数。
 */
export async function apply(ctx, config = {}) {
  const bytes = await readFile(join(HERE, 'host.js'));
  const rev = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
  const module = await import(new URL(`./host.js?rev=${rev}`, import.meta.url));
  return module.apply(ctx, config, holder);
}
