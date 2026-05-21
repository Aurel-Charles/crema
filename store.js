import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  DATA_DIR, REPLIES_FILE, SHORTCUTS_FILE, DND_FILE, IDENTITY_FILE, DEFAULT_TARGET_FILE,
  MAX_REPLIES, MAX_SHORTCUTS, MAX_LABEL_LENGTH, MAX_SHORTCUT_TEXT, MAX_ICON_LENGTH,
  DEFAULT_REPLIES, MIN_TTL_MS, MAX_TTL_MS, OWNER,
} from './config.js';
import { sysLog } from './logger.js';

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
    // Empty targetOwner is allowed = "global" shortcut, routed to the current
    // global recipient at send time. A non-empty value pins the shortcut.
    if (targetOwner.length > MAX_LABEL_LENGTH) continue;
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

// ===== Display nickname (V7.1) =====
//
// A presentation label propagated on top of `owner`. `owner` remains the
// immutable routing identity (broker registry key, mDNS dedup, history index);
// the nickname only ever changes how a Pi is *shown*. Effective name shown to
// users = nickname || owner. Empty-after-trim = not set.

let nickname = '';

export function sanitizeNickname(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  return s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH) : s;
}

async function loadIdentity() {
  try {
    const raw = await readFile(IDENTITY_FILE, 'utf8');
    nickname = sanitizeNickname(JSON.parse(raw)?.nickname);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[identity] load failed:', err.message);
    nickname = '';
  }
}

export function getNickname() {
  return nickname;
}

// ===== Global recipient (screen) =====
//
// The owner that "global" shortcuts are sent to, chosen on the screen. Single
// target for now (multi-recipient fan-out is a later phase). Empty = not set;
// global shortcuts then resolve to a sole online peer client-side, or stay
// disabled when the choice is ambiguous.

let defaultTarget = '';

function sanitizeTarget(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  return s.length > MAX_LABEL_LENGTH ? '' : s;
}

async function loadDefaultTarget() {
  try {
    const raw = await readFile(DEFAULT_TARGET_FILE, 'utf8');
    defaultTarget = sanitizeTarget(JSON.parse(raw)?.target);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[default-target] load failed:', err.message);
    defaultTarget = '';
  }
}

export function getDefaultTarget() {
  return defaultTarget;
}

// ===== Init =====

export async function init({ app, io, transport }) {
  await loadReplies();
  await loadShortcuts();
  await loadDnd();
  await loadIdentity();
  await loadDefaultTarget();

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

  // Global recipient picked on the screen. Front-ends (display ↔ settings)
  // sync live via the socket event, like dnd/profile.
  app.get('/default-target', (req, res) => res.json({ target: defaultTarget }));
  app.put('/default-target', async (req, res) => {
    const next = sanitizeTarget(req.body?.target);
    if (next === defaultTarget) return res.json({ target: defaultTarget });
    defaultTarget = next;
    try {
      await persistAtomic(DEFAULT_TARGET_FILE, { target: defaultTarget });
    } catch (err) {
      console.error('[default-target] persist failed:', err.message);
    }
    io.emit('default-target:updated', { target: defaultTarget });
    sysLog('default-target', defaultTarget ? `Destinataire courant : ${defaultTarget}` : 'Destinataire courant effacé', { target: defaultTarget });
    res.json({ target: defaultTarget });
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
    sysLog(dndEnabled ? 'dnd:on' : 'dnd:off', dndEnabled ? 'Mode Ne Pas Déranger activé' : 'Mode Ne Pas Déranger désactivé');
    res.json({ enabled: dndEnabled });
  });

  // Profile: the display nickname. owner is always returned alongside so the
  // front-ends can render `nickname || owner` without a second request.
  app.get('/profile', (req, res) => res.json({ owner: OWNER, nickname }));
  app.put('/profile', async (req, res) => {
    const next = sanitizeNickname(req.body?.nickname);
    if (next === nickname) return res.json({ owner: OWNER, nickname });
    nickname = next;
    try {
      await persistAtomic(IDENTITY_FILE, { nickname });
    } catch (err) {
      console.error('[identity] persist failed:', err.message);
    }
    // Local front-ends (settings ↔ display) sync live, like dnd:updated.
    io.emit('profile:updated', { owner: OWNER, nickname });
    // Push the new name to peers over whatever transport(s) are live (mDNS
    // re-advertise + broker profile:update). No-op if the transport predates
    // this method (defensive).
    transport?.announceProfile?.();
    sysLog('profile:update', nickname ? `Surnom défini : « ${nickname} »` : 'Surnom retiré', { owner: OWNER, nickname });
    res.json({ owner: OWNER, nickname });
  });
}
