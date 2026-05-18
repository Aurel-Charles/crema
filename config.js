import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deriveOwnerFromHostname() {
  const h = hostname().replace(/\.local$/, '');
  const stripped = h.startsWith('pi-') ? h.slice(3) : h;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
}

export const PORT = Number(process.env.PORT ?? 3000);
export const OWNER = process.env.CREMA_OWNER ?? deriveOwnerFromHostname();
export const INSTANCE_ID = randomUUID();

export const SERVICE_TYPE = 'crema';
export const SERVICE_NAME = `crema-${OWNER}-${INSTANCE_ID.slice(0, 8)}`;

// Amiens — used to compute sunrise/sunset for the day/night theme.
// Override via env if Crema gets deployed elsewhere.
export const LAT = Number(process.env.CREMA_LAT ?? 49.8941);
export const LON = Number(process.env.CREMA_LON ?? 2.2958);

export const DATA_DIR = join(__dirname, 'data');
export const REPLIES_FILE = join(DATA_DIR, 'replies.json');
export const SHORTCUTS_FILE = join(DATA_DIR, 'shortcuts.json');
export const DND_FILE = join(DATA_DIR, 'dnd.json');
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
