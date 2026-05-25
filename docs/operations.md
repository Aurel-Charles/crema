# Operating notes

- **Server logs:** `sudo journalctl -u crema -f`
- **Server status:** `sudo systemctl status crema`
- **Manual restart:** `sudo systemctl restart crema`
- **Verify mDNS announcement:** `avahi-browse _crema._tcp -tr`
  (install `avahi-utils` if missing); the broker advertises `_crema-broker._tcp`.
- **Which transport path is live:** glance at the display's bottom-left
  watermark (empty = broker healthy), or grep the logs for `deliver:fallback`.
  Confirm the broker sees both Pis: `curl http://<broker-ip>:4000/health`.
- **Switch transport:** `./pin-broker.sh`, `./reset-transport.sh`,
  `./disable-broker.sh`, `./enable-broker.sh` — see [`transport.md`](./transport.md).
- **Broker logs/status:** `sudo journalctl -u crema-broker -f` /
  `sudo systemctl status crema-broker` (on the broker box, not the Pi).
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
