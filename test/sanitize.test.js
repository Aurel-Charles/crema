import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampTtl, sanitizeReplies, sanitizeResponseOptions, sanitizeShortcuts,
  sanitizeNickname, sanitizeTarget, sanitizeBrokerUrl, sanitizeTheme,
} from '../sanitize.js';
import {
  MIN_TTL_MS, MAX_TTL_MS, MAX_REPLIES, MAX_SHORTCUTS, MAX_LABEL_LENGTH,
  MAX_SHORTCUT_TEXT, MAX_ICON_LENGTH,
} from '../config.js';

// These run anywhere (no native deps) — that's the whole point of extracting
// sanitize.js out of the db.js/mdns import chain. `node --test`.

test('clampTtl', async (t) => {
  await t.test('clamps below MIN up to MIN', () => {
    assert.equal(clampTtl(0), MIN_TTL_MS);
    assert.equal(clampTtl(MIN_TTL_MS - 1), MIN_TTL_MS);
  });
  await t.test('clamps above MAX down to MAX', () => {
    assert.equal(clampTtl(MAX_TTL_MS + 1), MAX_TTL_MS);
    assert.equal(clampTtl(Number.MAX_SAFE_INTEGER), MAX_TTL_MS);
  });
  await t.test('passes a valid value through', () => {
    assert.equal(clampTtl(60_000), 60_000);
  });
  await t.test('coerces numeric strings', () => {
    assert.equal(clampTtl('60000'), 60_000);
  });
  await t.test('returns null only when Number() is non-finite', () => {
    assert.equal(clampTtl(undefined), null); // Number(undefined) === NaN
    assert.equal(clampTtl('abc'), null);
    assert.equal(clampTtl(NaN), null);
    assert.equal(clampTtl(Infinity), null);
  });
  await t.test('coerces null/empty-string (Number → 0) up to MIN, not null', () => {
    // Number(null) === 0 and Number('') === 0, both finite → clamped to MIN.
    // Documented so callers know these are *not* treated as "unset".
    assert.equal(clampTtl(null), MIN_TTL_MS);
    assert.equal(clampTtl(''), MIN_TTL_MS);
  });
});

test('sanitizeReplies', async (t) => {
  await t.test('throws on a non-array', () => {
    assert.throws(() => sanitizeReplies('nope'), /Liste invalide/);
    assert.throws(() => sanitizeReplies(null), /Liste invalide/);
  });
  await t.test('keeps and trims valid labels', () => {
    assert.deepEqual(sanitizeReplies([{ label: '  Vu ' }, { label: '👍' }]),
      [{ label: 'Vu' }, { label: '👍' }]);
  });
  await t.test('drops empties and non-string labels', () => {
    assert.deepEqual(sanitizeReplies([{ label: '   ' }, { label: 42 }, {}, { label: 'OK' }]),
      [{ label: 'OK' }]);
  });
  await t.test('drops over-length labels', () => {
    const long = 'x'.repeat(MAX_LABEL_LENGTH + 1);
    assert.deepEqual(sanitizeReplies([{ label: long }, { label: 'ok' }]), [{ label: 'ok' }]);
  });
  await t.test('dedups by label', () => {
    assert.deepEqual(sanitizeReplies([{ label: 'a' }, { label: 'a' }, { label: 'b' }]),
      [{ label: 'a' }, { label: 'b' }]);
  });
  await t.test('caps at MAX_REPLIES', () => {
    const many = Array.from({ length: MAX_REPLIES + 3 }, (_, i) => ({ label: `r${i}` }));
    assert.equal(sanitizeReplies(many).length, MAX_REPLIES);
  });
});

test('sanitizeResponseOptions', async (t) => {
  await t.test('returns [] on a non-array (no throw, unlike sanitizeReplies)', () => {
    assert.deepEqual(sanitizeResponseOptions('nope'), []);
    assert.deepEqual(sanitizeResponseOptions(undefined), []);
  });
  await t.test('accepts bare strings and { label } items alike', () => {
    assert.deepEqual(sanitizeResponseOptions(['Oui', { label: 'Non' }]),
      [{ label: 'Oui' }, { label: 'Non' }]);
  });
  await t.test('trims, drops empties, dedups, caps at MAX_REPLIES', () => {
    assert.deepEqual(sanitizeResponseOptions([' a ', 'a', '', 'b']),
      [{ label: 'a' }, { label: 'b' }]);
    const many = Array.from({ length: MAX_REPLIES + 2 }, (_, i) => `o${i}`);
    assert.equal(sanitizeResponseOptions(many).length, MAX_REPLIES);
  });
});

test('sanitizeShortcuts', async (t) => {
  const base = { label: 'Table', text: 'À table', icon: '🍽', targetOwner: 'Slibar', ttlMs: 300_000 };

  await t.test('throws on a non-array', () => {
    assert.throws(() => sanitizeShortcuts({}), /Liste invalide/);
  });
  await t.test('keeps a valid shortcut and mints an id when absent', () => {
    const [s] = sanitizeShortcuts([base]);
    assert.equal(typeof s.id, 'string');
    assert.ok(s.id.length > 0);
    assert.equal(s.label, 'Table');
    assert.equal(s.ttlMs, 300_000);
  });
  await t.test('preserves a supplied id', () => {
    const [s] = sanitizeShortcuts([{ ...base, id: 'fixed-id' }]);
    assert.equal(s.id, 'fixed-id');
  });
  await t.test('allows an empty targetOwner (global shortcut)', () => {
    const [s] = sanitizeShortcuts([{ ...base, targetOwner: '' }]);
    assert.equal(s.targetOwner, '');
  });
  await t.test('drops a shortcut with no label or no text', () => {
    assert.equal(sanitizeShortcuts([{ ...base, label: '' }]).length, 0);
    assert.equal(sanitizeShortcuts([{ ...base, text: '   ' }]).length, 0);
  });
  await t.test('drops a shortcut whose ttl is non-numeric (clampTtl → null)', () => {
    assert.equal(sanitizeShortcuts([{ ...base, ttlMs: 'soon' }]).length, 0);
  });
  await t.test('clamps an out-of-range ttl rather than dropping it', () => {
    const [s] = sanitizeShortcuts([{ ...base, ttlMs: 1 }]);
    assert.equal(s.ttlMs, MIN_TTL_MS);
  });
  await t.test('drops over-length text/icon', () => {
    assert.equal(sanitizeShortcuts([{ ...base, text: 'x'.repeat(MAX_SHORTCUT_TEXT + 1) }]).length, 0);
    assert.equal(sanitizeShortcuts([{ ...base, icon: 'x'.repeat(MAX_ICON_LENGTH + 1) }]).length, 0);
  });
  await t.test('caps at MAX_SHORTCUTS', () => {
    const many = Array.from({ length: MAX_SHORTCUTS + 2 }, (_, i) => ({ ...base, label: `s${i}` }));
    assert.equal(sanitizeShortcuts(many).length, MAX_SHORTCUTS);
  });
});

test('sanitizeNickname', async (t) => {
  await t.test('trims', () => {
    assert.equal(sanitizeNickname('  Salon  '), 'Salon');
  });
  await t.test('non-string → empty', () => {
    assert.equal(sanitizeNickname(42), '');
    assert.equal(sanitizeNickname(undefined), '');
  });
  await t.test('truncates over-length (does not reject)', () => {
    const long = 'x'.repeat(MAX_LABEL_LENGTH + 5);
    assert.equal(sanitizeNickname(long).length, MAX_LABEL_LENGTH);
  });
});

test('sanitizeTarget', async (t) => {
  await t.test('trims a normal owner', () => {
    assert.equal(sanitizeTarget('  Slibar '), 'Slibar');
  });
  await t.test('non-string → empty', () => {
    assert.equal(sanitizeTarget(null), '');
  });
  await t.test('over-length → empty (treated as unset, not truncated)', () => {
    assert.equal(sanitizeTarget('x'.repeat(MAX_LABEL_LENGTH + 1)), '');
  });
});

test('sanitizeBrokerUrl', async (t) => {
  await t.test("empty/whitespace/non-string → '' (clear the override)", () => {
    assert.equal(sanitizeBrokerUrl(''), '');
    assert.equal(sanitizeBrokerUrl('   '), '');
    assert.equal(sanitizeBrokerUrl(undefined), '');
    assert.equal(sanitizeBrokerUrl(null), '');
    assert.equal(sanitizeBrokerUrl(42), '');
  });
  await t.test('accepts ws:// and wss://, trims', () => {
    assert.equal(sanitizeBrokerUrl('  ws://192.168.1.50:4000 '), 'ws://192.168.1.50:4000');
    assert.equal(sanitizeBrokerUrl('wss://broker.example.fr'),
      'wss://broker.example.fr');
  });
  await t.test('drops a lone trailing slash (matches the env/pinned form)', () => {
    assert.equal(sanitizeBrokerUrl('wss://broker.example/'), 'wss://broker.example');
  });
  await t.test('keeps an explicit path', () => {
    assert.equal(sanitizeBrokerUrl('wss://host/relay'), 'wss://host/relay');
  });
  await t.test('null (rejected) for a non-ws scheme', () => {
    assert.equal(sanitizeBrokerUrl('http://broker.example'), null);
    assert.equal(sanitizeBrokerUrl('https://broker.example'), null);
  });
  await t.test('null (rejected) for an unparseable URL', () => {
    assert.equal(sanitizeBrokerUrl('not a url'), null);
    assert.equal(sanitizeBrokerUrl('ws://'), null);
  });
});

test('sanitizeTheme', async (t) => {
  await t.test("only the exact string 'dark' is dark", () => {
    assert.equal(sanitizeTheme('dark'), 'dark');
  });
  await t.test("everything else collapses to 'light'", () => {
    assert.equal(sanitizeTheme('light'), 'light');
    assert.equal(sanitizeTheme('Dark'), 'light');
    assert.equal(sanitizeTheme(''), 'light');
    assert.equal(sanitizeTheme(undefined), 'light');
    assert.equal(sanitizeTheme(null), 'light');
    assert.equal(sanitizeTheme(42), 'light');
    assert.equal(sanitizeTheme({}), 'light');
  });
});
