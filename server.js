import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mdns from 'mdns';
import { lookup as dnsLookup } from 'dns/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_TYPE = 'crema';
const PORT = Number(process.env.PORT ?? 3000);
const OWNER = process.env.CREMA_OWNER ?? deriveOwnerFromHostname();
const INSTANCE_ID = randomUUID();
const SERVICE_NAME = `crema-${OWNER}-${INSTANCE_ID.slice(0, 8)}`;

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

  const peer = findPeerByInstanceId(target);
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

const peerMap = new Map(); // service name -> peer

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
  const existing = peerMap.get(service.name);
  peerMap.set(service.name, peer);
  if (!existing || existing.address !== address) {
    console.log(`[mDNS] up: ${peer.owner} @ ${address}:${peer.port}`);
  }
});

browser.on('serviceDown', (service) => {
  const peer = peerMap.get(service.name);
  if (peer) {
    peerMap.delete(service.name);
    console.log(`[mDNS] down: ${peer.owner}`);
  }
});

browser.on('error', (err) => console.error('[mDNS browse]', err.message));
browser.start();

httpServer.listen(PORT, () => {
  console.log(`Crema V1 — ${OWNER} on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nArrêt…');
  try { browser.stop(); } catch {}
  try { advertisement.stop(); } catch {}
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
