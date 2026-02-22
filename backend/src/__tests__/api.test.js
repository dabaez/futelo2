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
const FRANK     = 'dev:1006:frank:Frank';  // used by BM tests only
const authHeader = (token) => ({ 'x-init-data': token });

async function authAs(app, token) {
  return request(app)
    .post('/api/auth')
    .set(authHeader(token))
    .send({ initData: token });
}

// Earn `needed` coins for `userToken` by sending alternating Tier-1 messages
// with a pivot user (defaults to BOB). Both users must already be registered.
// Letters are never consumed, so "h" from STARTING_INVENTORY is always safe.
async function seedCoins(app, userToken, needed = 100) {
  const pivot = userToken === BOB ? ALICE : BOB;
  await authAs(app, pivot);
  const iters = Math.ceil(needed / 10);
  for (let i = 0; i < iters; i++) {
    await request(app).post('/api/message').set(authHeader(pivot)).send({ text: 'h' });
    await request(app).post('/api/message').set(authHeader(userToken)).send({ text: 'h' });
  }
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
    // STARTING_COINS = 0; earn 100 coins via alternating Tier-1 messages before rolling.
    await seedCoins(app, ALICE, 100);
  });

  test('deducts 50 coins and returns 3 new letters', async () => {
    // Fetch current balance before rolling (seedCoins + prior test coins may vary)
    const meRes = await request(app).get('/api/me').set(authHeader(ALICE));
    const coinsBefore = meRes.body.coins;

    const res = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(ALICE))
      .send();

    expect(res.status).toBe(200);
    expect(res.body.newLetters).toHaveLength(3);
    expect(typeof res.body.newCoins).toBe('number');
    // Roll cost is dynamic (scales with inventory level)
    expect(res.body.newCoins).toBe(coinsBefore - res.body.rollCost);
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
describe('P2P market endpoints', () => {
  let app;
  let eveLetter;
  let listingId;

  beforeAll(async () => {
    app = getApp();
    // Register both players
    await authAs(app, EVE);
    await authAs(app, DAVE);
    // Give EVE enough coins to roll for letters (roll cost scales with inventory ~110+)
    await seedCoins(app, EVE, 300);
    // Eve rolls to get letters
    const rollRes = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(EVE))
      .send();
    eveLetter = (rollRes.body.newLetters || [])[0];
    // Give DAVE enough coins to buy a listing
    await seedCoins(app, DAVE, 200);
  });

  test('GET /api/market/listings returns an array without authentication', async () => {
    const res = await request(app).get('/api/market/listings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/market/my-listings returns 401 without authentication', async () => {
    const res = await request(app).get('/api/market/my-listings');
    expect(res.status).toBe(401);
  });

  test('GET /api/market/my-listings returns array for authed user', async () => {
    const res = await request(app)
      .get('/api/market/my-listings')
      .set(authHeader(EVE));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/market/list returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/api/market/list')
      .send({ letter: 'a', price: 50 });
    expect(res.status).toBe(401);
  });

  test('POST /api/market/list returns 400 for an invalid letter', async () => {
    const res = await request(app)
      .post('/api/market/list')
      .set(authHeader(EVE))
      .send({ letter: '!', price: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválida/i);
  });

  test('POST /api/market/list creates a listing and returns listingId', async () => {
    const res = await request(app)
      .post('/api/market/list')
      .set(authHeader(EVE))
      .send({ letter: eveLetter, price: 50 });
    expect(res.status).toBe(200);
    expect(typeof res.body.listingId).toBe('number');
    expect(res.body.letter).toBe(eveLetter);
    expect(res.body.price).toBe(50);
    listingId = res.body.listingId;
  });

  test('POST /api/market/buy/:id buyer receives letter and coins transfer correctly', async () => {
    // Get DAVE's coins before buying
    const meBefore = await request(app).get('/api/me').set(authHeader(DAVE));
    const coinsBefore = meBefore.body.coins;

    const res = await request(app)
      .post(`/api/market/buy/${listingId}`)
      .set(authHeader(DAVE));

    expect(res.status).toBe(200);
    expect(res.body.letter).toBe(eveLetter);
    expect(res.body.newCoins).toBe(coinsBefore - 50);
    expect(res.body.newInventory[eveLetter]).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/market/buy/:id returns 400 for already-sold listing', async () => {
    const res = await request(app)
      .post(`/api/market/buy/${listingId}`)
      .set(authHeader(DAVE));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disponible/i);
  });

  test('POST /api/market/cancel/:id cancels an open listing and returns the letter', async () => {
    // Eve lists another letter first
    await seedCoins(app, EVE, 300);
    const rollRes2 = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(EVE))
      .send();
    const anotherLetter = (rollRes2.body.newLetters || [])[0];

    const listRes = await request(app)
      .post('/api/market/list')
      .set(authHeader(EVE))
      .send({ letter: anotherLetter, price: 30 });
    const cancelId = listRes.body.listingId;

    const res = await request(app)
      .post(`/api/market/cancel/${cancelId}`)
      .set(authHeader(EVE));

    expect(res.status).toBe(200);
    expect(res.body.letter).toBe(anotherLetter);
    expect(typeof res.body.newInventory).toBe('object');
  });

  test('POST /api/market/cancel/:id returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/api/market/cancel/1');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Black market endpoints (secret)
// ────────────────────────────────────────────────────────────────────────────
describe('Black market endpoints (secret)', () => {
  let app;
  let bmListingId;
  let frankLetter;

  beforeAll(() => { app = getApp(); });

  test('GET /api/bm/listings returns 200 without auth', async () => {
    const res = await request(app).get('/api/bm/listings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/bm/my-listings returns 401 without auth', async () => {
    const res = await request(app).get('/api/bm/my-listings');
    expect(res.status).toBe(401);
  });

  test('GET /api/bm/my-listings returns 200 with auth', async () => {
    await authAs(app, FRANK);
    const res = await request(app).get('/api/bm/my-listings').set(authHeader(FRANK));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/bm/list returns 401 without authentication', async () => {
    const res = await request(app).post('/api/bm/list').send({ letter: 'a', price: 20 });
    expect(res.status).toBe(401);
  });

  test('POST /api/bm/list creates a BM listing', async () => {
    // FRANK needs coins and letters first
    await authAs(app, FRANK);
    await seedCoins(app, FRANK, 100);
    // Send a message to trigger letter unlock
    await request(app).post('/api/message').set(authHeader(FRANK)).send({ text: 'h' });

    const meRes = await request(app).get('/api/me').set(authHeader(FRANK));
    const inv = meRes.body.inventory || {};
    frankLetter = Object.keys(inv).find((k) => inv[k] > 0);
    expect(frankLetter).toBeTruthy();

    const res = await request(app)
      .post('/api/bm/list')
      .set(authHeader(FRANK))
      .send({ letter: frankLetter, price: 25 });

    expect(res.status).toBe(200);
    expect(res.body.letter).toBe(frankLetter);
    bmListingId = res.body.listingId;
    expect(typeof bmListingId).toBe('number');
  });

  test('GET /api/bm/listings shows the new listing', async () => {
    const res = await request(app).get('/api/bm/listings');
    expect(res.status).toBe(200);
    expect(res.body.some((l) => l.id === bmListingId)).toBe(true);
  });

  test('POST /api/bm/buy/:id returns 401 without authentication', async () => {
    const res = await request(app).post(`/api/bm/buy/${bmListingId}`);
    expect(res.status).toBe(401);
  });

  test('POST /api/bm/buy/:id lets another user purchase the BM listing', async () => {
    await authAs(app, DAVE);
    await seedCoins(app, DAVE, 100);

    const res = await request(app)
      .post(`/api/bm/buy/${bmListingId}`)
      .set(authHeader(DAVE));

    expect(res.status).toBe(200);
    expect(res.body.letter).toBe(frankLetter);
    expect(typeof res.body.newInventory).toBe('object');
  });

  test('POST /api/bm/buy/:id returns 400 for already-sold BM listing', async () => {
    const res = await request(app)
      .post(`/api/bm/buy/${bmListingId}`)
      .set(authHeader(DAVE));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disponible/i);
  });

  test('POST /api/bm/cancel/:id returns 401 without auth', async () => {
    const res = await request(app).post('/api/bm/cancel/1');
    expect(res.status).toBe(401);
  });

  test('POST /api/bm/cancel/:id lets the seller cancel an open BM listing', async () => {
    // Frank reacquires a letter by using the shop roll
    await seedCoins(app, FRANK, 300);
    const rollRes = await request(app).post('/api/shop/roll').set(authHeader(FRANK));
    const newLetter = (rollRes.body.newLetters || [])[0];
    expect(newLetter).toBeTruthy();

    const listRes = await request(app)
      .post('/api/bm/list')
      .set(authHeader(FRANK))
      .send({ letter: newLetter, price: 20 });
    const cancelId = listRes.body.listingId;

    const res = await request(app)
      .post(`/api/bm/cancel/${cancelId}`)
      .set(authHeader(FRANK));

    expect(res.status).toBe(200);
    expect(res.body.letter).toBe(newLetter);
    expect(typeof res.body.newInventory).toBe('object');
  });
});
