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

const { db, stmts, requireUser, requireRoomMember } = require('../db/database');
const {
  PICKAXE_COST,
  PICKAXE_COST_SCALE,
  PICKAXE_HITS,
  MINE_HIT_CHANCE,
  MAX_LETTER_LEVEL,
  CAP_OVERFLOW_COINS_PER_LETTER,
} = require('../config');

/** All valid letters that can be found while mining (includes ñ). */
const ALPHABET_ARR = 'abcdefghijklmnopqrstuvwxyzñ'.split('');

/**
 * Pick a random letter from the subset the player still has room to level up.
 * Returns null when every letter is already at MAX_LETTER_LEVEL (all-capped).
 */
function randomUncappedLetter(inventory) {
  const uncapped = ALPHABET_ARR.filter((l) => (inventory[l] || 0) < MAX_LETTER_LEVEL);
  if (uncapped.length === 0) return null;
  return uncapped[Math.floor(Math.random() * uncapped.length)];
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
function buyPickaxe(userId, roomId = 0) {
  requireUser(userId);
  const rm = requireRoomMember(userId, roomId);

  const inv         = JSON.parse(rm.inventory_json || '{}');
  const totalLevels = Object.values(inv).reduce((s, v) => s + v, 0);
  const pickaxeCost = PICKAXE_COST + PICKAXE_COST_SCALE * totalLevels;

  if (rm.coins < pickaxeCost) {
    throw new Error(
      `Monedas insuficientes. Un pico cuesta ${pickaxeCost} 🪙.`
    );
  }

  db.transaction(() => {
    stmts.updateRoomCoins.run(-pickaxeCost, roomId, userId);
    stmts.addRoomPickaxeHits.run(PICKAXE_HITS, roomId, userId);
  })();

  const fresh = stmts.getRoomMember.get(roomId, userId);
  return {
    newCoins:    fresh.coins,
    pickaxeHits: fresh.pickaxe_hits,
    pickaxeCost,
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
function swing(userId, roomId = 0) {
  requireUser(userId);
  const rm = requireRoomMember(userId, roomId);

  if (rm.pickaxe_hits <= 0) {
    throw new Error('No tienes golpes restantes. Compra un pico para seguir minando.');
  }

  const hit = Math.random() < MINE_HIT_CHANCE;

  let newInventory = null;
  let letter       = null;
  let coinBonus    = 0;
  let allCapped    = false;

  db.transaction(() => {
    stmts.useRoomPickaxeHit.run(roomId, userId);

    if (hit) {
      const inv          = JSON.parse(rm.inventory_json || '{}');
      const uncapped     = randomUncappedLetter(inv);

      if (uncapped === null) {
        // Every letter is at max — award coins instead of a wasted swing
        allCapped = true;
        coinBonus = CAP_OVERFLOW_COINS_PER_LETTER;
        stmts.updateRoomCoins.run(coinBonus, roomId, userId);
        newInventory = inv;
      } else {
        letter       = uncapped;
        inv[letter]  = Math.min((inv[letter] || 0) + 1, MAX_LETTER_LEVEL);
        stmts.updateRoomInventory.run(JSON.stringify(inv), roomId, userId);
        newInventory = inv;
      }
    }
  })();

  const fresh = stmts.getRoomMember.get(roomId, userId);

  return {
    found:        hit,
    letter,
    newInventory: hit ? (newInventory ?? JSON.parse(fresh.inventory_json || '{}')) : null,
    hitsLeft:     fresh.pickaxe_hits,
    allCapped,
    coinBonus,
  };
}

module.exports = { buyPickaxe, swing };
