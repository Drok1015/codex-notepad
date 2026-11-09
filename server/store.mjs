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
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS notes_order ON notes(deleted_at, pinned, updated_at);`);
  }
  close() { this.db.close(); }
  map(row) {
    return { id: row.id, title: row.title, content: row.content, pinned: !!row.pinned,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
      version: row.version };
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!row) throw new NoteError('NOT_FOUND', '这篇笔记不存在。');
    return this.map(row);
  }
  list({ query = '', trash = false } = {}) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const rows = this.db.prepare(`SELECT * FROM notes WHERE deleted_at IS ${trash ? 'NOT NULL' : 'NULL'}
      AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
      ORDER BY pinned DESC, updated_at DESC, id DESC`).all(`%${escaped}%`, `%${escaped}%`);
    return rows.map(row => {
      const note = this.map(row);
      delete note.content;
      return { ...note, excerpt: row.content.slice(0, 140) };
    });
  }
  create({ title = '', content = '' } = {}) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO notes(id,title,content,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, title, content, now, now);
    return this.get(id);
  }
  update({ id, version, title, content, pinned, deleted }) {
    const note = this.get(id);
    if (note.version !== version) throw new NoteError('CONFLICT', '笔记已在其他窗口更新。请先保留当前内容，再重新加载。');
    if (note.deletedAt && deleted !== false) throw new NoteError('IN_TRASH', '笔记已在回收站，请先恢复。');
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE notes SET title=?,content=?,pinned=?,deleted_at=?,updated_at=?,version=version+1
      WHERE id=? AND version=?`).run(title ?? note.title, content ?? note.content, +(pinned ?? note.pinned),
      deleted === true ? now : deleted === false ? null : note.deletedAt, now, id, version);
    if (!result.changes) throw new NoteError('CONFLICT', '笔记已在其他窗口更新。请先保留当前内容，再重新加载。');
    return this.get(id);
  }
}
