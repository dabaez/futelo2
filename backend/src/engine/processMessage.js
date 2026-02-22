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
 *   Tier 1 – different user sent last  →  +10 coins
 *   Tier 2 – same user, streak == 2    →  0 coins               (warning)
 *   Tier 3 – same user, streak >= 3    →  -50 coins, 1 letter locked 5 min
 *
 * First-message bonus
 *   On a user's very first message they receive FIRST_MESSAGE_LETTERS random
 *   letters as a one-time starter pack. After that, letters are only obtained
 *   through the shop.
 */

const { db, stmts, requireUser } = require('../db/database');
const {
  LOCK_DURATION_SEC,
  ROLL_COST,
  ROLL_COST_SCALE,
  LOOTBOX_TIERS,
  TIER1_COINS,
  FIRST_MESSAGE_LETTERS,
  TIER3_PENALTY,
  MAX_LETTER_LEVEL,
  SYMBOL_CHARS,
} = require('../config');

/**
 * Compute the actual roll cost for a player given their current inventory.
 * cost = ROLL_COST + ROLL_COST_SCALE × Σ(inventory values)
 */
function computeRollCost(inventory) {
  const totalLevels = Object.values(inventory || {}).reduce((s, v) => s + v, 0);
  return ROLL_COST + ROLL_COST_SCALE * totalLevels;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if `key` is a valid inventory key:
 * a single a–z/ñ letter or one of the two group keys _numbers / _symbols.
 */
function isValidInventoryKey(key) {
  if (!key) return false;
  return (key >= 'a' && key <= 'z') || key === 'ñ'
    || key === '_numbers' || key === '_symbols';
}

/**
 * Count the occurrence of each inventory-relevant character in `text`.
 * Letters (a-z, ñ) are counted individually.
 * Digits (0-9) are summed into the `_numbers` group key.
 * Symbols (SYMBOL_CHARS) are summed into the `_symbols` group key.
 * @param {string} text
 * @returns {Object.<string, number>}  e.g. { a:1, p:2, _numbers:1, _symbols:2 }
 */
function letterRequirements(text) {
  const req = {};
  for (const ch of text) {
    const lc = ch.toLowerCase();
    if ((lc >= 'a' && lc <= 'z') || lc === 'ñ') {
      req[lc] = (req[lc] || 0) + 1;
    } else if (ch >= '0' && ch <= '9') {
      req._numbers = (req._numbers || 0) + 1;
    } else if (SYMBOL_CHARS.includes(ch)) {
      req._symbols = (req._symbols || 0) + 1;
    }
  }
  return req;
}

/**
 * Pick `n` random letters weighted toward common English letters
 * so early-game rewards feel useful.
 */
const WEIGHTED_POOL = [
  ...('eeeeeeettttttaaaaooooiiiinnnnsssrrrhhhhddddllllccuuummmffppggwwybbvvkjxqzññ').split(''),
  '_numbers', '_numbers', '_numbers',
  '_symbols', '_symbols',
];

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

  // ── Step 1b: First-message check ──────────────────────────────────────────
  const isFirstMessage = stmts.getUserMessageCount.get(userId).cnt === 0;

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
    newLetters  = [];
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

  // ── First-message bonus: one-time starter pack of letters ─────────────────
  if (isFirstMessage) {
    newLetters = randomLetters(FIRST_MESSAGE_LETTERS);
  }

  // ── Step 5b: Block Tier-3 if user cannot cover the penalty ───────────────
  // We check this BEFORE the transaction so the message is fully rejected and
  // no DB state is modified when the user is too broke to spam.
  if (tier === 3 && user.coins < TIER3_PENALTY) {
    throw new Error(
      `No puedes enviar otro mensaje seguido: la penalización sería de ${TIER3_PENALTY} 🪙 ` +
      `pero solo tienes ${user.coins} 🪙. ¡Deja hablar a alguien más primero!`
    );
  }

  // ── Step 6: Apply everything inside one transaction ───────────────────────
  const result = db.transaction(() => {
    // Build updated inventory: increment unlock levels for new letters (capped at MAX_LETTER_LEVEL)
    const updatedInventory = { ...inventory };
    for (const letter of newLetters) {
      updatedInventory[letter] = Math.min((updatedInventory[letter] || 0) + 1, MAX_LETTER_LEVEL);
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
/**
 * Pick a random rarity tier from LOOTBOX_TIERS using weighted selection.
 */
function rollRarity() {
  const total = LOOTBOX_TIERS.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const tier of LOOTBOX_TIERS) {
    r -= tier.weight;
    if (r <= 0) return tier;
  }
  return LOOTBOX_TIERS[LOOTBOX_TIERS.length - 1];
}

function shopRoll(userId) {
  const user      = requireUser(userId);
  const inventory = JSON.parse(user.inventory_json || '{}');
  const rollCost  = computeRollCost(inventory);

  if (user.coins < rollCost) {
    throw new Error(`Monedas insuficientes. La tirada cuesta ${rollCost} 🪙 con tu inventario actual.`);
  }

  const tier       = rollRarity();
  const newLetters = randomLetters(tier.letters);

  const updatedInventory = { ...inventory };
  for (const letter of newLetters) {
    updatedInventory[letter] = Math.min((updatedInventory[letter] || 0) + 1, MAX_LETTER_LEVEL);
  }

  db.transaction(() => {
    stmts.updateCoins.run(-rollCost, userId);
    stmts.updateInventory.run(JSON.stringify(updatedInventory), userId);
  })();

  const fresh = stmts.getUser.get(userId);

  return {
    newLetters,
    rarity:       tier.name,
    newCoins:     fresh.coins,
    newInventory: updatedInventory,
    rollCost,
  };
}

module.exports = { processMessage, shopRoll, computeRollCost, letterRequirements, ROLL_COST, ROLL_COST_SCALE };
