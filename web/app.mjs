import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const $ = id => document.getElementById(id);
const state = { notes: [], current: null, dirty: false, saving: null, timer: null, trash: false, preview: false, busy: false, error: null, listGeneration: 0, gallery: true, copying: null };
let app, call;
const date = value => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(value));
const fullDate = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

function setStatus(message, error = false) { $('save-status').textContent = message; $('save-status').classList.toggle('error', error); }
function clearError() { state.error = null; $('error-banner').hidden = true; }
function showError(error) {
  state.error = error;
  $('error-message').textContent = error.message || '操作失败，请重试。';
  $('error-banner').hidden = false;
  const hasDraft = !!state.current && state.dirty;
  $('save-copy').hidden = !hasDraft;
  $('reload-note').hidden = !state.current;
  $('retry-save').hidden = !hasDraft || error.code === 'CONFLICT' || error.code === 'IN_TRASH';
  setStatus(hasDraft ? '尚未保存 · 当前内容已保留在编辑器' : '操作失败', true);
}

async function tool(name, args = {}) {
  const result = await call(name, args);
  if (result.isError || result.structuredContent?.error) {
    const detail = result.structuredContent?.error;
    const error = new Error(detail?.message || result.content?.find(x => x.type === 'text')?.text || '操作失败');
    error.code = detail?.code;
    throw error;
  }
  return result.structuredContent;
}

function renderList() {
  const list = $('note-list'); list.replaceChildren();
  $('note-count').textContent = state.notes.length;
  $('list-heading').textContent = state.trash ? '已删除的笔记' : ($('search').value ? '搜索结果' : '我的笔记');
  for (const note of state.notes) {
    const card = document.createElement('button'); card.className = 'note-card';
    card.classList.toggle('selected', note.id === state.current?.id); card.setAttribute('role', 'listitem');
    card.setAttribute('aria-current', note.id === state.current?.id ? 'true' : 'false');
    card.disabled = state.busy;
    const title = document.createElement('strong'); title.textContent = note.title || '无标题笔记';
    const excerpt = document.createElement('p'); excerpt.textContent = note.excerpt || '还没有内容';
    const time = document.createElement('time'); time.dateTime = note.updatedAt; time.textContent = date(note.updatedAt);
    if (note.pinned) { const pin = document.createElement('span'); pin.className = 'pin-label'; pin.textContent = '置顶'; card.append(pin); }
    card.append(title, excerpt, time); card.onclick = () => action(() => selectNote(note.id)); list.append(card);
  }
  if (!state.notes.length) {
    const empty = document.createElement('p'); empty.className = 'list-empty';
    empty.textContent = $('search').value ? '没有找到相关笔记' : state.trash ? '回收站是空的' : '还没有笔记\n点击上方，写下第一篇';
    list.append(empty);
  }
  renderGallery();
}

let toastTimer;
function showToast(message, failed = false) {
  clearTimeout(toastTimer);
  $('copy-toast').textContent = message; $('copy-toast').hidden = false;
  $('copy-toast').classList.toggle('failed', failed);
  toastTimer = setTimeout(() => { $('copy-toast').hidden = true; }, failed ? 6000 : 2600);
}

async function copyNote(note) {
  if (state.copying) return;
  state.copying = note.id; renderGallery();
  try {
    const result = await tool('copy_note', { id: note.id });
    if (!result?.copied) throw new Error('未能完成复制，请重试。');
    showToast(`✓ 已复制「${result.title || '无标题笔记'}」的正文`);
  } catch (error) { showToast(`复制失败：${error.message}`, true); }
  finally { state.copying = null; renderGallery(); }
}

function renderGallery() {
  $('gallery').hidden = !state.gallery;
  $('gallery-toggle').setAttribute('aria-pressed', String(state.gallery));
  const grid = $('gallery-grid'); grid.replaceChildren();
  $('gallery-count').textContent = state.notes.length;
  $('gallery-empty').hidden = !!state.notes.length;
  const searching = !!$('search').value;
  $('gallery-empty-title').textContent = searching ? '没有找到相关笔记' : '把常用的内容，放在手边。';
  $('gallery-empty-text').textContent = searching ? '换个关键词，再找找看。' : '新建一篇笔记，就会在这里生成卡片。';
  $('gallery-create').hidden = searching;
  if (!state.gallery) return;
  for (const note of state.notes) {
    const card = document.createElement('article'); card.className = 'gallery-card';
    const copy = document.createElement('button'); copy.className = 'gallery-copy';
    copy.setAttribute('aria-label', `复制笔记：${note.title || '无标题笔记'}`);
    copy.disabled = !!state.copying || state.busy;
    const label = document.createElement('span'); label.className = 'gallery-card-label'; label.textContent = note.pinned ? '置顶笔记' : '笔记';
    const title = document.createElement('h2'); title.textContent = note.title || '无标题笔记';
    const excerpt = document.createElement('p'); excerpt.textContent = note.excerpt || '这篇笔记还没有正文';
    const hint = document.createElement('span'); hint.className = 'gallery-copy-hint'; hint.textContent = state.copying === note.id ? '正在复制…' : '⧉ 点击复制正文';
    copy.append(label, title, excerpt, hint); copy.onclick = () => copyNote(note);
    const footer = document.createElement('footer');
    const time = document.createElement('time'); time.dateTime = note.updatedAt; time.textContent = date(note.updatedAt);
    const edit = document.createElement('button'); edit.className = 'gallery-edit'; edit.textContent = '编辑 ↗';
    edit.setAttribute('aria-label', `编辑笔记：${note.title || '无标题笔记'}`); edit.disabled = state.busy || !!state.copying;
    edit.onclick = () => action(() => selectNote(note.id));
    footer.append(time, edit); card.append(copy, footer); grid.append(card);
  }
}

async function refresh() {
  const generation = ++state.listGeneration;
  const result = await tool('list_notes', { query: $('search').value, trash: state.trash });
  if (generation !== state.listGeneration) return;
  state.notes = result.notes; renderList();
}

function renderPreview() {
  const html = marked.parse($('note-content').value, { async: false, breaks: true });
  $('markdown-preview').innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'input', 'form'] });
  for (const link of $('markdown-preview').querySelectorAll('a')) {
    link.addEventListener('click', async event => {
      event.preventDefault();
      const url = link.getAttribute('href');
      if (!/^https?:\/\//i.test(url || '')) return;
      if (app) await app.openLink({ url }); else window.open(url, '_blank', 'noopener,noreferrer');
    });
  }
}

function renderEditor(note) {
  state.gallery = !note && !state.trash;
  renderGallery();
  $('empty').hidden = !!note || state.gallery; $('editor').hidden = !note;
  $('current-label').textContent = note ? note.title || '无标题笔记' : state.gallery ? '卡片画廊' : '回收站';
  for (const id of ['preview-toggle', 'export-note']) $(id).hidden = !note;
  for (const id of ['pin-note', 'trash-note']) $(id).hidden = !note || !!note.deletedAt;
  $('restore-note').hidden = !note?.deletedAt;
  if (!note) { $('word-count').textContent = '把思绪留在这里'; return; }
  $('note-title').value = note.title; $('note-content').value = note.content;
  $('note-title').readOnly = !!note.deletedAt; $('note-content').readOnly = !!note.deletedAt;
  $('pin-note').textContent = note.pinned ? '取消置顶' : '置顶'; $('pin-note').setAttribute('aria-pressed', String(note.pinned));
  $('note-date').textContent = fullDate(note.updatedAt);
  $('word-count').textContent = `${Array.from(note.content).length.toLocaleString('zh-CN')} 字`;
  state.preview = false; updatePreview();
  setStatus(note.deletedAt ? '在回收站中 · 恢复后可以继续编辑' : '✓ 所有更改已保存');
}

async function save() {
  clearTimeout(state.timer);
  if (state.saving) { await state.saving; if (state.dirty) return save(); return; }
  if (!state.dirty || !state.current || state.current.deletedAt) return;
  if (state.error?.code === 'CONFLICT' || state.error?.code === 'IN_TRASH') throw state.error;
  const snapshot = { id: state.current.id, version: state.current.version, title: $('note-title').value, content: $('note-content').value };
  state.dirty = false; setStatus('正在保存…');
  state.saving = (async () => {
    try {
      const { note } = await tool('update_note', snapshot);
      state.current = note;
      $('current-label').textContent = note.title || '无标题笔记';
      $('note-date').textContent = fullDate(note.updatedAt);
      clearError(); setStatus(state.dirty ? '有未保存的更改…' : '✓ 所有更改已保存');
    } catch (error) { state.dirty = true; showError(error); throw error; }
  })();
  try { await state.saving; } finally { state.saving = null; }
  if (state.dirty) return save();
  // A list reload failure must not mark an already-saved draft as unsaved.
  try { await refresh(); } catch (error) { showError(error); }
}

async function action(fn) {
  if (state.busy) return;
  state.busy = true;
  $('note-title').readOnly = true; $('note-content').readOnly = true;
  for (const id of ['new-note', 'empty-create', 'gallery-create', 'gallery-toggle', 'pin-note', 'trash-note', 'restore-note', 'active-filter', 'trash-filter', 'save-copy', 'reload-note']) $(id).disabled = true;
  renderList();
  try { await fn(); } catch (error) { showError(error); }
  finally {
    state.busy = false;
    $('note-title').readOnly = !!state.current?.deletedAt; $('note-content').readOnly = !!state.current?.deletedAt;
    for (const id of ['new-note', 'empty-create', 'gallery-create', 'gallery-toggle', 'pin-note', 'trash-note', 'restore-note', 'active-filter', 'trash-filter', 'save-copy', 'reload-note']) $(id).disabled = false;
    renderList();
  }
}

async function selectNote(id) {
  await save();
  const { note } = await tool('get_note', { id });
  state.current = note; state.dirty = false; clearError(); renderEditor(note); renderList();
}

async function newNote() {
  await save();
  const { note } = await tool('create_note', { title: '', content: '' });
  state.current = note; state.dirty = false; clearError(); state.trash = false; $('search').value = '';
  renderFilters(); renderEditor(note); await refresh(); $('note-title').focus();
}

function renderFilters() {
  $('empty-create').hidden = state.trash;
  for (const [id, active] of [['active-filter', !state.trash], ['trash-filter', state.trash]]) {
    $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active));
  }
}

async function switchFilter(trash) {
  await save(); state.trash = trash; state.current = null; clearError();
  renderFilters(); renderEditor(null);
  $('empty-description').textContent = trash ? '删除的笔记暂存在这里，可以随时恢复。' : '选择一篇笔记，或开始一段新的记录。';
  $('empty-create').hidden = trash; await refresh();
}

function onEdit() {
  if (!state.current || state.current.deletedAt) return;
  state.dirty = true;
  if (!state.error) setStatus('有未保存的更改…');
  $('word-count').textContent = `${Array.from($('note-content').value).length.toLocaleString('zh-CN')} 字`;
  clearTimeout(state.timer);
  if (state.error?.code !== 'CONFLICT' && state.error?.code !== 'IN_TRASH') state.timer = setTimeout(() => save().catch(() => {}), 650);
}

function updatePreview() {
  $('note-content').hidden = state.preview; $('markdown-preview').hidden = !state.preview;
  $('preview-toggle').setAttribute('aria-pressed', String(state.preview)); $('preview-toggle').textContent = state.preview ? '编辑' : '预览';
  if (state.preview) renderPreview();
}

function exportNote() {
  if (!state.current) return;
  const title = $('note-title').value || '无标题笔记';
  const blob = new Blob([`# ${title}\n\n${$('note-content').value}\n`], { type: 'text/markdown;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) + '.md';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

$('new-note').onclick = $('empty-create').onclick = () => action(newNote);
$('gallery-create').onclick = () => action(newNote);
$('gallery-toggle').onclick = () => action(() => switchFilter(false));
$('active-filter').onclick = () => action(() => switchFilter(false));
$('trash-filter').onclick = () => action(() => switchFilter(true));
$('note-title').oninput = $('note-content').oninput = onEdit;
$('preview-toggle').onclick = () => { state.preview = !state.preview; updatePreview(); };
$('export-note').onclick = exportNote;
$('refresh').onclick = () => action(refresh);
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); state.listGeneration++; searchTimer = setTimeout(() => refresh().catch(showError), 160); };
$('pin-note').onclick = () => action(async () => {
  await save(); const { id, version, pinned } = state.current;
  const { note } = await tool('update_note', { id, version, pinned: !pinned });
  state.current = note; renderEditor(note); await refresh();
});
for (const [button, name] of [['trash-note', 'trash_note'], ['restore-note', 'restore_note']]) $(button).onclick = () => action(async () => {
  await save(); const { id, version } = state.current;
  await tool(name, { id, version }); state.current = null; renderEditor(null); clearError(); await refresh();
  setStatus(name === 'trash_note' ? '已移入回收站 · 可随时恢复' : '已恢复笔记');
});
$('retry-save').onclick = () => action(save);
$('reload-note').onclick = () => action(async () => {
  if (state.dirty && !window.confirm('重新加载会放弃编辑器里尚未保存的修改。建议先“另存为新笔记”。确定重新加载？')) return;
  // Keep the draft intact if the reload itself fails.
  const { note } = await tool('get_note', { id: state.current.id });
  clearTimeout(state.timer); state.current = note; state.dirty = false; clearError(); renderEditor(note); await refresh();
});
$('save-copy').onclick = () => action(async () => {
  clearTimeout(state.timer);
  const { note } = await tool('create_note', { title: ($('note-title').value || '无标题笔记').slice(0, 495) + '（副本）', content: $('note-content').value });
  state.current = note; state.dirty = false; state.trash = false; clearError(); renderFilters(); renderEditor(note); await refresh();
});
window.addEventListener('beforeunload', event => { if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); action(save); }
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); $('search').focus(); }
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); action(newNote); }
});

async function start() {
  // Standalone mode uses the same tool contracts for local preview and tests.
  if (window.parent === window) {
    call = async (name, args) => {
      const response = await fetch('/api/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Notepad-Client': 'local' }, body: JSON.stringify({ name, arguments: args }) });
      if (!response.ok) throw new Error('本地记事本连接失败。');
      return response.json();
    };
    await refresh(); setStatus('✓ 笔记保存在本机');
  } else {
    app = new App({ name: '记事本', version: '0.3.0' });
    new OpenAIExtensions(app);
    call = (name, args) => app.callServerTool({ name, arguments: args });
    app.ontoolresult = result => {
      if (!state.current && result.structuredContent?.notes && !state.trash && !$('search').value) {
        state.notes = result.structuredContent.notes; renderList();
      }
    };
    const theme = context => { if (context?.theme) document.documentElement.dataset.theme = context.theme; };
    app.onhostcontextchanged = theme;
    await app.connect(); theme(app.getHostContext());
    await refresh(); setStatus('✓ 笔记保存在本机');
  }
}
renderEditor(null);
start().catch(showError);
