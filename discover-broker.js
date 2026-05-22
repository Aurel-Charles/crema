import mdns from 'mdns';
import { BROKER_SERVICE_TYPE } from './config.js';
import { resolveHost } from './peers.js';
import { peerLog, errLog } from './logger.js';

// Pi-side broker discovery: browse `_crema-broker._tcp` and report the first
// broker that appears as a ws:// URL. Used by the dual transport when no
// CREMA_BROKER_URL is pinned. Reuses the same resolverSequence patch as
// peers.js — mdns 2.7.2's getaddrinfo step crashes on Node 18+, so we stop
// after DNSServiceResolve and resolve the .local hostname ourselves.
//
// Returns { stop } so the caller can tear the browser down. `onUrl` fires once
// per newly-seen broker with its ws:// URL; the caller decides what to do with
// late arrivals (Socket.IO already owns reconnection once connected).
export function discoverBroker({ onUrl }) {
  let browser = null;

  const onServiceUp = async (service) => {
    const host = service.host?.replace(/\.$/, '');
    if (!host || !service.port) return;
    // resolveHost returns null when the .local lookup fails; fall back to the
    // hostname so we build ws://broker.local:port (NSS-resolvable) rather than
    // ws://null:port.
    const address = await resolveHost(host) ?? host;
    const url = `ws://${address}:${service.port}`;
    peerLog('broker:discovered', `Broker trouvé sur ${url}`, { url, host });
    onUrl(url);
  };

  try {
    browser = mdns.createBrowser(mdns.tcp(BROKER_SERVICE_TYPE), {
      resolverSequence: [mdns.rst.DNSServiceResolve()],
    });
    browser.on('serviceUp', onServiceUp);
    browser.on('error', (err) => errLog('broker-discovery:error', err.message));
    browser.start();
    peerLog('broker:discovery-start', `Recherche d'un broker (${BROKER_SERVICE_TYPE})…`);
  } catch (err) {
    errLog('broker-discovery:start-failed', err.message);
  }

  return {
    stop() {
      try { browser?.stop(); } catch {}
      browser = null;
    },
  };
}
