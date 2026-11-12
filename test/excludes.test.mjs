import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  compileExcludeMatcher,
  isExcluded,
  listGitignoredDirs,
  managedIgnoreFile,
  readManagedIgnore,
  resolveConfig,
  scanWorkspace,
  SnapshotService,
} from '../lib/host.js';

const logger = { info() {}, warn() {}, error() {} };

async function fixture(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(base, 'workspace');
  const root = join(base, 'store');
  await mkdir(cwd, { recursive: true });
  await mkdir(root, { recursive: true });
  return { base, cwd, root };
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function initRepo(cwd) {
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore', windowsHide: true });
}

test('excludes 支持段级通配，且不影响精确匹配/扩展名', () => {
  const match = compileExcludeMatcher(['.tmp-*', 'node_modules'], ['.jar']);
  assert.equal(match('.tmp-gradle/caches/x'), true);
  assert.equal(match('app/.tmp-junit/x.txt'), true);
  assert.equal(match('src/app.js'), false);
  assert.equal(match('src/lib.jar'), true);
  assert.equal(match('node_modules/pkg/index.js'), true);
  // 通配只匹配单个路径段，不跨 `/`
  assert.equal(match('tmp-gradle/x'), false);
  assert.equal(match('.tmp/a/b'), false);
  // 旧签名（Set）继续可用
  assert.equal(isExcluded('.tmp-a/b', new Set(['.tmp-*']), new Set()), true);
  assert.equal(isExcluded('src/app.js', new Set(['node_modules']), new Set(['.js'])), true);
});

test('默认排除包含 .tmp-*，临时目录不计入扫描', async () => {
  const { base, cwd, root } = await fixture('dsh-excl-tmp-');
  try {
    await mkdir(join(cwd, '.tmp-gradle', 'caches'), { recursive: true });
    await writeFile(join(cwd, '.tmp-gradle', 'caches', 'x.txt'), 'temp', 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');
    const config = resolveConfig({ root, excludeGitignoredDirs: false });
    const { index, stats } = await scanWorkspace({ cwd, config, previousIndex: null });
    assert.deepEqual(Object.keys(index.entries), ['src/main.js']);
    assert.equal(stats.ignoredDirs, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('gitignore 目录默认跳过、被忽略的文件保留、可关闭', { skip: !hasGit() }, async () => {
  const { base, cwd, root } = await fixture('dsh-excl-git-');
  try {
    initRepo(cwd);
    await writeFile(join(cwd, '.gitignore'), 'generated/\nlocal.env\n', 'utf8');
    await mkdir(join(cwd, 'generated'), { recursive: true });
    await writeFile(join(cwd, 'generated', 'a.txt'), 'generated', 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');
    await writeFile(join(cwd, 'local.env'), 'secret', 'utf8');

    const ignored = await listGitignoredDirs(cwd);
    assert.deepEqual(ignored, ['generated']);

    const on = resolveConfig({ root, excludeGitignoredDirs: true });
    const scanOn = await scanWorkspace({ cwd, config: on, previousIndex: null });
    assert.deepEqual(Object.keys(scanOn.index.entries).sort(), ['.gitignore', 'local.env', 'src/main.js']);
    assert.equal(scanOn.stats.ignoredDirs, 1);
    assert.deepEqual(scanOn.ignoredDirs, ['generated']);

    const off = resolveConfig({ root, excludeGitignoredDirs: false });
    const scanOff = await scanWorkspace({ cwd, config: off, previousIndex: null });
    assert.ok(scanOff.index.entries['generated/a.txt'] !== undefined);

    // 从“纳入”切到“跳过”时，上一条索引里的路径不能被记成删除。
    const scanBack = await scanWorkspace({ cwd, config: on, previousIndex: scanOff.index });
    assert.equal(scanBack.index.entries['generated/a.txt'], undefined);
    assert.equal(scanBack.unknown['generated/a.txt'], 'excluded');
    assert.equal(scanBack.changes['generated/a.txt'], undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('超限报错列出最占用的未排除目录', async () => {
  const { base, cwd, root } = await fixture('dsh-excl-overflow-');
  try {
    await mkdir(join(cwd, 'big'), { recursive: true });
    for (let i = 0; i < 6; i += 1) await writeFile(join(cwd, 'big', `f${i}.txt`), String(i), 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');
    const config = resolveConfig({ root, maxFilesPerSnapshot: 2, excludeGitignoredDirs: false });
    await assert.rejects(
      scanWorkspace({ cwd, config, previousIndex: null }),
      (error) => {
        assert.match(String(error.message), /maxFilesPerSnapshot/);
        assert.match(String(error.message), /big/);
        return true;
      },
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('新增排除规则时，原本已纳入的路径记 unknown 而不是删除', async () => {
  const { base, cwd, root } = await fixture('dsh-excl-transition-');
  try {
    await mkdir(join(cwd, 'generated'), { recursive: true });
    await writeFile(join(cwd, 'generated', 'a.txt'), 'generated', 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');

    const before = resolveConfig({ root, excludes: [], excludeGitignoredDirs: false });
    const first = await scanWorkspace({ cwd, config: before, previousIndex: null });
    assert.ok(first.index.entries['generated/a.txt'] !== undefined);

    const after = resolveConfig({ root, excludes: ['generated'], excludeGitignoredDirs: false });
    const second = await scanWorkspace({ cwd, config: after, previousIndex: first.index });
    assert.equal(second.index.entries['generated/a.txt'], undefined);
    assert.equal(second.unknown['generated/a.txt'], 'excluded');
    assert.equal(second.changes['generated/a.txt'], undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('gitignore 目录写进快照：之后取消忽略，回滚到旧快照也不会把它当新建删除', { skip: !hasGit() }, async () => {
  const { base, cwd, root } = await fixture('dsh-excl-git-rec-');
  try {
    initRepo(cwd);
    await writeFile(join(cwd, '.gitignore'), 'generated/\n', 'utf8');
    await mkdir(join(cwd, 'generated'), { recursive: true });
    await writeFile(join(cwd, 'generated', 'a.txt'), 'generated', 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');

    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const session = { id: 's-git-rec', header: { cwd } };
    const first = await service.capture(session, 'manual', {});
    assert.deepEqual(first.record.ignoredDirs, ['generated']);

    // 取消忽略后重新采集：generated/ 这次会纳入快照。
    await writeFile(join(cwd, '.gitignore'), '', 'utf8');
    await service.capture(session, 'manual', {});
    const records = await service.store.listSnapshots(session.id);
    const last = records[records.length - 1];
    assert.ok(last.changes['generated/a.txt'] !== undefined);

    // 回滚目标仍是第一条快照时，该目录属于“当时未采集”，不能进删除清单。
    const info = service.store.resolveTreeInfo(records, first.record.id);
    assert.ok(info.unknownDirs.includes('generated'));
    const preview = await service.preview(session.id, first.record.id);
    const removeRels = (preview.remove ?? []).map((item) => item.rel);
    assert.ok(!removeRels.includes('generated/a.txt'));
    assert.ok((preview.unknown ?? []).some((item) => item.rel === 'generated/a.txt'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('超限时自动写入插件自己的忽略清单并重扫成功', async () => {
  const { base, cwd, root } = await fixture('dsh-auto-ignore-');
  try {
    await mkdir(join(cwd, 'junk'), { recursive: true });
    for (let i = 0; i < 120; i += 1) await writeFile(join(cwd, 'junk', `f${i}.log`), 'x', 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');

    const config = resolveConfig({ root, maxFilesPerSnapshot: 2 });
    const result = await scanWorkspace({ cwd, config, previousIndex: null, allowAutoIgnore: true });
    assert.deepEqual(Object.keys(result.index.entries), ['src/main.js']);
    assert.equal(result.stats.total, 1);
    assert.equal(result.stats.autoIgnored, 1);
    assert.ok(result.stats.autoIgnoredPaths.includes('junk'));
    assert.ok(result.ignoredDirs.includes('junk'));

    const managed = await readManagedIgnore(config, cwd);
    assert.deepEqual(managed.entries.map((entry) => entry.value), ['junk']);
    assert.equal(managed.entries[0].kind, 'path');
    assert.equal(managed.entries[0].source, 'auto');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('含源码/文本的目录不会被自动忽略', async () => {
  const { base, cwd, root } = await fixture('dsh-auto-ignore-src-');
  try {
    await mkdir(join(cwd, 'src'), { recursive: true });
    for (let i = 0; i < 120; i += 1) await writeFile(join(cwd, 'src', `f${i}.js`), 'x', 'utf8');
    const config = resolveConfig({ root, maxFilesPerSnapshot: 2 });
    await assert.rejects(
      scanWorkspace({ cwd, config, previousIndex: null, allowAutoIgnore: true }),
      /maxFilesPerSnapshot/,
    );
    const managed = await readManagedIgnore(config, cwd);
    assert.equal(managed.entries.length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('autoIgnore: off 时不写清单', async () => {
  const { base, cwd, root } = await fixture('dsh-auto-ignore-off-');
  try {
    await mkdir(join(cwd, 'junk'), { recursive: true });
    for (let i = 0; i < 120; i += 1) await writeFile(join(cwd, 'junk', `f${i}.log`), 'x', 'utf8');
    const config = resolveConfig({ root, maxFilesPerSnapshot: 2, autoIgnore: 'off' });
    await assert.rejects(
      scanWorkspace({ cwd, config, previousIndex: null, allowAutoIgnore: true }),
      /maxFilesPerSnapshot/,
    );
    const managed = await readManagedIgnore(config, cwd);
    assert.equal(managed.entries.length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('插件忽略清单支持路径前缀与段通配，且记录被跳过目录', async () => {  const { base, cwd, root } = await fixture('dsh-managed-ignore-');
  try {
    await mkdir(join(cwd, 'a', '.umi'), { recursive: true });
    await writeFile(join(cwd, 'a', '.umi', 'x.log'), 'x', 'utf8');
    await mkdir(join(cwd, 'b', '.umi'), { recursive: true });
    await writeFile(join(cwd, 'b', '.umi', 'y.log'), 'y', 'utf8');
    await mkdir(join(cwd, 'pkg', 'build-cache'), { recursive: true });
    await writeFile(join(cwd, 'pkg', 'build-cache', 'z.log'), 'z', 'utf8');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.js'), 'code', 'utf8');

    const config = resolveConfig({ root });
    const file = managedIgnoreFile(config, cwd);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      v: 1,
      entries: [
        { kind: 'path', value: 'a/.umi' },
        { kind: 'pattern', value: 'build-*' },
      ],
    }), 'utf8');

    const result = await scanWorkspace({ cwd, config, previousIndex: null });
    const paths = Object.keys(result.index.entries).sort();
    assert.ok(!paths.includes('a/.umi/x.log'));
    assert.ok(paths.includes('b/.umi/y.log'));
    assert.ok(!paths.includes('pkg/build-cache/z.log'));
    assert.ok(result.ignoredDirs.includes('a/.umi'));
    assert.ok(result.ignoredDirs.includes('pkg/build-cache'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('手动管理插件忽略清单：添加、去重、删除', async () => {
  const { base, cwd, root } = await fixture('dsh-managed-ignore-api-');
  try {
    const service = new SnapshotService({ get: () => undefined }, { root }, logger);
    const sessionId = 's-managed-ignore';
    service.metaFor({ id: sessionId }).cwd = cwd;

    let info = await service.listManagedIgnore(sessionId);
    assert.equal(info.entries.length, 0);
    assert.ok(info.file.includes('ignore'));

    await service.addManagedIgnore(sessionId, { kind: 'path', value: 'a/.umi' });
    await service.addManagedIgnore(sessionId, { kind: 'path', value: 'a/.umi' });
    await service.addManagedIgnore(sessionId, { kind: 'pattern', value: '.tmp-*' });
    info = await service.listManagedIgnore(sessionId);
    assert.equal(info.entries.length, 2);
    assert.ok(info.entries.some((entry) => entry.kind === 'path' && entry.value === 'a/.umi'));
    assert.ok(info.entries.some((entry) => entry.kind === 'pattern' && entry.value === '.tmp-*'));
    assert.ok(info.entries.every((entry) => entry.source === 'manual'));

    await assert.rejects(
      service.addManagedIgnore(sessionId, { kind: 'pattern', value: 'a/b' }),
      /不能包含/,
    );
    await service.removeManagedIgnore(sessionId, { kind: 'path', value: 'a/.umi' });
    info = await service.listManagedIgnore(sessionId);
    assert.equal(info.entries.length, 1);
    assert.equal(info.entries[0].value, '.tmp-*');

    await assert.rejects(
      service.removeManagedIgnore(sessionId, { kind: 'path', value: 'a/.umi' }),
      /找不到/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
