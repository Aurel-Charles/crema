import * as peers from './peers.js';
import { msgLog } from './logger.js';

// P2P transport: wraps the existing mDNS discovery (peers.js) and direct
// Pi-to-Pi HTTP delivery. This is the default and preserves the historical
// behaviour exactly — the .local re-resolve retry now lives here instead of
// being smeared across messaging.js. See docs/broker-protocol.md.

const KIND_PATH = {
  inbox: '/inbox',
  'read-receipt': '/read-receipt',
  typing: '/typing',
};

async function post(address, port, path, payload) {
  const r = await fetch(`http://${address}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export function createP2pTransport({ io }) {
  let lifecycle = null;

  function findPeer({ owner, instanceId } = {}) {
    if (instanceId) return peers.findPeerByInstanceId(instanceId);
    if (owner) return peers.findPeerByOwner(owner);
    return null;
  }

  return {
    init() {
      lifecycle = peers.init({ io });
    },

    stop() {
      lifecycle?.stop();
    },

    // V7.1 — nickname changed locally: re-advertise mDNS so peers see it.
    announceProfile() {
      lifecycle?.refresh();
    },

    // V7.3 — no broker on this path, so a broker-URL change is a no-op. Present
    // only to satisfy the transport interface (settings PUT /transport calls it).
    setBrokerUrl() {},

    listPeers() {
      return peers.listPeers();
    },

    findPeer,

    // P2P inbound arrives via the HTTP routes in messaging.js, so there is
    // nothing to wire here. The hook exists to satisfy the interface.
    onDeliver() {},

    // No broker on this path — the status badge stays in "direct" mode.
    health: () => ({ mode: 'p2p', broker: 'disabled' }),

    async deliver(target, kind, payload) {
      const path = KIND_PATH[kind];
      if (!path) return { ok: false, error: 'bad-kind' };

      const peer = findPeer(target);
      if (!peer) return { ok: false, error: 'offline' };

      try {
        await post(peer.address, peer.port, path, payload);
        return { ok: true };
      } catch (err1) {
        // Single re-resolve retry: the peer's IP may have changed since
        // discovery (DHCP lease, Wi-Fi reconnect). Do not replace a numeric
        // mDNS-provided address with a .local hostname if DNS lookup fails.
        msgLog('msg:send-retry', `Renvoi → ${peer.owner} (${err1.message})`, { to: peer.owner }, 'warn');
        try {
          const fresh = await peers.resolveHost(peer.host);
          if (!fresh || fresh === peer.address) throw err1;
          peer.address = fresh;
          await post(fresh, peer.port, path, payload);
          return { ok: true };
        } catch (err2) {
          return { ok: false, error: 'unreachable', detail: err2.message };
        }
      }
    },
  };
}
