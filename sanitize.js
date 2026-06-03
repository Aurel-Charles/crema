import { randomUUID } from 'crypto';
import {
  MAX_REPLIES, MAX_SHORTCUTS, MAX_LABEL_LENGTH, MAX_SHORTCUT_TEXT, MAX_ICON_LENGTH,
  MIN_TTL_MS, MAX_TTL_MS,
  MAX_STATUS_PRESETS, MAX_STATUS_NOTE, STATUS_COLOR_DEFAULT,
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

// ===== Rich presence (V7.7) =====

// A status-dot colour: a #rrggbb hex, else the amber default. Kept to a closed
// shape so it's safe to drop straight into a CSS variable / inline style.
export function sanitizeColor(input, fallback = STATUS_COLOR_DEFAULT) {
  const s = typeof input === 'string' ? input.trim() : '';
  return /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
}

// Status presets catalog: array of { id, label, icon, color }. Throws on a
// non-array (the PUT route maps that to a 400), like sanitizeShortcuts. Mints
// an id when absent, dedups by id, drops items failing a field constraint,
// caps at MAX_STATUS_PRESETS.
export function sanitizeStatusPresets(input) {
  if (!Array.isArray(input)) throw new Error('Liste invalide');
  const cleaned = [];
  const seen = new Set();
  for (const item of input) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const icon = typeof item?.icon === 'string' ? item.icon.trim() : '';
    if (!label || label.length > MAX_LABEL_LENGTH) continue;
    if (icon.length > MAX_ICON_LENGTH) continue;
    const color = sanitizeColor(item?.color);
    const id = (typeof item?.id === 'string' && item.id) ? item.id : randomUUID();
    if (seen.has(id)) continue;
    seen.add(id);
    cleaned.push({ id, label, icon, color });
    if (cleaned.length >= MAX_STATUS_PRESETS) break;
  }
  return cleaned;
}

// A free note attached to a status: trimmed, truncated (not rejected) at
// MAX_STATUS_NOTE. Empty-after-trim = no note.
export function sanitizeStatusNote(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  return s.length > MAX_STATUS_NOTE ? s.slice(0, MAX_STATUS_NOTE) : s;
}

// The "until" auto-revert epoch-ms. Must be in the future; clamped to the TTL
// ceiling so a status can't be pinned for longer than a message lives. null =
// no auto-revert (manual until changed).
export function sanitizeUntil(input, now = Date.now()) {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  if (n <= now) return null;
  if (n > now + MAX_TTL_MS) return now + MAX_TTL_MS;
  return Math.floor(n);
}

// Resolve a live status from the catalog + the user's selection. The resolved
// object is what propagates to peers (label/icon/colour come from this Pi's
// catalog; note/until from the picker). Returns null = "no status set" (plain
// "en ligne"): an empty/unknown presetId, or a preset that no longer exists.
export function resolveStatus(presets, { presetId, note, until } = {}, now = Date.now()) {
  if (!presetId) return null;
  const preset = (Array.isArray(presets) ? presets : []).find((p) => p.id === presetId);
  if (!preset) return null;
  const status = {
    presetId,
    label: preset.label,
    icon: preset.icon || '',
    color: sanitizeColor(preset.color),
  };
  const n = sanitizeStatusNote(note);
  if (n) status.note = n;
  const u = sanitizeUntil(until, now);
  if (u) status.until = u;
  return status;
}

// Normalise a status received off the wire (mDNS TXT / broker) before showing
// it. Defensive: drops anything malformed, and treats an already-expired
// `until` as no status (the owner's auto-revert announce may not have arrived
// yet). Returns null or a clean { label, icon, color, note?, until? }.
export function normalizeIncomingStatus(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
  if (!label) return null;
  if (Number.isFinite(Number(input.until)) && Number(input.until) <= now) return null;
  const out = {
    label,
    icon: typeof input.icon === 'string' ? input.icon.trim().slice(0, MAX_ICON_LENGTH) : '',
    color: sanitizeColor(input.color),
  };
  const note = sanitizeStatusNote(input.note);
  if (note) out.note = note;
  const u = sanitizeUntil(input.until, now);
  if (u) out.until = u;
  return out;
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
