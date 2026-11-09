import { execFileSync } from 'node:child_process';

export function assertRuntime({ platform = process.platform, version = process.versions.node } = {}) {
  if (platform !== 'darwin') throw new Error('安装需要 macOS（卡片复制使用系统剪贴板）。Windows / Linux 当前仅支持开发测试。');
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`需要 Node.js 22.13+，当前为 ${version}。请升级 Node 后重试。`);
}

export const codexBinary = () => process.env.NOTEPAD_CODEX_BIN || 'codex';
export function assertCodex() {
  try { execFileSync(codexBinary(), ['plugin', 'add', '--help'], { stdio: 'pipe' }); }
  catch { throw new Error('未找到支持 plugin add 的 codex CLI。请先安装或升级官方 Codex CLI，并确认 codex 在 PATH 中。'); }
}
if (process.argv.includes('--check')) {
  assertRuntime(); assertCodex();
  console.log(`环境检查通过：macOS / Node ${process.versions.node} / Codex CLI。`);
}
