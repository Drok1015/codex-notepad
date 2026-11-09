import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultDataDir = () => process.env.NOTEPAD_DATA_DIR || join(homedir(), '.local', 'share', 'codex-notepad');

export class NoteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class NoteStore {
  constructor(file = join(defaultDataDir(), 'notes.sqlite')) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS notes_order ON notes(deleted_at, pinned, updated_at);`);
    // Serialize schema migration across simultaneously starting MCP processes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL
      )`);
      if (!this.db.prepare('PRAGMA table_info(notes)').all().some(column => column.name === 'folder_id')) {
        this.db.exec('ALTER TABLE notes ADD COLUMN folder_id TEXT REFERENCES folders(id)');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder_id, deleted_at); COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  map(row) {
    return { id: row.id, title: row.title, content: row.content, pinned: !!row.pinned,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
      version: row.version, folderId: row.folder_id ?? null };
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!row) throw new NoteError('NOT_FOUND', '这篇笔记不存在。');
    return this.map(row);
  }
  list({ query = '', trash = false, folderId } = {}) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const folderFilter = folderId === undefined ? '' : folderId === null ? ' AND folder_id IS NULL' : ' AND folder_id = ?';
    const params = [`%${escaped}%`, `%${escaped}%`];
    if (typeof folderId === 'string') params.push(folderId);
    const rows = this.db.prepare(`SELECT * FROM notes WHERE deleted_at IS ${trash ? 'NOT NULL' : 'NULL'}
      AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${folderFilter}
      ORDER BY pinned DESC, updated_at DESC, id DESC`).all(...params);
    return rows.map(row => {
      const note = this.map(row);
      delete note.content;
      return { ...note, excerpt: row.content.slice(0, 140) };
    });
  }
  listFolders() {
    const folders = this.db.prepare(`SELECT f.*,count(CASE WHEN n.deleted_at IS NULL THEN n.id END) AS note_count,
      count(n.id) AS total_note_count FROM folders f
      LEFT JOIN notes n ON n.folder_id=f.id
      GROUP BY f.id ORDER BY f.created_at,f.id`).all()
      .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, noteCount: row.note_count, totalNoteCount: row.total_note_count }));
    const counts = this.db.prepare(`SELECT
      count(CASE WHEN deleted_at IS NULL THEN 1 END) AS total,
      count(CASE WHEN deleted_at IS NULL AND folder_id IS NULL THEN 1 END) AS unfiled,
      count(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trash FROM notes`).get();
    return { folders, totalCount: counts.total, unfiledCount: counts.unfiled, trashCount: counts.trash };
  }
  validateFolderName(name) {
    name = name.trim();
    if (!name || name.length > 80) throw new NoteError('INVALID_FOLDER_NAME', '文件夹名称需要 1–80 个字符。');
    if (name === '未分类') throw new NoteError('INVALID_FOLDER_NAME', '「未分类」是默认分类，请使用其他名称。');
    return name;
  }
  createFolder({ name }) {
    name = this.validateFolderName(name);
    if (this.db.prepare('SELECT id FROM folders WHERE name=? COLLATE NOCASE').get(name)) {
      throw new NoteError('DUPLICATE_FOLDER', '同名文件夹已存在。');
    }
    const folder = { id: randomUUID(), name, createdAt: new Date().toISOString(), noteCount: 0 };
    try { this.db.prepare('INSERT INTO folders(id,name,created_at) VALUES(?,?,?)').run(folder.id, name, folder.createdAt); }
    catch (error) {
      if (this.db.prepare('SELECT id FROM folders WHERE name=? COLLATE NOCASE').get(name)) throw new NoteError('DUPLICATE_FOLDER', '同名文件夹已存在。');
      throw error;
    }
    return folder;
  }
  renameFolder({ id, expectedName, name }) {
    name = this.validateFolderName(name);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const folder = this.db.prepare('SELECT * FROM folders WHERE id=?').get(id);
      if (!folder) throw new NoteError('FOLDER_NOT_FOUND', '文件夹已不存在，请刷新后重试。');
      if (folder.name !== expectedName) throw new NoteError('FOLDER_CONFLICT', '文件夹已被其他窗口改名，请刷新后重试。');
      if (this.db.prepare('SELECT id FROM folders WHERE name=? COLLATE NOCASE AND id<>?').get(name, id)) {
        throw new NoteError('DUPLICATE_FOLDER', '同名文件夹已存在。');
      }
      this.db.prepare('UPDATE folders SET name=? WHERE id=?').run(name, id);
      this.db.exec('COMMIT');
      return { id, name, createdAt: folder.created_at };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deleteFolder({ id, expectedName, confirmed = false, expectedNoteCount }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const folder = this.db.prepare('SELECT * FROM folders WHERE id=?').get(id);
      if (!folder) throw new NoteError('FOLDER_NOT_FOUND', '文件夹已不存在，请刷新后重试。');
      if (folder.name !== expectedName) throw new NoteError('FOLDER_CONFLICT', '文件夹已被其他窗口改名，请刷新后重试。');
      // Include trashed notes: deleting a folder must not leave dangling classifications.
      const count = this.db.prepare('SELECT count(*) AS n FROM notes WHERE folder_id=?').get(id).n;
      if (count > 0 && (!confirmed || expectedNoteCount !== count)) {
        this.db.exec('COMMIT');
        return { requiresConfirmation: true, folder: { id, name: folder.name }, noteCount: count };
      }
      // Keep content, dates and trash status; invalidate stale drafts in other windows.
      this.db.prepare('UPDATE notes SET folder_id=NULL,version=version+1 WHERE folder_id=?').run(id);
      this.db.prepare('DELETE FROM folders WHERE id=?').run(id);
      this.db.exec('COMMIT');
      return { deleted: true, folder: { id, name: folder.name }, movedNoteCount: count };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  checkFolder(folderId) {
    if (folderId !== null && !this.db.prepare('SELECT id FROM folders WHERE id=?').get(folderId)) {
      throw new NoteError('FOLDER_NOT_FOUND', '文件夹不存在，请刷新后重试。');
    }
  }
  create({ title = '', content = '', folderId = null } = {}) {
    this.checkFolder(folderId);
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO notes(id,title,content,created_at,updated_at,folder_id) VALUES(?,?,?,?,?,?)')
      .run(id, title, content, now, now, folderId);
    return this.get(id);
  }
  update({ id, version, title, content, pinned, deleted, folderId }) {
    const note = this.get(id);
    if (note.version !== version) throw new NoteError('CONFLICT', '笔记已在其他窗口更新。请先保留当前内容，再重新加载。');
    if (note.deletedAt && deleted !== false) throw new NoteError('IN_TRASH', '笔记已在回收站，请先恢复。');
    const nextFolderId = folderId === undefined ? note.folderId : folderId;
    this.checkFolder(nextFolderId);
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE notes SET title=?,content=?,pinned=?,deleted_at=?,updated_at=?,folder_id=?,version=version+1
      WHERE id=? AND version=?`).run(title ?? note.title, content ?? note.content, +(pinned ?? note.pinned),
      deleted === true ? now : deleted === false ? null : note.deletedAt, now, nextFolderId, id, version);
    if (!result.changes) throw new NoteError('CONFLICT', '笔记已在其他窗口更新。请先保留当前内容，再重新加载。');
    return this.get(id);
  }
}
