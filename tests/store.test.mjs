import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore } from '../server/store.mjs';
import { noteTools } from '../server/tools.mjs';
import { DatabaseSync } from 'node:sqlite';

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

test('旧数据库自动迁移，保留原笔记全部数据并归入未分类', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notepad-migration-')); let store;
  try {
    const file = join(dir, 'notes.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1)`);
    old.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)').run('legacy', '原笔记', '中文\nMarkdown **内容**', 1, '2026-01-01', '2026-02-01', null, 7);
    const before = old.prepare('SELECT * FROM notes').get(); old.close();
    store = new NoteStore(file);
    assert.equal(store.get('legacy').folderId, null);
    const after = store.db.prepare('SELECT * FROM notes').get();
    delete after.folder_id; assert.deepEqual(after, before);
    assert.equal(store.list({ folderId: null }).length, 1);
    store.close(); store = new NoteStore(file);
    assert.equal(store.get('legacy').version, 7);
    assert.equal(store.listFolders().unfiledCount, 1);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('文件夹分类、未分类、数量统计、移动与回收站恢复', () => {
  const store = new NoteStore(':memory:');
  try {
    const work = store.createFolder({ name: '  工作  ' });
    const ideas = store.createFolder({ name: '灵感' });
    assert.equal(work.name, '工作');
    assert.throws(() => store.createFolder({ name: '工作' }), error => error.code === 'DUPLICATE_FOLDER');
    assert.throws(() => store.createFolder({ name: '   ' }), /名称/);
    assert.throws(() => store.createFolder({ name: '未分类' }), /默认分类/);
    const a = store.create({ title: '周报', content: '正文', folderId: work.id });
    const b = store.create({ title: '未分类笔记' });
    assert.equal(store.list().length, 2);
    assert.deepEqual(store.list({ folderId: work.id }).map(n => n.id), [a.id]);
    assert.equal(store.list({ folderId: work.id, query: '找不到' }).length, 0);
    assert.equal(store.list({ folderId: null })[0].id, b.id);
    assert.equal(store.listFolders().folders.find(f => f.id === work.id).noteCount, 1);
    assert.throws(() => store.update({ id: a.id, version: 1, folderId: 'missing' }), error => error.code === 'FOLDER_NOT_FOUND');
    assert.equal(store.get(a.id).version, 1);
    const moved = store.update({ id: a.id, version: 1, folderId: ideas.id });
    assert.equal(moved.content, '正文');
    assert.throws(() => store.update({ id: a.id, version: 1, folderId: null }), error => error.code === 'CONFLICT');
    const deleted = store.update({ id: a.id, version: moved.version, deleted: true });
    assert.equal(store.listFolders().folders.find(f => f.id === ideas.id).noteCount, 0);
    assert.equal(store.listFolders().trashCount, 1);
    assert.equal(store.list({ trash: true })[0].folderId, ideas.id);
    const restored = store.update({ id: a.id, version: deleted.version, deleted: false });
    assert.equal(restored.folderId, ideas.id);
    const unfiled = store.update({ id: a.id, version: restored.version, folderId: null });
    assert.equal(unfiled.folderId, null);
    assert.equal(store.listFolders().unfiledCount, 2);
    assert.equal(store.listFolders().totalCount, 2);
  } finally { store.close(); }
});

test('文件夹改名校验重名和并发名称，不改动笔记本身', () => {
  const store = new NoteStore(':memory:');
  try {
    const a = store.createFolder({ name: '工作' }); store.createFolder({ name: '灵感' });
    const note = store.create({ title: '原笔记', content: '保留内容', folderId: a.id });
    const renamed = store.renameFolder({ id: a.id, expectedName: '工作', name: '  项目资料  ' });
    assert.equal(renamed.name, '项目资料');
    assert.deepEqual(store.get(note.id), note);
    assert.throws(() => store.renameFolder({ id: a.id, expectedName: '工作', name: '其他' }), error => error.code === 'FOLDER_CONFLICT');
    assert.throws(() => store.renameFolder({ id: a.id, expectedName: '项目资料', name: '灵感' }), error => error.code === 'DUPLICATE_FOLDER');
    assert.throws(() => store.renameFolder({ id: a.id, expectedName: '项目资料', name: '未分类' }), /默认分类/);
    assert.throws(() => store.deleteFolder({ id: a.id, expectedName: '工作' }), error => error.code === 'FOLDER_CONFLICT');
    assert.equal(store.listFolders().folders.length, 2);
  } finally { store.close(); }
});

test('非空文件夹删除需确认最新数量，保留正文、日期、置顶与回收站状态', () => {
  const store = new NoteStore(':memory:');
  try {
    const folder = store.createFolder({ name: '工作' });
    const a = store.create({ title: '正文 A', content: 'Markdown **A**', folderId: folder.id });
    const b = store.create({ title: '正文 B', content: '正文 B', folderId: folder.id });
    const trashed = store.update({ id: b.id, version: b.version, deleted: true });
    const request = { id: folder.id, expectedName: folder.name };
    const pending = store.deleteFolder(request);
    assert.equal(pending.requiresConfirmation, true); assert.equal(pending.noteCount, 2);
    assert.deepEqual(store.get(a.id), a);
    assert.equal(store.listFolders().folders[0].totalNoteCount, 2);
    const added = store.create({ title: '确认期间新增', folderId: folder.id });
    const changed = store.deleteFolder({ ...request, confirmed: true, expectedNoteCount: 2 });
    assert.equal(changed.requiresConfirmation, true); assert.equal(changed.noteCount, 3);
    assert.equal(store.get(a.id).folderId, folder.id);
    const result = store.deleteFolder({ ...request, confirmed: true, expectedNoteCount: 3 });
    assert.equal(result.deleted, true); assert.equal(result.movedNoteCount, 3);
    assert.equal(store.listFolders().folders.length, 0);
    for (const before of [a, trashed, added]) {
      const after = store.get(before.id);
      assert.deepEqual(after, { ...before, folderId: null, version: before.version + 1 });
    }
    assert.throws(() => store.update({ id: a.id, version: a.version, content: '旧草稿' }), error => error.code === 'CONFLICT');
    const restored = store.update({ id: trashed.id, version: trashed.version + 1, deleted: false });
    assert.equal(restored.folderId, null); assert.equal(restored.content, trashed.content);
    assert.equal(store.list().length, 3);
  } finally { store.close(); }
});

test('空文件夹直接删除，只有回收站笔记的文件夹仍需确认', () => {
  const store = new NoteStore(':memory:');
  try {
    const empty = store.createFolder({ name: '空文件夹' });
    assert.equal(store.deleteFolder({ id: empty.id, expectedName: empty.name }).deleted, true);
    const folder = store.createFolder({ name: '已归档' });
    const note = store.create({ folderId: folder.id });
    store.update({ id: note.id, version: note.version, deleted: true });
    assert.equal(store.listFolders().folders[0].noteCount, 0);
    const result = store.deleteFolder({ id: folder.id, expectedName: folder.name });
    assert.equal(result.requiresConfirmation, true); assert.equal(result.noteCount, 1);
    assert.equal(store.get(note.id).folderId, folder.id);
  } finally { store.close(); }
});
