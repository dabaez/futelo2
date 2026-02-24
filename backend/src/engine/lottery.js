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
  LOTTERY_DURATION_SEC,
  GAMBLING_COINS_PER_LETTER,
  GAMBLING_WIN_LETTERS,
  GAMBLING_ERRORS,
  MAX_LETTER_LEVEL,
} = require('../config');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickLetter() {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

function getCarryOver(roomId = 0) {
  const row = stmts.getState.get(`room:${roomId}:lottery_jackpot`);
  return row ? (parseInt(row.value, 10) || 0) : 0;
}

function setCarryOver(amount, roomId = 0) {
  stmts.setState.run(`room:${roomId}:lottery_jackpot`, String(amount));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the active round for a room or null (never exposes secret_letter).
 */
function getActiveLottery(roomId = 0) {
  const round = stmts.getActiveLotteryRound.get(roomId);
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
function startLottery(userId, roomId = 0) {
  requireUser(userId);
  if (stmts.getActiveLotteryRound.get(roomId)) {
    throw new Error('Ya hay una lotería activa. Espera a que termine.');
  }

  return db.transaction(() => {
    const user = requireUser(userId);
    if (user.coins < LOTTERY_START_COST) {
      throw new Error(`Monedas insuficientes. Iniciar la lotería cuesta ${LOTTERY_START_COST} 🪙.`);
    }
    const carryOver    = getCarryOver(roomId);
    const jackpot      = carryOver + LOTTERY_START_COST;
    const secretLetter = pickLetter();
    const closesAt     = Math.floor(Date.now() / 1000) + LOTTERY_DURATION_SEC;

    stmts.updateCoins.run(-LOTTERY_START_COST, userId);
    setCarryOver(0, roomId);  // consumed into this round
    const result  = stmts.insertLotteryRound.run(secretLetter, jackpot, userId, closesAt, roomId);
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
 * Place a letter-based guess for the calling user in the given round.
 * – 1st guess: always succeeds; letter level is removed from inventory.
 * – Each subsequent guess: error probability = 1 - 0.5^k where k is the
 *   number of guesses already placed by this user this round.
 *   If the error fires the guess is rejected and the letter is NOT consumed.
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

    // User must have at least 1 inventory level of this letter
    const inv = JSON.parse(user.inventory_json);
    if ((inv[letter] || 0) < 1) {
      throw new Error(`No tienes "${letter.toUpperCase()}" en tu inventario.`);
    }

    // Escalating error probability: 1 - 0.5^(existing bet count)
    const { count: existingBets } = stmts.getUserBetCountInRound.get(roundId, userId);
    if (existingBets > 0) {
      const errorProb = 1 - Math.pow(0.5, existingBets);
      if (Math.random() < errorProb) {
        const msg = GAMBLING_ERRORS[Math.floor(Math.random() * GAMBLING_ERRORS.length)];
        throw new Error(msg);
      }
    }

    // Deduct one level of the guessed letter from inventory
    inv[letter] = Math.max(0, (inv[letter] || 0) - 1);
    if (inv[letter] === 0) delete inv[letter];
    stmts.updateInventory.run(JSON.stringify(inv), userId);

    const betResult = stmts.insertLotteryBet.run(roundId, userId, letter);
    const fresh     = requireUser(userId);
    const bet       = stmts.getLotteryBetById.get(betResult.lastInsertRowid);

    return {
      bet:          betPayload(bet),
      newInventory: JSON.parse(fresh.inventory_json),
      jackpot:      round.jackpot,
    };
  })();
}

/**
 * Close a round, reveal the secret letter, and distribute rewards.
 * Winners (users who guessed the secret letter at least once):
 *   – inventory[secret_letter] += GAMBLING_WIN_LETTERS (capped at MAX_LETTER_LEVEL)
 *   – coins += round.jackpot + GAMBLING_COINS_PER_LETTER × (bets from ALL OTHER users)
 *   No split: every winner receives the full reward independently.
 * No winners: all bet letters convert to coins that carry over as jackpot.
 */
function closeLottery(roundId) {
  const round = stmts.getLotteryRoundById.get(roundId);
  if (!round || round.status !== 'active') return null;

  const bets = stmts.getLotteryBets.all(roundId);
  const winnerUserIds = [...new Set(
    bets.filter((b) => b.letter === round.secret_letter).map((b) => b.user_id),
  )];

  return db.transaction(() => {
    stmts.closeLotteryRound.run(roundId);
    const roomId = round.room_id ?? 0;

    if (winnerUserIds.length === 0) {
      // Nobody guessed correctly – convert all bet letters to coins and carry over
      const totalCarry = round.jackpot + bets.length * GAMBLING_COINS_PER_LETTER;
      setCarryOver(totalCarry, roomId);
      return {
        roundId,
        secretLetter: round.secret_letter,
        jackpot:      totalCarry,
        winners:      [],
        carryOver:    true,
      };
    }

    // Pay each winner independently (full reward, no split)
    const winnerResults = winnerUserIds.map((winnerId) => {
      const otherBetCount = bets.filter((b) => b.user_id !== winnerId).length;
      const coinsEarned   = round.jackpot + otherBetCount * GAMBLING_COINS_PER_LETTER;

      stmts.updateCoins.run(coinsEarned, winnerId);

      const winnerUser = requireUser(winnerId);
      const inv        = JSON.parse(winnerUser.inventory_json);
      inv[round.secret_letter] = Math.min(
        (inv[round.secret_letter] || 0) + GAMBLING_WIN_LETTERS,
        MAX_LETTER_LEVEL,
      );
      stmts.updateInventory.run(JSON.stringify(inv), winnerId);

      const fresh = requireUser(winnerId);
      return {
        userId:       winnerId,
        username:     fresh.username,
        firstName:    fresh.first_name,
        coinsEarned,
        newInventory: JSON.parse(fresh.inventory_json),
      };
    });

    setCarryOver(0, roomId);
    return {
      roundId,
      secretLetter: round.secret_letter,
      jackpot:      round.jackpot,
      winners:      winnerResults,
      carryOver:    false,
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
  LOTTERY_DURATION_SEC,
};
