'use strict';

/**
 * achievements.test.js
 * ────────────────────
 * Unit tests for the Achievement engine.
 * All DB interactions are mocked — no SQLite file is needed.
 *
 * What is tested:
 *   • checkAchievements – awards correct achievements per event type
 *   • Skips achievements already earned
 *   • Skips achievements whose condition is not yet met
 *   • Awards coins via a single transaction for all newly earned achievements
 *   • Counter updates per event (mine_swing, roll, market_buy/sell, lottery_bet/win, prompt_win/vote)
 *   • _isMet conditions: message counts, inventory thresholds, stat counters
 */

// ── Mock the DB layer ─────────────────────────────────────────────────────────
const mockStmts = {
  // Stats management
  upsertUserStats:          { run: jest.fn() },
  getUserStats:             { get: jest.fn() },
  statMineFind:             { run: jest.fn() },
  statMineFail:             { run: jest.fn() },
  statLootbox:              { run: jest.fn() },
  statLootboxCommon:        { run: jest.fn() },
  statLootboxNotCommon:     { run: jest.fn() },
  statPromptLoss:           { run: jest.fn() },
  statMarketBuy:            { run: jest.fn() },
  statMarketSell:           { run: jest.fn() },
  statLotteryBet:           { run: jest.fn() },
  statLotteryParticipate:   { run: jest.fn() },
  statLotteryBetsInRound:   { run: jest.fn() },
  statLotteryWin:           { run: jest.fn() },
  statPromptWin:            { run: jest.fn() },
  statPromptCorrectVote:    { run: jest.fn() },
  // Achievement records
  getEarnedAchievements:    { all: jest.fn() },
  insertUserAchievement:    { run: jest.fn() },
  // Room / inventory
  getRoomMember:            { get: jest.fn() },
  updateRoomCoins:          { run: jest.fn() },
  // Message count
  getUserMessageCount:      { get: jest.fn() },
  // Emoji
  getUnlockedEmojis:        { all: jest.fn() },
};

jest.mock('../db/database', () => ({
  db:    { transaction: jest.fn() },
  stmts: mockStmts,
}));

const { checkAchievements } = require('../engine/achievements');
const { db, stmts } = require('../db/database');
const { MAX_LETTER_LEVEL } = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Returns a blank user_stats row (all counters at 0). */
function makeStats(overrides = {}) {
  return {
    user_id: 1,
    mine_finds:                0,
    consecutive_mine_fails:    0,
    lootboxes_total:           0,
    consecutive_common_boxes:  0,
    prompt_losses:             0,
    market_buys:               0,
    market_sells:              0,
    lottery_wins:              0,
    lottery_participations:    0,
    lottery_bets_total:        0,
    lottery_bets_in_round:     0,
    prompt_wins:               0,
    prompt_correct_votes:      0,
    ...overrides,
  };
}

/** Returns a room_member row with a given inventory. */
function makeRoomMember(invOverrides = {}) {
  return {
    user_id:        1,
    room_id:        -1001,
    coins:          100,
    inventory_json: JSON.stringify({ a: 1, ...invOverrides }),
  };
}

/** Wire up the common per-test defaults. */
function setup({ stats = {}, inv = {}, msgCnt = 1, earned = [], emojis = [] } = {}) {
  stmts.getUserStats.get.mockReturnValue(makeStats(stats));
  stmts.getRoomMember.get.mockReturnValue(makeRoomMember(inv));
  stmts.getUserMessageCount.get.mockReturnValue({ cnt: msgCnt });
  stmts.getEarnedAchievements.all.mockReturnValue(
    earned.map((id) => ({ achievement_id: id }))
  );
  stmts.getUnlockedEmojis.all.mockReturnValue(
    emojis.map((k) => ({ emoji_key: k }))
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  db.transaction.mockImplementation((fn) => () => fn());
});

// ─────────────────────────────────────────────────────────────────────────────
// Skipping already-earned achievements
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – already earned', () => {
  test('does not re-award an achievement the user already has', () => {
    // mine_first requires mine_finds >= 1 — condition IS met but achievement already earned
    setup({ stats: { mine_finds: 1 }, earned: ['mine_first'] });

    const awarded = checkAchievements(1, -1001, 'mine_swing', { found: true });

    expect(awarded.map((a) => a.id)).not.toContain('mine_first');
    expect(stmts.insertUserAchievement.run).not.toHaveBeenCalled();
  });

  test('returns empty array when no eligible achievement is met', () => {
    // mine_swing checks mine_first/mine_50/mine_fail_streak — none met at 0
    setup({ stats: { mine_finds: 0, consecutive_mine_fails: 0 } });

    const awarded = checkAchievements(1, -1001, 'mine_swing', { found: false });

    expect(awarded).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// message event
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – message event', () => {
  test('awards first_message on the first message', () => {
    setup({ msgCnt: 1 });

    const awarded = checkAchievements(1, -1001, 'message', { text: 'hi' });

    const ids = awarded.map((a) => a.id);
    expect(ids).toContain('first_message');
  });

  test('awards messages_50 when message count reaches 50', () => {
    setup({ msgCnt: 50 });

    const awarded = checkAchievements(1, -1001, 'message', { text: 'hi' });

    expect(awarded.map((a) => a.id)).toContain('messages_50');
  });

  test('awards miso when text contains "miso soup"', () => {
    setup({ msgCnt: 5 });

    const awarded = checkAchievements(1, -1001, 'message', { text: 'have some miso soup please' });

    expect(awarded.map((a) => a.id)).toContain('miso');
  });

  test('does not award miso when text does not contain "miso soup"', () => {
    setup({ msgCnt: 5 });

    const awarded = checkAchievements(1, -1001, 'message', { text: 'just soup' });

    expect(awarded.map((a) => a.id)).not.toContain('miso');
  });

  test('awards full_keyboard when all inventory keys are >= 1', () => {
    // Build an inventory with every key at level 1
    const allKeys = [
      ...'abcdefghijklmnopqrstuvwxyzñ'.split(''),
      '_numbers', '_symbols',
    ];
    const fullInv = Object.fromEntries(allKeys.map((k) => [k, 1]));
    setup({ msgCnt: 5, inv: fullInv });

    const awarded = checkAchievements(1, -1001, 'message', { text: 'hi' });

    expect(awarded.map((a) => a.id)).toContain('full_keyboard');
  });

  test('does not award full_keyboard when some keys are 0', () => {
    setup({ msgCnt: 5, inv: { a: 1 } }); // most keys missing

    const awarded = checkAchievements(1, -1001, 'message', { text: 'hi' });

    expect(awarded.map((a) => a.id)).not.toContain('full_keyboard');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roll event
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – roll event', () => {
  test('increments lootboxes_total stat', () => {
    setup();

    checkAchievements(1, -1001, 'roll', { rarity: 'común' });

    expect(stmts.statLootbox.run).toHaveBeenCalledWith(1);
  });

  test('increments consecutive_common_boxes for a common roll', () => {
    setup();

    checkAchievements(1, -1001, 'roll', { rarity: 'común' });

    expect(stmts.statLootboxCommon.run).toHaveBeenCalledWith(1);
    expect(stmts.statLootboxNotCommon.run).not.toHaveBeenCalled();
  });

  test('resets consecutive_common_boxes for a non-common roll', () => {
    setup();

    checkAchievements(1, -1001, 'roll', { rarity: 'raro' });

    expect(stmts.statLootboxNotCommon.run).toHaveBeenCalledWith(1);
    expect(stmts.statLootboxCommon.run).not.toHaveBeenCalled();
  });

  test('awards roll_legendary immediately on a legendary roll', () => {
    setup({ stats: { lootboxes_total: 0 } });

    const awarded = checkAchievements(1, -1001, 'roll', { rarity: 'legendario' });

    expect(awarded.map((a) => a.id)).toContain('roll_legendary');
  });

  test('awards roll_bad_streak when 5 común boxes are consecutive', () => {
    setup({ stats: { consecutive_common_boxes: 5 } });

    const awarded = checkAchievements(1, -1001, 'roll', { rarity: 'común' });

    expect(awarded.map((a) => a.id)).toContain('roll_bad_streak');
  });

  test('awards roll_10 at exactly 10 lootboxes', () => {
    setup({ stats: { lootboxes_total: 10 } });

    const awarded = checkAchievements(1, -1001, 'roll', { rarity: 'bueno' });

    expect(awarded.map((a) => a.id)).toContain('roll_10');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mine_swing event
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – mine_swing event', () => {
  test('increments mine_finds stat on a successful swing', () => {
    setup();

    checkAchievements(1, -1001, 'mine_swing', { found: true });

    expect(stmts.statMineFind.run).toHaveBeenCalledWith(1);
    expect(stmts.statMineFail.run).not.toHaveBeenCalled();
  });

  test('increments consecutive_mine_fails stat on a miss', () => {
    setup();

    checkAchievements(1, -1001, 'mine_swing', { found: false });

    expect(stmts.statMineFail.run).toHaveBeenCalledWith(1);
    expect(stmts.statMineFind.run).not.toHaveBeenCalled();
  });

  test('awards mine_first at 1 mine find', () => {
    setup({ stats: { mine_finds: 1 } });

    const awarded = checkAchievements(1, -1001, 'mine_swing', { found: true });

    expect(awarded.map((a) => a.id)).toContain('mine_first');
  });

  test('does not award mine_first at 0 mine finds', () => {
    setup({ stats: { mine_finds: 0 } });

    const awarded = checkAchievements(1, -1001, 'mine_swing', { found: false });

    expect(awarded.map((a) => a.id)).not.toContain('mine_first');
  });

  test('awards mine_fail_streak at 300 consecutive misses', () => {
    setup({ stats: { consecutive_mine_fails: 300 } });

    const awarded = checkAchievements(1, -1001, 'mine_swing', { found: false });

    expect(awarded.map((a) => a.id)).toContain('mine_fail_streak');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// market events
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – market events', () => {
  test('market_buy event increments market_buys stat', () => {
    setup();

    checkAchievements(1, -1001, 'market_buy', {});

    expect(stmts.statMarketBuy.run).toHaveBeenCalledWith(1);
  });

  test('awards market_buy on first purchase', () => {
    setup({ stats: { market_buys: 1 } });

    const awarded = checkAchievements(1, -1001, 'market_buy', {});

    expect(awarded.map((a) => a.id)).toContain('market_buy');
  });

  test('market_sell event increments market_sells stat', () => {
    setup();

    checkAchievements(1, -1001, 'market_sell', {});

    expect(stmts.statMarketSell.run).toHaveBeenCalledWith(1);
  });

  test('awards market_sell on first sale', () => {
    setup({ stats: { market_sells: 1 } });

    const awarded = checkAchievements(1, -1001, 'market_sell', {});

    expect(awarded.map((a) => a.id)).toContain('market_sell');
  });

  test('awards bm_buy immediately on a BM purchase', () => {
    setup();

    const awarded = checkAchievements(1, -1001, 'bm_buy', {});

    expect(awarded.map((a) => a.id)).toContain('bm_buy');
  });

  test('awards bm_sell immediately on a BM sale', () => {
    setup();

    const awarded = checkAchievements(1, -1001, 'bm_sell', {});

    expect(awarded.map((a) => a.id)).toContain('bm_sell');
  });

  test('awards bm_caught immediately when caught selling on BM', () => {
    setup();

    const awarded = checkAchievements(1, -1001, 'bm_caught', {});

    expect(awarded.map((a) => a.id)).toContain('bm_caught');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lottery events
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – lottery events', () => {
  test('lottery_bet event updates participation counter on first bet in round', () => {
    setup();

    checkAchievements(1, -1001, 'lottery_bet', { betsInRound: 1 });

    expect(stmts.statLotteryParticipate.run).toHaveBeenCalledWith(1);
    expect(stmts.statLotteryBet.run).toHaveBeenCalledWith(1);
  });

  test('lottery_bet does not increment participations on subsequent bets', () => {
    setup();

    checkAchievements(1, -1001, 'lottery_bet', { betsInRound: 2 });

    expect(stmts.statLotteryParticipate.run).not.toHaveBeenCalled();
  });

  test('awards lottery_participate at first participation', () => {
    setup({ stats: { lottery_participations: 1 } });

    const awarded = checkAchievements(1, -1001, 'lottery_bet', { betsInRound: 1 });

    expect(awarded.map((a) => a.id)).toContain('lottery_participate');
  });

  test('awards lottery_win on a win event', () => {
    setup({ stats: { lottery_wins: 1 } });

    const awarded = checkAchievements(1, -1001, 'lottery_win', { coinsEarned: 1000 });

    expect(awarded.map((a) => a.id)).toContain('lottery_win');
  });

  test('awards lottery_small_win when coins earned is between 0 and 499', () => {
    setup({ stats: { lottery_wins: 1 } });

    const awarded = checkAchievements(1, -1001, 'lottery_win', { coinsEarned: 300 });

    expect(awarded.map((a) => a.id)).toContain('lottery_small_win');
  });

  test('does not award lottery_small_win when coins earned >= 500', () => {
    setup({ stats: { lottery_wins: 1 }, earned: ['lottery_win'] });

    const awarded = checkAchievements(1, -1001, 'lottery_win', { coinsEarned: 500 });

    expect(awarded.map((a) => a.id)).not.toContain('lottery_small_win');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emoji_unlock event
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – emoji_unlock event', () => {
  test('awards emoji_first when emojiCount reaches 1', () => {
    setup({ emojis: ['happy'] }); // 1 unlocked

    const awarded = checkAchievements(1, -1001, 'emoji_unlock', {});

    expect(awarded.map((a) => a.id)).toContain('emoji_first');
  });

  test('awards emoji_5 when emojiCount reaches 5', () => {
    setup({ emojis: ['happy', 'sad', 'tongue', 'laugh', 'cool'] });

    const awarded = checkAchievements(1, -1001, 'emoji_unlock', {});

    expect(awarded.map((a) => a.id)).toContain('emoji_5');
  });

  test('does not award emoji_5 when only 4 emojis are unlocked', () => {
    setup({ emojis: ['happy', 'sad', 'tongue', 'laugh'] });

    const awarded = checkAchievements(1, -1001, 'emoji_unlock', {});

    expect(awarded.map((a) => a.id)).not.toContain('emoji_5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prompt events
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – prompt events', () => {
  test('awards prompt_win immediately on first prompt win', () => {
    setup({ stats: { prompt_wins: 1 } });

    const awarded = checkAchievements(1, -1001, 'prompt_win', {});

    expect(awarded.map((a) => a.id)).toContain('prompt_win');
  });

  test('awards prompt_win_3 when prompt_wins reaches 3', () => {
    setup({ stats: { prompt_wins: 3 } });

    const awarded = checkAchievements(1, -1001, 'prompt_win', {});

    expect(awarded.map((a) => a.id)).toContain('prompt_win_3');
  });

  test('awards prompt_lose_5 on 5th loss', () => {
    setup({ stats: { prompt_losses: 5 } });

    const awarded = checkAchievements(1, -1001, 'prompt_lose', {});

    expect(awarded.map((a) => a.id)).toContain('prompt_lose_5');
  });

  test('awards prompt_vote_winner immediately for a correct vote', () => {
    setup();

    const awarded = checkAchievements(1, -1001, 'prompt_vote_win', {});

    expect(awarded.map((a) => a.id)).toContain('prompt_vote_winner');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transaction and coin award integrity
// ─────────────────────────────────────────────────────────────────────────────
describe('checkAchievements – coin awards', () => {
  test('awards coins inside a single transaction when multiple achievements earned', () => {
    // first_message (50) + miso (30) should both fire
    setup({ msgCnt: 1 });

    const awarded = checkAchievements(1, -1001, 'message', { text: 'miso soup' });

    // Both should be in awarded list
    const ids = awarded.map((a) => a.id);
    expect(ids).toContain('first_message');
    expect(ids).toContain('miso');

    // updateRoomCoins called inside the transaction (once per achievement)
    expect(stmts.updateRoomCoins.run).toHaveBeenCalledTimes(ids.length);
    // And insertUserAchievement was called for each
    expect(stmts.insertUserAchievement.run).toHaveBeenCalledTimes(ids.length);
  });

  test('returns empty array and makes no DB writes when no achievement is earned', () => {
    // mine_swing with no finds and no fail streak — no conditions met
    setup({ stats: { mine_finds: 0, consecutive_mine_fails: 0 } });

    const awarded = checkAchievements(1, -1001, 'mine_swing', { found: false });

    expect(awarded).toHaveLength(0);
    expect(stmts.insertUserAchievement.run).not.toHaveBeenCalled();
    expect(stmts.updateRoomCoins.run).not.toHaveBeenCalled();
  });
});
