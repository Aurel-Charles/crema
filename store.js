import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  DATA_DIR, REPLIES_FILE, SHORTCUTS_FILE, DND_FILE,
  MAX_REPLIES, MAX_SHORTCUTS, MAX_LABEL_LENGTH, MAX_SHORTCUT_TEXT, MAX_ICON_LENGTH,
  DEFAULT_REPLIES, MIN_TTL_MS, MAX_TTL_MS,
} from './config.js';

async function persistAtomic(path, data) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

export function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, n));
}

// ===== Quick replies (V3) =====

let replies = [];

function sanitizeReplies(input) {
  if (!Array.isArray(input)) throw new Error('Liste invalide');
  const cleaned = [];
  const seen = new Set();
  for (const item of input) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    cleaned.push({ label });
    if (cleaned.length >= MAX_REPLIES) break;
  }
  return cleaned;
}

async function loadReplies() {
  try {
    const raw = await readFile(REPLIES_FILE, 'utf8');
    replies = sanitizeReplies(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      replies = [...DEFAULT_REPLIES];
      await persistAtomic(REPLIES_FILE, replies);
      console.log('[replies] seeded defaults');
    } else {
      console.error('[replies] load failed:', err.message);
      replies = [...DEFAULT_REPLIES];
    }
  }
}

export function getReplies() {
  return replies;
}

// ===== Shortcuts (V5) =====

let shortcuts = [];

function sanitizeShortcuts(input) {
  if (!Array.isArray(input)) throw new Error('Liste invalide');
  const cleaned = [];
  for (const item of input) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const icon = typeof item?.icon === 'string' ? item.icon.trim() : '';
    const targetOwner = typeof item?.targetOwner === 'string' ? item.targetOwner.trim() : '';
    const ttlMs = clampTtl(item?.ttlMs);
    if (!label || label.length > MAX_LABEL_LENGTH) continue;
    if (!text || text.length > MAX_SHORTCUT_TEXT) continue;
    if (!targetOwner || targetOwner.length > MAX_LABEL_LENGTH) continue;
    if (!ttlMs) continue;
    if (icon.length > MAX_ICON_LENGTH) continue;
    const id = (typeof item?.id === 'string' && item.id) ? item.id : randomUUID();
    cleaned.push({ id, label, icon, text, targetOwner, ttlMs });
    if (cleaned.length >= MAX_SHORTCUTS) break;
  }
  return cleaned;
}

async function loadShortcuts() {
  try {
    const raw = await readFile(SHORTCUTS_FILE, 'utf8');
    shortcuts = sanitizeShortcuts(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      shortcuts = [];
    } else {
      console.error('[shortcuts] load failed:', err.message);
      shortcuts = [];
    }
  }
}

export function getShortcuts() {
  return shortcuts;
}

export function findShortcut(id) {
  return shortcuts.find((s) => s.id === id) ?? null;
}

// ===== Do Not Disturb (V5.1) =====

let dndEnabled = false;

async function loadDnd() {
  try {
    const raw = await readFile(DND_FILE, 'utf8');
    dndEnabled = JSON.parse(raw)?.enabled === true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[dnd] load failed:', err.message);
    dndEnabled = false;
  }
}

export function getDnd() {
  return dndEnabled;
}

// ===== Init =====

export async function init({ app, io }) {
  await loadReplies();
  await loadShortcuts();
  await loadDnd();

  app.get('/replies', (req, res) => res.json(replies));
  app.put('/replies', async (req, res) => {
    try {
      replies = sanitizeReplies(req.body);
      await persistAtomic(REPLIES_FILE, replies);
      io.emit('replies:updated', replies);
      res.json(replies);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/shortcuts', (req, res) => res.json(shortcuts));
  app.put('/shortcuts', async (req, res) => {
    try {
      shortcuts = sanitizeShortcuts(req.body);
      await persistAtomic(SHORTCUTS_FILE, shortcuts);
      io.emit('shortcuts:updated', shortcuts);
      res.json(shortcuts);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/dnd', (req, res) => res.json({ enabled: dndEnabled }));
  app.put('/dnd', async (req, res) => {
    const next = req.body?.enabled === true;
    if (next === dndEnabled) return res.json({ enabled: dndEnabled });
    dndEnabled = next;
    try {
      await persistAtomic(DND_FILE, { enabled: dndEnabled });
    } catch (err) {
      console.error('[dnd] persist failed:', err.message);
    }
    io.emit('dnd:updated', { enabled: dndEnabled });
    res.json({ enabled: dndEnabled });
  });
}
