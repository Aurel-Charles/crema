import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectVersion } from '../config.js';

// Pure resolver — runs anywhere. The runtime `VERSION` constant is *not*
// tested here (it calls execSync at module load, which would freeze whatever
// happened on this machine into a test snapshot).

test('detectVersion', async (t) => {
  await t.test('env CREMA_VERSION wins over git describe', () => {
    assert.equal(
      detectVersion({ env: { CREMA_VERSION: 'v9.9.9' }, gitDescribe: () => 'v0.0.0' }),
      'v9.9.9',
    );
  });

  await t.test('falls back to git describe when env is missing/empty', () => {
    assert.equal(
      detectVersion({ env: {}, gitDescribe: () => 'v7.3.0-2-gd4d997b' }),
      'v7.3.0-2-gd4d997b',
    );
    assert.equal(
      detectVersion({ env: { CREMA_VERSION: '' }, gitDescribe: () => 'v7.3.0' }),
      'v7.3.0',
    );
    assert.equal(
      detectVersion({ env: { CREMA_VERSION: '   ' }, gitDescribe: () => 'v7.3.0' }),
      'v7.3.0',
    );
  });

  await t.test('trims whitespace/newlines (execSync output ends with \\n)', () => {
    assert.equal(
      detectVersion({ env: {}, gitDescribe: () => 'v7.3.0\n' }),
      'v7.3.0',
    );
    assert.equal(
      detectVersion({ env: { CREMA_VERSION: '  v7.3.0  ' }, gitDescribe: () => null }),
      'v7.3.0',
    );
  });

  await t.test('falls back to "unknown" when both fail', () => {
    assert.equal(detectVersion({ env: {}, gitDescribe: () => null }), 'unknown');
    assert.equal(detectVersion({ env: {}, gitDescribe: () => '' }), 'unknown');
    assert.equal(detectVersion({ env: {}, gitDescribe: () => '   ' }), 'unknown');
    assert.equal(detectVersion({}), 'unknown');
    assert.equal(detectVersion(), 'unknown');
  });

  await t.test('non-string env value falls through to git', () => {
    assert.equal(
      detectVersion({ env: { CREMA_VERSION: 42 }, gitDescribe: () => 'v7.3.0' }),
      'v7.3.0',
    );
  });
});
