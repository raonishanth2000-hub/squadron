import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { q, now, uid } from './db.js';

const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(pw, stored) {
  const [scheme, salt, key] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const candidate = scryptSync(pw, salt, 64);
  const known = Buffer.from(key, 'hex');
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}

/* a handle is derived once, then kept unique */
function makeHandle(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 18) || 'member';
  let handle = base, n = 1;
  while (q.get('SELECT 1 FROM users WHERE handle = ?', handle)) handle = `${base}_${++n}`;
  return handle;
}

export function createUser({ email, password, name }) {
  const clean = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw httpError(400, 'That email address does not look right.');
  if (String(password).length < 8) throw httpError(400, 'Use at least 8 characters for your password.');
  if (!String(name).trim()) throw httpError(400, 'Tell us what to call you.');
  if (q.get('SELECT 1 FROM users WHERE email = ?', clean)) throw httpError(409, 'That email is already registered. Sign in instead.');

  const id = uid('u_');
  q.run('INSERT INTO users (id,email,pw_hash,name,handle,rating,created_at) VALUES (?,?,?,?,?,?,?)',
    id, clean, hashPassword(password), String(name).trim(), makeHandle(name), null, now());
  return getUser(id);
}

export function authenticate(email, password) {
  const row = q.get('SELECT * FROM users WHERE email = ?', String(email).trim().toLowerCase());
  /* a closed account keeps its row so old threads stay readable, but the
     scrubbed hash must never match and the same message is returned either
     way, so this does not reveal which addresses exist */
  if (!row || row.deleted_at || !verifyPassword(password, row.pw_hash))
    throw httpError(401, 'That email and password do not match.');
  return publicUser(row);
}

/* The database stores a hash of the session token, never the token itself.
   The file gets copied around — backed up, moved to a host — and a stolen copy
   used to hand over every live session as a ready-made cookie value. Now it
   yields hashes, which are useless on their own.

   A plain SHA-256 rather than scrypt, deliberately: the token is 32 random
   bytes, so there is nothing to brute-force, and this runs on every single
   request. Password hashing has to be slow; this must not be. */
const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');

export function startSession(userId) {
  const token = randomBytes(32).toString('hex');
  const t = now();
  q.run('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)',
    tokenHash(token), userId, t, t + SESSION_DAYS * 864e5);
  return token;                       /* the raw token only ever lives in the cookie */
}

export function endSession(token) {
  if (token) q.run('DELETE FROM sessions WHERE token = ?', tokenHash(token));
}

export function userFromToken(token) {
  if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE token = ?', tokenHash(token));
  if (!s) return null;
  if (s.expires_at < now()) { q.run('DELETE FROM sessions WHERE token = ?', s.token); return null; }
  return getUser(s.user_id);
}

/* Fold the existing plaintext rows over to hashes. Doing it in place keeps
   everyone signed in — the cookie they already hold still hashes to the row we
   just rewrote — where deleting the table would have signed out every account
   at once. A row is already hashed if it is 64 hex characters and the stored
   tokens are 64 hex characters too, so length cannot tell them apart; the
   marker column records that the pass has run. */
export function migrateSessionTokens() {
  const done = q.get("SELECT value FROM meta WHERE key = 'sessions_hashed'");
  if (done) return 0;
  const rows = q.all('SELECT token FROM sessions');
  for (const r of rows) q.run('UPDATE sessions SET token = ? WHERE token = ?', tokenHash(r.token), r.token);
  q.run("INSERT INTO meta (key,value) VALUES ('sessions_hashed','1')");
  return rows.length;
}

export const publicUser = (r) => r && ({
  id: r.id, name: r.name, handle: r.handle, email: r.email, rating: r.rating,
  tourSeen: !!r.tour_seen, createdAt: r.created_at
});

/* a handle the owner chose, rather than one derived from their name */
export function claimHandle(userId, raw) {
  const want = String(raw || '').trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  if (want.length < 3) throw httpError(400, 'A handle needs at least three characters.');
  const taken = q.get('SELECT id FROM users WHERE handle = ? AND id != ?', want, userId);
  if (taken) throw httpError(409, 'That handle is already taken.');
  return want;
}

export const getUser = (id) => publicUser(q.get('SELECT * FROM users WHERE id = ?', id));

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
