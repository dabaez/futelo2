'use strict';

/**
 * market.test.js
 * ──────────────
 * Unit tests for the P2P letter market engine.
 * All DB interactions are mocked so no SQLite file is needed.
 */

// ── Mock the DB layer ─────────────────────────────────────────────────────────
const mockStmts = {
  insertMarketListing:   { run: jest.fn() },
  getMarketListing:      { get: jest.fn() },
  getOpenMarketListings: { all: jest.fn() },
  resolveMarketListing:  { run: jest.fn() },
  getUserMarketListings: { all: jest.fn() },
  // Black-market stmts
  insertBmListing:       { run: jest.fn() },
  getBmListing:          { get: jest.fn() },
  getOpenBmListings:     { all: jest.fn() },
  resolveBmListing:      { run: jest.fn() },
  getUserBmListings:     { all: jest.fn() },
  updateCoins:           { run: jest.fn() },
  updateInventory:       { run: jest.fn() },
};

jest.mock('../db/database', () => ({
  db: { transaction: jest.fn() },
  stmts: mockStmts,
  requireUser: jest.fn(),
}));

// Import engine AFTER the mock is set up
const { listLetter, buyListing, cancelListing, getOpenListings, getUserListings,
        bmListLetter, bmBuyListing, bmCancelListing, getBmOpenListings, getBmUserListings } =
  require('../engine/market');
const { db, stmts, requireUser } = require('../db/database');
const { MARKET_MAX_PRICE, MAX_LETTER_LEVEL } = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeUser(overrides = {}) {
  return {
    id:             1,
    username:       'alice',
    first_name:     'Alice',
    coins:          200,
    inventory_json: JSON.stringify({ a: 3 }),
    streak_count:   0,
    message_count:  1,
    ...overrides,
  };
}

function makeListing(overrides = {}) {
  return {
    id:        1,
    seller_id: 10,
    letter:    'a',
    price:     50,
    status:    'open',
    listed_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Make db.transaction passthrough — calls fn() immediately and returns its result
  db.transaction.mockImplementation((fn) => (...args) => fn(...args));
});

// ─────────────────────────────────────────────────────────────────────────────
// listLetter
// ─────────────────────────────────────────────────────────────────────────────
describe('listLetter', () => {
  test('throws on an invalid letter key', () => {
    expect(() => listLetter(1, '!', 50)).toThrow(/inválida/i);
    expect(() => listLetter(1, '1', 50)).toThrow(/inválida/i);
  });

  test('throws if price is out of range', () => {
    requireUser.mockReturnValue(makeUser());
    expect(() => listLetter(1, 'a', 0)).toThrow(/precio/i);
    expect(() => listLetter(1, 'a', MARKET_MAX_PRICE + 1)).toThrow(/precio/i);
  });

  test('throws if seller has no inventory for that letter', () => {
    requireUser.mockReturnValue(makeUser({ inventory_json: JSON.stringify({}) }));
    expect(() => listLetter(1, 'a', 50)).toThrow(/inventario/i);
  });

  test('deducts one letter level and inserts a listing', () => {
    const user = makeUser({ inventory_json: JSON.stringify({ a: 2 }) });
    requireUser.mockReturnValue(user);
    stmts.insertMarketListing.run.mockReturnValue({ lastInsertRowid: 42 });

    const result = listLetter(1, 'a', 75);

    expect(result.listingId).toBe(42);
    expect(result.letter).toBe('a');
    expect(result.price).toBe(75);
    expect(result.newInventory.a).toBe(1);
    expect(stmts.updateInventory.run).toHaveBeenCalledWith(
      JSON.stringify({ a: 1 }), 1
    );
    expect(stmts.insertMarketListing.run).toHaveBeenCalledWith(1, 'a', 75);
  });

  test('removes the letter key from inventory when level drops to 0', () => {
    const user = makeUser({ inventory_json: JSON.stringify({ a: 1 }) });
    requireUser.mockReturnValue(user);
    stmts.insertMarketListing.run.mockReturnValue({ lastInsertRowid: 7 });

    const result = listLetter(1, 'a', 30);

    expect(result.newInventory).not.toHaveProperty('a');
  });

  test('works for the _numbers group key', () => {
    const user = makeUser({ inventory_json: JSON.stringify({ _numbers: 3 }) });
    requireUser.mockReturnValue(user);
    stmts.insertMarketListing.run.mockReturnValue({ lastInsertRowid: 5 });

    const result = listLetter(1, '_numbers', 20);

    expect(result.letter).toBe('_numbers');
    expect(result.newInventory._numbers).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buyListing
// ─────────────────────────────────────────────────────────────────────────────
describe('buyListing', () => {
  test('throws if listing not found', () => {
    requireUser.mockReturnValue(makeUser({ id: 99 }));
    stmts.getMarketListing.get.mockReturnValue(null);

    expect(() => buyListing(99, 1)).toThrow(/no encontrado/i);
  });

  test('throws if listing is not open', () => {
    requireUser.mockReturnValue(makeUser({ id: 99 }));
    stmts.getMarketListing.get.mockReturnValue(makeListing({ status: 'sold' }));

    expect(() => buyListing(99, 1)).toThrow(/disponible/i);
  });

  test('throws if buyer is the seller', () => {
    requireUser.mockReturnValue(makeUser({ id: 10 }));
    stmts.getMarketListing.get.mockReturnValue(makeListing({ seller_id: 10 }));

    expect(() => buyListing(10, 1)).toThrow(/propio/i);
  });

  test('throws if buyer has insufficient coins', () => {
    const buyer = makeUser({ id: 99, coins: 10 });
    requireUser.mockReturnValue(buyer);
    stmts.getMarketListing.get.mockReturnValue(makeListing({ seller_id: 10, price: 50 }));

    expect(() => buyListing(99, 1)).toThrow(/insuficiente/i);
  });

  test('transfers coins and grants letter to buyer on success', () => {
    const listing = makeListing({ id: 1, seller_id: 10, letter: 'b', price: 50 });
    const buyer = makeUser({ id: 99, coins: 200, inventory_json: JSON.stringify({ b: 1 }) });
    const buyerUpdated = makeUser({ id: 99, coins: 150, inventory_json: JSON.stringify({ b: 2 }) });

    // requireUser called: outer, buyer (coins check), buyerFresh (inv update), buyerUpdated (final)
    requireUser
      .mockReturnValueOnce(buyer)         // outer validation
      .mockReturnValueOnce(buyer)         // coins check inside txn
      .mockReturnValueOnce(buyer)         // buyerFresh for inventory
      .mockReturnValueOnce(buyerUpdated); // buyerUpdated for return value

    stmts.getMarketListing.get.mockReturnValue(listing);

    const result = buyListing(99, 1);

    expect(stmts.updateCoins.run).toHaveBeenCalledWith(-50, 99);     // deduct from buyer
    expect(stmts.updateCoins.run).toHaveBeenCalledWith( 50, 10);     // credit to seller
    expect(result.letter).toBe('b');
    expect(result.price).toBe(50);
    expect(result.sellerId).toBe(10);
    expect(result.newInventory.b).toBe(2);
    expect(result.newCoins).toBe(150);
  });

  test('caps buyer letter level at MAX_LETTER_LEVEL', () => {
    const listing = makeListing({ seller_id: 10, letter: 'c', price: 10 });
    const inv = { c: MAX_LETTER_LEVEL }; // already at cap
    const buyer = makeUser({ id: 99, coins: 200, inventory_json: JSON.stringify(inv) });
    const buyerUpdated = makeUser({ id: 99, coins: 190, inventory_json: JSON.stringify(inv) });

    requireUser
      .mockReturnValueOnce(buyer)
      .mockReturnValueOnce(buyer)
      .mockReturnValueOnce(buyer)
      .mockReturnValueOnce(buyerUpdated);
    stmts.getMarketListing.get.mockReturnValue(listing);

    const result = buyListing(99, 1);

    expect(result.newInventory.c).toBe(MAX_LETTER_LEVEL); // clamped, not MAX_LETTER_LEVEL + 1
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelListing
// ─────────────────────────────────────────────────────────────────────────────
describe('cancelListing', () => {
  test('throws if listing not found', () => {
    requireUser.mockReturnValue(makeUser({ id: 10 }));
    stmts.getMarketListing.get.mockReturnValue(null);

    expect(() => cancelListing(10, 1)).toThrow(/no encontrado/i);
  });

  test('throws if caller is not the seller', () => {
    requireUser.mockReturnValue(makeUser({ id: 99 }));
    stmts.getMarketListing.get.mockReturnValue(makeListing({ seller_id: 10 }));

    expect(() => cancelListing(99, 1)).toThrow(/cancelar/i);
  });

  test('throws if listing is not open', () => {
    requireUser.mockReturnValue(makeUser({ id: 10 }));
    stmts.getMarketListing.get.mockReturnValue(makeListing({ seller_id: 10, status: 'cancelled' }));

    expect(() => cancelListing(10, 1)).toThrow(/activo/i);
  });

  test('returns letter level to seller and resolves with cancelled status', () => {
    const listing = makeListing({ seller_id: 10, letter: 'a', status: 'open' });
    const seller = makeUser({ id: 10, inventory_json: JSON.stringify({ a: 1 }) });

    requireUser
      .mockReturnValueOnce(seller) // outer validation
      .mockReturnValueOnce(seller); // inside transaction

    stmts.getMarketListing.get.mockReturnValue(listing);

    const result = cancelListing(10, 1);

    expect(result.letter).toBe('a');
    expect(result.newInventory.a).toBe(2); // 1 + returned level
    expect(stmts.resolveMarketListing.run).toHaveBeenCalledWith(
      'cancelled', null, expect.any(Number), 1
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOpenListings / getUserListings
// ─────────────────────────────────────────────────────────────────────────────
describe('getOpenListings', () => {
  test('delegates to stmts.getOpenMarketListings.all', () => {
    const rows = [{ id: 1, letter: 'a', price: 50, seller_username: 'alice' }];
    stmts.getOpenMarketListings.all.mockReturnValue(rows);

    expect(getOpenListings()).toEqual(rows);
    expect(stmts.getOpenMarketListings.all).toHaveBeenCalledTimes(1);
  });
});

describe('getUserListings', () => {
  test('delegates to stmts.getUserMarketListings.all', () => {
    const rows = [{ id: 2, letter: 'b', price: 30, status: 'sold' }];
    stmts.getUserMarketListings.all.mockReturnValue(rows);

    expect(getUserListings(10)).toEqual(rows);
    expect(stmts.getUserMarketListings.all).toHaveBeenCalledWith(10);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Black market — factory produces independent functions
// ────────────────────────────────────────────────────────────────────────────────
describe('Black market (bmListLetter)', () => {
  test('uses BM stmts, not regular market stmts', () => {
    const user = makeUser({ inventory_json: JSON.stringify({ a: 2 }) });
    requireUser.mockReturnValue(user);
    stmts.insertBmListing.run.mockReturnValue({ lastInsertRowid: 99 });

    const result = bmListLetter(1, 'a', 40);

    expect(result.listingId).toBe(99);
    expect(stmts.insertBmListing.run).toHaveBeenCalledWith(1, 'a', 40);
    // Regular stmt must NOT have been called
    expect(stmts.insertMarketListing.run).not.toHaveBeenCalled();
  });

  test('throws on an invalid letter key (same guard as regular market)', () => {
    expect(() => bmListLetter(1, '$', 50)).toThrow(/inválida/i);
  });
});

describe('Black market (getBmOpenListings / getBmUserListings)', () => {
  test('getBmOpenListings delegates to stmts.getOpenBmListings.all', () => {
    const rows = [{ id: 5, letter: 'z', price: 99 }];
    stmts.getOpenBmListings.all.mockReturnValue(rows);

    expect(getBmOpenListings()).toEqual(rows);
    expect(stmts.getOpenBmListings.all).toHaveBeenCalledTimes(1);
    expect(stmts.getOpenMarketListings.all).not.toHaveBeenCalled();
  });

  test('getBmUserListings delegates to stmts.getUserBmListings.all', () => {
    const rows = [{ id: 6, letter: 'x', status: 'open' }];
    stmts.getUserBmListings.all.mockReturnValue(rows);

    expect(getBmUserListings(77)).toEqual(rows);
    expect(stmts.getUserBmListings.all).toHaveBeenCalledWith(77);
    expect(stmts.getUserMarketListings.all).not.toHaveBeenCalled();
  });
});

describe('Black market (bmCancelListing)', () => {
  test('uses BM stmt to resolve and returns letter to seller', () => {
    const listing = makeListing({ seller_id: 10, letter: 'b', status: 'open' });
    const seller = makeUser({ id: 10, inventory_json: JSON.stringify({ b: 1 }) });

    requireUser
      .mockReturnValueOnce(seller)
      .mockReturnValueOnce(seller);
    stmts.getBmListing.get.mockReturnValue(listing);

    const result = bmCancelListing(10, 1);

    expect(result.letter).toBe('b');
    expect(result.newInventory.b).toBe(2);
    expect(stmts.resolveBmListing.run).toHaveBeenCalledWith(
      'cancelled', null, expect.any(Number), 1
    );
    // Regular resolve must NOT have been called
    expect(stmts.resolveMarketListing.run).not.toHaveBeenCalled();
  });
});
