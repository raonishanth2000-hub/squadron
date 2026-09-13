import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ensureCert, lanAddresses } from './cert.js';

import { q } from './db.js';
import { userFromToken, migrateSessionTokens } from './auth.js';
import { buildRouter, json, readBody, parseCookies, serveStatic, meetingPassOk } from './api-bridge.js';
import { saveUpload, serveFile, fileRow, fileReachable } from './files.js';
import { startInteractive } from './run.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(root, 'public');
const PORT = Number(process.env.PORT) || 4173;
/* Behind a reverse proxy the only thing that should reach this process is the
   proxy itself on the loopback. Binding every interface means a flushed
   firewall would expose the app directly on its port with no TLS in front of
   it. Left open by default so a laptop can still be reached over the LAN. */
const BIND = process.env.BIND || '0.0.0.0';
const COOKIE = 'sq_session';

const router = buildRouter();

/* Rewrite any session tokens still stored in the clear. Runs before the first
   request so no lookup can race it. */
{
  const n = migrateSessionTokens();
  if (n) console.log(`[db] hashed ${n} stored session token(s)`);
}

/* ---------- rooms: who is listening to which squad ---------- */
const squadRooms = new Map();          // squadId -> Set<ws>
const userSockets = new Map();         // userId  -> Set<ws>, for direct messages
const meetingRooms = new Map();        // meetingId -> Map<peerId, ws>

function broadcast(squadId, payload, except) {
  const room = squadRooms.get(squadId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const ws of room) if (ws !== except && ws.readyState === 1) ws.send(data);
}

/* ---------- http ---------- */
/* Content-Security-Policy, assembled from what the app actually loads.

   script-src carries no 'unsafe-inline': every script in index.html is an
   external file, so an injected <script> tag simply will not execute. That is
   the whole value of the header, and it is only available because there were
   no inline blocks to grandfather in. style-src does need it — there are 92
   inline style attributes — which is a far smaller risk.

   frame-ancestors 'none' is the clickjacking fix: the workspace can no longer
   be loaded inside an invisible iframe on someone else's page. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

/* Behind a proxy the socket is plain http while the visitor is on https, so
   the forwarded header is the only honest answer to "was this secure?". */
const overHttps = (req) =>
  !!tls || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');          /* for anything older than frame-ancestors */
  res.setHeader('permissions-policy', 'geolocation=(), payment=(), usb=()');
  /* Only ever over https: sent on a plain connection it would pin a browser to
     a scheme this server may not be able to answer on. */
  if (overHttps(req)) res.setHeader('strict-transport-security', 'max-age=15552000; includeSubDomains');

  if (url.pathname.startsWith('/api/')) {
    /* Attachments are handled before the router. Both directions need the raw
       streams: readBody buffers the whole request and parses it as JSON with a
       1MB ceiling, and the JSON reply path cannot do a range request. */
    const upload = req.method === 'POST' && url.pathname === '/api/files';
    const download = (req.method === 'GET' || req.method === 'HEAD') && /^\/api\/files\/[\w-]+$/.test(url.pathname);
    if (upload || download) {
      const who = userFromToken(parseCookies(req.headers.cookie)[COOKIE]);
      if (!who) return json(res, 401, { error: 'Sign in to continue.' });
      try {
        if (upload) return json(res, 200, { file: await saveUpload(req, who, url.searchParams) });
        const row = fileRow(url.pathname.slice('/api/files/'.length));
        if (!row) return json(res, 404, { error: 'That file is gone.' });
        if (!fileReachable(row.id, who.id)) return json(res, 403, { error: 'That file is not shared with you.' });
        return serveFile(req, res, row);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[files]', url.pathname, err);
        return json(res, status, { error: err.message || 'That did not work.' });
      }
    }

    const hit = router.match(req.method, url.pathname);
    if (!hit) return json(res, 404, { error: 'No such endpoint.' });

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    const user = userFromToken(token);

    const ctx = {
      params: hit.params, token, user, query: url.searchParams,
      body: {},
      requireUser() {
        if (!this.user) { const e = new Error('Sign in to continue.'); e.status = 401; throw e; }
        return this.user;
      },
      setSession(t) {
        /* Secure only when the visitor is actually on https — set on a plain
           http dev origin the browser discards the cookie outright and nobody
           can sign in at all. */
        const flag = overHttps(req) ? '; Secure' : '';
        res.setHeader('set-cookie',
          `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/${flag}; Max-Age=${30 * 24 * 3600}`);
      },
      clearSession() {
        const flag = overHttps(req) ? '; Secure' : '';
        res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/${flag}; Max-Age=0`);
      },
      isSecure: () => !!tls,
      localOrigin: () => `${scheme}://localhost:${PORT}`,
      lanOrigins: () => lanAddresses().map(ip => `${scheme}://${ip}:${PORT}`),
      publicOrigin: () => {
        /* A quick tunnel gets a new hostname every restart, so the URL cannot
           live in a fixed env var. The tunnel script drops it here and this is
           read per request — otherwise invite links fall back to the LAN
           address, which is plain http and cannot reach a camera. */
        const fromEnv = (process.env.PUBLIC_URL || '').trim();
        if (fromEnv) return fromEnv.replace(/\/$/, '');
        try {
          const f = readFileSync(join(root, 'data', 'public-url'), 'utf8').trim();
          return /^https?:\/\//.test(f) ? f.replace(/\/$/, '') : null;
        } catch { return null; }
      },
      broadcast,
      /* something only one person may see — a private task, an invitation —
         goes to their own sockets and never into the squad room */
      notifyUser(userId, payload) {
        for (const sock of userSockets.get(userId) || []) {
          if (sock.readyState === 1) { try { sock.send(JSON.stringify(payload)); } catch {} }
        }
      },
      /* a direct message goes to both people's sockets, not to a squad room */
      dmNotify(thread, payload) {
        /* a set, because a notice aimed at one person passes the same id twice */
        for (const id of new Set([thread.a_id, thread.b_id])) {
          for (const sock of userSockets.get(id) || []) {
            if (sock.readyState === 1) { try { sock.send(JSON.stringify(payload)); } catch {} }
          }
        }
      }
    };

    try {
      /* Read the body inside the guard. It used to be awaited while building
         ctx — outside this try — so an oversized request threw an unhandled
         rejection and took the whole process down, which any caller could do
         on purpose with one large POST. */
      if (req.method !== 'GET' && req.method !== 'DELETE') ctx.body = await readBody(req);
      const out = await hit.handler(ctx);
      /* a route can hand back bytes instead of JSON — used for voice clips */
      if (out && out.__raw) {
        res.writeHead(200, {
          'content-type': out.__raw.type || 'application/octet-stream',
          'content-length': out.__raw.body.length,
          'cache-control': 'private, max-age=86400'
        });
        return res.end(out.__raw.body);
      }
      return json(res, 200, out ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[api]', url.pathname, err);
      return json(res, status, { error: err.message || 'Something went wrong.' });
    }
  }

  if (await serveStatic(res, PUBLIC, url.pathname, req)) return;
  /* single-page app: unknown paths fall back to the shell */
  if (!url.pathname.includes('.') && await serveStatic(res, PUBLIC, '/index.html', req)) return;
  res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
};

/* TLS where we can get it: camera, microphone and screen share are blocked by the
   browser outside a secure context, and localhost is the only insecure exception. */
const tls = process.env.SQUADRON_HTTP === '1' ? null : ensureCert();
const server = tls ? createHttps(tls, handler) : createHttp(handler);
const scheme = tls ? 'https' : 'http';

/* ---------- websocket: live workspace + webrtc signalling ---------- */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const user = userFromToken(token);
  if (!user) { ws.close(4001, 'Sign in first'); return; }

  ws.user = user;
  ws.peerId = Math.random().toString(36).slice(2, 10);
  ws.squads = new Set();
  ws.meetingId = null;
  if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
  userSockets.get(user.id).add(ws);
  ws.send(JSON.stringify({ type: 'hello', peerId: ws.peerId, user }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* --- workspace rooms --- */
    if (msg.type === 'watch') {
      const member = q.get('SELECT 1 FROM squad_members WHERE squad_id = ? AND user_id = ?', msg.squadId, user.id);
      if (!member) return;
      ws.squads.add(msg.squadId);
      if (!squadRooms.has(msg.squadId)) squadRooms.set(msg.squadId, new Set());
      squadRooms.get(msg.squadId).add(ws);
      return;
    }

    if (msg.type === 'typing' && ws.squads.has(msg.squadId)) {
      return broadcast(msg.squadId, { type: 'typing', channelId: msg.channelId, user: user.name }, ws);
    }

    /* --- meeting: join, then peers negotiate directly --- */
    if (msg.type === 'meeting-join') {
      const m = q.get('SELECT * FROM meetings WHERE id = ?', msg.meetingId);
      if (!m) return;
      const member = !!q.get('SELECT 1 FROM squad_members WHERE squad_id = ? AND user_id = ?', m.squad_id, user.id);
      /* a guest holds the pass from the link; the same rule the REST route uses */
      if (!member && !(meetingPassOk(m, msg.pass) && !m.ended_at)) {
        ws.send(JSON.stringify({ type: 'meeting-refused', meetingId: msg.meetingId }));
        return;
      }
      ws.isGuest = !member;

      ws.meetingId = msg.meetingId;
      if (!meetingRooms.has(msg.meetingId)) meetingRooms.set(msg.meetingId, new Map());
      const room = meetingRooms.get(msg.meetingId);

      /* tell the newcomer who is already here, so IT makes the offers */
      const existing = [...room.values()].map(p => ({ peerId: p.peerId, name: p.user.name, handle: p.user.handle, guest: !!p.isGuest }));
      ws.send(JSON.stringify({ type: 'meeting-peers', peers: existing }));

      /* tell the room someone arrived */
      for (const peer of room.values()) {
        if (peer.readyState === 1) peer.send(JSON.stringify({
          type: 'meeting-joined', peerId: ws.peerId, name: user.name, handle: user.handle, guest: ws.isGuest
        }));
      }
      room.set(ws.peerId, ws);
      if (!m.started_at) q.run('UPDATE meetings SET started_at = ? WHERE id = ?', Date.now(), m.id);
      return;
    }

    /* offer / answer / ice all relay verbatim to one peer */
    if (['offer', 'answer', 'ice'].includes(msg.type) && ws.meetingId) {
      const room = meetingRooms.get(ws.meetingId);
      const target = room?.get(msg.to);
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({ ...msg, from: ws.peerId, name: user.name, handle: user.handle }));
      }
      return;
    }

    if (msg.type === 'meeting-state' && ws.meetingId) {
      const room = meetingRooms.get(ws.meetingId);
      for (const peer of room?.values() || []) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'meeting-state', peerId: ws.peerId, ...msg.state }));
        }
      }
      return;
    }

    /* --- interactive run: output streams out, typed lines go back in --- */
    if (msg.type === 'code-run') {
      if (ws.run) { try { ws.run.kill(); } catch {} ws.run = null; }
      if (!q.get('SELECT 1 FROM squad_members WHERE user_id = ?', user.id)) {
        ws.send(JSON.stringify({ type: 'code-end', stage: 'blocked', stderr: 'Join a squad before running code.' }));
        return;
      }
      const send = (o) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch {} } };
      const token = Symbol('run');
      ws.runToken = token;
      startInteractive({
        lang: msg.lang, source: msg.source, includes: [],
        onOut: (o) => { if (ws.runToken === token) send({ type: 'code-out', ...o }); },
        onEnd: (e) => { if (ws.runToken === token) { send({ type: 'code-end', ...e }); ws.run = null; } }
      }).then(h => {
        /* a second run may have started while this one was compiling */
        if (ws.runToken !== token) { h?.kill(); return; }
        ws.run = h;
        if (h) send({ type: 'code-started' });
      }).catch(() => send({ type: 'code-end', stage: 'error', stderr: 'Could not start.' }));
      return;
    }
    if (msg.type === 'code-stdin') { ws.run?.write(msg.line ?? ''); return; }
    if (msg.type === 'code-eof')   { ws.run?.eof(); return; }
    if (msg.type === 'code-kill')  { ws.runToken = null; ws.run?.kill(); ws.run = null; return; }

    if (msg.type === 'meeting-leave') leaveMeeting(ws);
  });

  ws.on('close', () => {
    /* the tab is gone; nothing should still be running on its behalf */
    ws.runToken = null;
    try { ws.run?.kill(); } catch {}
    ws.run = null;
    leaveMeeting(ws);
    for (const id of ws.squads) squadRooms.get(id)?.delete(ws);
    /* drop the user entry too, or the map grows for the life of the process */
    const mine = userSockets.get(user.id);
    if (mine) { mine.delete(ws); if (!mine.size) userSockets.delete(user.id); }
  });
});

function leaveMeeting(ws) {
  if (!ws.meetingId) return;
  const room = meetingRooms.get(ws.meetingId);
  if (room) {
    room.delete(ws.peerId);
    for (const peer of room.values()) {
      if (peer.readyState === 1) peer.send(JSON.stringify({ type: 'meeting-left', peerId: ws.peerId }));
    }
    if (!room.size) {
      meetingRooms.delete(ws.meetingId);
      q.run('UPDATE meetings SET ended_at = ? WHERE id = ? AND ended_at IS NULL', Date.now(), ws.meetingId);
    }
  }
  ws.meetingId = null;
}

server.listen(PORT, BIND, () => {
  console.log(`\n  Squadron  ${scheme}://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`            ${scheme}://${ip}:${PORT}   (same wifi)`);
  if (process.env.PUBLIC_URL) console.log(`            ${process.env.PUBLIC_URL}   (public tunnel)`);
  if (tls) {
    console.log('\n  The certificate is self-signed, so the first visit on each device shows a');
    console.log('  browser warning — continue past it once and camera, mic and screen share work.');
  } else {
    console.log('\n  Running without TLS: camera and mic will only work on localhost.');
  }
  console.log('');
});
