'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');
const { STARTING_COINS, STARTING_INVENTORY } = require('../config');

// Ensure data directory exists..
// FUTELO_DATA_DIR can be overridden in tests to point at a temp location.
const DATA_DIR = process.env.FUTELO_DATA_DIR || path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'futelo.db');

const db = new Database(DB_PATH);

// ── WAL mode for concurrent reads + writes on a single-GB server ──────────────
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');  // Safe with WAL, faster than FULL
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -16000');   // 16 MB page cache

// ── Schema ────────────────────────────────────────────────────────────────────
// Baseline tables: present since day one. Safe to run on every start.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,          -- Telegram user_id
    username      TEXT    NOT NULL DEFAULT '',
    first_name    TEXT    NOT NULL DEFAULT '',
    photo_url     TEXT    NOT NULL DEFAULT '',
    coins         INTEGER NOT NULL DEFAULT ${STARTING_COINS},
    -- JSON object: { "a": 3, "b": 1, ... }
    -- Value = the maximum # of that letter usable per message (unlock level).
    -- Letters are NEVER consumed; they represent capacity limits.
    inventory_json TEXT   NOT NULL DEFAULT '${STARTING_INVENTORY}',
    streak_count  INTEGER NOT NULL DEFAULT 0,   -- consecutive self-messages
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Global key/value store (last_sender_id, etc.)
  CREATE TABLE IF NOT EXISTS game_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Messages persisted for the read-only feed mirror
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT    NOT NULL,
    coin_delta INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Temporarily locked letters per user (Tier-3 penalty)
  CREATE TABLE IF NOT EXISTS letter_locks (
    user_id      INTEGER NOT NULL REFERENCES users(id),
    letter       TEXT    NOT NULL,
    locked_until INTEGER NOT NULL,    -- Unix timestamp
    PRIMARY KEY (user_id, letter)
  );

  -- Index to speed up feed queries
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_locks_user ON letter_locks(user_id, locked_until);

  -- ── Prompt feature ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS prompts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    closes_at  INTEGER NOT NULL,
    closed     INTEGER NOT NULL DEFAULT 0
  );

  -- One reply per user per prompt
  CREATE TABLE IF NOT EXISTS prompt_replies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id  INTEGER NOT NULL REFERENCES prompts(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(prompt_id, user_id)
  );

  -- One vote per voter per reply
  CREATE TABLE IF NOT EXISTS prompt_votes (
    reply_id  INTEGER NOT NULL REFERENCES prompt_replies(id),
    voter_id  INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (reply_id, voter_id)
  );
`);

// ── Migrations ────────────────────────────────────────────────────────────────
// PRAGMA user_version stores the last applied migration index (0 = none applied).
// To add a new migration: append a function to this array and bump SCHEMA_VERSION.
// Each migration runs inside a transaction; user_version is updated atomically.
// Migrations never need to be run manually — they apply automatically on startup.
//
// IMPORTANT: never edit a past migration. Always append a new one.
const SCHEMA_VERSION = 7;

const migrations = [
  // ── v1: P2P letter market ─────────────────────────────────────────────────
  // Drops any old market_listings table (pre-P2P schema) and recreates it with
  // the correct columns. Open listings are lost, but that is acceptable because
  // this migration only runs once on DBs that predate the P2P rewrite.
  () => {
    db.exec(`
      DROP TABLE IF EXISTS market_listings;
      CREATE TABLE market_listings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id    INTEGER NOT NULL REFERENCES users(id),
        letter       TEXT    NOT NULL,
        price        INTEGER NOT NULL CHECK(price >= 1),
        listed_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        status       TEXT    NOT NULL DEFAULT 'open',
        buyer_id     INTEGER REFERENCES users(id),
        resolved_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ml_open   ON market_listings(status, listed_at);
      CREATE INDEX IF NOT EXISTS idx_ml_seller ON market_listings(seller_id, status);
    `);
  },

  // ── v2: Secret black market ───────────────────────────────────────────────
  // Identical schema to market_listings but on a separate table so the two
  // never share listings.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS black_market_listings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id    INTEGER NOT NULL REFERENCES users(id),
        letter       TEXT    NOT NULL,
        price        INTEGER NOT NULL CHECK(price >= 1),
        listed_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        status       TEXT    NOT NULL DEFAULT 'open',
        buyer_id     INTEGER REFERENCES users(id),
        resolved_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_bml_open   ON black_market_listings(status, listed_at);
      CREATE INDEX IF NOT EXISTS idx_bml_seller ON black_market_listings(seller_id, status);
    `);
  },

  // ── v3: Letter lottery ────────────────────────────────────────────────────
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lottery_rounds (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        secret_letter TEXT    NOT NULL,
        jackpot       INTEGER NOT NULL DEFAULT 0,
        status        TEXT    NOT NULL DEFAULT 'active',
        started_by    INTEGER NOT NULL REFERENCES users(id),
        closes_at     INTEGER NOT NULL,
        created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS lottery_bets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id   INTEGER NOT NULL REFERENCES lottery_rounds(id),
        user_id    INTEGER NOT NULL REFERENCES users(id),
        letter     TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(round_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lr_status ON lottery_rounds(status);
      CREATE INDEX IF NOT EXISTS idx_lb_round  ON lottery_bets(round_id);
    `);
  },

  // ── v4: Allow multiple gambling bets per user per round ──────────────────
  // Removes the UNIQUE(round_id, user_id) constraint so players can throw
  // multiple letters into the pot. Existing rows are preserved.
  () => {
    db.exec(`
      CREATE TABLE lottery_bets_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id   INTEGER NOT NULL REFERENCES lottery_rounds(id),
        user_id    INTEGER NOT NULL REFERENCES users(id),
        letter     TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      INSERT INTO lottery_bets_new SELECT * FROM lottery_bets;
      DROP TABLE lottery_bets;
      ALTER TABLE lottery_bets_new RENAME TO lottery_bets;
      CREATE INDEX IF NOT EXISTS idx_lb_round      ON lottery_bets(round_id);
      CREATE INDEX IF NOT EXISTS idx_lb_user_round ON lottery_bets(round_id, user_id);
    `);
  },

  // ── v5: System user for chat feed system messages ─────────────────────
  // Inserts a virtual user with id=0 used by server-generated messages
  // (lottery results, prompt summaries). Telegram UIDs start at 1 so 0
  // will never clash with a real player.
  () => {
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, first_name, photo_url, coins, inventory_json)
      VALUES (0, 'sistema', 'Sistema', '', 0, '{}');
    `);
  },

  // ── v6: Persistent per-user notification queue ──────────────────────
  // Toast notifications (e.g. "your letter sold") are queued here so
  // offline players see them the next time they connect.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        text       TEXT    NOT NULL,
        type       TEXT    NOT NULL DEFAULT 'info',
        delivered  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, delivered);
    `);
  },
  // ── v7: Letter mines — pickaxe hit counter ────────────────────────────────
  // Adds a persistent swing counter to every user row. Each purchased pickaxe
  // adds PICKAXE_HITS to this value; each mine swing decrements it by 1.
  // Stored on the users table (not in inventory_json) so computeRollCost is
  // not affected by the mining economy.
  () => {
    db.exec('ALTER TABLE users ADD COLUMN pickaxe_hits INTEGER NOT NULL DEFAULT 0');
  },];

// Apply any pending migrations inside a single transaction so a crash mid-way
// leaves the DB at the last successfully completed version.
db.transaction(() => {
  const current = db.pragma('user_version', { simple: true });
  if (current < SCHEMA_VERSION) {
    console.log(`[DB] Applying migrations ${current + 1}..${SCHEMA_VERSION}`);
  }
  for (let i = current; i < SCHEMA_VERSION; i++) {
    migrations[i]();
    db.pragma(`user_version = ${i + 1}`);
    console.log(`[DB] Migration ${i + 1} applied.`);
  }
})();

// ── Prepared statements (reused across requests for performance) ──────────────
const stmts = {
  getUser:        db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser:     db.prepare(`
    INSERT INTO users (id, username, first_name, photo_url)
    VALUES (@id, @username, @first_name, @photo_url)
    ON CONFLICT(id) DO UPDATE SET
      username   = excluded.username,
      first_name = excluded.first_name,
      photo_url  = excluded.photo_url
  `),
  updateCoins:    db.prepare('UPDATE users SET coins = MAX(0, coins + ?) WHERE id = ?'),
  updateStreak:   db.prepare('UPDATE users SET streak_count = ? WHERE id = ?'),
  updateInventory:db.prepare('UPDATE users SET inventory_json = ? WHERE id = ?'),
  updateUser:     db.prepare(`
    UPDATE users
    SET coins = MAX(0, coins + @coinDelta),
        streak_count = @streak,
        inventory_json = @inventory
    WHERE id = @userId
  `),
  getState:       db.prepare('SELECT value FROM game_state WHERE key = ?'),
  setState:       db.prepare('INSERT OR REPLACE INTO game_state (key, value) VALUES (?, ?)'),
  insertMessage:  db.prepare('INSERT INTO messages (user_id, text, coin_delta) VALUES (@userId, @text, @coinDelta)'),
  getRecentMessages: db.prepare(`
    SELECT m.id, m.text, m.coin_delta, m.created_at,
           u.id AS user_id, u.username, u.first_name, u.photo_url
    FROM messages m
    JOIN users u ON u.id = m.user_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `),
  getLocks:       db.prepare('SELECT letter FROM letter_locks WHERE user_id = ? AND locked_until > ?'),
  upsertLock:     db.prepare('INSERT OR REPLACE INTO letter_locks (user_id, letter, locked_until) VALUES (?, ?, ?)'),
  cleanLocks:     db.prepare('DELETE FROM letter_locks WHERE locked_until <= ?'),
  getUserMessageCount: db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE user_id = ?'),

  // ── Prompts ──────────────────────────────────────────────────────────────
  getLastMessageTime: db.prepare('SELECT MAX(created_at) AS ts FROM messages'),
  insertPrompt:      db.prepare('INSERT INTO prompts (text, closes_at) VALUES (?, ?)'),
  getPromptById:     db.prepare('SELECT * FROM prompts WHERE id = ?'),
  getActivePrompt:   db.prepare('SELECT * FROM prompts WHERE closed = 0 ORDER BY id DESC LIMIT 1'),
  getLastPrompt:     db.prepare('SELECT * FROM prompts ORDER BY id DESC LIMIT 1'),
  closePrompt:       db.prepare('UPDATE prompts SET closed = 1 WHERE id = ?'),
  insertPromptReply: db.prepare('INSERT OR IGNORE INTO prompt_replies (prompt_id, user_id, text) VALUES (?, ?, ?)'),
  getPromptReplyById:db.prepare('SELECT * FROM prompt_replies WHERE id = ?'),
  getUserPromptReply:db.prepare('SELECT * FROM prompt_replies WHERE prompt_id = ? AND user_id = ?'),
  getPromptReplies:  db.prepare(`
    SELECT pr.id, pr.prompt_id, pr.user_id, pr.text, pr.created_at,
           COUNT(pv.voter_id) AS votes,
           u.username, u.first_name, u.photo_url
    FROM prompt_replies pr
    LEFT JOIN prompt_votes pv ON pv.reply_id = pr.id
    JOIN users u ON u.id = pr.user_id
    WHERE pr.prompt_id = ?
    GROUP BY pr.id
    ORDER BY votes DESC, pr.created_at ASC
  `),
  insertVote:     db.prepare('INSERT OR IGNORE INTO prompt_votes (reply_id, voter_id) VALUES (?, ?)'),
  getVoteCount:   db.prepare('SELECT COUNT(*) AS votes FROM prompt_votes WHERE reply_id = ?'),
  hasVoted:       db.prepare('SELECT 1 FROM prompt_votes WHERE reply_id = ? AND voter_id = ?'),

  // ── P2P market listings ───────────────────────────────────────────────────
  insertMarketListing:   db.prepare(
    'INSERT INTO market_listings (seller_id, letter, price) VALUES (?, ?, ?)'
  ),
  getMarketListing:      db.prepare('SELECT * FROM market_listings WHERE id = ?'),
  getOpenMarketListings: db.prepare(`
    SELECT ml.id, ml.seller_id, ml.letter, ml.price, ml.listed_at,
           u.username AS seller_username, u.first_name AS seller_first_name
    FROM market_listings ml
    JOIN users u ON u.id = ml.seller_id
    WHERE ml.status = 'open'
    ORDER BY ml.listed_at ASC
  `),
  getActiveSellerListing: db.prepare(
    "SELECT * FROM market_listings WHERE seller_id = ? AND letter = ? AND status = 'open'"
  ),
  resolveMarketListing:  db.prepare(
    'UPDATE market_listings SET status = ?, buyer_id = ?, resolved_at = ? WHERE id = ?'
  ),
  getUserMarketListings: db.prepare(
    "SELECT * FROM market_listings WHERE seller_id = ? ORDER BY listed_at DESC LIMIT 20"
  ),

  // ── Black market listings ──────────────────────────────────────────────────
  insertBmListing:  db.prepare(
    'INSERT INTO black_market_listings (seller_id, letter, price) VALUES (?, ?, ?)'
  ),
  getBmListing:     db.prepare('SELECT * FROM black_market_listings WHERE id = ?'),
  getOpenBmListings: db.prepare(`
    SELECT bml.id, bml.seller_id, bml.letter, bml.price, bml.listed_at,
           u.username AS seller_username, u.first_name AS seller_first_name
    FROM black_market_listings bml
    JOIN users u ON u.id = bml.seller_id
    WHERE bml.status = 'open'
    ORDER BY bml.listed_at ASC
  `),
  resolveBmListing: db.prepare(
    'UPDATE black_market_listings SET status = ?, buyer_id = ?, resolved_at = ? WHERE id = ?'
  ),
  getUserBmListings: db.prepare(
    "SELECT * FROM black_market_listings WHERE seller_id = ? ORDER BY listed_at DESC LIMIT 20"
  ),
  // Full rows (no JOIN) used by the heat engine's catch check loop
  getAllOpenBmListings: db.prepare(
    "SELECT * FROM black_market_listings WHERE status = 'open' ORDER BY listed_at ASC"
  ),

  // ── Lottery ───────────────────────────────────────────────────────────────
  insertLotteryRound:   db.prepare(
    'INSERT INTO lottery_rounds (secret_letter, jackpot, started_by, closes_at) VALUES (?, ?, ?, ?)'
  ),
  getLotteryRoundById:  db.prepare('SELECT * FROM lottery_rounds WHERE id = ?'),
  getActiveLotteryRound: db.prepare(
    "SELECT * FROM lottery_rounds WHERE status = 'active' ORDER BY id DESC LIMIT 1"
  ),
  closeLotteryRound:    db.prepare("UPDATE lottery_rounds SET status = 'closed' WHERE id = ?"),
  addJackpotToRound:    db.prepare('UPDATE lottery_rounds SET jackpot = jackpot + ? WHERE id = ?'),
  insertLotteryBet:     db.prepare(
    'INSERT INTO lottery_bets (round_id, user_id, letter) VALUES (?, ?, ?)'
  ),
  getLotteryBetById:    db.prepare(`
    SELECT lb.*, u.username, u.first_name
    FROM lottery_bets lb JOIN users u ON u.id = lb.user_id
    WHERE lb.id = ?
  `),
  getLotteryBets:       db.prepare(`
    SELECT lb.id, lb.round_id, lb.user_id, lb.letter, lb.created_at,
           u.username, u.first_name
    FROM lottery_bets lb JOIN users u ON u.id = lb.user_id
    WHERE lb.round_id = ?
    ORDER BY lb.created_at ASC
  `),
  getUserBetCountInRound: db.prepare(
    'SELECT COUNT(*) as count FROM lottery_bets WHERE round_id = ? AND user_id = ?'
  ),

  // ── Mining / pickaxe ─────────────────────────────────────────────────────────
  addPickaxeHits: db.prepare(
    'UPDATE users SET pickaxe_hits = MIN(pickaxe_hits + ?, 9999) WHERE id = ?'
  ),
  usePickaxeHit: db.prepare(
    'UPDATE users SET pickaxe_hits = MAX(0, pickaxe_hits - 1) WHERE id = ?'
  ),

  // ── Notifications ─────────────────────────────────────────────────────────────
  insertNotification: db.prepare(
    'INSERT INTO notifications (user_id, text, type) VALUES (@userId, @text, @type)'
  ),
  getPendingNotifications: db.prepare(
    "SELECT id, text, type FROM notifications WHERE user_id = ? AND delivered = 0 ORDER BY created_at ASC"
  ),
  markNotificationDelivered: db.prepare(
    'UPDATE notifications SET delivered = 1 WHERE id = ?'
  ),
  markAllNotificationsDelivered: db.prepare(
    'UPDATE notifications SET delivered = 1 WHERE user_id = ? AND delivered = 0'
  ),
  pruneOldNotifications: db.prepare(
    'DELETE FROM notifications WHERE delivered = 1 AND created_at < ?'
  ),
};

/**
 * Upsert a Telegram user record and return the full row.
 */
function upsertUser({ id, username = '', first_name = '', photo_url = '' }) {
  stmts.insertUser.run({ id, username, first_name, photo_url });
  return stmts.getUser.get(id);
}

/**
 * Return the user or throw if not found.
 */
function requireUser(userId) {
  const user = stmts.getUser.get(userId);
  if (!user) throw new Error(`User ${userId} not found. They must /start the bot first.`);
  return user;
}

module.exports = { db, stmts, upsertUser, requireUser };
