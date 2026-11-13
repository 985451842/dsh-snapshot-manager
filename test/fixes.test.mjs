import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService, relWithinWorkspace, createApi, startDevChannel } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

async function fixture(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(base, 'workspace');
  const root = join(base, 'store');
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  return { base, cwd, root };
}

function controller(extra = {}) {
  return {
    async list() { return { items: [] }; },
    async fork() { return { sessionId: 'child' }; },
    async prompt() { return { accepted: true }; },
    ...extra,
  };
}

function eventsForBoundary() {
  return [
    { seq: 0, type: 'permission/preset', data: { preset: 'x' } },
    { seq: 1, type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { seq: 2, type: 'approval/policy', data: { policy: 'ask' } },
    { seq: 3, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'm1', content: [{ type: 'text', text: '原提问' }], source: { kind: 'user' } }] } },
    { seq: 4, type: 'turn/start', data: { turn: 1 } },
    { seq: 5, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 6, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: '原提问' }], source: { kind: 'user' } } },
  ];
}

test('relWithinWorkspace 允许以 .. 开头的合法文件名', async () => {
  const { base, cwd } = await fixture('dsh-fix-rel-');
  try {
    assert.equal(relWithinWorkspace(cwd, join(cwd, '..config')), '..config');
    assert.equal(relWithinWorkspace(cwd, join(cwd, 'sub', '..x')), 'sub/..x');
    assert.equal(relWithinWorkspace(cwd, join(cwd, '..', 'outside')), null);
    assert.equal(relWithinWorkspace(cwd, cwd), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('快照时已存在的空目录不被删除，快照后新建的空目录会被清理', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-emptydir-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-emptydir', header: { cwd } };
    await mkdir(join(cwd, 'empty-dir'), { recursive: true });
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
    const captured = await service.capture(session, 'manual', {});
    // 目标快照里 empty-dir 是已存在空目录；之后写入再删除文件，回滚不应把它收掉。
    await writeFile(join(cwd, 'empty-dir', 'run.txt'), 'temp', 'utf8');
    await mkdir(join(cwd, 'newempty'), { recursive: true });
    const preview = await service.preview(session.id, captured.record.id);
    const report = await service.restore({
      sessionId: session.id,
      snapshotId: captured.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.failed, 0);
    assert.deepEqual(await readdir(join(cwd, 'empty-dir')), []);
    await assert.rejects(readdir(join(cwd, 'newempty')), /ENOENT/);

    // 快照时点存在的空目录后来被删除，回滚会按 dirs 清单重新创建。
    await rm(join(cwd, 'empty-dir'), { recursive: true, force: true });
    const preview2 = await service.preview(session.id, captured.record.id);
    const report2 = await service.restore({
      sessionId: session.id,
      snapshotId: captured.record.id,
      files: true,
      conversation: false,
      planToken: preview2.planToken,
    });
    assert.equal(report2.files.failed, 0);
    assert.deepEqual(await readdir(join(cwd, 'empty-dir')), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('目标文件 vs 只含嵌套空目录的同名目录时，能按预览恢复', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-nested-dir-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-nested', header: { cwd } };
    await writeFile(join(cwd, 'a'), 'file-content', 'utf8');
    const captured = await service.capture(session, 'manual', {});
    await rm(join(cwd, 'a'), { force: true });
    await mkdir(join(cwd, 'a', 'sub'), { recursive: true });

    const preview = await service.preview(session.id, captured.record.id);
    assert.ok(preview.counts.dirsRemove >= 2);
    const report = await service.restore({
      sessionId: session.id,
      snapshotId: captured.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(join(cwd, 'a'), 'utf8'), 'file-content');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('首轮 fork 切点落在提问插入之前，不再包含原提问', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-fork-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-fork', header: { cwd } };
    service.readEvents = async () => eventsForBoundary();
    await writeFile(join(cwd, 'a.txt'), 'x', 'utf8');
    const result = await service.capture(session, 'start', { seq: 4, turn: 1 });
    assert.equal(result.record.forkSeq, 2, '安全切点应在 inbox splice(seq=3) 之前');
    assert.equal(result.record.forkSeqSafe, true);

    const old = { ...result.record, forkSeq: 3 };
    delete old.forkSeqSafe;
    const unsafe = await service.checkForkSafety(session.id, old);
    assert.equal(unsafe.safe, false, '旧版落在 inbox splice 上的切点必须被拒绝');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('历史快照的不安全 fork 切点会让 buildPlan 禁用对话回退', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-fork-plan-');
  try {
    const controllerApi = controller();
    const service = new SnapshotService({ get: (key) => (key === 'sessionController' ? controllerApi : undefined) }, { root }, logger);
    const session = { id: 's-plan', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'x', 'utf8');
    const captured = await service.capture(session, 'manual', {});
    service.readEvents = async () => eventsForBoundary();
    const snapshots = await service.store.listSnapshots(session.id);
    const record = snapshots.find((item) => item.id === captured.record.id);
    await service.store.putSnapshot({ ...record, forkSeq: 3, forkSeqSafe: undefined, seq: 6, turn: 1 });
    const plan = await service.buildPlan(session.id, captured.record.id);
    assert.equal(plan.conversation.available, false);
    assert.ok(plan.warnings.some((text) => text.includes('对话切点')));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('capture 使用 workingDirectory 的有效 cwd，而不是不可变的 header.cwd', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-cwd-');
  try {
    const other = join(base, 'other');
    await mkdir(other, { recursive: true });
    const workingDirectory = { get: () => other };
    const service = new SnapshotService({ get: (key) => (key === 'workingDirectory' ? workingDirectory : undefined) }, { root }, logger);
    const session = { id: 's-cwd', header: { cwd }, append() {} };
    await writeFile(join(other, 'b.txt'), 'b', 'utf8');
    const result = await service.capture(session, 'manual', { cwd: undefined });
    assert.equal(result.record.cwd, other);
    assert.ok(result.record.changeCount >= 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('冷会话手动快照通过 list 解析 cwd（不依赖不存在的 inspect）', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-cold-');
  try {
    const controllerApi = controller({ async list() { return { items: [{ sessionId: 's-cold', cwd, running: false }] }; } });
    const service = new SnapshotService({ get: (key) => (key === 'sessionController' ? controllerApi : undefined) }, { root }, logger);
    await writeFile(join(cwd, 'a.txt'), 'x', 'utf8');
    const result = await service.captureSynthetic({ sessionId: 's-cold' });
    assert.equal(result.record.cwd, cwd);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GC 在 sessions 根不可读时跳过，不删除仍被引用的对象', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-gc-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-gc', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
    await service.capture(session, 'manual', {});
    const objectBuckets = await readdir(join(root, 'objects'));
    const objectCount = objectBuckets.length;

    await rename(join(root, 'sessions'), join(root, 'sessions.moved'));
    const report = await service.gcObjects();
    assert.equal(report.skipped, true);
    assert.equal(report.removed, 0);
    assert.ok(objectCount > 0);
    assert.deepEqual(await readdir(join(root, 'objects')), objectBuckets);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GC 在会话快照目录被整体移走时跳过，不回收其对象', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-gc-moved-');
  try {
    const dshHome = join(base, 'home');
    await mkdir(join(dshHome, 'sessions', 'bucket', 's-moved'), { recursive: true });
    const service = new SnapshotService({ get: () => undefined }, { root, dshHome }, logger);
    const session = { id: 's-moved', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
    await service.capture(session, 'manual', {});
    assert.ok((await readdir(join(root, 'sessions'))).includes('.manifest.json'));
    await rename(join(root, 'sessions', 's-moved'), join(root, 's-moved.aside'));
    const report = await service.gcObjects();
    assert.equal(report.skipped, true);
    assert.equal(report.removed, 0);
    assert.ok((await readdir(join(root, 'objects'))).length > 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('pruneSnapshots 在 dshHome 看不到会话日志时拒绝删除全部快照', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-prune-');
  try {
    const dshHome = join(base, 'wrong-home');
    await mkdir(dshHome, { recursive: true });
    const service = new SnapshotService({ get: () => undefined }, { root, dshHome }, logger);
    const session = { id: 's-prune', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
    await service.capture(session, 'manual', {});
    const report = await service.pruneSnapshots();
    assert.equal(report.skipped, true);
    assert.deepEqual(report.removed, []);
    assert.ok((await readdir(join(root, 'sessions'))).includes('s-prune'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('工作区内目录 junction 不会被回滚写穿', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('此回归依赖 Windows junction 语义');
    return;
  }
  const { base, cwd, root } = await fixture('dsh-fix-junction-');
  try {
    const other = join(cwd, 'other');
    await mkdir(other, { recursive: true });
    await mkdir(join(cwd, 'link'), { recursive: true });
    await writeFile(join(cwd, 'link', 'foo.txt'), 'LINK_OLD', 'utf8');
    await writeFile(join(other, 'foo.txt'), 'OTHER_KEEP', 'utf8');
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-junction', header: { cwd } };
    const captured = await service.capture(session, 'manual', {});

    await rm(join(cwd, 'link'), { recursive: true, force: true });
    await symlink(other, join(cwd, 'link'), 'junction');
    const preview = await service.preview(session.id, captured.record.id);
    assert.ok(preview.unknown.some((item) => item.rel === 'link/foo.txt'));
    const report = await service.restore({
      sessionId: session.id,
      snapshotId: captured.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.restored, 0);
    assert.equal(await readFile(join(other, 'foo.txt'), 'utf8'), 'OTHER_KEEP');
  } finally {
    await rm(join(cwd, 'link'), { recursive: true, force: true }).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('恢复点采集失败不会烧掉回滚令牌', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-token-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-token', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const captured = await service.capture(session, 'manual', {});
    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');
    const preview = await service.preview(session.id, captured.record.id);

    const originalCapture = service.capture.bind(service);
    let failedOnce = false;
    service.capture = async (target, phase, info) => {
      if (phase === 'pre-rollback' && !failedOnce) {
        failedOnce = true;
        throw new Error('simulated disk full');
      }
      return originalCapture(target, phase, info);
    };
    await assert.rejects(
      service.restore({
        sessionId: session.id,
        snapshotId: captured.record.id,
        files: true,
        conversation: false,
        planToken: preview.planToken,
      }),
      /恢复点/,
    );
    // 同一个令牌仍然可用（恢复点失败时工作区尚未改动）。
    const report = await service.restore({
      sessionId: session.id,
      snapshotId: captured.record.id,
      files: true,
      conversation: false,
      planToken: preview.planToken,
    });
    assert.equal(report.files.failed, 0);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('full 快照的展示改动数是与实际差异，而不是文件总数', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-fullcount-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root, checkpointEvery: 2 }, logger);
    const session = { id: 's-count', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'a1', 'utf8');
    await writeFile(join(cwd, 'b.txt'), 'b1', 'utf8');
    const first = await service.capture(session, 'manual', {});
    assert.equal(first.record.full, true);
    await writeFile(join(cwd, 'a.txt'), 'a2', 'utf8');
    const second = await service.capture(session, 'manual', {});
    assert.equal(second.record.full, false);
    await writeFile(join(cwd, 'b.txt'), 'b2', 'utf8');
    await writeFile(join(cwd, 'c.txt'), 'c1', 'utf8');
    const third = await service.capture(session, 'manual', {});
    assert.equal(third.record.full, true, '达到 checkpointEvery 后应写 full');
    assert.equal(third.record.changeCount, 2, '只应统计 a/b 两个实际变化，而不是全部文件');
    assert.ok(third.record.stats.total >= 3);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('陈旧的跨进程存储锁会被接管，任务仍能执行', async () => {
  const { base, root } = await fixture('dsh-fix-lock-');
  try {
    const lock = join(root, '.store.lock');
    await writeFile(lock, JSON.stringify({ token: 'old', pid: process.pid, host: hostname(), startedAt: 0 }), 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, old, old);
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const value = await service.withStore(async () => 42);
    assert.equal(value, 42);
    await assert.rejects(readdir(lock), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('开发命令通道要求 id 与 token，缺一不执行', async () => {
  const { base } = await fixture('dsh-fix-devchannel-');
  const dir = join(base, 'dev');
  await mkdir(dir, { recursive: true });
  const calls = [];
  const stop = startDevChannel({
    dir,
    intervalMs: 20,
    token: 'secret',
    logger,
    dispatch: async (cmd) => { calls.push(cmd.op); return { op: cmd.op }; },
  });
  try {
    await writeFile(join(dir, 'cmd.json'), JSON.stringify({ id: 'no-token', op: 'bad' }), 'utf8');
    await new Promise((done) => setTimeout(done, 80));
    assert.deepEqual(calls, []);
    await writeFile(join(dir, 'cmd.json'), JSON.stringify({ id: 'with-token', token: 'secret', op: 'good' }), 'utf8');
    for (let i = 0; i < 30 && calls.length === 0; i += 1) await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(calls, ['good']);
  } finally {
    stop();
  }
});

test('maxFilesPerSnapshot / maxSessionBytes 真正生效而非死配置', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-quota-');
  try {
    await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
    await writeFile(join(cwd, 'b.txt'), 'b', 'utf8');
    const limited = new SnapshotService({ get: () => undefined }, { root, maxFilesPerSnapshot: 1 }, logger);
    await assert.rejects(
      limited.capture({ id: 's-quota', header: { cwd } }, 'manual', {}),
      /maxFilesPerSnapshot/,
    );
    const sized = new SnapshotService({ get: () => undefined }, { root, maxSessionBytes: 1 }, logger);
    await assert.rejects(
      sized.capture({ id: 's-quota', header: { cwd } }, 'manual', {}),
      /maxSessionBytes/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('HTTP 错误映射为 400/404/409/500，而不是一律 500', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  let mode = 'ok';
  const service = {
    async listSnapshots() { return { items: [] }; },
    async preview() {
      if (mode === 'missing') throw new Error('找不到快照 x');
      if (mode === 'boom') throw new Error('unexpected failure');
      return { planToken: 't' };
    },
    async restore() { throw new Error('当前会话仍在运行，已拒绝回滚'); },
    async captureSynthetic(input) { return { input }; },
    status() { return { ok: true }; },
  };
  const api = createApi(() => service, logger);
  const route = (suffix) => api.routes.find((item) => item.path.endsWith(suffix));
  const request = (path, init) => new Request(`http://127.0.0.1:1${path}`, init);

  const missingSession = await route('/snapshots').fetch(request('/api/snapshot-manager/v4/snapshots'));
  assert.equal(missingSession.status, 400);
  mode = 'missing';
  assert.equal((await route('/preview').fetch(request('/api/snapshot-manager/v4/preview?sessionId=s&snapshotId=x'))).status, 404);
  mode = 'ok';
  assert.equal((await route('/restore').fetch(request('/api/snapshot-manager/v4/restore', { method: 'POST', body: '{}' }))).status, 409);
  mode = 'boom';
  assert.equal((await route('/preview').fetch(request('/api/snapshot-manager/v4/preview?sessionId=s&snapshotId=x'))).status, 500);

  const captured = await route('/capture').fetch(request('/api/snapshot-manager/v4/capture', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's', label: 'manual', phase: 'x', forkSeq: 9 }),
  }));
  const body = await captured.json();
  assert.equal(body.record.input.phase, undefined, 'HTTP 不再透传 phase');
  assert.equal(body.record.input.forkSeq, undefined, 'HTTP 不再透传 forkSeq');
});

test('restore 拒绝超长 promptText', async () => {
  const { base, root } = await fixture('dsh-fix-prompt-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    await assert.rejects(
      service.restore({ sessionId: 's', promptText: 'x'.repeat(100001) }),
      /promptText 过长/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('recover 在改动工作区前生成可撤销的恢复点', async () => {
  const { base, cwd, root } = await fixture('dsh-fix-recover-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-recover', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const target = await service.capture(session, 'manual', {});
    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');
    await writeFile(join(cwd, 'new-work.txt'), 'keep me', 'utf8');
    await service.writeRestoreTx({
      id: 'tx-fix',
      sessionId: session.id,
      snapshotId: target.record.id,
      preRollbackId: null,
      scope: 'all',
      status: 'interrupted',
      startedAt: Date.now(),
      cwd,
      files: true,
      conversation: false,
      plan: { restore: 1, remove: 1, dirs: 0 },
    });

    const result = await service.recover('tx-fix', 'resume');
    assert.equal(typeof result.recoveryPointId, 'string');
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one');
    assert.equal(await readFile(join(cwd, 'new-work.txt'), 'utf8').catch(() => null), null);

    // 恢复点必须能回到 recover 之前，包括中断后新增的文件。
    const recovery = await service.preview(session.id, result.recoveryPointId);
    await service.restore({
      sessionId: session.id,
      snapshotId: result.recoveryPointId,
      files: true,
      conversation: false,
      planToken: recovery.planToken,
    });
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'two');
    assert.equal(await readFile(join(cwd, 'new-work.txt'), 'utf8'), 'keep me');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
