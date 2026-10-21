import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

/** 取一个临时工作区与独立的快照根。 */
async function fixture(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(base, 'workspace');
  const root = join(base, 'store');
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  return { base, cwd, root };
}

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test('回滚使用完整清单执行恢复/删除/重建，并且令牌只能用一次', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-restore-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-restore', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    await writeFile(join(cwd, 'c.txt'), 'keep', 'utf8');
    const capture = await service.capture(session, 'manual', {});

    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');
    await writeFile(join(cwd, 'b.txt'), 'new', 'utf8');
    await rm(join(cwd, 'c.txt'));

    const preview = await service.preview(session.id, capture.record.id);
    assert.equal(preview.counts.restore, 2);
    assert.equal(preview.counts.remove, 1);
    assert.equal(typeof preview.planToken, 'string');
    assert.ok(preview.planToken.length > 10);

    const report = await service.restore({
      sessionId: session.id,
      snapshotId: capture.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one');
    assert.equal(await readFile(join(cwd, 'c.txt'), 'utf8'), 'keep');
    assert.equal(await missing(join(cwd, 'b.txt')), true);
    assert.equal(typeof report.recoveryPoint, 'string');

    await assert.rejects(
      service.restore({
        sessionId: session.id,
        snapshotId: capture.record.id,
        files: true,
        conversation: false,
        planToken: preview.planToken,
      }),
      /已使用过/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('预览后工作区变化会导致令牌校验失败，而不是执行旧清单', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-token-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-token', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const capture = await service.capture(session, 'manual', {});
    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');

    const preview = await service.preview(session.id, capture.record.id);
    // 预览之后又有改动：新增一个“快照之后创建”的文件，删除清单变化，令牌必须失效。
    await writeFile(join(cwd, 'a.txt'), 'three', 'utf8');
    await writeFile(join(cwd, 'late.txt'), 'late', 'utf8');

    await assert.rejects(
      service.restore({
        sessionId: session.id,
        snapshotId: capture.record.id,
        files: true,
        conversation: false,
        planToken: preview.planToken,
      }),
      /工作区在预览之后已发生变化/,
    );
    // 被拒绝时不应改动工作区：late.txt 仍在，a.txt 也仍是 three。
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'three');
    assert.equal(await readFile(join(cwd, 'late.txt'), 'utf8'), 'late');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('跨会话共享工作区时，增量快照仍然相对本会话上一条快照', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-cross-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const a = { id: 'session-a', header: { cwd } };
    const b = { id: 'session-b', header: { cwd } };
    await writeFile(join(cwd, 'base.txt'), 'base', 'utf8');
    const a1 = await service.capture(a, 'manual', {});

    await writeFile(join(cwd, 'b.txt'), 'from-b', 'utf8');
    await service.capture(b, 'manual', {});

    await writeFile(join(cwd, 'c.txt'), 'from-a', 'utf8');
    const a2 = await service.capture(a, 'manual', {});

    const snapshots = await service.store.listSnapshots(a.id);
    const info = service.store.resolveTreeInfo(snapshots, a2.record.id);
    assert.equal(info.complete, true);
    assert.ok(Object.prototype.hasOwnProperty.call(info.tree, 'b.txt'), 'A2 必须包含 B 改过的 b.txt');
    assert.ok(Object.prototype.hasOwnProperty.call(info.tree, 'c.txt'));
    assert.ok(Object.prototype.hasOwnProperty.call(info.tree, 'base.txt'));

    // A1 仍然是完整基座，不受 B 的索引推进影响。
    const first = service.store.resolveTreeInfo(snapshots, a1.record.id);
    assert.equal(first.complete, true);
    assert.deepEqual(Object.keys(first.tree), ['base.txt']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('展示上限 500 条不会截断实际执行清单', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-limit-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-limit', header: { cwd } };
    const total = 505;
    for (let i = 0; i < total; i += 1) {
      await writeFile(join(cwd, `f${String(i).padStart(3, '0')}.txt`), `v${i}`, 'utf8');
    }
    const capture = await service.capture(session, 'manual', {});
    for (let i = 0; i < total; i += 1) {
      await rm(join(cwd, `f${String(i).padStart(3, '0')}.txt`), { force: true });
    }

    const preview = await service.preview(session.id, capture.record.id);
    assert.equal(preview.counts.restore, total);
    assert.equal(preview.restore.length, 500);
    assert.equal(preview.truncated, true);

    const report = await service.restore({
      sessionId: session.id,
      snapshotId: capture.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.restored, total);
    for (let i = 0; i < total; i += 1) {
      assert.equal(await readFile(join(cwd, `f${String(i).padStart(3, '0')}.txt`), 'utf8'), `v${i}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('检测到残缺链时，下一次采集会重建 full 基座', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-repair-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-repair', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
    await service.store.putSnapshot({
      id: '00000-start-broken',
      sessionId: session.id,
      phase: 'start',
      parent: 'missing-parent',
      full: false,
      changes: { 'ghost.txt': 'h' },
      at: 1,
      cwd,
    });

    const capture = await service.capture(session, 'manual', {});
    assert.equal(capture.record.full, true);
    const snapshots = await service.store.listSnapshots(session.id);
    const latest = snapshots.find((item) => item.id === capture.record.id);
    assert.equal(latest.parent, null);
    assert.equal(latest.chainRepaired, true);
    const info = service.store.resolveTreeInfo(snapshots, latest.id);
    assert.equal(info.complete, true);
    assert.ok(Object.prototype.hasOwnProperty.call(info.tree, 'a.txt'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('中断的回滚事务可以继续还原目标快照', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-recover-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-recover', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const capture = await service.capture(session, 'manual', {});
    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');

    const tx = {
      id: 'tx-interrupted',
      sessionId: session.id,
      snapshotId: capture.record.id,
      preRollbackId: null,
      scope: 'all',
      status: 'interrupted',
      startedAt: Date.now(),
      cwd,
      files: true,
      conversation: false,
      plan: { restore: 1, remove: 0, dirs: 0 },
    };
    await service.writeRestoreTx(tx);
    const pending = await service.listRecoveries(session.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'tx-interrupted');

    const result = await service.recover('tx-interrupted', 'resume');
    assert.equal(result.files.failed, 0);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one');
    const after = await service.readRestoreTx('tx-interrupted');
    assert.equal(after.status, 'recovered');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('符号链接/目录链接指向工作区外时，回滚拒绝写出去', async (t) => {
  const { base, cwd, root } = await fixture('dsh-snapshot-link-');
  try {
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await mkdir(join(cwd, 'sub'), { recursive: true });
    await writeFile(join(cwd, 'sub', 'a.txt'), 'inside', 'utf8');
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-link', header: { cwd } };
    const capture = await service.capture(session, 'manual', {});

    // 删掉真实目录，换成指向工作区外的目录链接；目标路径下仍有同名文件。
    await rm(join(cwd, 'sub'), { recursive: true, force: true });
    await writeFile(join(outside, 'a.txt'), 'outside-original', 'utf8');
    try {
      await symlink(outside, join(cwd, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`当前环境无法创建目录链接：${String(error?.code ?? error)}`);
      return;
    }

    const preview = await service.preview(session.id, capture.record.id);
    const report = await service.restore({
      sessionId: session.id,
      snapshotId: capture.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.ok(report.files.failed > 0, '越界链接必须被拒绝，而不是写穿');
    assert.equal(await readFile(join(outside, 'a.txt'), 'utf8'), 'outside-original');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
