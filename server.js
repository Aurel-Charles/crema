import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mdns from 'mdns';
import SunCalc from 'suncalc';
import { lookup as dnsLookup } from 'dns/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_TYPE = 'crema';
const PORT = Number(process.env.PORT ?? 3000);
const OWNER = process.env.CREMA_OWNER ?? deriveOwnerFromHostname();
const INSTANCE_ID = randomUUID();
const SERVICE_NAME = `crema-${OWNER}-${INSTANCE_ID.slice(0, 8)}`;

// Amiens — used to compute sunrise/sunset for the day/night theme.
// Override via env if Crema gets deployed elsewhere.
const LAT = Number(process.env.CREMA_LAT ?? 49.8941);
const LON = Number(process.env.CREMA_LON ?? 2.2958);

const DATA_DIR = join(__dirname, 'data');
const REPLIES_FILE = join(DATA_DIR, 'replies.json');
const SHORTCUTS_FILE = join(DATA_DIR, 'shortcuts.json');
const MAX_REPLIES = 5;
const MAX_SHORTCUTS = 6;
const MAX_LABEL_LENGTH = 30;
const MAX_SHORTCUT_TEXT = 200;
const MAX_ICON_LENGTH = 8;
const DEFAULT_REPLIES = [{ label: '👍' }, { label: 'Vu' }, { label: 'Plus tard' }];

// V4 TTL bounds — keep generous on both ends.
const MIN_TTL_MS = 5_000;            // 5 s
const MAX_TTL_MS = 24 * 3600 * 1000; // 24 h

function deriveOwnerFromHostname() {
  const h = hostname().replace(/\.local$/, '');
  const stripped = h.startsWith('pi-') ? h.slice(3) : h;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'display.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'settings.html'));
});

app.get('/me', (req, res) => {
  res.json({ owner: OWNER, instanceId: INSTANCE_ID });
});

app.get('/peers', (req, res) => {
  res.json(listPeers());
});

app.get('/theme-schedule', (req, res) => {
  const now = new Date();
  const today = SunCalc.getTimes(now, LAT, LON);
  const tomorrow = SunCalc.getTimes(new Date(now.getTime() + 24 * 3600 * 1000), LAT, LON);
  res.json({
    sunrise: today.sunrise.toISOString(),
    sunset: today.sunset.toISOString(),
    nextSunrise: tomorrow.sunrise.toISOString(),
  });
});

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
    const parsed = JSON.parse(raw);
    replies = sanitizeReplies(parsed);
  } catch (err) {
    if (err.code === 'ENOENT') {
      replies = [...DEFAULT_REPLIES];
      await persistReplies();
      console.log('[replies] seeded defaults');
    } else {
      console.error('[replies] load failed:', err.message);
      replies = [...DEFAULT_REPLIES];
    }
  }
}

async function persistReplies() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${REPLIES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(replies, null, 2), 'utf8');
  await rename(tmp, REPLIES_FILE);
}

app.get('/replies', (req, res) => {
  res.json(replies);
});

app.put('/replies', async (req, res) => {
  try {
    replies = sanitizeReplies(req.body);
    await persistReplies();
    io.emit('replies:updated', replies);
    res.json(replies);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
    const parsed = JSON.parse(raw);
    shortcuts = sanitizeShortcuts(parsed);
  } catch (err) {
    if (err.code === 'ENOENT') {
      shortcuts = [];
    } else {
      console.error('[shortcuts] load failed:', err.message);
      shortcuts = [];
    }
  }
}

async function persistShortcuts() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SHORTCUTS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(shortcuts, null, 2), 'utf8');
  await rename(tmp, SHORTCUTS_FILE);
}

app.get('/shortcuts', (req, res) => {
  res.json(shortcuts);
});

app.put('/shortcuts', async (req, res) => {
  try {
    shortcuts = sanitizeShortcuts(req.body);
    await persistShortcuts();
    io.emit('shortcuts:updated', shortcuts);
    res.json(shortcuts);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/reply', async (req, res) => {
  const to = typeof req.body?.to === 'string' ? req.body.to : '';
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const replyToMsgId = typeof req.body?.replyToMsgId === 'string' ? req.body.replyToMsgId : null;
  if (!to) return res.status(400).json({ error: 'Destinataire manquant' });
  if (!label) return res.status(400).json({ error: 'Réponse vide' });

  const peer = findPeerByInstanceId(to);
  if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

  const payload = {
    text: label,
    from: OWNER,
    fromInstanceId: INSTANCE_ID,
    isReply: true,
    replyToMsgId,
  };

  try {
    await postInbox(peer.address, peer.port, payload);
    return res.json({ ok: true });
  } catch (err1) {
    console.warn(`[reply] retry → ${peer.owner} (${err1.message})`);
    try {
      const fresh = await resolveHost(peer.host);
      peer.address = fresh;
      await postInbox(fresh, peer.port, payload);
      return res.json({ ok: true });
    } catch (err2) {
      console.error(`[reply] failed → ${peer.owner}:`, err2.message);
      return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
    }
  }
});

async function postInbox(address, port, payload) {
  const r = await fetch(`http://${address}:${port}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function sanitizeResponseOptions(input) {
  if (!Array.isArray(input)) return [];
  const cleaned = [];
  const seen = new Set();
  for (const item of input) {
    const label = typeof item === 'string'
      ? item.trim()
      : (typeof item?.label === 'string' ? item.label.trim() : '');
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    cleaned.push({ label });
    if (cleaned.length >= MAX_REPLIES) break;
  }
  return cleaned;
}

function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, n));
}

// ===== Sender-side pending tracking (V4) =====
// When /send succeeds, the message is kept in this map until either:
//   - the peer replies (we get a /inbox hit with replyToMsgId), or
//   - the TTL elapses (we emit msg:expired to our own display).
const pendingMessages = new Map(); // msgId -> { text, targetOwner, expiresAt, timer }

function trackPending({ id, text, targetOwner, expiresAt }) {
  const ttl = expiresAt - Date.now();
  const timer = setTimeout(() => {
    const entry = pendingMessages.get(id);
    if (!entry) return;
    pendingMessages.delete(id);
    console.log(`[pending] expired without reply → ${targetOwner}: ${text.slice(0, 30)}`);
    io.emit('msg:expired', { id, text, targetOwner });
  }, Math.max(0, ttl));
  pendingMessages.set(id, { text, targetOwner, expiresAt, timer });
}

function resolvePending(id) {
  const entry = pendingMessages.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingMessages.delete(id);
  return true;
}

// Shared send pipeline used by /send and /shortcut/send. Generates the msgId
// + expiresAt, posts to the peer (with one re-resolve retry on failure), and
// registers the pending message so the expiry timer can fire later.
async function sendToPeer(peer, { text, ttlMs, responseOptions = null }) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const opts = responseOptions && responseOptions.length > 0 ? responseOptions : null;
  const payload = { id, text, from: OWNER, fromInstanceId: INSTANCE_ID, expiresAt, responseOptions: opts };

  try {
    await postInbox(peer.address, peer.port, payload);
  } catch (err1) {
    console.warn(`[send] retry → ${peer.owner} (${err1.message})`);
    const fresh = await resolveHost(peer.host);
    peer.address = fresh;
    await postInbox(fresh, peer.port, payload);
  }

  trackPending({ id, text, targetOwner: peer.owner, expiresAt: Date.parse(expiresAt) });
  return { id, expiresAt };
}

app.post('/send', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const target = typeof req.body?.target === 'string' ? req.body.target : '';
  if (!text) return res.status(400).json({ error: 'Message vide' });
  if (!target) return res.status(400).json({ error: 'Destinataire manquant' });

  const peer = findPeerByInstanceId(target);
  if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

  const responseOptions = sanitizeResponseOptions(req.body?.responseOptions);
  const defaultTtl = responseOptions.length > 0 ? 3600_000 : 300_000;
  const ttlMs = clampTtl(req.body?.ttlMs) ?? defaultTtl;

  try {
    const result = await sendToPeer(peer, { text, ttlMs, responseOptions });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[send] failed → ${peer.owner}:`, err.message);
    return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
  }
});

app.post('/shortcut/send', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!id) return res.status(400).json({ error: 'Raccourci manquant' });
  const shortcut = shortcuts.find((s) => s.id === id);
  if (!shortcut) return res.status(404).json({ error: 'Raccourci introuvable' });

  const peer = [...peerMap.values()].find((p) => p.owner === shortcut.targetOwner);
  if (!peer) return res.status(404).json({ error: `${shortcut.targetOwner} hors ligne` });

  try {
    const result = await sendToPeer(peer, { text: shortcut.text, ttlMs: shortcut.ttlMs });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[shortcut] failed → ${peer.owner}:`, err.message);
    return res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
  }
});

app.post('/inbox', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const from = typeof req.body?.from === 'string' ? req.body.from.trim() : 'Inconnu';
  const fromInstanceId = typeof req.body?.fromInstanceId === 'string' ? req.body.fromInstanceId : null;
  const isReply = req.body?.isReply === true;
  const id = typeof req.body?.id === 'string' ? req.body.id : null;
  const expiresAt = typeof req.body?.expiresAt === 'string' ? req.body.expiresAt : null;
  const replyToMsgId = typeof req.body?.replyToMsgId === 'string' ? req.body.replyToMsgId : null;
  const responseOptions = sanitizeResponseOptions(req.body?.responseOptions);
  if (!text) return res.status(400).json({ error: 'Message vide' });

  // If this is a reply to one of our own pending messages, clear its expiry timer.
  if (isReply && replyToMsgId) resolvePending(replyToMsgId);

  io.emit('message', {
    id,
    text,
    from,
    fromInstanceId,
    isReply,
    expiresAt,
    responseOptions: responseOptions.length > 0 ? responseOptions : null,
  });
  res.json({ ok: true });
});

const peerMap = new Map(); // service name -> peer

io.on('connection', (socket) => {
  socket.emit('peers:init', listPeers());
});

function listPeers() {
  return [...peerMap.values()].map((p) => ({ instanceId: p.instanceId, owner: p.owner }));
}

function findPeerByInstanceId(id) {
  for (const peer of peerMap.values()) {
    if (peer.instanceId === id) return peer;
  }
  return null;
}

function pickHost(service) {
  return service.host?.replace(/\.$/, '') ?? null;
}

async function resolveHost(host) {
  try {
    const { address } = await dnsLookup(host, { family: 4 });
    return address;
  } catch {
    return host;
  }
}

const advertisement = mdns.createAdvertisement(
  mdns.tcp(SERVICE_TYPE),
  PORT,
  {
    name: SERVICE_NAME,
    txtRecord: { owner: OWNER, instanceId: INSTANCE_ID },
  },
);
advertisement.on('error', (err) => console.error('[mDNS advertise]', err.message));
advertisement.start();

// mdns 2.7.2's getaddrinfo step crashes on Node 18+ (deprecated internal API).
// Stop the resolver after DNSServiceResolve — we use the .local hostname directly,
// letting the OS resolver (avahi via NSS) handle name-to-IP at fetch time.
const browser = mdns.createBrowser(mdns.tcp(SERVICE_TYPE), {
  resolverSequence: [mdns.rst.DNSServiceResolve()],
});

browser.on('serviceUp', async (service) => {
  const txt = service.txtRecord ?? {};
  if (!txt.instanceId) return;
  if (txt.instanceId === INSTANCE_ID) return;
  const host = pickHost(service);
  if (!host) return;
  const address = await resolveHost(host);
  const peer = {
    instanceId: txt.instanceId,
    owner: txt.owner ?? '?',
    host,
    address,
    port: service.port,
  };

  // Same-owner dedup: a new instance announcing means the previous one is dead,
  // even if avahi hasn't sent its serviceDown yet. Assumes 1 Pi per owner (true
  // in V2; revisit when we add room labels for multi-Pi-per-owner setups).
  for (const [name, p] of peerMap) {
    if (p.owner === peer.owner && p.instanceId !== peer.instanceId) {
      peerMap.delete(name);
      peerFailures.delete(name);
      console.log(`[mDNS] stale dropped: ${p.owner} (${p.instanceId.slice(0, 8)})`);
      io.emit('peer:down', { instanceId: p.instanceId });
    }
  }

  const existing = peerMap.get(service.name);
  peerMap.set(service.name, peer);
  peerFailures.set(service.name, 0);
  if (!existing) {
    console.log(`[mDNS] up: ${peer.owner} @ ${address}:${peer.port}`);
    io.emit('peer:up', { instanceId: peer.instanceId, owner: peer.owner });
  } else if (existing.address !== address) {
    console.log(`[mDNS] re-resolved: ${peer.owner} @ ${address}:${peer.port}`);
  }
});

browser.on('serviceDown', (service) => {
  const peer = peerMap.get(service.name);
  if (peer) {
    peerMap.delete(service.name);
    peerFailures.delete(service.name);
    console.log(`[mDNS] down: ${peer.owner}`);
    io.emit('peer:down', { instanceId: peer.instanceId });
  }
});

// Active health check — mDNS "bye" packets are unreliable (lost when a peer
// reboots or loses power), so we ping each peer's /me every 10 s and drop
// it after 3 consecutive failures. Also catches instanceId rotation (peer
// restarted with a new UUID before mDNS noticed).
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_MAX_FAILURES = 3;
const peerFailures = new Map(); // service.name -> consecutive failure count

async function pingPeer(peer) {
  const r = await fetch(`http://${peer.address}:${peer.port}/me`, {
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json().catch(() => ({}));
  if (data.instanceId && data.instanceId !== peer.instanceId) {
    throw new Error('instanceId rotated');
  }
}

async function runHealthCheck() {
  for (const [name, peer] of [...peerMap.entries()]) {
    try {
      await pingPeer(peer);
      peerFailures.set(name, 0);
    } catch (err) {
      const failures = (peerFailures.get(name) ?? 0) + 1;
      peerFailures.set(name, failures);
      if (failures >= HEALTH_MAX_FAILURES) {
        console.log(`[health] dropped ${peer.owner} after ${failures} failed pings (${err.message})`);
        peerMap.delete(name);
        peerFailures.delete(name);
        io.emit('peer:down', { instanceId: peer.instanceId });
      }
    }
  }
}

setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL_MS);

browser.on('error', (err) => console.error('[mDNS browse]', err.message));
browser.start();

await loadReplies();
await loadShortcuts();

httpServer.listen(PORT, () => {
  console.log(`Crema V5 — ${OWNER} on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nArrêt…');
  try { browser.stop(); } catch {}
  try { advertisement.stop(); } catch {}
  // 2s grace to let the mDNS "bye" packet reach peers, so they don't keep us
  // in their peerMap until avahi's ~2 min TTL expires. systemd's default
  // TimeoutStopSec is 90s, so this is well within budget.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
