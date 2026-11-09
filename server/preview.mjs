import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { NoteStore } from './store.mjs';
import { noteTools } from './tools.mjs';

// Loopback only; strict Host/Origin and a non-simple header block cross-site writes.
const port = Number(process.env.NOTEPAD_PORT || 43827);
const store = new NoteStore();
const tools = noteTools(store);
const html = readFileSync(new URL('../dist/app.html', import.meta.url));
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
  if (req.method === 'GET' && req.url === '/') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return;
  }
  if (req.method !== 'POST' || req.url !== '/api/tool') { res.writeHead(404).end(); return; }
  if (req.headers['x-notepad-client'] !== 'local' || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403).end(); return; }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 10_000_000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const { name, arguments: args } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const definition = Object.hasOwn(tools, name) ? tools[name] : null;
    if (!definition) throw new Error('未知操作');
    const data = await definition.run(definition.schema.parse(args));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ structuredContent: data }));
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ isError: true, structuredContent: { error: { code: error.code || 'ERROR', message: error.message } } }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`记事本：${origin}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
