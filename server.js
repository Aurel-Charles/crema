import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Bonjour } from 'bonjour-service';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_TYPE = 'crema';
const PORT = Number(process.env.PORT ?? 3000);
const OWNER = process.env.CREMA_OWNER ?? deriveOwnerFromHostname();
const INSTANCE_ID = randomUUID();

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

app.get('/me', (req, res) => {
  res.json({ owner: OWNER, instanceId: INSTANCE_ID });
});

app.get('/peers', (req, res) => {
  res.json(listPeers());
});

app.post('/send', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const target = typeof req.body?.target === 'string' ? req.body.target : '';
  if (!text) return res.status(400).json({ error: 'Message vide' });
  if (!target) return res.status(400).json({ error: 'Destinataire manquant' });

  const peer = peerMap.get(target);
  if (!peer) return res.status(404).json({ error: 'Destinataire introuvable' });

  try {
    const url = `http://${peer.address}:${peer.port}/inbox`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: OWNER }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[send] failed → ${peer.owner}:`, err.message);
    res.status(502).json({ error: `Destinataire injoignable (${peer.owner})` });
  }
});

app.post('/inbox', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const from = typeof req.body?.from === 'string' ? req.body.from.trim() : 'Inconnu';
  if (!text) return res.status(400).json({ error: 'Message vide' });
  io.emit('message', { text, from });
  res.json({ ok: true });
});

const bonjour = new Bonjour();
const peerMap = new Map();

function listPeers() {
  return [...peerMap.values()]
    .filter((p) => p.instanceId !== INSTANCE_ID)
    .map((p) => ({ instanceId: p.instanceId, owner: p.owner }));
}

function pickAddress(service) {
  const v4 = service.addresses?.find((a) => a.includes('.') && !a.includes(':'));
  return v4 ?? service.referer?.address ?? service.host;
}

bonjour.publish({
  name: `crema-${OWNER}-${INSTANCE_ID.slice(0, 8)}`,
  type: SERVICE_TYPE,
  port: PORT,
  txt: { owner: OWNER, instanceId: INSTANCE_ID },
});

const browser = bonjour.find({ type: SERVICE_TYPE });

browser.on('up', (service) => {
  const txt = service.txt ?? {};
  if (!txt.instanceId) return;
  if (txt.instanceId === INSTANCE_ID) return;
  const peer = {
    instanceId: txt.instanceId,
    owner: txt.owner ?? '?',
    address: pickAddress(service),
    port: service.port,
  };
  peerMap.set(peer.instanceId, peer);
  console.log(`[mDNS] up: ${peer.owner} @ ${peer.address}:${peer.port}`);
});

browser.on('down', (service) => {
  const txt = service.txt ?? {};
  if (!txt.instanceId) return;
  if (peerMap.delete(txt.instanceId)) {
    console.log(`[mDNS] down: ${txt.owner}`);
  }
});

httpServer.listen(PORT, () => {
  console.log(`Crema V1 — ${OWNER} on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nArrêt…');
  bonjour.unpublishAll(() => {
    bonjour.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
