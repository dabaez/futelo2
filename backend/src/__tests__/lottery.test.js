'use strict';

/**
 * lottery.test.js
 * ───────────────
 * Unit tests for the letter-lottery engine (lottery.js).
 * All DB interactions are mocked – no SQLite file is needed.
 */

// ── Mock the DB layer ────────────────────────────────────────────────────────
const mockStmts = {
  // Round lifecycle
  insertLotteryRound:     { run: jest.fn() },
  getLotteryRoundById:    { get: jest.fn() },
  getActiveLotteryRound:  { get: jest.fn() },
  closeLotteryRound:      { run: jest.fn() },
  // Bets
  insertLotteryBet:       { run: jest.fn() },
  getLotteryBetById:      { get: jest.fn() },
  getLotteryBets:         { all: jest.fn() },
  getUserBetCountInRound: { get: jest.fn() },
  // game_state (carry-over jackpot)
  getState: { get: jest.fn() },
  setState: { run: jest.fn() },
  // Room-scoped stmts
  getRoomMember:       { get: jest.fn() },
  updateRoomCoins:     { run: jest.fn() },
  updateRoomInventory: { run: jest.fn() },
};

jest.mock('../db/database', () => ({
  db:                { transaction: jest.fn() },
  stmts:             mockStmts,
  requireUser:       jest.fn(),
  requireRoomMember: jest.fn(),
}));

const { startLottery, placeBet, closeLottery, getActiveLottery } =
  require('../engine/lottery');
const { db, stmts, requireUser, requireRoomMember } = require('../db/database');
const {
  LOTTERY_START_COST,
  GAMBLING_COINS_PER_LETTER,
  GAMBLING_WIN_LETTERS,
  MAX_LETTER_LEVEL,
} = require('../config');

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeUser(overrides = {}) {
  return {
    id:             1,
    username:       'alice',
    first_name:     'Alice',
    coins:          500,
    inventory_json: JSON.stringify({ a: 3 }),
    ...overrides,
  };
}

function makeRound(overrides = {}) {
  return {
    id:            1,
    secret_letter: 'a',
    jackpot:       LOTTERY_START_COST,
    started_by:    1,
    status:        'active',
    closes_at:     Math.floor(Date.now() / 1000) + 3600,
    room_id:       0,
    ...overrides,
  };
}

function makeBet(overrides = {}) {
  return {
    id:         1,
    round_id:   1,
    user_id:    1,
    letter:     'a',
    username:   'alice',
    first_name: 'Alice',
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  db.transaction.mockImplementation((fn) => () => fn());
  // No carry-over by default
  mockStmts.getState.get.mockReturnValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// startLottery
// ─────────────────────────────────────────────────────────────────────────────
describe('startLottery', () => {
  test('throws when a round is already active', () => {
    requireUser.mockReturnValue(makeUser());
    stmts.getActiveLotteryRound.get.mockReturnValue(makeRound());

    expect(() => startLottery(1, 0)).toThrow(/activa/i);
  });

  test('throws when user has insufficient coins', () => {
    requireUser.mockReturnValue(makeUser({ coins: LOTTERY_START_COST - 1 }));
    stmts.getActiveLotteryRound.get.mockReturnValue(null);
    requireRoomMember.mockReturnValue(makeUser({ coins: LOTTERY_START_COST - 1 }));

    expect(() => startLottery(1, 0)).toThrow(/insuficiente/i);
  });

  test('deducts LOTTERY_START_COST and creates a round', () => {
    const user  = makeUser({ coins: LOTTERY_START_COST + 100 });
    requireUser.mockReturnValue(user);
    stmts.getActiveLotteryRound.get.mockReturnValue(null);
    requireRoomMember.mockReturnValue(user);

    const round      = makeRound({ id: 7 });
    const { secret_letter: _sl, ...roundSafe } = round;
    stmts.insertLotteryRound.run.mockReturnValue({ lastInsertRowid: 7 });
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: user.coins - LOTTERY_START_COST });

    const result = startLottery(1, 0);

    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(-LOTTERY_START_COST, 0, 1);
    expect(result.roundId).toBe(7);
    expect(result.jackpot).toBe(LOTTERY_START_COST);
    expect(result.newCoins).toBe(user.coins - LOTTERY_START_COST);
    // secret_letter must NOT be leaked to the caller
    expect(result.round.secret_letter).toBeUndefined();
  });

  test('includes any carry-over jackpot in the new round total', () => {
    const carryAmount = 200;
    const user        = makeUser({ coins: LOTTERY_START_COST + 50 });
    requireUser.mockReturnValue(user);
    stmts.getActiveLotteryRound.get.mockReturnValue(null);
    requireRoomMember.mockReturnValue(user);
    // Simulate a saved carry-over
    stmts.getState.get.mockReturnValue({ value: String(carryAmount) });

    const round = makeRound({ id: 2, jackpot: carryAmount + LOTTERY_START_COST });
    stmts.insertLotteryRound.run.mockReturnValue({ lastInsertRowid: 2 });
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getRoomMember.get.mockReturnValue({ ...user, coins: user.coins - LOTTERY_START_COST });

    const result = startLottery(1, 0);
    expect(result.carryOver).toBe(carryAmount);
    expect(result.jackpot).toBe(carryAmount + LOTTERY_START_COST);
    // Carry-over is cleared after start
    expect(stmts.setState.run).toHaveBeenCalledWith('room:0:lottery_jackpot', '0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// placeBet
// ─────────────────────────────────────────────────────────────────────────────
describe('placeBet', () => {
  test('throws for an invalid letter', () => {
    expect(() => placeBet(1, 1, '$')).toThrow(/válida/i);
  });

  test('throws when the round is not active', () => {
    const round = makeRound({ status: 'closed' });
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    expect(() => placeBet(1, 1, 'a')).toThrow(/activa/i);
  });

  test('throws when user does not have the letter in inventory', () => {
    const round = makeRound();
    const user  = makeUser({ inventory_json: JSON.stringify({}) }); // no 'a'
    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getUserBetCountInRound.get.mockReturnValue({ count: 0 });

    expect(() => placeBet(1, 1, 'a')).toThrow(/inventario/i);
  });

  test('deducts one inventory level and inserts a bet', () => {
    const round = makeRound();
    const user  = makeUser({ inventory_json: JSON.stringify({ a: 2 }) });
    const freshUser = { ...user, inventory_json: JSON.stringify({ a: 1 }) };
    const bet   = makeBet({ id: 3 });

    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getUserBetCountInRound.get.mockReturnValue({ count: 0 });
    stmts.insertLotteryBet.run.mockReturnValue({ lastInsertRowid: 3 });
    stmts.getLotteryBetById.get.mockReturnValue(bet);
    stmts.getRoomMember.get.mockReturnValue(freshUser);

    const result = placeBet(1, 1, 'a');

    expect(stmts.updateRoomInventory.run).toHaveBeenCalledWith(
      JSON.stringify({ a: 1 }), 0, 1
    );
    expect(result.bet.letter).toBe('a');
    expect(result.newInventory.a).toBe(1);
  });

  test('removes inventory key when level drops to 0', () => {
    const round = makeRound();
    const user  = makeUser({ inventory_json: JSON.stringify({ a: 1 }) });
    const freshUser = { ...user, inventory_json: JSON.stringify({}) };
    const bet   = makeBet({ id: 4 });

    requireUser.mockReturnValue(user);
    requireRoomMember.mockReturnValue(user);
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getUserBetCountInRound.get.mockReturnValue({ count: 0 });
    stmts.insertLotteryBet.run.mockReturnValue({ lastInsertRowid: 4 });
    stmts.getLotteryBetById.get.mockReturnValue(bet);
    stmts.getRoomMember.get.mockReturnValue(freshUser);

    const result = placeBet(1, 1, 'a');
    expect(result.newInventory).not.toHaveProperty('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// closeLottery
// ─────────────────────────────────────────────────────────────────────────────
describe('closeLottery', () => {
  test('returns null when round not found or already closed', () => {
    stmts.getLotteryRoundById.get.mockReturnValue(null);
    expect(closeLottery(99)).toBeNull();

    stmts.getLotteryRoundById.get.mockReturnValue(makeRound({ status: 'closed' }));
    expect(closeLottery(1)).toBeNull();
  });

  test('carries over jackpot when nobody guessed correctly', () => {
    const round = makeRound({ jackpot: 100, secret_letter: 'z' });
    // Two bets on 'a' (not 'z') → no winners
    const bets  = [
      makeBet({ id: 1, user_id: 10, letter: 'a' }),
      makeBet({ id: 2, user_id: 20, letter: 'b' }),
    ];
    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getLotteryBets.all.mockReturnValue(bets);

    const result = closeLottery(1);

    expect(result.carryOver).toBe(true);
    expect(result.winners).toHaveLength(0);
    // Jackpot = round.jackpot + bets.length * GAMBLING_COINS_PER_LETTER
    const expectedCarry = round.jackpot + bets.length * GAMBLING_COINS_PER_LETTER;
    expect(result.jackpot).toBe(expectedCarry);
    expect(stmts.setState.run).toHaveBeenCalledWith(
      `room:0:lottery_jackpot`, String(expectedCarry)
    );
  });

  test('distributes coins and letters to winning users', () => {
    const round   = makeRound({ jackpot: 100, secret_letter: 'a', room_id: 0 });
    const winner  = makeBet({ id: 1, user_id: 10, letter: 'a' }); // correct
    const loser   = makeBet({ id: 2, user_id: 20, letter: 'b' }); // wrong

    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getLotteryBets.all.mockReturnValue([winner, loser]);

    const winnerUser = makeUser({ id: 10, inventory_json: JSON.stringify({ a: 1 }) });
    requireUser.mockReturnValue(winnerUser);
    stmts.getRoomMember.get
      .mockReturnValueOnce(winnerUser)           // fresh read for winner coins
      .mockReturnValueOnce(winnerUser);           // fresh read for winner inventory post-update

    const result = closeLottery(1);

    expect(result.carryOver).toBe(false);
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0].userId).toBe(10);

    // Winner coins: jackpot + otherBetCount * GAMBLING_COINS_PER_LETTER
    const otherBetCount = 1; // loser's bet
    const coinsEarned   = round.jackpot + otherBetCount * GAMBLING_COINS_PER_LETTER;
    expect(stmts.updateRoomCoins.run).toHaveBeenCalledWith(coinsEarned, 0, 10);

    // Winner letters: +GAMBLING_WIN_LETTERS for secret_letter
    expect(stmts.updateRoomInventory.run).toHaveBeenCalledWith(
      JSON.stringify({ a: Math.min(1 + GAMBLING_WIN_LETTERS, MAX_LETTER_LEVEL) }),
      0,
      10
    );
  });

  test('caps winner letter level at MAX_LETTER_LEVEL', () => {
    const round  = makeRound({ jackpot: 50, secret_letter: 'b', room_id: 0 });
    const bet    = makeBet({ id: 1, user_id: 5, letter: 'b' });
    const user   = makeUser({ id: 5, inventory_json: JSON.stringify({ b: MAX_LETTER_LEVEL }) });

    stmts.getLotteryRoundById.get.mockReturnValue(round);
    stmts.getLotteryBets.all.mockReturnValue([bet]);
    requireUser.mockReturnValue(user);
    stmts.getRoomMember.get.mockReturnValueOnce(user).mockReturnValueOnce(user);

    closeLottery(1);

    expect(stmts.updateRoomInventory.run).toHaveBeenCalledWith(
      JSON.stringify({ b: MAX_LETTER_LEVEL }), // capped, not MAX_LETTER_LEVEL + GAMBLING_WIN_LETTERS
      0, 5
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getActiveLottery
// ─────────────────────────────────────────────────────────────────────────────
describe('getActiveLottery', () => {
  test('returns null when no active round', () => {
    stmts.getActiveLotteryRound.get.mockReturnValue(null);
    expect(getActiveLottery(0)).toBeNull();
  });

  test('strips secret_letter from the returned object', () => {
    stmts.getActiveLotteryRound.get.mockReturnValue(makeRound());
    const result = getActiveLottery(0);
    expect(result).not.toHaveProperty('secret_letter');
    expect(result.jackpot).toBe(LOTTERY_START_COST);
  });
});
