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
const SCHEMA_VERSION = 22;

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
  },

  // ── v8: Multi-room support — one room per Telegram group ──────────────────
  // Each Telegram group that adds the bot gets a separate room. All content
  // (messages, prompts, lottery, market listings) is scoped to a room_id.
  // Existing rows are assigned to room 0 ("Global") for backward compat.
  // Per-room streak state moves from users.streak_count to room_member_streaks
  // (users.streak_count stays but is no longer written after this migration).
  () => {
    db.exec(`
      -- Room registry: one row per Telegram group
      CREATE TABLE IF NOT EXISTS rooms (
        id         INTEGER PRIMARY KEY,   -- Telegram chat_id (negative for groups)
        title      TEXT    NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      -- Backward-compat placeholder: all pre-migration content belongs here
      INSERT OR IGNORE INTO rooms (id, title) VALUES (0, 'Global');

      -- Per-room streak counter (replaces users.streak_count for new messages)
      CREATE TABLE IF NOT EXISTS room_member_streaks (
        room_id  INTEGER NOT NULL REFERENCES rooms(id),
        user_id  INTEGER NOT NULL REFERENCES users(id),
        streak   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, user_id)
      );

      -- Scope messages to a room
      ALTER TABLE messages              ADD COLUMN room_id INTEGER NOT NULL DEFAULT 0;
      -- Scope prompts to a room
      ALTER TABLE prompts               ADD COLUMN room_id INTEGER NOT NULL DEFAULT 0;
      -- Scope lottery rounds to a room
      ALTER TABLE lottery_rounds        ADD COLUMN room_id INTEGER NOT NULL DEFAULT 0;
      -- Scope P2P market listings to a room
      ALTER TABLE market_listings       ADD COLUMN room_id INTEGER NOT NULL DEFAULT 0;
      -- Scope black market listings to a room
      ALTER TABLE black_market_listings ADD COLUMN room_id INTEGER NOT NULL DEFAULT 0;

      -- Indexes for room-based queries
      CREATE INDEX IF NOT EXISTS idx_messages_room   ON messages(room_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompts_room    ON prompts(room_id, closed);
      CREATE INDEX IF NOT EXISTS idx_lr_room_status  ON lottery_rounds(room_id, status);
      CREATE INDEX IF NOT EXISTS idx_ml_room         ON market_listings(room_id, status);
      CREATE INDEX IF NOT EXISTS idx_bml_room        ON black_market_listings(room_id, status);
    `);
  },

  // v9 – per-room gatekeeper flag
  () => {
    db.exec(`ALTER TABLE rooms ADD COLUMN gatekeeper INTEGER NOT NULL DEFAULT 0`);
  },

  // v10 – opt-in Telegram push notifications
  () => {
    db.exec('ALTER TABLE users ADD COLUMN allows_write_to_pm INTEGER NOT NULL DEFAULT 0');
  },

  // v11 – Telegram thread mirroring config per room
  // notify_thread_id: NULL=not configured, 0=main chat, N=specific topic ID
  // notify_thread_delete: 1=auto-delete user messages posted to that thread
  () => {
    db.exec('ALTER TABLE rooms ADD COLUMN notify_thread_id INTEGER');
    db.exec('ALTER TABLE rooms ADD COLUMN notify_thread_delete INTEGER NOT NULL DEFAULT 0');
  },

  // v12 – per-room game state (coins, inventory, pickaxe_hits) + per-room letter locks
  // room_members is the new source of truth for all per-player economy data.
  // letter_locks gains room_id so Tier-3 penalties are scoped to a room.
  () => {
    db.exec(`
      CREATE TABLE room_members (
        room_id        INTEGER NOT NULL REFERENCES rooms(id),
        user_id        INTEGER NOT NULL REFERENCES users(id),
        coins          INTEGER NOT NULL DEFAULT 0,
        inventory_json TEXT    NOT NULL DEFAULT '${STARTING_INVENTORY}',
        pickaxe_hits   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rm_user ON room_members(user_id);
    `);
    // Seed room 0 from existing global user stats for backward compat
    db.exec(`
      INSERT OR IGNORE INTO room_members (room_id, user_id, coins, inventory_json, pickaxe_hits)
      SELECT 0, id, coins, inventory_json, pickaxe_hits FROM users WHERE id != 0;
    `);
    // Recreate letter_locks with room_id in the PK (per-room penalties)
    db.exec(`
      CREATE TABLE letter_locks_new (
        room_id      INTEGER NOT NULL DEFAULT 0,
        user_id      INTEGER NOT NULL REFERENCES users(id),
        letter       TEXT    NOT NULL,
        locked_until INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id, letter)
      );
      INSERT INTO letter_locks_new (room_id, user_id, letter, locked_until)
        SELECT 0, user_id, letter, locked_until FROM letter_locks;
      DROP TABLE letter_locks;
      ALTER TABLE letter_locks_new RENAME TO letter_locks;
      CREATE INDEX IF NOT EXISTS idx_locks_user ON letter_locks(room_id, user_id, locked_until);
    `);
  },

  // v13 – reset notify_thread_delete that was accidentally set by gatekeeper coupling
  // /gatekeeper briefly synced notify_thread_delete; this undoes that side-effect
  // so thread-delete is only active when explicitly set via /setthreaddelete.
  () => {
    db.exec('UPDATE rooms SET notify_thread_delete = 0');
  },

  // v14 – migrate gatekeeper rooms to setthreaddelete
  // /gatekeeper has been removed; rooms that had it enabled were opting into
  // message deletion, so enable notify_thread_delete for them instead.
  () => {
    db.exec('UPDATE rooms SET notify_thread_delete = 1 WHERE gatekeeper = 1');
  },

  // v15 – emoji forge
  // emoji_merges  – one active merge per user (user_id + status='pending' unique via query)
  // unlocked_emojis – permanent per-user emoji unlocks (global, not per-room)
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS emoji_merges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        room_id     INTEGER NOT NULL DEFAULT 0,
        ingredients TEXT    NOT NULL,  -- JSON array of chars
        finishes_at INTEGER NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'pending', -- pending | success | failed
        emoji_key   TEXT                                -- set on success
      );
      CREATE INDEX IF NOT EXISTS idx_em_user_status ON emoji_merges(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_em_pending     ON emoji_merges(status, finishes_at);

      CREATE TABLE IF NOT EXISTS unlocked_emojis (
        user_id   INTEGER NOT NULL REFERENCES users(id),
        emoji_key TEXT    NOT NULL,
        PRIMARY KEY (user_id, emoji_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ue_user ON unlocked_emojis(user_id);
    `);
  },

  // v16 – achievements system
  // user_achievements – one row per earned achievement (global per-user, not per-room)
  // user_stats        – running counters used by achievement conditions
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        user_id        INTEGER NOT NULL REFERENCES users(id),
        achievement_id TEXT    NOT NULL,
        earned_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, achievement_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ua_user ON user_achievements(user_id);

      CREATE TABLE IF NOT EXISTS user_stats (
        user_id                  INTEGER PRIMARY KEY REFERENCES users(id),
        mine_finds               INTEGER NOT NULL DEFAULT 0,
        consecutive_mine_fails   INTEGER NOT NULL DEFAULT 0,
        lootboxes_total          INTEGER NOT NULL DEFAULT 0,
        consecutive_common_boxes INTEGER NOT NULL DEFAULT 0,
        prompt_losses            INTEGER NOT NULL DEFAULT 0
      );
    `);
  },

  // v17 – extend user_stats with market/lottery/prompt counters;
  //        remove UNIQUE(round_id, user_id) from lottery_bets to allow multi-letter betting
  () => {
    db.exec(`
      ALTER TABLE user_stats ADD COLUMN market_buys         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN market_sells        INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN lottery_wins        INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN lottery_participations INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN lottery_bets_total  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN lottery_bets_in_round INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN prompt_wins         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_stats ADD COLUMN prompt_correct_votes INTEGER NOT NULL DEFAULT 0;
    `);
    db.exec(`
      ALTER TABLE lottery_bets RENAME TO lottery_bets_old;
      CREATE TABLE lottery_bets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id   INTEGER NOT NULL REFERENCES lottery_rounds(id),
        user_id    INTEGER NOT NULL REFERENCES users(id),
        letter     TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      INSERT INTO lottery_bets SELECT id, round_id, user_id, letter, created_at FROM lottery_bets_old;
      DROP TABLE lottery_bets_old;
      CREATE INDEX IF NOT EXISTS idx_lb_round      ON lottery_bets(round_id);
      CREATE INDEX IF NOT EXISTS idx_lb_user_round ON lottery_bets(round_id, user_id);
    `);
  },

  // v18 – message reactions (likes / dislikes)
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        user_id    INTEGER NOT NULL,
        reaction   TEXT    NOT NULL CHECK(reaction IN ('like','dislike')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(message_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mr_message ON message_reactions(message_id);
    `);
  },

  // v19 – make achievements, unlocked_emojis, and user_stats per-room
  // Each existing global row is expanded into one row per room the user belongs to.
  // If a user has no room_members rows, their data is preserved under room_id = 0.
  () => {
    // ── user_achievements → per-room ─────────────────────────────────────────
    db.exec(`
      ALTER TABLE user_achievements RENAME TO user_achievements_old;

      CREATE TABLE user_achievements (
        user_id        INTEGER NOT NULL REFERENCES users(id),
        room_id        INTEGER NOT NULL DEFAULT 0,
        achievement_id TEXT    NOT NULL,
        earned_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, room_id, achievement_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ua_user_room ON user_achievements(user_id, room_id);

      -- Expand each global record to every room the user is a member of
      INSERT OR IGNORE INTO user_achievements (user_id, room_id, achievement_id, earned_at)
        SELECT ua.user_id, rm.room_id, ua.achievement_id, ua.earned_at
        FROM user_achievements_old ua
        JOIN room_members rm ON rm.user_id = ua.user_id;

      -- Preserve records for users with no room memberships
      INSERT OR IGNORE INTO user_achievements (user_id, room_id, achievement_id, earned_at)
        SELECT ua.user_id, 0, ua.achievement_id, ua.earned_at
        FROM user_achievements_old ua
        WHERE NOT EXISTS (
          SELECT 1 FROM room_members WHERE user_id = ua.user_id
        );

      DROP TABLE user_achievements_old;
    `);

    // ── unlocked_emojis → per-room ────────────────────────────────────────────
    db.exec(`
      ALTER TABLE unlocked_emojis RENAME TO unlocked_emojis_old;

      CREATE TABLE unlocked_emojis (
        user_id   INTEGER NOT NULL REFERENCES users(id),
        room_id   INTEGER NOT NULL DEFAULT 0,
        emoji_key TEXT    NOT NULL,
        PRIMARY KEY (user_id, room_id, emoji_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ue_user_room ON unlocked_emojis(user_id, room_id);

      INSERT OR IGNORE INTO unlocked_emojis (user_id, room_id, emoji_key)
        SELECT ue.user_id, rm.room_id, ue.emoji_key
        FROM unlocked_emojis_old ue
        JOIN room_members rm ON rm.user_id = ue.user_id;

      INSERT OR IGNORE INTO unlocked_emojis (user_id, room_id, emoji_key)
        SELECT ue.user_id, 0, ue.emoji_key
        FROM unlocked_emojis_old ue
        WHERE NOT EXISTS (
          SELECT 1 FROM room_members WHERE user_id = ue.user_id
        );

      DROP TABLE unlocked_emojis_old;
    `);

    // ── user_stats → per-room ─────────────────────────────────────────────────
    // user_id was the PK; recreate with composite (user_id, room_id)
    db.exec(`
      ALTER TABLE user_stats RENAME TO user_stats_old;

      CREATE TABLE user_stats (
        user_id                  INTEGER NOT NULL REFERENCES users(id),
        room_id                  INTEGER NOT NULL DEFAULT 0,
        mine_finds               INTEGER NOT NULL DEFAULT 0,
        consecutive_mine_fails   INTEGER NOT NULL DEFAULT 0,
        lootboxes_total          INTEGER NOT NULL DEFAULT 0,
        consecutive_common_boxes INTEGER NOT NULL DEFAULT 0,
        prompt_losses            INTEGER NOT NULL DEFAULT 0,
        market_buys              INTEGER NOT NULL DEFAULT 0,
        market_sells             INTEGER NOT NULL DEFAULT 0,
        lottery_wins             INTEGER NOT NULL DEFAULT 0,
        lottery_participations   INTEGER NOT NULL DEFAULT 0,
        lottery_bets_total       INTEGER NOT NULL DEFAULT 0,
        lottery_bets_in_round    INTEGER NOT NULL DEFAULT 0,
        prompt_wins              INTEGER NOT NULL DEFAULT 0,
        prompt_correct_votes     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, room_id)
      );

      INSERT OR IGNORE INTO user_stats
        (user_id, room_id, mine_finds, consecutive_mine_fails, lootboxes_total,
         consecutive_common_boxes, prompt_losses, market_buys, market_sells,
         lottery_wins, lottery_participations, lottery_bets_total,
         lottery_bets_in_round, prompt_wins, prompt_correct_votes)
        SELECT s.user_id, rm.room_id,
               s.mine_finds, s.consecutive_mine_fails, s.lootboxes_total,
               s.consecutive_common_boxes, s.prompt_losses, s.market_buys, s.market_sells,
               s.lottery_wins, s.lottery_participations, s.lottery_bets_total,
               s.lottery_bets_in_round, s.prompt_wins, s.prompt_correct_votes
        FROM user_stats_old s
        JOIN room_members rm ON rm.user_id = s.user_id;

      INSERT OR IGNORE INTO user_stats
        (user_id, room_id, mine_finds, consecutive_mine_fails, lootboxes_total,
         consecutive_common_boxes, prompt_losses, market_buys, market_sells,
         lottery_wins, lottery_participations, lottery_bets_total,
         lottery_bets_in_round, prompt_wins, prompt_correct_votes)
        SELECT s.user_id, 0,
               s.mine_finds, s.consecutive_mine_fails, s.lootboxes_total,
               s.consecutive_common_boxes, s.prompt_losses, s.market_buys, s.market_sells,
               s.lottery_wins, s.lottery_participations, s.lottery_bets_total,
               s.lottery_bets_in_round, s.prompt_wins, s.prompt_correct_votes
        FROM user_stats_old s
        WHERE NOT EXISTS (
          SELECT 1 FROM room_members WHERE user_id = s.user_id
        );

      DROP TABLE user_stats_old;
    `);
  },

  // v20 – persist purchased emoji hints per user
  // Hints are global per-user (not per-room) because emojis are global.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS emoji_hints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        hint_text  TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_eh_user ON emoji_hints(user_id);
    `);
  },

  // v21 – Futelo GOLD (April Fools feature, April 1 2026)
  // futelo_gold_level on room_members: 0 = not purchased, N = number of upgrades.
  // gold_upgrades on user_stats: running counter for the centurion achievement.
  // Both columns persist permanently so achievements survive after the feature ends.
  () => {
    db.exec(`ALTER TABLE room_members ADD COLUMN futelo_gold_level INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE user_stats ADD COLUMN gold_upgrades INTEGER NOT NULL DEFAULT 0`);
  },

  // v22 – Futelo GOLD active toggle
  // futelo_gold_active: 1 = show gold styling to others (default), 0 = hidden.
  () => {
    db.exec(`ALTER TABLE room_members ADD COLUMN futelo_gold_active INTEGER NOT NULL DEFAULT 1`);
  },
];

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
  insertMessage:  db.prepare('INSERT INTO messages (user_id, text, coin_delta, room_id) VALUES (@userId, @text, @coinDelta, @roomId)'),
  getRecentMessages: db.prepare(`
    SELECT m.id, m.text, m.coin_delta, m.created_at,
           u.id AS user_id, u.username, u.first_name, u.photo_url,
           COALESCE((SELECT COUNT(*) FROM message_reactions WHERE message_id = m.id AND reaction = 'like'), 0)    AS likes,
           COALESCE((SELECT COUNT(*) FROM message_reactions WHERE message_id = m.id AND reaction = 'dislike'), 0) AS dislikes,
           CASE WHEN COALESCE(rm.futelo_gold_active, 1) = 1 THEN COALESCE(rm.futelo_gold_level, 0) ELSE 0 END AS gold_level
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN room_members rm ON rm.user_id = m.user_id AND rm.room_id = m.room_id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `),
  getLocks:       db.prepare('SELECT letter FROM letter_locks WHERE room_id = ? AND user_id = ? AND locked_until > ?'),
  upsertLock:     db.prepare('INSERT OR REPLACE INTO letter_locks (room_id, user_id, letter, locked_until) VALUES (?, ?, ?, ?)'),
  getRoomMemberMessageCount: db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE user_id = ? AND room_id = ?'),
  cleanLocks:     db.prepare('DELETE FROM letter_locks WHERE locked_until <= ?'),
  getUserMessageCount: db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE user_id = ?'),

  // ── Prompts ──────────────────────────────────────────────────────────────
  getLastMessageTime: db.prepare('SELECT MAX(created_at) AS ts FROM messages WHERE room_id = ?'),
  insertPrompt:      db.prepare('INSERT INTO prompts (text, closes_at, room_id) VALUES (?, ?, ?)'),
  getPromptById:     db.prepare('SELECT * FROM prompts WHERE id = ?'),
  getActivePrompt:   db.prepare('SELECT * FROM prompts WHERE closed = 0 AND room_id = ? ORDER BY id DESC LIMIT 1'),
  getLastPrompt:     db.prepare('SELECT * FROM prompts WHERE room_id = ? ORDER BY id DESC LIMIT 1'),
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
    'INSERT INTO market_listings (seller_id, letter, price, room_id) VALUES (?, ?, ?, ?)'
  ),
  getMarketListing:      db.prepare('SELECT * FROM market_listings WHERE id = ?'),
  getOpenMarketListings: db.prepare(`
    SELECT ml.id, ml.seller_id, ml.letter, ml.price, ml.listed_at,
           u.username AS seller_username, u.first_name AS seller_first_name
    FROM market_listings ml
    JOIN users u ON u.id = ml.seller_id
    WHERE ml.status = 'open' AND ml.room_id = ?
    ORDER BY ml.listed_at ASC
  `),
  getActiveSellerListing: db.prepare(
    "SELECT * FROM market_listings WHERE seller_id = ? AND letter = ? AND status = 'open' AND room_id = ?"
  ),
  resolveMarketListing:  db.prepare(
    'UPDATE market_listings SET status = ?, buyer_id = ?, resolved_at = ? WHERE id = ?'
  ),
  getUserMarketListings: db.prepare(
    "SELECT * FROM market_listings WHERE seller_id = ? AND room_id = ? AND status = 'open' ORDER BY listed_at DESC"
  ),

  // ── Black market listings ──────────────────────────────────────────────────
  insertBmListing:  db.prepare(
    'INSERT INTO black_market_listings (seller_id, letter, price, room_id) VALUES (?, ?, ?, ?)'
  ),
  getBmListing:     db.prepare('SELECT * FROM black_market_listings WHERE id = ?'),
  getOpenBmListings: db.prepare(`
    SELECT bml.id, bml.seller_id, bml.letter, bml.price, bml.listed_at,
           u.username AS seller_username, u.first_name AS seller_first_name
    FROM black_market_listings bml
    JOIN users u ON u.id = bml.seller_id
    WHERE bml.status = 'open' AND bml.room_id = ?
    ORDER BY bml.listed_at ASC
  `),
  resolveBmListing: db.prepare(
    'UPDATE black_market_listings SET status = ?, buyer_id = ?, resolved_at = ? WHERE id = ?'
  ),
  getUserBmListings: db.prepare(
    "SELECT * FROM black_market_listings WHERE seller_id = ? AND room_id = ? AND status = 'open' ORDER BY listed_at DESC"
  ),
  // Full rows (no JOIN) used by the heat engine's catch check loop — scoped to room
  getAllOpenBmListings: db.prepare(
    "SELECT * FROM black_market_listings WHERE status = 'open' AND room_id = ? ORDER BY listed_at ASC"
  ),
  // Used by the scheduler catch-check which processes ALL rooms in one pass
  getAllOpenBmListingsGlobal: db.prepare(
    "SELECT * FROM black_market_listings WHERE status = 'open' ORDER BY listed_at ASC"
  ),

  // ── Lottery ───────────────────────────────────────────────────────────────
  insertLotteryRound:   db.prepare(
    'INSERT INTO lottery_rounds (secret_letter, jackpot, started_by, closes_at, room_id) VALUES (?, ?, ?, ?, ?)'
  ),
  getLotteryRoundById:  db.prepare('SELECT * FROM lottery_rounds WHERE id = ?'),
  getActiveLotteryRound: db.prepare(
    "SELECT * FROM lottery_rounds WHERE status = 'active' AND room_id = ? ORDER BY id DESC LIMIT 1"
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

  // ── Room members (per-room game state) ────────────────────────────────────
  upsertRoomMember: db.prepare(
    'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)'
  ),
  getRoomMember: db.prepare(
    'SELECT * FROM room_members WHERE room_id = ? AND user_id = ?'
  ),
  updateRoomCoins: db.prepare(
    'UPDATE room_members SET coins = MAX(0, coins + ?) WHERE room_id = ? AND user_id = ?'
  ),
  updateRoomInventory: db.prepare(
    'UPDATE room_members SET inventory_json = ? WHERE room_id = ? AND user_id = ?'
  ),
  updateRoomMember: db.prepare(`
    UPDATE room_members
    SET coins = MAX(0, coins + @coinDelta),
        inventory_json = @inventory
    WHERE room_id = @roomId AND user_id = @userId
  `),
  addRoomPickaxeHits: db.prepare(
    'UPDATE room_members SET pickaxe_hits = MIN(pickaxe_hits + ?, 9999) WHERE room_id = ? AND user_id = ?'
  ),
  useRoomPickaxeHit: db.prepare(
    'UPDATE room_members SET pickaxe_hits = MAX(0, pickaxe_hits - 1) WHERE room_id = ? AND user_id = ?'
  ),

  // ── Thread mirror config ───────────────────────────────────────────────────
  setNotifyThread: db.prepare(
    'UPDATE rooms SET notify_thread_id = ? WHERE id = ?'
  ),
  setNotifyThreadDelete: db.prepare(
    'UPDATE rooms SET notify_thread_delete = ? WHERE id = ?'
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

  // ── Rooms ─────────────────────────────────────────────────────────────────
  upsertRoom: db.prepare(`
    INSERT INTO rooms (id, title) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title
  `),
  getRoomById:        db.prepare('SELECT * FROM rooms WHERE id = ?'),
  getAllRooms:        db.prepare('SELECT id, title FROM rooms WHERE id != 0 ORDER BY created_at ASC'),
  // ── Per-room streak tracking ───────────────────────────────────────────────
  getRoomStreak: db.prepare(
    'SELECT streak FROM room_member_streaks WHERE room_id = ? AND user_id = ?'
  ),
  upsertRoomStreak: db.prepare(`
    INSERT INTO room_member_streaks (room_id, user_id, streak) VALUES (?, ?, ?)
    ON CONFLICT(room_id, user_id) DO UPDATE SET streak = excluded.streak
  `),

  // ── Emoji forge ──────────────────────────────────────────────────────────────
  insertMerge: db.prepare(
    "INSERT INTO emoji_merges (user_id, room_id, ingredients, finishes_at) VALUES (?, ?, ?, ?)"
  ),
  getActiveMerge: db.prepare(
    "SELECT * FROM emoji_merges WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ),
  getMergeById: db.prepare('SELECT * FROM emoji_merges WHERE id = ?'),
  closeMerge: db.prepare(
    "UPDATE emoji_merges SET status = ?, emoji_key = ? WHERE id = ?"
  ),
  setMergeFinishNow: db.prepare(
    'UPDATE emoji_merges SET finishes_at = ? WHERE id = ?'
  ),
  getFinishedPendingMerges: db.prepare(
    "SELECT * FROM emoji_merges WHERE status = 'pending' AND finishes_at <= ?"
  ),
  insertUnlockedEmoji: db.prepare(
    'INSERT OR IGNORE INTO unlocked_emojis (user_id, room_id, emoji_key) VALUES (?, ?, ?)'
  ),
  getUnlockedEmoji: db.prepare(
    'SELECT * FROM unlocked_emojis WHERE user_id = ? AND room_id = ? AND emoji_key = ?'
  ),
  getUnlockedEmojis: db.prepare(
    'SELECT emoji_key FROM unlocked_emojis WHERE user_id = ? AND room_id = ?'
  ),
  insertEmojiHint: db.prepare(
    'INSERT INTO emoji_hints (user_id, hint_text) VALUES (?, ?)'
  ),
  getEmojiHints: db.prepare(
    'SELECT hint_text FROM emoji_hints WHERE user_id = ? ORDER BY id ASC'
  ),

  // ── Message reactions ────────────────────────────────────────────────────────
  getMessageById: db.prepare('SELECT id, user_id, room_id FROM messages WHERE id = ?'),
  getMessageReaction: db.prepare(
    'SELECT reaction FROM message_reactions WHERE message_id = ? AND user_id = ?'
  ),
  countMessageReactions: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN reaction='like'    THEN 1 ELSE 0 END), 0) AS likes,
      COALESCE(SUM(CASE WHEN reaction='dislike' THEN 1 ELSE 0 END), 0) AS dislikes
    FROM message_reactions WHERE message_id = ?
  `),
  countReactionType: db.prepare(
    'SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ? AND reaction = ?'
  ),
  insertMessageReaction: db.prepare(
    'INSERT INTO message_reactions (message_id, user_id, reaction) VALUES (?, ?, ?)'
  ),
  deleteMessageReaction: db.prepare(
    'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?'
  ),
  getMyReactionsForRoom: db.prepare(`
    SELECT mr.message_id, mr.reaction
    FROM message_reactions mr
    JOIN messages m ON m.id = mr.message_id
    WHERE mr.user_id = ? AND m.room_id = ?
    ORDER BY mr.message_id DESC LIMIT 200
  `),

  // ── Push notification opt-in ───────────────────────────────────────────────
  setUserWriteAccess: db.prepare(
    'UPDATE users SET allows_write_to_pm = 1 WHERE id = ?'
  ),
  // Returns user IDs of room members (excluding the sender) who have opted in
  getRoomMembersWithWriteAccess: db.prepare(`
    SELECT u.id
    FROM room_member_streaks rms
    JOIN users u ON u.id = rms.user_id
    WHERE rms.room_id = ? AND rms.user_id != ? AND u.allows_write_to_pm = 1
  `),

  // ── Futelo GOLD ──────────────────────────────────────────────────────────────
  incrementGoldLevel: db.prepare(
    'UPDATE room_members SET futelo_gold_level = futelo_gold_level + 1 WHERE room_id = ? AND user_id = ?'
  ),
  statGoldUpgrade: db.prepare(
    'UPDATE user_stats SET gold_upgrades = gold_upgrades + 1 WHERE user_id = ? AND room_id = ?'
  ),
  toggleGoldActive: db.prepare(
    'UPDATE room_members SET futelo_gold_active = CASE WHEN futelo_gold_active = 1 THEN 0 ELSE 1 END WHERE room_id = ? AND user_id = ?'
  ),

  // ── Achievements ─────────────────────────────────────────────────────────────
  getEarnedAchievements: db.prepare(
    'SELECT achievement_id FROM user_achievements WHERE user_id = ? AND room_id = ?'
  ),
  insertUserAchievement: db.prepare(
    'INSERT OR IGNORE INTO user_achievements (user_id, room_id, achievement_id) VALUES (?, ?, ?)'
  ),
  getUserStats: db.prepare(
    'SELECT * FROM user_stats WHERE user_id = ? AND room_id = ?'
  ),
  upsertUserStats: db.prepare(
    'INSERT OR IGNORE INTO user_stats (user_id, room_id) VALUES (?, ?)'
  ),
  statMineFind: db.prepare(
    'UPDATE user_stats SET mine_finds = mine_finds + 1, consecutive_mine_fails = 0 WHERE user_id = ? AND room_id = ?'
  ),
  statMineFail: db.prepare(
    'UPDATE user_stats SET consecutive_mine_fails = consecutive_mine_fails + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statLootbox: db.prepare(
    'UPDATE user_stats SET lootboxes_total = lootboxes_total + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statLootboxCommon: db.prepare(
    'UPDATE user_stats SET consecutive_common_boxes = consecutive_common_boxes + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statLootboxNotCommon: db.prepare(
    'UPDATE user_stats SET consecutive_common_boxes = 0 WHERE user_id = ? AND room_id = ?'
  ),
  statPromptLoss: db.prepare(
    'UPDATE user_stats SET prompt_losses = prompt_losses + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statMarketBuy: db.prepare(
    'UPDATE user_stats SET market_buys = market_buys + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statMarketSell: db.prepare(
    'UPDATE user_stats SET market_sells = market_sells + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statLotteryBet: db.prepare(
    'UPDATE user_stats SET lottery_bets_total = lottery_bets_total + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statLotteryParticipate: db.prepare(
    'UPDATE user_stats SET lottery_participations = lottery_participations + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statLotteryBetsInRound: db.prepare(
    'UPDATE user_stats SET lottery_bets_in_round = MAX(lottery_bets_in_round, ?) WHERE user_id = ? AND room_id = ?'
  ),
  statLotteryWin: db.prepare(
    'UPDATE user_stats SET lottery_wins = lottery_wins + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statPromptWin: db.prepare(
    'UPDATE user_stats SET prompt_wins = prompt_wins + 1 WHERE user_id = ? AND room_id = ?'
  ),
  statPromptCorrectVote: db.prepare(
    'UPDATE user_stats SET prompt_correct_votes = prompt_correct_votes + 1 WHERE user_id = ? AND room_id = ?'
  ),
  getVotersForReply: db.prepare(
    'SELECT voter_id FROM prompt_votes WHERE reply_id = ?'
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

/**
 * Upsert a room (Telegram group) and return it.
 * @param {number} id     Telegram chat_id (negative for groups/supergroups)
 * @param {string} title  Group title
 */
function upsertRoom(id, title = '') {
  stmts.upsertRoom.run(id, title);
  return stmts.getRoomById.get(id);
}

/**
 * Return the room or throw if not found.
 */
function requireRoom(roomId) {
  const room = stmts.getRoomById.get(roomId);
  if (!room) throw new Error(`Room ${roomId} not found.`);
  return room;
}

/**
 * Ensure a room_members row exists for this user+room and return it.
 */
function upsertRoomMember(userId, roomId) {
  stmts.upsertRoomMember.run(roomId, userId);
  return stmts.getRoomMember.get(roomId, userId);
}

/**
 * Return the room_members row or throw a user-facing error if not found.
 */
function requireRoomMember(userId, roomId) {
  const rm = stmts.getRoomMember.get(roomId, userId);
  if (!rm) throw new Error(`Usuario ${userId} no encontrado en la sala ${roomId}. Autentícate primero.`);
  return rm;
}

module.exports = {
  db, stmts,
  upsertUser, requireUser,
  upsertRoomMember, requireRoomMember,
  upsertRoom, requireRoom,
};
