# Adding a Pi with a Waveshare 3.5" HDMI LCD (pi-desk)

`pi-desk` is the third Crema Pi. Its permanent screen is a **Waveshare 3.5inch
HDMI LCD (H)** — HDMI scaler (RTD2660H) for video, resistive **XPT2046** touch
controller on the SPI/GPIO header. The panel presents **800×480** over HDMI
(the scaler downscales to its physical 480×320), which happens to be Crema's
native 5:3 design size.

OS used: **Raspberry Pi OS Trixie** (Debian 13, kernel 6.12, KMS `vc4-kms-v3d`).

## 1. Video — nothing to do

The KMS driver reads the panel's EDID and auto-negotiates **800×480**. Do **not**
add `hdmi_*` lines to `config.txt` — they're ignored under KMS anyway. Plug it in
and the image is there.

## 2. Touch — one config.txt overlay

The video and touch are independent: video over HDMI, touch over SPI. Touch needs
SPI enabled and the `ads7846` overlay. Edit **`/boot/firmware/config.txt`** (note:
Trixie/Bookworm path, not `/boot/`) and add:

```ini
dtparam=spi=on
dtoverlay=ads7846,cs=1,penirq=25,penirq_pull=2,speed=50000,xohms=100,pmax=255,xmin=200,xmax=3900,ymin=200,ymax=3900
```

Reboot. `cs=1` is correct for this panel. The axes are not swapped or inverted
(verified by reading raw evdev at the four corners: X 348–3656, Y 494–3552).

### Gotcha 1 — only valid overlay params

Run `dtoverlay -h ads7846` for the authoritative parameter list. Passing an
**unknown parameter silently corrupts the line's parsing**: an early attempt with
`keep_vref_on=1` (which does not exist) left `ABS_X` max stuck at `3`, so libinput
normalised X over `[200, 3]` and produced negative coordinates — the pointer was
glued to the left edge and nothing was tappable. Symptom-check the ABS ranges with
`sudo evtest /dev/input/event8` (the header lists each axis min/max).

### Gotcha 2 — ABS_Y range not applied (minor)

On this `ads7846.dtbo`, `xmin/xmax/pmax` apply but **`ymin/ymax` do not** — `ABS_Y`
stays `0–4095`. The result is a slight vertical compression (a tap near the bottom
lands a little high). It's been tolerated as cosmetic. If it ever needs fixing, set
a libinput calibration matrix (Wayland-native, independent of the overlay bug) in
`/etc/udev/rules.d/99-crema-touch.rules`, matching `ATTRS{name}=="ADS7846
Touchscreen"` with `ENV{LIBINPUT_CALIBRATION_MATRIX}="…"` computed from the measured
corners. wlroots/labwc honours it and it corrects both axes at once.

## 3. Small-screen display profile

An 800×480 layout on a physical 3.5" panel makes every touch target ~half the mm
of a 7" screen, so a dedicated profile re-composes the same stage with larger,
sparser controls. The display auto-fits the viewport, so a browser zoom is a no-op
— hence the CSS profile rather than scaling.

Enable it **per-Pi** with a gitignored file read by `start-display.sh`:

```bash
echo sm > ~/crema/data/screen-profile
```

`start-display.sh` then launches the kiosk at `…/display?screen=sm`, which sets
`body.screen-sm`. No file (the default on the 7" Pis) keeps the standard layout.
`CREMA_SCREEN=sm` in the environment works as an alternative source.

## 4. Native npm dependency

`npm install` fails to build the native `mdns` module with
`fatal error: dns_sd.h: No such file or directory`. Install the Avahi compat
headers first (also covers `better-sqlite3`'s build tools):

```bash
sudo apt install -y libavahi-compat-libdnssd-dev build-essential python3
```

## 5. Verify

```bash
# Touch axis ranges correct? (ABS_X 200–3900, then Ctrl+C)
sudo evtest /dev/input/event8

# Kiosk loading the small-screen profile?
pgrep -af chromium | grep -oE "display[^ ]*"     # → display?screen=sm
```

Reloading the kiosk after a `git pull` (no reboot, no sudo): `pkill chromium` —
`start-display.sh`'s loop relaunches it within 3 s with the fresh page.
