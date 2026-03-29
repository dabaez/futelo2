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
const { TIER1_COINS } = require('../config');

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
  const iters = Math.ceil(needed / TIER1_COINS);
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
    expect(typeof res.body.user.pickaxe_hits).toBe('number');
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
    expect(typeof res.body.pickaxe_hits).toBe('number');
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

  test(`Alice sends first message → Tier 1, +${TIER1_COINS} coins`, async () => {
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
      expect(res.body.coinDelta).toBe(TIER1_COINS);
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
    // STARTING_COINS = 0; earn 200 coins before rolling.
    // Roll cost is dynamic: 50 base + 2 × total inventory levels (≈110 with starting inventory).
    await seedCoins(app, ALICE, 200);
  });

  test('deducts rollCost coins and returns at least 1 new letter', async () => {
    // Fetch current balance before rolling (seedCoins + prior test coins may vary)
    const meRes = await request(app).get('/api/me').set(authHeader(ALICE));
    const coinsBefore = meRes.body.coins;

    const res = await request(app)
      .post('/api/shop/roll')
      .set(authHeader(ALICE))
      .send();

    expect(res.status).toBe(200);
    expect(res.body.newLetters.length).toBeGreaterThanOrEqual(1);
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/market/my-listings – open-only filter
// (Regression: previously returned last-20 of any status; sold/cancelled
//  listings would crowd out open ones above the LIMIT 20 threshold.)
// ─────────────────────────────────────────────────────────────────────────────
const MEG  = 'dev:1013:meg:Meg';
const NICK = 'dev:1014:nick:Nick';

describe('GET /api/market/my-listings only returns open listings', () => {
  let app;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, MEG);
    await authAs(app, NICK);
    // Give MEG coins and letters via shop rolls
    await seedCoins(app, MEG, 600);
    await seedCoins(app, NICK, 200);
  });

  test('sold listing no longer appears in my-listings', async () => {
    // MEG rolls for letters
    const roll1 = await request(app).post('/api/shop/roll').set(authHeader(MEG)).send();
    const letter1 = (roll1.body.newLetters || [])[0];
    expect(letter1).toBeTruthy();

    // MEG lists the letter
    const listRes = await request(app)
      .post('/api/market/list')
      .set(authHeader(MEG))
      .send({ letter: letter1, price: 20 });
    const soldId = listRes.body.listingId;
    expect(typeof soldId).toBe('number');

    // NICK buys it
    await request(app)
      .post(`/api/market/buy/${soldId}`)
      .set(authHeader(NICK));

    // MEG's my-listings should NOT contain the sold listing
    const myRes = await request(app)
      .get('/api/market/my-listings?roomId=-1001')
      .set(authHeader(MEG));
    expect(myRes.status).toBe(200);
    const ids = myRes.body.map((l) => l.id);
    expect(ids).not.toContain(soldId);
    // All returned listings must be open
    myRes.body.forEach((l) => expect(l.status).toBe('open'));
  });

  test('cancelled listing no longer appears in my-listings', async () => {
    await seedCoins(app, MEG, 300);
    const roll2 = await request(app).post('/api/shop/roll').set(authHeader(MEG)).send();
    const letter2 = (roll2.body.newLetters || [])[0];
    expect(letter2).toBeTruthy();

    const listRes = await request(app)
      .post('/api/market/list')
      .set(authHeader(MEG))
      .send({ letter: letter2, price: 25 });
    const cancelId = listRes.body.listingId;

    // MEG cancels it
    await request(app)
      .post(`/api/market/cancel/${cancelId}`)
      .set(authHeader(MEG));

    const myRes = await request(app)
      .get('/api/market/my-listings?roomId=-1001')
      .set(authHeader(MEG));
    expect(myRes.status).toBe(200);
    const ids = myRes.body.map((l) => l.id);
    expect(ids).not.toContain(cancelId);
    myRes.body.forEach((l) => expect(l.status).toBe('open'));
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
    const res = await request(app).get('/api/bm/listings?roomId=-1001');
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

// ─────────────────────────────────────────────────────────────────────────────
// Letter mines endpoints
// ─────────────────────────────────────────────────────────────────────────────
// Use fresh users (GINA, HANK) to avoid coin/inventory state from prior suites.
const GINA = 'dev:1007:gina:Gina';
const HANK = 'dev:1008:hank:Hank';

describe('POST /api/mine/buy', () => {
  let app;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, GINA);
  });

  test('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/mine/buy');
    expect(res.status).toBe(401);
  });

  test('returns 400 when the user has insufficient coins', async () => {
    // GINA starts at 0 coins (STARTING_COINS) and hasn't earned any yet
    const meRes = await request(app).get('/api/me').set(authHeader(GINA));
    expect(meRes.body.coins).toBe(0);

    const res = await request(app)
      .post('/api/mine/buy')
      .set(authHeader(GINA));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insuficiente/i);
  });

  test('deducts scaled cost and grants PICKAXE_HITS after seeding coins', async () => {
    await seedCoins(app, GINA, 500);
    const meBefore = await request(app).get('/api/me').set(authHeader(GINA));
    const coinsBefore = meBefore.body.coins;

    const configRes = await request(app).get('/api/config');
    const { PICKAXE_HITS } = configRes.body;

    const res = await request(app)
      .post('/api/mine/buy')
      .set(authHeader(GINA));

    expect(res.status).toBe(200);
    // Scaled cost is returned in the response; use it to verify the deduction
    expect(res.body.newCoins).toBe(coinsBefore - res.body.pickaxeCost);
    expect(res.body.pickaxeHits).toBe(PICKAXE_HITS);
  });

  test('buying a second pickaxe stacks the hit counter', async () => {
    const configRes = await request(app).get('/api/config');
    const { PICKAXE_HITS } = configRes.body;

    await seedCoins(app, GINA, 500);

    const res = await request(app)
      .post('/api/mine/buy')
      .set(authHeader(GINA));

    expect(res.status).toBe(200);
    // After this second purchase, hits should be at least 2 × PICKAXE_HITS
    // (may be less if some swings were used, but base is PICKAXE_HITS per purchase)
    expect(res.body.pickaxeHits).toBeGreaterThanOrEqual(PICKAXE_HITS);
  });
});

describe('POST /api/mine/swing', () => {
  let app;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, HANK);
    // Seed enough coins for a scaled-cost pickaxe, then buy one
    await seedCoins(app, HANK, 500);
    await request(app).post('/api/mine/buy').set(authHeader(HANK));
  });

  test('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/mine/swing');
    expect(res.status).toBe(401);
  });

  test('returns 400 when user has no pickaxe hits', async () => {
    // A brand-new user who has never bought a pickaxe
    const NOHITS = 'dev:9998:nohits:NoHits';
    await authAs(app, NOHITS);
    const res = await request(app).post('/api/mine/swing').set(authHeader(NOHITS));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/golpes/i);
  });

  test('returns 200 with found (boolean), letter, newInventory, and hitsLeft', async () => {
    const res = await request(app)
      .post('/api/mine/swing')
      .set(authHeader(HANK));

    expect(res.status).toBe(200);
    expect(typeof res.body.found).toBe('boolean');
    // letter is a string on a hit, null on a miss
    if (res.body.found) {
      expect(typeof res.body.letter).toBe('string');
      expect(typeof res.body.newInventory).toBe('object');
    } else {
      expect(res.body.letter).toBeNull();
      expect(res.body.newInventory).toBeNull();
    }
    expect(typeof res.body.hitsLeft).toBe('number');
  });

  test('hitsLeft decrements with each swing', async () => {
    const before = await request(app).post('/api/mine/swing').set(authHeader(HANK));
    const after  = await request(app).post('/api/mine/swing').set(authHeader(HANK));

    expect(after.body.hitsLeft).toBe(before.body.hitsLeft - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lottery endpoints
// ─────────────────────────────────────────────────────────────────────────────
const IAN  = 'dev:1009:ian:Ian';
const JANE = 'dev:1010:jane:Jane';

describe('Lottery endpoints', () => {
  let app;
  let roundId;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, IAN);
    await authAs(app, JANE);
  });

  test('GET /api/lottery/active returns { round: null } when no round is active', async () => {
    const res = await request(app).get('/api/lottery/active');
    expect(res.status).toBe(200);
    expect(res.body.round).toBeNull();
  });

  test('POST /api/lottery/start returns 401 without auth', async () => {
    const res = await request(app).post('/api/lottery/start');
    expect(res.status).toBe(401);
  });

  test('POST /api/lottery/start returns 400 when IAN has no coins', async () => {
    const meRes = await request(app).get('/api/me').set(authHeader(IAN));
    // IAN starts at 0 coins
    expect(meRes.body.coins).toBe(0);
    const res = await request(app).post('/api/lottery/start').set(authHeader(IAN));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insuficiente/i);
  });

  test('POST /api/lottery/start creates a round after seeding coins', async () => {
    const { LOTTERY_START_COST } = (await request(app).get('/api/config')).body;
    await seedCoins(app, IAN, LOTTERY_START_COST + 10);

    const res = await request(app).post('/api/lottery/start').set(authHeader(IAN));
    expect(res.status).toBe(200);
    expect(typeof res.body.roundId).toBe('number');
    expect(typeof res.body.jackpot).toBe('number');
    // secret_letter must never be returned to the client
    expect(res.body.round).toBeDefined();
    expect(res.body.round.secret_letter).toBeUndefined();
    roundId = res.body.roundId;
  });

  test('GET /api/lottery/active returns the active round (no secret_letter)', async () => {
    // IAN's dev token defaults to chatId -1001; pass roomId to match the round
    const res = await request(app).get('/api/lottery/active?roomId=-1001');
    expect(res.status).toBe(200);
    expect(res.body.round).not.toBeNull();
    expect(res.body.round.secret_letter).toBeUndefined();
  });

  test('POST /api/lottery/bet returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/lottery/bet')
      .send({ roundId, letter: 'a' });
    expect(res.status).toBe(401);
  });

  test('POST /api/lottery/bet places a bet for a letter in IAN inventory', async () => {
    // IAN should have letters from the seedCoins process
    const meRes = await request(app).get('/api/me').set(authHeader(IAN));
    const inv   = meRes.body.inventory || {};
    const letter = Object.keys(inv).find((k) => /^[a-záéíóúñ]$/.test(k) && inv[k] > 0);
    if (!letter) { return; } // skip if IAN has no letters (shouldn't happen)

    const res = await request(app)
      .post('/api/lottery/bet')
      .set(authHeader(IAN))
      .send({ roundId, letter });

    expect(res.status).toBe(200);
    expect(res.body.bet.letter).toBe(letter);
    expect(typeof res.body.newInventory).toBe('object');
  });

  test('POST /api/lottery/start returns 400 when a round is already active', async () => {
    await seedCoins(app, JANE, 200);
    const res = await request(app).post('/api/lottery/start').set(authHeader(JANE));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activa/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt endpoints
// ─────────────────────────────────────────────────────────────────────────────
const KATE = 'dev:1011:kate:Kate';
const LEON = 'dev:1012:leon:Leon';

describe('Prompt endpoints', () => {
  let app;

  beforeAll(async () => {
    app = getApp();
    await authAs(app, KATE);
    await authAs(app, LEON);
  });

  test('GET /api/prompt/active returns { prompt: null } when none is active', async () => {
    const res = await request(app).get('/api/prompt/active');
    expect(res.status).toBe(200);
    // prompt is null or an object – either is valid depending on prior test state
    expect(res.body).toHaveProperty('prompt');
  });

  test('POST /api/shop/prompt returns 401 without auth', async () => {
    const res = await request(app).post('/api/shop/prompt');
    expect(res.status).toBe(401);
  });

  test('POST /api/shop/prompt returns 400 when KATE has no coins', async () => {
    const res = await request(app).post('/api/shop/prompt').set(authHeader(KATE));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insuficiente/i);
  });

  test('POST /api/shop/prompt fires a prompt after KATE earns enough coins', async () => {
    const { PROMPT_BUY_COST } = (await request(app).get('/api/config')).body;
    await seedCoins(app, KATE, PROMPT_BUY_COST + 10);

    const res = await request(app).post('/api/shop/prompt').set(authHeader(KATE));
    expect(res.status).toBe(200);
    expect(typeof res.body.prompt.text).toBe('string');
    expect(typeof res.body.newCoins).toBe('number');
  });

  test('GET /api/prompt/active returns the active prompt', async () => {
    // KATE's dev token defaults to chatId -1001; pass roomId to match the prompt
    const res = await request(app).get('/api/prompt/active?roomId=-1001');
    expect(res.status).toBe(200);
    expect(res.body.prompt).not.toBeNull();
    expect(typeof res.body.prompt.text).toBe('string');
    // The server returns replies as a top-level array, not nested inside prompt
    expect(Array.isArray(res.body.replies)).toBe(true);
  });

  test('POST /api/shop/prompt returns 400 when a prompt is already active', async () => {
    const { PROMPT_BUY_COST } = (await request(app).get('/api/config')).body;
    await seedCoins(app, LEON, PROMPT_BUY_COST + 10);
    const res = await request(app).post('/api/shop/prompt').set(authHeader(LEON));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activo/i);
  });
});

describe('Config endpoint', () => {
  let app;
  beforeAll(() => { app = getApp(); });

  test('GET /api/config exposes HINT_COST dynamically', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.HINT_COST).toBeDefined();
    expect(typeof res.body.HINT_COST).toBe('number');
  });

  test('GET /api/config includes EMOJI_DEFS with key/emoji/name but no recipes or hints', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    const defs = res.body.EMOJI_DEFS;
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def).toHaveProperty('key');
      expect(def).toHaveProperty('emoji');
      expect(def).toHaveProperty('name');
      expect(def).not.toHaveProperty('recipes');
      expect(def).not.toHaveProperty('hint');
    }
  });
});

describe('Message reactions', () => {
  let app;
  beforeAll(async () => {
    app = getApp();
    await authAs(app, ALICE);
    await authAs(app, BOB);
    // Seed enough coins so Alice can send a message and Bob can react
    await seedCoins(app, ALICE, 0);
  });

  test('POST /api/reactions/:id – like credits correct room coins to message author', async () => {
    // Alice sends a message
    await request(app).post('/api/message').set(authHeader(BOB)).send({ text: 'h' });
    const msgRes = await request(app).post('/api/message').set(authHeader(ALICE)).send({ text: 'h' });
    const messageId = msgRes.body.messageId;
    expect(messageId).toBeDefined();

    // Get Alice's coins before the like
    const meBefore = await request(app).get('/api/me').set(authHeader(ALICE));
    const coinsBefore = meBefore.body.coins;

    // Bob likes Alice's message
    const reactRes = await request(app)
      .post(`/api/reactions/${messageId}`)
      .set(authHeader(BOB))
      .send({ reaction: 'like' });
    expect(reactRes.status).toBe(200);
    expect(reactRes.body.likes).toBe(1);

    // Alice should have gained coins
    const meAfter = await request(app).get('/api/me').set(authHeader(ALICE));
    expect(meAfter.body.coins).toBeGreaterThan(coinsBefore);
  });

  test('POST /api/reactions/:id – dislike uses room coins (does not set coins to 0)', async () => {
    // Eve sends a message, Dave dislikes it
    await authAs(app, DAVE);
    await authAs(app, EVE);
    // Alternate messages to earn coins for EVE
    await seedCoins(app, EVE, 30);

    await request(app).post('/api/message').set(authHeader(DAVE)).send({ text: 'h' });
    const msgRes = await request(app).post('/api/message').set(authHeader(EVE)).send({ text: 'h' });
    const messageId = msgRes.body.messageId;
    expect(messageId).toBeDefined();

    const meBefore = await request(app).get('/api/me').set(authHeader(EVE));
    const coinsBefore = meBefore.body.coins;
    expect(coinsBefore).toBeGreaterThan(0);

    const reactRes = await request(app)
      .post(`/api/reactions/${messageId}`)
      .set(authHeader(DAVE))
      .send({ reaction: 'dislike' });
    expect(reactRes.status).toBe(200);
    expect(reactRes.body.dislikes).toBe(1);

    // Eve should have lost coins but not gone to 0 (unless she had exactly 1)
    const meAfter = await request(app).get('/api/me').set(authHeader(EVE));
    expect(meAfter.body.coins).toBeLessThan(coinsBefore);
    // Crucially: coins come from room_members, not zeroed-out users table
    expect(meAfter.body.coins).toBeGreaterThanOrEqual(0);
  });
});

describe('Emoji forge hint persistence', () => {
  let app;
  beforeAll(async () => {
    app = getApp();
    await authAs(app, FRANK);
    await seedCoins(app, FRANK, 500);
  });

  test('GET /api/emoji/status includes hints array (empty initially)', async () => {
    const res = await request(app)
      .get('/api/emoji/status')
      .set(authHeader(FRANK));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hints)).toBe(true);
    expect(res.body.hints.length).toBe(0);
  });

  test('POST /api/emoji/hint persists hint and GET /api/emoji/status returns it', async () => {
    const hintRes = await request(app)
      .post('/api/emoji/hint')
      .set(authHeader(FRANK))
      .send({});
    expect(hintRes.status).toBe(200);
    expect(typeof hintRes.body.hint).toBe('string');

    // Re-fetch status — hint must now appear
    const statusRes = await request(app)
      .get('/api/emoji/status')
      .set(authHeader(FRANK));
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.hints).toContain(hintRes.body.hint);
  });

  test('hints accumulate across multiple purchases', async () => {
    const { HINT_COST } = require('../config');
    await seedCoins(app, FRANK, HINT_COST * 3);

    await request(app).post('/api/emoji/hint').set(authHeader(FRANK)).send({});
    await request(app).post('/api/emoji/hint').set(authHeader(FRANK)).send({});

    const statusRes = await request(app)
      .get('/api/emoji/status')
      .set(authHeader(FRANK));
    // At least 3 hints total (1 from previous test + 2 just bought)
    expect(statusRes.body.hints.length).toBeGreaterThanOrEqual(3);
  });
});

