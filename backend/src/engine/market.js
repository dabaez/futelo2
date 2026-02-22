'use strict';

/**
 * Futelo – P2P Letter Market Engine
 * ════════════════════════════════════
 * Powers both the regular market and the secret black market via a single
 * factory function.  Coins always flow directly buyer → seller.
 *
 * Regular market exports:
 *   listLetter(sellerId, letter, price)   → { listingId, letter, price, newInventory }
 *   buyListing(buyerId, listingId)        → { listingId, letter, price, sellerId, newInventory, newCoins }
 *   cancelListing(sellerId, listingId)    → { listingId, letter, newInventory }
 *   getOpenListings()                     → [...listings with seller names]
 *   getUserListings(userId)               → last 20 listings (any status)
 *
 * Black market exports (same signatures, separate DB table):
 *   bmListLetter / bmBuyListing / bmCancelListing / getBmOpenListings / getBmUserListings
 */

const { db, stmts, requireUser } = require('../db/database');
const { SELL_BASE_PRICE, MARKET_MAX_PRICE, MAX_LETTER_LEVEL, MARKET_COMMISSION } = require('../config');

// ── Validation helper ─────────────────────────────────────────────────────

function isValidInventoryKey(key) {
  if (key === '_numbers' || key === '_symbols') return true;
  return /^[a-záéíóúüñ]$/.test(key);
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Returns a complete market API (listLetter, buyListing, cancelListing,
 * getOpenListings, getUserListings) bound to the given set of prepared stmts.
 *
 * @param {object} s           { insert, getListing, resolve, getOpen, getUserList }
 * @param {number} [commission=0]  Fraction of the sale price that is taxed (burned).
 *                               Seller receives floor(price * (1 - commission)).
 */
function makeMarket(s, commission = 0) {

  function listLetter(sellerId, letter, price) {
    requireUser(sellerId);
    if (!isValidInventoryKey(letter)) throw new Error(`Letra inválida: "${letter}".`);
    const priceInt = Math.floor(Number(price));
    if (!Number.isFinite(priceInt) || priceInt < 1 || priceInt > MARKET_MAX_PRICE) {
      throw new Error(`El precio debe estar entre 1 y ${MARKET_MAX_PRICE} monedas.`);
    }
    return db.transaction(() => {
      const seller  = requireUser(sellerId);
      const inv     = JSON.parse(seller.inventory_json);
      const current = inv[letter] ?? 0;
      if (current <= 0) throw new Error(`Sin inventario de "${letter}" para listar.`);
      inv[letter] = current - 1;
      if (inv[letter] === 0) delete inv[letter];
      stmts.updateInventory.run(JSON.stringify(inv), sellerId);
      const result = s.insert.run(sellerId, letter, priceInt);
      return { listingId: result.lastInsertRowid, letter, price: priceInt, newInventory: inv };
    })();
  }

  function buyListing(buyerId, listingId) {
    requireUser(buyerId);
    return db.transaction(() => {
      const listing = s.getListing.get(listingId);
      if (!listing) throw new Error('Listado no encontrado.');
      if (listing.status !== 'open') throw new Error('Este listado ya no está disponible.');
      if (listing.seller_id === buyerId) throw new Error('No puedes comprar tu propio listado.');
      const buyer = requireUser(buyerId);
      if ((buyer.coins ?? 0) < listing.price) {
        throw new Error(`Monedas insuficientes. Necesitas ${listing.price} 🪙.`);
      }
      const sellerReceives = Math.floor(listing.price * (1 - commission));
      stmts.updateCoins.run(-listing.price,   buyerId);
      stmts.updateCoins.run( sellerReceives,  listing.seller_id);
      const buyerFresh = requireUser(buyerId);
      const inv = JSON.parse(buyerFresh.inventory_json);
      inv[listing.letter] = Math.min((inv[listing.letter] ?? 0) + 1, MAX_LETTER_LEVEL);
      stmts.updateInventory.run(JSON.stringify(inv), buyerId);
      const now = Math.floor(Date.now() / 1000);
      s.resolve.run('sold', buyerId, now, listingId);
      const buyerUpdated = requireUser(buyerId);
      return {
        listingId,
        letter:         listing.letter,
        price:          listing.price,
        sellerReceives,
        sellerId:       listing.seller_id,
        newInventory:   inv,
        newCoins:       buyerUpdated.coins,
      };
    })();
  }

  function cancelListing(sellerId, listingId) {
    requireUser(sellerId);
    return db.transaction(() => {
      const listing = s.getListing.get(listingId);
      if (!listing) throw new Error('Listado no encontrado.');
      if (listing.seller_id !== sellerId) throw new Error('No puedes cancelar el listado de otro jugador.');
      if (listing.status !== 'open') throw new Error('Este listado ya no está activo.');
      const seller = requireUser(sellerId);
      const inv = JSON.parse(seller.inventory_json);
      inv[listing.letter] = Math.min((inv[listing.letter] ?? 0) + 1, MAX_LETTER_LEVEL);
      stmts.updateInventory.run(JSON.stringify(inv), sellerId);
      const now = Math.floor(Date.now() / 1000);
      s.resolve.run('cancelled', null, now, listingId);
      return { listingId, letter: listing.letter, newInventory: inv };
    })();
  }

  function getOpenListings()         { return s.getOpen.all();        }
  function getUserListings(userId)   { return s.getUserList.all(userId); }

  return { listLetter, buyListing, cancelListing, getOpenListings, getUserListings };
}

// ── Instantiate both markets ──────────────────────────────────────────────

const regularMarket = makeMarket({
  insert:      stmts.insertMarketListing,
  getListing:  stmts.getMarketListing,
  resolve:     stmts.resolveMarketListing,
  getOpen:     stmts.getOpenMarketListings,
  getUserList: stmts.getUserMarketListings,
}, MARKET_COMMISSION);

const blackMarket = makeMarket({
  insert:      stmts.insertBmListing,
  getListing:  stmts.getBmListing,
  resolve:     stmts.resolveBmListing,
  getOpen:     stmts.getOpenBmListings,
  getUserList: stmts.getUserBmListings,
});

module.exports = {
  // Regular market
  listLetter:      regularMarket.listLetter,
  buyListing:      regularMarket.buyListing,
  cancelListing:   regularMarket.cancelListing,
  getOpenListings: regularMarket.getOpenListings,
  getUserListings: regularMarket.getUserListings,

  // Secret black market
  bmListLetter:      blackMarket.listLetter,
  bmBuyListing:      blackMarket.buyListing,
  bmCancelListing:   blackMarket.cancelListing,
  getBmOpenListings: blackMarket.getOpenListings,
  getBmUserListings: blackMarket.getUserListings,

  SELL_BASE_PRICE,
  MARKET_MAX_PRICE,
  MARKET_COMMISSION,
};
