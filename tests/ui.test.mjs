import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { NoteStore } from '../server/store.mjs';
import { noteTools } from '../server/tools.mjs';

const bundle = (await build({ entryPoints: ['web/app.mjs'], bundle: true, format: 'iife', platform: 'browser', write: false })).outputFiles[0].text;
const html = (await readFile('web/index.html', 'utf8')).replace(/<script[\s\S]*?<\/script>/, '');

test('交付 HTML 中的内嵌脚本语法完整', async () => {
  const built = await readFile('dist/app.html', 'utf8');
  const source = built.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.equal(source.includes('/* APP_SCRIPT */'), false);
  await transform(source, { loader: 'js' });
});

async function until(fn, message = '等待界面更新超时') {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 15)); }
}

function setup(intercept, clipboard) {
  const store = new NoteStore(':memory:');
  const copies = [];
  const tools = noteTools(store, { clipboard: clipboard || (async text => { copies.push(text); }) });
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:43827/', runScripts: 'outside-only' });
  const { window } = dom;
  window.fetch = async (_url, options) => {
    const { name, arguments: args } = JSON.parse(options.body);
    await intercept?.(name, args);
    let data;
    try { data = { structuredContent: await tools[name].run(tools[name].schema.parse(args)) }; }
    catch (error) { data = { isError: true, structuredContent: { error: { code: error.code, message: error.message } } }; }
    return { ok: true, json: async () => data };
  };
  window.eval(bundle);
  const $ = id => window.document.getElementById(id);
  const edit = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  return { store, tools, dom, window, $, edit, copies, close() { window.close(); store.close(); } };
}

test('画廊复制最新完整正文，保留 Markdown 与换行，编辑按钮不触发复制', async () => {
  const s = setup(); const { $, store, edit, copies } = s;
  try {
    const old = store.create({ title: '常用提示词', content: '原正文' });
    store.create({ title: '另一个笔记', content: '内容 B' });
    await until(() => $('gallery-grid').children.length === 2);
    assert.equal($('gallery').hidden, false);
    edit('search', '常用'); await until(() => $('gallery-grid').children.length === 1);
    const content = '# 完整正文\n\n' + '中文段落。\n'.repeat(120) + '\n**结尾不能截断**';
    store.update({ id: old.id, version: old.version, content });
    $('gallery-grid').querySelector('.gallery-copy').click();
    await until(() => copies.length === 1 && !$('copy-toast').hidden);
    assert.equal(copies[0], content);
    assert.match($('copy-toast').textContent, /已复制.*常用提示词/);
    $('gallery-grid').querySelector('.gallery-edit').click();
    await until(() => !$('editor').hidden && !$('new-note').disabled);
    assert.equal($('note-content').value, content);
    assert.equal(copies.length, 1);
    edit('note-content', '修改后回到画廊');
    $('gallery-toggle').click();
    await until(() => !$('gallery').hidden && !$('new-note').disabled);
    assert.equal(store.get(old.id).content, '修改后回到画廊');
    edit('search', '不存在'); await until(() => $('gallery-grid').children.length === 0);
    assert.equal($('gallery-empty-title').textContent, '没有找到相关笔记');
  } finally { s.close(); }
});

test('复制失败不显示成功，卡片可再次点击重试', async () => {
  let fail = true;
  const s = setup(undefined, async () => { if (fail) throw new Error('剪贴板暂不可用'); });
  const { $, store } = s;
  try {
    store.create({ title: '复制测试', content: '正文' });
    await until(() => $('gallery-grid').children.length === 1);
    $('gallery-grid').querySelector('.gallery-copy').click();
    await until(() => $('copy-toast').textContent.includes('复制失败'));
    assert.equal($('copy-toast').classList.contains('failed'), true);
    assert.equal($('gallery-grid').querySelector('.gallery-copy').disabled, false);
    fail = false;
    $('gallery-grid').querySelector('.gallery-copy').click();
    await until(() => $('copy-toast').textContent.includes('已复制'));
    assert.equal($('copy-toast').classList.contains('failed'), false);
    assert.equal(store.list().length, 1);
  } finally { s.close(); }
});

test('新建文件夹、归类、筛选、在文件夹中新建笔记及重复名称提示', async () => {
  const s = setup(); const { $, store, window } = s;
  try {
    const note = store.create({ title: '待整理', content: '不能丢失的正文' });
    await until(() => $('gallery-grid').children.length === 1);
    $('new-folder').click(); assert.equal($('folder-form').hidden, false);
    $('folder-name').value = '工作';
    $('folder-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => store.listFolders().folders.length === 1 && !$('new-note').disabled);
    const folder = store.listFolders().folders[0];
    assert.equal($('gallery-title').textContent, '工作');
    assert.equal($('gallery-grid').children.length, 0);
    $('active-filter').click(); await until(() => $('gallery-grid').children.length === 1 && !$('new-note').disabled);
    const select = $('gallery-grid').querySelector('select'); select.value = folder.id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => store.get(note.id).folderId === folder.id && !$('new-note').disabled);
    assert.equal(s.copies.length, 0);
    $('folder-list').querySelector('[aria-label="文件夹：未分类"]').click();
    await until(() => $('gallery-title').textContent === '未分类' && !$('new-note').disabled);
    assert.equal($('gallery-grid').children.length, 0);
    $('folder-list').querySelector('[aria-label="文件夹：工作"]').click();
    await until(() => $('gallery-grid').children.length === 1 && !$('new-note').disabled);
    $('new-note').click(); await until(() => !$('editor').hidden && !$('new-note').disabled);
    const added = store.list().find(n => n.id !== note.id); assert.equal(added.folderId, folder.id);
    $('new-folder').click(); $('folder-name').value = '工作';
    $('folder-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !$('folder-error').hidden && !$('new-note').disabled);
    assert.match($('folder-error').textContent, /同名/);
    assert.equal(store.listFolders().folders.length, 1);
    assert.equal(store.get(note.id).content, '不能丢失的正文');
  } finally { s.close(); }
});

test('卡片回收站按钮不会触发复制，恢复后保留原文件夹', async () => {
  const s = setup(); const { $, store } = s;
  try {
    const folder = store.createFolder({ name: '工作' });
    const note = store.create({ title: '卡片删除', content: '保留的内容', folderId: folder.id });
    await until(() => $('gallery-grid').children.length === 1);
    $('gallery-grid').querySelector('.gallery-trash').click();
    await until(() => !!store.get(note.id).deletedAt && !$('new-note').disabled);
    assert.equal(s.copies.length, 0);
    assert.equal($('gallery-grid').children.length, 0);
    assert.match($('copy-toast').textContent, /移入回收站/);
    $('trash-filter').click(); await until(() => $('note-list').querySelector('.note-card') && !$('new-note').disabled);
    $('note-list').querySelector('.note-card').click(); await until(() => !$('restore-note').hidden && !$('new-note').disabled);
    assert.equal($('note-folder').disabled, true);
    $('restore-note').click(); await until(() => !store.get(note.id).deletedAt && !$('new-note').disabled);
    assert.equal(store.get(note.id).folderId, folder.id);
    assert.equal(store.get(note.id).content, '保留的内容');
  } finally { s.close(); }
});

test('编辑器移动文件夹前保存草稿，归类与内容同时保留', async () => {
  const s = setup(); const { $, store, edit, window } = s;
  try {
    const folder = store.createFolder({ name: '灵感' });
    const note = store.create({ title: '原笔记', content: '原始内容' });
    await until(() => $('gallery-grid').children.length === 1);
    $('gallery-grid').querySelector('.gallery-edit').click();
    await until(() => !$('editor').hidden && !$('new-note').disabled);
    edit('note-content', '尚未自动保存的修改');
    $('note-folder').value = folder.id; $('note-folder').dispatchEvent(new window.Event('change', { bubbles: true }));
    await until(() => store.get(note.id).folderId === folder.id && !$('new-note').disabled);
    assert.equal(store.get(note.id).content, '尚未自动保存的修改');
    assert.equal($('note-folder').value, folder.id);
    assert.equal($('error-banner').hidden, true);
  } finally { s.close(); }
});

test('界面新建、自动保存、安全预览、搜索、回收与恢复', async () => {
  const s = setup(); const { $, edit, store } = s;
  try {
    await until(() => $('save-status').textContent.includes('本机'));
    $('new-note').click(); await until(() => !$('editor').hidden && !$('new-note').disabled);
    edit('note-title', '我的第一篇'); edit('note-content', '# 测试\n\n正文 <script>alert(1)</script>\n<img src="https://example.com/tracker" onerror="alert(1)">');
    await until(() => store.list()[0]?.title === '我的第一篇');
    $('preview-toggle').click();
    assert.equal($('markdown-preview').querySelectorAll('script,img').length, 0);
    assert.equal($('markdown-preview').querySelector('h1').textContent, '测试');
    $('pin-note').click(); await until(() => store.list()[0]?.pinned && !$('new-note').disabled);
    edit('search', '找不到'); await until(() => $('note-count').textContent === '0');
    edit('search', '第一篇'); await until(() => $('note-count').textContent === '1');
    $('trash-note').click(); await until(() => store.list().length === 0 && !$('new-note').disabled);
    $('trash-filter').click(); await until(() => $('note-list').querySelector('.note-card') && !$('new-note').disabled);
    $('note-list').querySelector('.note-card').click(); await until(() => !$('restore-note').hidden && !$('new-note').disabled);
    assert.equal($('note-content').readOnly, true);
    $('restore-note').click(); await until(() => store.list().length === 1 && !$('new-note').disabled);
    assert.equal(store.get(store.list()[0].id).title, '我的第一篇');
  } finally { s.close(); }
});

test('冲突保留编辑器内容，阻止自动覆盖，并可另存副本', async () => {
  const s = setup(); const { $, edit, store } = s;
  try {
    await until(() => $('save-status').textContent.includes('本机'));
    $('new-note').click(); await until(() => !$('editor').hidden && !$('new-note').disabled);
    const original = store.list()[0];
    store.update({ id: original.id, version: 1, content: '另一个窗口的修改' });
    edit('note-content', '当前窗口尚未保存的草稿');
    await until(() => !$('error-banner').hidden);
    assert.equal($('note-content').value, '当前窗口尚未保存的草稿');
    assert.equal(store.get(original.id).content, '另一个窗口的修改');
    $('new-note').click(); await until(() => !$('new-note').disabled);
    assert.equal(store.list().length, 1);
    assert.equal($('note-content').value, '当前窗口尚未保存的草稿');
    $('save-copy').click(); await until(() => store.list().length === 2 && !$('new-note').disabled);
    assert.equal(store.list().some(note => store.get(note.id).content === '当前窗口尚未保存的草稿'), true);
    assert.equal(store.get(original.id).content, '另一个窗口的修改');
    assert.equal($('error-banner').hidden, true);
  } finally { s.close(); }
});

test('保存请求进行中继续输入，后续内容仍会保存', async () => {
  let release, held = false;
  const s = setup(async name => {
    if (name === 'update_note' && !held) { held = true; await new Promise(resolve => { release = resolve; }); }
  });
  const { $, edit, store } = s;
  try {
    await until(() => $('save-status').textContent.includes('本机'));
    $('new-note').click(); await until(() => !$('editor').hidden && !$('new-note').disabled);
    edit('note-content', '第一段'); await until(() => release);
    edit('note-content', '第一段\n保存过程中补充的第二段');
    release();
    await until(() => store.get(store.list()[0].id).content.includes('第二段'));
    assert.equal($('note-content').value, '第一段\n保存过程中补充的第二段');
    await until(() => $('save-status').textContent.includes('所有更改已保存'));
  } finally { s.close(); }
});
