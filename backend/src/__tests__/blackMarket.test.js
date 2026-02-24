'use strict';

/**
 * blackMarket.test.js
 * ────────────────────
 * Unit tests for the black market heat engine (blackMarketHeat.js).
 * All DB interactions are mocked.
 */

// ── Mock the DB layer ─────────────────────────────────────────────────────────
const mockStmts = {
  getState:                      { get: jest.fn() },
  setState:                      { run: jest.fn() },
  getAllOpenBmListingsGlobal:     { all: jest.fn() },
  resolveBmListing:              { run: jest.fn() },
  updateCoins:                   { run: jest.fn() },
  updateInventory:               { run: jest.fn() },
  getUser:                       { get: jest.fn() },
};

jest.mock('../db/database', () => ({
  db: { transaction: jest.fn() },
  stmts: mockStmts,
  requireUser: jest.fn(),
}));

const { getCurrentHeat, addHeat, catchProbability, runCatchCheck } =
  require('../engine/blackMarketHeat');
const { db, stmts } = require('../db/database');
const config = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return {
    id: 1,
    coins: 200,
    inventory_json: JSON.stringify({ a: 2 }),
    ...overrides,
  };
}

function makeListing(overrides = {}) {
  return {
    id: 1,
    seller_id: 10,
    letter: 'a',
    price: 30,
    status: 'open',
    listed_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  db.transaction.mockImplementation((fn) => () => fn());
  // Default: no stored heat
  stmts.getState.get.mockReturnValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// getCurrentHeat
// ─────────────────────────────────────────────────────────────────────────────
describe('getCurrentHeat', () => {
  test('returns 0 when no heat is stored', () => {
    stmts.getState.get.mockReturnValue(undefined);
    expect(getCurrentHeat()).toBe(0);
  });

  test('returns stored heat when no time has elapsed', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stmts.getState.get
      .mockReturnValueOnce({ value: '60' })    // bm_heat
      .mockReturnValueOnce({ value: String(nowSec) }); // bm_heat_ts
    expect(getCurrentHeat()).toBeCloseTo(60, 0);
  });

  test('applies decay based on elapsed time', () => {
    const minutesAgo = 5;
    const ts = Math.floor(Date.now() / 1000) - minutesAgo * 60;
    stmts.getState.get
      .mockReturnValueOnce({ value: '60' })
      .mockReturnValueOnce({ value: String(ts) });
    // Expected: 60 - 3 * 5 = 45
    expect(getCurrentHeat()).toBeCloseTo(45, 0);
  });

  test('clamps decayed heat to 0', () => {
    const ts = Math.floor(Date.now() / 1000) - 100 * 60; // 100 min ago
    stmts.getState.get
      .mockReturnValueOnce({ value: '10' }) // only 10 heat, decays to 0 in ~3 min
      .mockReturnValueOnce({ value: String(ts) });
    expect(getCurrentHeat()).toBe(0);
  });

  test('clamps to BM_HEAT_MAX', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stmts.getState.get
      .mockReturnValueOnce({ value: String(config.BM_HEAT_MAX + 999) })
      .mockReturnValueOnce({ value: String(nowSec) });
    expect(getCurrentHeat()).toBe(config.BM_HEAT_MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addHeat
// ─────────────────────────────────────────────────────────────────────────────
describe('addHeat', () => {
  test('persists new heat and returns the value', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stmts.getState.get
      .mockReturnValueOnce({ value: '40' })
      .mockReturnValueOnce({ value: String(nowSec) });

    const result = addHeat(20);

    expect(result).toBeCloseTo(60, 0);
    expect(stmts.setState.run).toHaveBeenCalledWith('bm_heat', expect.any(String));
    expect(stmts.setState.run).toHaveBeenCalledWith('bm_heat_ts', expect.any(String));
  });

  test('clamps to BM_HEAT_MAX', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stmts.getState.get
      .mockReturnValueOnce({ value: '90' })
      .mockReturnValueOnce({ value: String(nowSec) });

    const result = addHeat(50); // would be 140 without clamp
    expect(result).toBe(config.BM_HEAT_MAX);
  });

  test('clamps to 0 (no negative heat)', () => {
    stmts.getState.get.mockReturnValue(undefined); // heat = 0
    const result = addHeat(-99);
    expect(result).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// catchProbability
// ─────────────────────────────────────────────────────────────────────────────
describe('catchProbability', () => {
  test('at heat=0 equals BM_BASE_CATCH_PROB', () => {
    expect(catchProbability(0)).toBeCloseTo(config.BM_BASE_CATCH_PROB);
  });

  test('at heat=100 equals BM_BASE_CATCH_PROB + BM_HEAT_CATCH_SCALE', () => {
    expect(catchProbability(config.BM_HEAT_MAX)).toBeCloseTo(
      config.BM_BASE_CATCH_PROB + config.BM_HEAT_CATCH_SCALE
    );
  });

  test('at heat=50 is midpoint between min and max', () => {
    const expected = config.BM_BASE_CATCH_PROB + config.BM_HEAT_CATCH_SCALE * 0.5;
    expect(catchProbability(50)).toBeCloseTo(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runCatchCheck
// ─────────────────────────────────────────────────────────────────────────────
describe('runCatchCheck', () => {
  test('returns empty arrays and current heat when no open listings', () => {
    stmts.getAllOpenBmListingsGlobal.all.mockReturnValue([]);
    const result = runCatchCheck();
    expect(result.caught).toEqual([]);
    expect(result.expired).toEqual([]);
    expect(result.heat).toBeGreaterThanOrEqual(0);
  });

  test('expires a listing older than BM_LISTING_EXPIRY_SEC and returns letter to seller', () => {
    const oldListedAt = Math.floor(Date.now() / 1000) - config.BM_LISTING_EXPIRY_SEC - 60;
    const listing = makeListing({ id: 5, seller_id: 10, letter: 'b', listed_at: oldListedAt });
    const seller  = makeUser({ id: 10, inventory_json: JSON.stringify({ b: 1 }) });

    stmts.getAllOpenBmListingsGlobal.all.mockReturnValue([listing]);
    stmts.getUser.get.mockReturnValue(seller);

    const result = runCatchCheck();

    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]).toMatchObject({ sellerId: 10, letter: 'b', listingId: 5 });
    expect(result.caught).toHaveLength(0);

    // Letter returned to seller
    expect(stmts.updateInventory.run).toHaveBeenCalledWith(
      JSON.stringify({ b: 2 }), 10
    );
    expect(stmts.resolveBmListing.run).toHaveBeenCalledWith(
      'expired', null, expect.any(Number), 5
    );
    // No coins deducted
    expect(stmts.updateCoins.run).not.toHaveBeenCalled();
  });

  test('catches a seller when Math.random is below catch probability', () => {
    const listing = makeListing({ id: 7, seller_id: 20, letter: 'c' });

    stmts.getAllOpenBmListingsGlobal.all.mockReturnValue([listing]);
    // Force catch: Math.random returns a value below any catch probability
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const result = runCatchCheck();

    expect(result.caught).toHaveLength(1);
    expect(result.caught[0]).toMatchObject({
      sellerId: 20, letter: 'c', fine: config.BM_CATCH_FINE, listingId: 7,
    });
    expect(result.expired).toHaveLength(0);

    expect(stmts.updateCoins.run).toHaveBeenCalledWith(-config.BM_CATCH_FINE, 20);
    expect(stmts.resolveBmListing.run).toHaveBeenCalledWith(
      'caught', null, expect.any(Number), 7
    );
    // Heat increased
    expect(stmts.setState.run).toHaveBeenCalledWith('bm_heat', expect.any(String));

    Math.random.mockRestore();
  });

  test('does not catch seller when Math.random is above catch probability', () => {
    const listing = makeListing({ id: 8, seller_id: 30, letter: 'd' });
    stmts.getAllOpenBmListingsGlobal.all.mockReturnValue([listing]);
    // Force no catch: Math.random returns 1 (above any probability)
    jest.spyOn(Math, 'random').mockReturnValue(1);

    const result = runCatchCheck();

    expect(result.caught).toHaveLength(0);
    expect(result.expired).toHaveLength(0);
    expect(stmts.updateCoins.run).not.toHaveBeenCalled();
    expect(stmts.resolveBmListing.run).not.toHaveBeenCalled();

    Math.random.mockRestore();
  });

  test('heat increases by BM_HEAT_CATCH_INCREMENT per caught seller', () => {
    const listings = [
      makeListing({ id: 1, seller_id: 11, letter: 'e' }),
      makeListing({ id: 2, seller_id: 12, letter: 'f' }),
    ];
    stmts.getAllOpenBmListingsGlobal.all.mockReturnValue(listings);
    jest.spyOn(Math, 'random').mockReturnValue(0); // always caught

    const result = runCatchCheck();

    expect(result.caught).toHaveLength(2);
    // Heat should have been written (the state was 0 + 2 * increment)
    const setHeatCall = stmts.setState.run.mock.calls.find((c) => c[0] === 'bm_heat');
    expect(Number(setHeatCall[1])).toBeCloseTo(config.BM_HEAT_CATCH_INCREMENT * 2, 0);

    Math.random.mockRestore();
  });
});
