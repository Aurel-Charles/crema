import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import {
  DATA_DIR, REPLIES_FILE, SHORTCUTS_FILE, DND_FILE, IDENTITY_FILE, DEFAULT_TARGET_FILE,
  TRANSPORT_FILE, THEME_FILE, DEFAULT_REPLIES, OWNER, BROKER_URL,
} from './config.js';
import {
  clampTtl, sanitizeReplies, sanitizeShortcuts, sanitizeNickname, sanitizeTarget,
  sanitizeBrokerUrl, sanitizeTheme,
} from './sanitize.js';
import { sysLog } from './logger.js';

// Pure input validators now live in sanitize.js (unit-tested in isolation).
// clampTtl is re-exported so existing importers (messaging.js) keep working
// through store.js without a churn-only import change.
export { clampTtl };

async function persistAtomic(path, data) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

// ===== Quick replies (V3) =====

let replies = [];

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

// ===== Broker URL override (V7.3) =====
//
// A broker URL set from the settings page, persisted in data/transport.json.
// Precedence (decided with the user): this override > the CREMA_BROKER_URL env
// pin (systemd drop-in / pin-broker.sh) > mDNS auto-discovery. Empty here = fall
// back to the env, then discovery. The transport reads getBrokerUrl() at boot
// and is hot re-pointed on PUT /transport — no service restart, no sudo.

let brokerUrlOverride = '';

async function loadTransport() {
  try {
    const raw = await readFile(TRANSPORT_FILE, 'utf8');
    const url = sanitizeBrokerUrl(JSON.parse(raw)?.url);
    // null = a malformed value slipped into the file; treat as "no override".
    brokerUrlOverride = url || '';
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[transport] load failed:', err.message);
    brokerUrlOverride = '';
  }
}

// The override alone (what the UI edits). Empty string = not set.
export function getBrokerUrlOverride() {
  return brokerUrlOverride;
}

// The effective pinned URL the transport should use: override first, then the
// env pin. null = neither set → the transport falls back to mDNS discovery.
export function getBrokerUrl() {
  return brokerUrlOverride || BROKER_URL || null;
}

// ===== Appearance: light / dark (V7.4) =====
//
// A pure presentation choice (CSS-variable remap), persisted per-Pi so toggling
// it from a phone also re-skins that Pi's screen. Front-ends (settings ↔ display
// ↔ other tabs) sync live via the socket event, like dnd. 'light' is the default
// direction; 'dark' adopts the deep-indigo "Mega Type" night palette.

let theme = 'light';

async function loadTheme() {
  try {
    const raw = await readFile(THEME_FILE, 'utf8');
    theme = sanitizeTheme(JSON.parse(raw)?.theme);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[theme] load failed:', err.message);
    theme = 'light';
  }
}

export function getTheme() {
  return theme;
}

// ===== Init =====

export async function init({ app, io, transport }) {
  await loadReplies();
  await loadShortcuts();
  await loadDnd();
  await loadIdentity();
  await loadDefaultTarget();
  await loadTransport();
  await loadTheme();

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

  // Appearance (V7.4). Pages read GET on load (after applying the localStorage
  // cache for a flash-free first paint), and PUT to switch. The socket event
  // re-skins the Pi's screen and any other open tab live, no reload.
  app.get('/theme', (req, res) => res.json({ theme }));
  app.put('/theme', async (req, res) => {
    const next = sanitizeTheme(req.body?.theme);
    if (next === theme) return res.json({ theme });
    theme = next;
    try {
      await persistAtomic(THEME_FILE, { theme });
    } catch (err) {
      console.error('[theme] persist failed:', err.message);
    }
    io.emit('theme:updated', { theme });
    sysLog('theme:update', theme === 'dark' ? 'Apparence : mode sombre' : 'Apparence : mode clair', { theme });
    res.json({ theme });
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

  // Broker URL (V7.3). The page reads GET to render the field + the live status,
  // and PUTs to set/clear the override. `source` tells the UI where the
  // currently-effective URL comes from, so it can flag "this overrides the
  // system pin" honestly. `health` mirrors transport.health() for the badge.
  function transportState() {
    const override = brokerUrlOverride;
    const effective = override || BROKER_URL || null;
    const source = override ? 'ui' : (BROKER_URL ? 'env' : 'discovery');
    return { url: override, envUrl: BROKER_URL ?? null, effective, source, health: transport?.health?.() ?? null };
  }

  app.get('/transport', (req, res) => res.json(transportState()));
  app.put('/transport', async (req, res) => {
    const next = sanitizeBrokerUrl(req.body?.url);
    if (next === null) {
      return res.status(400).json({ error: 'URL invalide — attendu ws:// ou wss://' });
    }
    if (next === brokerUrlOverride) return res.json(transportState());
    brokerUrlOverride = next;
    try {
      await persistAtomic(TRANSPORT_FILE, { url: brokerUrlOverride });
    } catch (err) {
      console.error('[transport] persist failed:', err.message);
    }
    // Hot re-point: hand the effective URL (override || env || null) to the
    // transport. null → it reverts to mDNS discovery. No-op on transports that
    // don't own a broker (p2p). Then tell the front-ends so the badge updates.
    transport?.setBrokerUrl?.(getBrokerUrl());
    io.emit('transport:config-updated', transportState());
    sysLog(
      'transport:broker-url',
      brokerUrlOverride ? `Broker épinglé via UI → ${brokerUrlOverride}` : 'Override broker effacé (retour env/découverte)',
      { url: brokerUrlOverride },
    );
    res.json(transportState());
  });
}
