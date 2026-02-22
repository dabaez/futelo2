'use strict';

/**
 * mining.test.js
 * ──────────────
 * Unit tests for the letter-mining engine (buyPickaxe + swing).
 * All DB interactions are mocked – no SQLite file is needed.
 */

// ── Mock the DB layer ─────────────────────────────────────────────────────────
const mockStmts = {
  getUser:         { get: jest.fn() },
  updateCoins:     { run: jest.fn() },
  addPickaxeHits:  { run: jest.fn() },
  usePickaxeHit:   { run: jest.fn() },
  updateInventory: { run: jest.fn() },
};

jest.mock('../db/database', () => ({
  db:          { transaction: jest.fn() },
  stmts:       mockStmts,
  requireUser: jest.fn(),
}));

// Import engine AFTER the mock is set up
const { buyPickaxe, swing } = require('../engine/mining');
const { db, stmts, requireUser } = require('../db/database');
const {
  PICKAXE_COST,
  PICKAXE_HITS,
  MINE_HIT_CHANCE,
  MAX_LETTER_LEVEL,
} = require('../config');

// Letter alphabet as defined in mining.js (used to reason about index→letter mapping)
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeUser(overrides = {}) {
  return {
    id:             1,
    username:       'alice',
    first_name:     'Alice',
    coins:          200,
    inventory_json: JSON.stringify({ a: 3 }),
    pickaxe_hits:   0,
    streak_count:   0,
    message_count:  1,
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Make db.transaction a synchronous passthrough (mirrors better-sqlite3 API):
  //   db.transaction(fn)() immediately calls fn()
  db.transaction.mockImplementation((fn) => (...args) => fn(...args));
});

// ─────────────────────────────────────────────────────────────────────────────
// buyPickaxe
// ─────────────────────────────────────────────────────────────────────────────
describe('buyPickaxe', () => {
  test('throws when the user has fewer coins than PICKAXE_COST', () => {
    requireUser.mockReturnValue(makeUser({ coins: PICKAXE_COST - 1 }));
    expect(() => buyPickaxe(1)).toThrow(/insuficiente/i);
  });

  test('throws at exactly zero coins', () => {
    requireUser.mockReturnValue(makeUser({ coins: 0 }));
    expect(() => buyPickaxe(1)).toThrow(/insuficiente/i);
  });

  test('deducts PICKAXE_COST from coins', () => {
    const user = makeUser({ coins: 100, pickaxe_hits: 0 });
    requireUser.mockReturnValue(user);
    stmts.getUser.get.mockReturnValue({
      ...user,
      coins:        100 - PICKAXE_COST,
      pickaxe_hits: PICKAXE_HITS,
    });

    buyPickaxe(1);

    expect(stmts.updateCoins.run).toHaveBeenCalledWith(-PICKAXE_COST, 1);
  });

  test('adds PICKAXE_HITS swings to the user', () => {
    const user = makeUser({ coins: 100, pickaxe_hits: 0 });
    requireUser.mockReturnValue(user);
    stmts.getUser.get.mockReturnValue({
      ...user,
      coins:        100 - PICKAXE_COST,
      pickaxe_hits: PICKAXE_HITS,
    });

    buyPickaxe(1);

    expect(stmts.addPickaxeHits.run).toHaveBeenCalledWith(PICKAXE_HITS, 1);
  });

  test('returns newCoins and pickaxeHits read from the fresh DB row', () => {
    const user = makeUser({ coins: 100, pickaxe_hits: 0 });
    const freshCoins = 100 - PICKAXE_COST;
    const freshHits  = PICKAXE_HITS;
    requireUser.mockReturnValue(user);
    stmts.getUser.get.mockReturnValue({
      ...user,
      coins:        freshCoins,
      pickaxe_hits: freshHits,
    });

    const result = buyPickaxe(1);

    expect(result).toEqual({ newCoins: freshCoins, pickaxeHits: freshHits });
  });

  test('stacks hits when buying multiple pickaxes', () => {
    // Simulate a user who already has PICKAXE_HITS from a prior purchase
    const user = makeUser({ coins: 100, pickaxe_hits: PICKAXE_HITS });
    requireUser.mockReturnValue(user);
    const expectedHits = PICKAXE_HITS * 2;
    stmts.getUser.get.mockReturnValue({
      ...user,
      coins:        100 - PICKAXE_COST,
      pickaxe_hits: expectedHits,
    });

    const result = buyPickaxe(1);

    expect(result.pickaxeHits).toBe(expectedHits);
  });

  test('wraps all DB writes in a single transaction', () => {
    requireUser.mockReturnValue(makeUser({ coins: 100 }));
    stmts.getUser.get.mockReturnValue(
      makeUser({ coins: 100 - PICKAXE_COST, pickaxe_hits: PICKAXE_HITS }),
    );

    buyPickaxe(1);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// swing
// ─────────────────────────────────────────────────────────────────────────────
describe('swing', () => {
  test('throws when the user has no pickaxe hits left', () => {
    requireUser.mockReturnValue(makeUser({ pickaxe_hits: 0 }));
    expect(() => swing(1)).toThrow(/golpes restantes/i);
  });

  test('always decrements the hit counter via usePickaxeHit', () => {
    requireUser.mockReturnValue(makeUser({ pickaxe_hits: 3 }));
    stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 2 }));
    jest.spyOn(Math, 'random').mockReturnValue(0.99); // guaranteed miss

    swing(1);

    expect(stmts.usePickaxeHit.run).toHaveBeenCalledWith(1);
    Math.random.mockRestore();
  });

  test('hitsLeft in the result reflects the fresh DB counter', () => {
    requireUser.mockReturnValue(makeUser({ pickaxe_hits: 7 }));
    stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 6 }));
    jest.spyOn(Math, 'random').mockReturnValue(0.99); // miss

    const result = swing(1);

    expect(result.hitsLeft).toBe(6);
    Math.random.mockRestore();
  });

  test('wraps DB writes in a single transaction', () => {
    requireUser.mockReturnValue(makeUser({ pickaxe_hits: 2 }));
    stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 1 }));
    jest.spyOn(Math, 'random').mockReturnValue(0.99); // miss

    swing(1);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    Math.random.mockRestore();
  });

  // ── Miss path ──────────────────────────────────────────────────────────────
  describe('miss (Math.random >= MINE_HIT_CHANCE)', () => {
    beforeEach(() => {
      // A value equal to MINE_HIT_CHANCE is NOT < MINE_HIT_CHANCE → miss
      jest.spyOn(Math, 'random').mockReturnValue(MINE_HIT_CHANCE);
    });
    afterEach(() => { Math.random.mockRestore(); });

    test('returns found=false, letter=null, newInventory=null', () => {
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 5 }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 4 }));

      const result = swing(1);

      expect(result.found).toBe(false);
      expect(result.letter).toBeNull();
      expect(result.newInventory).toBeNull();
    });

    test('does NOT call updateInventory on a miss', () => {
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 3 }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 2 }));

      swing(1);

      expect(stmts.updateInventory.run).not.toHaveBeenCalled();
    });
  });

  // ── Hit path ───────────────────────────────────────────────────────────────
  describe('hit (Math.random < MINE_HIT_CHANCE)', () => {
    beforeEach(() => {
      // First call: Math.random() < MINE_HIT_CHANCE → 0 is always a hit
      // Second call: selects the letter from ALPHABET; 0 → index 0 → 'a'
      jest.spyOn(Math, 'random')
        .mockReturnValueOnce(0)   // hit check
        .mockReturnValueOnce(0);  // letter selection → 'a'
    });
    afterEach(() => { Math.random.mockRestore(); });

    test('returns found=true with a non-null letter string', () => {
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 5, inventory_json: JSON.stringify({ a: 2 }) }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 4, inventory_json: JSON.stringify({ a: 3 }) }));

      const result = swing(1);

      expect(result.found).toBe(true);
      expect(typeof result.letter).toBe('string');
      expect(result.letter.length).toBeGreaterThanOrEqual(1);
    });

    test('grants the found letter: newInventory has incremented level', () => {
      const invBefore = { a: 2 };
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 5, inventory_json: JSON.stringify(invBefore) }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 4, inventory_json: JSON.stringify(invBefore) }));

      const result = swing(1);

      // Letter is 'a' (first in ALPHABET when random=0); level goes from 2→3
      expect(result.letter).toBe('a');
      expect(result.newInventory['a']).toBe(3);
    });

    test('calls updateInventory with the updated JSON string', () => {
      const invBefore = { a: 2 };
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 5, inventory_json: JSON.stringify(invBefore) }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 4, inventory_json: JSON.stringify(invBefore) }));

      swing(1);

      expect(stmts.updateInventory.run).toHaveBeenCalledWith(
        JSON.stringify({ a: 3 }),
        1,
      );
    });

    test('caps the found letter level at MAX_LETTER_LEVEL', () => {
      const invFull = { a: MAX_LETTER_LEVEL };
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 5, inventory_json: JSON.stringify(invFull) }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 4, inventory_json: JSON.stringify(invFull) }));

      const result = swing(1);

      expect(result.found).toBe(true);
      expect(result.letter).toBe('a');
      expect(result.newInventory['a']).toBe(MAX_LETTER_LEVEL); // must not exceed cap
    });

    test('adds a new letter key to inventory if not previously owned', () => {
      const invBefore = {};
      requireUser.mockReturnValue(makeUser({ pickaxe_hits: 5, inventory_json: JSON.stringify(invBefore) }));
      stmts.getUser.get.mockReturnValue(makeUser({ pickaxe_hits: 4, inventory_json: JSON.stringify(invBefore) }));

      const result = swing(1);

      expect(result.letter).toBe('a');
      expect(result.newInventory['a']).toBe(1);
    });
  });
});
