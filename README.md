# Crema

Local LAN messenger between Raspberry Pis on always-on screens. Send a short
message from your phone (PWA) or with a one-tap shortcut on the Pi screen
itself, and it surfaces on the recipient's Pi. Each message carries its own
time-to-live that defines the sender's availability window; the recipient
sees a live countdown and can fire back a tap-friendly reply. Each Pi sits
in idle as an ambient sage clock with day/night theming, shows who else is
online on the LAN, and exposes its configured shortcuts at the bottom of the
screen.

**Current version:** [v6.4.0](https://github.com/Aurel-Charles/crema/releases/tag/v6.4.0)
— see [CLAUDE.md](./CLAUDE.md) for the full project spec and roadmap.

## What works today

- **Symmetric peer-to-peer** — identical code on every Pi, no central server,
  no single point of failure.
- **mDNS auto-discovery** — Pis find each other on the LAN automatically;
  add another Pi by flashing the same image.
- **Active health check** — each Pi pings every peer's `/me` every 10 s and
  drops the entry after 3 consecutive failures (~30 s). Catches reboots and
  power cuts that mDNS "goodbye" packets miss.
- **PWA sender** — install `http://pi-<name>.local:3000` to your phone's home
  screen, pick a recipient, send.
- **Display kiosk** — fullscreen Chromium showing clock + date + presence in
  idle, switching to incoming messages for the duration of their TTL.
- **Day/night theme** — palette transitions automatically at local sunrise
  and sunset (defaults to Amiens coordinates, overridable via
  `CREMA_LAT` / `CREMA_LON`).
- **Quick replies (V3)** — touch-friendly buttons under each incoming
  message that fire a one-tap response back to the sender. Configurable per
  Pi via `/settings` in the PWA (`👍 / Vu / Plus tard` seeded by default).
  Replies show on the sender's screen with a `↩` prefix.
- **TTL + smart defaults (V4)** — sender picks an availability window at
  send-time (`30 s / 5 min / 1 h / Ce soir / Perso…`). Default is 5 min for
  plain messages, 1 h when custom response options are attached. The
  recipient sees a live `il y a Xs · encore Ymin` subtitle plus a discreet
  progress bar.
- **Custom response options (V4)** — attach 0-5 one-shot reply buttons to a
  specific message; they override the configured quick replies for that
  message only.
- **Expiry notifications (V4)** — if your own message expires without a
  reply, your display surfaces a quiet top-left toast for 10 s.
- **Touch shortcuts on the Pi (V5)** — up to 6 preconfigured one-tap
  shortcuts at the bottom of the idle screen. Each shortcut sends a preset
  message to its assigned peer with its own TTL. Greyed out when the target
  peer is offline. Configured per Pi via the same `/settings` page (now
  "Préférences" with a Raccourcis section).
- **Reply context (V5.1)** — incoming replies show the original question as
  an italic caption above the reply, so you remember what you asked. Replies
  also auto-clear after 10 s instead of the 30 s default, since they're
  typically short acks.
- **Tap-to-dismiss (V5.1)** — tap anywhere on the screen (outside the reply
  buttons) to clear the current message and return to idle without waiting
  for the TTL.
- **Do Not Disturb (V5.1)** — toggle from the Pi (tap the moon icon
  top-right) or from `/settings` in the PWA. State is persisted server-side
  and broadcast in real time so the display and any open settings page stay
  in sync. While DND is on, incoming messages don't take over the screen;
  they stack into a queue with a brief notif preview and a count badge on
  the moon. Turning DND off drains the queue oldest-first, with a 600 ms
  breath between each.
- **Message queue (V5.1)** — if a message arrives while another is on
  screen (or during DND), it's held back instead of clobbering the current
  one. Queue is capped at 5, oldest dropped on overflow. Queued messages
  keep their actual arrival time so the `il y a Xmin` subtitle stays
  honest when they finally surface.
- **Conversation history (V6.0)** — every sent and received message is
  journaled per-Pi in `data/history.db` (SQLite, WAL mode). Browse from
  the PWA via the clock icon in the header: `/history` shows messages
  grouped by day (Aujourd'hui / Hier / full date), with direction,
  sender/recipient, time, status badge, and reply context.
- **Read receipts (V6.1)** — when the recipient's display actually shows
  your message, your `/history` page flips its badge from "en attente"
  to "vu" in real time, then to "répondu" or "expiré" as the message
  evolves. Status updates are surgical (no full refresh) and protected
  against downgrading a terminal state. New messages also appear in
  `/history` live without reload.
- **Typing indicators (V6.2)** — when a peer starts typing a message
  toward this Pi, the presence row in the display swaps `en ligne` for
  `écrit…` with subtle bouncing dots. Throttled on send (max one event
  every 3 s), auto-cleared after 5 s of silence on the receiving side.
- **Activity log (V6.3)** — every notable event (peer up/down, message
  sent / received / expired, replies, DND toggles, errors) is journaled
  to a structured `events` table in SQLite and surfaced via the
  activity-pulse icon in the PWA header. `/logs` shows a live,
  filterable timeline (`Tous / Peers / Messages / Système / Erreurs`)
  grouped by day, with category-tinted badges and surgical socket
  updates. Manual "Nettoyer > 7 jours" prunes old entries.
- **Direction Sauge (V6.4)** — full visual rework across the five
  surfaces (palette foundation, PWA history, PWA send, display idle,
  display message). See the [Design](#design) section for the system.
- **Send reliability** — retry with hostname re-resolution on transient
  avahi flakiness; stale peers dropped immediately when a new instance
  announces under the same owner; mDNS shutdown grace so the "bye" packet
  reaches peers before exit.

## Architecture

Each Pi runs the same Node process which:
- Serves the PWA (`/`), the settings page (`/settings`), and the display
  kiosk (`/display`) over Express.
- Announces itself on the LAN as `_crema._tcp` via mDNS, with `owner` and
  `instanceId` in the TXT record.
- Browses for other `_crema._tcp` services and keeps a live peer map. A
  background health check pings each peer's `/me` every 10 s to evict
  unreachable entries that mDNS missed.
- Pushes incoming messages, presence events, replies/shortcuts config
  changes, and own-message expiry notifications to the display over
  Socket.IO.

When the PWA sends, it `POST`s to its local Crema server, which generates a
message id + `expiresAt`, forwards the payload to the target peer's
`/inbox`, and starts a local expiry timer. The peer's `/inbox` broadcasts
to its own display. When the peer fires a reply via `/reply`, the payload
includes `replyToMsgId`, which lets the original sender's server clear its
expiry timer before the toast fires. Shortcut taps on the Pi go through
`/shortcut/send` which reuses the same pipeline as the PWA path.

## Design

**Direction Sauge** — the visual system shared across PWA and display.

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

## Tech stack

Node.js 20, Express, Socket.IO, [`mdns`](https://github.com/agnat/node_mdns)
(via avahi compat on Linux), [`suncalc`](https://github.com/mourner/suncalc),
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (synchronous,
WAL mode, no armv7 prebuild so it compiles from source on 32-bit Pi OS).
Frontend is vanilla HTML/CSS/JS — no framework.

Per-Pi runtime state lives in `data/` (gitignored): `replies.json` for the
quick-reply config, `shortcuts.json` for the touch shortcuts, `dnd.json`
for the Do Not Disturb flag, and `history.db` for the SQLite message
journal.

The server is split into focused modules (`config.js`, `peers.js`,
`store.js`, `messaging.js`, `db.js`) wired together by a thin `server.js`
entrypoint.

## Setting up a new Pi

### Hardware

- Raspberry Pi 4B (dev) or 3B+ (works fine), any HDMI screen for now.
- Raspberry Pi OS **with desktop** (not Lite — Chromium kiosk is required).
- Set the hostname to `pi-<name>` (e.g. `pi-aurel`, `pi-flo`) via
  `raspi-config` or the Imager pre-config — the owner name is derived from
  it automatically.

### One-time install

```bash
# 1. SSH in and install Node 20 via nvm
ssh <user>@pi-<name>.local
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20

# 2. Install the native mDNS bridge to avahi
sudo apt update
sudo apt install -y libavahi-compat-libdnssd-dev

# 3. Clone and install Crema
git clone https://github.com/Aurel-Charles/crema.git
cd crema
npm install

# 4. Wire up systemd + Chromium autostart + emoji font + disable blanking
./install-pi.sh

# 5. Reboot to confirm full boot path works
sudo reboot
```

`install-pi.sh` is idempotent and also installs `fonts-noto-color-emoji`
(Raspberry Pi OS ships without any emoji font, which makes labels like
`👍` render as empty boxes in Chromium).

After reboot the Pi should land in the kiosk display showing the clock.
The PWA is reachable from any device on the LAN at
`http://pi-<name>.local:3000`.

### Deploying code updates

From your dev machine, push to `main`, then on each Pi:

```bash
ssh <user>@pi-<name>.local "cd ~/crema && git pull && sudo systemctl restart crema"
```

If `package.json` changed, add `&& npm install` before the restart.
On 32-bit Pi OS (armv7), `better-sqlite3` compiles from source on
`npm install` — `install-pi.sh` already provisions `build-essential`
and `python3` so this just works, but the first install takes a few
minutes.

To reload the display without rebooting (kiosk has an auto-restart loop):

```bash
ssh <user>@pi-<name>.local pkill -f chromium
```

## Operating notes

- **Server logs:** `sudo journalctl -u crema -f`
- **Server status:** `sudo systemctl status crema`
- **Manual restart:** `sudo systemctl restart crema`
- **Verify mDNS announcement:** `avahi-browse _crema._tcp -tr`
  (install `avahi-utils` if missing)
- **Override location for sunrise/sunset:** set `CREMA_LAT` / `CREMA_LON` in
  `/etc/systemd/system/crema.service` under `[Service]` as `Environment=`.
- **Inspect / reset per-Pi config:** `cat ~/crema/data/replies.json` or
  `cat ~/crema/data/shortcuts.json`. Delete the file to wipe and re-seed
  (replies get the defaults back, shortcuts stay empty).
- **Inspect history:** `sqlite3 ~/crema/data/history.db "SELECT * FROM messages ORDER BY created_at DESC LIMIT 20;"`
  Or just open `/history` from the PWA. To wipe: `rm ~/crema/data/history.db*`
  (the `.db-wal` and `.db-shm` sidecars get re-created on next start).
- **Force peer re-discovery** after a long network outage: when both Pis
  recover, neither will rebroadcast its mDNS announcement spontaneously, so
  `sudo systemctl restart crema` on each clears the slate.

## Known gotchas

- **`mdns` library** is required (not `bonjour-service`) — only the mdns lib
  talks to the avahi-daemon via its DNSSD compat layer, which is what owns
  port 5353 on Raspberry Pi OS.
- **Node 18+ crash** in mdns's getaddrinfo resolver step — worked around by
  configuring `resolverSequence: [mdns.rst.DNSServiceResolve()]` and letting
  the OS resolver (avahi via NSS) handle `.local` name resolution at fetch
  time.
- **RPi Imager Wi-Fi PSK bug** — the pre-config sometimes saves a Wi-Fi
  connection without its PSK. If a fresh Pi fails to reconnect after a
  reboot:
  ```bash
  sudo nmcli --ask connection up <SSID>           # enter PSK when prompted
  sudo nmcli connection modify <SSID> connection.autoconnect yes
  sudo nmcli connection modify <SSID> 802-11-wireless.powersave 2
  ```
  The `powersave 2` (off) command is worth running preemptively on every
  fresh Pi — flaky Wi-Fi causes mDNS drops and intermittent HTTP timeouts
  that look like Crema bugs but aren't.
- **PWA caching on iOS** — after a UI update, the installed PWA may serve
  stale HTML until you fully close it from the app switcher and reopen, or
  remove and reinstall the home-screen icon.

## Repo layout

```
server.js              entrypoint: Express + Socket.IO, page routes, wiring, shutdown
config.js              env, owner derivation, paths, TTL bounds, constants
peers.js               mDNS advertise + browse, peer map, dedup, health check
store.js               atomic JSON persistence for replies, shortcuts, DND + their routes
messaging.js           pendingMessages, sendToPeer, /send /shortcut/send /reply /inbox,
                       /read-receipt, /typing, msg:status + history:new broadcasts
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
  theme.css            Direction Sauge palette + .crema-label utility (single source of truth)
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
CLAUDE.md              project spec, design, roadmap
```
