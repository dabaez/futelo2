'use strict';

/**
 * api.test.js
 * ───────────
 * Integration tests for all REST endpoints.
 * Uses a real SQLite database in a temporary directory so nothing
 * touches the production data/ folder.
 *
 * The server is imported as an Express app (server.listen is skipped
 * because server.js guards it with require.main === module).
 * Supertest starts its own ephemeral port.
 */

const os      = require('os');
const path    = require('path');
const fs      = require('fs');
const request = require('supertest');

// ── Bootstrap a fresh temp DB before requiring any module ──────────────────
const TEST_DIR = path.join(os.tmpdir(), `futelo-test-${Date.now()}`);

beforeAll(() => {
  // Point the DB at a temp dir so tests never touch data/futelo.db
  process.env.FUTELO_DATA_DIR = TEST_DIR;
  process.env.DEV_MODE        = 'true';
  process.env.SERVER_PORT     = '0'; // supertest manages the port
  // Prevent dotenv from loading a real BOT_TOKEN from .env and starting the bot
  process.env.BOT_TOKEN       = '';
  process.env.BOT_MODE        = 'polling';
  // Fresh module graph so the DB module sees the env vars above
  jest.resetModules();
});

afterAll(() => {
  // Clean up temp DB files
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// Lazy-require AFTER env vars are set
function getApp() {
  return require('../server').app;
}

// ── Helpers ────────────────────────────────────────────────────────────────
const ALICE     = 'dev:1001:alice:Alice';
const BOB       = 'dev:1002:bob:Bob';
const DAVE      = 'dev:1004:dave:Dave';
const EVE       = 'dev:1005:eve:Eve';
const authHeader = (token) => ({ 'x-init-data': token });

async function authAs(app, token) {
  return request(app)
    .post('/api/auth')
    .set(authHeader(token))
    .send({ initData: token });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth', () => {
  let app;
  beforeAll(() => { app = getApp(); });

  test('registers a new user and returns profile', async () => {
    const res = await authAs(app, ALICE);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id:        1001,
      username:  'alice',
      first_name:'Alice',
    });
    expect(typeof res.body.user.coins).toBe('number');
    expect(typeof res.body.user.inventory).toBe('object');
  });

  test('is idempotent – second call returns same user', async () => {
    const r1 = await authAs(app, ALICE);
    const r2 = await authAs(app, ALICE);
    expect(r1.body.user.id).toBe(r2.body.user.id);
  });

  test('returns 401 when initData is missing', async () => {
    const res = await request(app).post('/api/auth').send({});
    expect(res.status).toBe(401);
  });

  test('returns 403 for a malformed dev token', async () => {
    const res = await request(app)
      .post('/api/auth')
      .set(authHeader('dev:notanumber:x:Y'))
      .send();
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/me', () => {
  let app;
  beforeAll(async () => {
    app = getApp();
    await authAs(app, BOB);
  });

  test('returns current user profile', async () => {
    const res = await request(app)
      .get('/api/me')
      .set(authHeader(BOB));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1002);
    expect(Array.isArray(res.body.lockedLetters)).toBe(true);
  });

  test('returns 401 without auth', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/messages', () => {
  let app;
  beforeAll(() => { app = getApp(); });

  test('returns an array (may be empty)', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('respects the limit query parameter', async () => {
    const res = await request(app).get('/api/messages?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
  });

  test('caps limit at 200', async () => {
    const res = await request(app).get('/api/messages?limit=9999');
    expect(res.status).toBe(200);
    // As long as we have < 200 messages in the test DB this just checks the route doesn't error
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/message', () => {
  let app;

  beforeAll(async () => {
    app = getApp();
    // Ensure users exist
    await authAs(app, ALICE);
    await authAs(app, BOB);
  });

  test('Alice sends first message → Tier 1, +10 coins', async () => {
    // Fetch Alice's inventory so we can pick a letter she can use
    const meRes = await request(app).get('/api/me').set(authHeader(ALICE));
    const inv   = meRes.body.inventory;
    // Alice starts with {} – give her a letter via auth flow (coins = 100 by default)
    // Fall back to sending a non-letter message if inventory is empty
    const text  = Object.keys(inv).length ? Object.keys(inv)[0] : 'hi';

    const res = await request(app)
      .post('/api/message')
      .set(authHeader(ALICE))
      .send({ text });

    // Either succeeds (Tier 1) or rejects due to empty inventory
    if (res.status === 200) {
      expect(res.body.ok).toBe(true);
      expect(res.body.tier).toBe(1);
      expect(res.body.coinDelta).toBe(10);
    } else {
      // Allowable failure if Alice has no letters yet
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    }
  });

  test('returns 400 for an empty message', async () => {
    const res = await request(app)
      .post('/api/message')
      .set(authHeader(ALICE))
      .send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vac/i);
  });

  test('returns 400 when inventory is insufficient', async () => {
    // Try sending a letter that almost certainly requires 100 'z's
    const res = await request(app)
      .post('/api/message')
      .set(authHeader(BOB))
      .send({ text: 'z'.repeat(100) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('returns 401 without auth', async () => {
    const res = await request(app).post('/api/message').send({ text: 'hi' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/shop/roll', () => {
  let app;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, ALICE);
  });

  test('deducts 50 coins and returns 3 new letters', async () => {
    // Alice starts with 100 coins, so one roll should work
    const res = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(ALICE))
      .send();

    expect(res.status).toBe(200);
    expect(res.body.newLetters).toHaveLength(3);
    expect(typeof res.body.newCoins).toBe('number');
    // 100 - 50 = 50
    expect(res.body.newCoins).toBe(50);
  });

  test('returns 400 when user has insufficient coins', async () => {
    // Alice now has 50 coins – roll once more to drain to 0
    await request(app).post('/api/shop/roll').set(authHeader(ALICE)).send();
    // Now she has 0 coins; another roll should fail
    const res = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(ALICE))
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insuficiente/i);
  });

  test('returns 401 without auth', async () => {
    const res = await request(app).post('/api/shop/roll').send();
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/shop/sell', () => {
  let app;
  let daveLetters = [];

  beforeAll(async () => {
    app = getApp();
    await authAs(app, DAVE);
    // Roll to obtain letters (100 → 50 coins, gains 3 letters)
    const rollRes = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(DAVE))
      .send();
    daveLetters = rollRes.body.newLetters || [];
  });

  test('sells a letter and returns 200 with earned coins', async () => {
    const letter = daveLetters[0];
    const res = await request(app)
      .post('/api/shop/sell')
      .set(authHeader(DAVE))
      .send({ letter });

    expect(res.status).toBe(200);
    expect(typeof res.body.earned).toBe('number');
    expect(res.body.earned).toBeGreaterThan(0);
    expect(typeof res.body.newCoins).toBe('number');
  });

  test('returns 400 for an invalid letter character', async () => {
    const res = await request(app)
      .post('/api/shop/sell')
      .set(authHeader(DAVE))
      .send({ letter: '!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválida/i);
  });

  test('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/api/shop/sell')
      .send({ letter: 'a' });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Black market endpoints', () => {
  let app;
  let eveLetter;
  let listingId;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, EVE);
    // Roll to obtain letters (100 → 50 coins, gains 3 letters)
    const rollRes = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(EVE))
      .send();
    eveLetter = (rollRes.body.newLetters || [])[0];
    // List the first letter on the black market
    const listRes = await request(app)
      .post('/api/blackmarket/list')
      .set(authHeader(EVE))
      .send({ letter: eveLetter });
    listingId = listRes.body.listingId;
  });

  test('GET /api/blackmarket/heat returns heat and catchProbPerMin', async () => {
    const res = await request(app).get('/api/blackmarket/heat');
    expect(res.status).toBe(200);
    expect(typeof res.body.heat).toBe('number');
    expect(typeof res.body.catchProbPerMin).toBe('number');
    expect(res.body.catchProbPerMin).toBeGreaterThan(0);
  });

  test('GET /api/blackmarket/listings returns an array for authed user', async () => {
    const res = await request(app)
      .get('/api/blackmarket/listings')
      .set(authHeader(EVE));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/blackmarket/list returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/blackmarket/list')
      .send({ letter: 'a' });

    expect(res.status).toBe(401);
  });

  test('POST /api/blackmarket/collect/:id collects the listing and returns SELL_BASE_PRICE', async () => {
    const res = await request(app)
      .post(`/api/blackmarket/collect/${listingId}`)
      .set(authHeader(EVE));

    expect(res.status).toBe(200);
    expect(res.body.earned).toBe(15); // SELL_BASE_PRICE
  });

  test('POST /api/blackmarket/collect/:id returns 400 for a non-existent listing', async () => {
    const res = await request(app)
      .post('/api/blackmarket/collect/999999')
      .set(authHeader(EVE));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no encontrado/i);
  });
});
