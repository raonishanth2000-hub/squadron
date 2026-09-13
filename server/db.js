import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* Where the database and attachments live. Deployed, this points outside the
   code directory, so pushing a new version cannot overwrite or delete the data
   — and the service can be locked down to exactly one writable path. Locally
   it stays ./data, so nothing changes for development. */
const DATA_DIR = process.env.SQUADRON_DATA || join(root, 'data');
mkdirSync(DATA_DIR, { recursive: true });

/* Attachments live on disk, not in the row. A phone video is tens of megabytes
   and a BLOB that size bloats the WAL and has to be read into memory whole
   just to serve one range request. The row keeps the metadata; the bytes sit
   under data/files named by the generated id, so nothing a user typed ever
   reaches a filesystem path. */
export const FILES_DIR = join(DATA_DIR, 'files');
mkdirSync(FILES_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'squadron.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  pw_hash     TEXT NOT NULL,
  name        TEXT NOT NULL,
  handle      TEXT NOT NULL UNIQUE,
  rating      INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

/* one-off markers for migrations that cannot be detected from the data itself */
CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS squads (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- icpc | gsoc | hack | study
  tagline     TEXT,
  cap         INTEGER NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_members (
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,            -- captain | member | advisor
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (squad_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  invited_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  accepted_at INTEGER
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  col         TEXT NOT NULL,            -- Backlog | In progress | In review | Solved
  xp          INTEGER NOT NULL DEFAULT 0,
  priority    TEXT NOT NULL DEFAULT 'md',
  tags        TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id),
  due         TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- task | contest | deadline | event | meeting
  starts_at   INTEGER NOT NULL,
  duration    INTEGER NOT NULL DEFAULT 60,
  meeting_id  TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS xp_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  squad_id    TEXT REFERENCES squads(id) ON DELETE SET NULL,
  amount      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_reads (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS snippets (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  scope       TEXT NOT NULL DEFAULT 'personal',
  title       TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'cpp',
  body        TEXT NOT NULL DEFAULT '',
  stdin       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS voice (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  ms          INTEGER NOT NULL,
  peaks       TEXT NOT NULL DEFAULT '[]',
  bytes       BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mentions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);

CREATE TABLE IF NOT EXISTS tests (
  id          TEXT PRIMARY KEY,
  snippet_id  TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  stdin       TEXT NOT NULL DEFAULT '',
  expected    TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strokes (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  board       TEXT NOT NULL DEFAULT 'main',
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  colour      TEXT NOT NULL,
  width       REAL NOT NULL,
  points      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

/* Direct messages get their own tables rather than pretending to be a channel:
   a channel belongs to a squad and everything keys off that, and bending it
   would have meant a nullable squad_id running through every guard. */
CREATE TABLE IF NOT EXISTS dm_threads (
  id          TEXT PRIMARY KEY,
  a_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  UNIQUE (a_id, b_id)
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL DEFAULT '',
  image_id    TEXT,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted_at  INTEGER
);

CREATE TABLE IF NOT EXISTS dm_reads (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);

/* Board snapshots and anything else pasted as a picture. Bytes live in the row
   so deleting the conversation takes the picture with it. */
CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  w           INTEGER NOT NULL DEFAULT 0,
  h           INTEGER NOT NULL DEFAULT 0,
  bytes       BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);

/* Anything attached with the + in the composer: documents, video, audio, code.
   Pictures pasted before this existed still live in the images table above. */
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  w           INTEGER NOT NULL DEFAULT 0,
  h           INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

/* A whiteboard can have several pages; strokes already carry a board name. */
CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  squad_id    TEXT NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_squad  ON tasks(squad_id, col, position);
CREATE INDEX IF NOT EXISTS idx_event_squad ON events(squad_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_member_user ON squad_members(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_user     ON xp_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_snip_squad  ON snippets(squad_id, scope, updated_at);
CREATE INDEX IF NOT EXISTS idx_voice_msg   ON voice(message_id);
CREATE INDEX IF NOT EXISTS idx_mention_user ON mentions(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_tests_snip   ON tests(snippet_id, position);
CREATE INDEX IF NOT EXISTS idx_strokes_sq   ON strokes(squad_id, board, created_at);
`);

/* additive migrations — safe to run on every boot */
function addColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
addColumn('channels', 'icon', "TEXT NOT NULL DEFAULT '#'");
addColumn('users', 'tour_seen', 'INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
addColumn('messages', 'parent_id',  'TEXT');        /* thread root, null for top level */
addColumn('messages', 'edited_at',  'INTEGER');
addColumn('messages', 'deleted_at', 'INTEGER');     /* tombstone, so replies keep their anchor */
addColumn('messages', 'pinned_at',  'INTEGER');
addColumn('messages', 'pinned_by',  'TEXT');
addColumn('users',    'deleted_at', 'INTEGER');
addColumn('snippets', 'include_as', 'TEXT');        /* name this file is #include-able under */
addColumn('messages', 'image_id',  'TEXT');         /* a board snapshot posted into a channel */
addColumn('messages',    'file_id', 'TEXT');        /* an attachment sent with the composer + */
addColumn('dm_messages', 'file_id', 'TEXT');
addColumn('strokes',  'kind',      "TEXT NOT NULL DEFAULT 'pen'");   /* pen | line | rect | ellipse | arrow | text */
addColumn('strokes',  'text',      'TEXT');         /* the label, for kind = text */
addColumn('strokes',  'fill',      'INTEGER NOT NULL DEFAULT 0');
addColumn('strokes',  'font',      "TEXT NOT NULL DEFAULT 'sans'");   /* sans | serif | mono */
addColumn('strokes',  'size',      'INTEGER NOT NULL DEFAULT 28');
/* null owner = the squad's shared page; set = that person's private page */
addColumn('boards',   'owner_id',  'TEXT');
/* same rule for tasks: null = on the squad board, set = that person's own
   to-do list, which nobody else can see, move, or delete */
addColumn('tasks',    'owner_id',  'TEXT');
/* An unguessable pass carried by the meeting link. Holding it admits you to
   that one call as a guest — it grants nothing else, and dies with the call. */
addColumn('meetings', 'pass',      'TEXT');

/* indexes on added columns have to come after the columns exist — the main
   schema block above runs before these migrations */
db.exec(`
CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_msg_pinned ON messages(channel_id, pinned_at);
CREATE INDEX IF NOT EXISTS idx_dm_thread  ON dm_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_people  ON dm_threads(a_id, b_id);
CREATE INDEX IF NOT EXISTS idx_boards_sq  ON boards(squad_id, position);
`);

/* Meetings that predate the pass column have none, so their links would admit
   nobody from outside the squad. Give the ones still running a pass rather
   than making people start a fresh call. */
{
  const { randomBytes } = await import('node:crypto');
  const stale = db.prepare('SELECT id FROM meetings WHERE (pass IS NULL OR pass = ?) AND ended_at IS NULL').all('');
  const set = db.prepare('UPDATE meetings SET pass = ? WHERE id = ?');
  for (const m of stale) set.run(randomBytes(18).toString('hex'), m.id);
  if (stale.length) console.log(`[db] issued a link pass to ${stale.length} open meeting(s)`);
}

/* every task is worth the same — the server decides, not the filer */
export const TASK_XP = 5;

/* Tasks are all worth the same now — the person filing the work no longer
   sets its value. Normalising the stored amount is not enough on its own:
   a task already sitting in Solved was paid out at its old rate, so moving it
   back out would withdraw 5 against a grant of (say) 50 and leave the
   difference stranded in the ledger. Post the correction first, then flatten. */
function flattenTaskXp() {
  const off = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE xp != ?').get(TASK_XP).n;
  if (!off) return;
  const solved = db.prepare(
    "SELECT id, squad_id, title, xp, assignee_id FROM tasks WHERE col = 'Solved' AND xp != ?"
  ).all(TASK_XP);
  const ins = db.prepare('INSERT INTO xp_ledger (id,user_id,squad_id,amount,reason,created_at) VALUES (?,?,?,?,?,?)');
  const t = Date.now();
  for (const task of solved) {
    if (!task.assignee_id) continue;
    const delta = TASK_XP - task.xp;
    if (delta) ins.run('x_' + Math.random().toString(36).slice(2, 10) + t.toString(36).slice(-4),
      task.assignee_id, task.squad_id, delta, `${task.title} — rebalanced to ${TASK_XP} XP`, t);
  }
  db.prepare('UPDATE tasks SET xp = ?').run(TASK_XP);
  console.log(`[db] flattened ${off} task(s) to ${TASK_XP} XP`);
}
flattenTaskXp();

export const q = {
  get:  (sql, ...a) => db.prepare(sql).get(...a),
  all:  (sql, ...a) => db.prepare(sql).all(...a),
  run:  (sql, ...a) => db.prepare(sql).run(...a)
};

export const now = () => Date.now();
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
