'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');
const { STARTING_COINS } = require('../config');

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
    inventory_json TEXT   NOT NULL DEFAULT '{}',
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

  -- ── Black market listings ───────────────────────────────────────────────────
  -- A listing is created when a user puts a letter on the black market.
  -- The letter level is escrowed immediately; the scheduler rolls for a
  -- catch once per minute.  The user collects coins if not caught.
  CREATE TABLE IF NOT EXISTS black_market_listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    letter       TEXT    NOT NULL,
    listed_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    status       TEXT    NOT NULL DEFAULT 'pending',
    -- status values: 'pending' | 'collected' | 'caught' | 'expired'
    resolved_at  INTEGER,
    coins_delta  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_bml_pending ON black_market_listings(status, listed_at);
  CREATE INDEX IF NOT EXISTS idx_bml_user    ON black_market_listings(user_id, status);
`);

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
  updateCoins:    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?'),
  updateStreak:   db.prepare('UPDATE users SET streak_count = ? WHERE id = ?'),
  updateInventory:db.prepare('UPDATE users SET inventory_json = ? WHERE id = ?'),
  updateUser:     db.prepare(`
    UPDATE users
    SET coins = coins + @coinDelta,
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

  // ── Black market listings ─────────────────────────────────────────────────
  insertBmListing:      db.prepare('INSERT INTO black_market_listings (user_id, letter) VALUES (?, ?)'),
  getBmListing:         db.prepare('SELECT * FROM black_market_listings WHERE id = ?'),
  getActiveBmListing:   db.prepare(
    "SELECT * FROM black_market_listings WHERE user_id = ? AND letter = ? AND status = 'pending'"
  ),
  getPendingBmListings: db.prepare(
    "SELECT * FROM black_market_listings WHERE status = 'pending' ORDER BY listed_at ASC"
  ),
  getExpiredBmListings: db.prepare(
    "SELECT * FROM black_market_listings WHERE status = 'pending' AND listed_at < ?"
  ),
  resolveBmListing:     db.prepare(
    'UPDATE black_market_listings SET status = ?, coins_delta = ?, resolved_at = ? WHERE id = ?'
  ),
  getUserBmListings:    db.prepare(
    "SELECT * FROM black_market_listings WHERE user_id = ? ORDER BY listed_at DESC LIMIT 20"
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
