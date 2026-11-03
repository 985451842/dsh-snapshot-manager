import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function fixture(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(base, 'workspace');
  const root = join(base, 'store');
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  return { base, cwd, root };
}

test('达到保留上限后，full 记录仍按 checkpointEvery 的节奏产生，而不是每轮全量', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-full-cadence-');
  try {
    const service = new SnapshotService({ get: () => undefined }, {
      root,
      maxSnapshotsPerSession: 4,
      checkpointEvery: 2,
    }, logger);
    const session = { id: 'session-full', header: { cwd } };
    const flags = [];
    for (let i = 0; i < 8; i += 1) {
      await writeFile(join(cwd, `f${i}.txt`), `content-${i}`, 'utf8');
      // 记录 id 的时间段是毫秒级；这里保证每次采集落在不同毫秒，避免同 id 覆盖。
      await sleep(5);
      const result = await service.capture(session, 'manual', { seq: i + 1 });
      flags.push(result.record.full === true);
      const list = await service.store.listSnapshots(session.id);
      assert.ok(list.length <= 4, `保留数不能超过上限，实际 ${list.length}`);
    }

    // 旧实现：一旦 trim 把长度压到 200（此处 4），4 % 2 === 0 恒成立，之后全是 full。
    // 新实现：按「距上一个 full 的非 full 记录数」判定，修剪后仍应交替出现非 full。
    assert.ok(
      flags.slice(-4).some((full) => full === false),
      `修剪饱和后仍然应该有非 full 记录，实际 ${JSON.stringify(flags)}`,
    );
    assert.ok(flags.slice(-4).filter(Boolean).length <= 3, `最后 4 条不应全是 full，实际 ${JSON.stringify(flags)}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('trim 把增量记录提升为 full 基座时保留合并后的 unknown', async () => {
  const { base, cwd } = await fixture('dsh-snapshot-trim-unknown-');
  const root = join(base, 'store');
  try {
    await mkdir(root, { recursive: true });
    const service = new SnapshotService({ get: () => undefined }, { root, maxSnapshotsPerSession: 2 }, logger);
    const sessionId = 'session-promote';
    const baseRecord = {
      v: 2,
      generation: 0,
      sessionId,
      phase: 'start',
      turn: null,
      seq: null,
      forkSeq: null,
      cwd,
      stats: { total: 1, changed: 1 },
      window: { queuedAt: 0, scanStartedAt: 0, finishedAt: 0, risk: [] },
    };
    await service.store.putSnapshot({
      ...baseRecord,
      id: '00000-start-a',
      at: 1,
      parent: null,
      full: true,
      changes: { 'a.txt': 'h1' },
      unknown: { 'big.bin': 'oversized' },
      unknownDirs: ['locked-dir'],
    });
    await service.store.putSnapshot({
      ...baseRecord,
      id: '00001-start-b',
      at: 2,
      parent: '00000-start-a',
      full: false,
      changes: {},
    });
    await service.store.putSnapshot({
      ...baseRecord,
      id: '00002-start-c',
      at: 3,
      parent: '00001-start-b',
      full: false,
      changes: { 'b.txt': 'h2' },
    });

    const trimmed = await service.trim(sessionId);
    assert.equal(trimmed, 1);

    const list = await service.store.listSnapshots(sessionId);
    const promoted = list.find((record) => record.id === '00001-start-b');
    assert.ok(promoted !== undefined);
    assert.equal(promoted.full, true);
    assert.equal(promoted.parent, null);
    assert.deepEqual(promoted.changes, { 'a.txt': 'h1' });
    // 提升前这条记录自己没有 unknown，但它继承来的“当时读不到/超限”的路径必须保留；
    // 丢掉的话，之后回滚会把后来恢复可读的同一路径当作“快照后新建”删掉。
    assert.equal(promoted.unknown?.['big.bin'], 'oversized');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
