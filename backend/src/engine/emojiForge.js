'use strict';

/**
 * Emoji Forge engine.
 *
 * Players choose 2–6 characters as "ingredients" and start a 1-hour merge.
 * While the merge is pending, one level is deducted from each ingredient's
 * inventory key (letter → its own key; symbol → _symbols; number → _numbers).
 *
 * After the timer (or instant-complete with coins):
 *   - Recipe matches a known emoji  → emoji permanently unlocked; levels stay gone.
 *   - No match                       → +1 returned to each ingredient's key (delta, not reset).
 *
 * Only one active merge is allowed per user at a time (global, not per-room).
 * Unlocked emojis are also global per user (usable in any room).
 */

const { db, stmts, requireRoomMember } = require('../db/database');
const {
  EMOJI_RECIPES,
  EMOJI_MERGE_DURATION_SEC,
  EMOJI_INSTANT_COST_PER_SEC,
  HINT_COST,
  MAX_LETTER_LEVEL,
  SYMBOL_CHARS,
} = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map a single character to its inventory key. */
function inventoryKey(ch) {
  const lc = ch.toLowerCase();
  if ((lc >= 'a' && lc <= 'z') || lc === 'ñ') return lc;
  if (ch >= '0' && ch <= '9') return '_numbers';
  if (SYMBOL_CHARS.includes(ch)) return '_symbols';
  return null;
}

/**
 * Aggregate the inventory requirements for a list of ingredient characters.
 * Returns { 'a': 2, '_symbols': 1, ... }
 * Throws if an unrecognised character is present.
 */
function countRequirements(ingredients) {
  const counts = {};
  for (const ch of ingredients) {
    const key = inventoryKey(ch);
    if (!key) throw new Error(`Carácter no válido en la mezcla: "${ch}"`);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Find the emoji definition whose recipes list contains a sequence that
 * exactly matches the given ingredients (case-insensitive for letters).
 * Returns the emoji definition or null.
 */
function matchRecipe(ingredients) {
  const norm = ingredients.map((c) => c.toLowerCase());
  for (const def of EMOJI_RECIPES) {
    for (const recipe of def.recipes) {
      if (recipe.length !== norm.length) continue;
      if (recipe.every((c, i) => c.toLowerCase() === norm[i])) return def;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a new forge merge.
 * Deducts 1 inventory level per ingredient and inserts the pending merge row.
 *
 * @param {number}   userId
 * @param {number}   roomId   – room whose inventory is charged
 * @param {string[]} ingredients – ordered list of characters (2–6)
 * @returns {{ merge: object, newInventory: object }}
 */
function startMerge(userId, roomId, ingredients) {
  if (!Array.isArray(ingredients) || ingredients.length < 1 || ingredients.length > 6) {
    throw new Error('Necesitas entre 1 y 6 ingredientes para la mezcla.');
  }

  const existing = stmts.getActiveMerge.get(userId);
  if (existing) {
    throw new Error('Ya tienes una mezcla en curso. Espérala o complétala al instante.');
  }

  // Reject immediately if the recipe is already known to produce an unlocked emoji
  const previewMatch = matchRecipe(ingredients);
  if (previewMatch && stmts.getUnlockedEmoji.get(userId, roomId, previewMatch.key)) {
    throw new Error(`Ya tienes ${previewMatch.emoji} ${previewMatch.name} desbloqueado. ¡No necesitas forjarlo de nuevo!`);
  }

  const rm  = requireRoomMember(userId, roomId);
  const inv = JSON.parse(rm.inventory_json || '{}');
  const req = countRequirements(ingredients);

  // Verify sufficient levels
  for (const [key, needed] of Object.entries(req)) {
    const have = inv[key] || 0;
    if (have < needed) {
      const label = key === '_symbols' ? 'símbolos'
                  : key === '_numbers' ? 'números'
                  : key.toUpperCase();
      throw new Error(`Nivel insuficiente de "${label}". Necesitas ${needed}, tienes ${have}.`);
    }
  }

  // Deduct levels (-1 per ingredient key occurrence)
  const newInv = { ...inv };
  for (const [key, amount] of Object.entries(req)) {
    newInv[key] = Math.max(0, (newInv[key] || 0) - amount);
  }

  const nowSec     = Math.floor(Date.now() / 1000);
  const finishesAt = nowSec + EMOJI_MERGE_DURATION_SEC;

  db.transaction(() => {
    stmts.updateRoomInventory.run(JSON.stringify(newInv), roomId, userId);
    stmts.insertMerge.run(userId, roomId, JSON.stringify(ingredients), finishesAt);
  })();

  const freshInv = JSON.parse(stmts.getRoomMember.get(roomId, userId).inventory_json);
  const merge    = stmts.getActiveMerge.get(userId);

  return { merge, newInventory: freshInv };
}

/**
 * Pay coins to instantly complete the active merge.
 * Cost = ceil(secsLeft × EMOJI_INSTANT_COST_PER_SEC).
 *
 * @param {number} userId
 * @param {number} roomId
 * @returns {object} – same shape as resolveMerge()
 */
function instantComplete(userId, roomId) {
  const merge = stmts.getActiveMerge.get(userId);
  if (!merge) throw new Error('No tienes ninguna mezcla en curso.');

  const nowSec   = Math.floor(Date.now() / 1000);
  const secsLeft = Math.max(0, merge.finishes_at - nowSec);

  if (secsLeft === 0) {
    // Already done naturally — just resolve without charging
    return _resolveFinishedMerge(userId, roomId, merge);
  }

  const cost = Math.ceil(secsLeft * EMOJI_INSTANT_COST_PER_SEC);
  const rm   = requireRoomMember(userId, roomId);

  if (rm.coins < cost) {
    throw new Error(`Monedas insuficientes. Completar ahora cuesta ${cost} 🪙.`);
  }

  db.transaction(() => {
    stmts.updateRoomCoins.run(-cost, roomId, userId);
    stmts.setMergeFinishNow.run(nowSec, merge.id);
  })();

  const updatedMerge = stmts.getMergeById.get(merge.id);
  const result       = _resolveFinishedMerge(userId, roomId, updatedMerge);
  const fresh        = stmts.getRoomMember.get(roomId, userId);
  result.newCoins    = fresh.coins;
  return result;
}

/**
 * Internal: resolve a merge whose finishes_at has passed.
 * Checks the recipe, unlocks the emoji on success, or refunds levels on failure.
 *
 * @param {number} userId
 * @param {number} roomId
 * @param {object} merge  – row from emoji_merges
 * @returns {{ success, emoji?, alreadyHad?, newInventory }}
 */
function _resolveFinishedMerge(userId, roomId, merge) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (merge.finishes_at > nowSec) {
    throw new Error('La mezcla aún no ha terminado.');
  }

  const ingredients = JSON.parse(merge.ingredients);
  const matched     = matchRecipe(ingredients);

  if (matched) {
    const alreadyHad = !!stmts.getUnlockedEmoji.get(userId, roomId, matched.key);

    db.transaction(() => {
      stmts.closeMerge.run('success', matched.key, merge.id);
      if (!alreadyHad) stmts.insertUnlockedEmoji.run(userId, roomId, matched.key);
    })();

    const freshInv = JSON.parse(stmts.getRoomMember.get(roomId, userId).inventory_json);
    return { success: true, emoji: matched, alreadyHad, newInventory: freshInv };
  }

  // Failed — return +1 per ingredient key (delta, not reset to original)
  const req = countRequirements(ingredients);
  const rm  = stmts.getRoomMember.get(roomId, userId);
  const inv = JSON.parse(rm.inventory_json || '{}');

  const newInv = { ...inv };
  for (const [key, amount] of Object.entries(req)) {
    newInv[key] = Math.min(MAX_LETTER_LEVEL, (newInv[key] || 0) + amount);
  }

  db.transaction(() => {
    stmts.updateRoomInventory.run(JSON.stringify(newInv), roomId, userId);
    stmts.closeMerge.run('failed', null, merge.id);
  })();

  const freshInv = JSON.parse(stmts.getRoomMember.get(roomId, userId).inventory_json);
  return { success: false, newInventory: freshInv };
}

/**
 * Buy a mystery hint.
 * Randomly picks one emoji the user has NOT yet unlocked and returns its hint
 * text — without revealing which emoji it belongs to.
 *
 * @param {number} userId
 * @param {number} roomId
 * @returns {{ hint: string, newCoins: number }}
 */
function buyHint(userId, roomId) {
  const rm = requireRoomMember(userId, roomId);
  if (rm.coins < HINT_COST) {
    throw new Error(`Monedas insuficientes. Una pista cuesta ${HINT_COST} 🪙.`);
  }

  const unlockedRows  = stmts.getUnlockedEmojis.all(userId, roomId);
  const unlockedKeys  = new Set(unlockedRows.map((r) => r.emoji_key));
  const purchasedHints = new Set(stmts.getEmojiHints.all(userId).map((r) => r.hint_text));

  const locked = EMOJI_RECIPES.filter((e) => !unlockedKeys.has(e.key));

  if (locked.length === 0) {
    throw new Error('¡Ya tienes todos los emojis desbloqueados!');
  }

  const available = locked.filter((e) => !purchasedHints.has(e.hint));

  if (available.length === 0) {
    throw new Error('¡Ya tienes todas las pistas disponibles de los emojis que te faltan!');
  }

  const def = available[Math.floor(Math.random() * available.length)];

  stmts.updateRoomCoins.run(-HINT_COST, roomId, userId);
  const fresh = stmts.getRoomMember.get(roomId, userId);
  stmts.insertEmojiHint.run(userId, def.hint);

  return { hint: def.hint, newCoins: fresh.coins };
}

/**
 * Get the current forge status for a user: active merge + all unlocked emojis.
 *
 * @param {number} userId
 * @param {number} roomId
 * @returns {{ merge: object|null, unlockedEmojis: string[] }}
 */
function getStatus(userId, roomId) {
  const merge    = stmts.getActiveMerge.get(userId) || null;
  const unlocked = stmts.getUnlockedEmojis.all(userId, roomId);
  const hints    = stmts.getEmojiHints.all(userId);
  return {
    merge,
    unlockedEmojis: unlocked.map((r) => r.emoji_key),
    hints: hints.map((r) => r.hint_text),
  };
}

/**
 * Scheduler hook — called every minute by the server.
 * Resolves any pending merges whose finishes_at has passed and emits results
 * to the affected user via the provided Socket.io instance.
 *
 * @param {import('socket.io').Server} io
 * @param {Function} notifyUser  – server's notifyUser(userId, text, type)
 */
function processFinishedMerges(io, notifyUser, onUnlock = null) {
  const nowSec  = Math.floor(Date.now() / 1000);
  const pending = stmts.getFinishedPendingMerges.all(nowSec);

  for (const merge of pending) {
    try {
      const result = _resolveFinishedMerge(merge.user_id, merge.room_id, merge);

      // Push inventory back to the user's socket (if connected)
      io.to(`user:${merge.user_id}`).emit('user_update', {
        newInventory: result.newInventory,
        newCoins:     result.newCoins,
      });
      // Tell the client forge result (success/fail + animation trigger)
      io.to(`user:${merge.user_id}`).emit('emoji_complete', result);

      if (result.success) {
        const msg = result.alreadyHad
          ? `🔮 La mezcla terminó, pero ya tenías ${result.emoji.emoji} ${result.emoji.name}.`
          : `✨ ¡Desbloqueaste ${result.emoji.emoji} ${result.emoji.name}!`;
        notifyUser(merge.user_id, msg, 'success');
        if (!result.alreadyHad && onUnlock) onUnlock(merge.user_id, merge.room_id);
      } else {
        notifyUser(merge.user_id, '❌ La mezcla falló. No hay receta conocida. Tus letras fueron devueltas.', 'warn');
      }
    } catch (err) {
      console.error(`[EmojiForge] Error resolving merge ${merge.id}: ${err.message}`);
    }
  }
}

module.exports = {
  startMerge,
  instantComplete,
  buyHint,
  getStatus,
  processFinishedMerges,
  matchRecipe,    // exported for tests
  inventoryKey,   // exported for tests
};
