import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

/** 造一条快照记录。 */
function record(id, parent, full, changes, at) {
  return { id, sessionId: 'session-chain', parent, full, changes, at };
}

test('resolveTreeInfo 报告缺失 parent，不能把残缺树当完整树', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-chain-'));
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const snapshots = [
      record('00001-start-a', 'missing-parent', false, { 'a.txt': 'h-a' }, 1),
    ];
    const info = service.store.resolveTreeInfo(snapshots, '00001-start-a');
    assert.equal(info.complete, false);
    assert.match(String(info.reason), /missing-parent/);
    assert.deepEqual(Object.keys(info.tree), ['a.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trim 删除最老记录前会把新的最老记录提升为 full 基座', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-trim-'));
  try {
    const service = new SnapshotService({ get: () => undefined }, { root, maxSnapshotsPerSession: 3 }, logger);
    const snapshots = [
      record('00000-start-a', null, true, { 'a.txt': 'h-a' }, 1),
      record('00001-start-b', '00000-start-a', false, { 'b.txt': 'h-b' }, 2),
      record('00002-start-c', '00001-start-b', false, { 'c.txt': 'h-c' }, 3),
      record('00003-start-d', '00002-start-c', false, { 'd.txt': 'h-d' }, 4),
      record('00004-start-e', '00003-start-d', false, { 'e.txt': 'h-e' }, 5),
    ];
    for (const item of snapshots) await service.store.putSnapshot(item);

    const removed = await service.trim('session-chain');
    assert.equal(removed, 2);

    const kept = await service.store.listSnapshots('session-chain');
    assert.equal(kept.length, 3);
    assert.equal(kept[0].id, '00002-start-c');
    assert.equal(kept[0].full, true);
    assert.equal(kept[0].parent, null);
    const info = service.store.resolveTreeInfo(kept, '00004-start-e');
    assert.equal(info.complete, true);
    assert.deepEqual(Object.keys(info.tree).sort(), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除有子记录的快照会被拒绝，删叶子可以', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-delete-'));
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    await service.store.putSnapshot(record('00000-start-a', null, true, { 'a.txt': 'h-a' }, 1));
    await service.store.putSnapshot(record('00001-start-b', '00000-start-a', false, { 'b.txt': 'h-b' }, 2));
    await assert.rejects(
      service.deleteSnapshot('session-chain', '00000-start-a'),
      /后续快照的基线/,
    );
    const result = await service.deleteSnapshot('session-chain', '00001-start-b');
    assert.equal(result.deleted, '00001-start-b');
    assert.equal((await service.store.listSnapshots('session-chain')).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
