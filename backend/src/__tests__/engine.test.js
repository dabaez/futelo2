'use strict';

/**
 * engine.test.js
 * ──────────────
 * Unit tests for the Futelo game engine.
 * The database module is fully mocked so tests run without any file I/O.
 *
 * What is tested:
 *   • letterRequirements – pure letter-count helper
 *   • processMessage     – Tier 1/2/3 coin economy, inventory validation,
 *                          letter-lock enforcement, transaction structure
 *   • shopRoll           – coin cost, inventory update, insufficient-coins guard
 */

// ── Mock the database module ──────────────────────────────────────────────────
// We define helpers to control initial state per test.

let _user;
let _lastSenderId;
let _locks;

// A transaction mock that immediately invokes the wrapped function and returns
// its output, mirroring better-sqlite3's synchronous transaction API:
//   db.transaction(fn)()
const mockTransaction = jest.fn((fn) => () => fn());

const mockStmts = {
  getRoomMember:             { get: jest.fn() },
  getLocks:                  { all: jest.fn() },
  getState:                  { get: jest.fn() },
  setState:                  { run: jest.fn() },
  updateRoomMember:          { run: jest.fn() },
  updateRoomCoins:           { run: jest.fn() },
  updateRoomInventory:       { run: jest.fn() },
  upsertLock:                { run: jest.fn() },
  cleanLocks:                { run: jest.fn() },
  insertMessage:             { run: jest.fn(() => ({ lastInsertRowid: 1 })) },
  // Default to cnt=1 (not a first message) so standard tier tests work unchanged.
  // Individual tests can override with mockReturnValueOnce({ cnt: 0 }) to test
  // the first-message letter-grant path.
  getRoomMemberMessageCount: { get: jest.fn(() => ({ cnt: 1 })) },
  // Per-room streak tracking (default: no prior streak in room)
  getRoomStreak:             { get: jest.fn(() => null) },
  upsertRoomStreak:          { run: jest.fn() },
};

jest.mock('../db/database', () => ({
  db:                 { transaction: mockTransaction },
  stmts:              mockStmts,
  requireUser:        jest.fn(),
  requireRoomMember:  jest.fn(),
}));

// Import engine AFTER the mock is set up
const { processMessage, shopRoll, letterRequirements } = require('../engine/processMessage');
const { requireUser, requireRoomMember, stmts } = require('../db/database');
const { MAX_LETTER_LEVEL, TIER1_COINS, TIER3_PENALTY, ROLL_COST, LOCK_DURATION_SEC, FIRST_MESSAGE_LETTERS, CAP_OVERFLOW_COINS_PER_LETTER } = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeUser(overrides = {}) {
  return {
    id:             1,
    username:       'alice',
    first_name:     'Alice',
    coins:          100,
    inventory_json: JSON.stringify({ a: 5, b: 3, p: 2, l: 1, e: 2 }),
    streak_count:   0,
    ...overrides,
  };
}

function setupUser(user) {
  _user = user;
  requireUser.mockReturnValue(user);
  requireRoomMember.mockReturnValue(user);
  // Default fresh-read: return the same user so result.newCoins is always defined.
  // Tests that need to assert a specific newCoins value should override this.
  stmts.getRoomMember.get.mockReturnValue(user);
}

function setupGameState({ lastSenderId = null, locks = [] } = {}) {
  _lastSenderId = lastSenderId;
  _locks = locks;
  stmts.getState.get.mockReturnValue(
    lastSenderId !== null ? { value: String(lastSenderId) } : null
  );
  stmts.getLocks.all.mockReturnValue(locks);
}

beforeEach(() => {
  jest.resetAllMocks();   // clears return-value queues AND .mock.calls
  // Default: identity function for transaction (calls fn immediately)
  mockTransaction.mockImplementation((fn) => () => fn());
  // processMessage destructures { lastInsertRowid } from this call
  mockStmts.insertMessage.run.mockReturnValue({ lastInsertRowid: 1 });
  // Default: not a first message (cnt > 0 means the user has sent before)
  mockStmts.getRoomMemberMessageCount.get.mockReturnValue({ cnt: 1 });
  // Default: no prior room streak (treated as 0)
  mockStmts.getRoomStreak.get.mockReturnValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// letterRequirements – pure function, no mocks needed
// ─────────────────────────────────────────────────────────────────────────────
describe('letterRequirements', () => {
  test('counts letters in a lowercase word', () => {
    expect(letterRequirements('apple')).toEqual({ a: 1, p: 2, l: 1, e: 1 });
  });

  test('is case-insensitive', () => {
    expect(letterRequirements('HELLO')).toEqual({ h: 1, e: 1, l: 2, o: 1 });
  });

  test('ignores spaces and characters outside the inventory system', () => {
    // '^' and '%' are not in SYMBOL_CHARS and not digits, so they are ignored
    const req = letterRequirements('hi there^%');
    expect(req).toEqual({ h: 2, i: 1, t: 1, e: 2, r: 1 });
    expect(req[' ']).toBeUndefined();
    expect(req['^']).toBeUndefined();
  });

  test('returns empty object for empty string', () => {
    expect(letterRequirements('')).toEqual({});
  });

  test('counts digits (0-9) into the _numbers group key', () => {
    expect(letterRequirements('abc 123')).toEqual({ a: 1, b: 1, c: 1, _numbers: 3 });
  });

  test('counts SYMBOL_CHARS characters into the _symbols group key', () => {
    // '!' and '?' are in SYMBOL_CHARS; '$' and '^' are not
    expect(letterRequirements('hola!?$^')).toEqual({ h: 1, o: 1, l: 1, a: 1, _symbols: 2 });
  });

  test('counts letters, digits, and symbols together', () => {
    expect(letterRequirements('hi 3!')).toEqual({ h: 1, i: 1, _numbers: 1, _symbols: 1 });
  });

  test('returns empty object when text contains only ignored characters', () => {
    expect(letterRequirements('   ^$~')).toEqual({});
  });

  it('counts ñ correctly', () => {
    expect(letterRequirements('mañana')).toEqual({ m: 1, a: 3, ñ: 1, n: 1 });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// processMessage – validation guards
// ─────────────────────────────────────────────────────────────────────────────
describe('processMessage – validation', () => {
  test('throws on empty / whitespace-only message', () => {
    setupUser(makeUser());
    setupGameState();
    expect(() => processMessage(1, '')).toThrow(/vac/i);
    expect(() => processMessage(1, '   ')).toThrow(/vac/i);
  });

  test('throws when user lacks sufficient inventory for a letter', () => {
    // Inventory has a:5 but message needs a:6
    setupUser(makeUser({ inventory_json: JSON.stringify({ a: 5 }) }));
    setupGameState();
    expect(() => processMessage(1, 'aaaaaa')).toThrow(/insuficiente/i);
  });

  test('throws when _numbers inventory is insufficient', () => {
    // Inventory has _numbers:1 but message needs 2 digits
    setupUser(makeUser({ inventory_json: JSON.stringify({ h: 1, _numbers: 1 }) }));
    setupGameState();
    expect(() => processMessage(1, 'h 12')).toThrow(/insuficiente/i);
  });

  test('throws when _symbols inventory is insufficient', () => {
    // Inventory has _symbols:1 but message needs 2 symbols
    setupUser(makeUser({ inventory_json: JSON.stringify({ h: 1, _symbols: 1 }) }));
    setupGameState();
    expect(() => processMessage(1, 'h!?')).toThrow(/insuficiente/i);
  });

  test('throws when a required letter is locked', () => {
    setupUser(makeUser({ inventory_json: JSON.stringify({ a: 5 }) }));
    setupGameState({ locks: [{ letter: 'a' }] });
    expect(() => processMessage(1, 'a')).toThrow(/bloqueada/i);
  });

  test('passes validation when inventory is exactly sufficient', () => {
    // Inventory has exactly p:2 — sending 'pp' should succeed
    setupUser(makeUser({ inventory_json: JSON.stringify({ p: 2 }) }));
    setupGameState({ lastSenderId: 99 }); // different user → Tier 1
    // Make the second getRoomMember.get call (fresh read inside transaction) return ok
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 110 }));
    expect(() => processMessage(1, 'pp')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processMessage – Tier 1 (different user sent last)
// ─────────────────────────────────────────────────────────────────────────────
describe('processMessage – Tier 1 (different user)', () => {
  test(`returns tier 1, +${TIER1_COINS} coins, 0 new letters`, () => {
    const user = makeUser({ coins: 100 });
    setupUser(user);
    setupGameState({ lastSenderId: 999 }); // different user

    // Fresh DB read inside transaction returns +TIER1_COINS coins already applied
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: 100 + TIER1_COINS });

    const result = processMessage(1, 'ab');

    expect(result.tier).toBe(1);
    expect(result.coinDelta).toBe(TIER1_COINS);
    // Letters are only granted on first message or via shop roll, not per tier.
    expect(result.newLetters).toHaveLength(0);
    expect(result.lockedLetter).toBeNull();
    expect(result.newCoins).toBe(100 + TIER1_COINS);
  });

  test('streak is reset to 1 after a Tier-1 message', () => {
    setupUser(makeUser({ streak_count: 3 }));
    setupGameState({ lastSenderId: 999 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 110 }));

    const result = processMessage(1, 'a');
    expect(result.newStreak).toBe(1);
  });

  test('inventory is unchanged after a tier-1 message (no per-tier letter grant)', () => {
    const invBefore = { a: 1 };
    setupUser(makeUser({ inventory_json: JSON.stringify(invBefore) }));
    setupGameState({ lastSenderId: 999 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 110 }));

    const result = processMessage(1, 'a');

    // Tier-1 grants no letters; inventory should be identical to before.
    expect(result.newLetters).toHaveLength(0);
    expect(result.newInventory).toEqual(invBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processMessage – Tier 2 (same user, streak = 2)
// ─────────────────────────────────────────────────────────────────────────────
describe('processMessage – Tier 2 (spam warning)', () => {
  test('returns tier 2, 0 coins, 0 letters', () => {
    // Room streak is 1, so next send (same user) makes it 2 → Tier 2
    setupUser(makeUser({ streak_count: 1 }));
    setupGameState({ lastSenderId: 1 }); // same user
    stmts.getRoomStreak.get.mockReturnValue({ streak: 1 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 100 }));

    const result = processMessage(1, 'a');

    expect(result.tier).toBe(2);
    expect(result.coinDelta).toBe(0);
    expect(result.newLetters).toHaveLength(0);
    expect(result.lockedLetter).toBeNull();
    expect(result.newStreak).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processMessage – Tier 3 (same user, streak >= 3)
// ─────────────────────────────────────────────────────────────────────────────
describe('processMessage – Tier 3 (spam penalty)', () => {
  test(`returns tier 3, -${TIER3_PENALTY} coins, a locked letter`, () => {
    // Room streak is 2, so next send (same user) makes it 3 → Tier 3
    setupUser(makeUser({ streak_count: 2, inventory_json: JSON.stringify({ a: 3 }) }));
    setupGameState({ lastSenderId: 1 });
    stmts.getRoomStreak.get.mockReturnValue({ streak: 2 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 50 }));

    const result = processMessage(1, 'a');

    expect(result.tier).toBe(3);
    expect(result.coinDelta).toBe(-TIER3_PENALTY);
    expect(result.newLetters).toHaveLength(0);
    expect(typeof result.lockedLetter).toBe('string');
    expect(result.lockedLetter).toHaveLength(1);
    expect(result.newStreak).toBe(3);
  });

  test('upsertLock is called with the locked letter', () => {
    setupUser(makeUser({ streak_count: 2, inventory_json: JSON.stringify({ b: 2 }) }));
    setupGameState({ lastSenderId: 1 });
    stmts.getRoomStreak.get.mockReturnValue({ streak: 2 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 50 }));

    const result = processMessage(1, 'b');

    expect(stmts.upsertLock.run).toHaveBeenCalledWith(
      expect.any(Number),  // roomId
      1,                   // userId
      result.lockedLetter,
      expect.any(Number)
    );
    // The locked timestamp should be approximately 5 minutes from now
    const [,,, lockedUntil] = stmts.upsertLock.run.mock.calls[0];
    const nowSec = Math.floor(Date.now() / 1000);
    expect(lockedUntil).toBeGreaterThan(nowSec + LOCK_DURATION_SEC - 10);
    expect(lockedUntil).toBeLessThan(nowSec + LOCK_DURATION_SEC + 10);
  });

  test('streak keeps increasing beyond 3', () => {
    setupUser(makeUser({ streak_count: 5, inventory_json: JSON.stringify({ a: 5 }) }));
    setupGameState({ lastSenderId: 1 });
    stmts.getRoomStreak.get.mockReturnValue({ streak: 5 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 50 }));

    const result = processMessage(1, 'a');
    expect(result.tier).toBe(3);
    expect(result.newStreak).toBe(6);
  });

  test('throws when user cannot cover the Tier-3 penalty', () => {
    // User has fewer coins than TIER3_PENALTY → message is blocked entirely
    setupUser(makeUser({ streak_count: 2, coins: TIER3_PENALTY - 1, inventory_json: JSON.stringify({ a: 3 }) }));
    setupGameState({ lastSenderId: 1 });
    stmts.getRoomStreak.get.mockReturnValue({ streak: 2 });

    expect(() => processMessage(1, 'a')).toThrow(/penalizaci/i);
  });

  test('allows the message when coins exactly equal the Tier-3 penalty', () => {
    // User has exactly TIER3_PENALTY coins – just enough to pay the penalty
    setupUser(makeUser({ streak_count: 2, coins: TIER3_PENALTY, inventory_json: JSON.stringify({ a: 3 }) }));
    setupGameState({ lastSenderId: 1 });
    stmts.getRoomStreak.get.mockReturnValue({ streak: 2 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 0 })); // TIER3_PENALTY - TIER3_PENALTY = 0 after penalty

    const result = processMessage(1, 'a');
    expect(result.tier).toBe(3);
    expect(result.newCoins).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processMessage – first-message letter grant
// ─────────────────────────────────────────────────────────────────────────────
describe('processMessage – first message bonus', () => {
  test(`grants FIRST_MESSAGE_LETTERS (${FIRST_MESSAGE_LETTERS}) random letters on a user's very first message`, () => {
    // User has starting inventory { a: 1 } so validation passes for the message 'a'.
    // The bonus letters are then granted on top, inside the transaction.
    setupUser(makeUser({ inventory_json: JSON.stringify({ a: 1 }) }));
    setupGameState({ lastSenderId: 999 }); // Tier 1 so no penalty interferes
    // Simulate first message: cnt === 0
    mockStmts.getRoomMemberMessageCount.get.mockReturnValue({ cnt: 0 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 100 + TIER1_COINS }));

    const result = processMessage(1, 'a');

    expect(result.newLetters).toHaveLength(FIRST_MESSAGE_LETTERS);
    // Every letter in the grant must appear in the updated inventory
    for (const letter of result.newLetters) {
      expect(result.newInventory[letter]).toBeGreaterThanOrEqual(1);
    }
  });

  test('never grants a level above MAX_LETTER_LEVEL even with a near-cap inventory', () => {
    // Start with most letters at MAX_LETTER_LEVEL - 1 (one slot away from cap)
    const nearCap = {};
    for (const l of 'abcdefghijklmnopqrstuvwxyzñ') nearCap[l] = MAX_LETTER_LEVEL - 1;
    // 'a' needs level 1 for the message validation; set it explicitly
    nearCap.a = Math.max(1, MAX_LETTER_LEVEL - 1);
    setupUser(makeUser({ inventory_json: JSON.stringify(nearCap) }));
    setupGameState({ lastSenderId: 999 });
    mockStmts.getRoomMemberMessageCount.get.mockReturnValue({ cnt: 0 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 100 + TIER1_COINS }));

    const result = processMessage(1, 'a');

    for (const [, level] of Object.entries(result.newInventory)) {
      expect(level).toBeLessThanOrEqual(MAX_LETTER_LEVEL);
    }
  });

  test('does NOT grant letters on subsequent messages (cnt > 0)', () => {
    setupUser(makeUser());
    setupGameState({ lastSenderId: 999 });
    // Default mock already returns cnt=1 via beforeEach
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 100 + TIER1_COINS }));

    const result = processMessage(1, 'a');
    expect(result.newLetters).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processMessage – DB writes happen inside one transaction
// ─────────────────────────────────────────────────────────────────────────────
describe('processMessage – transaction', () => {
  test('wraps all writes in a single db.transaction()', () => {
    setupUser(makeUser());
    setupGameState({ lastSenderId: 999 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 110 }));

    processMessage(1, 'a');

    // The transaction factory is called exactly once per processMessage call
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  test('updateUser and setState are called inside the transaction', () => {
    setupUser(makeUser());
    setupGameState({ lastSenderId: 999 });
    stmts.getRoomMember.get.mockReturnValue(makeUser({ coins: 110 }));

    processMessage(1, 'a');

    expect(stmts.updateRoomMember.run).toHaveBeenCalledTimes(1);
    expect(stmts.setState.run).toHaveBeenCalledWith('room:0:last_sender', '1');
    expect(stmts.insertMessage.run).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shopRoll
// ─────────────────────────────────────────────────────────────────────────────
describe('shopRoll', () => {
  test('deducts rollCost coins and returns letters with a valid rarity tier', () => {
    // Use empty inventory so scaled cost = base ROLL_COST (no scaling addend)
    const user = makeUser({ coins: ROLL_COST * 4, inventory_json: JSON.stringify({}) });
    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: ROLL_COST * 4 - ROLL_COST });

    const result = shopRoll(1);

    expect(result.newLetters.length).toBeGreaterThanOrEqual(1);
    expect(result.newCoins).toBe(ROLL_COST * 4 - ROLL_COST);
    const validRarities = ['común', 'bueno', 'raro', 'épico', 'legendario'];
    expect(validRarities).toContain(result.rarity);
  });

  test(`throws when the user has fewer than ROLL_COST (${ROLL_COST}) coins`, () => {
    // Empty inventory so threshold is exactly ROLL_COST (no scaling addend)
    const broke = makeUser({ coins: ROLL_COST - 1, inventory_json: JSON.stringify({}) });
    requireUser.mockReturnValue(broke);
    requireRoomMember.mockReturnValue(broke);
    expect(() => shopRoll(1)).toThrow(/insuficiente/i);
  });

  test('updates inventory with the rolled letters', () => {
    const user = makeUser({ coins: 200, inventory_json: JSON.stringify({ a: 1 }) });
    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: 100 });

    const result = shopRoll(1);
    for (const letter of result.newLetters) {
      expect(result.newInventory[letter]).toBeGreaterThanOrEqual(1);
    }
  });

  test('all inventory slots at cap: waives cost, returns coinBonus, allCapped=true', () => {
    const fullInv = {};
    for (const l of 'abcdefghijklmnopqrstuvwxyzñ') fullInv[l] = MAX_LETTER_LEVEL;
    fullInv._numbers = MAX_LETTER_LEVEL;
    fullInv._symbols = MAX_LETTER_LEVEL;
    const user = makeUser({ coins: 500, inventory_json: JSON.stringify(fullInv) });
    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    // Coins increase (cost waived + coinBonus added) — exact amount depends on tier
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: 500 + CAP_OVERFLOW_COINS_PER_LETTER * 3 });

    const result = shopRoll(1);

    expect(result.allCapped).toBe(true);
    expect(result.newLetters).toHaveLength(0);
    expect(result.coinBonus).toBeGreaterThan(0);
    expect(result.rollCost).toBe(0);
    // Coins increase because cost is waived and bonus is credited
    expect(result.newCoins).toBeGreaterThanOrEqual(500);
  });

  test('steers picks exclusively to uncapped letters when some are at cap', () => {
    // Every slot at cap except 'z' — every picked letter must be 'z'
    const almostFull = {};
    for (const l of 'abcdefghijklmnopqrstuvwxyzñ') almostFull[l] = MAX_LETTER_LEVEL;
    almostFull._numbers = MAX_LETTER_LEVEL;
    almostFull._symbols = MAX_LETTER_LEVEL;
    almostFull.z = 0; // only 'z' has room
    const user = makeUser({ coins: 500, inventory_json: JSON.stringify(almostFull) });
    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: 450 });

    const result = shopRoll(1);

    expect(result.allCapped).toBe(false);
    expect(result.newLetters.length).toBeGreaterThanOrEqual(1);
    for (const letter of result.newLetters) {
      expect(letter).toBe('z');
    }
  });
});

