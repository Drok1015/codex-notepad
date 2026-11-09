import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { readFileSync } from 'node:fs';
import { NoteStore } from './store.mjs';
import { noteTools } from './tools.mjs';

const icon = readFileSync(new URL('../assets/icon.svg', import.meta.url), 'utf8');
const icons = [{ src: `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }];
const server = new McpServer({ name: '记事本', version: '0.3.0', icons });
new OpenAIExtensions(server);
const store = new NoteStore();
const uri = 'ui://local-notepad/v2';
registerAppResource(server, '记事本', uri, {}, async () => ({ contents: [{
  uri, mimeType: RESOURCE_MIME_TYPE,
  text: readFileSync(new URL('./app.html', import.meta.url), 'utf8'),
  _meta: {
    ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen', 'pip'] },
  },
}] }));
registerAppTool(server, 'open_notepad', {
  title: '记事本', description: '打开本地记事本，浏览、编辑和搜索笔记。', inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: {
    ui: { resourceUri: uri },
    'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    'openai/outputTemplate': uri,
  },
}, async () => ({ content: [{ type: 'text', text: '本地记事本已打开。' }], structuredContent: { notes: store.list() } }));

for (const [name, tool] of Object.entries(noteTools(store))) {
  server.registerTool(name, {
    title: tool.title, description: tool.description, inputSchema: tool.schema,
    annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async (args) => {
    try {
      const data = await tool.run(args);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (err) {
      const error = { code: err.code || 'ERROR', message: err.message };
      return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { error } };
    }
  });
}
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { store.close(); });
