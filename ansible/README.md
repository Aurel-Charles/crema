# Crema — Ansible provisioning

One-shot provisioning of a Crema Pi, run from the Mac over SSH. Takes a Pi that was
**just flashed** (OS + Wi-Fi credentials + SSH enabled) all the way to a running
install in a **single run** — installs Node, clones the repo, builds the native
modules, and lays down everything `install-pi.sh` does. Idempotent: re-runs only
change what drifted, unlike the shell script which always restarts the service.

## What it does

A full default run, top to bottom:

| Step                          | Playbook task                          |
| ----------------------------- | -------------------------------------- |
| `apt install` build tools + curl | *Install system packages*           |
| install **nvm + Node.js 20**  | *Install nvm* / *Install Node.js 20…*  |
| clone the repo to `crema_dir` | *Clone or update the Crema repo*       |
| `npm install` (compiles native modules) | *Install npm dependencies*   |
| `chmod +x` launchers          | *Make launcher scripts executable*     |
| write `crema.service`         | *Install crema.service* (+ enable/start)|
| write autostart `.desktop`    | *Install crema-display.desktop*        |
| `raspi-config do_blanking 1`  | *Disable screen blanking*              |

Plus:
- **`wifi-watchdog-on.sh`** — installed on hosts in the `wifi_dongle` group (pi-desk).
- **V7.2 screen profile** — `crema_screen=sm` in the inventory writes
  `data/screen-profile` per Pi.

Node is installed via **nvm** (not apt), matching the proven fleet setup —
`start.sh` sources `~/.nvm` to find `node` under systemd.

## Prerequisites

- `ansible` on the Mac (`brew install ansible`).
- A Pi freshly flashed with **Raspberry Pi OS (desktop)**, Wi-Fi credentials set, and
  SSH enabled. Nothing else needs to be installed on it by hand.
- SSH key access to each Pi. Usernames differ — set in `inventory.ini`
  (`aurel@pi-aurel`, `pi@pi-slibar`, `pi@pi-desk`); verify with `ssh <user>@<host>.local true`.
- `sudo` rights. The **first** run needs a sudo password (`--ask-become-pass`);
  it installs passwordless sudo for the deploy user, so every later run — and CI
  — needs no password. See *sudo — passwordless (NOPASSWD)* below.

## Usage

```bash
cd ansible

# One-shot full install on every Pi (Node + repo + config). This is the default.
ansible-playbook playbook.yml --ask-become-pass

# Preview first (dry run)
ansible-playbook playbook.yml --ask-become-pass --check --diff

# One Pi only
ansible-playbook playbook.yml --ask-become-pass --limit pi-desk

# Update code on an already-provisioned Pi (git pull + npm install). When the
# code actually changed, this auto-restarts the Node server AND reloads the
# Chromium kiosk, so both backend and frontend edits take effect.
ansible-playbook playbook.yml --ask-become-pass --tags deploy

# Force a restart + kiosk reload without pulling (debug, or after a manual edit)
ansible-playbook playbook.yml --ask-become-pass --tags reload

# Reboot the Pis, one at a time (opt-in — never runs on a normal deploy)
ansible-playbook playbook.yml --ask-become-pass --tags reboot --limit pi-desk

# Just one slice: --tags service | transport | display | watchdog
ansible-playbook playbook.yml --ask-become-pass --tags watchdog
```

## sudo — passwordless (NOPASSWD)

The systemd/apt tasks need root. Rather than feed a sudo password to every run
(impossible unattended — that's what broke the Semaphore deploy at the *Restart
crema* handler), the playbook installs a sudoers drop-in
(`/etc/sudoers.d/010-crema-<user>`) granting the deploy user passwordless sudo.

- **Bootstrap once** (provisioning is from the Mac anyway), supplying the
  password so the drop-in can be written:

  ```bash
  # full provisioning run — installs the drop-in along the way
  ansible-playbook playbook.yml --ask-become-pass

  # or just the drop-in, on already-provisioned Pis:
  ansible-playbook playbook.yml --ask-become-pass --tags sudoers --limit pi-test,pi-desk
  ```

- **Afterwards, drop the flag** — local and CI runs escalate silently:

  ```bash
  ansible-playbook playbook.yml --tags deploy
  ```

- **Semaphore**: no become password and no vault — just remove any
  `ansible_become_password` extra-var secret from the template's Environment.

Why `NOPASSWD: ALL` and not scoped to `systemctl`: Ansible escalates a Python
interpreter as root (the AnsiballZ module wrapper), not a fixed binary, so
per-command sudoers rules don't apply to it. The grant is therefore broad — fine
for a single-purpose home-LAN Pi whose deploy user already has full sudo, but
don't copy this onto a multi-user or internet-exposed host. The file is
`visudo`-validated before install, so a syntax slip can't lock you out.

## Notes

- `crema_dir` defaults to `/home/<user>/crema` — change it in `inventory.ini` if you
  cloned elsewhere.
- **Pin a broker** (dual mode, p2p stays as fallback — the Ansible equivalent of
  `pin-broker.sh`): set `crema_broker_url` (and optionally `crema_broker_token`) on a
  host in the inventory. It writes the *same* drop-in
  `/etc/systemd/system/crema.service.d/transport.conf`, so there's a single source and
  `reset-transport.sh` still removes it. Additive — only managed when the var is set,
  never auto-removed, so a default run won't clobber a hand-pinned Pi. Scope it with
  `--tags transport`. Example:
  ```ini
  pi-aurel ansible_host=pi-aurel.local ansible_user=aurel crema_broker_url=wss://broker.example.com
  ```
- To force a different transport entirely (broker-only, no fallback), that's a separate
  thing: set `crema_env={'CREMA_TRANSPORT':'broker','CREMA_BROKER_URL':'ws://10.0.0.5:4000'}`
  — it bakes `Environment=` lines into `crema.service`. Don't mix it with `crema_broker_url`.
- The watchdog driver/iface default to `rtl8xxxu` / `wlan0`; override per group or host
  with `watchdog_driver=` / `watchdog_iface=`.
- Changing a Pi's `crema_screen` profile only takes effect after the Chromium kiosk
  relaunches (the profile is read by `start-display.sh`, not the server). The kiosk
  isn't a systemd unit, so it's reloaded with `pkill -f chromium` — the
  `start-display.sh` loop reopens it ~3s later. A `--tags deploy` does this for you
  when the code changed; otherwise force it with `--tags reload` (or `--tags reboot`).
