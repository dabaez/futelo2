'use strict';

/**
 * auth.test.js
 * ────────────
 * Unit tests for Telegram initData validation (HMAC) and dev-token parsing.
 * These tests are purely in-memory – no DB, no network.
 */

const crypto = require('crypto');

// We need to re-require with different env vars, so reset modules between suites
const { validateInitData, validateInitDataDev } = require('../bot/auth');

// ── Test helper: build a valid Telegram initData string ──────────────────────
function buildValidInitData(botToken, userPayload = {}) {
  const user = JSON.stringify({
    id:         42,
    first_name: 'Test',
    username:   'testuser',
    ...userPayload,
  });

  const params = new URLSearchParams({ user, auth_date: '9999999999' });
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  params.set('hash', hash);
  return params.toString();
}

// ── validateInitDataDev ───────────────────────────────────────────────────────
describe('validateInitDataDev', () => {
  test('parses a valid dev token', () => {
    const user = validateInitDataDev('dev:1001:alice:Alice');
    expect(user.id).toBe(1001);
    expect(user.username).toBe('alice');
    expect(user.first_name).toBe('Alice');
    expect(user.is_bot).toBe(false);
  });

  test('allows colons inside the first name', () => {
    const user = validateInitDataDev('dev:99:bob:Bob: The Builder');
    expect(user.first_name).toBe('Bob: The Builder');
  });

  test('throws when the token does not start with dev:', () => {
    expect(() => validateInitDataDev('user:1:alice:Alice')).toThrow();
  });

  test('throws when USER_ID is not a positive integer', () => {
    expect(() => validateInitDataDev('dev:abc:alice:Alice')).toThrow();
    expect(() => validateInitDataDev('dev:-5:alice:Alice')).toThrow();
    expect(() => validateInitDataDev('dev:0:alice:Alice')).toThrow();
  });

  test('throws when the token has fewer than 4 colon-separated parts', () => {
    expect(() => validateInitDataDev('dev:1001:alice')).toThrow();
  });
});

// ── validateInitData – real HMAC path ─────────────────────────────────────────
describe('validateInitData – HMAC validation', () => {
  const BOT_TOKEN = 'test_bot_token_12345';

  beforeEach(() => {
    // Ensure dev mode is OFF for HMAC tests
    delete process.env.DEV_MODE;
  });

  test('accepts correctly signed initData and returns the user object', () => {
    const raw  = buildValidInitData(BOT_TOKEN, { id: 42, username: 'tester' });
    const user = validateInitData(raw, BOT_TOKEN);
    expect(user.id).toBe(42);
    expect(user.username).toBe('tester');
  });

  test('throws when the hash has been tampered with', () => {
    const raw     = buildValidInitData(BOT_TOKEN);
    const tampered = raw.replace(/hash=[0-9a-f]+/, 'hash=deadbeef');
    expect(() => validateInitData(tampered, BOT_TOKEN)).toThrow('Invalid initData hash');
  });

  test('throws when hash field is absent', () => {
    const raw     = buildValidInitData(BOT_TOKEN);
    const noHash  = raw.replace(/&?hash=[^&]+/, '');
    expect(() => validateInitData(noHash, BOT_TOKEN)).toThrow('Missing hash');
  });

  test('throws when the wrong bot token is used', () => {
    const raw = buildValidInitData(BOT_TOKEN);
    expect(() => validateInitData(raw, 'wrong_token')).toThrow('Invalid initData hash');
  });

  test('throws when initData is empty or null', () => {
    expect(() => validateInitData('',   BOT_TOKEN)).toThrow();
    expect(() => validateInitData(null, BOT_TOKEN)).toThrow();
  });
});

// ── validateInitData – dev token bypass ───────────────────────────────────────
describe('validateInitData – dev token passthrough (DEV_MODE=true)', () => {
  beforeEach(() => { process.env.DEV_MODE = 'true'; });
  afterEach(()  => { delete process.env.DEV_MODE; });

  test('accepts a dev: token when DEV_MODE is true', () => {
    const user = validateInitData('dev:7:charlie:Charlie', 'any_token');
    expect(user.id).toBe(7);
    expect(user.username).toBe('charlie');
  });

  test('rejects a dev: token when DEV_MODE is NOT true', () => {
    process.env.DEV_MODE = 'false';
    // A dev: token is not valid URL-encoded initData with a hash
    expect(() => validateInitData('dev:7:charlie:Charlie', 'any_token')).toThrow();
  });
});
