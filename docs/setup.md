# Setting up a new Pi

> For a Pi with a **Waveshare 3.5" HDMI touchscreen**, do this base setup first,
> then follow [`pi-desk-3.5-screen.md`](./pi-desk-3.5-screen.md) for the screen
> and touch configuration.

## Hardware

- Raspberry Pi 4B (dev) or 3B+ (works fine), any HDMI screen for now.
- Raspberry Pi OS **with desktop** (not Lite — Chromium kiosk is required).
- Set the hostname to `pi-<name>` (e.g. `pi-aurel`, `pi-flo`) via
  `raspi-config` or the Imager pre-config — the owner name is derived from
  it automatically.

## Provisioning with Ansible (recommended)

From a freshly flashed Pi (OS + Wi-Fi + SSH key) a single run from the Mac does
everything below — installs Node via nvm, clones the repo, builds the native
modules, and lays down the systemd service, kiosk autostart, screen blanking,
and the USB Wi-Fi watchdog. It's idempotent, so re-runs only fix drift.

```bash
# Add the Pi to ansible/inventory.ini (hostname, ansible_user, optional crema_screen),
# then from the repo:
cd ansible
ansible-playbook playbook.yml --ask-become-pass --limit pi-<name>
sudo reboot   # or: ssh <user>@pi-<name>.local sudo reboot — to land in the kiosk
```

See [`ansible/README.md`](../ansible/README.md) for prerequisites, tags
(`deploy` / `service` / `transport` / `display` / `watchdog` / `reload` / `reboot`)
and broker pinning.
The manual steps below are the fallback if you'd rather not use Ansible.

## Manual one-time install (alternative)

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

## Deploying code updates

From your dev machine, push to `main`, then on each Pi:

```bash
ssh <user>@pi-<name>.local "cd ~/crema && git pull && sudo systemctl restart crema"
```

Or, with Ansible: `ansible-playbook playbook.yml --ask-become-pass --tags deploy`
(git pull + npm install, on every Pi or one via `--limit`). When the code
actually changed, `deploy` then restarts the Node server **and** reloads the
Chromium kiosk, so both backend and frontend edits take effect. To force those
without a pull use `--tags reload`; to reboot the Pis one at a time use
`--tags reboot` (opt-in — never runs on a normal deploy).

If `package.json` changed, add `&& npm install` before the restart.
On 32-bit Pi OS (armv7), `better-sqlite3` compiles from source on
`npm install` — `install-pi.sh` already provisions `build-essential`
and `python3` so this just works, but the first install takes a few
minutes.

To reload the display without rebooting (kiosk has an auto-restart loop):

```bash
ssh <user>@pi-<name>.local pkill -f chromium
```

## Docker Hub image

Pushing to `main`, pushing a `v*` tag, or manually running the
`Publish Docker image` GitHub Actions workflow builds and publishes
`lowess/crema` to Docker Hub for `linux/amd64` and `linux/arm64`.
The workflow logs in as Docker Hub user `Lowess` and expects a repository
secret named `DOCKERHUB_TOKEN`.
