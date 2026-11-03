import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService, normalizePhase, safeSegment } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

async function fixture(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(base, 'workspace');
  const root = join(base, 'store');
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  return { base, cwd, root };
}

test('safeSegment 拒绝 "."/".." 纯点号片段，normalizePhase 收敛到白名单', () => {
  assert.equal(safeSegment('..'), '_..');
  assert.equal(safeSegment('.'), '_.');
  assert.equal(safeSegment('...'), '_...');
  assert.equal(safeSegment(''), '_');
  assert.equal(safeSegment('a/b\\c'), 'a_b_c');
  assert.equal(safeSegment('session-1'), 'session-1');

  assert.equal(normalizePhase('../../../escaped'), 'manual');
  assert.equal(normalizePhase('start'), 'start');
  assert.equal(normalizePhase('pre-rollback'), 'pre-rollback');
  assert.equal(normalizePhase(undefined), 'manual');
});

test('非法 phase 不会进记录 id，也不会把记录写出会话目录', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-phase-');
  try {
    await writeFile(join(cwd, 'a.txt'), 'x', 'utf8');
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 'session-sec', header: { cwd } };
    const result = await service.capture(session, '../../../escaped', {});

    assert.equal(result.record.phase, 'manual');
    assert.equal(result.record.id.includes('/'), false);
    assert.equal(result.record.id.includes('\\'), false);
    assert.equal(result.record.id.includes('..'), false);

    const sessionsRoot = await readdir(join(root, 'sessions'));
    assert.deepEqual(sessionsRoot, ['session-sec'], '存储根下只应有这一个会话目录');
    const inside = await readdir(join(root, 'sessions', 'session-sec'));
    assert.deepEqual(inside, [`${result.record.id}.json`], '记录必须落在会话自己的目录里');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('sessionId 为 ".." 时读写仍限制在 sessions 目录内', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-session-id-');
  try {
    await writeFile(join(cwd, 'a.txt'), 'x', 'utf8');
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: '..', header: { cwd } };
    const result = await service.capture(session, 'manual', {});

    const sessionsRoot = await readdir(join(root, 'sessions'));
    assert.deepEqual(sessionsRoot, [safeSegment('..')], '记录不能落到 sessions 根目录');
    assert.equal(result.record.id.includes('..'), false);

    const listed = await service.listSnapshots('..');
    assert.equal(listed.count, 1);
    assert.equal(listed.items[0].id, result.record.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
