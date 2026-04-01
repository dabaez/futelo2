'use strict';

/**
 * Futelo – Achievement Engine
 * ───────────────────────────
 * Defines all achievements and exposes `checkAchievements(userId, roomId, event, data)`.
 *
 * Calling convention:
 *   - Call `checkAchievements` from server.js after every relevant user action.
 *   - The function updates running counters in `user_stats`, reads fresh state,
 *     awards any newly earned achievements (coins + DB record), and returns the
 *     list of newly earned achievement objects so the caller can send toasts.
 *
 * All DB writes happen inside a single transaction so a crash mid-way never
 * leaves the user with partial awards.
 */

const { db, stmts } = require('../db/database');
const { EMOJI_RECIPES, MAX_LETTER_LEVEL } = require('../config');

// All inventory keys that must be at a given level for keyboard achievements
const ALL_INVENTORY_KEYS = [
  ...'abcdefghijklmnopqrstuvwxyzñ'.split(''),
  '_numbers',
  '_symbols',
];

const TOTAL_EMOJIS = EMOJI_RECIPES.length;

/**
 * Full catalogue of achievements.
 * Fields: id, name, desc, reward (coins), icon, category
 */
const ACHIEVEMENTS = [
  // ── Mensajes ───────────────────────────────────────────────────────────────
  { id: 'first_message',    name: '¡Hola, Mundo!',          desc: 'Envía tu primer mensaje.',                                 reward: 50,  icon: '💬', category: 'Mensajes'  },
  { id: 'messages_50',      name: 'Conversador',            desc: 'Envía 50 mensajes.',                                       reward: 30,  icon: '📣', category: 'Mensajes'  },
  { id: 'messages_200',     name: 'Locuaz',                 desc: 'Envía 200 mensajes.',                                      reward: 60,  icon: '📢', category: 'Mensajes'  },
  { id: 'messages_1000',    name: 'Inagotable',             desc: 'Envía 1000 mensajes.',                                     reward: 150, icon: '🗣️', category: 'Mensajes'  },
  { id: 'messages_3000',    name: 'Máquina del chat',       desc: 'Envía 3000 mensajes.',                                     reward: 300, icon: '📡', category: 'Mensajes'  },
  { id: 'messages_10000',   name: 'I <3 Futelo',            desc: 'Envía 10000 mensajes.',                                    reward: 500, icon: '🌐', category: 'Mensajes'  },
  { id: 'miso',             name: '¿Sopa de Miso?',         desc: 'Menciona "miso soup" en un mensaje.',                      reward: 30,  icon: '🍜', category: 'Mensajes'  }, // matches: miso soup, misosoup, miso-soup

  // ── Teclado ────────────────────────────────────────────────────────────────
  { id: 'full_keyboard',    name: 'Alfabeto Completo',      desc: 'Desbloquea al menos una vez cada letra, número y símbolo.', reward: 200, icon: '⌨️', category: 'Teclado'   },
  { id: 'double_all',       name: 'Dos de Todo',            desc: 'Lleva todas las letras al nivel 2.',                       reward: 100, icon: '✌️', category: 'Teclado'   },
  { id: 'halfway',          name: 'A mitad del camino',     desc: 'Desbloquea la mitad de las letras.',                       reward: 75,  icon: '🌓', category: 'Teclado'   },
  { id: 'max_all',          name: 'Sin límites',            desc: `Lleva todas las letras al nivel máximo (${MAX_LETTER_LEVEL}).`, reward: 500, icon: '🏆', category: 'Teclado'   },
  // ── Tienda ─────────────────────────────────────────────────────────────────
  { id: 'roll_10',          name: 'Adicto a la Tienda',     desc: 'Compra 10 cajitas de letras.',                             reward: 50,  icon: '📦', category: 'Tienda'    },
  { id: 'roll_50',          name: 'Fanático de la Tienda',  desc: 'Compra 50 cajitas de letras.',                             reward: 150, icon: '🎁', category: 'Tienda'    },
  { id: 'roll_legendary',   name: 'Toque Legendario',       desc: 'Consigue una cajita legendaria.',                          reward: 100, icon: '👑', category: 'Tienda'    },
  { id: 'roll_bad_streak',  name: '99% de los apostadores', desc: 'Consigue 5 cajitas comunes seguidas.',                     reward: 25,  icon: '📫', category: 'Tienda'    },

  // ── Mercado ────────────────────────────────────────────────────────────────
  { id: 'market_buy',       name: 'Primer Comprador',       desc: 'Compra una letra en el mercado.',                          reward: 20,  icon: '🛒', category: 'Mercado'   },
  { id: 'market_buy_10',    name: 'Cliente Frecuente',   desc: 'Compra 10 letras en el mercado.',                             reward: 50,  icon: '🛍️', category: 'Mercado'   },
  { id: 'market_buy_30',    name: 'Don Compras',         desc: 'Compra 30 letras en el mercado.',                            reward: 100, icon: '🛍️', category: 'Mercado'   },
  { id: 'market_sell',      name: 'Primer Vendedor',        desc: 'Vende una letra en el mercado.',                           reward: 20,  icon: '🏪', category: 'Mercado'   },
  { id: 'market_sell_10',   name: 'Armando la PYME',    desc: 'Vende 10 letras en el mercado.',                             reward: 50,  icon: '🏪', category: 'Mercado'   },
  { id: 'market_sell_30',   name: 'Don Ventas',             desc: 'Vende 30 letras en el mercado.',                           reward: 100, icon: '🏢', category: 'Mercado'   },
  { id: 'bm_buy',           name: 'Cliente Clandestino',    desc: 'Compra en el mercado negro.',                              reward: 30,  icon: '🌑', category: 'Mercado'   },
  { id: 'bm_sell',          name: 'Mercader Oscuro',        desc: 'Vende en el mercado negro.',                               reward: 30,  icon: '🕵️', category: 'Mercado'   },
  { id: 'bm_caught',        name: 'Pillado In Fraganti',    desc: 'Que te pillen vendiendo en el mercado negro.',             reward: 15,  icon: '🚔', category: 'Mercado'   },

  // ── Mina ───────────────────────────────────────────────────────────────────
  { id: 'mine_first',       name: 'Primer Hallazgo',        desc: 'Encuentra tu primera letra minando.',                      reward: 30,  icon: '⛏️', category: 'Mina'      },
  { id: 'mine_50',          name: 'Minero Dedicado',        desc: 'Encuentra 50 letras minando.',                             reward: 80,  icon: '💎', category: 'Mina'      },
  { id: 'mine_fail_streak', name: 'Esta mina no sirve',     desc: 'Falla 300 golpes seguidos en la mina.',                     reward: 20,  icon: '🪨', category: 'Mina'      },

  // ── Apuestas ───────────────────────────────────────────────────────────────
  { id: 'lottery_win',      name: 'Millonario',       desc: 'Gana una ronda de apuestas.',                              reward: 50,  icon: '🎰', category: 'Apuestas'  },
  { id: 'lottery_win_2',    name: 'Un rayo no golpea dos veces', desc: 'Gana dos rondas de apuestas.',                      reward: 100, icon: '⚡', category: 'Apuestas'  },
  { id: 'lottery_small_win', name: 'No tan millonario',      desc: 'Gana menos de 500 monedas en una ronda de apuestas.',      reward: 25,  icon: '🪙', category: 'Apuestas'  },
  { id: 'lottery_participate',     name: 'Empezando el vicio',desc: 'Participa en una ronda de apuestas.',                            reward: 10,  icon: '💸', category: 'Apuestas'  },
  { id: 'lottery_participate_10',  name: 'Lo puedo dejar cuando quiera', desc: 'Participa en 10 rondas de apuestas.',                reward: 30,  icon: '🎲', category: 'Apuestas'  },
  { id: 'lottery_participate_30',  name: 'Tienes un problema',          desc: 'Participa en 30 rondas de apuestas.',                reward: 75,  icon: '🎲', category: 'Apuestas'  },
  { id: 'lottery_participate_50',  name: 'Esto es una intervención',    desc: 'Participa en 50 rondas de apuestas.',                reward: 150, icon: '🎲', category: 'Apuestas'  },
  { id: 'lottery_bet_10',         name: 'Considéralo una inversión',   desc: 'Apuesta 10 letras.',                                 reward: 40,  icon: '💰', category: 'Apuestas'  },
  { id: 'lottery_bet_50',         name: 'A la larga vas a salir ganando', desc: 'Apuesta 50 letras.',                              reward: 100, icon: '💰', category: 'Apuestas'  },
  { id: 'lottery_bet_100',        name: 'Lo he perdido todo',          desc: 'Apuesta 100 letras.',                                reward: 200, icon: '💰', category: 'Apuestas'  },
  { id: 'lottery_bet_6_rounds',   name: 'Mejorando las probabilidades', desc: 'Apuesta 6 letras en una ronda.',                     reward: 30,  icon: '🃏', category: 'Apuestas'  },
  { id: 'lottery_bet_7_rounds',   name: 'Los errores me resbalan',     desc: 'Apuesta 7 letras en una ronda.',                     reward: 40,  icon: '🃏', category: 'Apuestas'  },
  { id: 'lottery_bet_8_rounds',   name: 'Tankeador de errores',        desc: 'Apuesta 8 letras en una ronda.',                     reward: 60,  icon: '🃏', category: 'Apuestas'  },
  { id: 'lottery_bet_9_rounds',   name: 'Técnicamente posible',        desc: 'Apuesta 9 letras en una ronda.',                     reward: 100, icon: '🃏', category: 'Apuestas'  },

  // ── Emojis ─────────────────────────────────────────────────────────────────
  { id: 'emoji_first',      name: 'Primera Reacción',       desc: 'Desbloquea tu primer emoji forjado.',                      reward: 50,  icon: '🧪', category: 'Emojis'    },
  { id: 'emoji_5',          name: 'Coleccionista',          desc: 'Desbloquea 5 emojis.',                                     reward: 100, icon: '🎭', category: 'Emojis'    },
  { id: 'emoji_10',        name: 'Maestro Forjador',       desc: `Desbloquea 10 emojis.`,           reward: 200, icon: '🌟', category: 'Emojis'    },

  // ── Community ──────────────────────────────────────────────────────────────
  { id: 'prompt_win',       name: 'Favorito del Público',   desc: 'Gana una votación de Community.',                          reward: 75,  icon: '🏅', category: 'Community' },
  { id: 'prompt_win_3',          name: 'Comediante del grupo',        desc: 'Gana 3 votaciones de Community.',                    reward: 100, icon: '🥇', category: 'Community' },
  { id: 'prompt_win_5',          name: "Te vas pa' viña",             desc: 'Gana 5 votaciones de Community.',                    reward: 200, icon: '🎤', category: 'Community' },
  { id: 'prompt_lose_5',    name: 'Perseverante',           desc: 'Participa sin ganar en Community 5 veces.',                reward: 25,  icon: '💪', category: 'Community' },
  { id: 'prompt_vote_loser',     name: 'Chiste de nicho',             desc: 'Sé el único en votar por una respuesta.',           reward: 20,  icon: '🤡', category: 'Community' },
  { id: 'prompt_vote_winner',    name: 'Gusto popular',               desc: 'Vota por la respuesta con más votos.',               reward: 15,  icon: '👍', category: 'Community' },
  { id: 'prompt_vote_winner_10', name: 'Yo entiendo al pueblo',       desc: 'Vota por la respuesta con más votos 10 veces.',      reward: 75,  icon: '🫵', category: 'Community' },
  { id: 'prompt_win_2nd',        name: 'Segundo lugar es el primer perdedor', desc: 'Queda segundo en una votación de Community.', reward: 30,  icon: '🥈', category: 'Community' },
];

// Achievements eligible to be checked for each event type
const EVENT_CHECKS = {
  message:          ['first_message', 'messages_50', 'messages_200', 'messages_1000', 'messages_3000', 'messages_10000', 'miso',
                     'full_keyboard', 'double_all', 'halfway', 'max_all'],
  roll:             ['roll_10', 'roll_50', 'roll_legendary', 'roll_bad_streak',
                     'full_keyboard', 'double_all', 'halfway', 'max_all'],
  mine_swing:       ['mine_first', 'mine_50', 'mine_fail_streak'],
  market_buy:       ['market_buy', 'market_buy_10', 'market_buy_30'],
  market_sell:      ['market_sell', 'market_sell_10', 'market_sell_30'],
  bm_buy:           ['bm_buy'],
  bm_sell:          ['bm_sell'],
  bm_caught:        ['bm_caught'],
  lottery_bet:      ['lottery_participate', 'lottery_participate_10', 'lottery_participate_30', 'lottery_participate_50',
                     'lottery_bet_10', 'lottery_bet_50', 'lottery_bet_100',
                     'lottery_bet_6_rounds', 'lottery_bet_7_rounds', 'lottery_bet_8_rounds', 'lottery_bet_9_rounds'],
  lottery_win:      ['lottery_win', 'lottery_win_2', 'lottery_small_win'],
  lottery_lose:     [], // kept for forward-compat; no achievements currently reference it
  emoji_unlock:     ['emoji_first', 'emoji_5', 'emoji_10'],
  prompt_win:       ['prompt_win', 'prompt_win_3', 'prompt_win_5'],
  prompt_lose:      ['prompt_lose_5'],
  prompt_runner_up: ['prompt_win_2nd'],
  prompt_vote_win:  ['prompt_vote_winner', 'prompt_vote_winner_10'],
  prompt_vote_only: ['prompt_vote_loser'],
};

/**
 * Check for newly earned achievements after a game event and award them.
 *
 * @param {number} userId   Telegram user id
 * @param {number} roomId   Room where the event occurred; reward coins go here
 * @param {string} event    One of the EVENT_CHECKS keys
 * @param {object} [data]   Event-specific payload (text, rarity, found, …)
 * @returns {Array}         Newly earned achievement objects { id, name, reward, icon, … }
 */
function checkAchievements(userId, roomId, event, data = {}) {
  // Ensure the user_stats row exists before any UPDATE statements fire
  stmts.upsertUserStats.run(userId, roomId);

  // ── Update running counters based on event ─────────────────────────────────
  if (event === 'mine_swing') {
    if (data.found) stmts.statMineFind.run(userId, roomId);
    else            stmts.statMineFail.run(userId, roomId);
  } else if (event === 'roll') {
    stmts.statLootbox.run(userId, roomId);
    if (data.rarity === 'común') stmts.statLootboxCommon.run(userId, roomId);
    else                         stmts.statLootboxNotCommon.run(userId, roomId);
  } else if (event === 'prompt_lose') {
    stmts.statPromptLoss.run(userId, roomId);
  } else if (event === 'market_buy') {
    stmts.statMarketBuy.run(userId, roomId);
  } else if (event === 'market_sell') {
    stmts.statMarketSell.run(userId, roomId);
  } else if (event === 'lottery_bet') {
    stmts.statLotteryBet.run(userId, roomId);
    if (data.betsInRound === 1) stmts.statLotteryParticipate.run(userId, roomId);
    stmts.statLotteryBetsInRound.run(data.betsInRound || 1, userId, roomId);
  } else if (event === 'lottery_win') {
    stmts.statLotteryWin.run(userId, roomId);
  } else if (event === 'prompt_win') {
    stmts.statPromptWin.run(userId, roomId);
  } else if (event === 'prompt_vote_win') {
    stmts.statPromptCorrectVote.run(userId, roomId);
  }

  // ── Read current state ─────────────────────────────────────────────────────
  const stats      = stmts.getUserStats.get(userId, roomId);
  const earnedSet  = new Set(stmts.getEarnedAchievements.all(userId, roomId).map((r) => r.achievement_id));
  const rm         = stmts.getRoomMember.get(roomId, userId);
  const inv        = rm ? JSON.parse(rm.inventory_json || '{}') : {};
  const msgCnt     = stmts.getUserMessageCount.get(userId).cnt;
  const emojiCount = stmts.getUnlockedEmojis.all(userId, roomId).length;

  const toCheck = EVENT_CHECKS[event] || [];

  const newlyEarned = [];
  for (const ach of ACHIEVEMENTS) {
    if (!toCheck.includes(ach.id)) continue;
    if (earnedSet.has(ach.id)) continue;
    if (_isMet(ach.id, { inv, msgCnt, stats, data, emojiCount })) {
      newlyEarned.push(ach);
    }
  }

  if (newlyEarned.length === 0) return [];

  // Award all in one transaction: record + coin grant
  db.transaction(() => {
    for (const ach of newlyEarned) {
      stmts.insertUserAchievement.run(userId, roomId, ach.id);
      stmts.updateRoomCoins.run(ach.reward, roomId, userId);
    }
  })();

  return newlyEarned;
}

/** Test whether a single achievement's condition is satisfied. */
function _isMet(id, { inv, msgCnt, stats, data, emojiCount }) {
  switch (id) {
    // ── Mensajes
    case 'first_message':          return msgCnt >= 1;
    case 'messages_50':            return msgCnt >= 50;
    case 'messages_200':           return msgCnt >= 200;
    case 'messages_1000':          return msgCnt >= 1000;
    case 'messages_3000':          return msgCnt >= 3000;
    case 'messages_10000':         return msgCnt >= 10000;
    case 'miso':                   return /miso[\s-]?soup/i.test(data.text || '');
    // ── Teclado
    case 'full_keyboard':          return ALL_INVENTORY_KEYS.every((k) => (inv[k] || 0) >= 1);
    case 'double_all':             return ALL_INVENTORY_KEYS.every((k) => (inv[k] || 0) >= 2);
    case 'halfway':                return ALL_INVENTORY_KEYS.filter((k) => (inv[k] || 0) >= 1).length >= Math.ceil(ALL_INVENTORY_KEYS.length / 2);
    case 'max_all':                return ALL_INVENTORY_KEYS.every((k) => (inv[k] || 0) >= MAX_LETTER_LEVEL);
    // ── Tienda
    case 'roll_10':                return (stats.lootboxes_total            || 0) >= 10;
    case 'roll_50':                return (stats.lootboxes_total            || 0) >= 50;
    case 'roll_legendary':         return data.rarity === 'legendario';
    case 'roll_bad_streak':        return (stats.consecutive_common_boxes   || 0) >= 5;
    // ── Mercado
    case 'market_buy':             return true;
    case 'market_buy_10':          return (stats.market_buys                || 0) >= 10;
    case 'market_buy_30':          return (stats.market_buys                || 0) >= 30;
    case 'market_sell':            return true;
    case 'market_sell_10':         return (stats.market_sells               || 0) >= 10;
    case 'market_sell_30':         return (stats.market_sells               || 0) >= 30;
    case 'bm_buy':                 return true;
    case 'bm_sell':                return true;
    case 'bm_caught':              return true;
    // ── Mina
    case 'mine_first':             return (stats.mine_finds                 || 0) >= 1;
    case 'mine_50':                return (stats.mine_finds                 || 0) >= 50;
    case 'mine_fail_streak':       return (stats.consecutive_mine_fails     || 0) >= 300;
    // ── Apuestas
    case 'lottery_win':            return true;
    case 'lottery_win_2':          return (stats.lottery_wins               || 0) >= 2;
    case 'lottery_small_win':      return (data.coinsEarned || 0) > 0 && (data.coinsEarned || 0) < 500;
    case 'lottery_participate':    return (stats.lottery_participations     || 0) >= 1;
    case 'lottery_participate_10': return (stats.lottery_participations     || 0) >= 10;
    case 'lottery_participate_30': return (stats.lottery_participations     || 0) >= 30;
    case 'lottery_participate_50': return (stats.lottery_participations     || 0) >= 50;
    case 'lottery_bet_10':         return (stats.lottery_bets_total         || 0) >= 10;
    case 'lottery_bet_50':         return (stats.lottery_bets_total         || 0) >= 50;
    case 'lottery_bet_100':        return (stats.lottery_bets_total         || 0) >= 100;
    case 'lottery_bet_6_rounds':   return (stats.lottery_bets_in_round      || 0) >= 6;
    case 'lottery_bet_7_rounds':   return (stats.lottery_bets_in_round      || 0) >= 7;
    case 'lottery_bet_8_rounds':   return (stats.lottery_bets_in_round      || 0) >= 8;
    case 'lottery_bet_9_rounds':   return (stats.lottery_bets_in_round      || 0) >= 9;
    // ── Emojis
    case 'emoji_first':            return emojiCount >= 1;
    case 'emoji_5':                return emojiCount >= 5;
    case 'emoji_10':               return emojiCount >= 10;
    // ── Community
    case 'prompt_win':             return true;
    case 'prompt_win_3':           return (stats.prompt_wins                || 0) >= 3;
    case 'prompt_win_5':           return (stats.prompt_wins                || 0) >= 5;
    case 'prompt_lose_5':          return (stats.prompt_losses              || 0) >= 5;
    case 'prompt_win_2nd':         return true;
    case 'prompt_vote_winner':     return true;
    case 'prompt_vote_winner_10':  return (stats.prompt_correct_votes       || 0) >= 10;
    case 'prompt_vote_loser':      return true;
    default:                       return false;
  }
}

/**
 * One-time startup backfill: award achievements reconstructable from existing
 * DB history. Safe to call repeatedly — already-earned achievements are skipped.
 *
 * Reconstructed from DB:
 *   first_message, messages_50/200/1000, miso, full_keyboard, double_all,
 *   max_all, market_buy/sell, bm_buy/sell, lottery_win/lose, emoji_first/5/all
 *
 * Skipped (no historical data — will accumulate from now):
 *   roll_10/50/legendary/bad_streak, mine_first/50/fail_streak,
 *   prompt_win, prompt_lose_5
 */
function backfillAchievements() {
  // Prepare statements once, outside the per-user/room loop
  const getUserRooms      = db.prepare('SELECT DISTINCT user_id, room_id FROM room_members WHERE room_id != 0');
  const misoCheck         = db.prepare("SELECT 1 FROM messages WHERE user_id = ? AND (lower(text) LIKE '%miso soup%' OR lower(text) LIKE '%misosoup%' OR lower(text) LIKE '%miso-soup%') LIMIT 1");
  const mktBoughtCnt      = db.prepare("SELECT COUNT(*) as cnt FROM market_listings WHERE buyer_id = ? AND status = 'sold' AND room_id = ?");
  const mktSoldCnt        = db.prepare("SELECT COUNT(*) as cnt FROM market_listings WHERE seller_id = ? AND status = 'sold' AND room_id = ?");
  const bmBought          = db.prepare("SELECT 1 FROM black_market_listings WHERE buyer_id = ? AND status = 'sold' AND room_id = ? LIMIT 1");
  const bmSold            = db.prepare("SELECT 1 FROM black_market_listings WHERE seller_id = ? AND status = 'sold' AND room_id = ? LIMIT 1");
  const lotWinCnt         = db.prepare(`
    SELECT COUNT(DISTINCT lb.round_id) as cnt FROM lottery_bets lb
    JOIN lottery_rounds lr ON lr.id = lb.round_id
    WHERE lb.user_id = ? AND lb.letter = lr.secret_letter AND lr.status = 'closed' AND lr.room_id = ?
  `);
  const lotPartCnt        = db.prepare(`
    SELECT COUNT(DISTINCT lb.round_id) as cnt FROM lottery_bets lb
    JOIN lottery_rounds lr ON lr.id = lb.round_id
    WHERE lb.user_id = ? AND lr.room_id = ?
  `);
  const lotBetsCnt        = db.prepare(`
    SELECT COUNT(*) as cnt FROM lottery_bets lb
    JOIN lottery_rounds lr ON lr.id = lb.round_id
    WHERE lb.user_id = ? AND lr.room_id = ?
  `);
  const lotMaxBetsInRound = db.prepare(`
    SELECT COALESCE(MAX(cnt), 0) as max FROM (
      SELECT COUNT(*) as cnt FROM lottery_bets lb
      JOIN lottery_rounds lr ON lr.id = lb.round_id
      WHERE lb.user_id = ? AND lr.room_id = ?
      GROUP BY lb.round_id
    )
  `);
  const getRoomMsgCnt     = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE user_id = ? AND room_id = ?');

  const pairs = getUserRooms.all();
  let totalAwarded = 0;

  for (const { user_id: userId, room_id: roomId } of pairs) {
    stmts.upsertUserStats.run(userId, roomId);

    const earnedSet = new Set(stmts.getEarnedAchievements.all(userId, roomId).map((r) => r.achievement_id));
    const rm        = stmts.getRoomMember.get(roomId, userId);
    if (!rm) continue;
    const inv = JSON.parse(rm.inventory_json || '{}');

    const msgCnt     = getRoomMsgCnt.get(userId, roomId).cnt;
    const emojiCount = stmts.getUnlockedEmojis.all(userId, roomId).length;

    const newlyEarned = [];
    const maybe = (id, cond) => {
      if (cond && !earnedSet.has(id)) {
        const ach = ACHIEVEMENTS.find((a) => a.id === id);
        if (ach) newlyEarned.push(ach);
      }
    };

    const boughtCnt    = mktBoughtCnt.get(userId, roomId).cnt;
    const soldCnt      = mktSoldCnt.get(userId, roomId).cnt;
    const lotWins      = lotWinCnt.get(userId, roomId).cnt;
    const lotParts     = lotPartCnt.get(userId, roomId).cnt;
    const lotBets      = lotBetsCnt.get(userId, roomId).cnt;
    const lotMaxPerRnd = lotMaxBetsInRound.get(userId, roomId).max;

    maybe('first_message',          msgCnt >= 1);
    maybe('messages_50',            msgCnt >= 50);
    maybe('messages_200',           msgCnt >= 200);
    maybe('messages_1000',          msgCnt >= 1000);
    maybe('messages_3000',          msgCnt >= 3000);
    maybe('messages_10000',         msgCnt >= 10000);
    maybe('miso',                   !!misoCheck.get(userId));
    maybe('full_keyboard',          ALL_INVENTORY_KEYS.every((k) => (inv[k] || 0) >= 1));
    maybe('double_all',             ALL_INVENTORY_KEYS.every((k) => (inv[k] || 0) >= 2));
    maybe('halfway',                ALL_INVENTORY_KEYS.filter((k) => (inv[k] || 0) >= 1).length >= Math.ceil(ALL_INVENTORY_KEYS.length / 2));
    maybe('max_all',                ALL_INVENTORY_KEYS.every((k) => (inv[k] || 0) >= MAX_LETTER_LEVEL));
    maybe('market_buy',             boughtCnt >= 1);
    maybe('market_buy_10',          boughtCnt >= 10);
    maybe('market_buy_30',          boughtCnt >= 30);
    maybe('market_sell',            soldCnt >= 1);
    maybe('market_sell_10',         soldCnt >= 10);
    maybe('market_sell_30',         soldCnt >= 30);
    maybe('bm_buy',                 !!bmBought.get(userId, roomId));
    maybe('bm_sell',                !!bmSold.get(userId, roomId));
    maybe('lottery_win',            lotWins >= 1);
    maybe('lottery_win_2',          lotWins >= 2);
    maybe('lottery_participate',    lotParts >= 1);
    maybe('lottery_participate_10', lotParts >= 10);
    maybe('lottery_participate_30', lotParts >= 30);
    maybe('lottery_participate_50', lotParts >= 50);
    maybe('lottery_bet_10',         lotBets >= 10);
    maybe('lottery_bet_50',         lotBets >= 50);
    maybe('lottery_bet_100',        lotBets >= 100);
    maybe('lottery_bet_6_rounds',   lotMaxPerRnd >= 6);
    maybe('lottery_bet_7_rounds',   lotMaxPerRnd >= 7);
    maybe('lottery_bet_8_rounds',   lotMaxPerRnd >= 8);
    maybe('lottery_bet_9_rounds',   lotMaxPerRnd >= 9);
    maybe('emoji_first',            emojiCount >= 1);
    maybe('emoji_5',                emojiCount >= 5);
    maybe('emoji_10',               emojiCount >= 10);

    if (newlyEarned.length === 0) continue;

    db.transaction(() => {
      for (const ach of newlyEarned) {
        stmts.insertUserAchievement.run(userId, roomId, ach.id);
        stmts.updateRoomCoins.run(ach.reward, roomId, userId);
      }
    })();

    totalAwarded += newlyEarned.length;
    console.log(`[Achievements] Backfill user ${userId} room ${roomId}: ${newlyEarned.map((a) => a.id).join(', ')}`);
  }

  console.log(
    totalAwarded > 0
      ? `[Achievements] Backfill complete — ${totalAwarded} achievement(s) awarded.`
      : '[Achievements] Backfill: nothing new to award.'
  );
}

module.exports = { ACHIEVEMENTS, checkAchievements, backfillAchievements };
