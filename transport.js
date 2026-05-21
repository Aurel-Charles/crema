import { TRANSPORT } from './config.js';
import { createP2pTransport } from './transport-p2p.js';
import { createBrokerTransport } from './transport-broker.js';
import { createDualTransport } from './transport-dual.js';

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
//   health() -> { mode, broker }            current transport status (badge)
export function createTransport({ io }) {
  if (TRANSPORT === 'p2p') {
    return createP2pTransport({ io });
  }
  if (TRANSPORT === 'broker') {
    // Pure broker: emit health on connect/disconnect so the badge tracks it.
    return createBrokerTransport({
      io,
      onStatus: (broker) => io.emit('transport:health', { mode: 'broker', broker }),
    });
  }
  return createDualTransport({ io }); // default
}
