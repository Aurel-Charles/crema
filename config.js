import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// V7.4 — running version, frozen at boot. Surfaced in /me and propagated to
// peers (TXT mDNS + broker register). Pure resolver (env > git describe >
// "unknown") so it stays testable on the Mac without `.git/` or git installed.
// `CREMA_VERSION` env wins so the Docker image (which has no `.git/`) can
// inject the right version via --build-arg at build time.
export function detectVersion({ env = {}, gitDescribe = () => null } = {}) {
  const fromEnv = env.CREMA_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const fromGit = gitDescribe();
  if (typeof fromGit === 'string' && fromGit.trim()) return fromGit.trim();
  return 'unknown';
}

export const VERSION = detectVersion({
  env: process.env,
  gitDescribe: () => {
    try {
      return execSync('git describe --tags --always --dirty', {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
    } catch {
      return null;
    }
  },
});

function deriveOwnerFromHostname() {
  const h = hostname().replace(/\.local$/, '');
  const stripped = h.startsWith('pi-') ? h.slice(3) : h;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
}

export const PORT = Number(process.env.PORT ?? 3000);
export const OWNER = process.env.CREMA_OWNER ?? deriveOwnerFromHostname();
export const INSTANCE_ID = randomUUID();
export const EMBED_BROKER = process.env.CREMA_EMBED_BROKER === '1';
export const ALLOW_P2P_IN_EMBEDDED_BROKER = process.env.CREMA_ALLOW_P2P_IN_EMBEDDED_BROKER === '1';
// Opt-in (default off): add DNSServiceGetAddrInfo to the mDNS resolverSequence
// so peers.js can read the IP straight from the service record. That symbol is
// absent in libavahi-compat (the Pi build), where it throws every browse cycle
// — pure log spam with no benefit, since DNSServiceResolve already yields the
// .local host we resolve via NSS. Enable (=1) only on a real Bonjour stack.
export const MDNS_RESOLVE_ADDRESSES = process.env.CREMA_MDNS_RESOLVE_ADDRESSES === '1';

// Transport selection — see docs/broker-protocol.md.
//   dual   : broker primary + p2p fallback, both live at once (default)
//   p2p    : mDNS discovery + direct Pi-to-Pi HTTP only (broker disabled)
//   broker : Socket.IO client to a LAN broker only (no mDNS)
const _t = process.env.CREMA_TRANSPORT;
function selectTransport(value) {
  if (EMBED_BROKER && !ALLOW_P2P_IN_EMBEDDED_BROKER) return 'broker';
  if (value === 'p2p' || value === 'broker') return value;
  return 'dual';
}

export const TRANSPORT = selectTransport(_t);

// Broker URL. null = let dual mode auto-discover the broker over mDNS
// (_crema-broker._tcp). Set it explicitly (e.g. a DHCP-reserved static IP) to
// pin the primary path and skip discovery entirely — the robust choice.
// Pure broker mode falls back to localhost for Mac testing.
export const BROKER_URL = process.env.CREMA_BROKER_URL ?? null;
export const BROKER_URL_DEFAULT = 'ws://127.0.0.1:4000';
export const BROKER_TOKEN = process.env.CREMA_BROKER_TOKEN ?? null;

// mDNS service types: peers announce `_crema._tcp`, the broker announces
// `_crema-broker._tcp` so a Pi's peer browser never mistakes the broker for a peer.
export const SERVICE_TYPE = 'crema';
export const BROKER_SERVICE_TYPE = 'crema-broker';
export const SERVICE_NAME = `crema-${OWNER}-${INSTANCE_ID.slice(0, 8)}`;

// Amiens — used to compute sunrise/sunset for the day/night theme.
// Override via env if Crema gets deployed elsewhere.
export const LAT = Number(process.env.CREMA_LAT ?? 49.8941);
export const LON = Number(process.env.CREMA_LON ?? 2.2958);

export const DATA_DIR = join(__dirname, 'data');
export const REPLIES_FILE = join(DATA_DIR, 'replies.json');
export const SHORTCUTS_FILE = join(DATA_DIR, 'shortcuts.json');
export const DND_FILE = join(DATA_DIR, 'dnd.json');
// Global recipient selected on the screen — the owner that "global" shortcuts
// (those created without a pinned target) are sent to. Single-target for now.
export const DEFAULT_TARGET_FILE = join(DATA_DIR, 'default-target.json');
// V7.1 — display nickname (and room labels later). owner stays the immutable
// routing identity; this is a presentation layer propagated on top of it.
export const IDENTITY_FILE = join(DATA_DIR, 'identity.json');
// V7.3 — broker URL set from the settings page. Takes precedence over the
// CREMA_BROKER_URL env pin (systemd drop-in / pin-broker.sh), which becomes a
// mere seed; empty here = fall back to env, then mDNS discovery. Lives in data/
// so it's git-ignored and survives restarts.
export const TRANSPORT_FILE = join(DATA_DIR, 'transport.json');
// V7.4 — light/dark appearance picked from /settings. A pure presentation layer
// (CSS-variable remap), persisted per-Pi so the toggle on a phone also re-skins
// that Pi's screen. Empty/missing = 'light' (the default direction).
export const THEME_FILE = join(DATA_DIR, 'theme.json');
export const HISTORY_DB_FILE = join(DATA_DIR, 'history.db');
export const PUBLIC_DIR = join(__dirname, 'public');

export const MAX_REPLIES = 5;
export const MAX_SHORTCUTS = 6;
export const MAX_LABEL_LENGTH = 30;
export const MAX_SHORTCUT_TEXT = 200;
export const MAX_ICON_LENGTH = 8;

export const DEFAULT_REPLIES = [{ label: '👍' }, { label: 'Vu' }, { label: 'Plus tard' }];

// V4 TTL bounds — keep generous on both ends.
export const MIN_TTL_MS = 5_000;
export const MAX_TTL_MS = 24 * 3600 * 1000;
