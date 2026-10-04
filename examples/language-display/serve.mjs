import {readFile, readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
const root = new URL('./', import.meta.url), source = new URL('../../src/', import.meta.url);
const files = new Map([['/', ['browser.html', 'text/html; charset=utf-8']], ...['browser.mjs', 'plugin.mjs'].map(name => ['/' + name, [name, 'text/javascript; charset=utf-8']])]);
const modules = new Set((await readdir(source)).filter(name => /^[a-z0-9-]+\.mjs$/.test(name)));
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') {response.writeHead(405).end(); return;}
    let entry = files.get(request.url), base = root;
    if (!entry && request.url.startsWith('/sdk/') && modules.has(request.url.slice(5))) {entry = [request.url.slice(5), 'text/javascript; charset=utf-8']; base = source;}
    if (!entry) {response.writeHead(404).end(); return;}
    const body = await readFile(new URL(entry[0], base));
    response.writeHead(200, {'content-type': entry[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}).end(body);
  } catch {response.writeHead(404).end();}
});
await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
console.log('Language display example: http://127.0.0.1:' + server.address().port);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {server.close(); server.closeAllConnections();});
