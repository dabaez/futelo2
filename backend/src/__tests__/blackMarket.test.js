'use strict';

// ── Mock setup ───────────────────────────────────────────────────────────────
// jest.mock is hoisted before imports, but factories are lazy (run on first
// require). Declaring these variables beforehand lets the factory assign them.

let mockTransaction;
let mockRequireUser;

const mockStmts = {
  getUser:              { get: jest.fn() },
  updateCoins:          { run: jest.fn() },
  updateInventory:      { run: jest.fn() },
  getState:             { get: jest.fn() },
  setState:             { run: jest.fn() },
  getActiveBmListing:   { get: jest.fn() },
  insertBmListing:      { run: jest.fn() },
  getBmListing:         { get: jest.fn() },
  getPendingBmListings:  { all: jest.fn() },
  getExpiredBmListings:  { all: jest.fn() },
  resolveBmListing:     { run: jest.fn() },
  getUserBmListings:    { all: jest.fn() },
};

jest.mock('../db/database', () => {
  mockTransaction = jest.fn();
  mockRequireUser = jest.fn();
  return {
    db:          { transaction: mockTransaction },
    stmts:       mockStmts,
    requireUser: mockRequireUser,
  };
});

const {
  getHeat,
  catchProbForHeat,
  addMentionHeat,
  listLetter,
  collectListing,
  sweepCatchRolls,
} = require('../engine/blackMarket');

const {
  BLACK_MARKET_BASE_PROB,
  BLACK_MARKET_MAX_PROB,
  HEAT_MENTION_INCREMENT,
  HEAT_CATCH_INCREMENT,
  HEAT_DECAY_RATE,
  HEAT_MAX,
  SELL_BASE_PRICE,
  BLACK_MARKET_FINE,
} = require('../config');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return {
    id:              1001,
    username:        'alice',
    first_name:      'Alice',
    coins:           100,
    inventory_json:  '{}',
    ...overrides,
  };
}

function makeListing(overrides = {}) {
  return {
    id:          42,
    user_id:     1001,
    letter:      'a',
    listed_at:   Math.floor(Date.now() / 1000) - 60,
    status:      'pending',
    ...overrides,
  };
}

// ── Default mocks before each test ──────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
  // transaction(fn) returns a callable that invokes fn() synchronously
  mockTransaction.mockImplementation((fn) => () => fn());
  // BM listing insert returns a rowid
  mockStmts.insertBmListing.run.mockReturnValue({ lastInsertRowid: 42 });
  // heat is 0 by default (no row)
  mockStmts.getState.get.mockReturnValue(null);
  // no duplicate listing by default
  mockStmts.getActiveBmListing.get.mockReturnValue(null);
  // empty sweep queues
  mockStmts.getPendingBmListings.all.mockReturnValue([]);
  mockStmts.getExpiredBmListings.all.mockReturnValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Heat helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('getHeat()', () => {
  test('returns 0 when there is no row in game_state', () => {
    mockStmts.getState.get.mockReturnValue(null);
    expect(getHeat()).toBe(0);
  });

  test('returns the parsed float when a row exists', () => {
    mockStmts.getState.get.mockReturnValue({ value: '0.45' });
    expect(getHeat()).toBeCloseTo(0.45);
  });

  test('clamps to HEAT_MAX (1.0) when stored value exceeds it', () => {
    mockStmts.getState.get.mockReturnValue({ value: '9.99' });
    expect(getHeat()).toBe(HEAT_MAX);
  });
});

describe('catchProbForHeat()', () => {
  test('equals BASE_PROB at heat = 0', () => {
    expect(catchProbForHeat(0)).toBeCloseTo(BLACK_MARKET_BASE_PROB);
  });

  test('increases as heat rises', () => {
    expect(catchProbForHeat(0.5)).toBeGreaterThan(catchProbForHeat(0));
  });

  test('is capped at BLACK_MARKET_MAX_PROB', () => {
    // At heat = 1.0 the formula gives 0.04 * 16 = 0.64, well below 0.80.
    // Force a value that would exceed max: heat = 10 → 0.04 * 151 = 6.04 → capped.
    expect(catchProbForHeat(10)).toBe(BLACK_MARKET_MAX_PROB);
  });
});

describe('addMentionHeat()', () => {
  test('increments heat by HEAT_MENTION_INCREMENT and calls setState', () => {
    mockStmts.getState.get.mockReturnValue({ value: '0.20' });
    addMentionHeat();
    const [key, val] = mockStmts.setState.run.mock.calls[0];
    expect(key).toBe('black_market_heat');
    expect(parseFloat(val)).toBeCloseTo(0.20 + HEAT_MENTION_INCREMENT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listLetter()
// ─────────────────────────────────────────────────────────────────────────────

describe('listLetter()', () => {
  test('throws on an invalid letter character', () => {
    expect(() => listLetter(1001, '!')).toThrow(/inválida/i);
  });

  test('throws when the user has no inventory level for that letter', () => {
    mockRequireUser.mockReturnValue(makeUser({ inventory_json: '{}' }));
    expect(() => listLetter(1001, 'a')).toThrow(/no tienes/i);
  });

  test('throws when the user already has an active listing for that letter', () => {
    mockRequireUser.mockReturnValue(makeUser({ inventory_json: '{"a":2}' }));
    mockStmts.getActiveBmListing.get.mockReturnValue(makeListing());
    expect(() => listLetter(1001, 'a')).toThrow(/ya tienes/i);
  });

  test('deducts one level from the letter (a:2 → a:1)', () => {
    mockRequireUser.mockReturnValue(makeUser({ inventory_json: '{"a":2}' }));
    const result = listLetter(1001, 'a');
    expect(result.newInventory).toEqual({ a: 1 });
  });

  test('removes the letter key when level drops to 0 (a:1 → deleted)', () => {
    mockRequireUser.mockReturnValue(makeUser({ inventory_json: '{"a":1}' }));
    const result = listLetter(1001, 'a');
    expect(result.newInventory).not.toHaveProperty('a');
  });

  test('returns listingId, letter, heat, and catchProbPerMin', () => {
    mockRequireUser.mockReturnValue(makeUser({ inventory_json: '{"b":3}' }));
    const result = listLetter(1001, 'b');
    expect(result.listingId).toBe(42);
    expect(result.letter).toBe('b');
    expect(typeof result.heat).toBe('number');
    expect(typeof result.catchProbPerMin).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectListing()
// ─────────────────────────────────────────────────────────────────────────────

describe('collectListing()', () => {
  test('throws when the listing does not exist', () => {
    mockStmts.getBmListing.get.mockReturnValue(null);
    expect(() => collectListing(1001, 99)).toThrow(/no encontrado/i);
  });

  test('throws when the listing belongs to a different user', () => {
    mockStmts.getBmListing.get.mockReturnValue(
      makeListing({ user_id: 9999 })
    );
    expect(() => collectListing(1001, 42)).toThrow(/no es tu/i);
  });

  test('throws with "ya cobrado" when status is collected', () => {
    mockStmts.getBmListing.get.mockReturnValue(
      makeListing({ status: 'collected' })
    );
    expect(() => collectListing(1001, 42)).toThrow(/ya cobrado/i);
  });

  test('throws with "confiscado" when status is caught', () => {
    mockStmts.getBmListing.get.mockReturnValue(
      makeListing({ status: 'caught' })
    );
    expect(() => collectListing(1001, 42)).toThrow(/confiscado/i);
  });

  test('awards SELL_BASE_PRICE coins and resolves the listing as collected', () => {
    const userAfter = makeUser({ coins: 100 + SELL_BASE_PRICE });
    mockStmts.getBmListing.get.mockReturnValue(makeListing({ status: 'pending' }));
    mockStmts.getUser.get.mockReturnValue(userAfter);

    const result = collectListing(1001, 42);

    // Correct resolution status
    expect(mockStmts.resolveBmListing.run).toHaveBeenCalledWith(
      'collected',
      SELL_BASE_PRICE,
      expect.any(Number),
      42
    );
    // Coins credited
    expect(mockStmts.updateCoins.run).toHaveBeenCalledWith(SELL_BASE_PRICE, 1001);
    // Return value
    expect(result.earned).toBe(SELL_BASE_PRICE);
    expect(result.newCoins).toBe(userAfter.coins);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepCatchRolls()
// ─────────────────────────────────────────────────────────────────────────────

describe('sweepCatchRolls()', () => {
  test('returns empty arrays when there are no pending or expired listings', () => {
    const result = sweepCatchRolls();
    expect(result).toEqual({ caught: [], expired: [] });
  });

  test('expires a stale listing and returns the letter to inventory', () => {
    const listing = makeListing({ listed_at: 0 }); // ancient listing
    mockStmts.getExpiredBmListings.all.mockReturnValue([listing]);
    mockStmts.getUser.get.mockReturnValue(makeUser({ inventory_json: '{}' }));

    const result = sweepCatchRolls();

    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].letter).toBe('a');
    expect(mockStmts.resolveBmListing.run).toHaveBeenCalledWith(
      'expired', 0, expect.any(Number), listing.id
    );
    // Letter must have been returned to the inventory
    const savedInv = JSON.parse(
      mockStmts.updateInventory.run.mock.calls[0][0]
    );
    expect(savedInv.a).toBe(1);
  });

  test('decays heat each sweep cycle', () => {
    mockStmts.getState.get.mockReturnValue({ value: '1.0' });

    sweepCatchRolls();

    // After decay: setState should be called with heat * HEAT_DECAY_RATE
    const calls = mockStmts.setState.run.mock.calls;
    const heatCall = calls.find(([key]) => key === 'black_market_heat');
    expect(heatCall).toBeDefined();
    expect(parseFloat(heatCall[1])).toBeCloseTo(1.0 * HEAT_DECAY_RATE);
  });

  test('catches a pending listing when Math.random() returns 0', () => {
    const listing = makeListing();
    mockStmts.getPendingBmListings.all.mockReturnValue([listing]);
    mockStmts.getUser.get.mockReturnValue(makeUser({ coins: 60 }));

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = sweepCatchRolls();
    spy.mockRestore();

    expect(result.caught).toHaveLength(1);
    expect(result.caught[0].listingId).toBe(listing.id);
    expect(mockStmts.resolveBmListing.run).toHaveBeenCalledWith(
      'caught', -BLACK_MARKET_FINE, expect.any(Number), listing.id
    );
    expect(mockStmts.updateCoins.run).toHaveBeenCalledWith(-BLACK_MARKET_FINE, listing.user_id);
  });

  test('does not catch a listing when Math.random() returns 0.99 and heat is 0', () => {
    // At heat=0 catch prob ≈ 4 %, so 0.99 is always safe.
    const listing = makeListing();
    mockStmts.getPendingBmListings.all.mockReturnValue([listing]);

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
    const result = sweepCatchRolls();
    spy.mockRestore();

    expect(result.caught).toHaveLength(0);
  });

  test('increments global heat when a listing is caught', () => {
    const listing = makeListing();
    mockStmts.getPendingBmListings.all.mockReturnValue([listing]);
    mockStmts.getUser.get.mockReturnValue(makeUser({ coins: 60 }));
    // heat starts at 0 after decay
    mockStmts.getState.get.mockReturnValue(null);

    const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
    sweepCatchRolls();
    spy.mockRestore();

    // setState should have been called at least twice: once for decay, once for catch spike
    const heatVals = mockStmts.setState.run.mock.calls
      .filter(([key]) => key === 'black_market_heat')
      .map(([, val]) => parseFloat(val));
    // The last heat value should be higher than (0 * HEAT_DECAY_RATE) because of the spike
    const lastHeat = heatVals[heatVals.length - 1];
    expect(lastHeat).toBeGreaterThan(0);
    expect(lastHeat).toBeCloseTo(HEAT_CATCH_INCREMENT);
  });
});
