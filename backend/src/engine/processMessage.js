'use strict';

/**
 * Futelo Message Engine
 * ─────────────────────
 * Handles letter-inventory validation, streak tracking, and the
 * three-tier Anti-Spam coin economy – all inside a single SQLite
 * transaction, so the DB never lands in an inconsistent state.
 *
 * Letter Semantics
 *   inventory[letter] = the MAXIMUM number of that letter the user
 *   may include in any single message (unlock level, never consumed).
 *
 * Coin Tiers
 *   Tier 1 – different user sent last  →  +10 coins, 2 random letters
 *   Tier 2 – same user, streak == 2    →  0 coins, 0 letters  (warning)
 *   Tier 3 – same user, streak >= 3    →  -50 coins, 1 letter locked 5 min
 */

const { db, stmts, requireUser } = require('../db/database');
const {
  LOCK_DURATION_SEC,
  ROLL_COST,
  ROLL_COUNT,
  TIER1_COINS,
  TIER1_LETTERS,
  TIER3_PENALTY,
  SELL_BASE_PRICE,
  SELL_COMMISSION_RATE,
} = require('../config');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count the occurrence of each a-z character in `text`.
 * @param {string} text
 * @returns {Object.<string, number>}  e.g. { a:1, p:2, l:1, e:1 }
 */
function letterRequirements(text) {
  const req = {};
  for (const ch of text.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || ch === 'ñ') {
      req[ch] = (req[ch] || 0) + 1;
    }
  }
  return req;
}

/**
 * Pick `n` random letters weighted toward common English letters
 * so early-game rewards feel useful.
 */
const WEIGHTED_POOL = (
  'eeeeeeettttttaaaaooooiiiinnnnsssrrrhhhhddddllllccuuummmffppggwwybbvvkjxqzññ'
).split('');

function randomLetters(n) {
  const result = [];
  for (let i = 0; i < n; i++) {
    result.push(WEIGHTED_POOL[Math.floor(Math.random() * WEIGHTED_POOL.length)]);
  }
  return result;
}

/**
 * From the user's current inventory pick a letter they actually own
 * to lock as a penalty. Falls back to a random a-z letter.
 */
function pickLockTarget(inventory) {
  const owned = Object.entries(inventory)
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  if (owned.length === 0) return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return owned[Math.floor(Math.random() * owned.length)];
}

// ── Core Engine ───────────────────────────────────────────────────────────────

/**
 * Process a Futelo message.
 *
 * @param {number} userId  – Telegram user ID
 * @param {string} text    – Raw message text
 * @returns {{
 *   success: true,
 *   messageId: number,
 *   coinDelta: number,
 *   newLetters: string[],
 *   lockedLetter: string|null,
 *   newStreak: number,
 *   tier: 1|2|3,
 *   newCoins: number,
 *   newInventory: Object
 * }}
 * @throws {Error} with a user-facing message on validation failure
 */
function processMessage(userId, text) {
  if (!text || text.trim().length === 0) {
    throw new Error('El mensaje no puede estar vacío.');
  }

  // ── Step 1: Fetch user (throws if absent) ──────────────────────────────────
  const user = requireUser(userId);
  const inventory = JSON.parse(user.inventory_json || '{}');
  const nowSec = Math.floor(Date.now() / 1000);

  // ── Step 2: Letter requirements ───────────────────────────────────────────
  const req = letterRequirements(text);

  // ── Step 3: Active letter locks ───────────────────────────────────────────
  const locks = stmts.getLocks.all(userId, nowSec);
  const lockedSet = new Set(locks.map((r) => r.letter));

  // ── Step 4: Inventory validation ─────────────────────────────────────────
  for (const [letter, count] of Object.entries(req)) {
    if (lockedSet.has(letter)) {
      throw new Error(
        `La letra "${letter.toUpperCase()}" está bloqueada por ${LOCK_DURATION_SEC / 60} minutos.`
      );
    }
    const unlocked = inventory[letter] || 0;
    if (unlocked < count) {
      throw new Error(
        `"${letter.toUpperCase()}" insuficiente desbloqueada. ` +
        `Necesitas ${count}, tienes ${unlocked}. ¡Compra más en la Tienda!`
      );
    }
  }

  // ── Step 5: Streak / tier calculation ────────────────────────────────────
  const lastSenderRow = stmts.getState.get('last_sender_id');
  const lastSenderId = lastSenderRow ? Number(lastSenderRow.value) : null;

  let tier, coinDelta, newLetters, lockedLetter, newStreak;

  if (lastSenderId !== userId) {
    // ── Tier 1 – different user ──────────────────────────────────────────
    tier        = 1;
    coinDelta   = TIER1_COINS;
    newLetters  = randomLetters(TIER1_LETTERS);
    lockedLetter = null;
    newStreak   = 1;
  } else {
    newStreak = user.streak_count + 1;

    if (newStreak === 2) {
      // ── Tier 2 – first self-reply ──────────────────────────────────────
      tier        = 2;
      coinDelta   = 0;
      newLetters  = [];
      lockedLetter = null;
    } else {
      // ── Tier 3 – 3+ consecutive ───────────────────────────────────────
      tier        = 3;
      coinDelta   = -TIER3_PENALTY;
      newLetters  = [];
      lockedLetter = pickLockTarget(inventory);
    }
  }

  // ── Step 6: Apply everything inside one transaction ───────────────────────
  const result = db.transaction(() => {
    // Build updated inventory: increment unlock levels for new letters
    const updatedInventory = { ...inventory };
    for (const letter of newLetters) {
      updatedInventory[letter] = (updatedInventory[letter] || 0) + 1;
    }

    // Persist user state
    stmts.updateUser.run({
      coinDelta,
      streak:    newStreak,
      inventory: JSON.stringify(updatedInventory),
      userId,
    });

    // Apply letter lock if Tier 3
    if (lockedLetter) {
      stmts.upsertLock.run(userId, lockedLetter, nowSec + LOCK_DURATION_SEC);
    }

    // Advance global last-sender
    stmts.setState.run('last_sender_id', String(userId));

    // Persist message
    const { lastInsertRowid } = stmts.insertMessage.run({
      userId,
      text,
      coinDelta,
    });

    // Opportunistic cleanup of expired locks (non-blocking side-effect)
    stmts.cleanLocks.run(nowSec);

    // Reread final coins from DB for accuracy
    const fresh = stmts.getUser.get(userId);

    return {
      success:      true,
      messageId:    lastInsertRowid,
      coinDelta,
      newLetters,
      lockedLetter,
      newStreak,
      tier,
      newCoins:     fresh.coins,
      newInventory: updatedInventory,
    };
  })();

  return result;
}

// ── Shop: Roll for random letters ─────────────────────────────────────────────

/**
 * Spend coins to unlock random letters (loot-box style).
 * @param {number} userId
 * @returns {{ newLetters: string[], newCoins: number, newInventory: object }}
 */
function shopRoll(userId) {
  const user = requireUser(userId);

  if (user.coins < ROLL_COST) {
    throw new Error(`Monedas insuficientes. Una tirada cuesta ${ROLL_COST} monedas.`);
  }

  const newLetters   = randomLetters(ROLL_COUNT);
  const inventory    = JSON.parse(user.inventory_json || '{}');

  const updatedInventory = { ...inventory };
  for (const letter of newLetters) {
    updatedInventory[letter] = (updatedInventory[letter] || 0) + 1;
  }

  db.transaction(() => {
    stmts.updateCoins.run(-ROLL_COST, userId);
    stmts.updateInventory.run(JSON.stringify(updatedInventory), userId);
  })();

  const fresh = stmts.getUser.get(userId);

  return {
    newLetters,
    newCoins:     fresh.coins,
    newInventory: updatedInventory,
  };
}

// ── Market: Sell a letter level (normal market) ────────────────────────────────

/**
 * Sell one level of a letter on the normal market (instant, tax deducted).
 * For black-market sales use engine/blackMarket.js (listing / heat system).
 *
 * Earned = floor(SELL_BASE_PRICE × (1 − SELL_COMMISSION_RATE))
 *
 * @param {number} userId
 * @param {string} letter  – single lowercase letter
 * @returns {{ letter, earned, newCoins, newInventory }}
 * @throws {Error} with a user-facing message on validation failure
 */
function sellLetter(userId, letter) {
  if (!letter || letter.length !== 1) {
    throw new Error('Letra inválida para vender.');
  }
  const normalizedLetter = letter.toLowerCase();
  if (!((normalizedLetter >= 'a' && normalizedLetter <= 'z') || normalizedLetter === 'ñ')) {
    throw new Error('Letra inválida para vender.');
  }

  const user      = requireUser(userId);
  const inventory = JSON.parse(user.inventory_json || '{}');
  const level     = inventory[normalizedLetter] || 0;

  if (level < 1) {
    throw new Error(
      `No tienes niveles de "${normalizedLetter.toUpperCase()}" para vender.`
    );
  }

  const earned   = Math.floor(SELL_BASE_PRICE * (1 - SELL_COMMISSION_RATE));
  const netDelta = earned;

  const result = db.transaction(() => {
    const updatedInventory = { ...inventory };
    updatedInventory[normalizedLetter] = level - 1;
    if (updatedInventory[normalizedLetter] === 0) {
      delete updatedInventory[normalizedLetter];
    }

    stmts.updateCoins.run(netDelta, userId);
    stmts.updateInventory.run(JSON.stringify(updatedInventory), userId);

    const fresh = stmts.getUser.get(userId);
    return {
      letter:       normalizedLetter,
      earned,
      newCoins:     fresh.coins,
      newInventory: updatedInventory,
    };
  })();

  return result;
}

module.exports = { processMessage, shopRoll, sellLetter, letterRequirements, ROLL_COST, ROLL_COUNT };
