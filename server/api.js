import { q, now, uid, TASK_XP } from './db.js';
import { createUser, authenticate, startSession, endSession, getUser, httpError,
         hashPassword, verifyPassword, claimHandle } from './auth.js';
import { Router } from './http.js';
import { runCode, runTests, runnerStatus, LANGS } from './run.js';
import { fileShape, dropFile } from './files.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/* ---------- competition presets: these drive the real structure ---------- */
/* `cap` is only the default the creator sees — every squad can change it later. */
export const KINDS = {
  icpc:  { label: 'ICPC team',       cap: 3,  channels: ['general', 'problem-sets', 'contest-log', 'balloons'], sprint: 'Practice Sprint 1' },
  gsoc:  { label: 'GSoC circle',     cap: 6,  channels: ['general', 'proposals', 'org-shortlist', 'code-review'], sprint: 'Proposal Sprint 1' },
  hack:  { label: 'Hackathon squad', cap: 6,  channels: ['general', 'build-log', 'pitch'], sprint: 'Build Sprint' },
  study: { label: 'Study group',     cap: 12, channels: ['general', 'daily-problem', 'editorials'], sprint: 'Ladder Week 1' }
};

/* Tasks pay a flat 5, so the old 1500-per-level step meant 300 tasks to reach
   level 2 — roughly a hundred days of steady work for one increment, which is
   no signal at all. 40 keeps a level worth about eight solved tasks. */
const LEVEL_STEP = 40;
export const levelOf = (xp) => Math.floor(xp / LEVEL_STEP) + 1;
export const levelFloor = (xp) => (levelOf(xp) - 1) * LEVEL_STEP;
export const levelCeil = (xp) => levelOf(xp) * LEVEL_STEP;

export const totalXp = (userId) =>
  q.get('SELECT COALESCE(SUM(amount),0) AS n FROM xp_ledger WHERE user_id = ?', userId).n;

/* ---------- membership guards ---------- */
function membership(squadId, userId) {
  return q.get('SELECT * FROM squad_members WHERE squad_id = ? AND user_id = ?', squadId, userId);
}
function requireMember(squadId, user) {
  const m = membership(squadId, user.id);
  if (!m) throw httpError(403, 'You are not a member of that squad.');
  return m;
}

/* Constant-time, so the pass cannot be recovered a byte at a time by timing
   the responses. Lengths are compared first because timingSafeEqual throws on
   a mismatch rather than returning false. */
export function meetingPassOk(meeting, given) {
  const want = String(meeting.pass || ''), got = String(given || '');
  if (!want || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/* ---------- shaping ---------- */
const memberRows = (squadId) => q.all(`
  SELECT u.id, u.name, u.handle, u.rating, m.role, m.joined_at
  FROM squad_members m JOIN users u ON u.id = m.user_id
  WHERE m.squad_id = ? ORDER BY CASE m.role WHEN 'captain' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.joined_at`, squadId);

/* channels carry their symbol and the viewer's unread count */
const channelRows = (squadId, userId) => q.all(`
  SELECT c.id, c.name, c.position, c.icon,
         (SELECT COUNT(*) FROM messages m
           WHERE m.channel_id = c.id
             AND m.user_id != ?
             AND m.created_at > COALESCE((SELECT r.read_at FROM channel_reads r
                                           WHERE r.channel_id = c.id AND r.user_id = ?), 0)
         ) AS unread
  FROM channels c WHERE c.squad_id = ? ORDER BY c.position, c.name`,
  userId, userId, squadId);

const squadShape = (s, userId) => ({
  ...s,
  kindLabel: KINDS[s.kind]?.label || s.kind,
  members: memberRows(s.id),
  channels: channelRows(s.id, userId),
  role: membership(s.id, userId)?.role || null
});

const voiceFor = (messageId) => {
  const v = q.get('SELECT id, ms, peaks, mime FROM voice WHERE message_id = ?', messageId);
  return v ? { id: v.id, ms: v.ms, mime: v.mime, peaks: JSON.parse(v.peaks || '[]') } : null;
};

const messageShape = (m) => ({
  id: m.id, body: m.deleted_at ? '' : m.body, created_at: m.created_at,
  kind: m.deleted_at ? 'deleted' : (m.kind || 'text'),
  deleted: !!m.deleted_at,
  editedAt: m.edited_at || null,
  pinnedAt: m.pinned_at || null,
  parentId: m.parent_id || null,
  replies: q.get('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ? AND deleted_at IS NULL', m.id).n,
  voice: (m.kind === 'voice' && !m.deleted_at) ? voiceFor(m.id) : null,
  image: m.deleted_at ? null : (m.image_id || null),
  file: m.deleted_at ? null : fileShape(m.file_id),
  author: { id: m.user_id, name: m.name, handle: m.handle },
  reactions: q.all('SELECT key, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY key', m.id),
  reacted: m._me ? q.all('SELECT key FROM reactions WHERE message_id = ? AND user_id = ?', m.id, m._me).map(r => r.key) : []
});

/* ---------- routes ---------- */
export function buildRouter() {
  const r = new Router();

  /* auth */
  r.post('/api/auth/signup', async (ctx) => {
    const { email, password, name } = ctx.body;
    const user = createUser({ email, password, name });
    ctx.setSession(startSession(user.id));
    return { user };
  });

  r.post('/api/auth/login', async (ctx) => {
    const user = authenticate(ctx.body.email, ctx.body.password);
    ctx.setSession(startSession(user.id));
    return { user };
  });

  r.post('/api/auth/logout', async (ctx) => { endSession(ctx.token); ctx.clearSession(); return { ok: true }; });

  r.get('/api/me', async (ctx) => {
    const u = ctx.requireUser();
    const xp = totalXp(u.id);
    return {
      user: u,
      xp: { total: xp, level: levelOf(xp), floor: levelFloor(xp), ceil: levelCeil(xp) },
      ledger: q.all('SELECT id,amount,reason,created_at FROM xp_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 12', u.id),
      pendingInvites: q.all(`SELECT i.id, i.role, s.name AS squad_name, s.kind
        FROM invites i JOIN squads s ON s.id = i.squad_id
        WHERE i.email = ? AND i.email <> '' AND i.accepted_at IS NULL`, u.email)
    };
  });

  /* squads */
  /* ---------- account settings ----------
     There is no route that returns a password, and there cannot be one: what
     is stored is a scrypt hash with a random salt, which is what stops a copy
     of this database from being a list of everyone's password. Changing it is
     the only thing on offer, and that needs the current one. */
  r.patch('/api/me', async (ctx) => {
    const u = ctx.requireUser();
    const name = ctx.body.name === undefined ? null : String(ctx.body.name).trim().slice(0, 60);
    if (name !== null && name.length < 2) throw httpError(400, 'Names need at least two characters.');
    const handle = ctx.body.handle === undefined ? null : claimHandle(u.id, ctx.body.handle);
    let rating = null;
    if (ctx.body.rating !== undefined) {
      rating = ctx.body.rating === '' || ctx.body.rating === null ? null : Number(ctx.body.rating);
      if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 4000))
        throw httpError(400, 'A rating should be between 0 and 4000.');
    }
    q.run('UPDATE users SET name = COALESCE(?,name), handle = COALESCE(?,handle), rating = ? WHERE id = ?',
      name, handle, ctx.body.rating === undefined ? u.rating : rating, u.id);
    return { user: getUser(u.id) };
  });

  r.post('/api/me/password', async (ctx) => {
    const u = ctx.requireUser();
    const row = q.get('SELECT pw_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(ctx.body.current || ''), row.pw_hash))
      throw httpError(403, 'That is not your current password.');
    const next = String(ctx.body.next || '');
    if (next.length < 8) throw httpError(400, 'Use at least eight characters.');
    if (next === String(ctx.body.current || '')) throw httpError(400, 'That is the password you already have.');
    q.run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(next), u.id);
    /* every other session is now signed in with a password that no longer
       exists — end them, and keep only the one making the change */
    q.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, ctx.token);
    return { ok: true, otherSessionsEnded: true };
  });

  r.post('/api/me/email', async (ctx) => {
    const u = ctx.requireUser();
    const row = q.get('SELECT pw_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(ctx.body.password || ''), row.pw_hash))
      throw httpError(403, 'Enter your password to change the address you sign in with.');
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right.');
    if (q.get('SELECT 1 FROM users WHERE email = ? AND id != ?', email, u.id))
      throw httpError(409, 'Another account already uses that address.');
    q.run('UPDATE users SET email = ? WHERE id = ?', email, u.id);
    return { user: getUser(u.id) };
  });

  /* ---------- closing an account ----------
     Eight tables reference users(id) without a cascade, so a hard DELETE is
     refused by SQLite — and it would be the wrong thing anyway: removing the
     row would punch holes in conversations other people are still reading.
     Instead the identity is scrubbed and everything personal is removed, which
     is what "delete my account" has to mean in a shared workspace. */
  r.post('/api/me/delete', async (ctx) => {
    const u = ctx.requireUser();
    const row = q.get('SELECT pw_hash FROM users WHERE id = ?', u.id);
    if (!verifyPassword(String(ctx.body.password || ''), row.pw_hash))
      throw httpError(403, 'Enter your password to close the account.');
    if (String(ctx.body.confirm || '').trim().toLowerCase() !== 'delete')
      throw httpError(400, 'Type "delete" to confirm.');

    /* hand over or dissolve any squad this person captains */
    for (const m of q.all("SELECT squad_id FROM squad_members WHERE user_id = ? AND role = 'captain'", u.id)) {
      const others = q.all('SELECT user_id FROM squad_members WHERE squad_id = ? AND user_id != ?', m.squad_id, u.id);
      if (others.length) q.run("UPDATE squad_members SET role = 'captain' WHERE squad_id = ? AND user_id = ?", m.squad_id, others[0].user_id);
      else q.run('DELETE FROM squads WHERE id = ?', m.squad_id);
    }
    q.run('DELETE FROM squad_members WHERE user_id = ?', u.id);
    q.run("DELETE FROM snippets WHERE user_id = ? AND scope = 'personal'", u.id);
    q.run('DELETE FROM reactions WHERE user_id = ?', u.id);
    q.run('DELETE FROM mentions WHERE user_id = ?', u.id);
    q.run('DELETE FROM channel_reads WHERE user_id = ?', u.id);
    q.run('DELETE FROM strokes WHERE user_id = ?', u.id);
    /* their own messages go; the tombstone keeps any thread they anchored */
    q.run("UPDATE messages SET deleted_at = ?, body = '' WHERE user_id = ? AND deleted_at IS NULL", now(), u.id);
    q.run('DELETE FROM voice WHERE message_id IN (SELECT id FROM messages WHERE user_id = ?)', u.id);
    /* every attachment they ever sent, off the disk as well as out of the row */
    for (const f of q.all('SELECT id FROM files WHERE owner_id = ?', u.id)) dropFile(f.id);
    q.run("UPDATE messages SET file_id = NULL WHERE user_id = ?", u.id);
    q.run("UPDATE dm_messages SET file_id = NULL WHERE user_id = ?", u.id);

    const stamp = now();
    q.run(`UPDATE users SET deleted_at = ?, email = ?, handle = ?, name = 'Deleted member',
           pw_hash = 'closed', rating = NULL WHERE id = ?`,
      stamp, `deleted+${u.id}@squadron.invalid`, `deleted_${u.id.slice(-6)}`, u.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    ctx.clearSession();
    return { ok: true };
  });

  /* what the account is made of, for the settings page */
  r.get('/api/me/account', async (ctx) => {
    const u = ctx.requireUser();
    return {
      user: getUser(u.id),
      squads: q.all(`SELECT s.id, s.name, s.kind, m.role FROM squad_members m
                     JOIN squads s ON s.id = m.squad_id WHERE m.user_id = ?`, u.id),
      xp: totalXp(u.id),
      sessions: q.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', u.id).n,
      counts: {
        messages: q.get('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?', u.id).n,
        snippets: q.get('SELECT COUNT(*) AS n FROM snippets WHERE user_id = ?', u.id).n,
        solved: q.get("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND col = 'Solved'", u.id).n
      }
    };
  });

  /* sign out everywhere, for a shared or lost machine */
  r.post('/api/me/sessions/end-others', async (ctx) => {
    const u = ctx.requireUser();
    const n = q.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND token != ?', u.id, ctx.token).n;
    q.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, ctx.token);
    return { ok: true, ended: n };
  });

  /* the walk-through is offered once per account, not once per browser */
  r.post('/api/me/tour-seen', async (ctx) => {
    const u = ctx.requireUser();
    q.run('UPDATE users SET tour_seen = 1 WHERE id = ?', u.id);
    return { ok: true };
  });

  r.get('/api/squads', async (ctx) => {
    const u = ctx.requireUser();
    const rows = q.all(`SELECT s.* FROM squads s JOIN squad_members m ON m.squad_id = s.id
                        WHERE m.user_id = ? ORDER BY s.created_at`, u.id);
    return { squads: rows.map(s => squadShape(s, u.id)) };
  });

  r.post('/api/squads', async (ctx) => {
    const u = ctx.requireUser();
    const { name, kind, tagline, cap, invites = [] } = ctx.body;
    if (!KINDS[kind]) throw httpError(400, 'Pick a competition for the squad.');
    if (!String(name || '').trim()) throw httpError(400, 'Give the squad a name.');

    const id = uid('s_'), t = now(), preset = KINDS[kind];
    const size = clampCap(cap ?? preset.cap);
    q.run('INSERT INTO squads (id,name,kind,tagline,cap,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      id, String(name).trim(), kind, String(tagline || '').trim() || null, size, u.id, t);
    q.run('INSERT INTO squad_members (squad_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, u.id, 'captain', t);
    preset.channels.forEach((c, i) =>
      q.run('INSERT INTO channels (id,squad_id,name,position,icon) VALUES (?,?,?,?,?)',
        uid('c_'), id, c, i, seedIcon(c)));

    for (const raw of invites) {
      const email = String(raw.email || raw || '').trim().toLowerCase();
      if (!email) continue;
      q.run('INSERT INTO invites (id,squad_id,email,role,invited_by,created_at) VALUES (?,?,?,?,?,?)',
        uid('i_'), id, email, raw.role === 'advisor' ? 'advisor' : 'member', u.id, t);
    }
    return { squad: squadShape(q.get('SELECT * FROM squads WHERE id = ?', id), u.id) };
  });

  r.get('/api/squads/:id', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const s = q.get('SELECT * FROM squads WHERE id = ?', ctx.params.id);
    if (!s) throw httpError(404, 'That squad no longer exists.');
    return {
      squad: squadShape(s, u.id),
      /* a private task belongs to one person's own list: it never reaches
         anyone else's payload, so there is nothing to filter out client-side */
      tasks: q.all('SELECT * FROM tasks WHERE squad_id = ? AND (owner_id IS NULL OR owner_id = ?) ORDER BY col, position', s.id, u.id),
      events: q.all('SELECT * FROM events WHERE squad_id = ? ORDER BY starts_at', s.id),
      invites: q.all('SELECT id,email,role,accepted_at FROM invites WHERE squad_id = ?', s.id)
    };
  });

  r.patch('/api/squads/:id', async (ctx) => {
    const u = ctx.requireUser();
    const m = requireMember(ctx.params.id, u);
    if (m.role !== 'captain') throw httpError(403, 'Only the captain can change squad settings.');
    const s = q.get('SELECT * FROM squads WHERE id = ?', ctx.params.id);
    const members = memberRows(s.id).length;

    const name = ctx.body.name !== undefined ? String(ctx.body.name).trim() : s.name;
    const tagline = ctx.body.tagline !== undefined ? (String(ctx.body.tagline).trim() || null) : s.tagline;
    let cap = ctx.body.cap !== undefined ? clampCap(ctx.body.cap) : s.cap;
    if (!name) throw httpError(400, 'The squad needs a name.');
    if (cap < members) throw httpError(400, `There are already ${members} people here — the limit cannot go below that.`);

    q.run('UPDATE squads SET name=?, tagline=?, cap=? WHERE id=?', name, tagline, cap, s.id);
    const squad = squadShape(q.get('SELECT * FROM squads WHERE id = ?', s.id), u.id);
    ctx.broadcast(s.id, { type: 'squad', squad });
    return { squad };
  });

  r.post('/api/squads/:id/invites', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const s = q.get('SELECT * FROM squads WHERE id = ?', ctx.params.id);
    if (memberRows(s.id).length >= s.cap) throw httpError(409, `This squad is full at ${s.cap}. Raise the limit in squad settings first.`);
    const id = uid('i_');
    q.run('INSERT INTO invites (id,squad_id,email,role,invited_by,created_at) VALUES (?,?,?,?,?,?)',
      id, s.id, email, ctx.body.role === 'advisor' ? 'advisor' : 'member', u.id, now());
    return { invite: { id, email, link: '/?invite=' + id } };
  });

  /* An invitation aimed at an account, rather than a link to pass around.
     It still needs accepting — quietly adding someone to a squad they never
     asked to join is not an invitation. */
  r.post('/api/squads/:id/invites/user', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const s = q.get('SELECT * FROM squads WHERE id = ?', ctx.params.id);
    if (!s) throw httpError(404, 'That squad no longer exists.');
    const target = q.get('SELECT id, name, email, deleted_at FROM users WHERE id = ?', String(ctx.body.userId || ''));
    if (!target || target.deleted_at) throw httpError(404, 'No such person.');
    if (target.id === u.id) throw httpError(400, 'You are already in it.');
    if (membership(s.id, target.id)) throw httpError(409, `${target.name} is already in this squad.`);
    if (memberRows(s.id).length >= s.cap)
      throw httpError(409, `This squad is full at ${s.cap}. Raise the limit in squad settings first.`);
    const already = q.get(`SELECT i.id FROM invites i WHERE i.squad_id = ? AND i.email = ? AND i.accepted_at IS NULL`, s.id, target.email);
    if (already) throw httpError(409, `${target.name} already has an invitation to this squad.`);

    const id = uid('i_');
    q.run('INSERT INTO invites (id,squad_id,email,role,invited_by,created_at) VALUES (?,?,?,?,?,?)',
      id, s.id, target.email, ctx.body.role === 'advisor' ? 'advisor' : 'member', u.id, now());
    ctx.dmNotify({ a_id: target.id, b_id: target.id },
      { type: 'invited', squadName: s.name, from: u.name, inviteId: id });
    return { invite: { id, name: target.name }, link: '/?invite=' + id };
  });

  r.post('/api/invites/:id/decline', async (ctx) => {
    const u = ctx.requireUser();
    const inv = q.get('SELECT * FROM invites WHERE id = ?', ctx.params.id);
    if (!inv) throw httpError(404, 'That invitation is gone.');
    if (inv.email !== u.email) throw httpError(403, 'That invitation is not yours.');
    q.run('DELETE FROM invites WHERE id = ?', inv.id);
    return { ok: true };
  });

  r.get('/api/invites/:id', async (ctx) => {
    const inv = q.get('SELECT * FROM invites WHERE id = ?', ctx.params.id);
    if (!inv) throw httpError(404, 'That invitation link is not valid.');
    const s = q.get('SELECT name,kind FROM squads WHERE id = ?', inv.squad_id);
    return {
      invite: { id: inv.id, role: inv.role, accepted: !!inv.accepted_at, email: inv.email || null },
      squad: { name: s.name, kindLabel: KINDS[s.kind]?.label || s.kind },
      seatsLeft: Math.max(0, q.get('SELECT cap FROM squads WHERE id = ?', inv.squad_id).cap - memberRows(inv.squad_id).length)
    };
  });

  r.post('/api/invites/:id/accept', async (ctx) => {
    const u = ctx.requireUser();
    const inv = q.get('SELECT * FROM invites WHERE id = ?', ctx.params.id);
    if (!inv) throw httpError(404, 'That invitation link is not valid.');
    /* An invite addressed to someone stays theirs; one with no address is a
       shareable link that any signed-in person can redeem. */
    if (inv.email && inv.email !== u.email) throw httpError(403, 'That invitation was addressed to a different account.');
    const s = q.get('SELECT * FROM squads WHERE id = ?', inv.squad_id);
    if (membership(s.id, u.id)) return { squad: squadShape(s, u.id), already: true };
    if (memberRows(s.id).length >= s.cap) throw httpError(409, 'That squad is full. Ask the captain to raise the limit.');
    q.run('INSERT OR IGNORE INTO squad_members (squad_id,user_id,role,joined_at) VALUES (?,?,?,?)',
      inv.squad_id, u.id, inv.role, now());
    if (inv.email) q.run('UPDATE invites SET accepted_at = ? WHERE id = ?', now(), inv.id);
    return { squad: squadShape(s, u.id) };
  });

  /* messages */
  /* ---------- rate limiting ----------
     One member with a loop should not be able to fill the database or keep the
     compiler busy. Counters live in memory: a restart forgives everyone, which
     is the right trade for a server this size. */
  const buckets = new Map();
  function limit(key, max, windowMs, what) {
    const now2 = Date.now();
    const b = buckets.get(key);
    if (!b || now2 > b.until) { buckets.set(key, { n: 1, until: now2 + windowMs }); return; }
    if (++b.n > max) {
      const wait = Math.ceil((b.until - now2) / 1000);
      throw httpError(429, `Too many ${what} — try again in ${wait}s.`);
    }
  }
  /* keep the map from growing without bound */
  setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.until) buckets.delete(k); }, 60000).unref?.();

  /* ---------- mentions ----------
     Parsed from the body against the squad's own roster, so @handle only
     notifies someone who is actually in the squad. */
  function recordMentions(msg, squadId, channelId, authorId) {
    const found = [...new Set((msg.body.match(/@([a-z0-9_]{3,20})/gi) || []).map(h => h.slice(1).toLowerCase()))];
    if (!found.length) return [];
    const members = q.all(`SELECT u.id, u.handle FROM squad_members m JOIN users u ON u.id = m.user_id
                           WHERE m.squad_id = ?`, squadId);
    const hits = members.filter(m => found.includes(m.handle.toLowerCase()) && m.id !== authorId);
    const t = now();
    for (const h of hits) {
      q.run('INSERT INTO mentions (id,user_id,message_id,channel_id,squad_id,created_at) VALUES (?,?,?,?,?,?)',
        uid('mn_'), h.id, msg.id, channelId, squadId, t);
    }
    return hits.map(h => h.id);
  }

  r.get('/api/mentions', async (ctx) => {
    const u = ctx.requireUser();
    return {
      mentions: q.all(`SELECT mn.id, mn.message_id, mn.channel_id, mn.squad_id, mn.created_at, mn.read_at,
                              c.name AS channel_name, c.icon AS channel_icon,
                              s.name AS squad_name, m.body, au.name AS author_name
                       FROM mentions mn
                       JOIN channels c ON c.id = mn.channel_id
                       JOIN squads   s ON s.id = mn.squad_id
                       JOIN messages m ON m.id = mn.message_id
                       JOIN users   au ON au.id = m.user_id
                       WHERE mn.user_id = ? AND mn.read_at IS NULL
                       ORDER BY mn.created_at DESC LIMIT 30`, u.id)
    };
  });

  r.post('/api/mentions/read', async (ctx) => {
    const u = ctx.requireUser();
    if (ctx.body.id) q.run('UPDATE mentions SET read_at = ? WHERE id = ? AND user_id = ?', now(), ctx.body.id, u.id);
    else q.run('UPDATE mentions SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), u.id);
    return { ok: true };
  });

  /* ---------- editing, deleting, pinning ---------- */
  r.patch('/api/messages/:id', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT m.*, c.squad_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That message no longer exists.');
    requireMember(m.squad_id, u);
    if (m.user_id !== u.id) throw httpError(403, 'You can only edit your own messages.');
    if (m.deleted_at) throw httpError(400, 'That message was deleted.');
    if (m.kind === 'voice') throw httpError(400, 'A voice note cannot be edited.');
    const body = String(ctx.body.body || '').trim();
    if (!body) throw httpError(400, 'An edit cannot be empty — delete it instead.');
    q.run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', body, now(), m.id);
    const row = q.get('SELECT m.*, u.name, u.handle FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?', m.id);
    const msg = messageShape({ ...row, _me: u.id });
    ctx.broadcast(m.squad_id, { type: 'message-edited', channelId: m.channel_id, message: msg });
    return { message: msg };
  });

  r.del('/api/messages/:id', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT m.*, c.squad_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That message no longer exists.');
    requireMember(m.squad_id, u);
    const role = membership(m.squad_id, u.id)?.role;
    if (m.user_id !== u.id && role !== 'captain')
      throw httpError(403, 'Only the author, or the captain, can delete a message.');
    /* A tombstone rather than a real delete: replies in a thread would
       otherwise lose the message they are answering. */
    q.run("UPDATE messages SET deleted_at = ?, body = '', pinned_at = NULL, file_id = NULL WHERE id = ?", now(), m.id);
    q.run('DELETE FROM reactions WHERE message_id = ?', m.id);
    q.run('DELETE FROM voice WHERE message_id = ?', m.id);
    q.run('DELETE FROM mentions WHERE message_id = ?', m.id);
    dropFile(m.file_id);
    ctx.broadcast(m.squad_id, { type: 'message-deleted', channelId: m.channel_id, id: m.id });
    return { ok: true };
  });

  r.post('/api/messages/:id/pin', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT m.*, c.squad_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That message no longer exists.');
    requireMember(m.squad_id, u);
    if (m.deleted_at) throw httpError(400, 'That message was deleted.');
    const on = !m.pinned_at;
    if (on && q.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL', m.channel_id).n >= 20)
      throw httpError(400, 'Twenty pins is the limit for one channel.');
    q.run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', on ? now() : null, on ? u.id : null, m.id);
    ctx.broadcast(m.squad_id, { type: 'pins', channelId: m.channel_id });
    return { pinned: on };
  });

  r.get('/api/channels/:id/pins', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    requireMember(ch.squad_id, u);
    const rows = q.all(`SELECT m.*, u.name, u.handle FROM messages m JOIN users u ON u.id = m.user_id
                        WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
                        ORDER BY m.pinned_at DESC`, ch.id);
    return { pins: rows.map(m => messageShape({ ...m, _me: u.id })) };
  });

  /* ---------- threads ---------- */
  r.get('/api/messages/:id/thread', async (ctx) => {
    const u = ctx.requireUser();
    const root = q.get('SELECT m.*, c.squad_id, u.name, u.handle FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id WHERE m.id = ?', ctx.params.id);
    if (!root) throw httpError(404, 'That message no longer exists.');
    requireMember(root.squad_id, u);
    const replies = q.all(`SELECT m.*, u.name, u.handle FROM messages m JOIN users u ON u.id = m.user_id
                           WHERE m.parent_id = ? ORDER BY m.created_at`, root.id);
    return {
      root: messageShape({ ...root, _me: u.id }),
      replies: replies.map(m => messageShape({ ...m, _me: u.id }))
    };
  });

  /* ---------- search ---------- */
  r.get('/api/squads/:id/search', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const term = String(ctx.query.get('q') || '').trim();
    if (term.length < 2) return { hits: [] };
    const hits = q.all(`SELECT m.id, m.body, m.created_at, m.channel_id, c.name AS channel_name, c.icon AS channel_icon,
                               au.name AS author_name, au.handle AS author_handle
                        FROM messages m
                        JOIN channels c ON c.id = m.channel_id
                        JOIN users   au ON au.id = m.user_id
                        WHERE c.squad_id = ? AND m.deleted_at IS NULL AND m.kind = 'text'
                          AND m.body LIKE ? ESCAPE '\\'
                        ORDER BY m.created_at DESC LIMIT 40`,
      ctx.params.id, '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%');
    return { hits, term };
  });

  /* ---------- leaving ---------- */
  r.post('/api/squads/:id/leave', async (ctx) => {
    const u = ctx.requireUser();
    const m = requireMember(ctx.params.id, u);
    const members = q.all('SELECT user_id, role FROM squad_members WHERE squad_id = ?', ctx.params.id);
    if (m.role === 'captain' && members.length > 1) {
      const heir = ctx.body.handTo
        ? members.find(x => x.user_id === ctx.body.handTo && x.user_id !== u.id)
        : members.find(x => x.user_id !== u.id);
      if (!heir) throw httpError(400, 'Pick someone to hand the squad to first.');
      q.run("UPDATE squad_members SET role = 'captain' WHERE squad_id = ? AND user_id = ?", ctx.params.id, heir.user_id);
    }
    q.run('DELETE FROM squad_members WHERE squad_id = ? AND user_id = ?', ctx.params.id, u.id);
    /* the last person out takes the squad with them */
    if (members.length === 1) q.run('DELETE FROM squads WHERE id = ?', ctx.params.id);
    ctx.broadcast(ctx.params.id, { type: 'squad-left', userId: u.id, name: u.name });
    return { ok: true, squadRemoved: members.length === 1 };
  });

  /* ---------- compiler: snippets + sandboxed execution ---------- */
  /* A personal snippet belongs to one person and is never listed for anyone
     else. A team snippet is visible to, and editable by, every member of the
     squad — it is the shared scratchpad. */
  const snippetShape = (r) => ({
    id: r.id, squadId: r.squad_id, scope: r.scope, title: r.title, lang: r.lang,
    body: r.body, stdin: r.stdin, createdAt: r.created_at, updatedAt: r.updated_at,
    includeAs: r.include_as || null,
    author: { id: r.user_id, name: r.author_name, handle: r.author_handle },
    updatedBy: r.updated_by ? { id: r.updated_by, name: r.editor_name } : null
  });
  const SNIP_SQL = `SELECT s.*, a.name AS author_name, a.handle AS author_handle, e.name AS editor_name
                    FROM snippets s JOIN users a ON a.id = s.user_id
                    LEFT JOIN users e ON e.id = s.updated_by`;

  function snippetFor(id, user) {
    const r = q.get(SNIP_SQL + ' WHERE s.id = ?', id);
    if (!r) throw httpError(404, 'That file no longer exists.');
    requireMember(r.squad_id, user);
    /* someone else's personal file is not theirs to see */
    if (r.scope === 'personal' && r.user_id !== user.id)
      throw httpError(403, 'That is someone else\'s personal file.');
    return r;
  }

  r.get('/api/squads/:id/snippets', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    return {
      runner: runnerStatus(),
      langs: Object.entries(LANGS).map(([k, v]) => ({ key: k, label: v.label })),
      personal: q.all(SNIP_SQL + " WHERE s.squad_id = ? AND s.scope = 'personal' AND s.user_id = ? ORDER BY s.updated_at DESC",
        ctx.params.id, u.id).map(snippetShape),
      team: q.all(SNIP_SQL + " WHERE s.squad_id = ? AND s.scope = 'team' ORDER BY s.updated_at DESC",
        ctx.params.id).map(snippetShape)
    };
  });

  r.post('/api/squads/:id/snippets', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    limit('snip:' + u.id, 20, 60000, 'new files');
    const scope = ctx.body.scope === 'team' ? 'team' : 'personal';
    const lang = LANGS[ctx.body.lang] ? ctx.body.lang : 'cpp';
    const title = String(ctx.body.title || '').trim().slice(0, 80) || 'untitled';
    if (q.get('SELECT COUNT(*) AS n FROM snippets WHERE squad_id = ? AND scope = ? AND (scope = ? OR user_id = ?)',
        ctx.params.id, scope, 'team', u.id).n >= 100)
      throw httpError(400, 'That is 100 files already — delete a few first.');
    const id = uid('sn_'), t = now();
    q.run(`INSERT INTO snippets (id,squad_id,user_id,scope,title,lang,body,stdin,created_at,updated_at,updated_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, u.id, scope, title, lang,
      String(ctx.body.body || ''), String(ctx.body.stdin || ''), t, t, u.id);
    const snippet = snippetShape(q.get(SNIP_SQL + ' WHERE s.id = ?', id));
    if (scope === 'team') ctx.broadcast(ctx.params.id, { type: 'snippet', snippet });
    return { snippet };
  });

  r.patch('/api/snippets/:id', async (ctx) => {
    const u = ctx.requireUser();
    const cur = snippetFor(ctx.params.id, u);
    /* team files are a shared surface — any member may edit; personal ones are not */
    if (cur.scope === 'personal' && cur.user_id !== u.id) throw httpError(403, 'Not your file.');
    const next = {
      title: ctx.body.title === undefined ? cur.title : String(ctx.body.title).trim().slice(0, 80) || 'untitled',
      lang:  LANGS[ctx.body.lang] ? ctx.body.lang : cur.lang,
      body:  ctx.body.body === undefined ? cur.body : String(ctx.body.body).slice(0, 200000),
      stdin: ctx.body.stdin === undefined ? cur.stdin : String(ctx.body.stdin).slice(0, 65536)
    };
    q.run('UPDATE snippets SET title=?,lang=?,body=?,stdin=?,updated_at=?,updated_by=? WHERE id=?',
      next.title, next.lang, next.body, next.stdin, now(), u.id, cur.id);
    const snippet = snippetShape(q.get(SNIP_SQL + ' WHERE s.id = ?', cur.id));
    if (snippet.scope === 'team') ctx.broadcast(cur.squad_id, { type: 'snippet', snippet });
    return { snippet };
  });

  r.del('/api/snippets/:id', async (ctx) => {
    const u = ctx.requireUser();
    const cur = snippetFor(ctx.params.id, u);
    const role = membership(cur.squad_id, u.id)?.role;
    if (cur.user_id !== u.id && role !== 'captain')
      throw httpError(403, 'Only the person who made it, or the captain, can delete it.');
    q.run('DELETE FROM snippets WHERE id = ?', cur.id);
    if (cur.scope === 'team') ctx.broadcast(cur.squad_id, { type: 'snippet-removed', id: cur.id });
    return { ok: true };
  });

  /* share a file into a channel so the squad sees it in context */
  r.post('/api/snippets/:id/share', async (ctx) => {
    const u = ctx.requireUser();
    const cur = snippetFor(ctx.params.id, u);
    const ch = q.get('SELECT * FROM channels WHERE id = ? AND squad_id = ?', ctx.body.channelId, cur.squad_id);
    if (!ch) throw httpError(404, 'Pick a channel in this squad.');
    const note = String(ctx.body.note || '').trim().slice(0, 300);
    const to = ctx.body.to ? q.get('SELECT u.handle FROM users u JOIN squad_members m ON m.user_id = u.id WHERE u.id = ? AND m.squad_id = ?', ctx.body.to, cur.squad_id) : null;
    const fence = LANGS[cur.lang]?.mono || '';
    const body = `${to ? '@' + to.handle + ' ' : ''}${note || 'Sharing ' + cur.title}\n\n\`\`\`${fence}\n${cur.body}\n\`\`\``;
    const id = uid('m_'), t = now();
    q.run('INSERT INTO messages (id,channel_id,user_id,body,created_at) VALUES (?,?,?,?,?)', id, ch.id, u.id, body, t);
    const msg = messageShape({ id, body, created_at: t, user_id: u.id, name: u.name, handle: u.handle, _me: u.id });
    ctx.broadcast(cur.squad_id, { type: 'message', channelId: ch.id, message: msg });
    return { message: msg, channel: { id: ch.id, name: ch.name } };
  });

  /* ---------- direct messages ----------
     Only between people who already share a squad: without that, anyone with
     an account could message anyone else, which is a different product. */
  const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);

  function sharesSquad(a, b) {
    return !!q.get(`SELECT 1 FROM squad_members m1 JOIN squad_members m2 ON m1.squad_id = m2.squad_id
                    WHERE m1.user_id = ? AND m2.user_id = ?`, a, b);
  }

  function threadFor(me, other, create) {
    const [a, b] = pairKey(me, other);
    let t = q.get('SELECT * FROM dm_threads WHERE a_id = ? AND b_id = ?', a, b);
    if (!t && create) {
      const id = uid('dm_'), n = now();
      q.run('INSERT INTO dm_threads (id,a_id,b_id,created_at,last_at) VALUES (?,?,?,?,?)', id, a, b, n, n);
      t = q.get('SELECT * FROM dm_threads WHERE id = ?', id);
    }
    return t;
  }

  function requireThread(id, user) {
    const t = q.get('SELECT * FROM dm_threads WHERE id = ?', id);
    if (!t) throw httpError(404, 'That conversation no longer exists.');
    if (t.a_id !== user.id && t.b_id !== user.id) throw httpError(403, 'That is not your conversation.');
    return t;
  }

  const dmShape = (m, meId) => ({
    id: m.id, body: m.deleted_at ? '' : m.body, created_at: m.created_at,
    deleted: !!m.deleted_at, editedAt: m.edited_at || null,
    image: m.deleted_at ? null : (m.image_id || null),
    file: m.deleted_at ? null : fileShape(m.file_id),
    author: { id: m.user_id, name: m.name, handle: m.handle },
    mine: m.user_id === meId
  });

  /* everyone you could write to, and every conversation you already have */
  r.get('/api/dms', async (ctx) => {
    const u = ctx.requireUser();
    const threads = q.all(`
      SELECT t.*, o.id AS other_id, o.name AS other_name, o.handle AS other_handle,
             (SELECT body FROM dm_messages WHERE thread_id = t.id AND deleted_at IS NULL
              ORDER BY created_at DESC LIMIT 1) AS preview,
             (SELECT COUNT(*) FROM dm_messages dm
               WHERE dm.thread_id = t.id AND dm.user_id != ?
                 AND dm.created_at > COALESCE((SELECT read_at FROM dm_reads WHERE thread_id = t.id AND user_id = ?), 0)
             ) AS unread
      FROM dm_threads t
      JOIN users o ON o.id = CASE WHEN t.a_id = ? THEN t.b_id ELSE t.a_id END
      WHERE (t.a_id = ? OR t.b_id = ?) AND o.deleted_at IS NULL
      ORDER BY t.last_at DESC`, u.id, u.id, u.id, u.id, u.id);

    const people = q.all(`
      SELECT DISTINCT o.id, o.name, o.handle FROM squad_members m1
      JOIN squad_members m2 ON m1.squad_id = m2.squad_id
      JOIN users o ON o.id = m2.user_id
      WHERE m1.user_id = ? AND o.id != ? AND o.deleted_at IS NULL
      ORDER BY o.name`, u.id, u.id);

    return { threads, people };
  });

  r.post('/api/dms', async (ctx) => {
    const u = ctx.requireUser();
    const other = String(ctx.body.userId || '');
    if (other === u.id) throw httpError(400, 'You cannot message yourself.');
    if (!sharesSquad(u.id, other)) throw httpError(403, 'You can only message people in your squads.');
    const t = threadFor(u.id, other, true);
    return { thread: t };
  });

  r.get('/api/dms/:id/messages', async (ctx) => {
    const u = ctx.requireUser();
    const t = requireThread(ctx.params.id, u);
    const before = Number(ctx.query.get('before')) || null;
    const page = Math.min(Number(ctx.query.get('limit')) || 60, 120);
    const rows = q.all(`SELECT m.rowid AS seq, m.*, u.name, u.handle
                        FROM dm_messages m JOIN users u ON u.id = m.user_id
                        WHERE m.thread_id = ? ${before ? 'AND m.rowid < ?' : ''}
                        ORDER BY m.rowid DESC LIMIT ?`,
      ...(before ? [t.id, before, page + 1] : [t.id, page + 1]));
    const more = rows.length > page;
    if (more) rows.pop();
    rows.reverse();
    const other = q.get('SELECT id,name,handle FROM users WHERE id = ?', t.a_id === u.id ? t.b_id : t.a_id);
    const theirRead = q.get('SELECT read_at FROM dm_reads WHERE thread_id = ? AND user_id = ?', t.id, other.id)?.read_at || 0;
    return {
      thread: t, other, more, theirRead,
      oldest: rows.length ? rows[0].seq : null,
      messages: rows.map(m => dmShape(m, u.id))
    };
  });

  r.post('/api/dms/:id/messages', async (ctx) => {
    const u = ctx.requireUser();
    const t = requireThread(ctx.params.id, u);
    limit('dm:' + u.id, 30, 20000, 'messages');
    const body = String(ctx.body.body || '').trim().slice(0, 8000);
    const imageId = ctx.body.imageId ? String(ctx.body.imageId) : null;
    const fileId = ctx.body.fileId ? String(ctx.body.fileId) : null;
    if (!body && !imageId && !fileId) throw httpError(400, 'Write something first.');
    if (imageId && !q.get('SELECT 1 FROM images WHERE id = ? AND owner_id = ?', imageId, u.id))
      throw httpError(400, 'That picture is not yours to send.');
    if (fileId && !q.get('SELECT 1 FROM files WHERE id = ? AND owner_id = ?', fileId, u.id))
      throw httpError(400, 'That file is not yours to send.');
    const id = uid('dmm_'), n = now();
    q.run('INSERT INTO dm_messages (id,thread_id,user_id,body,image_id,file_id,created_at) VALUES (?,?,?,?,?,?,?)',
      id, t.id, u.id, body, imageId, fileId, n);
    q.run('UPDATE dm_threads SET last_at = ? WHERE id = ?', n, t.id);
    /* `mine` is per viewer, so it cannot ride a broadcast that both people
       receive — the recipient was being told the sender's message was theirs
       and rendering it on the wrong side. The clients derive it from author. */
    const msg = dmShape({ id, thread_id: t.id, user_id: u.id, body, image_id: imageId, file_id: fileId, created_at: n, name: u.name, handle: u.handle }, u.id);
    const { mine, ...shared } = msg;
    ctx.dmNotify(t, { type: 'dm', threadId: t.id, message: shared });
    return { message: msg };
  });

  r.post('/api/dms/:id/read', async (ctx) => {
    const u = ctx.requireUser();
    const t = requireThread(ctx.params.id, u);
    const n = now();
    q.run(`INSERT INTO dm_reads (user_id,thread_id,read_at) VALUES (?,?,?)
           ON CONFLICT(user_id,thread_id) DO UPDATE SET read_at = excluded.read_at`, u.id, t.id, n);
    ctx.dmNotify(t, { type: 'dm-read', threadId: t.id, userId: u.id, readAt: n });
    return { ok: true, readAt: n };
  });

  r.del('/api/dm-messages/:id', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT * FROM dm_messages WHERE id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That message no longer exists.');
    if (m.user_id !== u.id) throw httpError(403, 'You can only delete your own messages.');
    q.run("UPDATE dm_messages SET deleted_at = ?, body = '', file_id = NULL WHERE id = ?", now(), m.id);
    dropFile(m.file_id);
    const t = q.get('SELECT * FROM dm_threads WHERE id = ?', m.thread_id);
    ctx.dmNotify(t, { type: 'dm-deleted', threadId: t.id, id: m.id });
    return { ok: true };
  });

  /* ---------- pictures ---------- */
  const IMG_MAX = 2 * 1024 * 1024;
  r.post('/api/images', async (ctx) => {
    const u = ctx.requireUser();
    limit('img:' + u.id, 20, 60000, 'uploads');
    const mime = String(ctx.body.mime || 'image/png');
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) throw httpError(400, 'PNG, JPEG or WebP only.');
    let bytes;
    try { bytes = Buffer.from(String(ctx.body.data || ''), 'base64'); }
    catch { throw httpError(400, 'That picture could not be read.'); }
    if (!bytes.length) throw httpError(400, 'That picture was empty.');
    if (bytes.length > IMG_MAX) throw httpError(413, 'That picture is too large — 2MB is the limit.');
    const id = uid('img_');
    q.run('INSERT INTO images (id,owner_id,mime,w,h,bytes,created_at) VALUES (?,?,?,?,?,?,?)',
      id, u.id, mime, Number(ctx.body.w) || 0, Number(ctx.body.h) || 0, bytes, now());
    return { id, w: Number(ctx.body.w) || 0, h: Number(ctx.body.h) || 0 };
  });

  r.get('/api/images/:id', async (ctx) => {
    const u = ctx.requireUser();
    const img = q.get('SELECT * FROM images WHERE id = ?', ctx.params.id);
    if (!img) throw httpError(404, 'That picture is gone.');
    /* yours, or attached to something you can already see */
    const reachable = img.owner_id === u.id
      || q.get(`SELECT 1 FROM dm_messages m JOIN dm_threads t ON t.id = m.thread_id
                WHERE m.image_id = ? AND (t.a_id = ? OR t.b_id = ?)`, img.id, u.id, u.id)
      || q.get(`SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id
                JOIN squad_members sm ON sm.squad_id = c.squad_id
                WHERE m.image_id = ? AND sm.user_id = ?`, img.id, u.id);
    if (!reachable) throw httpError(403, 'That picture is not shared with you.');
    return { __raw: { body: img.bytes, type: img.mime } };
  });

  /* post a picture into a channel (a board snapshot, usually) */
  r.post('/api/channels/:id/image', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    requireMember(ch.squad_id, u);
    const imageId = String(ctx.body.imageId || '');
    if (!q.get('SELECT 1 FROM images WHERE id = ? AND owner_id = ?', imageId, u.id))
      throw httpError(400, 'That picture is not yours to send.');
    const id = uid('m_'), t = now();
    const body = String(ctx.body.body || '').trim().slice(0, 500);
    q.run('INSERT INTO messages (id,channel_id,user_id,body,created_at,image_id) VALUES (?,?,?,?,?,?)',
      id, ch.id, u.id, body, t, imageId);
    const msg = messageShape({ id, body, created_at: t, user_id: u.id, name: u.name, handle: u.handle, image_id: imageId, _me: u.id });
    ctx.broadcast(ch.squad_id, { type: 'message', channelId: ch.id, message: msg });
    return { message: msg };
  });

  /* ---------- test cases and the shared template library ---------- */
  const includesFor = (squadId) =>
    q.all("SELECT include_as AS name, body FROM snippets WHERE squad_id = ? AND scope = 'team' AND include_as IS NOT NULL AND include_as != ''", squadId);

  r.get('/api/snippets/:id/tests', async (ctx) => {
    const u = ctx.requireUser();
    const sn = snippetFor(ctx.params.id, u);
    return { tests: q.all('SELECT * FROM tests WHERE snippet_id = ? ORDER BY position, created_at', sn.id) };
  });

  r.post('/api/snippets/:id/tests', async (ctx) => {
    const u = ctx.requireUser();
    const sn = snippetFor(ctx.params.id, u);
    if (q.get('SELECT COUNT(*) AS n FROM tests WHERE snippet_id = ?', sn.id).n >= 25)
      throw httpError(400, 'Twenty-five cases is the limit for one file.');
    const id = uid('tc_');
    const pos = (q.get('SELECT COALESCE(MAX(position),-1) AS p FROM tests WHERE snippet_id = ?', sn.id).p) + 1;
    q.run('INSERT INTO tests (id,snippet_id,name,stdin,expected,position,created_at) VALUES (?,?,?,?,?,?,?)',
      id, sn.id, String(ctx.body.name || `case ${pos + 1}`).slice(0, 40),
      String(ctx.body.stdin || '').slice(0, 65536), String(ctx.body.expected || '').slice(0, 65536), pos, now());
    return { test: q.get('SELECT * FROM tests WHERE id = ?', id) };
  });

  r.patch('/api/tests/:id', async (ctx) => {
    const u = ctx.requireUser();
    const t = q.get('SELECT * FROM tests WHERE id = ?', ctx.params.id);
    if (!t) throw httpError(404, 'That case is gone.');
    snippetFor(t.snippet_id, u);
    q.run('UPDATE tests SET name = ?, stdin = ?, expected = ? WHERE id = ?',
      ctx.body.name === undefined ? t.name : String(ctx.body.name).slice(0, 40),
      ctx.body.stdin === undefined ? t.stdin : String(ctx.body.stdin).slice(0, 65536),
      ctx.body.expected === undefined ? t.expected : String(ctx.body.expected).slice(0, 65536), t.id);
    return { test: q.get('SELECT * FROM tests WHERE id = ?', t.id) };
  });

  r.del('/api/tests/:id', async (ctx) => {
    const u = ctx.requireUser();
    const t = q.get('SELECT * FROM tests WHERE id = ?', ctx.params.id);
    if (!t) throw httpError(404, 'That case is gone.');
    snippetFor(t.snippet_id, u);
    q.run('DELETE FROM tests WHERE id = ?', t.id);
    return { ok: true };
  });

  r.post('/api/snippets/:id/run-tests', async (ctx) => {
    const u = ctx.requireUser();
    const sn = snippetFor(ctx.params.id, u);
    limit('run:' + u.id, 20, 60000, 'runs');
    const cases = q.all('SELECT id,name,stdin,expected FROM tests WHERE snippet_id = ? ORDER BY position, created_at', sn.id);
    return await runTests({
      lang: ctx.body.lang || sn.lang,
      source: ctx.body.source !== undefined ? String(ctx.body.source) : sn.body,
      cases,
      includes: includesFor(sn.squad_id).filter(i => i.name && sn.include_as !== i.name)
    });
  });

  /* make a team file includable — or stop it being one */
  r.post('/api/snippets/:id/include', async (ctx) => {
    const u = ctx.requireUser();
    const sn = snippetFor(ctx.params.id, u);
    if (sn.scope !== 'team') throw httpError(400, 'Only team files can go in the library.');
    const raw = String(ctx.body.name || '').trim();
    if (!raw) { q.run('UPDATE snippets SET include_as = NULL WHERE id = ?', sn.id); return { includeAs: null }; }
    const name = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
    if (!name) throw httpError(400, 'Use letters, numbers, dots, dashes or underscores.');
    if (q.get('SELECT 1 FROM snippets WHERE squad_id = ? AND include_as = ? AND id != ?', sn.squad_id, name, sn.id))
      throw httpError(409, 'Another file in the library already uses that name.');
    q.run('UPDATE snippets SET include_as = ? WHERE id = ?', name, sn.id);
    ctx.broadcast(sn.squad_id, { type: 'snippet', snippet: snippetShape(q.get(SNIP_SQL + ' WHERE s.id = ?', sn.id)) });
    return { includeAs: name };
  });

  r.get('/api/squads/:id/library', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    return { library: q.all("SELECT id, title, include_as, lang FROM snippets WHERE squad_id = ? AND scope = 'team' AND include_as IS NOT NULL AND include_as != '' ORDER BY include_as", ctx.params.id) };
  });

  /* ---------- importing a contest schedule ----------
     Takes pasted text rather than fetching a third party: nothing leaves this
     machine, it works offline, and it handles the ICS files judges publish as
     well as a plain list typed by hand. */
  function parseSchedule(text) {
    const out = [];
    const raw = String(text || '');

    /* unfold ICS continuation lines before anything else */
    const ics = raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    if (/BEGIN:VEVENT/i.test(ics)) {
      for (const block of ics.split(/BEGIN:VEVENT/i).slice(1)) {
        const get = (k) => (block.match(new RegExp('^' + k + '[^:\\n]*:(.*)$', 'im')) || [])[1]?.trim();
        const when = get('DTSTART'), title = get('SUMMARY');
        if (!when || !title) continue;
        const m = when.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
        if (!m) continue;
        const [, y, mo, d, hh = '00', mi = '00', ss = '00', z] = m;
        const ms = z ? Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) : new Date(+y, +mo - 1, +d, +hh, +mi, +ss).getTime();
        let mins = 120;
        const end = get('DTEND');
        if (end) {
          const e = end.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
          if (e) {
            const ems = e[7] ? Date.UTC(+e[1], +e[2] - 1, +e[3], +(e[4] || 0), +(e[5] || 0), +(e[6] || 0))
                             : new Date(+e[1], +e[2] - 1, +e[3], +(e[4] || 0), +(e[5] || 0), +(e[6] || 0)).getTime();
            if (ems > ms) mins = Math.min(Math.round((ems - ms) / 60000), 60 * 24);
          }
        }
        out.push({ title: title.slice(0, 120), startsAt: ms, minutes: mins });
      }
      return out;
    }

    /* otherwise: one per line, "2026-03-14 18:00 Div 2 Round" or with a comma */
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || /^#/.test(t)) continue;
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T,]+(\d{1,2}):(\d{2})\s*[,\-–]?\s*(.+)$/);
      if (!m) continue;
      const [, y, mo, d, hh, mi, title] = m;
      out.push({
        title: title.trim().slice(0, 120),
        startsAt: new Date(+y, +mo - 1, +d, +hh, +mi).getTime(),
        minutes: 120
      });
    }
    return out;
  }

  r.post('/api/squads/:id/schedule/preview', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const found = parseSchedule(ctx.body.text).slice(0, 60);
    return { found, count: found.length };
  });

  r.post('/api/squads/:id/schedule/import', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    limit('import:' + u.id, 5, 60000, 'imports');
    const rows = parseSchedule(ctx.body.text).slice(0, 60);
    let added = 0, skipped = 0;
    for (const e of rows) {
      /* re-importing the same file should not double every round */
      const dup = q.get('SELECT 1 FROM events WHERE squad_id = ? AND title = ? AND starts_at = ?',
        ctx.params.id, e.title, e.startsAt);
      if (dup) { skipped++; continue; }
      const id = uid('e_');
      q.run(`INSERT INTO events (id,squad_id,title,kind,starts_at,duration,created_by,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
        id, ctx.params.id, e.title, 'contest', e.startsAt, e.minutes, u.id, now());
      ctx.broadcast(ctx.params.id, { type: 'event', event: q.get('SELECT * FROM events WHERE id = ?', id) });
      added++;
    }
    return { added, skipped, total: rows.length };
  });

  /* ---------- whiteboard ---------- */
  /* Pages are just named boards; strokes already carried a board name, so a
     page is a row here plus the strokes that reference it. */
  /* boards.id is a global primary key, so the first page cannot simply be
     called "main" for every squad — the second squad to open a whiteboard
     collided. Each squad gets its own id, and anything already drawn under the
     old "main" key is moved onto it so no marks are stranded. */
  function ensurePages(squadId) {
    if (q.get('SELECT 1 FROM boards WHERE squad_id = ?', squadId)) return;
    const id = uid('bd_');
    q.run('INSERT INTO boards (id,squad_id,name,position,created_at) VALUES (?,?,?,?,?)',
      id, squadId, 'Page 1', 0, now());
    q.run("UPDATE strokes SET board = ? WHERE squad_id = ? AND board = 'main'", id, squadId);
  }

  /* A page is either the squad's or one person's. Personal pages are never
     listed for anyone else and their strokes are unreachable — the shared
     board is still shared, but it is no longer the only option. */
  function pageFor(boardId, squadId, user) {
    const b = q.get('SELECT * FROM boards WHERE id = ? AND squad_id = ?', boardId, squadId);
    if (!b) throw httpError(404, 'That page no longer exists.');
    if (b.owner_id && b.owner_id !== user.id) throw httpError(403, 'That is someone else\'s private page.');
    return b;
  }

  r.get('/api/squads/:id/boards', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    ensurePages(ctx.params.id);
    return {
      boards: q.all(`SELECT b.id, b.name, b.position, b.owner_id,
                            (SELECT COUNT(*) FROM strokes s WHERE s.squad_id = b.squad_id AND s.board = b.id) AS marks
                     FROM boards b
                     WHERE b.squad_id = ? AND (b.owner_id IS NULL OR b.owner_id = ?)
                     ORDER BY b.owner_id IS NOT NULL, b.position, b.created_at`, ctx.params.id, u.id)
        .map(b => ({ ...b, scope: b.owner_id ? 'personal' : 'team' }))
    };
  });

  r.post('/api/squads/:id/boards', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    ensurePages(ctx.params.id);
    if (q.get('SELECT COUNT(*) AS n FROM boards WHERE squad_id = ?', ctx.params.id).n >= 20)
      throw httpError(400, 'Twenty pages is the limit.');
    const id = uid('bd_');
    const personal = ctx.body.scope === 'personal';
    const pos = (q.get('SELECT COALESCE(MAX(position),-1) AS p FROM boards WHERE squad_id = ?', ctx.params.id).p) + 1;
    q.run('INSERT INTO boards (id,squad_id,name,position,created_at,owner_id) VALUES (?,?,?,?,?,?)',
      id, ctx.params.id, String(ctx.body.name || `Page ${pos + 1}`).slice(0, 40), pos, now(), personal ? u.id : null);
    const board = q.get('SELECT id,name,position,owner_id FROM boards WHERE id = ?', id);
    /* only a shared page is news to anyone else */
    if (!personal) ctx.broadcast(ctx.params.id, { type: 'boards' });
    return { board: { ...board, scope: personal ? 'personal' : 'team' } };
  });

  r.patch('/api/boards/:id', async (ctx) => {
    const u = ctx.requireUser();
    const b = q.get('SELECT * FROM boards WHERE id = ?', ctx.params.id);
    if (!b) throw httpError(404, 'That page is gone.');
    requireMember(b.squad_id, u);
    if (b.owner_id && b.owner_id !== u.id) throw httpError(403, 'That is someone else\'s private page.');
    q.run('UPDATE boards SET name = ? WHERE id = ?', String(ctx.body.name || b.name).slice(0, 40), b.id);
    if (!b.owner_id) ctx.broadcast(b.squad_id, { type: 'boards' });
    return { ok: true };
  });

  r.del('/api/boards/:id', async (ctx) => {
    const u = ctx.requireUser();
    const b = q.get('SELECT * FROM boards WHERE id = ?', ctx.params.id);
    if (!b) throw httpError(404, 'That page is gone.');
    requireMember(b.squad_id, u);
    if (b.owner_id && b.owner_id !== u.id) throw httpError(403, 'That is someone else\'s private page.');
    /* the squad must keep one shared page; personal ones can all go */
    if (!b.owner_id && q.get('SELECT COUNT(*) AS n FROM boards WHERE squad_id = ? AND owner_id IS NULL', b.squad_id).n < 2)
      throw httpError(400, 'A whiteboard needs at least one shared page.');
    q.run('DELETE FROM strokes WHERE squad_id = ? AND board = ?', b.squad_id, b.id);
    q.run('DELETE FROM boards WHERE id = ?', b.id);
    if (!b.owner_id) ctx.broadcast(b.squad_id, { type: 'boards' });
    return { ok: true };
  });

  /* an unnamed board means "this squad's first page" */
  const firstPage = (squadId) => {
    ensurePages(squadId);
    return q.get('SELECT id FROM boards WHERE squad_id = ? AND owner_id IS NULL ORDER BY position, created_at LIMIT 1', squadId).id;
  };

  r.get('/api/squads/:id/board', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const board = String(ctx.query.get('board') || '').slice(0, 40) || firstPage(ctx.params.id);
    pageFor(board, ctx.params.id, u);
    return {
      strokes: q.all(`SELECT s.id, s.user_id, s.colour, s.width, s.points, s.created_at, s.kind, s.text, s.fill, s.font, s.size, u.name
                      FROM strokes s JOIN users u ON u.id = s.user_id
                      WHERE s.squad_id = ? AND s.board = ? ORDER BY s.created_at LIMIT 4000`,
        ctx.params.id, board).map(s => ({ ...s, points: JSON.parse(s.points) }))
    };
  });

  r.post('/api/squads/:id/board', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    limit('draw:' + u.id, 240, 60000, 'strokes');
    const board = String(ctx.body.board || '').slice(0, 40) || firstPage(ctx.params.id);
    const page = pageFor(board, ctx.params.id, u);
    const pts = Array.isArray(ctx.body.points) ? ctx.body.points.slice(0, 600) : [];
    const minPts = ctx.body.kind === 'text' ? 1 : 2;
    if (pts.length < minPts) throw httpError(400, 'A stroke needs at least two points.');
    const clean = pts.map(p => [Math.round(Number(p[0]) || 0), Math.round(Number(p[1]) || 0)]);
    const KINDS_OK = ['pen', 'line', 'rect', 'ellipse', 'arrow', 'text'];
    const kind = KINDS_OK.includes(ctx.body.kind) ? ctx.body.kind : 'pen';
    const text = kind === 'text' ? String(ctx.body.text || '').slice(0, 200) : null;
    if (kind === 'text' && !text) throw httpError(400, 'Type something for the label.');
    const id = uid('st_'), t = now();
    const colour = String(ctx.body.colour || '#E9B949').slice(0, 24);
    const width = Math.max(1, Math.min(Number(ctx.body.width) || 3, 40));
    const fill = ctx.body.fill ? 1 : 0;
    const FONTS = ['sans', 'serif', 'mono'];
    const font = FONTS.includes(ctx.body.font) ? ctx.body.font : 'sans';
    const size = Math.max(10, Math.min(Number(ctx.body.size) || 28, 160));
    q.run('INSERT INTO strokes (id,squad_id,board,user_id,colour,width,points,created_at,kind,text,fill,font,size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, ctx.params.id, board, u.id, colour, width, JSON.stringify(clean), t, kind, text, fill, font, size);
    const stroke = { id, user_id: u.id, name: u.name, colour, width, points: clean, created_at: t, kind, text, fill, font, size };
    if (!page.owner_id) ctx.broadcast(ctx.params.id, { type: 'stroke', board, stroke });
    return { stroke };
  });

  r.post('/api/squads/:id/board/undo', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const board = String(ctx.body.board || '').slice(0, 40) || firstPage(ctx.params.id);
    pageFor(board, ctx.params.id, u);
    const last = q.get('SELECT id FROM strokes WHERE squad_id = ? AND board = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
      ctx.params.id, board, u.id);
    if (!last) return { ok: true, removed: null };
    q.run('DELETE FROM strokes WHERE id = ?', last.id);
    if (!q.get('SELECT owner_id FROM boards WHERE id = ?', board)?.owner_id)
      ctx.broadcast(ctx.params.id, { type: 'stroke-removed', board, id: last.id });
    return { ok: true, removed: last.id };
  });

  r.del('/api/squads/:id/board', async (ctx) => {
    const u = ctx.requireUser();
    const m = requireMember(ctx.params.id, u);
    const board = String(ctx.query.get('board') || '').slice(0, 40) || firstPage(ctx.params.id);
    const page = pageFor(board, ctx.params.id, u);
    /* on your own page everything is yours; on a shared one, your own marks —
       or the whole surface if you are the captain */
    if (ctx.query.get('mine') === '1' || (m.role !== 'captain' && !page.owner_id))
      q.run('DELETE FROM strokes WHERE squad_id = ? AND board = ? AND user_id = ?', ctx.params.id, board, u.id);
    else
      q.run('DELETE FROM strokes WHERE squad_id = ? AND board = ?', ctx.params.id, board);
    if (!page.owner_id) ctx.broadcast(ctx.params.id, { type: 'board-cleared', board });
    return { ok: true };
  });

  r.post('/api/run', async (ctx) => {
    const u = ctx.requireUser();
    /* running is squad-gated so a bare account cannot use the box as a shell */
    limit('run:' + u.id, 20, 60000, 'runs');
    if (ctx.body.squadId) requireMember(ctx.body.squadId, u);
    else if (!q.get('SELECT 1 FROM squad_members WHERE user_id = ?', u.id))
      throw httpError(403, 'Join a squad before running code.');
    return await runCode({ lang: ctx.body.lang, source: ctx.body.source, stdin: ctx.body.stdin,
      includes: ctx.body.squadId ? includesFor(ctx.body.squadId) : [] });
  });

  /* channels */
  r.post('/api/squads/:id/channels', async (ctx) => {
    const u = ctx.requireUser();
    const sq = q.get('SELECT * FROM squads WHERE id = ?', ctx.params.id);
    if (!sq) throw httpError(404, 'That squad no longer exists.');
    requireMember(sq.id, u);

    const name = String(ctx.body.name || '').trim().toLowerCase()
      .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    if (!name) throw httpError(400, 'Give the channel a name.');
    if (q.get('SELECT 1 FROM channels WHERE squad_id = ? AND name = ?', sq.id, name))
      throw httpError(409, 'That channel already exists.');
    if (q.get('SELECT COUNT(*) AS n FROM channels WHERE squad_id = ?', sq.id).n >= 40)
      throw httpError(400, 'This squad has hit the 40 channel limit.');

    /* one grapheme of whatever the user picked — emoji, symbol, or a letter */
    const icon = [...String(ctx.body.icon || '#').trim()].slice(0, 2).join('') || '#';
    const position = (q.get('SELECT COALESCE(MAX(position),-1) AS p FROM channels WHERE squad_id = ?', sq.id).p) + 1;
    const id = uid('c_');
    q.run('INSERT INTO channels (id,squad_id,name,position,icon) VALUES (?,?,?,?,?)', id, sq.id, name, position, icon);

    const channel = { id, name, position, icon, unread: 0 };
    ctx.broadcast(sq.id, { type: 'channel', squadId: sq.id, channel });
    return { channel };
  });

  r.del('/api/channels/:id', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    const m = requireMember(ch.squad_id, u);
    if (m.role !== 'captain') throw httpError(403, 'Only the captain can delete a channel.');
    if (q.get('SELECT COUNT(*) AS n FROM channels WHERE squad_id = ?', ch.squad_id).n < 2)
      throw httpError(400, 'A squad needs at least one channel.');
    /* messages, voice clips and mentions cascade from the channel row */
    const msgs = q.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ch.id).n;
    q.run('DELETE FROM channels WHERE id = ?', ch.id);
    ctx.broadcast(ch.squad_id, { type: 'channel-removed', squadId: ch.squad_id, id: ch.id, name: ch.name });
    return { ok: true, messagesRemoved: msgs };
  });

  r.post('/api/channels/:id/read', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    requireMember(ch.squad_id, u);
    const t = now();
    q.run(`INSERT INTO channel_reads (user_id,channel_id,read_at) VALUES (?,?,?)
           ON CONFLICT(user_id,channel_id) DO UPDATE SET read_at = excluded.read_at`, u.id, ch.id, t);
    ctx.broadcast(ch.squad_id, { type: 'read', channelId: ch.id, userId: u.id, readAt: t });
    return { ok: true, channelId: ch.id, readAt: t };
  });

  r.get('/api/channels/:id/messages', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    requireMember(ch.squad_id, u);
    /* A page at a time, newest first, then flipped: a squad that has been
       talking for a term used to lose everything past the most recent 200.
       The cursor is rowid, not created_at — a burst of messages can share a
       millisecond, and `created_at < cursor` then skips every one of them. */
    const before = Number(ctx.query.get('before')) || null;
    const page = Math.min(Number(ctx.query.get('limit')) || 60, 120);
    const rows = q.all(`SELECT m.rowid AS seq, m.*, u.name, u.handle
                        FROM messages m JOIN users u ON u.id = m.user_id
                        WHERE m.channel_id = ? AND m.parent_id IS NULL
                          ${before ? 'AND m.rowid < ?' : ''}
                        ORDER BY m.rowid DESC LIMIT ?`,
      ...(before ? [ch.id, before, page + 1] : [ch.id, page + 1]));
    const more = rows.length > page;
    if (more) rows.pop();
    rows.reverse();
    /* One row per member rather than per message: the client works out who has
       seen what by comparing each person's read mark against a message's time. */
    const reads = q.all('SELECT user_id, read_at FROM channel_reads WHERE channel_id = ?', ch.id);
    return {
      channel: ch, reads, more,
      oldest: rows.length ? rows[0].seq : null,   /* rowid cursor for the next page */
      pinned: q.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL', ch.id).n,
      messages: rows.map(m => messageShape({ ...m, _me: u.id }))
    };
  });

  r.post('/api/channels/:id/messages', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    requireMember(ch.squad_id, u);
    limit('msg:' + u.id, 30, 20000, 'messages');
    const body = String(ctx.body.body || '').trim().slice(0, 8000);
    /* an attachment can travel on its own — a file with no caption is a message */
    const fileId = ctx.body.fileId ? String(ctx.body.fileId) : null;
    if (!body && !fileId) throw httpError(400, 'Write something first.');
    if (fileId && !q.get('SELECT 1 FROM files WHERE id = ? AND owner_id = ?', fileId, u.id))
      throw httpError(400, 'That file is not yours to send.');
    let parentId = null;
    if (ctx.body.parentId) {
      const root = q.get('SELECT id, channel_id, parent_id FROM messages WHERE id = ?', ctx.body.parentId);
      if (!root || root.channel_id !== ch.id) throw httpError(400, 'That thread is not in this channel.');
      /* threads are one level deep — replying to a reply joins the same thread */
      parentId = root.parent_id || root.id;
    }
    const id = uid('m_'), t = now();
    q.run('INSERT INTO messages (id,channel_id,user_id,body,created_at,parent_id,file_id) VALUES (?,?,?,?,?,?,?)',
      id, ch.id, u.id, body, t, parentId, fileId);
    const msg = messageShape({ id, body, created_at: t, user_id: u.id, name: u.name, handle: u.handle, parent_id: parentId, file_id: fileId, _me: u.id });
    const mentioned = recordMentions(msg, ch.squad_id, ch.id, u.id);
    ctx.broadcast(ch.squad_id, { type: 'message', channelId: ch.id, message: msg, mentioned });
    return { message: msg };
  });

  /* ---------- voice notes ----------
     The clip arrives base64 inside the normal JSON body, which keeps it under
     the existing 1MB request cap; the client caps recordings at 90s so a clip
     cannot get near it. Bytes live in the row, not on disk, so deleting a
     channel takes its audio with it. */
  const VOICE_MAX = 700 * 1024;
  r.post('/api/channels/:id/voice', async (ctx) => {
    const u = ctx.requireUser();
    const ch = q.get('SELECT * FROM channels WHERE id = ?', ctx.params.id);
    if (!ch) throw httpError(404, 'That channel no longer exists.');
    requireMember(ch.squad_id, u);
    limit('voice:' + u.id, 10, 60000, 'voice notes');

    const mime = String(ctx.body.mime || 'audio/webm').slice(0, 60);
    if (!/^audio\//.test(mime)) throw httpError(400, 'That is not audio.');
    const ms = Math.max(300, Math.min(Number(ctx.body.ms) || 0, 95000));
    let bytes;
    try { bytes = Buffer.from(String(ctx.body.audio || ''), 'base64'); }
    catch { throw httpError(400, 'The recording could not be read.'); }
    if (!bytes.length) throw httpError(400, 'The recording was empty.');
    if (bytes.length > VOICE_MAX) throw httpError(413, 'That recording is too long to send.');

    const peaks = Array.isArray(ctx.body.peaks)
      ? ctx.body.peaks.slice(0, 64).map(n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))) : [];

    const id = uid('m_'), vid = uid('v_'), t = now();
    q.run('INSERT INTO messages (id,channel_id,user_id,body,created_at,kind) VALUES (?,?,?,?,?,?)',
      id, ch.id, u.id, '', t, 'voice');
    q.run('INSERT INTO voice (id,message_id,mime,ms,peaks,bytes,created_at) VALUES (?,?,?,?,?,?,?)',
      vid, id, mime, ms, JSON.stringify(peaks), bytes, t);

    const msg = messageShape({ id, body: '', created_at: t, kind: 'voice', user_id: u.id, name: u.name, handle: u.handle, _me: u.id });
    ctx.broadcast(ch.squad_id, { type: 'message', channelId: ch.id, message: msg });
    return { message: msg };
  });

  r.get('/api/voice/:id', async (ctx) => {
    const u = ctx.requireUser();
    const v = q.get(`SELECT v.*, c.squad_id FROM voice v
                     JOIN messages m ON m.id = v.message_id
                     JOIN channels c ON c.id = m.channel_id WHERE v.id = ?`, ctx.params.id);
    if (!v) throw httpError(404, 'That clip is gone.');
    requireMember(v.squad_id, u);
    return { __raw: { body: v.bytes, type: v.mime } };
  });

  r.post('/api/messages/:id/reactions', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT m.*, c.squad_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That message no longer exists.');
    requireMember(m.squad_id, u);
    const key = String(ctx.body.key || '').slice(0, 20);
    const has = q.get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND key = ?', m.id, u.id, key);
    if (has) q.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND key = ?', m.id, u.id, key);
    else q.run('INSERT INTO reactions (message_id,user_id,key) VALUES (?,?,?)', m.id, u.id, key);
    const reactions = q.all('SELECT key, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY key', m.id);
    ctx.broadcast(m.squad_id, { type: 'reaction', messageId: m.id, reactions });
    return { reactions, mine: !has };
  });

  /* tasks */
  r.post('/api/squads/:id/tasks', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    /* xp is deliberately not read from the request — every task is TASK_XP */
    const { title, col = 'Backlog', priority = 'md', tags = '', due = null } = ctx.body;
    if (!String(title || '').trim()) throw httpError(400, 'Give the task a title.');
    const ownerId = ctx.body.private ? u.id : null;
    /* assigning a private task to someone else would hand them work they
       cannot see — a private task is yours or nobody's */
    const assignee_id = ownerId ? (ctx.body.assignee_id === u.id ? u.id : null) : (ctx.body.assignee_id || null);
    const id = uid('t_');
    const pos = (q.get('SELECT COALESCE(MAX(position),0) AS p FROM tasks WHERE squad_id = ? AND col = ?', ctx.params.id, col).p) + 1;
    q.run(`INSERT INTO tasks (id,squad_id,title,col,xp,priority,tags,assignee_id,due,position,created_at,owner_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ctx.params.id, String(title).trim(), col, TASK_XP, priority, tags, assignee_id, due, pos, now(), ownerId);
    const task = q.get('SELECT * FROM tasks WHERE id = ?', id);
    if (ownerId) ctx.notifyUser(u.id, { type: 'task', task });
    else ctx.broadcast(ctx.params.id, { type: 'task', task });
    return { task };
  });

  /* Somebody else's private task answers 404 rather than 403: a task nobody
     may see should not confirm that it exists either. */
  const reachTask = (id, u) => {
    const t = q.get('SELECT * FROM tasks WHERE id = ?', id);
    if (!t) throw httpError(404, 'That task no longer exists.');
    requireMember(t.squad_id, u);
    if (t.owner_id && t.owner_id !== u.id) throw httpError(404, 'That task no longer exists.');
    return t;
  };

  /* XP is the squad's public record of who is carrying the load, so it is owed
     only while the work is on the shared board and done. Stated as a state
     rather than a transition, every path settles correctly on its own: solving,
     reopening, and taking a solved task private or public again. */
  const xpOwed = (task) => (task.col === 'Solved' && !task.owner_id) ? TASK_XP : 0;

  r.patch('/api/tasks/:id', async (ctx) => {
    const u = ctx.requireUser();
    const t = reachTask(ctx.params.id, u);

    const next = { ...t, ...pick(ctx.body, ['title', 'col', 'priority', 'tags', 'assignee_id', 'due', 'position']), xp: TASK_XP };
    /* only the owner of a private task can change it, and they are the only
       one who can reach this line, so privacy is theirs to flip either way */
    if ('private' in ctx.body) next.owner_id = ctx.body.private ? u.id : null;
    if (next.owner_id && next.assignee_id !== u.id) next.assignee_id = null;

    q.run(`UPDATE tasks SET title=?,col=?,xp=?,priority=?,tags=?,assignee_id=?,due=?,position=?,owner_id=? WHERE id=?`,
      next.title, next.col, next.xp, next.priority, next.tags, next.assignee_id, next.due, next.position, next.owner_id, t.id);

    const xpDelta = xpOwed(next) - xpOwed(t);
    if (xpDelta) {
      const who = next.assignee_id || t.assignee_id || u.id;
      q.run('INSERT INTO xp_ledger (id,user_id,squad_id,amount,reason,created_at) VALUES (?,?,?,?,?,?)',
        uid('x_'), who, t.squad_id, xpDelta, next.title, now());
    }
    const task = q.get('SELECT * FROM tasks WHERE id = ?', t.id);

    if (task.owner_id) {
      /* it belongs to one person now — and if it was on the shared board a
         moment ago, take it off everyone else's screen */
      if (!t.owner_id) ctx.broadcast(t.squad_id, { type: 'task-removed', id: t.id });
      ctx.notifyUser(u.id, { type: 'task', task, xpDelta });
    } else {
      ctx.broadcast(t.squad_id, { type: 'task', task, xpDelta });
    }
    return { task, xpDelta, xp: totalXp(u.id) };
  });

  r.del('/api/tasks/:id', async (ctx) => {
    const u = ctx.requireUser();
    const t = reachTask(ctx.params.id, u);
    q.run('DELETE FROM tasks WHERE id = ?', t.id);
    /* a solved shared task takes its XP with it */
    const back = xpOwed(t);
    if (back) q.run('INSERT INTO xp_ledger (id,user_id,squad_id,amount,reason,created_at) VALUES (?,?,?,?,?,?)',
      uid('x_'), t.assignee_id || u.id, t.squad_id, -back, t.title, now());
    if (t.owner_id) ctx.notifyUser(u.id, { type: 'task-removed', id: t.id });
    else ctx.broadcast(t.squad_id, { type: 'task-removed', id: t.id });
    return { ok: true };
  });

  /* Everything starting soon, across every squad you are in — the calendar the
     client already has only covers the squad you happen to have open, so a
     reminder built on that would stay silent for the meeting you are actually
     about to miss. */
  r.get('/api/upcoming', async (ctx) => {
    const u = ctx.requireUser();
    const within = Math.min(Number(ctx.query.get('within')) || 60, 1440) * 60000;
    const t = now();
    return {
      now: t,
      events: q.all(`SELECT e.id, e.title, e.kind, e.starts_at, e.duration, e.meeting_id,
                            s.id AS squad_id, s.name AS squad_name
                     FROM events e
                     JOIN squads s ON s.id = e.squad_id
                     JOIN squad_members sm ON sm.squad_id = e.squad_id AND sm.user_id = ?
                     LEFT JOIN meetings m ON m.id = e.meeting_id
                     WHERE e.starts_at BETWEEN ? AND ?
                       AND (e.meeting_id IS NULL OR m.ended_at IS NULL)
                     ORDER BY e.starts_at`, u.id, t - 60000, t + within)
    };
  });

  /* calendar */
  r.post('/api/squads/:id/events', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const { title, kind = 'event', starts_at, duration = 60, meeting_id = null } = ctx.body;
    if (!String(title || '').trim()) throw httpError(400, 'Give the event a title.');
    if (!starts_at) throw httpError(400, 'Pick a date and time.');
    const id = uid('e_');
    q.run('INSERT INTO events (id,squad_id,title,kind,starts_at,duration,meeting_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ctx.params.id, String(title).trim(), kind, Number(starts_at), Number(duration) || 60, meeting_id, u.id, now());
    const event = q.get('SELECT * FROM events WHERE id = ?', id);
    ctx.broadcast(ctx.params.id, { type: 'event', event });
    return { event };
  });

  r.del('/api/events/:id', async (ctx) => {
    const u = ctx.requireUser();
    const e = q.get('SELECT * FROM events WHERE id = ?', ctx.params.id);
    if (!e) throw httpError(404, 'That event no longer exists.');
    requireMember(e.squad_id, u);
    q.run('DELETE FROM events WHERE id = ?', e.id);
    ctx.broadcast(e.squad_id, { type: 'event-removed', id: e.id });
    return { ok: true };
  });

  /* meetings */
  r.post('/api/squads/:id/meetings', async (ctx) => {
    const u = ctx.requireUser();
    requireMember(ctx.params.id, u);
    const title = String(ctx.body.title || 'Squad meeting').trim();
    const startsAt = ctx.body.starts_at ? Number(ctx.body.starts_at) : now();
    const duration = Number(ctx.body.duration) || 60;
    const id = uid('mt_'), t = now();
    q.run('INSERT INTO meetings (id,squad_id,title,created_by,created_at,started_at,pass) VALUES (?,?,?,?,?,?,?)',
      id, ctx.params.id, title, u.id, t, startsAt <= t ? t : null, randomBytes(18).toString('hex'));

    const eventId = uid('e_');
    q.run('INSERT INTO events (id,squad_id,title,kind,starts_at,duration,meeting_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      eventId, ctx.params.id, title, 'meeting', startsAt, duration, id, u.id, t);

    const meeting = q.get('SELECT * FROM meetings WHERE id = ?', id);
    const event = q.get('SELECT * FROM events WHERE id = ?', eventId);
    ctx.broadcast(ctx.params.id, { type: 'meeting', meeting, event });
    return { meeting, event };
  });

  r.get('/api/meetings/:id', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT * FROM meetings WHERE id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That meeting no longer exists.');
    const guest = !membership(m.squad_id, u.id);
    if (guest) {
      /* A meeting link has to work the way every other call link works, or the
         person you sent it to simply cannot get in. The pass admits them to
         this one call and nothing else: no channels, no tasks, no history, and
         no membership that outlives the call. */
      if (!meetingPassOk(m, ctx.query.get('pass')))
        throw httpError(403, 'That meeting link is not valid any more. Ask whoever sent it for a fresh one.');
      if (m.ended_at) throw httpError(410, 'That meeting has ended.');
    }
    return {
      meeting: { ...m, pass: guest ? undefined : m.pass },
      squad: q.get('SELECT id,name FROM squads WHERE id = ?', m.squad_id),
      guest
    };
  });

  r.post('/api/meetings/:id/end', async (ctx) => {
    const u = ctx.requireUser();
    const m = q.get('SELECT * FROM meetings WHERE id = ?', ctx.params.id);
    if (!m) throw httpError(404, 'That meeting no longer exists.');
    requireMember(m.squad_id, u);
    q.run('UPDATE meetings SET ended_at = ? WHERE id = ?', now(), m.id);
    ctx.broadcast(m.squad_id, { type: 'meeting-ended', id: m.id });
    return { ok: true };
  });

  /* Where this server can actually be reached from another machine.
     `localhost` only ever means "this device", so links must not use it. */
  r.get('/api/net', async (ctx) => {
    return {
      public: ctx.publicOrigin(),
      lan: ctx.lanOrigins(),
      local: ctx.localOrigin(),
      secure: ctx.isSecure()
    };
  });

  /* campus directory — only real, registered people */
  /* Finding a teammate by name should not hand out the whole user table, and
     certainly not everyone's email address. A term is required, the match is
     on name and handle only, and the reply carries no contact details. */
  r.get('/api/people', async (ctx) => {
    const u = ctx.requireUser();
    const term = String(ctx.query.get('q') || '').trim();
    if (term.length < 2) return { people: [], term };
    const squadId = String(ctx.query.get('squad') || '');
    if (squadId) requireMember(squadId, u);
    const like = '%' + term.replace(/[\%_]/g, c => '\\' + c) + '%';
    const rows = q.all(`SELECT id, name, handle FROM users
                        WHERE deleted_at IS NULL AND id != ?
                          AND (name LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\')
                        ORDER BY CASE WHEN handle = ? THEN 0 ELSE 1 END, name LIMIT 12`,
      u.id, like, like, term.toLowerCase());
    return {
      term,
      people: rows.map(p => ({
        ...p,
        member: squadId ? !!membership(squadId, p.id) : false,
        invited: squadId ? !!q.get(`SELECT 1 FROM invites i JOIN users x ON x.email = i.email
                                    WHERE i.squad_id = ? AND x.id = ? AND i.accepted_at IS NULL`, squadId, p.id) : false
      }))
    };
  });

  r.get('/api/standings', async (ctx) => {
    ctx.requireUser();
    return {
      standings: q.all(`SELECT u.id,u.name,u.handle,u.rating,
        COALESCE((SELECT SUM(amount) FROM xp_ledger WHERE user_id = u.id),0) AS xp
        FROM users u ORDER BY xp DESC, u.name LIMIT 25`)
    };
  });

  return r;
}

/* a sensible default symbol for each preset channel name */
const SEED_ICONS = {
  general: '\u{1F4AC}', 'problem-sets': '\u{1F9E9}', 'contest-log': '\u{1F4DC}', balloons: '\u{1F388}',
  proposals: '\u{1F4DD}', 'org-shortlist': '\u{1F3E2}', 'code-review': '\u{1F50D}',
  'build-log': '\u{1F528}', pitch: '\u{1F3A4}', 'daily-problem': '\u{2600}\u{FE0F}', editorials: '\u{1F4D6}'
};
const seedIcon = (name) => SEED_ICONS[name] || '#';

const clampCap = (n) => Math.max(2, Math.min(200, Number(n) || 2));

const pick = (o, keys) => keys.reduce((a, k) => (o[k] !== undefined && (a[k] = o[k]), a), {});
