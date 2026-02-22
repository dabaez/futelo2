'use strict';

/**
 * Futelo Letter Lottery Engine
 * ─────────────────────────────
 * One user pays LOTTERY_START_COST to open a round and a secret letter is
 * chosen at random. Other players (and the opener) can bet LOTTERY_BET_AMOUNT
 * on the letter they think was chosen (one bet per player per round).
 * When the round closes:
 *   – If anyone guessed correctly → they split jackpot × 2 (coins created by
 *     the game; the multiplier is the reward for the risk).
 *   – If nobody guessed → the jackpot carries over to the next round.
 * Jackpot carry-over is stored in game_state under 'lottery_jackpot'.
 */

const { db, stmts, requireUser } = require('../db/database');
const {
  LOTTERY_START_COST,
  LOTTERY_BET_AMOUNT,
  LOTTERY_DURATION_SEC,
} = require('../config');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickLetter() {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

function getCarryOver() {
  const row = stmts.getState.get('lottery_jackpot');
  return row ? (parseInt(row.value, 10) || 0) : 0;
}

function setCarryOver(amount) {
  stmts.setState.run('lottery_jackpot', String(amount));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the active round or null (never exposes secret_letter).
 */
function getActiveLottery() {
  const round = stmts.getActiveLotteryRound.get();
  if (!round) return null;
  const { secret_letter, ...safe } = round;   // strip from result
  return safe;
}

/**
 * Returns round + bets (no secret_letter) for a given roundId.
 * Used to hydrate the frontend on mount.
 */
function getLotteryWithBets(roundId) {
  const round = stmts.getLotteryRoundById.get(roundId);
  if (!round) return null;
  const bets = stmts.getLotteryBets.all(roundId);
  const { secret_letter, ...safe } = round;
  return {
    ...safe,
    bets: bets.map(betPayload),
  };
}

/**
 * Start a new lottery round.
 * Costs LOTTERY_START_COST; picks up any carry-over jackpot from game_state.
 */
function startLottery(userId) {
  requireUser(userId);
  if (stmts.getActiveLotteryRound.get()) {
    throw new Error('Ya hay una lotería activa. Espera a que termine.');
  }

  return db.transaction(() => {
    const user = requireUser(userId);
    if (user.coins < LOTTERY_START_COST) {
      throw new Error(`Monedas insuficientes. Iniciar la lotería cuesta ${LOTTERY_START_COST} 🪙.`);
    }
    const carryOver    = getCarryOver();
    const jackpot      = carryOver + LOTTERY_START_COST;
    const secretLetter = pickLetter();
    const closesAt     = Math.floor(Date.now() / 1000) + LOTTERY_DURATION_SEC;

    stmts.updateCoins.run(-LOTTERY_START_COST, userId);
    setCarryOver(0);  // consumed into this round
    const result  = stmts.insertLotteryRound.run(secretLetter, jackpot, userId, closesAt);
    const roundId = result.lastInsertRowid;
    const fresh   = requireUser(userId);
    const { secret_letter: _sl, ...roundSafe } = stmts.getLotteryRoundById.get(roundId);

    return {
      roundId,
      round:    { ...roundSafe, bets: [] },  // safe for client; no secret_letter
      jackpot,
      carryOver,
      closesAt,
      newCoins:  fresh.coins,
    };
  })();
}

/**
 * Place a bet for the calling user in the given round.
 */
function placeBet(userId, roundId, letter) {
  letter = String(letter).toLowerCase();
  if (!ALPHABET.includes(letter)) {
    throw new Error('Letra no válida. Elige una letra del abecedario (a–z, ñ).');
  }

  return db.transaction(() => {
    const user  = requireUser(userId);
    const round = stmts.getLotteryRoundById.get(roundId);

    if (!round || round.status !== 'active') {
      throw new Error('La ronda no está activa.');
    }
    if (Math.floor(Date.now() / 1000) > round.closes_at) {
      throw new Error('Se acabó el tiempo para apostar en esta ronda.');
    }
    if (user.coins < LOTTERY_BET_AMOUNT) {
      throw new Error(`Monedas insuficientes. Apostar cuesta ${LOTTERY_BET_AMOUNT} 🪙.`);
    }

    const betResult = stmts.insertLotteryBet.run(roundId, userId, letter);
    if (betResult.changes === 0) {
      throw new Error('Ya apostaste en esta ronda.');
    }

    stmts.updateCoins.run(-LOTTERY_BET_AMOUNT, userId);
    stmts.addJackpotToRound.run(LOTTERY_BET_AMOUNT, roundId);

    const fresh = requireUser(userId);
    const bet   = stmts.getLotteryBetById.get(betResult.lastInsertRowid);

    return {
      bet:      betPayload(bet),
      newCoins: fresh.coins,
      jackpot:  round.jackpot + LOTTERY_BET_AMOUNT,
    };
  })();
}

/**
 * Close a round, reveal the letter, pay out winners (or carry over).
 * Returns the result payload for broadcasting, or null if already closed.
 */
function closeLottery(roundId) {
  const round = stmts.getLotteryRoundById.get(roundId);
  if (!round || round.status !== 'active') return null;

  const bets    = stmts.getLotteryBets.all(roundId);
  const winners = bets.filter((b) => b.letter === round.secret_letter);

  return db.transaction(() => {
    stmts.closeLotteryRound.run(roundId);

    if (winners.length === 0) {
      // Nobody won – carry the jackpot forward
      setCarryOver(round.jackpot);
      return {
        roundId,
        secretLetter: round.secret_letter,
        jackpot:      round.jackpot,
        winners:      [],
        prize:        0,
        carryOver:    true,
      };
    }

    // Winners split jackpot × 2
    const prize = Math.floor((round.jackpot * 2) / winners.length);
    winners.forEach((w) => stmts.updateCoins.run(prize, w.user_id));
    setCarryOver(0);

    return {
      roundId,
      secretLetter: round.secret_letter,
      jackpot:      round.jackpot,
      winners:      winners.map((w) => ({
        userId:    w.user_id,
        username:  w.username,
        firstName: w.first_name,
        letter:    w.letter,
      })),
      prize,
      carryOver: false,
    };
  })();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function betPayload(b) {
  return {
    id:        b.id,
    roundId:   b.round_id,
    userId:    b.user_id,
    username:  b.username,
    firstName: b.first_name,
    letter:    b.letter,
  };
}

module.exports = {
  getActiveLottery,
  getLotteryWithBets,
  startLottery,
  placeBet,
  closeLottery,
  getCarryOver,
  LOTTERY_START_COST,
  LOTTERY_BET_AMOUNT,
  LOTTERY_DURATION_SEC,
};
