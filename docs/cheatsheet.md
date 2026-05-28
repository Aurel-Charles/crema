# Cheatsheet

One-glance reference for the commands that come up most often. For the
*why* behind each (and the gotchas), see
[`operations.md`](./operations.md), [`transport.md`](./transport.md), and
[`setup.md`](./setup.md).

Placeholders used below: `<user>` is the Pi's SSH user (varies — see the
[`pi-ssh-usernames` memory](../CLAUDE.md)), `<pi>` is the hostname
(`pi-aurel.local`, etc.) or a static IP, `<owner>` is the Pi's owner name
(`Aurel`, `Slibar`, `Desk`, `Test`, `Flo`).

## On one Pi (SSH)

```bash
# Live logs / status / restart the server
sudo journalctl -u crema -f
sudo systemctl status crema
sudo systemctl restart crema

# Reload only the kiosk (server keeps running)
pkill -f chromium       # the start-display.sh loop reopens it ~3 s later

# Reboot the Pi
sudo reboot
```

## Deploy from the Mac (Ansible)

```bash
cd ansible

# Provision a brand-new Pi (Node + clone + service + kiosk + watchdog)
ansible-playbook playbook.yml --ask-become-pass --limit pi-<name>

# Update an existing Pi: git pull + restart server + reload kiosk
# (auto-reloads kiosk ONLY when the code actually changed)
ansible-playbook playbook.yml --tags deploy

# Force a restart + kiosk reload, even if code is already up to date
ansible-playbook playbook.yml --tags reload

# Reboot the Pis one at a time (opt-in)
ansible-playbook playbook.yml --tags reboot

# (Re)pin or unpin the broker URL via inventory
ansible-playbook playbook.yml --tags transport

# (Re)install the NOPASSWD sudo drop-in (after a fresh SSH bootstrap)
ansible-playbook playbook.yml --tags sudoers --ask-become-pass
```

Targeting a subset: append `--limit pi-test` or `--limit 'pi-test,pi-desk'`.

The same playbook is what the **Semaphore** CI runner executes — same tags,
same inventory.

## Inspect a running fleet

```bash
# Which version is each Pi running? (V7.4)
curl -s http://<pi>:3000/me | jq .version

# Same, fan-out across the LAN
for h in pi-aurel.local pi-slibar.local pi-desk.local 192.168.1.198; do
  echo -n "$h: "
  curl -s -m 2 "http://$h:3000/me" | jq -r '.owner + " · " + (.version // "?")' \
    2>/dev/null || echo "offline"
done

# What does this Pi see as peers? (instanceId, owner, nickname, version)
curl -s http://<pi>:3000/peers | jq

# Broker health — full roster with versions (V7.4 shape)
curl -s https://crema-broker.cloud.110lab.fr/health | jq

# Message history (raw, last 20)
sqlite3 ~/crema/data/history.db \
  "SELECT created_at, direction, owner_other, status, substr(text,1,40) \
   FROM messages ORDER BY created_at DESC LIMIT 20;"
# Or open /history in the PWA.
```

## Transport switch (drop-in systemd, reversible)

Run on the Pi, in `~/crema`:

```bash
./pin-broker.sh ws://<ip>:4000 [token]   # dual + broker pinned (skip discovery)
./reset-transport.sh                      # back to default: dual + discovery
./disable-broker.sh                       # force p2p only
./enable-broker.sh ws://<ip>:4000 [token] # force broker only (debug)
```

The broker URL is also editable live from `/settings` (V7.3) — UI override
wins over the env pin.

## Per-Pi data files (under `~/crema/data/`)

```bash
# Inspect
cat ~/crema/data/replies.json        # quick replies
cat ~/crema/data/shortcuts.json      # screen shortcuts
cat ~/crema/data/identity.json       # owner + nickname (V7.1)
cat ~/crema/data/transport.json      # broker URL override (V7.3)
cat ~/crema/data/dnd.json            # do-not-disturb state
cat ~/crema/data/theme.json          # light/dark appearance

# Reset (delete → re-seeded with defaults on next start)
rm ~/crema/data/replies.json         # quick replies fall back to defaults
rm ~/crema/data/history.db*          # wipe history (.db-wal/.db-shm too)
```

## Display only (kiosk)

```bash
# Inside ~/crema, run the kiosk loop manually (normally systemd does it)
./start-display.sh

# Force-close Chromium — the loop relaunches it ~3 s later
pkill -f chromium
```

## USB Wi-Fi dongle watchdog (pi-desk)

```bash
cd ~/crema
./wifi-watchdog-on.sh           # install + start the systemd watchdog
./wifi-watchdog-off.sh          # remove it
sudo systemctl status crema-wifi-watchdog
sudo journalctl -u crema-wifi-watchdog -f
```

Override defaults with `WATCHDOG_DRIVER=…` / `WATCHDOG_IFACE=…` before
calling `wifi-watchdog-on.sh`. See [`usb-wifi-dongle.md`](./usb-wifi-dongle.md).

## Broker (LAN relay)

Only relevant if you run a standalone LAN broker (not the cloud broker).

```bash
# Install the broker as a systemd service
cd broker && ./install-broker.sh

# Manage it
sudo systemctl status crema-broker
sudo systemctl restart crema-broker
sudo journalctl -u crema-broker -f

# Run the broker protocol regression test (Mac OK — no native deps)
cd broker && node test-protocol.mjs
```

## mDNS / network sanity

```bash
# Are the Pis announcing themselves? (install avahi-utils if missing)
avahi-browse _crema._tcp -tr

# Is the broker announcing itself?
avahi-browse _crema-broker._tcp -tr

# Resolve a .local hostname to an IP from another machine
ping pi-test.local

# After a long network outage, force re-discovery — neither Pi
# re-broadcasts spontaneously. Restart on each clears the slate:
sudo systemctl restart crema
```

## Stability soak test

Long-running probing harness (cross-Pi `/me`, mDNS, temp/load/Wi-Fi).
Output: JSONL in `./logs/stability-<host>-<date>.jsonl`.

```bash
# Run for hours, detached, on each Pi
TERM=xterm-256color tmux new -d -s stab 'npm run stability-test'

# Attach to watch it
tmux attach -t stab

# Stop cleanly (triggers a final summary)
tmux send-keys -t stab C-c

# Detect a Pi reboot during a run
journalctl --list-boots
last -x | grep reboot
```

The `TERM=` prefix is the workaround for the
[ghostty SSH tmux glitch](../CLAUDE.md).

## Tests on the Mac

```bash
npm test                                 # unit tests (sanitize, version)
cd broker && node test-protocol.mjs      # broker wire protocol regression
```

Everything that touches `mdns` or `better-sqlite3` only runs on a Pi.

## Common troubleshooting one-liners

```bash
# PWA showing stale state after an upgrade
# → in the browser: Cmd+Shift+R (Chrome/Brave). On iOS PWA: close from
#   app-switcher and reopen, or remove + reinstall the home-screen icon.

# A peer shows "?" as version even though it runs V7.4+
# → the path between the peers has an old broker that strips the field.
#   Check the broker shape: curl https://…/health | jq
#   If broker is V7.4 too, hard refresh the PWA — it's a stale JS state.

# Pi just rebooted — was it a crash or a power blip?
journalctl --list-boots

# fresh Pi after RPi Imager: Wi-Fi reconnects without PSK
sudo nmcli --ask connection up <SSID>
sudo nmcli connection modify <SSID> connection.autoconnect yes
sudo nmcli connection modify <SSID> 802-11-wireless.powersave 2
```
