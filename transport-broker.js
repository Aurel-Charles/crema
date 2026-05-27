import { io as ioClient } from 'socket.io-client';
import { INSTANCE_ID, OWNER, BROKER_URL_DEFAULT, BROKER_TOKEN } from './config.js';
import { getNickname, getBrokerUrl } from './store.js';
import { peerLog, errLog } from './logger.js';

// Broker transport: a Socket.IO *client* to the LAN broker. Implements the same
// interface as transport-p2p so messaging.js and server.js stay topology-blind.
// See docs/broker-protocol.md for the wire protocol.
//
// Presence is mirrored into the Pi's *local* io (the one its PWA/display
// connect to) as the very same peer:up / peer:down events that peers.js emits
// in P2P mode, so the front-ends behave identically.
export function createBrokerTransport({ io, onStatus = () => {} }) {
  let socket = null;
  let deliverHandler = () => {};
  let peers = []; // [{ owner, instanceId, nickname }]
  let connected = false;
  let currentUrl = null; // the URL we're connected to / last asked to use

  function setConnected(next) {
    if (next === connected) return;
    connected = next;
    onStatus(connected ? 'connected' : 'down');
  }

  function findPeer({ owner, instanceId } = {}) {
    if (instanceId) return peers.find((p) => p.instanceId === instanceId) ?? null;
    if (owner) return peers.find((p) => p.owner === owner) ?? null;
    return null;
  }

  return {
    isConnected: () => connected,

    health: () => ({ mode: 'broker', broker: connected ? 'connected' : 'down', url: currentUrl }),

    // Default honours the V7.3 precedence (UI override > env) in pure broker
    // mode. In dual mode the composite always calls init(url) explicitly.
    init(url = getBrokerUrl() ?? BROKER_URL_DEFAULT) {
      currentUrl = url;
      socket = ioClient(url, { reconnection: true, reconnectionDelayMax: 5000 });

      socket.on('connect', () => {
        socket.emit('register', {
          owner: OWNER,
          instanceId: INSTANCE_ID,
          nickname: getNickname() || undefined,
          token: BROKER_TOKEN ?? undefined,
        });
        setConnected(true);
        peerLog('broker:connected', `Connecté au broker ${url}`, { url });
      });

      // Full roster on (re)register — replace local view and announce each to
      // our front-ends.
      socket.on('peers', (list) => {
        peers = Array.isArray(list)
          ? list.map((p) => ({ owner: p.owner, instanceId: p.instanceId, nickname: p.nickname || '' }))
          : [];
        for (const p of peers) io.emit('peer:up', p);
      });

      socket.on('peer:up', (p) => {
        if (!p?.instanceId) return;
        const entry = peers.find((x) => x.instanceId === p.instanceId);
        if (entry) entry.nickname = p.nickname || '';
        else peers.push({ owner: p.owner, instanceId: p.instanceId, nickname: p.nickname || '' });
        io.emit('peer:up', { owner: p.owner, instanceId: p.instanceId, nickname: p.nickname || '' });
        peerLog('peer:up', `${p.owner} en ligne (broker)`, { owner: p.owner });
      });

      // V7.1 — a peer changed its nickname (no up/down). Update our view and
      // re-emit peer:up so front-ends upsert the new name.
      socket.on('profile:update', ({ owner, instanceId, nickname } = {}) => {
        if (!instanceId) return;
        const entry = peers.find((x) => x.instanceId === instanceId);
        if (entry) entry.nickname = nickname || '';
        io.emit('peer:up', { owner, instanceId, nickname: nickname || '' });
        peerLog('peer:profile', `${owner} → surnom « ${nickname || '—'} » (broker)`, { owner, nickname });
      });

      socket.on('peer:down', (p) => {
        if (!p?.instanceId) return;
        peers = peers.filter((x) => x.instanceId !== p.instanceId);
        io.emit('peer:down', { instanceId: p.instanceId });
        peerLog('peer:down', `${p.owner} hors ligne (broker)`, { owner: p.owner });
      });

      // Inbound delivery pushed by the broker → hand to messaging's dispatcher.
      socket.on('deliver', ({ from, kind, payload } = {}) => {
        deliverHandler(from, kind, payload);
      });

      socket.on('register:denied', ({ error } = {}) => {
        errLog('broker:denied', `Register refusé par le broker : ${error}`);
      });

      socket.on('connect_error', (err) => {
        errLog('broker:connect-error', err.message);
      });

      socket.on('disconnect', (reason) => {
        // Lost the broker → we can no longer see anyone. Clear and tell the UI.
        const gone = peers;
        peers = [];
        setConnected(false);
        for (const p of gone) io.emit('peer:down', { instanceId: p.instanceId });
        peerLog('broker:disconnected', `Déconnecté du broker (${reason})`, { reason }, 'warn');
      });
    },

    stop() {
      try { socket?.disconnect(); } catch {}
      socket = null;
      peers = [];
      setConnected(false);
    },

    // V7.3 — re-point to a new broker URL in pure broker mode (settings page).
    // `url` is the resolved effective target; empty falls back to the default.
    // In dual mode the composite drives re-pointing itself and never calls this.
    setBrokerUrl(url) {
      this.stop();
      this.init(url || BROKER_URL_DEFAULT);
    },

    listPeers() {
      return peers.map((p) => ({ owner: p.owner, instanceId: p.instanceId, nickname: p.nickname || '' }));
    },

    // V7.1 — broadcast our new nickname over the broker. Not a re-register
    // (that would trip same-owner dedup on ourselves); a dedicated event the
    // broker relays to everyone else. No-op when the socket is down.
    announceProfile() {
      if (!socket || !socket.connected) return;
      socket.emit('profile:update', {
        owner: OWNER,
        instanceId: INSTANCE_ID,
        nickname: getNickname() || '',
      });
    },

    findPeer,

    onDeliver(fn) {
      deliverHandler = typeof fn === 'function' ? fn : () => {};
    },

    // Forward to the broker and resolve with its ack. Mirrors the P2P contract:
    // { ok: true } | { ok: false, error }.
    deliver(target, kind, payload) {
      return new Promise((resolve) => {
        if (!socket || !socket.connected) {
          resolve({ ok: false, error: 'broker-offline' });
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: 'timeout' });
        }, 5000);
        socket.emit('deliver', { to: target, kind, payload }, (ack) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ack ?? { ok: false, error: 'no-ack' });
        });
      });
    },
  };
}
