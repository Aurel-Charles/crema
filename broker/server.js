import { createServer } from 'http';
import { Server } from 'socket.io';

// Crema LAN broker — a stateless WebSocket relay. It keeps an in-memory
// registry of connected Pis (owner -> socket) and routes `deliver` envelopes
// between them. It knows nothing about message contents and persists nothing;
// each Pi remains the sole owner of its history. See docs/broker-protocol.md.

const PORT = Number(process.env.BROKER_PORT ?? 4000);
const TOKEN = process.env.CREMA_BROKER_TOKEN ?? null;

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);

const httpServer = createServer((req, res) => {
  // Tiny health endpoint so the box can be probed without a WS client.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peers: [...registry.keys()] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer);

// owner -> { socket, instanceId }
const registry = new Map();

function roster(exceptOwner) {
  const list = [];
  for (const [owner, entry] of registry) {
    if (owner === exceptOwner) continue;
    list.push({ owner, instanceId: entry.instanceId });
  }
  return list;
}

// Resolve a target descriptor the same way the P2P transport does: by
// instanceId if present, else by owner. 1 Pi per owner today.
function resolve(to) {
  if (to?.instanceId) {
    for (const entry of registry.values()) {
      if (entry.instanceId === to.instanceId) return entry;
    }
    return null;
  }
  if (to?.owner) return registry.get(to.owner) ?? null;
  return null;
}

io.on('connection', (socket) => {
  socket.on('register', ({ owner, instanceId, token } = {}) => {
    if (TOKEN && token !== TOKEN) {
      socket.emit('register:denied', { error: 'bad token' });
      socket.disconnect(true);
      log(`register DENIED (bad token) from ${owner ?? '?'}`);
      return;
    }
    if (!owner || !instanceId) {
      socket.emit('register:denied', { error: 'owner and instanceId required' });
      socket.disconnect(true);
      return;
    }

    // Same-owner dedup: a new instance announcing means the previous one is
    // dead. Drop it and tell everyone, mirroring peers.js behaviour.
    const existing = registry.get(owner);
    if (existing && existing.instanceId !== instanceId) {
      socket.broadcast.emit('peer:down', { owner, instanceId: existing.instanceId });
      try { existing.socket.disconnect(true); } catch { /* already gone */ }
      log(`dedup ${owner}: dropped stale ${existing.instanceId.slice(0, 8)}`);
    }

    socket.data.owner = owner;
    socket.data.instanceId = instanceId;
    registry.set(owner, { socket, instanceId });

    socket.emit('peers', roster(owner));
    socket.broadcast.emit('peer:up', { owner, instanceId });
    log(`register ${owner} (${instanceId.slice(0, 8)}) — ${registry.size} online`);
  });

  socket.on('deliver', ({ to, kind, payload } = {}, ack) => {
    const target = resolve(to);
    if (!target) {
      if (typeof ack === 'function') ack({ ok: false, error: 'offline' });
      return;
    }
    target.socket.emit('deliver', {
      from: { owner: socket.data.owner, instanceId: socket.data.instanceId },
      kind,
      payload,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const owner = socket.data.owner;
    if (!owner) return;
    const entry = registry.get(owner);
    // Only remove if this socket still owns the slot — a newer instance may
    // have already replaced us (dedup above), in which case leave it alone.
    if (entry && entry.socket === socket) {
      registry.delete(owner);
      socket.broadcast.emit('peer:down', { owner, instanceId: entry.instanceId });
      log(`disconnect ${owner} — ${registry.size} online`);
    }
  });
});

httpServer.listen(PORT, () => {
  log(`Crema broker on :${PORT}${TOKEN ? ' (token auth ON)' : ''}`);
});

function shutdown() {
  log('Arrêt du broker…');
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
