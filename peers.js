import mdns from 'mdns';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import {
  INSTANCE_ID, MDNS_RESOLVE_ADDRESSES, OWNER, PORT, SERVICE_NAME, SERVICE_TYPE, VERSION,
} from './config.js';
import { getNickname } from './store.js';
import { peerLog, errLog } from './logger.js';

const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_MAX_FAILURES = 3;

// Long-running mDNS pipelines rust after a few hours on Pi (observed: full
// peer loss at ~4h on both sides during a 5h stability run, despite Node and
// avahi-daemon staying healthy). Recreating advertisement + browser every 2h
// keeps discovery fresh without disrupting traffic — peers see a brief
// dedup but the address book stays current.
const MDNS_REBIRTH_INTERVAL_MS = 2 * 60 * 60 * 1000;

const peerMap = new Map();      // service.name -> peer
const peerFailures = new Map(); // service.name -> consecutive failure count

function pickHost(service) {
  return service.host?.replace(/\.$/, '') ?? null;
}

function pickAddress(service) {
  const addresses = Array.isArray(service.addresses) ? service.addresses : [];
  return addresses.find((address) => isIP(address) === 4) ?? null;
}

export async function resolveHost(host) {
  try {
    const { address } = await dnsLookup(host, { family: 4 });
    return address;
  } catch {
    return null;
  }
}

export function listPeers() {
  return [...peerMap.values()].map((p) => ({
    instanceId: p.instanceId, owner: p.owner, nickname: p.nickname, version: p.version,
  }));
}

export function findPeerByInstanceId(id) {
  for (const peer of peerMap.values()) {
    if (peer.instanceId === id) return peer;
  }
  return null;
}

export function findPeerByOwner(owner) {
  for (const peer of peerMap.values()) {
    if (peer.owner === owner) return peer;
  }
  return null;
}

async function pingPeer(peer) {
  const r = await fetch(`http://${peer.address}:${peer.port}/me`, {
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json().catch(() => ({}));
  if (data.instanceId && data.instanceId !== peer.instanceId) {
    throw new Error('instanceId rotated');
  }
  return data;
}

export function init({ io }) {
  let advertisement = null;
  let browser = null;

  const onServiceUp = async (service) => {
    const txt = service.txtRecord ?? {};
    if (!txt.instanceId) return;
    if (txt.instanceId === INSTANCE_ID) return;
    const host = pickHost(service);
    if (!host) return;
    const address = pickAddress(service) ?? await resolveHost(host) ?? host;
    const peer = {
      instanceId: txt.instanceId,
      owner: txt.owner ?? '?',
      nickname: txt.nickname || '',
      version: txt.version || '',
      host,
      address,
      addresses: Array.isArray(service.addresses) ? service.addresses : [],
      port: service.port,
    };

    // Same-owner dedup: a new instance announcing means the previous one is dead,
    // even if avahi hasn't sent its serviceDown yet. Assumes 1 Pi per owner (true
    // in V2; revisit when we add room labels for multi-Pi-per-owner setups).
    for (const [name, p] of peerMap) {
      if (p.owner === peer.owner && p.instanceId !== peer.instanceId) {
        peerMap.delete(name);
        peerFailures.delete(name);
        peerLog('peer:dedup', `${p.owner} stale instance dropped (${p.instanceId.slice(0, 8)})`, {
          owner: p.owner, oldInstanceId: p.instanceId, newInstanceId: peer.instanceId,
        });
        io.emit('peer:down', { instanceId: p.instanceId });
      }
    }

    const existing = peerMap.get(service.name);
    peerMap.set(service.name, peer);
    peerFailures.set(service.name, 0);
    if (!existing) {
      peerLog('peer:up', `${peer.owner} apparu sur ${address}:${peer.port} (${peer.version || '?'})`, {
        owner: peer.owner, host, address, addresses: peer.addresses, port: peer.port, version: peer.version,
      });
      io.emit('peer:up', {
        instanceId: peer.instanceId, owner: peer.owner, nickname: peer.nickname, version: peer.version,
      });
    } else {
      if (existing.address !== address) {
        peerLog('peer:reresolved', `${peer.owner} → nouvelle IP ${address}:${peer.port}`, {
          owner: peer.owner, host, oldAddress: existing.address, address, addresses: peer.addresses,
        });
      }
      // The peer re-advertised with a new nickname (V7.1 hot update over mDNS)
      // or a new version (V7.4 on Pi restart with a new build). Re-emit peer:up
      // so front-ends upsert the change — peer:up is an idempotent upsert keyed
      // by instanceId.
      if (existing.nickname !== peer.nickname || existing.version !== peer.version) {
        peerLog('peer:profile', `${peer.owner} → surnom « ${peer.nickname || '—'} » · ${peer.version || '?'}`, {
          owner: peer.owner, nickname: peer.nickname, version: peer.version,
        });
        io.emit('peer:up', {
          instanceId: peer.instanceId, owner: peer.owner, nickname: peer.nickname, version: peer.version,
        });
      }
    }
  };

  const onServiceDown = (service) => {
    const peer = peerMap.get(service.name);
    if (peer) {
      peerMap.delete(service.name);
      peerFailures.delete(service.name);
      peerLog('peer:down-mdns', `${peer.owner} a annoncé son départ`, { owner: peer.owner });
      io.emit('peer:down', { instanceId: peer.instanceId });
    }
  };

  function startMdns() {
    advertisement = mdns.createAdvertisement(
      mdns.tcp(SERVICE_TYPE),
      PORT,
      {
        name: SERVICE_NAME,
        // nickname read fresh at advertise time so a re-advertise (rebirth or
        // V7.1 refresh()) picks up the current value. version is frozen at boot
        // (V7.4) — it can't change without a process restart, which mints a new
        // INSTANCE_ID anyway and triggers a same-owner dedup on peers.
        txtRecord: { owner: OWNER, instanceId: INSTANCE_ID, nickname: getNickname() || '', version: VERSION },
      },
    );
    advertisement.on('error', (err) => errLog('mdns:advertise-error', err.message));
    advertisement.start();

    const resolverSequence = MDNS_RESOLVE_ADDRESSES
      ? [
          mdns.rst.DNSServiceResolve(),
          mdns.rst.DNSServiceGetAddrInfo({ families: [4] }),
          mdns.rst.makeAddressesUnique(),
        ]
      : [mdns.rst.DNSServiceResolve()];

    browser = mdns.createBrowser(mdns.tcp(SERVICE_TYPE), {
      resolverSequence,
    });
    browser.on('serviceUp', onServiceUp);
    browser.on('serviceDown', onServiceDown);
    browser.on('error', (err) => errLog('mdns:browse-error', err.message));
    browser.start();
  }

  function stopMdns() {
    try { browser?.stop(); } catch {}
    try { advertisement?.stop(); } catch {}
    browser = null;
    advertisement = null;
  }

  startMdns();

  const rebirthInterval = setInterval(() => {
    peerLog('mdns:rebirth', 'Recréation advertisement + browser (anti-rust)', {
      everyMs: MDNS_REBIRTH_INTERVAL_MS,
    });
    stopMdns();
    setTimeout(startMdns, 500);
  }, MDNS_REBIRTH_INTERVAL_MS);

  // Active health check — mDNS "bye" packets are unreliable (lost when a peer
  // reboots or loses power), so we ping each peer's /me every 10 s and drop
  // it after 3 consecutive failures. Also catches instanceId rotation (peer
  // restarted with a new UUID before mDNS noticed).
  const healthInterval = setInterval(async () => {
    for (const [name, peer] of [...peerMap.entries()]) {
      try {
        const data = await pingPeer(peer);
        peerFailures.set(name, 0);
        // V7.4 — backfill version from /me. The TXT mDNS record carries it
        // too, but health-check is the more direct signal (no advertisement
        // round-trip needed). Useful when the peer was discovered before V7.4
        // shipped, then upgraded mid-run.
        if (typeof data.version === 'string' && data.version && data.version !== peer.version) {
          peer.version = data.version;
          peerLog('peer:version', `${peer.owner} → version ${peer.version}`, {
            owner: peer.owner, version: peer.version,
          });
          io.emit('peer:up', {
            instanceId: peer.instanceId, owner: peer.owner, nickname: peer.nickname, version: peer.version,
          });
        }
      } catch (err) {
        const failures = (peerFailures.get(name) ?? 0) + 1;
        peerFailures.set(name, failures);
        if (failures >= HEALTH_MAX_FAILURES) {
          peerLog(
            'peer:down-health',
            `${peer.owner} retiré après ${failures} pings en échec (${err.message})`,
            { owner: peer.owner, failures, reason: err.message },
            'warn'
          );
          peerMap.delete(name);
          peerFailures.delete(name);
          io.emit('peer:down', { instanceId: peer.instanceId });
        }
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // V7.1 — re-advertise immediately so peers pick up a changed nickname (or
  // any future identity field) without waiting for the 2h rebirth. Same
  // stop/start dance, so peers see a brief dedup then the fresh TXT record.
  function refresh() {
    stopMdns();
    setTimeout(startMdns, 200);
  }

  function stop() {
    clearInterval(rebirthInterval);
    clearInterval(healthInterval);
    stopMdns();
  }

  return { stop, refresh };
}
