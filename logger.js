import * as db from './db.js';

let ioRef = null;

export function init({ io }) {
  ioRef = io;
}

export function log({ category, level = 'info', event, message, details = null }) {
  const ts = Date.now();
  const row = { ts, category, level, event, message, details };

  try {
    db.insertEvent({ ts, category, level, event, message, details });
  } catch (err) {
    // Never let logging break the host call site. Fall back to stderr.
    console.error('[logger] insert failed:', err.message);
  }

  // Mirror to stdout for journalctl. Keep formatting compact but level-aware
  // so systemd colorizes/filters correctly.
  const line = `[${category}:${event}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (ioRef) ioRef.emit('event:new', row);
}

// Convenience helpers — same signature shape, category baked in.
export const peerLog = (event, message, details, level = 'info') =>
  log({ category: 'peer', level, event, message, details });

export const msgLog = (event, message, details, level = 'info') =>
  log({ category: 'message', level, event, message, details });

export const sysLog = (event, message, details, level = 'info') =>
  log({ category: 'system', level, event, message, details });

export const errLog = (event, message, details) =>
  log({ category: 'error', level: 'error', event, message, details });
