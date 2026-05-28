import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

// Crema LAN broker — a stateless WebSocket relay. It keeps an in-memory
// registry of connected Pis (owner -> socket) and routes `deliver` envelopes
// between them. It knows nothing about message contents and persists nothing;
// each Pi remains the sole owner of its history. See docs/broker-protocol.md.

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);

export function startBroker({
  port = Number(process.env.BROKER_PORT ?? 4000),
  token = process.env.CREMA_BROKER_TOKEN ?? null,
  advertise = process.env.CREMA_BROKER_ADVERTISE !== '0',
} = {}) {
  // owner -> { socket, instanceId, nickname, version }
  const registry = new Map();
  let advertisement = null;

  const httpServer = createServer((req, res) => {
    // Tiny health endpoint so the box can be probed without a WS client.
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        peers: [...registry.entries()].map(([owner, entry]) => ({
          owner, nickname: entry.nickname || '', version: entry.version || '',
        })),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io = new Server(httpServer);

  function roster(exceptOwner) {
    const list = [];
    for (const [owner, entry] of registry) {
      if (owner === exceptOwner) continue;
      list.push({
        owner, instanceId: entry.instanceId, nickname: entry.nickname || '', version: entry.version || '',
      });
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
    socket.on('register', ({ owner, instanceId, nickname, version, token: peerToken } = {}) => {
      if (token && peerToken !== token) {
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
      socket.data.nickname = nickname || '';
      socket.data.version = version || '';
      registry.set(owner, { socket, instanceId, nickname: nickname || '', version: version || '' });

      socket.emit('peers', roster(owner));
      socket.broadcast.emit('peer:up', {
        owner, instanceId, nickname: nickname || '', version: version || '',
      });
      log(`register ${owner} (${instanceId.slice(0, 8)})${nickname ? ` "${nickname}"` : ''}${version ? ` · ${version}` : ''} — ${registry.size} online`);
    });

    // V7.1 — display nickname change. Not a re-register (that trips same-owner
    // dedup); a presentation-only update we store and relay to everyone else.
    socket.on('profile:update', ({ nickname } = {}) => {
      const owner = socket.data.owner;
      if (!owner) return;
      const entry = registry.get(owner);
      if (!entry || entry.socket !== socket) return;
      entry.nickname = nickname || '';
      socket.data.nickname = entry.nickname;
      socket.broadcast.emit('profile:update', { owner, instanceId: entry.instanceId, nickname: entry.nickname });
      log(`profile ${owner} → "${entry.nickname}"`);
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

  async function startAdvertising() {
    if (!advertise) {
      log('mDNS advertise OFF (CREMA_BROKER_ADVERTISE=0) — pin CREMA_BROKER_URL on the Pis');
      return;
    }
    try {
      const mdns = (await import('mdns')).default;
      advertisement = mdns.createAdvertisement(mdns.tcp('crema-broker'), port, {
        name: `crema-broker-${port}`,
      });
      advertisement.on('error', (err) => log(`mDNS advertise error: ${err.message}`));
      advertisement.start();
      log(`mDNS advertising _crema-broker._tcp on :${port}`);
    } catch (err) {
      log(`mDNS unavailable — auto-discovery off, relay still works (${err.message})`);
    }
  }

  const ready = new Promise((resolveReady, rejectReady) => {
    const onError = (err) => {
      httpServer.off('listening', onListening);
      rejectReady(err);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      log(`Crema broker on :${port}${token ? ' (token auth ON)' : ''}`);
      startAdvertising();
      resolveReady();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port);
  });

  function stop({ exit = false } = {}) {
    log('Arrêt du broker…');
    try { advertisement?.stop(); } catch { /* not advertising */ }
    io.close();
    httpServer.close(() => {
      if (exit) process.exit(0);
    });
    if (exit) setTimeout(() => process.exit(0), 2000).unref();
  }

  return { httpServer, io, ready, registry, stop };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isCli) {
  const broker = startBroker();
  process.on('SIGINT', () => broker.stop({ exit: true }));
  process.on('SIGTERM', () => broker.stop({ exit: true }));
}
