import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(`${root}/dist`, { recursive: true });
const result = await build({ entryPoints: [`${root}/web/app.mjs`], bundle: true, format: 'esm', platform: 'browser', write: false, minify: true });
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await readFile(`${root}/web/style.css`, 'utf8');
const html = (await readFile(`${root}/web/index.html`, 'utf8')).replace('/* APP_STYLE */', () => css).replace('/* APP_SCRIPT */', () => script);
await writeFile(`${root}/dist/app.html`, html);
await build({ entryPoints: [`${root}/server/index.mjs`], outfile: `${root}/dist/server.mjs`, bundle: true, format: 'esm', platform: 'node', target: 'node22',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
// Legacy .mcp.json does not expand ${PLUGIN_ROOT} in the installed desktop runtime.
// Use a concrete launch path; install.mjs replaces it with the actual installed path.
// Install only bundled runtime assets, without node_modules or development files.
for (const path of ['dist', 'assets', '.codex-plugin']) await cp(`${root}/${path}`, `${root}/release/${path}`, { recursive: true });
await writeFile(`${root}/release/.mcp.json`, JSON.stringify({ mcpServers: { notepad: { command: process.execPath, args: [`${root}/release/dist/server.mjs`] } } }, null, 2) + '\n');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(`${root}/${name}`, `${root}/release/${name}`);
const dependencyRoots = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(path => path !== root);
const notices = [];
for (const directory of [...new Set(dependencyRoots)].sort()) {
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  const files = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  const texts = await Promise.all(files.map(async name => `${name}\n${await readFile(`${directory}/${name}`, 'utf8')}`));
  if (!texts.length && pkg.name === '@cfworker/json-schema') texts.push(await readFile(`${root}/third-party/cfworker.LICENSE.md`, 'utf8'));
  if (!texts.length) throw new Error(`Missing license file for ${pkg.name}`);
  notices.push(`${pkg.name}@${pkg.version} (${typeof pkg.license === 'string' ? pkg.license : 'see license below'})\n${texts.join('\n\n')}`);
}
await writeFile(`${root}/release/THIRD_PARTY_LICENSES.txt`, notices.join('\n\n========================================\n\n'));
console.log('Built plugin server and notepad UI.');
