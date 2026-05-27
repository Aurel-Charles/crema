import { TRANSPORT } from './config.js';

// Selects the transport implementation behind a common interface so the rest
// of the app (messaging.js, server.js) is topology-agnostic. See
// docs/broker-protocol.md for the contract and the broker rollout plan.
//
// Interface:
//   init()                                  start discovery / connect
//   stop()                                  tear down
//   listPeers() -> [{owner, instanceId}]    currently reachable peers
//   findPeer({owner?, instanceId?}) -> peer|null
//   deliver(target, kind, payload) -> Promise<{ok:true} | {ok:false, error}>
//   onDeliver((from, kind, payload) => void) register the receive-side handler
//   health() -> { mode, broker, url? }       current transport status (badge)
//   setBrokerUrl(url|null)                   V7.3 — re-point the broker live
//                                            (no-op on p2p); null → discovery
export async function createTransport({ io }) {
  if (TRANSPORT === 'p2p') {
    const { createP2pTransport } = await import('./transport-p2p.js');
    return createP2pTransport({ io });
  }
  if (TRANSPORT === 'broker') {
    const { createBrokerTransport } = await import('./transport-broker.js');
    // Pure broker: emit health on connect/disconnect so the badge tracks it.
    return createBrokerTransport({
      io,
      onStatus: (broker) => io.emit('transport:health', { mode: 'broker', broker }),
    });
  }
  const { createDualTransport } = await import('./transport-dual.js');
  return createDualTransport({ io }); // default
}
