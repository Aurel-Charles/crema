import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { HISTORY_DB_FILE } from './config.js';

let db = null;
const stmts = {};

export function init() {
  mkdirSync(dirname(HISTORY_DB_FILE), { recursive: true });
  db = new Database(HISTORY_DB_FILE);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('out', 'in')),
      text TEXT NOT NULL,
      from_owner TEXT NOT NULL,
      to_owner TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      is_reply INTEGER NOT NULL DEFAULT 0,
      reply_to_msg_id TEXT,
      reply_to_text TEXT,
      response_options TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
  `);
  stmts.insert = db.prepare(`
    INSERT INTO messages (
      id, direction, text, from_owner, to_owner, created_at, expires_at,
      is_reply, reply_to_msg_id, reply_to_text, response_options, status
    ) VALUES (
      @id, @direction, @text, @from_owner, @to_owner, @created_at, @expires_at,
      @is_reply, @reply_to_msg_id, @reply_to_text, @response_options, @status
    )
  `);
  stmts.updateStatus = db.prepare('UPDATE messages SET status = ? WHERE id = ?');
  stmts.updateStatusIfPending = db.prepare(
    "UPDATE messages SET status = ? WHERE id = ? AND status = 'pending'"
  );
  stmts.getById = db.prepare('SELECT * FROM messages WHERE id = ?');
  stmts.listRecent = db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?');
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    text: row.text,
    from: row.from_owner,
    to: row.to_owner,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    isReply: row.is_reply === 1,
    replyToMsgId: row.reply_to_msg_id,
    replyToText: row.reply_to_text,
    responseOptions: row.response_options ? JSON.parse(row.response_options) : null,
    status: row.status,
  };
}

export function insertMessage({
  id,
  direction,
  text,
  from,
  to = null,
  createdAt = Date.now(),
  expiresAt = null,
  isReply = false,
  replyToMsgId = null,
  replyToText = null,
  responseOptions = null,
  status,
}) {
  if (!id) throw new Error('insertMessage: id required');
  if (!direction) throw new Error('insertMessage: direction required');
  // Tolerate duplicate inserts (e.g. same message replayed) — sqlite will
  // throw on PRIMARY KEY conflict, which we swallow to keep /inbox resilient.
  try {
    stmts.insert.run({
      id,
      direction,
      text,
      from_owner: from,
      to_owner: to,
      created_at: createdAt,
      expires_at: expiresAt,
      is_reply: isReply ? 1 : 0,
      reply_to_msg_id: replyToMsgId,
      reply_to_text: replyToText,
      response_options: responseOptions ? JSON.stringify(responseOptions) : null,
      status,
    });
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw err;
  }
}

export function setStatus(id, status) {
  stmts.updateStatus.run(status, id);
}

// Use for transitions that should not overwrite a terminal state
// ('replied', 'expired'). Currently used for 'pending' → 'read'.
export function setStatusIfPending(id, status) {
  stmts.updateStatusIfPending.run(status, id);
}

export function getMessage(id) {
  return rowToMessage(stmts.getById.get(id));
}

function localDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function listGroupedByDay(limit = 200) {
  const rows = stmts.listRecent.all(limit).map(rowToMessage);
  const groups = [];
  let current = null;
  for (const msg of rows) {
    const key = localDateKey(msg.createdAt);
    if (!current || current.date !== key) {
      current = { date: key, messages: [] };
      groups.push(current);
    }
    current.messages.push(msg);
  }
  return groups;
}

export function close() {
  if (db) {
    db.close();
    db = null;
  }
}
