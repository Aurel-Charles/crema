import mdns from 'mdns';
import { lookup as dnsLookup } from 'dns/promises';
import {
  INSTANCE_ID, OWNER, PORT, SERVICE_NAME, SERVICE_TYPE,
} from './config.js';

const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_MAX_FAILURES = 3;

const peerMap = new Map();      // service.name -> peer
const peerFailures = new Map(); // service.name -> consecutive failure count

function pickHost(service) {
  return service.host?.replace(/\.$/, '') ?? null;
}

export async function resolveHost(host) {
  try {
    const { address } = await dnsLookup(host, { family: 4 });
    return address;
  } catch {
    return host;
  }
}

export function listPeers() {
  return [...peerMap.values()].map((p) => ({ instanceId: p.instanceId, owner: p.owner }));
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
}

export function init({ io }) {
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

  browser.on('error', (err) => console.error('[mDNS browse]', err.message));
  browser.start();

  // Active health check — mDNS "bye" packets are unreliable (lost when a peer
  // reboots or loses power), so we ping each peer's /me every 10 s and drop
  // it after 3 consecutive failures. Also catches instanceId rotation (peer
  // restarted with a new UUID before mDNS noticed).
  const healthInterval = setInterval(async () => {
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
  }, HEALTH_CHECK_INTERVAL_MS);

  function stop() {
    clearInterval(healthInterval);
    try { browser.stop(); } catch {}
    try { advertisement.stop(); } catch {}
  }

  return { stop };
}
