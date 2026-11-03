import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

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

test('受跟踪文件在采集时超限，不会被后续回滚当成不存在而删除', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-unknown-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root, maxFileBytes: 4 }, logger);
    const session = { id: 'session-unknown', header: { cwd } };
    const file = join(cwd, 'big.txt');

    await writeFile(file, 'ok', 'utf8');
    const first = await service.capture(session, 'manual', {});
    const listed = await service.listSnapshots(session.id);
    assert.equal(listed.count, 1);
    assert.equal(listed.items[0].id, first.record.id);

    // 采集时超过 maxFileBytes：不能写成 null（那表示“当时不存在”）。
    await writeFile(file, '0123456789', 'utf8');
    const grown = await service.capture(session, 'manual', {});
    const record = (await service.store.listSnapshots(session.id)).find((item) => item.id === grown.record.id);
    assert.equal(record.unknown?.['big.txt'], 'oversized');
    assert.equal(Object.prototype.hasOwnProperty.call(record.changes, 'big.txt'), false);

    await writeFile(file, 'ok', 'utf8');
    const preview = await service.preview(session.id, grown.record.id);
    assert.equal(preview.remove.some((item) => item.rel === 'big.txt'), false);
    assert.ok(preview.unknown.some((item) => item.rel === 'big.txt'));

    const report = await service.restore({
      sessionId: session.id,
      snapshotId: grown.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.removed, 0);
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(file, 'utf8'), 'ok');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('快照时未纳入的文件，后来可扫描也不会被当成快照后新建而删除', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-unknown-new-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root, maxFileBytes: 4 }, logger);
    const session = { id: 'session-unknown-new', header: { cwd } };
    const file = join(cwd, 'grow.txt');

    // 采集时文件超大：未跟踪，但确实存在；必须记成 unknown。
    await writeFile(file, '0123456789', 'utf8');
    const first = await service.capture(session, 'manual', {});
    const record = (await service.store.listSnapshots(session.id)).find((item) => item.id === first.record.id);
    assert.equal(record.unknown?.['grow.txt'], 'oversized');

    await writeFile(file, 'ok', 'utf8');
    const preview = await service.preview(session.id, first.record.id);
    assert.equal(preview.remove.some((item) => item.rel === 'grow.txt'), false);
    assert.ok(preview.unknown.some((item) => item.rel === 'grow.txt'));

    const report = await service.restore({
      sessionId: session.id,
      snapshotId: first.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.removed, 0);
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(file, 'utf8'), 'ok');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('文件/目录类型冲突时先删除占位文件，再恢复目标文件', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-type-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-type', header: { cwd } };
    await mkdir(join(cwd, 'a'), { recursive: true });
    await writeFile(join(cwd, 'a', 'b.txt'), 'original', 'utf8');
    const capture = await service.capture(session, 'manual', {});

    // 目录 a 被替换成同名文件：恢复 a/b.txt 前必须先删掉 a。
    await rm(join(cwd, 'a'), { recursive: true, force: true });
    await writeFile(join(cwd, 'a'), 'conflict', 'utf8');

    const preview = await service.preview(session.id, capture.record.id);
    assert.ok(preview.restore.some((item) => item.rel === 'a/b.txt'));
    assert.ok(preview.remove.some((item) => item.rel === 'a'));

    const report = await service.restore({
      sessionId: session.id,
      snapshotId: capture.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(join(cwd, 'a', 'b.txt'), 'utf8'), 'original');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('对象缺失时在改动工作区前拒绝回滚', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-missing-object-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-missing-object', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const capture = await service.capture(session, 'manual', {});
    const record = (await service.store.listSnapshots(session.id)).find((item) => item.id === capture.record.id);
    const hash = record.changes['a.txt'];
    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');
    await writeFile(join(cwd, 'b.txt'), 'created after', 'utf8');
    // 模拟历史 GC/磁盘损坏：删除计划要写的内容对象。
    await rm(join(root, 'objects', hash.slice(0, 2), hash));

    const preview = await service.preview(session.id, capture.record.id);
    assert.ok(preview.counts.missingObjects > 0);
    assert.ok(preview.warnings.some((text) => text.includes('对象库缺少')));

    await assert.rejects(
      service.restore({
        sessionId: session.id,
        snapshotId: capture.record.id,
        files: true,
        conversation: false,
        planToken: preview.planToken,
      }),
      /快照对象缺失/,
    );
    // 预检必须在删除 b.txt 之前失败。
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'two');
    assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'created after');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('旧 v1 快照出现过跳过项时，不把当前多出的文件当成快照后新建', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-legacy-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-legacy', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const capture = await service.capture(session, 'manual', {});
    const record = (await service.store.listSnapshots(session.id)).find((item) => item.id === capture.record.id);
    // 模拟 0.3.1 的记录：v1，且统计里出现过符号链接/超大/不可读。
    await service.store.putSnapshot({ ...record, v: 1, stats: { ...record.stats, symlinks: 1 } });
    await writeFile(join(cwd, 'b.txt'), 'created after', 'utf8');

    const preview = await service.preview(session.id, record.id);
    assert.equal(preview.remove.some((item) => item.rel === 'b.txt'), false);
    assert.ok(preview.unknown.some((item) => item.rel === 'b.txt' && item.reason === 'legacy-unknown'));
    assert.ok(preview.warnings.some((text) => text.includes('0.3.1')));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GC 遇到无法解析的快照记录时跳过，不删除其对象', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-gc-corrupt-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-gc', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const capture = await service.capture(session, 'manual', {});
    const record = (await service.store.listSnapshots(session.id)).find((item) => item.id === capture.record.id);
    const hash = record.changes['a.txt'];
    const objectPath = join(root, 'objects', hash.slice(0, 2), hash);
    await writeFile(join(root, 'sessions', session.id, 'corrupt.json'), '{not json', 'utf8');

    const first = await service.gcObjects();
    assert.equal(first.skipped, true);
    assert.equal(first.corrupt, 1);
    assert.equal(await missing(objectPath), false);

    await rm(join(root, 'sessions', session.id, 'corrupt.json'));
    const second = await service.gcObjects();
    assert.equal(second.skipped, undefined);
    assert.equal(second.removed, 0);
    assert.equal(await missing(objectPath), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Windows 仅大小写重命名不会被同时恢复和删除', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅 Windows 大小写不敏感文件系统需要此回归');
    return;
  }
  const { base, cwd, root } = await fixture('dsh-snapshot-case-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-case', header: { cwd } };
    await writeFile(join(cwd, 'Foo.txt'), 'original', 'utf8');
    const capture = await service.capture(session, 'manual', {});

    // 仅改大小写；Windows 上 foo.txt 与 Foo.txt 是同一个文件。
    await rename(join(cwd, 'Foo.txt'), join(cwd, 'foo.txt'));
    await writeFile(join(cwd, 'foo.txt'), 'changed', 'utf8');

    const preview = await service.preview(session.id, capture.record.id);
    assert.equal(preview.remove.some((item) => item.rel.toLowerCase() === 'foo.txt'), false);
    assert.ok(preview.restore.some((item) => item.rel.toLowerCase() === 'foo.txt'));

    const report = await service.restore({
      sessionId: session.id,
      snapshotId: capture.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.removed, 0);
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(join(cwd, 'foo.txt'), 'utf8'), 'original');
    assert.equal(await missing(join(cwd, 'foo.txt')), false);
    // 目录里只剩同一个文件，不应被删成空目录。
    assert.equal((await readdir(cwd)).length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
