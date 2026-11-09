import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = JSON.parse(await readFile(`${root}/.local/install.json`, 'utf8'));
const config = JSON.parse(await readFile(join(installed.installedPath, '.mcp.json'), 'utf8')).mcpServers.notepad;
const dir = await mkdtemp(join(tmpdir(), 'codex-notepad-verify-'));
const client = new Client({ name: 'codex-notepad-installer', version: '1' });
try {
  await client.connect(new StdioClientTransport({ ...config, cwd: '/', env: { ...process.env, NOTEPAD_DATA_DIR: dir }, stderr: 'pipe' }));
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  const open = tools.find(tool => tool.name === 'open_notepad');
  for (const name of ['list_notes', 'get_note', 'create_note', 'update_note', 'trash_note', 'restore_note', 'copy_note', 'list_folders', 'create_folder']) {
    if (!tools.some(tool => tool.name === name)) throw new Error(`缺少工具：${name}`);
  }
  const entries = open?._meta?.['openai/ui']?.entrypoints || [];
  if (!entries.some(e => e.type === 'global') || !entries.some(e => e.type === 'thread')) throw new Error('侧边栏或侧面板入口缺失');
  if (!info.icons?.length || info.version !== installed.version) throw new Error('图标缺失或安装版本不匹配');
  const result = await client.readResource({ uri: open._meta.ui.resourceUri });
  if (!result.contents.some(c => c.text?.includes('gallery-grid'))) throw new Error('画廊 UI 资源缺失');
  if (!result.contents.some(c => c.text?.includes('folder-list'))) throw new Error('文件夹 UI 资源缺失');
  console.log(`验证通过：${installed.pluginId} v${info.version}，10 个工具、图标、侧边栏入口、侧面板入口与文件夹卡片 UI 均可读取。`);
  console.log('此结果验证服务和入口注册；图标的实际显示需在重启后的桌面应用中确认。未读取个人笔记或修改剪贴板。');
} finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
