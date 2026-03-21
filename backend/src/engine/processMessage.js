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

const { db, stmts, requireUser, requireRoomMember } = require('../db/database');
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
  CAP_OVERFLOW_COINS_PER_LETTER,
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

// Uniform pool: every letter (a–z + ñ) appears once, plus number/symbol group keys.
// No weighting — each pick is equally likely, so players get a spread across all letters.
const WEIGHTED_POOL = [
  ...'abcdefghijklmnopqrstuvwxyzñ'.split(''),
  '_numbers', '_numbers',
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
 * @param {number} roomId  – Room (Telegram group) ID
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
function processMessage(userId, text, roomId = 0) {
  if (!text || text.trim().length === 0) {
    throw new Error('El mensaje no puede estar vacío.');
  }

  // ── Step 1: Fetch user identity + room-scoped game state ────────────────────────
  requireUser(userId);  // validates global identity exists
  const rm        = requireRoomMember(userId, roomId);
  const inventory = JSON.parse(rm.inventory_json || '{}');
  const nowSec = Math.floor(Date.now() / 1000);

  // ── Step 1b: First-message check (per room) ──────────────────────────────
  const isFirstMessage = stmts.getRoomMemberMessageCount.get(userId, roomId).cnt === 0;

  // ── Step 2: Letter requirements ───────────────────────────────────────────
  const req = letterRequirements(text);

  // ── Step 3: Active letter locks ───────────────────────────────────────────
  const locks = stmts.getLocks.all(roomId, userId, nowSec);
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
  const lastSenderKey = `room:${roomId}:last_sender`;
  const lastSenderRow = stmts.getState.get(lastSenderKey);
  const lastSenderId  = lastSenderRow ? Number(lastSenderRow.value) : null;

  // Per-room streak (falls back to 0 if this user hasn't messaged in this room)
  const roomStreakRow = stmts.getRoomStreak.get(roomId, userId);
  const currentStreak = roomStreakRow ? roomStreakRow.streak : 0;

  let tier, coinDelta, newLetters, lockedLetter, newStreak;

  if (lastSenderId !== userId) {
    // ── Tier 1 – different user ──────────────────────────────────────────
    tier        = 1;
    coinDelta   = TIER1_COINS;
    newLetters  = [];
    lockedLetter = null;
    newStreak   = 1;
  } else {
    newStreak = currentStreak + 1;

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
  // Pick each letter from the portion of WEIGHTED_POOL that isn't yet capped,
  // counting accumulating picks so no level is silently wasted.
  if (isFirstMessage) {
    const pending = { ...inventory };
    newLetters = [];
    for (let i = 0; i < FIRST_MESSAGE_LETTERS; i++) {
      const uncapped = WEIGHTED_POOL.filter((k) => (pending[k] || 0) < MAX_LETTER_LEVEL);
      if (uncapped.length === 0) break; // all slots filled — extremely unlikely
      const pick = uncapped[Math.floor(Math.random() * uncapped.length)];
      newLetters.push(pick);
      pending[pick] = (pending[pick] || 0) + 1;
    }
  }

  // ── Step 5b: Block Tier-3 if user cannot cover the penalty ───────────────
  // We check this BEFORE the transaction so the message is fully rejected and
  // no DB state is modified when the user is too broke to spam.
  if (tier === 3 && rm.coins < TIER3_PENALTY) {
    throw new Error(
      `No puedes enviar otro mensaje seguido: la penalización sería de ${TIER3_PENALTY} 🪙 ` +
      `pero solo tienes ${rm.coins} 🪙. ¡Deja hablar a alguien más primero!`
    );
  }

  // ── Step 6: Apply everything inside one transaction ───────────────────────
  const result = db.transaction(() => {
    // Build updated inventory: increment unlock levels for new letters (capped at MAX_LETTER_LEVEL)
    const updatedInventory = { ...inventory };
    for (const letter of newLetters) {
      updatedInventory[letter] = Math.min((updatedInventory[letter] || 0) + 1, MAX_LETTER_LEVEL);
    }

    // Persist room-scoped game state (coins + inventory)
    stmts.updateRoomMember.run({
      coinDelta,
      inventory: JSON.stringify(updatedInventory),
      roomId,
      userId,
    });

    // Apply letter lock if Tier 3
    if (lockedLetter) {
      stmts.upsertLock.run(roomId, userId, lockedLetter, nowSec + LOCK_DURATION_SEC);
    }

    // Advance per-room last-sender and streak
    stmts.setState.run(`room:${roomId}:last_sender`, String(userId));
    stmts.upsertRoomStreak.run(roomId, userId, newStreak);

    // Persist message with room_id
    const { lastInsertRowid } = stmts.insertMessage.run({
      userId,
      text,
      coinDelta,
      roomId,
    });

    // Opportunistic cleanup of expired locks (non-blocking side-effect)
    stmts.cleanLocks.run(nowSec);

    // Reread final coins from DB for accuracy
    const fresh = stmts.getRoomMember.get(roomId, userId);

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

function shopRoll(userId, roomId = 0) {
  requireUser(userId);
  const rm        = requireRoomMember(userId, roomId);
  const inventory = JSON.parse(rm.inventory_json || '{}');
  const rollCost  = computeRollCost(inventory);

  if (rm.coins < rollCost) {
    throw new Error(`Monedas insuficientes. La tirada cuesta ${rollCost} 🪙 con tu inventario actual.`);
  }

  const tier = rollRarity();

  // Build a pool restricted to letters/groups NOT yet at the level cap.
  // This steers every roll toward completing the alphabet rather than
  // silently wasting levels on already-maxed letters.
  const uncappedPool = WEIGHTED_POOL.filter(
    (key) => (inventory[key] || 0) < MAX_LETTER_LEVEL
  );

  // ── All letters at cap → waive cost, give coins instead ─────────────────
  if (uncappedPool.length === 0) {
    const coinBonus = tier.letters * CAP_OVERFLOW_COINS_PER_LETTER;
    db.transaction(() => {
      stmts.updateRoomCoins.run(coinBonus, roomId, userId);
    })();
    const fresh = stmts.getRoomMember.get(roomId, userId);
    return {
      newLetters:   [],
      rarity:       tier.name,
      newCoins:     fresh.coins,
      newInventory: inventory,
      rollCost:     0,
      coinBonus,
      allCapped:    true,
    };
  }

  // ── Normal path: pick only from uncapped letters ─────────────────────────
  const newLetters = [];
  for (let i = 0; i < tier.letters; i++) {
    newLetters.push(uncappedPool[Math.floor(Math.random() * uncappedPool.length)]);
  }

  const updatedInventory = { ...inventory };
  for (const letter of newLetters) {
    updatedInventory[letter] = Math.min((updatedInventory[letter] || 0) + 1, MAX_LETTER_LEVEL);
  }

  db.transaction(() => {
    stmts.updateRoomCoins.run(-rollCost, roomId, userId);
    stmts.updateRoomInventory.run(JSON.stringify(updatedInventory), roomId, userId);
  })();

  const fresh = stmts.getRoomMember.get(roomId, userId);

  return {
    newLetters,
    rarity:       tier.name,
    newCoins:     fresh.coins,
    newInventory: updatedInventory,
    rollCost,
    coinBonus:    0,
    allCapped:    false,
  };
}

module.exports = { processMessage, shopRoll, computeRollCost, letterRequirements, ROLL_COST, ROLL_COST_SCALE };
