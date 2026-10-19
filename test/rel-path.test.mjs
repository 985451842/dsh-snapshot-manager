import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { relWithinWorkspace } from '../lib/host.js';

// 用解析后的绝对目录，保证在 Windows / POSIX 上都能跑。
const cwd = resolve('workspace-root');

test('工作区相对路径会被接受（回归：此前只认绝对路径）', () => {
  assert.equal(relWithinWorkspace(cwd, 'src/app/main.ts'), 'src/app/main.ts');
});

test('./ 开头的相对路径会被规范化', () => {
  assert.equal(relWithinWorkspace(cwd, './src/app/main.ts'), 'src/app/main.ts');
});

test('工作区内的绝对路径仍按相对路径返回', () => {
  assert.equal(relWithinWorkspace(cwd, resolve(cwd, 'src/app/main.ts')), 'src/app/main.ts');
});

test('用相对路径越出工作区会被拒绝', () => {
  assert.equal(relWithinWorkspace(cwd, '../outside.txt'), null);
  assert.equal(relWithinWorkspace(cwd, '../../outside.txt'), null);
});

test('用绝对路径指向工作区外会被拒绝', () => {
  assert.equal(relWithinWorkspace(cwd, resolve(cwd, '..', 'outside.txt')), null);
});

test('路径等于工作区根目录本身会被拒绝', () => {
  assert.equal(relWithinWorkspace(cwd, '.'), null);
  assert.equal(relWithinWorkspace(cwd, cwd), null);
});

test('空值返回 null', () => {
  assert.equal(relWithinWorkspace(cwd, ''), null);
  assert.equal(relWithinWorkspace('', 'src/app/main.ts'), null);
  assert.equal(relWithinWorkspace(undefined, 'src/app/main.ts'), null);
  assert.equal(relWithinWorkspace(cwd, undefined), null);
});

test('反斜杠相对路径在 Windows 上归一为 / 分隔', { skip: process.platform !== 'win32' }, () => {
  assert.equal(relWithinWorkspace('D:\\javaProject\\yf', 'yefu-admin\\src\\a.java'), 'yefu-admin/src/a.java');
  assert.equal(relWithinWorkspace('D:\\javaProject\\yf', 'D:\\javaProject\\yf\\yefu-fe\\src\\a.ts'), 'yefu-fe/src/a.ts');
  assert.equal(relWithinWorkspace('D:\\javaProject\\yf', 'C:\\other\\a.java'), null);
});
