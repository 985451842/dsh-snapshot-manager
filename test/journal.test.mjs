import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

/** 等 journal 的异步 append 落盘（最多等 2 秒）。 */
async function waitForJournal(file) {
  for (let i = 0; i < 40; i += 1) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  throw new Error(`journal 未生成：${file}`);
}

test('相对 file_path 的 write 会写进会话 journal（回归）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-'));
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const cwd = join(root, 'workspace');
    service.onSessionEvent(
      { id: 'session-test', header: { cwd } },
      {
        seq: 1,
        type: 'tool/call',
        data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/app.ts', content: 'x' }) },
      },
    );
    const text = await waitForJournal(join(root, 'journal', 'session-test.jsonl'));
    assert.equal(text.trim(), 'src/app.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('绝对 file_path 仍然记成工作区相对路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-'));
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const cwd = join(root, 'workspace');
    service.onSessionEvent(
      { id: 'session-abs', header: { cwd } },
      {
        seq: 1,
        type: 'tool/call',
        data: { name: 'edit', arguments: JSON.stringify({ file_path: join(cwd, 'src', 'b.ts'), old_string: 'a', new_string: 'b' }) },
      },
    );
    const text = await waitForJournal(join(root, 'journal', 'session-abs.jsonl'));
    assert.equal(text.trim(), 'src/b.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('工作区外的路径不会被记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-'));
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const cwd = join(root, 'workspace');
    service.onSessionEvent(
      { id: 'session-out', header: { cwd } },
      {
        seq: 1,
        type: 'tool/call',
        data: { name: 'write', arguments: JSON.stringify({ file_path: '../outside.ts', content: 'x' }) },
      },
    );
    await new Promise((done) => setTimeout(done, 300));
    await assert.rejects(readFile(join(root, 'journal', 'session-out.jsonl'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
