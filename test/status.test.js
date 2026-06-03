import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeColor, sanitizeStatusPresets, sanitizeStatusNote, sanitizeUntil,
  resolveStatus, normalizeIncomingStatus,
} from '../sanitize.js';
import {
  MAX_STATUS_PRESETS, MAX_STATUS_NOTE, STATUS_COLOR_DEFAULT, MAX_TTL_MS,
} from '../config.js';

// Pure rich-presence (V7.7) validators/resolvers — run anywhere (no native
// deps), like the rest of sanitize.js. `node --test`.

test('sanitizeColor', async (t) => {
  await t.test('accepts a #rrggbb hex (case-insensitive)', () => {
    assert.equal(sanitizeColor('#F4A65A'), '#F4A65A');
    assert.equal(sanitizeColor('#abc123'), '#abc123');
  });
  await t.test('falls back on anything else', () => {
    assert.equal(sanitizeColor('red'), STATUS_COLOR_DEFAULT);
    assert.equal(sanitizeColor('#fff'), STATUS_COLOR_DEFAULT); // 3-digit not allowed
    assert.equal(sanitizeColor(''), STATUS_COLOR_DEFAULT);
    assert.equal(sanitizeColor(undefined), STATUS_COLOR_DEFAULT);
  });
  await t.test('honours a custom fallback', () => {
    assert.equal(sanitizeColor('nope', '#000000'), '#000000');
  });
});

test('sanitizeStatusPresets', async (t) => {
  await t.test('throws on a non-array', () => {
    assert.throws(() => sanitizeStatusPresets('x'));
    assert.throws(() => sanitizeStatusPresets(null));
  });
  await t.test('keeps valid items, mints missing ids', () => {
    const out = sanitizeStatusPresets([{ label: 'Sorti', icon: '🚪', color: '#9C7E54' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Sorti');
    assert.equal(out[0].icon, '🚪');
    assert.equal(out[0].color, '#9C7E54');
    assert.ok(typeof out[0].id === 'string' && out[0].id.length > 0);
  });
  await t.test('preserves a supplied id and dedups by id', () => {
    const out = sanitizeStatusPresets([
      { id: 'a', label: 'One' },
      { id: 'a', label: 'Dup' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'a');
    assert.equal(out[0].label, 'One');
  });
  await t.test('drops empties and bad colours fall back', () => {
    const out = sanitizeStatusPresets([
      { label: '' },
      { label: '   ' },
      { label: 'Occupé', color: 'tomato' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].color, STATUS_COLOR_DEFAULT);
  });
  await t.test('caps at MAX_STATUS_PRESETS', () => {
    const many = Array.from({ length: MAX_STATUS_PRESETS + 4 }, (_, i) => ({ label: `S${i}` }));
    assert.equal(sanitizeStatusPresets(many).length, MAX_STATUS_PRESETS);
  });
});

test('sanitizeStatusNote', async (t) => {
  await t.test('trims', () => assert.equal(sanitizeStatusNote('  hi  '), 'hi'));
  await t.test('empty for non-strings', () => assert.equal(sanitizeStatusNote(42), ''));
  await t.test('truncates at MAX_STATUS_NOTE', () => {
    const long = 'x'.repeat(MAX_STATUS_NOTE + 10);
    assert.equal(sanitizeStatusNote(long).length, MAX_STATUS_NOTE);
  });
});

test('sanitizeUntil', async (t) => {
  const now = 1_000_000;
  await t.test('null for non-finite / past / now', () => {
    assert.equal(sanitizeUntil('soon', now), null);
    assert.equal(sanitizeUntil(now - 1, now), null);
    assert.equal(sanitizeUntil(now, now), null);
  });
  await t.test('passes a future ms through (floored)', () => {
    assert.equal(sanitizeUntil(now + 5000.7, now), now + 5000);
  });
  await t.test('clamps to the TTL ceiling', () => {
    assert.equal(sanitizeUntil(now + MAX_TTL_MS + 9999, now), now + MAX_TTL_MS);
  });
});

test('resolveStatus', async (t) => {
  const presets = [
    { id: 'sorti', label: 'Sorti', icon: '🚪', color: '#9C7E54' },
    { id: 'occupe', label: 'Occupé', icon: '⛔', color: 'bad' },
  ];
  const now = 1_000_000;
  await t.test('null when no/unknown preset', () => {
    assert.equal(resolveStatus(presets, { presetId: '' }, now), null);
    assert.equal(resolveStatus(presets, { presetId: 'ghost' }, now), null);
    assert.equal(resolveStatus(presets, {}, now), null);
  });
  await t.test('resolves label/icon/colour from the catalog', () => {
    const s = resolveStatus(presets, { presetId: 'sorti' }, now);
    assert.deepEqual(s, { presetId: 'sorti', label: 'Sorti', icon: '🚪', color: '#9C7E54' });
  });
  await t.test('a bad preset colour falls back', () => {
    assert.equal(resolveStatus(presets, { presetId: 'occupe' }, now).color, STATUS_COLOR_DEFAULT);
  });
  await t.test('attaches a note and a future until, drops a past until', () => {
    const s = resolveStatus(presets, { presetId: 'sorti', note: '  au studio ', until: now + 5000 }, now);
    assert.equal(s.note, 'au studio');
    assert.equal(s.until, now + 5000);
    const s2 = resolveStatus(presets, { presetId: 'sorti', until: now - 1 }, now);
    assert.equal(s2.until, undefined);
  });
});

test('normalizeIncomingStatus', async (t) => {
  const now = 1_000_000;
  await t.test('null for junk / missing label', () => {
    assert.equal(normalizeIncomingStatus(null, now), null);
    assert.equal(normalizeIncomingStatus('x', now), null);
    assert.equal(normalizeIncomingStatus({ icon: '🚪' }, now), null);
  });
  await t.test('treats an already-expired until as no status', () => {
    assert.equal(normalizeIncomingStatus({ label: 'Sorti', until: now - 1 }, now), null);
  });
  await t.test('passes a clean object through, defends the colour', () => {
    const s = normalizeIncomingStatus({ label: 'Occupé', icon: '⛔', color: 'evil', note: 'x', until: now + 5000 }, now);
    assert.equal(s.label, 'Occupé');
    assert.equal(s.icon, '⛔');
    assert.equal(s.color, STATUS_COLOR_DEFAULT);
    assert.equal(s.note, 'x');
    assert.equal(s.until, now + 5000);
  });
});
