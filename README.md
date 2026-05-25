# Crema

Local LAN messenger between Raspberry Pis on always-on screens. Send a short
message from your phone (PWA) or with a one-tap shortcut on the Pi screen
itself, and it surfaces on the recipient's Pi. Each message carries its own
time-to-live that defines the sender's availability window; the recipient
sees a live countdown and can fire back a tap-friendly reply. Each Pi sits
in idle as an ambient sage clock with day/night theming, shows who else is
online on the LAN, and exposes its configured shortcuts at the bottom of the
screen.

**Releases:** [github.com/Aurel-Charles/crema/releases](https://github.com/Aurel-Charles/crema/releases)

## What works today

- **Symmetric peer-to-peer** — identical code on every Pi; add another by
  flashing the same image and it's discovered automatically.
- **Dual transport (default)** — a broker client and the p2p stack run at
  once: broker primary, direct Pi-to-Pi HTTP as the warm fallback, automatic
  failover both ways. Pure-p2p and pure-broker modes also exist. See
  [`docs/transport.md`](./docs/transport.md).
- **mDNS auto-discovery + active health check** — Pis (and the broker) find
  each other on the LAN; each Pi pings every peer's `/me` every 10 s and drops
  it after 3 misses, catching reboots and power cuts mDNS goodbyes miss.
- **PWA sender** — install `http://pi-<name>.local:3000` to your phone, pick a
  recipient, send.
- **Display kiosk + day/night theme** — fullscreen Chromium: clock, date and
  presence in idle, incoming messages for their TTL; palette shifts at local
  sunrise/sunset (`CREMA_LAT` / `CREMA_LON`).
- **Quick replies & custom response options** — tap-friendly reply buttons
  under each message, configurable per Pi, optionally overridden per-message.
- **TTL + smart defaults** — sender picks an availability window
  (`30 s / 5 min / 1 h / Ce soir / Perso…`); recipient sees a live
  `il y a Xs · encore Ymin` subtitle and a progress bar.
- **Touch shortcuts on the Pi** — up to 6 one-tap preset messages on the idle
  screen, greyed out when the target peer is offline.
- **Do Not Disturb + message queue** — DND stacks incoming messages instead of
  taking over the screen; the queue is capped, preserves arrival times, and
  drains oldest-first when DND clears.
- **History, read receipts, typing & activity log** — every message journaled
  per-Pi in SQLite; `/history` shows status (en attente → vu → répondu/expiré)
  live, the display swaps `en ligne` for `écrit…` while a peer types, and
  `/logs` is a filterable event timeline.
- **Direction Mirage** — a shared sunset visual system (coral accent, Currents
  rainbow signature) across PWA and display. See
  [`docs/architecture.md`](./docs/architecture.md#design--direction-mirage).
- **Small-screen profile** — a dedicated layout for physically tiny panels
  (e.g. a 3.5" touchscreen). See [`docs/pi-desk-3.5-screen.md`](./docs/pi-desk-3.5-screen.md).

## Quick start

| Task | Command |
|------|---------|
| Set up a new Pi | see [`docs/setup.md`](./docs/setup.md) |
| Update a Pi | `cd ~/crema && git pull && sudo systemctl restart crema` |
| Reload the display only | `pkill -f chromium` (the kiosk auto-restarts) |
| Switch transport | `./pin-broker.sh` · `./reset-transport.sh` · `./disable-broker.sh` ([transport](./docs/transport.md)) |
| Run the broker relay | `cd broker && ./install-broker.sh` ([transport](./docs/transport.md)) |
| Server logs / status | `sudo journalctl -u crema -f` · `sudo systemctl status crema` |

## Docs

- [`setup.md`](./docs/setup.md) — install a new Pi, deploy updates, Docker image.
- [`transport.md`](./docs/transport.md) — the three transport modes, switching, running the broker relay.
- [`broker-protocol.md`](./docs/broker-protocol.md) — the broker wire protocol (register / deliver / presence).
- [`architecture.md`](./docs/architecture.md) — how it's built, tech stack, and the Direction Mirage design system.
- [`operations.md`](./docs/operations.md) — day-to-day operating notes and known gotchas.
- [`pi-desk-3.5-screen.md`](./docs/pi-desk-3.5-screen.md) — Waveshare 3.5" HDMI touchscreen setup.

## Repo layout

```
server.js              entrypoint: Express + Socket.IO, page routes, wiring, shutdown
config.js              env, owner derivation, paths, TTL bounds, constants
transport.js           transport selector — picks dual/p2p/broker from CREMA_TRANSPORT
transport-dual.js      composite: broker primary + p2p fallback, presence aggregation (default)
transport-p2p.js       direct Pi↔Pi HTTP (wraps peers.js); retry + .local re-resolution
transport-broker.js    Socket.IO client to the LAN relay
discover-broker.js     mDNS discovery of the broker (_crema-broker._tcp) on the Pi
peers.js               mDNS advertise + browse, peer map, dedup, health check (p2p path)
store.js               atomic JSON persistence for replies, shortcuts, DND + their routes
messaging.js           pendingMessages, send pipeline, /send /shortcut/send /reply /inbox,
                       /read-receipt, /typing, inbound dispatch, msg:status + history:new
db.js                  SQLite history (better-sqlite3, WAL): insert/update/group-by-day
logger.js              structured event log: writes to events table, mirrors to
                       stdout, broadcasts 'event:new' over Socket.IO
public/
  index.html           PWA sender (target / message / response options / TTL / typing)
  settings.html        PWA Préférences (DND toggle + replies + shortcuts editor)
  history.html         PWA history page (grouped by day, live status updates)
  logs.html            PWA activity log (filterable timeline grouped by day, live)
  display.html         Pi kiosk (clock, message, queue, DND moon, replies, shortcuts,
                       presence + typing indicator)
  theme.css            Direction Mirage palette + .crema-label utility (single source of truth)
  manifest.json        PWA manifest
  service-worker.js    minimal SW to enable PWA install
  icon.svg
data/                  per-Pi runtime state (gitignored)
  replies.json         configured quick replies
  shortcuts.json       configured touch shortcuts
  dnd.json             Do Not Disturb flag
  history.db           SQLite message journal (sent + received)
start.sh               wraps `node server.js` with nvm sourcing
start-display.sh       Chromium kiosk launcher with restart loop
install-pi.sh          one-shot Pi setup (systemd + autostart + emoji + blanking + build tools)
pin-broker.sh          transport switch: dual + broker pinned to a URL (p2p fallback kept)
reset-transport.sh     transport switch: back to default dual + broker auto-discovery
disable-broker.sh      transport switch: force pure p2p (mDNS only)
enable-broker.sh       transport switch: force pure broker (debug, no fallback)
broker/
  server.js            stateless LAN relay: owner→socket registry + deliver routing + /health
  install-broker.sh    one-shot broker setup on a dedicated box (crema-broker.service)
  start-broker.sh      wraps `node server.js` with nvm sourcing
  test-protocol.mjs    standalone protocol smoke test against a running broker
docs/                  setup, transport, broker protocol, architecture, operations, 3.5" screen
```
