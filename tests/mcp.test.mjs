import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('打包后的 MCP 可启动并发布侧边栏入口和全部笔记工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notepad-mcp-'));
  const client = new Client({ name: 'notepad-test', version: '1' });
  try {
    // Launch exactly as the host does, from the shipped manifest, without hand-expanding paths.
    const configPath = process.env.NOTEPAD_TEST_PLUGIN_ROOT ? join(process.env.NOTEPAD_TEST_PLUGIN_ROOT, '.mcp.json') : 'release/.mcp.json';
    const { command, args } = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.notepad;
    await client.connect(new StdioClientTransport({ command, args, cwd: '/', env: { ...process.env, NOTEPAD_DATA_DIR: dir }, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    const open = tools.find(t => t.name === 'open_notepad');
    // SDK 1 exposes navigation icons through serverInfo (the documented fallback).
    assert.ok(client.getServerVersion().icons[0].src.startsWith('data:image/svg+xml;base64,'));
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    const opened = await client.callTool({ name: 'open_notepad', arguments: {} });
    assert.deepEqual(opened.structuredContent.notes, []);
    const resource = await client.readResource({ uri: open._meta.ui.resourceUri });
    assert.ok(resource.contents[0].text.includes('note-content'));
    const created = await client.callTool({ name: 'create_note', arguments: { title: 'MCP 测试', content: '持久内容' } });
    assert.equal(created.isError, undefined);
    const { id, version } = created.structuredContent.note;
    const updated = await client.callTool({ name: 'update_note', arguments: { id, version, content: '新内容' } });
    assert.equal(updated.structuredContent.note.content, '新内容');
    const conflict = await client.callTool({ name: 'update_note', arguments: { id, version, content: '过时内容' } });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent.error.code, 'CONFLICT');
    const trashed = await client.callTool({ name: 'trash_note', arguments: { id, version: 2 } });
    assert.ok(trashed.structuredContent.note.deletedAt);
    const restored = await client.callTool({ name: 'restore_note', arguments: { id, version: 3 } });
    assert.equal(restored.structuredContent.note.deletedAt, null);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
