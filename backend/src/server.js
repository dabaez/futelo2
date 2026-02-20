'use strict';

/**
 * Futelo – Express + Socket.io server
 * ────────────────────────────────────
 * HTTP Routes
 *   POST /api/auth          – validate Telegram initData, upsert user, return profile
 *   POST /api/message       – processMessage (guarded by auth middleware)
 *   POST /api/shop/roll     – buy a letter roll
 *   GET  /api/messages      – last N messages for feed hydration
 *   GET  /api/me            – current user profile + inventory + locks
 *   GET  /api/prompt/active – active prompt + all replies with vote counts
 *   POST /api/shop/prompt   – buy and fire a new prompt (costs 200 coins)
 *
 * Socket.io Events (client → server)
 *   send_message          { text }
 *   submit_prompt_reply   { promptId, text }
 *   vote_reply            { replyId }
 *
 * Socket.io Events (server → client)
 *   new_message           { id, userId, username, … }
 *   rejected_message      { reason }
 *   user_update           { newCoins, newInventory, … }
 *   new_prompt            { id, text, closesAt }
 *   new_prompt_reply      { id, promptId, userId, text, votes, … }
 *   vote_update           { replyId, votes }
 *   prompt_closed         { promptId, promptText, winner, runnerUp, replies }
 *   prompt_error          { reason }
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const { upsertUser, requireUser, stmts } = require('./db/database');
const { processMessage, shopRoll, sellLetter } = require('./engine/processMessage');
const {
  listLetter, collectListing, sweepCatchRolls, getUserListings,
  addMentionHeat, getHeat, catchProbForHeat,
}                                            = require('./engine/blackMarket');
const { validateInitData }               = require('./bot/auth');
const {
  startPrompt, getActivePrompt, getPromptWithReplies,
  submitReply, castVote, closePrompt, buyPrompt, PROMPT_BUY_COST,
}                                        = require('./engine/promptEngine');
const config                             = require('./config');

const PORT      = Number(process.env.SERVER_PORT) || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_MODE  = process.env.BOT_MODE || 'polling';
const DEV_MODE  = process.env.DEV_MODE === 'true';

// Lazy-load the bot only when a real token exists (optional in dev mode)
let bot, broadcastToGroup;
if (!DEV_MODE || BOT_TOKEN) {
  ({ bot, broadcastToGroup } = require('./bot/bot'));
} else {
  // Stub – messages are broadcasted nowhere in dev mode
  broadcastToGroup = async () => {};
}

if (!DEV_MODE && !BOT_TOKEN) {
  throw new Error('BOT_TOKEN missing from .env (set DEV_MODE=true to skip in dev)');
}

if (DEV_MODE) {
  console.warn('[Dev Mode] ⚠️  Telegram auth is DISABLED. Do not use in production.');
}

// ── Express ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// ── Socket.io ─────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Keep memory pressure low on 1 GB RAM
  maxHttpBufferSize: 1e5,       // 100 KB max payload
  pingInterval:      25_000,
  pingTimeout:       60_000,
});

// ── Auth middleware ────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  try {
    const initData = req.headers['x-init-data'] || req.body?.initData;
    if (!initData) return res.status(401).json({ error: 'Missing initData' });

    const tgUser = validateInitData(initData, BOT_TOKEN);

    // Auto-upsert so the user always exists in SQLite
    upsertUser({
      id:         tgUser.id,
      username:   tgUser.username   || '',
      first_name: tgUser.first_name || '',
      photo_url:  tgUser.photo_url  || '',
    });

    req.tgUser = tgUser;
    next();
  } catch (err) {
    // In dev mode give a friendlier hint
    const hint = DEV_MODE ? ' (use a dev token like: dev:1001:alice:Alice)' : '';
    res.status(403).json({ error: err.message + hint });
  }
}

// ── Helper: parse & attach user to socket on connect ──────────────────────
function socketAuth(socket, next) {
  try {
    const initData = socket.handshake.auth?.initData;
    if (!initData) return next(new Error('Missing initData'));

    const tgUser = validateInitData(initData, BOT_TOKEN);
    upsertUser({
      id:         tgUser.id,
      username:   tgUser.username   || '',
      first_name: tgUser.first_name || '',
      photo_url:  tgUser.photo_url  || '',
    });

    socket.tgUser = tgUser;
    next();
  } catch (err) {
    const hint = DEV_MODE ? ' Use dev token: dev:USER_ID:username:Name' : '';
    next(new Error('Unauthorized: ' + err.message + hint));
  }
}

// ── REST: /api/config ───────────────────────────────────────────────────
// Exposes public game constants so the frontend never has to duplicate them.
app.get('/api/config', (_req, res) => {
  const heat = getHeat();
  res.json({
    ROLL_COST:                  config.ROLL_COST,
    ROLL_COUNT:                 config.ROLL_COUNT,
    PROMPT_BUY_COST:            config.PROMPT_BUY_COST,
    PROMPT_WINNER_BONUS:        config.PROMPT_WINNER_BONUS,
    PROMPT_RUNNER_UP_BONUS:     config.PROMPT_RUNNER_UP_BONUS,
    PROMPT_DURATION_SEC:        config.PROMPT_DURATION_SEC,
    TIER1_COINS:                config.TIER1_COINS,
    TIER3_PENALTY:              config.TIER3_PENALTY,
    SELL_BASE_PRICE:            config.SELL_BASE_PRICE,
    SELL_COMMISSION_RATE:       config.SELL_COMMISSION_RATE,
    BLACK_MARKET_FINE:          config.BLACK_MARKET_FINE,
    BLACK_MARKET_BASE_PROB:     config.BLACK_MARKET_BASE_PROB,
    BLACK_MARKET_MAX_PROB:      config.BLACK_MARKET_MAX_PROB,
    BLACK_MARKET_LISTING_SEC:   config.BLACK_MARKET_LISTING_SEC,
    HEAT_CATCH_INCREMENT:       config.HEAT_CATCH_INCREMENT,
    HEAT_MENTION_INCREMENT:     config.HEAT_MENTION_INCREMENT,
    // Live values
    heat,
    catchProbPerMin: catchProbForHeat(heat),
  });
});

// ── REST: /api/auth ────────────────────────────────────────────────────────
app.post('/api/auth', authMiddleware, (req, res) => {
  const user = requireUser(req.tgUser.id);
  const nowSec = Math.floor(Date.now() / 1000);
  const locks  = stmts.getLocks.all(user.id, nowSec);

  res.json({
    user: {
      id:          user.id,
      username:    user.username,
      first_name:  user.first_name,
      photo_url:   user.photo_url,
      coins:       user.coins,
      inventory:   JSON.parse(user.inventory_json || '{}'),
      streak:      user.streak_count,
      lockedLetters: locks.map((l) => l.letter),
    },
  });
});

// ── REST: /api/me ──────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
  const user   = requireUser(req.tgUser.id);
  const nowSec = Math.floor(Date.now() / 1000);
  const locks  = stmts.getLocks.all(user.id, nowSec);

  res.json({
    id:           user.id,
    username:     user.username,
    first_name:   user.first_name,
    photo_url:    user.photo_url,
    coins:        user.coins,
    inventory:    JSON.parse(user.inventory_json || '{}'),
    streak:       user.streak_count,
    lockedLetters: locks.map((l) => l.letter),
  });
});

// ── REST: /api/messages ────────────────────────────────────────────────────
app.get('/api/messages', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows  = stmts.getRecentMessages.all(limit).reverse();  // oldest first

  res.json(
    rows.map((r) => ({
      id:         r.id,
      text:       r.text,
      coinDelta:  r.coin_delta,
      createdAt:  r.created_at,
      userId:     r.user_id,
      username:   r.username,
      firstName:  r.first_name,
      photoUrl:   r.photo_url,
    }))
  );
});

// ── REST: /api/message ─────────────────────────────────────────────────────
app.post('/api/message', authMiddleware, (req, res) => {
  const { text } = req.body;

  try {
    const result = processMessage(req.tgUser.id, text);

    // Broadcast via Socket.io
    const user = requireUser(req.tgUser.id);
    const payload = buildMessagePayload(user, text, result);
    io.emit('new_message', payload);

    // Mirror to Telegram group (fire-and-forget)
    broadcastToGroup({
      username:   user.username,
      first_name: user.first_name,
      text,
      coinDelta:  result.coinDelta,
      tier:       result.tier,
    }).catch(() => {});

    // Black market heat: bump if the message mentions it
    if (/mercado\s+negro/i.test(text)) {
      const newHeat = addMentionHeat();
      io.emit('bm_heat_update', { heat: newHeat, catchProbPerMin: catchProbForHeat(newHeat) });
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── REST: /api/shop/roll ───────────────────────────────────────────────────
app.post('/api/shop/roll', authMiddleware, (req, res) => {
  try {
    const result = shopRoll(req.tgUser.id);
    // Notify the specific user's sockets of their updated state
    io.to(`user:${req.tgUser.id}`).emit('user_update', {
      newCoins:     result.newCoins,
      newInventory: result.newInventory,
      newLetters:   result.newLetters,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// ── REST: /api/shop/sell  (normal market, instant) ───────────────────────
app.post('/api/shop/sell', authMiddleware, (req, res) => {
  const { letter } = req.body;
  try {
    const result = sellLetter(req.tgUser.id, letter);
    io.to(`user:${req.tgUser.id}`).emit('user_update', {
      newCoins:     result.newCoins,
      newInventory: result.newInventory,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── REST: Black market (listing system) ─────────────────────────────────

// GET /api/blackmarket/heat – current heat + catch probability
app.get('/api/blackmarket/heat', (_req, res) => {
  const heat = getHeat();
  res.json({ heat, catchProbPerMin: catchProbForHeat(heat) });
});

// GET /api/blackmarket/listings – caller's recent listings
app.get('/api/blackmarket/listings', authMiddleware, (req, res) => {
  res.json(getUserListings(req.tgUser.id));
});

// POST /api/blackmarket/list – escrow a letter level on the black market
app.post('/api/blackmarket/list', authMiddleware, (req, res) => {
  const { letter } = req.body;
  try {
    const result = listLetter(req.tgUser.id, letter);
    // Inventory changed immediately (escrow) – push to user's sockets
    io.to(`user:${req.tgUser.id}`).emit('user_update', {
      newInventory: result.newInventory,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/blackmarket/collect/:id – claim coins from a safe listing
app.post('/api/blackmarket/collect/:id', authMiddleware, (req, res) => {
  try {
    const result = collectListing(req.tgUser.id, Number(req.params.id));
    io.to(`user:${req.tgUser.id}`).emit('user_update', { newCoins: result.newCoins });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── REST: /api/prompt/active ───────────────────────────────────────────────
app.get('/api/prompt/active', (req, res) => {
  const prompt = getActivePrompt();
  if (!prompt) return res.json({ prompt: null, replies: [] });
  res.json(getPromptWithReplies(prompt.id));
});
// ── REST: /api/shop/prompt ───────────────────────────────────────────
app.post('/api/shop/prompt', authMiddleware, (req, res) => {
  try {
    const result = buyPrompt(req.tgUser.id);
    // Tell everyone about the new prompt
    io.emit('new_prompt', {
      id:       result.prompt.id,
      text:     result.prompt.text,
      closesAt: result.prompt.closesAt,
    });
    // Tell the buyer their new coin balance
    io.to(`user:${req.tgUser.id}`).emit('user_update', {
      newCoins: result.newCoins,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// ── Socket.io ─────────────────────────────────────────────────────────────
io.use(socketAuth);

io.on('connection', (socket) => {
  const userId = socket.tgUser.id;
  console.log(`[Socket] Connected: user ${userId}`);

  // Join a personal room so per-user notifications work
  socket.join(`user:${userId}`);

  // ── Event: send_message ──────────────────────────────────────────────────
  socket.on('send_message', ({ text }) => {
    try {
      const result  = processMessage(userId, text);
      const user    = requireUser(userId);
      const payload = buildMessagePayload(user, text, result);

      // Broadcast to ALL connected clients
      io.emit('new_message', payload);

      // Notify only the sender of their economy update
      socket.emit('user_update', {
        newCoins:     result.newCoins,
        newInventory: result.newInventory,
        newLetters:   result.newLetters,
        lockedLetter: result.lockedLetter,
        tier:         result.tier,
        coinDelta:    result.coinDelta,
      });

      // Mirror to Telegram group
      broadcastToGroup({
        username:   user.username,
        first_name: user.first_name,
        text,
        coinDelta:  result.coinDelta,
        tier:       result.tier,
      }).catch(() => {});
    } catch (err) {
      socket.emit('rejected_message', { reason: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: user ${userId}`);
  });

  // ── Event: submit_prompt_reply ───────────────────────────────────────
  socket.on('submit_prompt_reply', ({ promptId, text }) => {
    try {
      const reply = submitReply(userId, promptId, text);
      io.emit('new_prompt_reply', reply);
    } catch (err) {
      socket.emit('prompt_error', { reason: err.message });
    }
  });

  // ── Event: vote_reply ──────────────────────────────────────────────
  socket.on('vote_reply', ({ replyId }) => {
    try {
      const result = castVote(userId, replyId);
      io.emit('vote_update', result);
    } catch (err) {
      socket.emit('prompt_error', { reason: err.message });
    }
  });
});

// ── Build message payload ──────────────────────────────────────────────────
function buildMessagePayload(user, text, result) {
  return {
    id:          result.messageId,
    userId:      user.id,
    username:    user.username,
    firstName:   user.first_name,
    photoUrl:    user.photo_url,
    text,
    coinDelta:   result.coinDelta,
    tier:        result.tier,
    newLetters:  result.newLetters,
    lockedLetter:result.lockedLetter,
    createdAt:   Math.floor(Date.now() / 1000),
  };
}

// ── Start bot (skipped in dev mode without a real token) ──────────────────
if (bot) {
  if (BOT_MODE === 'webhook') {
    const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
    const WEBHOOK_PATH   = `/bot${BOT_TOKEN}`;
    bot.api.setWebhook(`${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
    app.post(WEBHOOK_PATH, (req, res) => {
      bot.handleUpdate(req.body).then(() => res.sendStatus(200));
    });
    console.log('[Bot] Webhook mode active');
  } else {
    bot.start().catch(console.error);
    console.log('[Bot] Long-polling mode active');
  }
} else {
  console.log('[Bot] Skipped (DEV_MODE=true, no BOT_TOKEN)');
}

// ── Prompt scheduler ─────────────────────────────────────────────────────
// Checks every 15 s:
//  1. Close any expired prompt and broadcast results.
//  2. Auto-fire a new prompt only when the chat has been silent for 24 h.
//  Manual firing is available via POST /api/shop/prompt (costs 200 coins).
const INACTIVITY_SEC = config.INACTIVITY_SEC;

if (require.main === module) {
  // ── Black market sweep (every 60 s) ────────────────────────────────────
  // Expires stale listings, decays heat, rolls catch probability.
  setInterval(() => {
    const { caught, expired } = sweepCatchRolls();

    for (const c of caught) {
      io.to(`user:${c.userId}`).emit('bm_caught', {
        listingId:    c.listingId,
        letter:       c.letter,
        fine:         c.fine,
        newCoins:     c.newCoins,
        newInventory: c.newInventory,
      });
    }

    for (const e of expired) {
      io.to(`user:${e.userId}`).emit('bm_expired', {
        listingId:    e.listingId,
        letter:       e.letter,
        newInventory: e.newInventory,
      });
    }

    if (caught.length > 0 || expired.length > 0) {
      const heat = getHeat();
      io.emit('bm_heat_update', { heat, catchProbPerMin: catchProbForHeat(heat) });
      if (caught.length > 0) {
        console.log(`[BM] ${caught.length} caught, ${expired.length} expired. heat=${heat.toFixed(3)}`);
      }
    }
  }, 60_000);
}

if (require.main === module) {
  setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const active = getActivePrompt();

    // Close expired prompt
    if (active && nowSec >= active.closes_at) {
      const result = closePrompt(active.id);
      if (result) {
        io.emit('prompt_closed', result);
        console.log(`[Prompt] Closed "${active.text}". Winner: ${result.winner?.userId || 'none'}`);
      }
    }

    // Inactivity trigger: no active prompt + chat silent ≥ 24 h
    if (!active) {
      const lastMsg   = stmts.getLastMessageTime.get();
      const silentSec = lastMsg?.ts ? nowSec - lastMsg.ts : Infinity;
      if (silentSec >= INACTIVITY_SEC) {
        const np = startPrompt();
        io.emit('new_prompt', { id: np.id, text: np.text, closesAt: np.closesAt });
        console.log('[Prompt] Inactivity trigger (24 h silence).');
      }
    }
  }, 15_000);
}

// ── Start HTTP server ─────────────────────────────────────────────────────
// Guard lets tests import this module without binding a real port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Server] Futelo backend listening on port ${PORT}`);
  });
}

module.exports = { app, server, io };
