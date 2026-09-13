/* A very small router: enough for a JSON API and static files, no framework. */
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
  /* crawlers fetch these two, and octet-stream makes some of them skip the file */
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json'
};

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, rx, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }
}

export const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) throw Object.assign(new Error('That request is too large.'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Malformed JSON.'), { status: 400 }); }
}

export function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export async function serveStatic(res, rootDir, urlPath, req) {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = join(rootDir, rel);
  if (!file.startsWith(rootDir)) { res.writeHead(403).end('Forbidden'); return true; }
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const body = await readFile(file);
    /* The app ships as plain files with no build step or content hashing, so a
       cached copy of an older index.html/app.js is indistinguishable from a
       current one. Refuse to store them rather than hope for revalidation. */
    const ext = extname(file);
    const volatile = ext === '.html' || ext === '.js' || ext === '.css';

    /* The app ships as plain text with no build step — 330KB of it. Anything
       textual compresses about four to one, and gzipSync on a file this size
       costs a few milliseconds, so it is done per request rather than cached. */
    const TEXTUAL = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map']);
    const wantsGzip = /\bgzip\b/.test(req?.headers?.['accept-encoding'] || '');
    let out = body, encoding = null;
    if (wantsGzip && TEXTUAL.has(ext) && body.length > 1024) {
      out = gzipSync(body, { level: 6 });
      encoding = 'gzip';
    }

    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': out.length,
      ...(encoding ? { 'content-encoding': encoding, vary: 'accept-encoding' } : {}),
      'cache-control': volatile ? 'no-store, must-revalidate' : 'no-cache',
      ...(volatile ? { pragma: 'no-cache', expires: '0' } : {})
    });
    res.end(out);
    return true;
  } catch { return false; }
}
