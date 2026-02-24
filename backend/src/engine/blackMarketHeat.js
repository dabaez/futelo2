'use strict';

/**
 * Futelo – Black Market Heat Engine
 * ════════════════════════════════════
 * Manages the global "heat" level that drives the black market catch probability.
 *
 * Heat mechanics:
 *   - Ranges 0–BM_HEAT_MAX (0–100).
 *   - Decays passively at BM_HEAT_DECAY_PER_MIN points per real minute.
 *   - Increases when a seller is caught (+BM_HEAT_CATCH_INCREMENT).
 *   - Increases when someone mentions "mercado negro" in chat (+BM_HEAT_CHAT_INCREMENT).
 *
 * Catch check (runs every BM_CHECK_INTERVAL_SEC):
 *   - All open BM listings are tested against catchProbability(currentHeat).
 *   - Caught sellers are fined BM_CATCH_FINE coins; the listed letter is lost.
 *   - Listings older than BM_LISTING_EXPIRY_SEC are auto-expired: letter returned, no coins.
 *
 * Heat is persisted in the `game_state` table under two keys:
 *   - "bm_heat"    → floating-point string, the stored value before decay
 *   - "bm_heat_ts" → Unix timestamp (seconds) of the last heat write
 *
 * Exported:
 *   getCurrentHeat()               → number  (0–100, decay applied)
 *   addHeat(delta)                 → number  (new heat after adding delta)
 *   catchProbability(heat)         → number  (0.05–0.30)
 *   runCatchCheck()                → { caught, expired, heat }
 */

const { db, stmts } = require('../db/database');
const {
  BM_HEAT_MAX,
  BM_HEAT_DECAY_PER_MIN,
  BM_HEAT_CATCH_INCREMENT,
  BM_BASE_CATCH_PROB,
  BM_HEAT_CATCH_SCALE,
  BM_CATCH_FINE,
  BM_LISTING_EXPIRY_SEC,
  MAX_LETTER_LEVEL,
} = require('../config');

// ── Heat read/write ───────────────────────────────────────────────────────────

function getRawHeat() {
  const row = stmts.getState.get('bm_heat');
  return row ? Number(row.value) : 0;
}

function getHeatTs() {
  const row = stmts.getState.get('bm_heat_ts');
  return row ? Number(row.value) : Math.floor(Date.now() / 1000);
}

/**
 * Returns the current heat with time-based decay applied.
 * Does NOT write to the DB — purely a read operation.
 */
function getCurrentHeat() {
  const stored    = getRawHeat();
  const ts        = getHeatTs();
  const nowSec    = Math.floor(Date.now() / 1000);
  const elapsedMin = (nowSec - ts) / 60;
  const decayed   = stored - BM_HEAT_DECAY_PER_MIN * elapsedMin;
  return Math.max(0, Math.min(BM_HEAT_MAX, decayed));
}

/**
 * Persist a new heat value (clamped 0–BM_HEAT_MAX) and update the timestamp.
 * Returns the clamped value.
 */
function setHeat(value) {
  const clamped = Math.max(0, Math.min(BM_HEAT_MAX, value));
  stmts.setState.run('bm_heat',    String(clamped));
  stmts.setState.run('bm_heat_ts', String(Math.floor(Date.now() / 1000)));
  return clamped;
}

/**
 * Add delta to the current (decayed) heat and persist.
 * Returns the new heat value.
 */
function addHeat(delta) {
  return setHeat(getCurrentHeat() + delta);
}

// ── Probability ───────────────────────────────────────────────────────────────

/**
 * Returns the catch probability for a single listing check cycle.
 * Ranges from BM_BASE_CATCH_PROB (heat=0) to
 * BM_BASE_CATCH_PROB + BM_HEAT_CATCH_SCALE (heat=100).
 *
 * Default: 5% at heat=0, 30% at heat=100.
 */
function catchProbability(heat) {
  return BM_BASE_CATCH_PROB + BM_HEAT_CATCH_SCALE * (heat / BM_HEAT_MAX);
}

// ── Catch check ───────────────────────────────────────────────────────────────

/**
 * Runs one full catch & expiry cycle over all open BM listings.
 *
 * For each open listing:
 *   - If older than BM_LISTING_EXPIRY_SEC: resolve as 'expired', return letter to seller.
 *   - Otherwise: roll against catchProbability(heat).
 *     If caught: fine seller BM_CATCH_FINE coins, resolve as 'caught' (letter lost).
 *
 * All DB writes are wrapped in a single transaction.
 * Heat is updated after the transaction based on how many sellers were caught.
 *
 * @returns {{
 *   caught:  Array<{ sellerId, letter, fine, listingId }>,
 *   expired: Array<{ sellerId, letter, listingId }>,
 *   heat:    number   (new heat value, or current if nothing changed)
 * }}
 */
function runCatchCheck() {
  const nowSec   = Math.floor(Date.now() / 1000);
  const listings = stmts.getAllOpenBmListingsGlobal.all();
  if (listings.length === 0) {
    return { caught: [], expired: [], heat: getCurrentHeat() };
  }

  const heat = getCurrentHeat();
  const prob = catchProbability(heat);

  const caught  = [];
  const expired = [];

  db.transaction(() => {
    for (const listing of listings) {
      const age = nowSec - listing.listed_at;

      if (age >= BM_LISTING_EXPIRY_SEC) {
        // ── Expired: return letter to seller ──────────────────────────────
        const seller = stmts.getUser.get(listing.seller_id);
        if (seller) {
          const inv = JSON.parse(seller.inventory_json || '{}');
          inv[listing.letter] = Math.min((inv[listing.letter] || 0) + 1, MAX_LETTER_LEVEL);
          stmts.updateInventory.run(JSON.stringify(inv), listing.seller_id);
        }
        stmts.resolveBmListing.run('expired', null, nowSec, listing.id);
        expired.push({ sellerId: listing.seller_id, letter: listing.letter, listingId: listing.id, roomId: listing.room_id });

      } else if (Math.random() < prob) {
        // ── Caught: fine the seller, letter is forfeited ──────────────────
        stmts.updateCoins.run(-BM_CATCH_FINE, listing.seller_id);
        stmts.resolveBmListing.run('caught', null, nowSec, listing.id);
        caught.push({ sellerId: listing.seller_id, letter: listing.letter, fine: BM_CATCH_FINE, listingId: listing.id, roomId: listing.room_id });
      }
    }
  })();

  // Update heat outside the transaction (game_state, not BM listings)
  let newHeat = heat;
  if (caught.length > 0) {
    newHeat = setHeat(heat + BM_HEAT_CATCH_INCREMENT * caught.length);
  }

  return { caught, expired, heat: newHeat };
}

module.exports = {
  getCurrentHeat,
  addHeat,
  catchProbability,
  runCatchCheck,
};
