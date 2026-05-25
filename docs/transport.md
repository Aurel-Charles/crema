# Transport

How a message gets from one Pi to another is abstracted behind `transport.js`,
selected by the `CREMA_TRANSPORT` env var (default **`dual`**). The full wire
protocol is in [`broker-protocol.md`](./broker-protocol.md).

| Mode | What it does | Discovery | Fallback |
|------|--------------|-----------|----------|
| **`dual`** (default) | Broker client **and** p2p stack run at once. Broker is primary, direct HTTP is the warm fallback. | Broker via mDNS (`_crema-broker._tcp`) or pinned URL; peers via mDNS | Automatic, both directions |
| **`p2p`** | Direct Pi↔Pi HTTP only (`POST /inbox`, `/reply`, `/read-receipt`, `/typing`), with retry + `.local` re-resolution. | Peers via mDNS (`_crema._tcp`) | None — relies on the avahi/mDNS stack |
| **`broker`** | Socket.IO client to a central LAN relay only. | None (central directory on the relay) | None |

- **Sending in dual** (`transport-dual.js`): broker first when connected; on
  any non-ok it logs `deliver:fallback` and routes over direct HTTP — never
  both, so no duplicate delivery. **Receiving** is dual-capable for free: the
  p2p HTTP routes and the broker's `onDeliver` callback are always wired.
- **Aggregated presence**: a peer is only marked down when *no* path can see
  it anymore. The display's bottom-left watermark reflects the live path —
  empty when the broker is healthy, otherwise `p2p · direct` or `hors-ligne`.
- **The broker** (`broker/server.js`) is a stateless relay: an `owner→socket`
  directory plus `deliver` routing, persisting nothing. Each Pi remains the
  sole owner of its own SQLite history. It's plain JS and runs anywhere
  Node does (testable on a Mac with `cd broker && npm start`).

## Switching transport on a Pi

The switch scripts drop a systemd override (`crema.service.d/transport.conf`)
without touching the base `crema.service` — fully reversible:

```bash
./pin-broker.sh ws://<broker-ip>:4000 [token]   # dual, broker pinned (skips discovery — robust)
./reset-transport.sh                            # back to default: dual + broker auto-discovery
./disable-broker.sh                             # force pure p2p (mDNS only)
./enable-broker.sh ws://<broker-ip>:4000 [token] # force pure broker (debug; no fallback)
```

Pinning the broker to a DHCP-reserved static IP is the robust choice: it skips
mDNS discovery for the primary path while keeping p2p as the fallback. Each
script finishes with a `sudo systemctl restart`, so enter the sudo password and
let it run to the end (otherwise the override is written but not loaded).

## Running the broker relay

Run this on a dedicated always-on LAN box (not a Pi), once:

```bash
git clone https://github.com/Aurel-Charles/crema.git
cd crema/broker
# Optional shared secret — Pis must then register with the same token:
CREMA_BROKER_TOKEN=s3cret ./install-broker.sh
```

`install-broker.sh` installs deps, writes/enables `crema-broker.service`, and
starts it. Verify with `curl http://localhost:4000/health` — it returns the
list of connected owners, e.g. `{"ok":true,"peers":["Aurel","Flo"]}`.

Pis on the default dual transport auto-discover the relay over mDNS — nothing
to run on them. For that, the broker box needs the optional native `mdns`
module (`sudo apt install libavahi-compat-libdnssd-dev`, then re-run
`npm install` in `broker/`); the relay works fine without it, auto-discovery
just stays off and you pin the URL on each Pi instead.
