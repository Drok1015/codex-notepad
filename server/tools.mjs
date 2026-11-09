import { z } from 'zod';
import { writeClipboard } from './clipboard.mjs';

const title = z.string().max(500).describe('笔记标题，可留空');
const content = z.string().max(2_000_000).describe('笔记正文，支持 Markdown');
const id = z.string().uuid().describe('笔记 ID');
const version = z.number().int().positive().describe('上次读取笔记时的 version，防止覆盖其他窗口的修改');
const folderId = z.string().uuid().nullable().describe('文件夹 ID；null 表示未分类');

export function noteTools(store, { clipboard = writeClipboard } = {}) {
  return {
    list_folders: {
      title: '列出文件夹', description: '列出笔记文件夹及各文件夹的有效笔记数量，并返回未分类、全部笔记和回收站数量。',
      schema: z.object({}), readOnly: true, run: () => store.listFolders(),
    },
    create_folder: {
      title: '新建文件夹', description: '按用户要求创建本地笔记文件夹，名称不可为空或重复。',
      schema: z.object({ name: z.string().trim().min(1).max(80) }), run: args => ({ folder: store.createFolder(args) }),
    },
    copy_note: {
      title: '复制笔记正文', description: '将指定笔记的完整正文复制到本机剪贴板，保留原始 Markdown 与换行，不包含标题。仅在用户要求复制笔记时调用。',
      schema: z.object({ id }),
      run: async ({ id }) => {
        const note = store.get(id);
        if (note.deletedAt) throw new Error('这篇笔记已移入回收站，请先恢复。');
        await clipboard(note.content);
        return { copied: true, id: note.id, title: note.title };
      },
    },
    list_notes: {
      title: '搜索笔记', description: '列出或搜索本地笔记。返回标题、摘要和版本；要读取完整正文，调用 get_note。',
      schema: z.object({ query: z.string().max(500).default(''), trash: z.boolean().default(false), folderId: folderId.optional() }), readOnly: true,
      run: args => ({ notes: store.list(args) }),
    },
    get_note: {
      title: '读取笔记', description: '按 ID 读取一篇本地笔记的完整内容与当前版本。',
      schema: z.object({ id }), readOnly: true, run: ({ id }) => ({ note: store.get(id) }),
    },
    create_note: {
      title: '新建笔记', description: '按用户要求新建笔记，内容保存在本机。',
      schema: z.object({ title: title.default(''), content: content.default(''), folderId: folderId.optional() }),
      run: args => ({ note: store.create(args) }),
    },
    update_note: {
      title: '保存笔记', description: '更新标题、正文、置顶状态或 folderId（null 移回未分类）。必须使用最新 version；如有冲突，重新读取并核对用户意图，不能盲目重试覆盖。',
      schema: z.object({ id, version, title: title.optional(), content: content.optional(), pinned: z.boolean().optional(), folderId: folderId.optional() }),
      run: args => ({ note: store.update(args) }),
    },
    trash_note: {
      title: '移入回收站', description: '按用户要求将笔记移入回收站，之后可以恢复。不会永久删除。',
      schema: z.object({ id, version }), run: args => ({ note: store.update({ ...args, deleted: true }) }),
    },
    restore_note: {
      title: '恢复笔记', description: '从回收站恢复指定笔记。',
      schema: z.object({ id, version }), run: args => ({ note: store.update({ ...args, deleted: false }) }),
    },
  };
}
