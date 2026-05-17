# Crema

Local LAN messenger between Raspberry Pis on always-on screens. Send a short
message from your phone (PWA) and it surfaces on the recipient's Pi screen,
auto-clearing after 30s. Each Pi sits in idle as an ambient amber clock with
day/night theming and shows who else is online on the LAN.

**Current version:** [v2.0.0](https://github.com/Aurel-Charles/crema/releases/tag/v2.0.0)
— see [CLAUDE.md](./CLAUDE.md) for the full project spec and roadmap.

## What works today (V2)

- **Symmetric peer-to-peer** — identical code on every Pi, no central server,
  no single point of failure.
- **mDNS auto-discovery** — Pis find each other on the LAN automatically;
  add another Pi by flashing the same image.
- **PWA sender** — install `http://pi-<name>.local:3000` to your phone's home
  screen, pick a recipient, send.
- **Display kiosk** — fullscreen Chromium showing clock + date + presence in
  idle, switching to incoming messages for 30s.
- **Day/night theme** — palette transitions automatically at local sunrise
  and sunset (defaults to Amiens coordinates, overridable via
  `CREMA_LAT` / `CREMA_LON`).
- **Send reliability** — retry with hostname re-resolution on transient
  avahi flakiness; stale peers dropped immediately when a new instance
  announces under the same owner.

## Architecture

Each Pi runs the same Node process which:
- Serves the PWA (`/`) and the display kiosk (`/display`) over Express.
- Announces itself on the LAN as `_crema._tcp` via mDNS, with `owner` and
  `instanceId` in the TXT record.
- Browses for other `_crema._tcp` services and keeps a live peer map.
- Pushes incoming messages and presence events to the display over
  Socket.IO.

When the PWA sends, it `POST`s to its local Crema server, which forwards
the payload to the target peer's `/inbox`, which broadcasts to its own
display via Socket.IO.

## Tech stack

Node.js 20, Express, Socket.IO, [`mdns`](https://github.com/agnat/node_mdns)
(via avahi compat on Linux), [`suncalc`](https://github.com/mourner/suncalc).
Frontend is vanilla HTML/CSS/JS — no framework.

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

# 4. Wire up systemd + Chromium autostart + disable screen blanking
./install-pi.sh

# 5. Reboot to confirm full boot path works
sudo reboot
```

After reboot the Pi should land in the kiosk display showing the clock.
The PWA is reachable from any device on the LAN at
`http://pi-<name>.local:3000`.

### Deploying code updates

From your dev machine, push to `main`, then on each Pi:

```bash
ssh <user>@pi-<name>.local "cd ~/crema && git pull && sudo systemctl restart crema"
```

If `package.json` changed, add `&& npm install` before the restart.

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

## Repo layout

```
server.js              Express + Socket.IO + mDNS
public/
  index.html           PWA sender
  display.html         Pi kiosk display
  manifest.json        PWA manifest
  service-worker.js    minimal SW to enable PWA install
  icon.svg
start.sh               wraps `node server.js` with nvm sourcing
start-display.sh       Chromium kiosk launcher with restart loop
install-pi.sh          one-shot Pi setup (systemd + autostart + blanking)
CLAUDE.md              project spec, design, roadmap
```
