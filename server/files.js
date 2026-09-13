import { createWriteStream, createReadStream, unlink, statSync } from 'node:fs';
import { join } from 'node:path';
import { q, now, uid, FILES_DIR } from './db.js';

/* 25MB. Big enough for a phone clip of a whiteboard or a problem-set PDF,
   small enough that one careless upload cannot fill a laptop's disk. */
export const FILE_MAX = 25 * 1024 * 1024;

/* Types the browser may render in place.

   Everything absent from this list is handed over as a download, because an
   attachment is served from our own origin: an HTML or SVG file rendered
   inline would run its own script against the signed-in session. SVG is an
   image and is deliberately still not on this list for that reason. */
const INLINE_OK = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac',
  'application/pdf', 'text/plain'
]);
export const inlineOk = (mime) => INLINE_OK.has(String(mime || '').toLowerCase());

/* The name is only ever displayed — the generated row id is the filename on
   disk, so nothing a user typed reaches a path. Strip separators and control
   characters anyway, so none of it can reach a response header or a log line. */
export function cleanName(raw) {
  const n = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (n || 'attachment').slice(0, 120);
}

/* RFC 5987: keep a plain ASCII fallback and give the real name separately, so
   a quote or a non-Latin filename cannot break out of the header. */
function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const fileRow = (id) => q.get('SELECT id,name,mime,size,w,h FROM files WHERE id = ?', id);

/* Yours, or attached to a message you are already allowed to read. */
export const fileReachable = (fileId, userId) =>
  !!q.get('SELECT 1 FROM files WHERE id = ? AND owner_id = ?', fileId, userId)
  || !!q.get(`SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id
              JOIN squad_members sm ON sm.squad_id = c.squad_id
              WHERE m.file_id = ? AND sm.user_id = ?`, fileId, userId)
  || !!q.get(`SELECT 1 FROM dm_messages m JOIN dm_threads t ON t.id = m.thread_id
              WHERE m.file_id = ? AND (t.a_id = ? OR t.b_id = ?)`, fileId, userId, userId);

/* ---------- upload ----------
   Raw bytes on the request stream, not base64 in JSON: base64 costs a third
   more on the wire and would have to be buffered whole before it could be
   written anywhere. */
export function saveUpload(req, user, params) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    const fail = (status, message) => reject(Object.assign(new Error(message), { status }));
    if (declared > FILE_MAX) return fail(413, `That file is too large — ${Math.round(FILE_MAX / 1048576)}MB is the limit.`);

    const id = uid('f_');
    const path = join(FILES_DIR, id);
    const out = createWriteStream(path);
    let size = 0, done = false;

    const scrap = (status, message) => {
      if (done) return; done = true;
      req.unpipe?.(out); out.destroy();
      unlink(path, () => {});
      fail(status, message);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      /* check as it arrives — content-length is the client's claim, not a fact */
      if (size > FILE_MAX) { scrap(413, `That file is too large — ${Math.round(FILE_MAX / 1048576)}MB is the limit.`); }
    });
    req.on('error', () => scrap(400, 'That upload did not finish.'));
    out.on('error', () => scrap(500, 'That file could not be saved.'));

    out.on('finish', () => {
      if (done) return; done = true;
      if (!size) { unlink(path, () => {}); return fail(400, 'That file was empty.'); }
      const name = cleanName(params.get('name'));
      const mime = String(params.get('mime') || '').toLowerCase().slice(0, 100) || 'application/octet-stream';
      q.run('INSERT INTO files (id,owner_id,name,mime,size,w,h,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, user.id, name, mime, size, Number(params.get('w')) || 0, Number(params.get('h')) || 0, now());
      resolve({ id, name, mime, size, w: Number(params.get('w')) || 0, h: Number(params.get('h')) || 0 });
    });

    req.pipe(out);
  });
}

/* ---------- download ----------
   Range-aware, because a <video> cannot seek without it and some browsers
   refuse to play at all when the server ignores Range. */
export function serveFile(req, res, row) {
  let stat;
  try { stat = statSync(join(FILES_DIR, row.id)); }
  catch { res.writeHead(410, { 'content-type': 'text/plain' }); return res.end('That file is no longer on disk.'); }

  const safe = inlineOk(row.mime);
  const head = {
    /* never echo back a type we have not vetted: with nosniff set, an
       unrecognised type is inert rather than guessed at */
    'content-type': safe ? row.mime : 'application/octet-stream',
    'content-disposition': disposition(safe ? 'inline' : 'attachment', row.name),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, max-age=86400',
    'accept-ranges': 'bytes'
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && stat.size) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(join(FILES_DIR, row.id), { start, end }).pipe(res);
  }

  res.writeHead(200, { ...head, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return createReadStream(join(FILES_DIR, row.id)).pipe(res);
}

/* A deleted message takes its attachment with it. Without this the row goes
   but the bytes stay on disk forever, reachable by nobody and counted by
   nothing. */
export function dropFile(id) {
  if (!id) return;
  q.run('DELETE FROM files WHERE id = ?', id);
  unlink(join(FILES_DIR, id), () => {});
}

/* what a message carries about its attachment */
export const fileShape = (id) => {
  if (!id) return null;
  const f = fileRow(id);
  return f ? { id: f.id, name: f.name, mime: f.mime, size: f.size, w: f.w, h: f.h } : null;
};
