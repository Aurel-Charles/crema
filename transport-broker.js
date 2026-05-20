import { io as ioClient } from 'socket.io-client';
import { OWNER, INSTANCE_ID, BROKER_URL, BROKER_TOKEN } from './config.js';
import { peerLog, errLog } from './logger.js';

// Broker transport: a Socket.IO *client* to the LAN broker. Implements the same
// interface as transport-p2p so messaging.js and server.js stay topology-blind.
// See docs/broker-protocol.md for the wire protocol.
//
// Presence is mirrored into the Pi's *local* io (the one its PWA/display
// connect to) as the very same peer:up / peer:down events that peers.js emits
// in P2P mode, so the front-ends behave identically.
export function createBrokerTransport({ io }) {
  let socket = null;
  let deliverHandler = () => {};
  let peers = []; // [{ owner, instanceId }]

  function findPeer({ owner, instanceId } = {}) {
    if (instanceId) return peers.find((p) => p.instanceId === instanceId) ?? null;
    if (owner) return peers.find((p) => p.owner === owner) ?? null;
    return null;
  }

  return {
    init() {
      socket = ioClient(BROKER_URL, { reconnection: true, reconnectionDelayMax: 5000 });

      socket.on('connect', () => {
        socket.emit('register', {
          owner: OWNER,
          instanceId: INSTANCE_ID,
          token: BROKER_TOKEN ?? undefined,
        });
        peerLog('broker:connected', `Connecté au broker ${BROKER_URL}`, { url: BROKER_URL });
      });

      // Full roster on (re)register — replace local view and announce each to
      // our front-ends.
      socket.on('peers', (list) => {
        peers = Array.isArray(list) ? list.map((p) => ({ owner: p.owner, instanceId: p.instanceId })) : [];
        for (const p of peers) io.emit('peer:up', p);
      });

      socket.on('peer:up', (p) => {
        if (!p?.instanceId) return;
        if (!peers.some((x) => x.instanceId === p.instanceId)) {
          peers.push({ owner: p.owner, instanceId: p.instanceId });
        }
        io.emit('peer:up', { owner: p.owner, instanceId: p.instanceId });
        peerLog('peer:up', `${p.owner} en ligne (broker)`, { owner: p.owner });
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
        for (const p of gone) io.emit('peer:down', { instanceId: p.instanceId });
        peerLog('broker:disconnected', `Déconnecté du broker (${reason})`, { reason }, 'warn');
      });
    },

    stop() {
      try { socket?.disconnect(); } catch {}
      socket = null;
      peers = [];
    },

    listPeers() {
      return peers.map((p) => ({ owner: p.owner, instanceId: p.instanceId }));
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
