import { createP2pTransport } from './transport-p2p.js';
import { createBrokerTransport } from './transport-broker.js';
import { discoverBroker } from './discover-broker.js';
import { getBrokerUrl } from './store.js';
import { peerLog } from './logger.js';

// Dual transport: runs the broker client and the P2P stack *at the same time*.
// Broker is the primary path; P2P is the always-warm fallback. This is the
// default topology — see docs/broker-protocol.md.
//
//  - Inbound is dual-capable for free: messaging.js always registers the HTTP
//    routes (P2P inbound) and always wires transport.onDeliver (broker inbound).
//  - Outbound (deliver) tries the broker first; on any non-ok it falls back to
//    direct HTTP. Never both — no duplicate delivery.
//  - Because every Pi stays reachable on both paths, there is no split-brain:
//    a Pi that only sees the broker and one that only sees mDNS still talk.
//
// Broker location (V7.3 precedence): a UI override (data/transport.json, set on
// the settings page) wins, else the CREMA_BROKER_URL env pin, else mDNS discovery
// of `_crema-broker._tcp`. getBrokerUrl() in store.js resolves the first two; a
// null result means "discover". The settings page re-points live via setBrokerUrl.
export function createDualTransport({ io }) {
  let brokerStarted = false;
  let brokerUrl = null;
  let discovery = null;

  function emitHealth() {
    io.emit('transport:health', { mode: 'dual', broker: brokerState(), url: brokerUrl });
  }

  function brokerState() {
    if (broker.isConnected()) return 'connected';
    if (brokerStarted) return 'down';
    return 'discovering';
  }

  // Presence aggregation: a peer is "up" if *either* path sees it. Both
  // sub-transports emit peer:up/peer:down for the same peer, so we ref-count by
  // source and only forward a net peer:down to the front-end once the last
  // path drops it. Without this, a broker disconnect would wrongly grey out a
  // peer that's still reachable over p2p (and flip the status badge to
  // "hors-ligne" instead of "p2p · direct"). All other events pass through.
  // V7.4 — version flows through here too: stored in the entry, re-emitted on
  // change so the front-end picks up upgrades without waiting for a peer:up
  // from one of the sub-transports. V7.7 — status flows through the same way.
  const sources = new Map(); // instanceId -> { owner, nickname, version, status, statuses: Map<source,status>, sources: Set<'p2p'|'broker'> }

  // Effective status across the live paths: the first non-null. A null from one
  // path (e.g. a pre-V7.7 broker that strips the field, or a path that hasn't
  // caught the announce yet) must not erase a real status carried by the other.
  function effStatus(e) {
    for (const s of e.statuses.values()) if (s) return s;
    return null;
  }

  function presenceUp(source, p) {
    if (!p?.instanceId) return;
    let e = sources.get(p.instanceId);
    if (!e) { e = { owner: p.owner ?? '?', nickname: '', version: '', status: null, statuses: new Map(), sources: new Set() }; sources.set(p.instanceId, e); }
    if (p.owner) e.owner = p.owner;
    const wasEmpty = e.sources.size === 0;
    // Forward when the peer first comes up OR its nickname/version/status
    // changed (V7.1 / V7.4 / V7.7 hot updates): peer:up is an idempotent upsert
    // on the front-end side, so re-emitting is safe and is how nickname edits,
    // version bumps and status changes land.
    const nick = p.nickname || '';
    const nickChanged = nick !== e.nickname;
    e.nickname = nick;
    const ver = p.version || '';
    // Only treat a non-empty incoming version as a change: an empty value from
    // one source (e.g. p2p before V7.4 announce caught up) must not clobber a
    // good value from the other.
    const verChanged = ver && ver !== e.version;
    if (ver) e.version = ver;
    // Status is resolved per-source (see effStatus): record this path's view,
    // then recompute the effective so one path's null can't clobber the other's
    // real status. A peer:up without the key leaves this path's view untouched.
    if ('status' in p) e.statuses.set(source, p.status ?? null);
    const status = effStatus(e);
    const statusChanged = JSON.stringify(status) !== JSON.stringify(e.status);
    e.status = status;
    e.sources.add(source);
    if (wasEmpty || nickChanged || verChanged || statusChanged) {
      io.emit('peer:up', { instanceId: p.instanceId, owner: e.owner, nickname: e.nickname, version: e.version, status: e.status });
    }
  }

  function presenceDown(source, p) {
    const id = p?.instanceId;
    if (!id) return;
    const e = sources.get(id);
    if (!e) return;
    e.sources.delete(source);
    e.statuses.delete(source);
    if (e.sources.size === 0) { sources.delete(id); io.emit('peer:down', { instanceId: id }); return; }
    // The dropped path may have held the only non-null status — recompute, and
    // re-emit if the effective status changed (peer is still up via the other).
    const status = effStatus(e);
    if (JSON.stringify(status) !== JSON.stringify(e.status)) {
      e.status = status;
      io.emit('peer:up', { instanceId: id, owner: e.owner, nickname: e.nickname, version: e.version, status: e.status });
    }
  }

  // A façade over the real io that reroutes only presence events through the
  // aggregator; everything else (message, msg:status, …) passes straight to io.
  function presenceProxy(source) {
    return new Proxy(io, {
      get(target, prop, recv) {
        if (prop === 'emit') {
          return (event, ...args) => {
            if (event === 'peer:up') return presenceUp(source, args[0]);
            if (event === 'peer:down') return presenceDown(source, args[0]);
            return target.emit(event, ...args);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  const broker = createBrokerTransport({
    io: presenceProxy('broker'),
    onStatus: () => emitHealth(),
  });
  const p2p = createP2pTransport({ io: presenceProxy('p2p') });

  function startBroker(url) {
    if (brokerStarted) {
      // Already connected/connecting. Only re-point if the broker moved to a
      // new address while we're currently down (Socket.IO owns reconnection to
      // the same URL otherwise).
      if (url !== brokerUrl && !broker.isConnected()) {
        peerLog('broker:repoint', `Broker déplacé → ${url}`, { from: brokerUrl, to: url });
        broker.stop();
        brokerUrl = url;
        broker.init(url);
      }
      return;
    }
    brokerStarted = true;
    brokerUrl = url;
    broker.init(url);
    emitHealth();
  }

  // Deliberate (re)targeting of the broker, used at boot and by setBrokerUrl().
  // Unlike startBroker (which only re-points a *down* broker, for discovery),
  // this always applies the requested target:
  //   url        → pin: stop discovery, (re-)connect the broker to url
  //   null/empty → unpin: drop the broker connection, fall back to mDNS discovery
  function applyBrokerTarget(url) {
    if (url) {
      if (discovery) { discovery.stop(); discovery = null; }
      if (!brokerStarted) {
        brokerStarted = true;
        brokerUrl = url;
        broker.init(url);
      } else if (url !== brokerUrl) {
        peerLog('broker:repoint', `Broker re-pointé → ${url}`, { from: brokerUrl, to: url });
        broker.stop();
        brokerUrl = url;
        broker.init(url);
      }
    } else {
      if (brokerStarted) {
        broker.stop();
        brokerStarted = false;
        brokerUrl = null;
      }
      if (!discovery) {
        discovery = discoverBroker({ onUrl: (u) => startBroker(u) });
      }
    }
    emitHealth();
  }

  return {
    init() {
      // P2P first: mDNS peers + HTTP inbound are live immediately.
      p2p.init();
      // Effective broker target: UI override > env pin > null (→ discovery).
      // Read from the store, which store.init() loaded before transport.init().
      applyBrokerTarget(getBrokerUrl());
    },

    // V7.3 — broker URL changed from the settings page. `url` is the already
    // resolved effective target (override || env || null); re-point live.
    setBrokerUrl(url) {
      applyBrokerTarget(url || null);
    },

    stop() {
      discovery?.stop();
      broker.stop();
      p2p.stop();
    },

    listPeers() {
      // Derived from the presence aggregator so a fresh client's peers:init
      // matches the net peer:up/peer:down stream exactly.
      return [...sources.entries()].map(([instanceId, e]) => ({
        instanceId, owner: e.owner, nickname: e.nickname, version: e.version || '', status: e.status ?? null,
      }));
    },

    findPeer(desc) {
      // Prefer the broker's view; fall back to the P2P address book.
      return broker.findPeer(desc) ?? p2p.findPeer(desc);
    },

    onDeliver(fn) {
      // Broker pushes inbound over WebSocket; P2P arrives via the HTTP routes.
      broker.onDeliver(fn);
    },

    // V7.1 — fan the nickname change out over both paths. Broker reaches peers
    // that only see the relay; mDNS re-advertise reaches peers that only see
    // the LAN. Each is a no-op when its path is down.
    announceProfile() {
      broker.announceProfile();
      p2p.announceProfile();
    },

    async deliver(target, kind, payload) {
      // Broker first when connected. broker.deliver returns instantly with
      // { ok:false, error:'broker-offline' } when the socket is down, so a
      // known-down broker costs nothing per call (matters for typing spam).
      if (broker.isConnected()) {
        const viaBroker = await broker.deliver(target, kind, payload);
        if (viaBroker.ok) return viaBroker;
        peerLog('deliver:fallback', `Broker KO (${viaBroker.error}) → repli p2p`, { kind, error: viaBroker.error }, 'warn');
      }
      return p2p.deliver(target, kind, payload);
    },

    health() {
      return { mode: 'dual', broker: brokerState(), url: brokerUrl };
    },
  };
}
