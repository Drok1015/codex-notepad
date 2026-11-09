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
    assert.ok(resource.contents[0].text.includes('folder-list'));
    const folderResult = await client.callTool({ name: 'create_folder', arguments: { name: '工作' } });
    const folderId = folderResult.structuredContent.folder.id;
    const created = await client.callTool({ name: 'create_note', arguments: { title: 'MCP 测试', content: '持久内容', folderId } });
    assert.equal(created.isError, undefined);
    const { id, version } = created.structuredContent.note;
    assert.equal(created.structuredContent.note.folderId, folderId);
    const renamed = await client.callTool({ name: 'rename_folder', arguments: { id: folderId, expectedName: '工作', name: '项目资料' } });
    assert.equal(renamed.structuredContent.folder.name, '项目资料');
    const pending = await client.callTool({ name: 'delete_folder', arguments: { id: folderId, expectedName: '项目资料' } });
    assert.equal(pending.structuredContent.requiresConfirmation, true);
    assert.equal(pending.structuredContent.noteCount, 1);
    const folders = await client.callTool({ name: 'list_folders', arguments: {} });
    assert.equal(folders.structuredContent.folders[0].noteCount, 1);
    const filtered = await client.callTool({ name: 'list_notes', arguments: { folderId } });
    assert.equal(filtered.structuredContent.notes[0].id, id);
    const updated = await client.callTool({ name: 'update_note', arguments: { id, version, content: '新内容', folderId: null } });
    assert.equal(updated.structuredContent.note.content, '新内容');
    assert.equal(updated.structuredContent.note.folderId, null);
    const deletedFolder = await client.callTool({ name: 'delete_folder', arguments: { id: folderId, expectedName: '项目资料' } });
    assert.equal(deletedFolder.structuredContent.deleted, true);
    const conflict = await client.callTool({ name: 'update_note', arguments: { id, version, content: '过时内容' } });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent.error.code, 'CONFLICT');
    const trashed = await client.callTool({ name: 'trash_note', arguments: { id, version: 2 } });
    assert.ok(trashed.structuredContent.note.deletedAt);
    const restored = await client.callTool({ name: 'restore_note', arguments: { id, version: 3 } });
    assert.equal(restored.structuredContent.note.deletedAt, null);
    const second = await client.callTool({ name: 'create_folder', arguments: { name: '归档' } });
    const secondId = second.structuredContent.folder.id;
    await client.callTool({ name: 'update_note', arguments: { id, version: 4, folderId: secondId } });
    const confirmed = await client.callTool({ name: 'delete_folder', arguments: { id: secondId, expectedName: '归档', confirmed: true, expectedNoteCount: 1 } });
    assert.equal(confirmed.structuredContent.deleted, true);
    const preserved = await client.callTool({ name: 'get_note', arguments: { id } });
    assert.equal(preserved.structuredContent.note.content, '新内容');
    assert.equal(preserved.structuredContent.note.folderId, null);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
