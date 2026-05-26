# Using a USB Wi-Fi dongle (and the rtl8xxxu watchdog)

Most Crema Pis use their **built-in Wi-Fi** and need nothing here. A Pi without
usable onboard Wi-Fi (e.g. `pi-desk`) runs a **USB Wi-Fi dongle** instead — and
some of those dongles, the Realtek ones in particular, drop off the bus after a
few hours and need a physical unplug/replug. This page explains the failure and
the `wifi-watchdog-on.sh` / `wifi-watchdog-off.sh` scripts that automate the
recovery.

## The symptom

The dongle works for hours, then the Pi silently goes offline. Replugging it
physically restores everything until the next time. `dmesg` shows the dongle's
MAC controller hanging, then the kernel dropping it:

```
usb 1-1.4: rtl8192eu_active_to_emu: Disabling MAC timed out
usb 1-1.4: disconnecting
```

This is a known bug in the **in-kernel `rtl8xxxu` driver** on the **RTL8192EU**
chip (the TP-Link TL-WN823N v2/v3 on `pi-desk`). The chip freezes — typically
during idle — and the driver can't recover it on its own (`authentication timed
out` on every retry). Only a fresh USB enumeration brings it back.

### It is *not* a power problem (rule it out, but don't stop there)

A USB dongle that disconnects is often under-voltage, so check it first:

```bash
vcgencmd get_throttled
```

`0x0` = clean. Any non-zero value means under-voltage *occurred* — but **correlate
its timestamp with the drop** before blaming the PSU. On `pi-desk` the
under-voltage events were boot-only (inrush at 26–76 s after boot, then `Voltage
normalised`) and **decorrelated** from the Wi-Fi drop hours later, so a better
cable would not have fixed the dropout. Confirm by comparing kernel timestamps:

```bash
dmesg | grep -iE 'voltage|hwmon'         # when did under-voltage happen?
dmesg | grep -iE 'wlan0|disconnect|rtl'  # when did the dongle drop?
```

If the under-voltage lines line up with the disconnects, fix the power (short,
thick cable; official 5.1 V PSU; or move the dongle to a powered USB hub) and
stop here. If they don't, it's the driver — read on.

Also confirm Wi-Fi power-save isn't the culprit (it usually isn't once
NetworkManager is set up): `iw dev wlan0 get power_save` should say `off`.

## The fix: an auto-recovery watchdog

`wifi-watchdog-on.sh` installs a small systemd service (`wifi-watchdog.service`)
that does the physical replug in software:

1. Pings the default gateway every **30 s**.
2. After **3** consecutive failures (~90 s), tries a soft `nmcli` reconnect.
3. If still down, **reloads the dongle's kernel module** (`modprobe -r` /
   `modprobe`) — a full re-enumeration, equivalent to the replug — and lets
   NetworkManager reconnect.

Every step is logged to journald. The periodic ping also doubles as a keepalive
that can stave off the idle hang in the first place.

```bash
cd ~/crema
./wifi-watchdog-on.sh      # install, start, enable at boot (asks for sudo)
./wifi-watchdog-off.sh     # stop and remove everything (reversible)
```

The service is `enabled`, so it survives reboots until you run the `off` script.

### Another dongle / interface

Defaults target `rtl8xxxu` on `wlan0`. Override at install time:

```bash
WATCHDOG_DRIVER=mt7601u WATCHDOG_IFACE=wlan1 ./wifi-watchdog-on.sh
```

Find your chip and driver with `lsusb` and `lsmod | grep -iE '8192|8xxxu|rtl|mt7'`.

## Reading the verdict

```bash
journalctl -u wifi-watchdog --no-pager | grep -iE 'recover|down'
```

- `recovered via soft reconnect` / `recovered via module reload` — the watchdog
  caught a drop and brought the link back on its own. No more manual replug.
- `STILL DOWN after module reload` — the module reload didn't help, meaning a
  true electrical disconnect the software can't re-enumerate. Escalate to the
  plan B below.

On `pi-desk` the verdict was `recovered via module reload` (~30 s outage on the
first night's drop), so the watchdog alone is enough there.

## Plan B — replace the driver (only if the watchdog can't recover)

If you see `STILL DOWN after module reload`, swap the flaky in-kernel driver for
Realtek's out-of-tree **`8192eu` DKMS** driver, which is more stable on the
RTL8192EU and re-enables proper power management:

1. Install build tooling + headers: `sudo apt install -y dkms git build-essential raspberrypi-kernel-headers`
2. Build/install an `8192eu` DKMS driver (e.g. the community `rtl8192eu-linux-driver`).
3. Blacklist the in-kernel one: `echo 'blacklist rtl8xxxu' | sudo tee /etc/modprobe.d/blacklist-rtl8xxxu.conf`
4. Disable its power management: `echo 'options 8192eu rtw_power_mgnt=0 rtw_enusbss=0' | sudo tee /etc/modprobe.d/8192eu.conf`
5. Reboot. DKMS rebuilds the module automatically on future kernel updates.

This is the root-cause fix but heavier to maintain, hence kept as a fallback.

## Verify

```bash
sudo systemctl status wifi-watchdog --no-pager   # active (running), enabled
iw dev wlan0 get power_save                       # Power save: off
journalctl -u wifi-watchdog --no-pager | tail     # a "started …" line, no errors
```
