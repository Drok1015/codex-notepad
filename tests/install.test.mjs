import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertRuntime } from '../scripts/runtime.mjs';

test('安装前检查系统与最低 Node 版本', () => {
  assert.doesNotThrow(() => assertRuntime({ platform: 'darwin', version: '22.13.0' }));
  assert.doesNotThrow(() => assertRuntime({ platform: 'darwin', version: '24.0.0' }));
  assert.throws(() => assertRuntime({ platform: 'darwin', version: '22.12.0' }), /22.13/);
  assert.throws(() => assertRuntime({ platform: 'linux', version: '22.13.0' }), /macOS/);
});

test('换目录安装：空格和中文路径、真实缓存路径回填、二次安装与握手验证', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notepad-install-'));
  const project = join(dir, '下载目录 with spaces', '任意项目名');
  const cache = join(dir, '自定义缓存 with spaces', 'plugin');
  try {
    await mkdir(project, { recursive: true });
    for (const name of ['scripts', '.codex-plugin', '.agents', 'release']) await cp(resolve(name), join(project, name), { recursive: true });
    await symlink(resolve('node_modules'), join(project, 'node_modules'));
    const fake = join(dir, '模拟 codex');
    await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);if(args.includes('--help'))process.exit(0);if(args[1]==='marketplace'){console.log('marketplace ready');process.exit(0);}fs.mkdirSync(${JSON.stringify(cache)},{recursive:true});fs.cpSync(path.join(process.cwd(),'release'),${JSON.stringify(cache)},{recursive:true});console.log(JSON.stringify({installedPath:${JSON.stringify(cache)}}));\n`);
    await chmod(fake, 0o700);
    const output = execFileSync(process.execPath, [join(project, 'scripts/install.mjs')], { cwd: '/', env: { ...process.env, NOTEPAD_CODEX_BIN: fake }, encoding: 'utf8' });
    assert.match(output, /安装完成/);
    const config = JSON.parse(await readFile(join(cache, '.mcp.json'), 'utf8')).mcpServers.notepad;
    assert.deepEqual(config.args, [join(await realpath(cache), 'dist/server.mjs')]);
    assert.equal(config.command, process.execPath);
    const verification = execFileSync(process.execPath, [join(project, 'scripts/verify.mjs')], { cwd: '/', encoding: 'utf8' });
    assert.match(verification, /验证通过/);
    assert.match(verification, /未读取个人笔记/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
