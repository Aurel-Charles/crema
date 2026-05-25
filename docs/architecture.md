# Architecture & design

## Architecture

Each Pi runs the same Node process which:
- Serves the PWA (`/`), the settings page (`/settings`), and the display
  kiosk (`/display`) over Express.
- Sends and receives messages through a swappable **transport** seam
  (`transport.js`) — see [`transport.md`](./transport.md) for the three modes.
- Pushes incoming messages, presence events, replies/shortcuts config
  changes, and own-message expiry notifications to the display over
  Socket.IO.

When the PWA sends, it `POST`s to its local Crema server, which generates a
message id + `expiresAt`, hands the payload to the transport for delivery to
the target peer, and starts a local expiry timer. On the recipient, inbound
messages broadcast to its own display. When the peer fires a reply, the
payload includes `replyToMsgId`, which lets the original sender's server
clear its expiry timer before the "expired" toast fires. Shortcut taps on the
Pi go through `/shortcut/send` which reuses the same pipeline as the PWA path.

The server is split into focused modules (`config.js`, `peers.js`,
`store.js`, `messaging.js`, `db.js`) wired together by a thin `server.js`
entrypoint. Delivery sits behind the `transport.js` seam with one
implementation per mode (`transport-dual.js`, `transport-p2p.js`,
`transport-broker.js`) plus `discover-broker.js` for mDNS broker discovery.

Per-Pi runtime state lives in `data/` (gitignored): `replies.json` for the
quick-reply config, `shortcuts.json` for the touch shortcuts, `dnd.json`
for the Do Not Disturb flag, and `history.db` for the SQLite message journal.

## Tech stack

Node.js 20, Express, Socket.IO (display push + broker transport),
[`socket.io-client`](https://github.com/socketio/socket.io) (Pi → broker),
[`mdns`](https://github.com/agnat/node_mdns) (via avahi compat on Linux —
peer and broker discovery), [`suncalc`](https://github.com/mourner/suncalc),
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (synchronous,
WAL mode, no armv7 prebuild so it compiles from source on 32-bit Pi OS).
Frontend is vanilla HTML/CSS/JS — no framework. The broker relay (`broker/`)
is a standalone Node + Socket.IO process with no native deps beyond an
optional `mdns` for self-advertisement.

## Design — Direction Sauge

The visual system shared across PWA and display.

- **Palette** in `public/theme.css` is the single source of truth. PWA
  runs light (`#F6F8F4`); display runs dark warm-green (`#121711`). Both
  share the sage accent `#A8C49C` — the "living color" reserved for the
  primary action (PWA send button), the active state of TTL presets and
  recipient buttons, the resting clock on the display, and the "sent"
  state of reply buttons. Warm gold `#C9A86A` is reserved for the lone
  `en attente` status badge in `/history`: scarcity is what earns it
  visual weight.
- **Typographic signature** — `.crema-label` (uppercase, 0.25em kerned)
  marks every identity surface: section labels in the PWA send form,
  day headers in `/history`, sender labels on the display, presence
  names, and the date below the clock. Mono is reserved for per-message
  direction marks — the `A → F` initials in `/history` and the peer
  initials in the segmented recipient picker.
- **Recipient picker** scales with peer count: a segmented control
  (mono initial + name) for 1–4 peers, falling back to a `<select>`
  beyond that.
