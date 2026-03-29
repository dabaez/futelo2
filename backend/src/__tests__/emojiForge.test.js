'use strict';

/**
 * emojiForge.test.js
 * ──────────────────
 * Unit tests for the Emoji Forge engine.
 * All DB interactions are mocked — no SQLite file is needed.
 *
 * What is tested:
 *   • inventoryKey  – pure character-to-key mapper
 *   • matchRecipe   – recipe lookup (case-insensitive)
 *   • startMerge    – validation, inventory deduction, merge creation
 *   • instantComplete – cost calculation, already-done path, coin check
 *   • _resolveFinishedMerge (via instantComplete) – success / fail / alreadyHad paths
 *   • buyHint       – coin check, all-unlocked guard, hint returned
 *   • getStatus     – assembles merge + emoji list
 */

// ── Mock the DB layer ─────────────────────────────────────────────────────────
const mockStmts = {
  getActiveMerge:          { get: jest.fn() },
  getUnlockedEmoji:        { get: jest.fn() },
  getUnlockedEmojis:       { all: jest.fn() },
  getRoomMember:           { get: jest.fn() },
  updateRoomInventory:     { run: jest.fn() },
  insertMerge:             { run: jest.fn() },
  updateRoomCoins:         { run: jest.fn() },
  setMergeFinishNow:       { run: jest.fn() },
  getMergeById:            { get: jest.fn() },
  closeMerge:              { run: jest.fn() },
  insertUnlockedEmoji:     { run: jest.fn() },
  insertEmojiHint:         { run: jest.fn() },
  getEmojiHints:           { all: jest.fn() },
};

jest.mock('../db/database', () => ({
  db:                { transaction: jest.fn() },
  stmts:             mockStmts,
  requireUser:       jest.fn(),
  requireRoomMember: jest.fn(),
}));

const { startMerge, instantComplete, buyHint, getStatus, matchRecipe, inventoryKey } =
  require('../engine/emojiForge');
const { db, stmts, requireRoomMember } = require('../db/database');
const { EMOJI_RECIPES, EMOJI_INSTANT_COST_PER_SEC, HINT_COST } = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeRoomMember(overrides = {}) {
  return {
    user_id:        1,
    room_id:        -1001,
    coins:          500,
    inventory_json: JSON.stringify({ a: 3, b: 2, _symbols: 2 }),
    ...overrides,
  };
}

function makeMerge(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id:           1,
    user_id:      1,
    room_id:      -1001,
    ingredients:  JSON.stringify([':', ')']),
    finishes_at:  nowSec - 1,  // already done by default
    status:       'pending',
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Synchronous transaction passthrough: db.transaction(fn)() calls fn()
  db.transaction.mockImplementation((fn) => () => fn());
});

// ─────────────────────────────────────────────────────────────────────────────
// inventoryKey – pure helper
// ─────────────────────────────────────────────────────────────────────────────
describe('inventoryKey', () => {
  test('maps lowercase letters to themselves', () => {
    expect(inventoryKey('a')).toBe('a');
    expect(inventoryKey('z')).toBe('z');
    expect(inventoryKey('ñ')).toBe('ñ');
  });

  test('maps uppercase letters to their lowercase equivalent', () => {
    expect(inventoryKey('A')).toBe('a');
    expect(inventoryKey('Z')).toBe('z');
  });

  test('maps digits to _numbers', () => {
    for (const d of '0123456789') {
      expect(inventoryKey(d)).toBe('_numbers');
    }
  });

  test('maps SYMBOL_CHARS characters to _symbols', () => {
    for (const s of '!?.,:-()@#&*;<>+~$%/^') {
      expect(inventoryKey(s)).toBe('_symbols');
    }
  });

  test('returns null for spaces and unrecognised characters', () => {
    expect(inventoryKey(' ')).toBeNull();
    expect(inventoryKey('€')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// matchRecipe – pure helper
// ─────────────────────────────────────────────────────────────────────────────
describe('matchRecipe', () => {
  test('matches a known 2-character emoticon recipe', () => {
    const result = matchRecipe([':', ')']);
    expect(result).not.toBeNull();
    expect(result.key).toBe('happy');
    expect(result.emoji).toBe('😊');
  });

  test('matching is case-insensitive for letters', () => {
    // 'laugh' recipe is ['X','D'] — lowercase should match
    const result = matchRecipe(['x', 'd']);
    expect(result).not.toBeNull();
    expect(result.key).toBe('laugh');
  });

  test('returns null when no recipe matches', () => {
    expect(matchRecipe(['z', 'z'])).toBeNull();
  });

  test('does not match a recipe of different length', () => {
    // happy recipes are 2-char; passing 3 chars should fail
    expect(matchRecipe([':', ')', '!'])).toBeNull();
  });

  test('matches a 3-character recipe', () => {
    // 'angry' has ['>',':','(']
    const result = matchRecipe(['>', ':', '(']);
    expect(result).not.toBeNull();
    expect(result.key).toBe('angry');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startMerge
// ─────────────────────────────────────────────────────────────────────────────
describe('startMerge', () => {
  test('throws when fewer than 2 ingredients are provided', () => {
    expect(() => startMerge(1, -1001, ['a'])).toThrow(/2 y 6/i);
  });

  test('throws when more than 6 ingredients are provided', () => {
    expect(() => startMerge(1, -1001, ['a','b','c','d','e','f','g'])).toThrow(/2 y 6/i);
  });

  test('throws when the user already has an active merge', () => {
    stmts.getActiveMerge.get.mockReturnValue(makeMerge());
    expect(() => startMerge(1, -1001, [':', ')'])).toThrow(/en curso/i);
  });

  test('throws when the resulting emoji is already unlocked', () => {
    stmts.getActiveMerge.get.mockReturnValue(null);
    // ':)' → happy; simulate already having it
    stmts.getUnlockedEmoji.get.mockReturnValue({ emoji_key: 'happy' });
    expect(() => startMerge(1, -1001, [':', ')'])).toThrow(/desbloqueado/i);
  });

  test('throws when the user has insufficient inventory for an ingredient', () => {
    stmts.getActiveMerge.get.mockReturnValue(null);
    stmts.getUnlockedEmoji.get.mockReturnValue(null);
    // Inventory has 0 _symbols → ':)' requires 2 symbols
    requireRoomMember.mockReturnValue(
      makeRoomMember({ inventory_json: JSON.stringify({ _symbols: 0 }) })
    );
    expect(() => startMerge(1, -1001, [':', ')'])).toThrow(/insuficiente/i);
  });

  test('deducts ingredient levels from inventory', () => {
    stmts.getActiveMerge.get.mockReturnValue(null);
    stmts.getUnlockedEmoji.get.mockReturnValue(null);
    const member = makeRoomMember({ inventory_json: JSON.stringify({ _symbols: 3 }) });
    requireRoomMember.mockReturnValue(member);
    // Fresh read after transaction
    const afterMember = { ...member, inventory_json: JSON.stringify({ _symbols: 1 }) };
    stmts.getRoomMember.get.mockReturnValue(afterMember);
    stmts.getActiveMerge.get
      .mockReturnValueOnce(null)      // existence check
      .mockReturnValueOnce(makeMerge()); // fetch after insert

    startMerge(1, -1001, [':', ')']);

    // updateRoomInventory should have been called with deducted inventory
    const callArg = stmts.updateRoomInventory.run.mock.calls[0][0];
    expect(JSON.parse(callArg)._symbols).toBe(1);
  });

  test('throws for an unrecognised ingredient character', () => {
    stmts.getActiveMerge.get.mockReturnValue(null);
    stmts.getUnlockedEmoji.get.mockReturnValue(null);
    requireRoomMember.mockReturnValue(makeRoomMember());
    expect(() => startMerge(1, -1001, ['€', ')'])).toThrow(/no válido/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// instantComplete
// ─────────────────────────────────────────────────────────────────────────────
describe('instantComplete', () => {
  test('throws when the user has no active merge', () => {
    stmts.getActiveMerge.get.mockReturnValue(null);
    expect(() => instantComplete(1, -1001)).toThrow(/ninguna mezcla/i);
  });

  test('throws when the user has insufficient coins', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    stmts.getActiveMerge.get.mockReturnValue(
      makeMerge({ finishes_at: nowSec + 3600 }) // 1 hour left
    );
    requireRoomMember.mockReturnValue(makeRoomMember({ coins: 0 }));
    expect(() => instantComplete(1, -1001)).toThrow(/insuficientes/i);
  });

  test('resolves immediately without charging if timer already expired', () => {
    // makeMerge defaults to finishes_at = nowSec - 1 (already past)
    const merge = makeMerge({ ingredients: JSON.stringify([':', ')']) });
    stmts.getActiveMerge.get.mockReturnValue(merge);
    // No getUnlockedEmoji call needed when directly calling with expired merge
    stmts.getUnlockedEmoji.get.mockReturnValue(null);
    const member = makeRoomMember({ inventory_json: JSON.stringify({ _symbols: 2 }) });
    stmts.getRoomMember.get.mockReturnValue(member);

    instantComplete(1, -1001);

    // Should NOT have charged coins (no updateRoomCoins call for the instant fee)
    expect(stmts.setMergeFinishNow.run).not.toHaveBeenCalled();
  });

  test('deducts coins and completes merge when time remains', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const secsLeft = 100;
    const merge = makeMerge({
      finishes_at: nowSec + secsLeft,
      ingredients: JSON.stringify(['z', 'z']), // no match → fail path
    });
    stmts.getActiveMerge.get.mockReturnValue(merge);
    requireRoomMember.mockReturnValue(makeRoomMember({ coins: 9999 }));

    const updatedMerge = { ...merge, finishes_at: nowSec - 1 };
    stmts.getMergeById.get.mockReturnValue(updatedMerge);

    const member = makeRoomMember({ inventory_json: JSON.stringify({ z: 2 }) });
    stmts.getRoomMember.get.mockReturnValue(member);

    instantComplete(1, -1001);

    expect(stmts.setMergeFinishNow.run).toHaveBeenCalled();
    // The coin deduction call should be negative
    const [delta] = stmts.updateRoomCoins.run.mock.calls[0];
    expect(delta).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buyHint
// ─────────────────────────────────────────────────────────────────────────────
describe('buyHint', () => {
  test('throws when the user has insufficient coins', () => {
    requireRoomMember.mockReturnValue(makeRoomMember({ coins: HINT_COST - 1 }));
    expect(() => buyHint(1, -1001)).toThrow(/insuficientes/i);
  });

  test('throws when all emojis are already unlocked', () => {
    requireRoomMember.mockReturnValue(makeRoomMember({ coins: 9999 }));
    // Return a row for every recipe — all unlocked
    stmts.getUnlockedEmojis.all.mockReturnValue(
      EMOJI_RECIPES.map((e) => ({ emoji_key: e.key }))
    );
    stmts.getRoomMember.get.mockReturnValue(makeRoomMember({ coins: 9999 - HINT_COST }));
    expect(() => buyHint(1, -1001)).toThrow(/todos los emojis/i);
  });

  test('deducts HINT_COST and returns a non-empty hint string', () => {
    requireRoomMember.mockReturnValue(makeRoomMember({ coins: 9999 }));
    stmts.getUnlockedEmojis.all.mockReturnValue([]); // none unlocked → all are candidates
    const afterCoins = 9999 - HINT_COST;
    stmts.getRoomMember.get.mockReturnValue(makeRoomMember({ coins: afterCoins }));

    const result = buyHint(1, -1001);

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(-HINT_COST, -1001, 1);
    expect(stmts.insertEmojiHint.run).toHaveBeenCalledWith(1, expect.any(String));
    expect(typeof result.hint).toBe('string');
    expect(result.hint.length).toBeGreaterThan(0);
    expect(result.newCoins).toBe(afterCoins);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getStatus
// ─────────────────────────────────────────────────────────────────────────────
describe('getStatus', () => {
  test('returns null merge and empty emoji list when user has nothing', () => {
    stmts.getActiveMerge.get.mockReturnValue(null);
    stmts.getUnlockedEmojis.all.mockReturnValue([]);
    stmts.getEmojiHints.all.mockReturnValue([]);

    const result = getStatus(1, -1001);

    expect(result.merge).toBeNull();
    expect(result.unlockedEmojis).toEqual([]);
    expect(result.hints).toEqual([]);
  });

  test('returns active merge and mapped emoji keys', () => {
    const merge = makeMerge();
    stmts.getActiveMerge.get.mockReturnValue(merge);
    stmts.getUnlockedEmojis.all.mockReturnValue([
      { emoji_key: 'happy' },
      { emoji_key: 'cool' },
    ]);
    stmts.getEmojiHints.all.mockReturnValue([
      { hint_text: 'Primera pista' },
      { hint_text: 'Segunda pista' },
    ]);

    const result = getStatus(1, -1001);

    expect(result.merge).toEqual(merge);
    expect(result.unlockedEmojis).toEqual(['happy', 'cool']);
    expect(result.hints).toEqual(['Primera pista', 'Segunda pista']);
  });
});
