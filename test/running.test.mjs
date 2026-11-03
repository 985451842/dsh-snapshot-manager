import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotService, STALE_RUNNING_MS } from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

async function fixture(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(base, 'workspace');
  const root = join(base, 'store');
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  return { base, cwd, root };
}

test('sessionController.list 报告 running 时拒绝回滚，停止后同一令牌可执行', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-running-');
  try {
    let running = true;
    const controller = {
      list: async () => ({ items: [{ sessionId: 'session-running', running }] }),
    };
    const service = new SnapshotService({
      get: (key) => (key === 'sessionController' ? controller : undefined),
    }, { root }, logger);
    const session = { id: 'session-running', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const capture = await service.capture(session, 'manual', {});
    await writeFile(join(cwd, 'a.txt'), 'two', 'utf8');

    const preview = await service.preview(session.id, capture.record.id);
    assert.equal(preview.running, true);
    assert.match(preview.warnings.join('\n'), /仍在运行/);

    await assert.rejects(
      service.restore({
        sessionId: session.id,
        snapshotId: capture.record.id,
        files: true,
        conversation: false,
        planToken: preview.planToken,
      }),
      /仍在运行/,
    );
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'two');

    // 运行结束后，未消费的令牌仍然可用；工作区没有变化，计划摘要一致。
    running = false;
    const report = await service.restore({
      sessionId: session.id,
      snapshotId: capture.record.id,
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

test('父会话本身空闲、但运行中的子代理仍会阻止回滚', async () => {
  const { base, root } = await fixture('dsh-snapshot-subagent-');
  try {
    const controller = {
      list: async () => ({
        items: [
          { sessionId: 'parent', running: false },
          { sessionId: 'child', parentSessionId: 'parent', running: true },
        ],
      }),
    };
    const service = new SnapshotService({
      get: (key) => (key === 'sessionController' ? controller : undefined),
    }, { root }, logger);
    const info = await service.detectRunning('parent');
    assert.equal(info.state, true);
    assert.deepEqual(info.subagents, ['child']);
    assert.match(service.runningError(info), /子代理/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('事件流 turn/start 与 turn/end 维护 running 状态', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-events-');
  try {
    const service = new SnapshotService({ get: () => undefined }, {
      root,
      captureOnTurnStart: false,
      captureOnTurnEnd: false,
    }, logger);
    const session = { id: 'session-events', header: { cwd } };
    service.onSessionEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
    assert.equal((await service.detectRunning(session.id)).state, true);
    service.onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal((await service.detectRunning(session.id)).state, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('事件流说运行中而 sessionController.list 说空闲时，仍按运行中拒绝', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-running-priority-');
  try {
    const controller = { list: async () => ({ items: [{ sessionId: 'session-priority', running: false, cwd }] }) };
    const service = new SnapshotService({
      get: (key) => (key === 'sessionController' ? controller : undefined),
    }, { root }, logger);
    const session = { id: 'session-priority', header: { cwd } };
    service.onSessionEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } });

    const info = await service.detectRunning(session.id);
    assert.equal(info.state, true, 'list 的 false 不能把事件流的 true 覆盖掉');
    assert.equal(info.source, 'events');
    assert.equal(service.meta.get(session.id).running, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('长时间没有任何事件、且 list 明确空闲时，陈旧运行标记会被修回空闲', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-running-stale-');
  try {
    const controller = { list: async () => ({ items: [{ sessionId: 'session-stale', running: false, cwd }] }) };
    const service = new SnapshotService({
      get: (key) => (key === 'sessionController' ? controller : undefined),
    }, { root }, logger);
    const session = { id: 'session-stale', header: { cwd } };
    service.onSessionEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
    service.meta.get(session.id).lastEventAt = Date.now() - STALE_RUNNING_MS - 1000;

    const info = await service.detectRunning(session.id);
    assert.equal(info.state, false);
    assert.equal(info.source, 'stale-events');
    assert.equal(service.meta.get(session.id).running, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('同一工作区里其他会话正在运行时，预览给出警告、执行被拒绝', async () => {
  const { base, cwd, root } = await fixture('dsh-snapshot-workspace-busy-');
  try {
    const controller = {
      list: async () => ({
        items: [
          { sessionId: 'session-self', running: false, cwd },
          { sessionId: 'session-other', running: true, cwd },
        ],
      }),
    };
    const service = new SnapshotService({
      get: (key) => (key === 'sessionController' ? controller : undefined),
    }, { root }, logger);
    const session = { id: 'session-self', header: { cwd } };
    await writeFile(join(cwd, 'a.txt'), 'one', 'utf8');
    const captured = await service.capture(session, 'manual', {});

    const preview = await service.preview(session.id, captured.record.id);
    assert.equal(preview.workspaceBusy.length, 1);
    assert.equal(preview.workspaceBusy[0].sessionId, 'session-other');
    assert.match(preview.warnings.join('\n'), /同一工作区/);

    await assert.rejects(
      service.restore({
        sessionId: session.id,
        snapshotId: captured.record.id,
        files: true,
        conversation: false,
        planToken: preview.planToken,
      }),
      /同一工作区/,
    );
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one', '执行被拒绝时文件不能被改动');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

