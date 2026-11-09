import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore } from '../server/store.mjs';
import { noteTools } from '../server/tools.mjs';

test('笔记持久化、搜索、置顶和回收站恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notepad-store-'));
  let store;
  try {
    const file = join(dir, 'notes.sqlite'); store = new NoteStore(file);
    const first = store.create({ title: '工作 100%', content: '中文正文\n第二行 _ \\' });
    const second = store.create({ title: '另一个想法', content: '记录灵感' });
    assert.equal(store.list({ query: '中文' })[0].id, first.id);
    assert.equal(store.list({ query: '%' }).length, 1);
    assert.equal(store.list({ query: '_' }).length, 1);
    assert.equal(store.list({ query: '\\' }).length, 1);
    assert.equal(store.list({ query: "' OR 1=1 --" }).length, 0);
    const pinned = store.update({ id: first.id, version: 1, pinned: true });
    assert.equal(store.list()[0].id, first.id);
    assert.equal(pinned.version, 2);
    assert.equal('content' in store.list()[0], false);
    const deleted = store.update({ id: first.id, version: 2, deleted: true });
    assert.deepEqual(store.list().map(x => x.id), [second.id]);
    assert.equal(store.list({ trash: true })[0].id, first.id);
    assert.throws(() => store.update({ id: first.id, version: deleted.version, content: '不应覆盖' }), /请先恢复/);
    const restored = store.update({ id: first.id, version: deleted.version, deleted: false });
    assert.equal(restored.deletedAt, null);
    store.close(); store = new NoteStore(file);
    assert.equal(store.get(first.id).content, first.content);
    assert.equal(store.list().length, 2);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('多个窗口必须检测版本冲突，不能覆盖新版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notepad-concurrent-'));
  let a, b;
  try {
    a = new NoteStore(join(dir, 'notes.sqlite')); b = new NoteStore(join(dir, 'notes.sqlite'));
    const note = a.create({ title: '共享笔记', content: '原始内容' });
    const otherWindow = b.get(note.id);
    a.update({ id: note.id, version: note.version, content: '窗口 A 的新内容' });
    assert.throws(() => b.update({ id: note.id, version: otherWindow.version, content: '旧副本' }), error => error.code === 'CONFLICT');
    assert.equal(b.get(note.id).content, '窗口 A 的新内容');
  } finally { a?.close(); b?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('工具参数验证防止超长正文和无版本写入', () => {
  const store = new NoteStore(':memory:');
  try {
    const tools = noteTools(store);
    assert.equal(tools.create_note.schema.safeParse({ content: 'x'.repeat(2_000_001) }).success, false);
    assert.equal(tools.update_note.schema.safeParse({ id: 'bad-id', content: 'x' }).success, false);
    assert.equal(tools.create_note.schema.safeParse({ title: 'x'.repeat(501) }).success, false);
  } finally { store.close(); }
});

test('复制完整正文，不包含标题；回收站笔记不可复制', async () => {
  const store = new NoteStore(':memory:'); const copied = [];
  try {
    const tools = noteTools(store, { clipboard: async text => copied.push(text) });
    const note = store.create({ title: '不应复制标题', content: '# 正文\n\n' + '中文'.repeat(1000) });
    const result = await tools.copy_note.run({ id: note.id });
    assert.equal(result.copied, true);
    assert.equal(copied[0], note.content);
    assert.equal('content' in result, false);
    store.update({ id: note.id, version: 1, deleted: true });
    await assert.rejects(tools.copy_note.run({ id: note.id }), /回收站/);
    assert.equal(copied.length, 1);
  } finally { store.close(); }
});
