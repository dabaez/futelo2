'use strict';

/**
 * Letter mines engine.
 *
 * Players buy a pickaxe (which grants PICKAXE_HITS swings) and then tap a
 * rock one swing at a time. Each swing has a MINE_HIT_CHANCE probability of
 * uncovering a random letter (+1 level, capped at MAX_LETTER_LEVEL). The hit
 * counter is stored in the `pickaxe_hits` column on the `users` table so it
 * persists across sessions and is never affected by the coin/inventory economy
 * used elsewhere in the game.
 */

const { db, stmts, requireUser } = require('../db/database');
const {
  PICKAXE_COST,
  PICKAXE_HITS,
  MINE_HIT_CHANCE,
  MAX_LETTER_LEVEL,
} = require('../config');

/** All valid letters that can be found while mining (includes ñ). */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzñ';

/**
 * Pick a single random letter from the mining alphabet.
 * @returns {string}
 */
function randomMineLetter() {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

/**
 * Buy a pickaxe.
 *
 * Deducts PICKAXE_COST coins from the user and adds PICKAXE_HITS to their
 * `pickaxe_hits` counter. Multiple pickaxes stack.
 *
 * @param {number} userId
 * @returns {{ newCoins: number, pickaxeHits: number }}
 */
function buyPickaxe(userId) {
  const user = requireUser(userId);

  if (user.coins < PICKAXE_COST) {
    throw new Error(
      `Monedas insuficientes. Un pico cuesta ${PICKAXE_COST} 🪙.`
    );
  }

  db.transaction(() => {
    stmts.updateCoins.run(-PICKAXE_COST, userId);
    stmts.addPickaxeHits.run(PICKAXE_HITS, userId);
  })();

  const fresh = stmts.getUser.get(userId);
  return {
    newCoins:    fresh.coins,
    pickaxeHits: fresh.pickaxe_hits,
  };
}

/**
 * Swing the pickaxe once.
 *
 * Consumes one hit from the user's `pickaxe_hits` counter and rolls for a
 * letter find. If successful, increments that letter's inventory level by 1
 * (capped at MAX_LETTER_LEVEL).
 *
 * @param {number} userId
 * @returns {{
 *   found:        boolean,
 *   letter:       string|null,
 *   newInventory: object|null,  // only present when found === true
 *   hitsLeft:     number,
 * }}
 */
function swing(userId) {
  const user = requireUser(userId);

  if (user.pickaxe_hits <= 0) {
    throw new Error('No tienes golpes restantes. Compra un pico para seguir minando.');
  }

  const hit = Math.random() < MINE_HIT_CHANCE;
  const letter = hit ? randomMineLetter() : null;

  let newInventory = null;

  db.transaction(() => {
    stmts.usePickaxeHit.run(userId);

    if (hit) {
      const inv = JSON.parse(user.inventory_json || '{}');
      inv[letter] = Math.min((inv[letter] || 0) + 1, MAX_LETTER_LEVEL);
      stmts.updateInventory.run(JSON.stringify(inv), userId);
      newInventory = inv;
    }
  })();

  const fresh = stmts.getUser.get(userId);

  // If we found a letter, re-read inventory from DB to be safe (the transaction
  // committed synchronously so fresh row is correct for coins/hits, but
  // newInventory was set inside the transaction closure already).
  if (hit && !newInventory) {
    newInventory = JSON.parse(fresh.inventory_json || '{}');
  }

  return {
    found:        hit,
    letter,
    newInventory: hit ? newInventory : null,
    hitsLeft:     fresh.pickaxe_hits,
  };
}

module.exports = { buyPickaxe, swing };
