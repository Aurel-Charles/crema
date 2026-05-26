# Crema — Ansible provisioning

Ansible equivalent of `install-pi.sh`, run from the Mac against the Pis over SSH.
Idempotent: re-runs only change what drifted, unlike the shell script which always
restarts the service.

## What it does

| install-pi.sh step            | Playbook task                          |
| ----------------------------- | -------------------------------------- |
| `apt install` build tools     | *Install system packages*              |
| `chmod +x` launchers          | *Make launcher scripts executable*     |
| write `crema.service`         | *Install crema.service* (+ enable/start)|
| write autostart `.desktop`    | *Install crema-display.desktop*        |
| `raspi-config do_blanking 1`  | *Disable screen blanking*              |
| `fonts-noto-color-emoji`      | (in *Install system packages*)         |

Plus, beyond the script:
- **`--tags deploy`** — `git pull` the repo + `npm install` (assumes Node/nvm already
  present, like the script does). Off by default (`never` tag).
- **`wifi-watchdog-on.sh`** — installed on hosts in the `wifi_dongle` group (pi-desk).
- **V7.2 screen profile** — `crema_screen=sm` in the inventory writes
  `data/screen-profile` per Pi.

## Prerequisites

- `ansible` on the Mac (`brew install ansible`).
- SSH key access to each Pi. Usernames differ — set in `inventory.ini`
  (`aurel@pi-aurel`, `flo@pi-slibar`, …); verify with `ssh <user>@<host>.local true`.
- `sudo` rights. pi-desk needs a sudo password → pass `--ask-become-pass`.

## Usage

```bash
cd ansible

# Dry run (preview changes)
ansible-playbook playbook.yml --ask-become-pass --check --diff

# Full install on every Pi
ansible-playbook playbook.yml --ask-become-pass

# One Pi only
ansible-playbook playbook.yml --ask-become-pass --limit pi-desk

# Deploy code too (git pull + npm install), then re-apply config
ansible-playbook playbook.yml --ask-become-pass --tags deploy,service,display

# Just the Wi-Fi watchdog (pi-desk)
ansible-playbook playbook.yml --ask-become-pass --tags watchdog
```

## Notes

- `crema_dir` defaults to `/home/<user>/crema` — change it in `inventory.ini` if you
  cloned elsewhere.
- To pin a broker (instead of dual auto-discovery), set `crema_env` for a host, e.g.
  `crema_env={'CREMA_TRANSPORT':'broker','CREMA_BROKER_URL':'ws://10.0.0.5:4000'}` —
  it becomes `Environment=` lines in the unit. The dedicated `pin-broker.sh` /
  `reset-transport.sh` drop-ins still work and are independent of this.
- The watchdog driver/iface default to `rtl8xxxu` / `wlan0`; override per group or host
  with `watchdog_driver=` / `watchdog_iface=`.
