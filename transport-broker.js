// Broker transport — NOT YET IMPLEMENTED.
//
// This is step 3 of the implementation plan in docs/broker-protocol.md: a
// Socket.IO *client* connecting to CREMA_BROKER_URL, registering this Pi's
// identity, mirroring the broker's peer:up/peer:down into the local io, and
// translating deliver/onDeliver to the broker's events.
//
// The stub throws on construction so an accidental CREMA_TRANSPORT=broker
// fails loudly with a pointer, rather than silently doing nothing.

export function createBrokerTransport(/* { io } */) {
  throw new Error(
    'CREMA_TRANSPORT=broker is not implemented yet (see docs/broker-protocol.md). '
    + 'Unset it or use CREMA_TRANSPORT=p2p.',
  );
}
