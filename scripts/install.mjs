import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertRuntime, assertCodex, codexBinary } from './runtime.mjs';

assertRuntime(); assertCodex();
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const catalog = JSON.parse(await readFile(`${root}/.agents/plugins/marketplace.json`, 'utf8'));
const manifest = JSON.parse(await readFile(`${root}/.codex-plugin/plugin.json`, 'utf8'));
await readFile(`${root}/release/dist/server.mjs`);
const selector = `${manifest.name}@${catalog.name}`;
const run = args => execFileSync(codexBinary(), args, { encoding: 'utf8', cwd: root });

console.log(run(['plugin', 'marketplace', 'add', root]).trim());
// The first install discovers the real cache path, including custom Codex storage locations.
const installed = JSON.parse(run(['plugin', 'add', selector, '--json']));
if (!isAbsolute(installed.installedPath || '')) throw new Error('安装器没有返回绝对安装路径，请检查 Codex CLI 版本。');
const installedRoot = await realpath(installed.installedPath);
await readFile(resolve(installedRoot, 'dist/server.mjs'));
const config = { mcpServers: { notepad: { command: process.execPath, args: [resolve(installedRoot, 'dist/server.mjs')] } } };
await writeFile(`${root}/release/.mcp.json`, JSON.stringify(config, null, 2) + '\n');
// A second install places a concrete launch path inside the self-contained cache package.
console.log(run(['plugin', 'add', selector]).trim());
await mkdir(`${root}/.local`, { recursive: true });
await writeFile(`${root}/.local/install.json`, JSON.stringify({ pluginId: selector, version: manifest.version, installedPath: installedRoot }, null, 2) + '\n');
console.log('安装完成。接下来运行 npm run verify:plugin，重启桌面应用并检查「记事本」。');
