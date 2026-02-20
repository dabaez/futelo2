'use strict';

/**
 * Futelo Black Market Engine
 * ──────────────────────────
 * Letters listed here are escrowed immediately (deducted from inventory).
 * Every minute the scheduler calls sweepCatchRolls(), which:
 *   1. Expires stale listings (letter returned, no coins).
 *   2. Decays global heat.
 *   3. Rolls each pending listing against the current catch probability.
 *      Caught → fine applied, heat spikes.  Safe → listing stays pending.
 * The user collects coins manually via collectListing() at any time while
 * the listing is still pending.
 *
 * Heat dynamics (stored in game_state as "black_market_heat"):
 *   • Each catch           → heat += HEAT_CATCH_INCREMENT  (0.20)
 *   • Each chat mention    → heat += HEAT_MENTION_INCREMENT (0.08)
 *   • Every minute         → heat *= HEAT_DECAY_RATE        (0.90)
 *   • catch_prob / min     = min(BASE * (1 + heat * 15), MAX)
 *     heat=0 → 4 %   heat=0.5 → 34 %   heat=1.0 → 64 %
 */

const { db, stmts, requireUser } = require('../db/database');
const {
  SELL_BASE_PRICE,
  BLACK_MARKET_FINE,
  BLACK_MARKET_BASE_PROB,
  BLACK_MARKET_MAX_PROB,
  HEAT_CATCH_INCREMENT,
  HEAT_MENTION_INCREMENT,
  HEAT_DECAY_RATE,
  HEAT_MAX,
  BLACK_MARKET_LISTING_SEC,
} = require('../config');

// ── Heat helpers ──────────────────────────────────────────────────────────────

function getHeat() {
  const row = stmts.getState.get('black_market_heat');
  return row ? Math.min(parseFloat(row.value) || 0, HEAT_MAX) : 0;
}

function setHeat(value) {
  const clamped = Math.max(0, Math.min(value, HEAT_MAX));
  stmts.setState.run('black_market_heat', String(clamped));
  return clamped;
}

/**
 * Catch probability per minute at the given heat level.
 *   prob = min(BASE × (1 + heat × 15), MAX)
 */
function catchProbForHeat(heat) {
  return Math.min(BLACK_MARKET_BASE_PROB * (1 + heat * 15), BLACK_MARKET_MAX_PROB);
}

/** Bump heat from a "mercado negro" chat mention. Returns new heat. */
function addMentionHeat() {
  return setHeat(getHeat() + HEAT_MENTION_INCREMENT);
}

// ── Listing management ────────────────────────────────────────────────────────

/**
 * Escrow one letter level on the black market.
 * The letter is deducted from inventory right away.
 * Returns listing metadata so the frontend can update its state.
 *
 * @param {number} userId
 * @param {string} letter  – single a-z or ñ character
 */
function listLetter(userId, letter) {
  const normalized = (letter || '').toLowerCase();
  if (!((normalized >= 'a' && normalized <= 'z') || normalized === 'ñ')) {
    throw new Error('Letra inválida para listar.');
  }

  const user      = requireUser(userId);
  const inventory = JSON.parse(user.inventory_json || '{}');
  const level     = inventory[normalized] || 0;

  if (level < 1) {
    throw new Error(`No tienes niveles de "${normalized.toUpperCase()}" para vender.`);
  }

  // One active listing per letter per user
  const existing = stmts.getActiveBmListing.get(userId, normalized);
  if (existing) {
    throw new Error(`Ya tienes "${normalized.toUpperCase()}" en el mercado negro.`);
  }

  // Escrow: remove the letter level immediately
  const updatedInventory = { ...inventory };
  updatedInventory[normalized] = level - 1;
  if (updatedInventory[normalized] === 0) delete updatedInventory[normalized];

  const listingId = db.transaction(() => {
    stmts.updateInventory.run(JSON.stringify(updatedInventory), userId);
    const { lastInsertRowid } = stmts.insertBmListing.run(userId, normalized);
    return lastInsertRowid;
  })();

  const heat = getHeat();
  return {
    listingId,
    letter:          normalized,
    listedAt:        Math.floor(Date.now() / 1000),
    heat,
    catchProbPerMin: catchProbForHeat(heat),
    expiresIn:       BLACK_MARKET_LISTING_SEC,
    newInventory:    updatedInventory,
  };
}

/**
 * Collect a pending listing – user claims their full SELL_BASE_PRICE coins.
 * Throws if the listing does not belong to the user or is no longer pending.
 *
 * @param {number} userId
 * @param {number} listingId
 */
function collectListing(userId, listingId) {
  const listing = stmts.getBmListing.get(Number(listingId));
  if (!listing)                    throw new Error('Listado no encontrado.');
  if (listing.user_id !== userId)  throw new Error('No es tu listado.');
  if (listing.status !== 'pending') {
    const labels = { collected: 'ya cobrado', caught: 'confiscado', expired: 'expirado' };
    throw new Error(`Este listado ya fue ${labels[listing.status] || 'cerrado'}.`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const earned = SELL_BASE_PRICE;

  const { newCoins } = db.transaction(() => {
    stmts.resolveBmListing.run('collected', earned, nowSec, listing.id);
    stmts.updateCoins.run(earned, userId);
    return { newCoins: stmts.getUser.get(userId).coins };
  })();

  return { listingId: listing.id, letter: listing.letter, earned, newCoins };
}

// ── Per-minute sweep ──────────────────────────────────────────────────────────

/**
 * Called by the server scheduler every 60 seconds.
 *
 * Order of operations:
 *   1. Expire listings older than BLACK_MARKET_LISTING_SEC (return letters).
 *   2. Decay global heat by HEAT_DECAY_RATE.
 *   3. Roll each remaining pending listing against catchProbForHeat.
 *      Each catch immediately increments heat for subsequent rolls.
 *
 * @returns {{ caught: Array, expired: Array }}
 */
function sweepCatchRolls() {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - BLACK_MARKET_LISTING_SEC;

  // ── 1. Expire stale listings (return letters) ─────────────────────────────
  const toExpire = stmts.getExpiredBmListings.all(cutoff);
  const expired  = [];

  for (const listing of toExpire) {
    const result = db.transaction(() => {
      const u   = stmts.getUser.get(listing.user_id);
      const inv = JSON.parse(u.inventory_json || '{}');
      inv[listing.letter] = (inv[listing.letter] || 0) + 1;
      stmts.updateInventory.run(JSON.stringify(inv), listing.user_id);
      stmts.resolveBmListing.run('expired', 0, nowSec, listing.id);
      return { newInventory: inv };
    })();

    expired.push({
      listingId:    listing.id,
      userId:       listing.user_id,
      letter:       listing.letter,
      newInventory: result.newInventory,
    });
  }

  // ── 2. Decay heat ──────────────────────────────────────────────────────────
  let currentHeat = setHeat(getHeat() * HEAT_DECAY_RATE);

  // ── 3. Roll all remaining pending listings ────────────────────────────────
  const pending = stmts.getPendingBmListings.all();
  const caught  = [];

  for (const listing of pending) {
    const prob = catchProbForHeat(currentHeat);

    if (Math.random() < prob) {
      const fine = BLACK_MARKET_FINE;

      const catchData = db.transaction(() => {
        stmts.resolveBmListing.run('caught', -fine, nowSec, listing.id);
        stmts.updateCoins.run(-fine, listing.user_id);
        const fresh = stmts.getUser.get(listing.user_id);
        return {
          newCoins:     fresh.coins,
          newInventory: JSON.parse(fresh.inventory_json || '{}'),
        };
      })();

      // Each catch raises heat for the listings processed after it this sweep
      currentHeat = setHeat(currentHeat + HEAT_CATCH_INCREMENT);

      caught.push({
        listingId: listing.id,
        userId:    listing.user_id,
        letter:    listing.letter,
        fine,
        ...catchData,
      });
    }
  }

  return { caught, expired };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** @returns {Array} user's 20 most recent listings (any status) */
function getUserListings(userId) {
  return stmts.getUserBmListings.all(userId);
}

module.exports = {
  listLetter,
  collectListing,
  sweepCatchRolls,
  getUserListings,
  addMentionHeat,
  getHeat,
  catchProbForHeat,
};
