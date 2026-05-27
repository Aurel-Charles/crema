import { randomUUID } from 'crypto';
import {
  MAX_REPLIES, MAX_SHORTCUTS, MAX_LABEL_LENGTH, MAX_SHORTCUT_TEXT, MAX_ICON_LENGTH,
  MIN_TTL_MS, MAX_TTL_MS,
} from './config.js';

// Pure input-sanitisation helpers, extracted from store.js and messaging.js so
// they can be unit-tested in isolation. This module imports only config.js
// (constants, no I/O) and crypto — deliberately no db.js / mdns / socket.io —
// so the tests run anywhere, including the dev Mac where the native deps
// (better-sqlite3, mdns) don't build. Behaviour is identical to the originals.

export function clampTtl(ttl) {
  const n = Number(ttl);
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, n));
}

// Quick replies (V3): array of { label }. Throws on a non-array (the PUT route
// maps that to a 400). Trims, drops empties/over-length, dedups by label, caps
// at MAX_REPLIES.
export function sanitizeReplies(input) {
  if (!Array.isArray(input)) throw new Error('Liste invalide');
  const cleaned = [];
  const seen = new Set();
  for (const item of input) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    cleaned.push({ label });
    if (cleaned.length >= MAX_REPLIES) break;
  }
  return cleaned;
}

// Response options attached to an outgoing message (V4). Like sanitizeReplies
// but lenient on shape: a non-array yields [] (not a throw) and items may be a
// bare string or { label }. Same trim/dedup/cap rules.
export function sanitizeResponseOptions(input) {
  if (!Array.isArray(input)) return [];
  const cleaned = [];
  const seen = new Set();
  for (const item of input) {
    const label = typeof item === 'string'
      ? item.trim()
      : (typeof item?.label === 'string' ? item.label.trim() : '');
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    cleaned.push({ label });
    if (cleaned.length >= MAX_REPLIES) break;
  }
  return cleaned;
}

// Send shortcuts (V5): { id, label, icon, text, targetOwner, ttlMs }. Throws on
// a non-array. Drops items failing any field constraint; mints an id when one
// isn't supplied. Empty targetOwner is allowed (= "global" shortcut, routed to
// the current global recipient at send time). Caps at MAX_SHORTCUTS.
export function sanitizeShortcuts(input) {
  if (!Array.isArray(input)) throw new Error('Liste invalide');
  const cleaned = [];
  for (const item of input) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const icon = typeof item?.icon === 'string' ? item.icon.trim() : '';
    const targetOwner = typeof item?.targetOwner === 'string' ? item.targetOwner.trim() : '';
    const ttlMs = clampTtl(item?.ttlMs);
    if (!label || label.length > MAX_LABEL_LENGTH) continue;
    if (!text || text.length > MAX_SHORTCUT_TEXT) continue;
    if (targetOwner.length > MAX_LABEL_LENGTH) continue;
    if (!ttlMs) continue;
    if (icon.length > MAX_ICON_LENGTH) continue;
    const id = (typeof item?.id === 'string' && item.id) ? item.id : randomUUID();
    cleaned.push({ id, label, icon, text, targetOwner, ttlMs });
    if (cleaned.length >= MAX_SHORTCUTS) break;
  }
  return cleaned;
}

// Display nickname (V7.1): trimmed, hard-capped at MAX_LABEL_LENGTH (truncated,
// not rejected). Empty-after-trim = not set.
export function sanitizeNickname(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  return s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH) : s;
}

// Global recipient owner picked on the screen: trimmed; an over-length value is
// treated as unset ('') rather than truncated, since it must match a real owner.
export function sanitizeTarget(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  return s.length > MAX_LABEL_LENGTH ? '' : s;
}

// Light/dark appearance (V7.4): a closed set, so anything that isn't the exact
// string 'dark' collapses to 'light'. Keeps the persisted file and the DOM
// attribute to two known values.
export function sanitizeTheme(input) {
  return input === 'dark' ? 'dark' : 'light';
}

// Broker URL set from the settings page (V7.3). Tri-state so the PUT route can
// tell "clear the override" apart from "rejected":
//   ''     → empty/whitespace = clear the override (fall back to env, then mDNS)
//   string → a valid ws:// or wss:// URL, normalised (lone trailing slash dropped)
//   null   → invalid (unparseable, or not a ws/ws scheme) → caller answers 400
export function sanitizeBrokerUrl(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  if (!u.hostname) return null;
  const path = u.pathname === '/' ? '' : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}
